// Storage chaos test (DECISIONS 135, step 4). Runs the production DocumentWorkflow, Runner, Store and every persistence
// helper in-process for N documents against the fault-injecting D1 (node:sqlite, committed migrations) and R2 (in memory)
// of core/server/testing/workflow-harness.ts, with pretend vendors. It injects documented transient errors at a seeded
// random rate (single faults and write-then-read pairs), a few faults that outlast the bounded retries on chosen
// documents, and Workflow re-entries mid-stage (an isolate that dies inside a storage call, and an instance that loses its
// runtime before entering a step, with the Durable Object lifecycle message or the Workers runtime's own "internal error;
// reference = <id>", DECISIONS 144; `--lostAcks` adds the r07 shape: a completed step whose acknowledgement is lost, then
// a broken next step). It then checks: the run completes; every set-aside document has a storage code and a
// plain reason; no vendor request is repeated; no stored object is replaced; spend counters equal the receipt scan;
// unaccounted attempts belong to set-aside documents; every other decision equals a fault-free run's.
//
// What it does NOT cover: real workerd/Miniflare isolates, the hosted Workflows engine's own replay behaviour, real D1
// internal read retries or latency, concurrency across isolates, and real-model responses. Nothing here contacts a
// network or a hosted service.
//
// Usage: node scripts/storage-chaos.mjs [--documents=10000] [--rate=20000] [--seed=20261006] [--concurrency=24]
//   [--budget=unlimited|limited] [--persistent=6] [--hangs=6] [--deferrals=4] [--lostAcks=0] [--pair=0.3] [--out=file.json]
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFileSync } from 'node:fs';
import { workflowHarness, d1Error, r2Error, internalError, lifecycleError, vendorRequests } from '../core/server/testing/workflow-harness.ts';
import { DOCUMENT_STORAGE_CODES, CHARGE_STORAGE_CODES } from '../core/server/errors.ts';
import { Store } from '../core/server/store.ts';

// Diagnostic only: every vendor receipt this process could not record, with the facts that explain it.
const ledgerFailures = [];
const recordVendorCall = Store.prototype.recordVendorCall;
Store.prototype.recordVendorCall = async function (call, completion) {
  try { return await recordVendorCall.call(this, call, completion); }
  catch (error) {
    ledgerFailures.push({ attemptId: call.attemptId, code: error?.code ?? null, latencyMs: call.latencyMs, status: call.status,
      cause: error?.cause instanceof Error ? error.cause.message : null });
    throw error;
  }
};

const arg = (name, fallback) => {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const options = {
  documents: Number(arg('documents', 10000)), rate: Number(arg('rate', 20000)), seed: Number(arg('seed', 20261006)),
  concurrency: Number(arg('concurrency', 24)), budget: arg('budget', 'unlimited'), persistent: Number(arg('persistent', 6)),
  hangs: Number(arg('hangs', 6)), deferrals: Number(arg('deferrals', 4)), lostAcks: Number(arg('lostAcks', 0)), pair: Number(arg('pair', 0.3)),
  out: arg('out', null), baseline: arg('baseline', 'yes') !== 'no'
};
for (const key of ['documents', 'rate', 'seed', 'concurrency', 'persistent', 'hangs', 'deferrals', 'lostAcks'])
  if (!Number.isSafeInteger(options[key]) || options[key] < 0) throw new Error(`--${key} must be a non-negative integer`);
if (!['unlimited', 'limited'].includes(options.budget)) throw new Error('--budget must be unlimited or limited');

/** mulberry32: a small seeded generator, so every chaos run is reproducible from its seed. */
function generator(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const D1_TRANSIENTS = ['Network connection lost.', 'D1 DB reset because its code was updated.', 'Internal error in D1 DB storage caused object to be reset.',
  'Cannot resolve D1 DB due to transient issue on remote node.'];
const R2_TRANSIENTS = [10001, 10043, 10054];
/** The runtime's own internal error is one fault in five on either store (DECISIONS 144); it carries no store prefix or code. */
const RUNTIME_INTERNAL_SHARE = 0.2;

/** A fault-free run of the same documents. A document that fails here is reported, never hidden. */
const baselineFailures = [];
async function decisions(documents) {
  const h = await workflowHarness({ budget: options.budget });
  await h.addDocuments(documents);
  for (const fingerprint of h.fingerprints) {
    try { await h.invoke(fingerprint); }
    catch (error) { baselineFailures.push({ fingerprint, code: error?.code ?? null, ledger: ledgerFailures.splice(0) }); }
  }
  const map = new Map(h.db.prepare('SELECT fingerprint,decision_json FROM documents').all().map(row => [String(row.fingerprint), String(row.decision_json)]));
  const status = String(h.db.prepare('SELECT status FROM runs').get().status);
  h.db.close();
  if (status !== 'complete' && baselineFailures.length === 0) throw new Error(`The fault-free baseline did not complete: ${status}`);
  ledgerFailures.length = 0;
  return map;
}

async function chaos(baseline) {
  const random = generator(options.seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const context = new AsyncLocalStorage();
  const counts = { operations: 0, injected: 0, byRate: 0, pairs: 0, persistent: 0, hangs: 0, deferrals: 0, lostAcks: 0, runtimeInternal: 0, byClass: {} };
  let pairPending = null;
  const h = await workflowHarness({ budget: options.budget });
  await h.addDocuments(options.documents);
  h.take();
  // Chosen documents: persistent faults, deaths inside a storage call, runtime loss before a step.
  const chosen = [...h.fingerprints].sort(() => random() - 0.5);
  const persistentClasses = [
    ['stage finish batch', op => op.method === 'batch' && op.statements.some(sql => sql.startsWith("UPDATE checkpoints SET status='complete'"))],
    // On a run with spending limits, raw-response puts happen after the request was sent: an unconfirmable one stops the run
    // by the money rule (unit-tested in storage-containment.test.ts), so the limited run's persistent faults avoid them.
    ['artifact put', op => op.store === 'r2' && op.method === 'put' && (options.budget === 'unlimited' || !['raw-bytes', 'raw'].includes(op.target.split('/')[2]))],
    ['document pointer', op => op.method === 'run' && /^UPDATE documents SET (digest_key|confidence_key|reader_key)=/.test(op.target)],
    ['checkpoint claim', op => op.method === 'run' && op.target.startsWith('INSERT OR IGNORE INTO checkpoints')],
    ...(options.budget === 'unlimited' ? [['vendor receipt batch', op => op.method === 'batch' && op.statements.some(sql => sql.startsWith('INSERT INTO vendor_calls'))]] : [])
  ];
  const persistent = new Map(chosen.slice(0, options.persistent).map(fp => {
    const [name, match] = pick(persistentClasses);
    return [fp, { name, match, after: Math.floor(random() * 3), remaining: 3 + 1 }];
  }));
  const hangs = new Map(chosen.slice(options.persistent, options.persistent + options.hangs)
    .map(fp => [fp, { at: 8 + Math.floor(random() * 60), phase: random() < 0.5 ? 'before' : 'after', seen: 0, done: false }]));
  const steps = ['digest', 'confidence-http-1', 'confidence-validated', 'reader-http-1', 'decide'];
  // Alternately the Durable Object lifecycle message and the runtime's internal error (DECISIONS 144).
  const engineError = index => index % 2 === 0 ? lifecycleError() : internalError();
  const deferrals = new Map(chosen.slice(options.persistent + options.hangs, options.persistent + options.hangs + options.deferrals)
    .map((fp, index) => [fp, { step: pick(steps), error: engineError(index), done: false }]));
  // The r07 shape: a completed step whose acknowledgement is lost to an internal error, then the next step throws it too.
  const lostAckSteps = ['confidence-circuit-outcome', 'reader-circuit-outcome', 'digest'];
  const lostAcks = new Map(chosen.slice(options.persistent + options.hangs + options.deferrals, options.persistent + options.hangs + options.deferrals + options.lostAcks)
    .map(fp => [fp, { step: pick(lostAckSteps), done: false }]));
  const classOf = op => op.store === 'r2' ? `R2 ${op.method}` : op.method === 'batch' ? 'D1 batch' : op.write ? 'D1 write' : 'D1 read';
  const transient = op => {
    if (random() < RUNTIME_INTERNAL_SHARE) { counts.runtimeInternal++; return internalError(); }
    return op.store === 'd1' ? d1Error(pick(D1_TRANSIENTS)) : r2Error(op.method, pick(R2_TRANSIENTS));
  };
  const inject = (op, kind) => { counts.injected++; counts[kind]++; const name = classOf(op); counts.byClass[name] = (counts.byClass[name] ?? 0) + 1; return transient(op); };
  const decide = phase => op => {
    if (phase === 'before') counts.operations++;
    const current = context.getStore();
    const fingerprint = current?.fingerprint;
    // A death inside a storage call of a chosen document's first entry: the operation never settles.
    const hang = fingerprint ? hangs.get(fingerprint) : undefined;
    if (hang && !hang.done && current.entry === 1 && phase === hang.phase && ++hang.seen >= hang.at) {
      hang.done = true; counts.hangs++; current.hung(); return 'hang';
    }
    // A fault that outlasts the bounded retries for one chosen document and one class of operation.
    const fixed = fingerprint ? persistent.get(fingerprint) : undefined;
    if (phase === 'before' && fixed && fixed.remaining > 0 && fixed.match(op)) {
      if (fixed.after > 0) { fixed.after--; } else { fixed.remaining--; return inject(op, 'persistent'); }
    }
    // The 6 October pattern: the next operation of the same store after a fault also fails.
    if (phase === 'before' && pairPending === op.store) { pairPending = null; return inject(op, 'pairs'); }
    // Writes may lose their acknowledgement after taking effect; reads fail before.
    if ((phase === 'before' || op.write) && random() < 1 / options.rate / (op.write ? 2 : 1)) {
      if (random() < options.pair) pairPending = op.store;
      return inject(op, 'byRate');
    }
  };

  h.faults.before = decide('before'); h.faults.after = decide('after');

  const beforeRequests = new Map(vendorRequests.byDocumentRole);
  // The engine replays an instance whose execution threw the engine's own raw error back at it (no code): the lifecycle
  // message or the runtime's internal error. A typed stop (a code) ends the instance.
  const replays = error => error instanceof Error && !('code' in error) &&
    (error.message === lifecycleError().message || /^internal error; reference = [a-z0-9]+$/.test(error.message));
  const outcomes = { completed: 0, failedInWorkflow: 0, reentries: 0, abandonedEntries: 0 };
  const runDocument = async fingerprint => {
    for (let entry = 1; entry <= 3; entry++) {
      let hung;
      const died = new Promise(resolve => { hung = resolve; });
      const deferral = deferrals.get(fingerprint), lostAck = lostAcks.get(fingerprint);
      const faults = entry !== 1 ? undefined : deferral && !deferral.done ? {
        unentered: name => { if (name === deferral.step) { deferral.done = true; counts.deferrals++; return deferral.error; } }
      } : lostAck && !lostAck.done ? {
        afterCompleted: name => { if (name === lostAck.step && !lostAck.lost) { lostAck.lost = true; counts.lostAcks++; return internalError(); } },
        unentered: () => { if (lostAck.lost && !lostAck.done) { lostAck.done = true; return internalError(); } }
      } : undefined;
      const invocation = context.run({ fingerprint, entry, hung: () => hung('hung') }, () => h.invoke(fingerprint, faults))
        .then(() => 'done', error => error);
      const result = await Promise.race([invocation, died]);
      if (result === 'done') { outcomes.completed++; return; }
      if (result === 'hung') { outcomes.abandonedEntries++; outcomes.reentries++; await new Promise(r => setTimeout(r, 20)); continue; }
      if (replays(result)) { outcomes.reentries++; await new Promise(r => setTimeout(r, 20)); continue; }
      outcomes.failedInWorkflow++; return;
    }
  };
  const queue = [...h.fingerprints];
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    while (queue.length) await runDocument(queue.shift());
  }));
  const elapsedMs = Date.now() - started;

  // The bounded document/re-entry workload has finished. Stop injecting before the read-only inspection:
  // its Store scans measure the recorded result; a fresh synthetic fault there would test the observer, not recovery.
  h.faults.before = undefined; h.faults.after = undefined;

  // Checks.
  const db = h.db;
  const run = db.prepare('SELECT status,halt_json,spend_openai_nano,spend_typesafe_nano,unknown_calls FROM runs').get();
  const documents = db.prepare('SELECT fingerprint,status,decision_json,failure_json FROM documents').all();
  const setAside = [], wrongDecisions = [];
  for (const document of documents) {
    const fingerprint = String(document.fingerprint);
    const failure = document.failure_json === null ? null : JSON.parse(String(document.failure_json));
    if (failure) setAside.push({ fingerprint, code: failure.code, message: failure.message,
      chosen: persistent.has(fingerprint) ? 'persistent:' + persistent.get(fingerprint).name : hangs.has(fingerprint) ? 'death'
        : deferrals.has(fingerprint) ? 'deferral' : lostAcks.has(fingerprint) ? 'lost-ack' : 'random' });
    else if (baseline && !baselineFailures.some(item => item.fingerprint === fingerprint) && document.decision_json !== baseline.get(fingerprint)) wrongDecisions.push(fingerprint);
  }
  const requests = [...vendorRequests.byDocumentRole.entries()].map(([key, n]) => [key, n - (beforeRequests.get(key) ?? 0)]).filter(([, n]) => n > 0);
  const repeated = requests.filter(([, n]) => n > 1);
  const requestTotal = requests.reduce((sum, [, n]) => sum + n, 0);
  const receipts = Number(db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get().n);
  const scan = { spend: await h.store.scanSpend(h.runId), unknown: await h.store.scanUnknown(h.runId) };
  const counters = { openai: String(run.spend_openai_nano), typesafe: String(run.spend_typesafe_nano), unknown: Number(run.unknown_calls) };
  const pending = await h.store.pendingAccounting(h.runId);
  const pendingDocuments = db.prepare("SELECT DISTINCT c.fingerprint FROM checkpoints c WHERE c.status!='complete' AND c.name LIKE '%-http-%' AND NOT EXISTS(SELECT 1 FROM vendor_calls v WHERE v.attempt_id=c.run_id||'-'||c.fingerprint||'-'||replace(c.name,'-http-','-'))").all().map(row => String(row.fingerprint));
  const setAsideSet = new Set(setAside.map(item => item.fingerprint));
  const unledgered = [...h.bucket.objects.keys()].filter(key => !db.prepare('SELECT 1 FROM artifacts WHERE key=?').get(key));
  const unledgeredOutside = unledgered.filter(key => !setAsideSet.has(key.split('/')[1]));
  const writing = db.prepare("SELECT key,fingerprint FROM artifacts WHERE state!='complete'").all();
  const ops = h.take();
  const outcomeCounts = {};
  for (const document of documents) {
    const outcome = document.decision_json === null ? 'none' : JSON.parse(String(document.decision_json)).outcome;
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
  }
  const checks = {
    runCompleted: run.status === 'complete',
    everyDocumentDecided: documents.every(document => document.status === 'complete' && document.decision_json !== null),
    setAsideHaveStorageCodes: setAside.every(item => DOCUMENT_STORAGE_CODES.has(item.code) || CHARGE_STORAGE_CODES.has(item.code)),
    // Storage set-asides name storage; exhausted runtime interruptions (E_RUNTIME_WAIT_LIMIT) name the interrupted processing.
    setAsideHavePlainReason: setAside.every(item => /storage|interrupted its processing/.test(item.message)),
    noVendorRequestRepeated: repeated.length === 0,
    receiptsWithinRequests: receipts <= requestTotal && requestTotal <= receipts + pending,
    noObjectReplaced: h.bucket.overwriteAttempts.length === 0,
    spendCountersEqualReceiptScan: counters.openai === scan.spend.openai && counters.typesafe === scan.spend.typesafe && counters.unknown === scan.unknown,
    unaccountedOnlyOnSetAside: pendingDocuments.every(fingerprint => setAsideSet.has(fingerprint)),
    orphanObjectsOnlyOnSetAside: unledgeredOutside.length === 0,
    incompleteLedgerOnlyOnSetAside: writing.every(row => setAsideSet.has(String(row.fingerprint))),
    otherDecisionsUnchanged: wrongDecisions.length === 0,
    faultFreeBaselineClean: baselineFailures.length === 0
  };
  db.close();
  return {
    options, elapsedMs, run: { status: run.status, halt: run.halt_json }, outcomes, outcomeCounts, faults: counts,
    operations: { d1Reads: ops.d1Reads, d1Writes: ops.d1Writes, d1Batches: ops.d1Batches, r2Gets: ops.r2Gets, r2Heads: ops.r2Heads, r2Puts: ops.r2Puts },
    setAside, persistentPlan: [...persistent].map(([fp, plan]) => ({ fingerprint: fp, class: plan.name })),
    vendor: { requests: requestTotal, receipts, repeated: repeated.length, pendingAccounting: pending },
    spend: { counters, scan }, baselineFailures, ledgerFailures: [...ledgerFailures], unledgeredObjects: unledgered.length, incompleteLedgerRows: writing.length, wrongDecisions: wrongDecisions.length,
    checks, passed: Object.values(checks).every(Boolean)
  };
}

const baseline = options.baseline ? await decisions(options.documents) : null;
const result = await chaos(baseline);
const text = JSON.stringify(result, null, 2);
if (options.out) writeFileSync(options.out, text);
console.log(JSON.stringify({ passed: result.passed, checks: result.checks, run: result.run, outcomes: result.outcomes,
  outcomeCounts: result.outcomeCounts, faults: result.faults, vendor: result.vendor, setAside: result.setAside.length,
  setAsideCodes: result.setAside.map(item => `${item.code} (${item.chosen})`), baselineFailures: result.baselineFailures,
  ledgerFailures: result.ledgerFailures, elapsedMs: result.elapsedMs }, null, 2));
if (!result.passed) process.exitCode = 1;
