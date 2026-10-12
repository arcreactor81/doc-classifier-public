import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from './store.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { guard } from './execution.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import { claimNativeRuntimeEntry, deferUnenteredRuntime, DeferredRuntimeInterruption, type RuntimeFrame } from './runtime-interruption.ts';

async function fixture(count = 1) {
  const db = migratedDatabase(), pack = syntheticPack(4);
  const env = { DB: localD1(db), ARTIFACTS: memoryR2(), MODEL_CALLS_ENABLED: 'true' } as unknown as Env;
  const store = new Store(env), actor = 'synthetic-owner';
  let at = Date.now() + 1000;
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, actor, new Date(at).toISOString());
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q',?,?,'interactive','types','pack','[]','{}')")
    .run(actor, new Date(at).toISOString());
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run',?,'running',?,'interactive',?,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(actor, new Date(at).toISOString(), count, JSON.stringify(pack), JSON.stringify(budget));
  const fingerprints = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  for (const [index, fingerprint] of fingerprints.entries())
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,ordinal) VALUES('run',?,?,'document.pdf','running','hash',?)")
      .run(fingerprint, 'rrun-' + String(index + 1).padStart(4, '0'), index + 1);
  const control = () => guard(env, store, 'run');
  const enter = async (index = 0) => claimNativeRuntimeEntry(store, 'run', fingerprints[index],
    await workflowInstanceId('run', fingerprints[index]), control, () => at);
  const original = () => new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.');
  const defer = (frame: RuntimeFrame, stage: string) => deferUnenteredRuntime(store, frame, stage, original(), control, () => at);
  const row = (index = 0) => db.prepare('SELECT * FROM runtime_interruptions WHERE run_id=? AND fingerprint=?').get('run', fingerprints[index])!;
  return { db, store, enter, defer, row, now: () => at, advance: (milliseconds: number) => { at += milliseconds; } };
}

test('a document admits at most three interruption episodes without resetting the count on native entry', async () => {
  const f = await fixture();
  try {
    let frame = await f.enter(); const ids: string[] = [];
    for (let episode = 1; episode <= 3; episode++) {
      await assert.rejects(f.defer(frame, 'stage-' + episode), DeferredRuntimeInterruption);
      assert.equal(f.row().interruptions, episode); ids.push(String(f.row().episode_id));
      f.advance(1000); frame = await f.enter(); assert.equal(f.row().state, 'reentered');
    }
    await assert.rejects(f.defer(frame, 'stage-4'), { code: 'E_RUNTIME_WAIT_LIMIT' });
    assert.equal(f.row().interruptions, 3); assert.equal(f.row().state, 'reentered');
    assert.equal(new Set(ids).size, 3);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='runtime_interruption' AND kind='pending'").get()!.n, 3);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
  } finally { f.db.close(); }
});

test('native entries and subsequent stages retain the first absolute deadline and cannot open a renewed window', async () => {
  const f = await fixture();
  try {
    let frame = await f.enter(); const first = f.now();
    await assert.rejects(f.defer(frame, 'stage-1'), DeferredRuntimeInterruption);
    f.advance(400000); frame = await f.enter();
    assert.equal((await f.store.run('run')).runtime_pending_deadline_ms, null);
    f.advance(400000); await assert.rejects(f.defer(frame, 'stage-2'), DeferredRuntimeInterruption);
    assert.equal(f.row().first_observed_ms, first); assert.equal(f.row().deadline_ms, first + 900000);
    frame = await f.enter(); f.advance(100000);
    await assert.rejects(f.defer(frame, 'stage-3'), { code: 'E_RUNTIME_WAIT_EXPIRED' });
    assert.equal(f.row().interruptions, 2); assert.equal(f.row().first_observed_ms, first);
    assert.equal(f.row().deadline_ms, first + 900000);
  } finally { f.db.close(); }
});

test('resolving one document keeps the other pending minimum, and resolving the last clears it', async () => {
  const f = await fixture(2);
  try {
    const first = await f.enter(0); await assert.rejects(f.defer(first, 'stage-1'), DeferredRuntimeInterruption);
    const firstDeadline = f.row(0).deadline_ms;
    f.advance(5000); const second = await f.enter(1); await assert.rejects(f.defer(second, 'stage-1'), DeferredRuntimeInterruption);
    const secondDeadline = f.row(1).deadline_ms;
    assert.equal((await f.store.run('run')).runtime_pending_deadline_ms, firstDeadline);
    await f.enter(0); assert.equal((await f.store.run('run')).runtime_pending_deadline_ms, secondDeadline);
    assert.equal(f.row(1).state, 'pending');
    await f.enter(1); assert.equal((await f.store.run('run')).runtime_pending_deadline_ms, null);
    assert.equal(f.row(0).deadline_ms, firstDeadline); assert.equal(f.row(1).deadline_ms, secondDeadline);
  } finally { f.db.close(); }
});

test('an older entry delayed before its claim cannot take ownership from an already accepted entry', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const batch = f.store.env.DB.batch.bind(f.store.env.DB); let first = true;
  f.store.env.DB.batch = async <T>(statements: D1PreparedStatement[]) => {
    if (first) { first = false; entered(); await held; }
    return batch<T>(statements);
  };
  try {
    const older = f.enter(); await ready;
    const accepted = await f.enter();
    await assert.rejects(f.defer(accepted, 'stage-1'), DeferredRuntimeInterruption);
    const pendingId = f.row().episode_id;
    release(); await assert.rejects(older, { code: 'E_RUNTIME_ENTRY_SUPERSEDED' });
    const document = await f.store.document('run', accepted.fingerprint);
    assert.equal(document.runtime_entry_token, accepted.entryToken); assert.equal(document.runtime_entry_sequence, accepted.entrySequence);
    assert.equal(f.row().state, 'pending'); assert.equal(f.row().episode_id, pendingId);
    assert.equal((await f.store.run('run')).status, 'running');
  } finally { release?.(); f.db.close(); }
});
