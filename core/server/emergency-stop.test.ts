import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { setEmergencyStop } from './emergency-stop.ts';
import { Store } from './store.ts';

// DECISIONS 140 (amends 129a): only a listed category editor (the site owner) may stop all runs, and only an editor may
// allow runs again; every run the stop halts gets the ordinary halt record (first cause kept, a `halted` receipt) and the
// spending check. Anyone else can stop only their own run, by discarding it.
const EDITOR = 'editor-person', USER = 'other-person';
const OWNER_ONLY = 'Only the site owner can stop all runs. You can stop your own run by discarding it.';

function fixture() {
  const db = migratedDatabase(), DB = localD1(db);
  const env = { DB, ARTIFACTS: memoryR2(), DEFINITION_EDITORS: JSON.stringify([EDITOR]) } as unknown as Env;
  const store = new Store(env);
  const run = (id: string, status: string) => {
    db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,'2026-10-05','interactive','types','pack','[]','{}')").run('q-' + id, USER);
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,?,'2026-10-05','interactive',1,0.9,'initial_design_threshold','types','{}','{}',?)").run(id, USER, status, 'q-' + id);
  };
  run('running-run', 'running');
  run('uploading-run', 'uploading');
  run('complete-run', 'complete');
  const kill = () => Number((db.prepare('SELECT kill FROM controls WHERE id=1').get() as { kill: number }).kill);
  const row = (id: string) => ({ ...db.prepare('SELECT status,halt_json FROM runs WHERE id=?').get(id) }) as { status: string; halt_json: string | null };
  const events = (id: string) => (db.prepare("SELECT kind FROM events WHERE run_id=? AND stage='run' ORDER BY created_at").all(id) as { kind: string }[]).map(e => e.kind);
  const switchEvents = () => (db.prepare("SELECT details_json FROM events WHERE stage='kill_switch'").all() as { details_json: string }[]).map(e => JSON.parse(e.details_json));
  return { env, store, kill, row, events, switchEvents };
}

test('someone who is not a listed editor cannot stop all runs: nothing changes and the refusal is plain', async () => {
  const f = fixture();
  await assert.rejects(setEmergencyStop(f.env, f.store, USER, true), { code: 'E_EDITOR_REQUIRED', status: 403, message: OWNER_ONLY });
  assert.equal(f.kill(), 0);
  assert.deepEqual(f.row('running-run'), { status: 'running', halt_json: null });
  assert.deepEqual(f.row('uploading-run'), { status: 'uploading', halt_json: null });
  assert.deepEqual(f.events('running-run'), []);
  assert.deepEqual(f.switchEvents(), []);
});

// DECISIONS 150: a trusted user is exempt from the per-person caps only; the global stop stays with the editor list.
test('a trusted user who is not a listed editor cannot stop all runs or allow them again', async () => {
  const f = fixture();
  const env = { ...f.env, TRUSTED_USERS: JSON.stringify([USER]) } as Env;
  await assert.rejects(setEmergencyStop(env, f.store, USER, true), { code: 'E_EDITOR_REQUIRED', status: 403, message: OWNER_ONLY });
  assert.equal(f.kill(), 0);
  assert.deepEqual(f.row('running-run'), { status: 'running', halt_json: null });
  await setEmergencyStop(env, f.store, EDITOR, true);
  await assert.rejects(setEmergencyStop(env, f.store, USER, false), { code: 'E_EDITOR_REQUIRED', status: 403 });
  assert.equal(f.kill(), 1);
});

test('a listed category editor can stop all runs; each live run is halted with its own receipt and the first cause', async () => {
  const f = fixture();
  assert.deepEqual(await setEmergencyStop(f.env, f.store, EDITOR, true), { enabled: true });
  assert.equal(f.kill(), 1);
  for (const id of ['running-run', 'uploading-run']) {
    const run = f.row(id);
    assert.equal(run.status, 'halted', id);
    assert.deepEqual(JSON.parse(run.halt_json!), { code: 'E_KILL_SWITCH', actor: EDITOR }, id);
    assert.deepEqual(f.events(id), ['halted'], id);
  }
  assert.deepEqual(f.row('complete-run'), { status: 'complete', halt_json: null });
  assert.deepEqual(f.events('complete-run'), []);
  assert.deepEqual(f.switchEvents(), [{ enabled: true, actor: EDITOR }]);
});

test('stopping again keeps each run\'s first cause and records only an observation', async () => {
  const f = fixture();
  const env = { ...f.env, DEFINITION_EDITORS: JSON.stringify([EDITOR, 'second-editor']) } as Env;
  await setEmergencyStop(env, f.store, EDITOR, true);
  await setEmergencyStop(env, f.store, 'second-editor', true);
  assert.deepEqual(JSON.parse(f.row('running-run').halt_json!), { code: 'E_KILL_SWITCH', actor: EDITOR });
  assert.deepEqual(f.events('running-run'), ['halted']);
});

test('only a listed category editor can allow runs again; halted runs stay halted', async () => {
  const f = fixture();
  await setEmergencyStop(f.env, f.store, EDITOR, true);
  await assert.rejects(setEmergencyStop(f.env, f.store, USER, false), { code: 'E_EDITOR_REQUIRED', status: 403 });
  assert.equal(f.kill(), 1, 'a refused allow leaves the stop in place');
  assert.deepEqual(await setEmergencyStop(f.env, f.store, EDITOR, false), { enabled: false });
  assert.equal(f.kill(), 0);
  assert.equal(f.row('running-run').status, 'halted');
  assert.deepEqual(f.switchEvents(), [{ enabled: true, actor: EDITOR }, { enabled: false, actor: EDITOR }]);
});

test('with no editor listed, nobody can stop all runs or allow them again from the site', async () => {
  const f = fixture();
  const env = { ...f.env, DEFINITION_EDITORS: '[]' } as Env;
  for (const actor of [USER, EDITOR])
    await assert.rejects(setEmergencyStop(env, f.store, actor, true), { code: 'E_EDITOR_REQUIRED', status: 403, message: OWNER_ONLY }, actor);
  assert.equal(f.kill(), 0);
  assert.equal(f.row('running-run').status, 'running');
  await assert.rejects(setEmergencyStop(env, f.store, EDITOR, false), { code: 'E_EDITOR_REQUIRED' });
  assert.deepEqual(f.switchEvents(), []);
});
