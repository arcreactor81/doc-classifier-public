import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1 } from './testing/local-bindings.ts';
import { activateDefinition, createDefinitionDraft, definitionState, effectiveProject } from './definitions.ts';
import { typeVersion, type ProjectPack } from '../config/project.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { applyReaderThreshold, readerCalibrationGuard, sameTrialReader } from './model-calibration.ts';

const OWNER = 'editor';
const BASE: ProjectPack = syntheticPack(2, { settings: { promptCachePolicy: 'explicit-no-cache-v1' } });
const SOL = BASE.pins.reader;
const TERRA = { ...SOL, id: 'gpt-5.6-terra' };
const SEED: ProjectPack = { ...BASE, readerModels: { defaultId: 'sol', options: [
  { id: 'sol', label: 'Reader one', pin: SOL, rates: BASE.prices.interactive.reader,
    promptCachePolicy: 'explicit-no-cache-v1', contextTokens: BASE.limits.readerContextTokens },
  { id: 'terra', label: 'Reader two', pin: TERRA, rates: BASE.prices.interactive.reader,
    promptCachePolicy: 'explicit-no-cache-v1', contextTokens: BASE.limits.readerContextTokens }
] } };
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: 'project-pack:reader-calibration', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:reader-calibration' ? { format: 'json', source: JSON.stringify(SEED), shortCircuit: true } : next(url, context);
  }
});

async function fixture(runtime = true) {
  const db = migratedDatabase({ foreignKeys: false });
  const env = { DB: localD1(db), DEFINITION_MODE: runtime ? 'runtime' : 'git', DEFINITION_EDITORS: JSON.stringify([OWNER]) };
  const version = await typeVersion(JSON.stringify(BASE.typeFile));
  let current: string | null = null, sequence = 0;
  const activate = async (kind: 'initial' | 'cosmetic' | 'semantic' = 'initial', inheritThreshold = false) => {
    const previous = current ? db.prepare('SELECT type_file_json FROM definition_revisions WHERE id=?').get(current) : null;
    const file = previous ? JSON.parse(String(previous.type_file_json)) : structuredClone(BASE.typeFile);
    if (kind === 'semantic') file.types[0].examples.push(`A changed synthetic example ${file.types[0].examples.length}.`);
    const draft = await createDefinitionDraft(env, SEED, OWNER, { baseRevisionId: current,
      typeFile: file, displayNames: kind === 'cosmetic' ? { [file.types[0].id]: 'Updated display' } : {} });
    const result = await activateDefinition(env, SEED, OWNER, draft.id, { inheritThreshold });
    current = result.active.id;
    return result.active;
  };
  if (runtime) await activate();
  const correction = async (pin: ProjectPack['pins']['reader'] | null, threshold: number,
    revisionId: string | null = current, applied = true) => {
    const n = ++sequence, id = `correction-${n}`, runId = `source-${n}`;
    const revision = revisionId ? db.prepare('SELECT type_file_json,type_version FROM definition_revisions WHERE id=?').get(revisionId) : null;
    const pack = { ...structuredClone(BASE), ...(revisionId ? { definitionRevisionId: revisionId } : {}),
      ...(revision ? { typeFile: JSON.parse(String(revision.type_file_json)) } : {}) };
    if (pin) pack.pins.reader = structuredClone(pin);
    else delete (pack as Partial<ProjectPack>).pins;
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'closed',?,'interactive',0,.9,'initial',?,?,'{}',?)")
      .run(runId, OWNER, `2026-10-06T00:00:${String(n).padStart(2, '0')}.000Z`, revision?.type_version ?? version, JSON.stringify(pack), `quote-${n}`);
    db.prepare('INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES(?,?,?,?,?,?,?)')
      .run(id, runId, OWNER, `2026-10-06T00:00:${String(n).padStart(2, '0')}.000Z`, `raw-${n}`, `analysis-${n}`, JSON.stringify({ raise: { threshold } }));
    if (applied) db.prepare('INSERT INTO threshold_history(id,correction_id,actor,created_at,threshold,direction) VALUES(?,?,?,?,?,?)')
      .run(`history-${n}`, id, OWNER, `2026-10-06T00:00:${String(n).padStart(2, '0')}.000Z`, threshold, 'raise');
    return { id, runId, pack, typeVersion: String(revision?.type_version ?? version) };
  };
  const selected = (id: string) => effectiveProject(env, SEED, { selectedReaderModel: id });
  const apply = (source: Awaited<ReturnType<typeof correction>>, threshold: number) => applyReaderThreshold(env.DB,
    source.pack, { runId: source.runId, typeVersion: source.typeVersion },
    { correctionId: source.id, actor: OWNER, threshold, direction: 'raise' });
  return { db, env, version, activate, correction, selected, apply, revision: () => current };
}

test('a reader menu restores only that exact reader pin own applied history', async () => {
  const f = await fixture();
  try {
    await f.correction(SOL, .93); const own = await f.correction(SOL, .93);
    const other = await f.correction(TERRA, .96);
    f.db.prepare("UPDATE definition_active SET threshold=.96,threshold_status='provisional',justification=?").run(other.id);
    const sol = await f.selected('sol'), terra = await f.selected('terra');
    assert.deepEqual([sol.pins.reader.id, sol.definitionThreshold, sol.definitionThresholdStatus, sol.definitionThresholdJustification],
      [SOL.id, .93, 'calibrated', own.id]);
    assert.deepEqual([terra.pins.reader.id, terra.definitionThreshold, terra.definitionThresholdStatus], [TERRA.id, .96, 'provisional']);
    assert.ok(sol.readerCalibrationKey); assert.notEqual(sol.readerCalibrationKey, terra.readerCalibrationKey);
  } finally { f.db.close(); }
});

test('a new reader starts at the design threshold without borrowing another or unknown reader', async () => {
  const f = await fixture();
  try {
    await f.correction(SOL, .97); await f.correction(null, .99);
    f.db.prepare("UPDATE definition_active SET threshold=.99,threshold_status='calibrated',justification='unknown-source'").run();
    const next = await f.selected('terra');
    assert.deepEqual([next.pins.reader.id, next.definitionThreshold, next.definitionThresholdStatus], [TERRA.id, .9, 'untested']);
  } finally { f.db.close(); }
});

test('a pack without a reader menu retains the recorded legacy active calibration', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE definition_active SET threshold=.97,threshold_status='calibrated',justification='legacy'").run();
    const result = await effectiveProject(f.env, BASE);
    assert.deepEqual([result.definitionThreshold, result.definitionThresholdStatus, result.readerCalibrationKey], [.97, 'calibrated', undefined]);
  } finally { f.db.close(); }
});

test('cosmetic carry and explicit semantic inheritance preserve each reader own threshold independently', async () => {
  const f = await fixture();
  try {
    await f.correction(SOL, .93); await f.correction(SOL, .93); await f.correction(TERRA, .96);
    const cosmetic = await f.activate('cosmetic');
    assert.deepEqual([cosmetic.threshold, cosmetic.thresholdStatus], [.93, 'calibrated']);
    assert.deepEqual([(await f.selected('sol')).definitionThresholdStatus, (await f.selected('terra')).definitionThreshold], ['calibrated', .96]);
    await f.activate('semantic', true);
    for (const [id, threshold] of [['sol', .93], ['terra', .96]] as const) {
      const pack = await f.selected(id);
      assert.deepEqual([pack.definitionThreshold, pack.definitionThresholdStatus], [threshold, 'unverified']);
    }
    await f.activate('semantic', false);
    for (const id of ['sol', 'terra']) {
      const pack = await f.selected(id);
      assert.deepEqual([pack.definitionThreshold, pack.definitionThresholdStatus], [.9, 'untested']);
    }
  } finally { f.db.close(); }
});

test('explicit applications affect only their source reader and never rewrite frozen runs or shared controls', async () => {
  const f = await fixture();
  try {
    const one = await f.correction(SOL, .95, undefined, false), two = await f.correction(SOL, .95, undefined, false);
    const other = await f.correction(TERRA, .95, undefined, false);
    const frozen = f.db.prepare('SELECT pack_json FROM runs WHERE id=?').get(one.runId)!.pack_json;
    const pointer = f.db.prepare('SELECT * FROM definition_active').get(), controls = f.db.prepare('SELECT * FROM controls').get();
    assert.equal((await f.apply(one, .95)).thresholdStatus, 'provisional');
    assert.equal((await f.apply(other, .95)).thresholdStatus, 'provisional');
    assert.equal((await f.selected('sol')).definitionThresholdStatus, 'provisional', 'another reader cannot confirm this reader');
    assert.equal((await f.apply(two, .95)).thresholdStatus, 'calibrated');
    assert.equal((await f.selected('terra')).definitionThresholdStatus, 'provisional');
    assert.equal((await definitionState(f.env, SEED, OWNER)).active!.threshold, .95);
    assert.equal(f.db.prepare('SELECT pack_json FROM runs WHERE id=?').get(one.runId)!.pack_json, frozen);
    assert.deepEqual(f.db.prepare('SELECT * FROM definition_active').get(), pointer);
    assert.deepEqual(f.db.prepare('SELECT * FROM controls').get(), controls);
    await assert.rejects(f.apply(two, .95), { code: 'E_READER_CALIBRATION_STALE' });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threshold_history').get()!.n, 3);
  } finally { f.db.close(); }
});

/** Pause before the real single-statement CAS. No second transaction is held open by this test gate. */
function pauseApplication(env: { DB: D1Database }) {
  const prepare = env.DB.prepare.bind(env.DB);
  let reached!: () => void, release!: () => void;
  const atWrite = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  env.DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === 'run' && sql.startsWith('INSERT INTO threshold_history')) return async () => {
          env.DB.prepare = prepare; reached(); await resume; return target.run();
        };
        return Reflect.get(target, key);
      }
    });
    return wrap(prepare(sql));
  };
  return { atWrite, release };
}

for (const sameReader of [true, false]) test(`concurrent applications ${sameReader ? 'for one reader cannot both confirm' : 'for different readers remain independent'}`, async () => {
  const f = await fixture();
  try {
    const one = await f.correction(SOL, .95, undefined, false), two = await f.correction(sameReader ? SOL : TERRA, .95, undefined, false);
    const gate = pauseApplication(f.env), pending = f.apply(one, .95).then(value => ({ value }), error => ({ error }));
    await gate.atWrite;
    try { assert.equal((await f.apply(two, .95)).thresholdStatus, 'provisional'); }
    finally { gate.release(); }
    const result = await pending;
    if (sameReader) assert.equal('error' in result && result.error.code, 'E_READER_CALIBRATION_STALE');
    else assert.equal('value' in result && result.value.thresholdStatus, 'provisional');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threshold_history').get()!.n, sameReader ? 1 : 2);
    assert.equal((await f.selected('sol')).definitionThresholdStatus, 'provisional');
  } finally { f.db.close(); }
});

test('a concurrent category activation refuses an old-reader application and leaves its history untouched', async () => {
  const f = await fixture();
  try {
    const source = await f.correction(SOL, .95, undefined, false), gate = pauseApplication(f.env);
    const pending = f.apply(source, .95).then(() => null, error => error);
    await gate.atWrite;
    try { await f.activate('cosmetic'); } finally { gate.release(); }
    assert.equal((await pending)?.code, 'E_READER_CALIBRATION_STALE');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threshold_history').get()!.n, 0);
  } finally { f.db.close(); }
});

test('a concurrent reader application invalidates a pending category inheritance', async () => {
  const f = await fixture();
  try {
    const source = await f.correction(TERRA, .95, undefined, false), previous = f.revision();
    const batch = f.env.DB.batch.bind(f.env.DB);
    let reached!: () => void, release!: () => void;
    const atBatch = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.env.DB.batch = async statements => { f.env.DB.batch = batch; reached(); await resume; return batch(statements); };
    const pending = f.activate('semantic', true).then(() => null, error => error);
    await atBatch;
    try { await f.apply(source, .95); } finally { release(); }
    assert.equal((await pending)?.code, 'E_DEFINITION_STALE');
    assert.equal(f.revision(), previous);
    assert.equal((await f.selected('terra')).definitionThreshold, .95);
  } finally { f.db.close(); }
});

test('the final admission guard rejects only a changed own-reader calibration snapshot', async () => {
  const f = await fixture();
  try {
    const pack = await f.selected('sol'), guard = readerCalibrationGuard(pack, f.version)!;
    const matches = () => f.db.prepare('SELECT (' + guard.sql + ') AS matches').get(...guard.params)!.matches;
    assert.equal(matches(), 1);
    await f.correction(TERRA, .96); assert.equal(matches(), 1);
    await f.correction(SOL, .94); assert.equal(matches(), 0);
    assert.notEqual((await f.selected('sol')).readerCalibrationKey, pack.readerCalibrationKey);
    assert.throws(() => readerCalibrationGuard({ ...pack, readerCalibrationKey: 'unreadable' }, f.version), { code: 'E_READER_CALIBRATION' });
  } finally { f.db.close(); }
});

test('git-mode menus also use only own-pin and same-type-version history', async () => {
  const f = await fixture(false);
  try {
    await f.correction(SOL, .93); await f.correction(SOL, .93);
    f.db.prepare("UPDATE controls SET threshold=.99,threshold_justification='shared'").run();
    assert.deepEqual([(await f.selected('sol')).definitionThreshold, (await f.selected('terra')).definitionThreshold], [.93, .9]);
    const changed = structuredClone(SEED); changed.typeFile.types[0].examples.push('A distinct synthetic definition.');
    assert.equal((await effectiveProject(f.env, changed, { selectedReaderModel: 'sol' })).definitionThreshold, .9);
  } finally { f.db.close(); }
});

test('present corrupt history or revision lineage fails loudly instead of looking untested', async () => {
  for (const problem of ['pin', 'proposal', 'lineage']) {
    const f = await fixture();
    try {
      const source = await f.correction(SOL, .94);
      if (problem === 'pin') {
        const corrupt = { ...source.pack, pins: { reader: { id: 42, policy: 'versioned' } } };
        f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(corrupt), source.runId);
      } else if (problem === 'proposal') f.db.prepare("UPDATE corrections SET proposals_json='{}' WHERE id=?").run(source.id);
      else {
        f.db.prepare("INSERT INTO definition_revisions(id,base_revision_id,type_version,type_file_json,display_names_json,created_at,created_by) VALUES('broken',? ,?,?,'{}','now',?)")
          .run(f.revision(), f.version, JSON.stringify(BASE.typeFile), OWNER);
        f.db.prepare("INSERT INTO definition_activations(id,revision_id,previous_revision_id,actor,created_at,threshold,threshold_status,change_kind,justification) VALUES('broken-activation','broken',NULL,?,'now',.9,'untested','cosmetic','initial')").run(OWNER);
        f.db.prepare("UPDATE definition_active SET revision_id='broken'").run();
      }
      await assert.rejects(f.selected('sol'), { code: 'E_READER_CALIBRATION' });
    } finally { f.db.close(); }
  }
});

test('trial reader matching preserves legacy reads but never borrows unknown or different reader checks for a menu', () => {
  assert.equal(sameTrialReader(BASE, JSON.stringify({})), true);
  assert.equal(sameTrialReader(SEED, JSON.stringify(BASE)), true);
  assert.equal(sameTrialReader(SEED, JSON.stringify({ ...BASE, pins: { ...BASE.pins, reader: TERRA } })), false);
  assert.equal(sameTrialReader(SEED, JSON.stringify({ settings: { pilotSize: 25 } })), false);
  assert.throws(() => sameTrialReader(SEED, JSON.stringify({ pins: { reader: { id: 7, policy: 'versioned' } } })), { code: 'E_READER_CALIBRATION' });
});

test('the public selected-project and explicit-apply routes retain per-reader scope', async () => {
  const { handleWithCloudflareIdentity } = await import('./api.ts');
  const f = await fixture();
  try {
    const source = await f.correction(TERRA, .96, undefined, false);
    const url = `https://unit.invalid/api/runs/${source.runId}/corrections/${source.id}/apply`;
    const response = await handleWithCloudflareIdentity(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'raise', threshold: .96 }) }), f.env as Env, OWNER);
    assert.equal(response.status, 200); assert.equal((await response.json() as { thresholdStatus: string }).thresholdStatus, 'provisional');
    for (const [id, threshold] of [['sol', .9], ['terra', .96]] as const) {
      const selected = await handleWithCloudflareIdentity(new Request('https://unit.invalid/api/project?selectedReaderModel=' + id), f.env as Env, OWNER);
      assert.equal(selected.status, 200); assert.equal((await selected.json() as ProjectPack).definitionThreshold, threshold);
    }
    const invalid = await handleWithCloudflareIdentity(new Request('https://unit.invalid/api/project?selectedReaderModel=missing_reader'), f.env as Env, OWNER);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: { kind: string } }).error.kind, 'request');
    const repeat = await handleWithCloudflareIdentity(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'raise', threshold: .96 }) }), f.env as Env, OWNER);
    assert.equal((await repeat.json() as { error: { code: string } }).error.code, 'E_THRESHOLD_ALREADY_APPLIED');
  } finally { f.db.close(); }
});

test('a nondefault reader trial remains viewable and confirmable against the same categories', async () => {
  const { pilotView, pilotConfirm } = await import('./pilot.ts');
  const { Store } = await import('./store.ts');
  const f = await fixture();
  try {
    const source = await f.correction(TERRA, .95, undefined, false), pack = await f.selected('terra');
    f.db.prepare("UPDATE runs SET pack_json=?,expected_count=1,campaign_id='reader-trial',campaign_role='pilot' WHERE id=?")
      .run(JSON.stringify(pack), source.runId);
    f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,decision_json,ordinal) VALUES(?,?,?,'synthetic.pdf','complete','hash',?,1)")
      .run(source.runId, '1'.repeat(64), 'trial-document', JSON.stringify({ ruleId: 'R1', destinationFolder: BASE.typeFile.types[0].id }));
    f.db.prepare("INSERT INTO pilot_reviews(id,run_id,fingerprint,verdict,actor,created_at) VALUES('review',?,?,'right',?,'2026-10-06')")
      .run(source.runId, '1'.repeat(64), OWNER);
    const env = f.env as Env, store = new Store(env), run = await store.run(source.runId);
    assert.equal((await pilotView(env, store, run)).categoryVersion.matches, true);
    const request = new Request(`https://unit.invalid/api/runs/${source.runId}/pilot-confirmation`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await pilotConfirm(request, env, store, run, OWNER)).status, 201);
    assert.equal((await f.selected('sol')).pins.reader.id, SOL.id, 'presentation default did not change to make the trial pass');
  } finally { f.db.close(); }
});

test('an explicit application refuses a malformed frozen menu calibration identity', async () => {
  const f = await fixture();
  try {
    const source = await f.correction(SOL, .95, undefined, false);
    source.pack = { ...await f.selected('sol'), readerCalibrationKey: 'bad-snapshot' };
    await assert.rejects(f.apply(source, .95), { code: 'E_READER_CALIBRATION' });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threshold_history').get()!.n, 0);
  } finally { f.db.close(); }
});
