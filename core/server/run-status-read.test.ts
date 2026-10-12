import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { readRunStatusInput } from './run-status-read.ts';
import { documentPhase } from './document-phase.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

// The status poll reads checkpoint names only for dispatched unfinished documents. Every document's phase must equal
// the phase derived from ALL of its checkpoints, as the poll computed it before.
test('status phases from unfinished documents only equal the phases from every checkpoint', async () => {
  const db = migratedDatabase(), log: string[] = [], env = { DB: localD1(db, log), ARTIFACTS: memoryR2() } as unknown as Env;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'synthetic-owner', '2026-10-06');
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-06','interactive','types','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner','running','2026-10-06','interactive',6,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(JSON.stringify(syntheticPack(4)), JSON.stringify(budget));
  const documents: [string, string, string | null, string[]][] = [
    ['a', 'complete', 'wf-a', ['started', 'digest', 'confidence-http-1', 'confidence-validated', 'reader-http-1', 'reader-validated', 'decide', 'record-decision']],
    ['b', 'running', 'wf-b', ['started', 'digest', 'confidence-http-1']],
    ['c', 'running', 'wf-c', ['started', 'digest', 'confidence-http-1', 'confidence-circuit-outcome', 'confidence-validated', 'reader-http-1']],
    ['d', 'running', 'wf-d', []],
    ['e', 'uploaded', null, []],
    ['f', 'running', 'wf-f', ['started', 'recovery-http-1']]
  ];
  for (const [index, [fingerprint, status, workflowId, names]] of documents.entries()) {
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,workflow_id,ordinal,decision_json) VALUES('run',?,?,?,?,'hash',?,?,?)")
      .run(fingerprint, 'tag-' + fingerprint, fingerprint + '.pdf', status, workflowId, index + 1,
        status === 'complete' ? JSON.stringify({ ruleId: 'R1', outcome: 'filed', reasonCode: 'agreement_at_threshold', destinationFolder: 'x', typeId: 'x', notes: [], failures: [] }) : null);
    for (const name of names)
      db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,?,'complete','2026-10-06')").run(fingerprint, name);
  }
  try {
    const store = new Store(env);
    const input = await readRunStatusInput(store, env, await store.run('run'), Date.now());
    for (const document of input.documents) {
      const all = db.prepare("SELECT name,status FROM checkpoints WHERE run_id='run' AND fingerprint=?").all(document.fingerprint)
        .map(row => ({ name: String(row.name), status: String(row.status) }));
      assert.equal(document.phase, documentPhase(document.status, all), document.fingerprint);
    }
    assert.deepEqual(input.documents.map(document => document.phase),
      ['done', 'confidence_check', 'reader', 'waiting_to_start', 'waiting_to_start', 'finding_headings']);
    // No poll statement reads every checkpoint row of the run.
    assert.equal(log.some(sql => /FROM checkpoints WHERE run_id=\?$/.test(sql)), false);
  } finally { db.close(); }
});

test('more unfinished documents than one bound array holds are read in chunks with the same phases', async () => {
  const db = migratedDatabase(), log: string[] = [], env = { DB: localD1(db, log), ARTIFACTS: memoryR2() } as unknown as Env;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'synthetic-owner', '2026-10-06');
  const count = 5_003;
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-06','interactive','types','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner','running','2026-10-06','interactive',?,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(count, JSON.stringify(syntheticPack(4)), JSON.stringify(budget));
  db.exec('BEGIN');
  const document = db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,workflow_id,ordinal) VALUES('run',?,?,?,'running','hash',?,?)");
  const checkpoint = db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'digest','running','2026-10-06')");
  for (let index = 0; index < count; index++) {
    const fingerprint = index.toString(16).padStart(64, '0');
    document.run(fingerprint, 'tag-' + index, index + '.pdf', 'wf-' + index, index + 1); checkpoint.run(fingerprint);
  }
  db.exec('COMMIT');
  try {
    const store = new Store(env);
    const input = await readRunStatusInput(store, env, await store.run('run'), Date.now());
    assert.equal(input.documents.length, count);
    assert.ok(input.documents.every(item => item.phase === 'preparing_text'));
    assert.equal(log.filter(sql => sql.includes('json_each(?)')).length, 2);
  } finally { db.close(); }
});
