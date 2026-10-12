// One rule for every storage operation on the Workflow path (DECISIONS 135): a documented transient error is retried
// within the existing bound, a lost acknowledgement is settled by reading back and comparing, and nothing else repeats.
// Each case runs the production DocumentWorkflow in-process for one document with one injected fault (optionally
// followed by lost reads, the 6 October pattern) and requires the same decision as a run without faults, two vendor
// requests, one receipt per request and no replaced object.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowHarness, d1Error, r2Error, vendorRequests, type StorageOperation } from './testing/workflow-harness.ts';
import { GUARD_SNAPSHOT_SQL } from './store.ts';

const lost = () => d1Error('Network connection lost.');
interface Plan {
  name: string;
  target(operation: StorageOperation): boolean;
  phase: 'before' | 'after';
  occurrence?: number;
  /** Lost reads of the same store immediately after the injected fault. */
  readLosses?: number;
}
const batchHas = (fragment: string) => (op: StorageOperation) => op.method === 'batch' && (op.statements ?? []).some(sql => sql.includes(fragment));
const sqlStarts = (prefix: string) => (op: StorageOperation) => op.store === 'd1' && op.method !== 'batch' && op.target.startsWith(prefix);
const r2 = (method: string, kind: string) => (op: StorageOperation) => op.store === 'r2' && op.method === method && op.target.split('/')[2] === kind;

const writes: [string, (op: StorageOperation) => boolean][] = [
  ['checkpoint claim', sqlStarts('INSERT OR IGNORE INTO checkpoints')],
  ['stage finish batch', batchHas("UPDATE checkpoints SET status='complete'")],
  ['vendor receipt batch', batchHas('INSERT INTO vendor_calls')],
  ['circuit outcome batch', batchHas('INSERT INTO vendor_circuit_outcomes')],
  ['document start', sqlStarts("UPDATE documents SET status='running'")],
  ['document digest pointer', sqlStarts('UPDATE documents SET digest_key=')],
  ['document decision', batchHas("UPDATE documents SET status='complete',decision_json")],
  ['native entry batch', batchHas('UPDATE documents SET workflow_id=')],
  ['text artifact register', sqlStarts('INSERT INTO artifacts')],
  ['text artifact complete', sqlStarts("UPDATE artifacts SET state='complete'")],
  ['run completion batch', batchHas("UPDATE runs SET status='complete'")]
];
const plans: Plan[] = [];
for (const [name, target] of writes) for (const phase of ['before', 'after'] as const) {
  plans.push({ name: `${name} ${phase} commit`, target, phase });
  plans.push({ name: `${name} ${phase} commit, then its readback lost twice`, target, phase, readLosses: 2 });
}
for (const occurrence of [1, 7, 20]) plans.push({ name: `guard read #${occurrence} lost twice`, target: op => op.target === GUARD_SNAPSHOT_SQL,
  phase: 'before', occurrence, readLosses: 1 });
plans.push({ name: 'admission checkpoint read lost', target: sqlStarts('SELECT status FROM checkpoints'), phase: 'before' });
plans.push({ name: 'document read lost', target: sqlStarts('SELECT * FROM documents'), phase: 'before', occurrence: 2 });
for (const kind of ['raw-bytes', 'raw', 'decide', 'digest']) for (const phase of ['before', 'after'] as const)
  plans.push({ name: `R2 put ${kind} ${phase} store`, target: r2('put', kind), phase });
plans.push({ name: 'R2 put raw after store, then its confirmation read lost', target: r2('put', 'raw'), phase: 'after', readLosses: 1 });
plans.push({ name: 'R2 get input lost twice', target: r2('get', 'input'), phase: 'before', readLosses: 1 });

let baseline: unknown;
async function decide(plan?: Plan) {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const before = vendorRequests.total, fingerprint = h.fingerprints[0]!;
  const roleCount = (role: string) => vendorRequests.byDocumentRole.get(fingerprint + '/' + role) ?? 0;
  const beforeRoles = ['confidence', 'reader'].map(roleCount);
  let seen = 0, armed = 0, armedStore: 'd1' | 'r2' = 'd1', injected = 0;
  const error = (op: StorageOperation) => op.store === 'd1' ? lost() : r2Error(op.method, 10001);
  const pick = (phase: 'before' | 'after') => (op: StorageOperation) => {
    if (phase === 'before' && armed > 0 && !op.write && op.store === armedStore) { armed--; injected++; return error(op); }
    if (plan && plan.phase === phase && plan.target(op) && ++seen === (plan.occurrence ?? 1)) {
      injected++; armed = plan.readLosses ?? 0; armedStore = op.store; return error(op);
    }
  };
  h.faults.before = pick('before'); h.faults.after = pick('after');
  await h.invoke(fingerprint);
  const run = h.db.prepare('SELECT status,halt_json,spend_openai_nano,spend_typesafe_nano,unknown_calls FROM runs').get()!;
  const document = h.db.prepare('SELECT status,decision_json,failure_json FROM documents').get()!;
  const result = {
    injected, run: String(run.status), halt: run.halt_json, decision: document.decision_json, failure: document.failure_json,
    requests: vendorRequests.total - before,
    requestsPerRole: ['confidence', 'reader'].map((role, index) => roleCount(role) - beforeRoles[index]!),
    receipts: Number(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n),
    overwrites: h.bucket.overwriteAttempts.length,
    incomplete: Number(h.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE state!='complete'").get()!.n),
    unledgered: [...h.bucket.objects.keys()].filter(key => !h.db.prepare('SELECT 1 FROM artifacts WHERE key=?').get(key)).length,
    counters: [run.spend_openai_nano, run.spend_typesafe_nano, run.unknown_calls]
  };
  h.db.close();
  return result;
}

test('baseline without faults', async () => {
  const result = await decide();
  assert.equal(result.run, 'complete'); assert.equal(result.requests, 2); assert.equal(result.receipts, 2);
  baseline = result;
});

for (const plan of plans) test(`one rule: ${plan.name} settles without repeating work or changing the result`, async () => {
  const result = await decide(plan), expected = baseline as Awaited<ReturnType<typeof decide>>;
  assert.ok(result.injected >= 1, 'the fault must be injected');
  assert.equal(result.halt, null); assert.equal(result.run, 'complete');
  assert.equal(result.failure, null); assert.equal(result.decision, expected.decision);
  assert.equal(result.requests, 2); assert.deepEqual(result.requestsPerRole, [1, 1]); assert.equal(result.receipts, 2);
  assert.deepEqual(result.counters, expected.counters);
  assert.equal(result.overwrites, 0); assert.equal(result.incomplete, 0); assert.equal(result.unledgered, 0);
});
