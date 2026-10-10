import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';

/**
 * Every run route is its owner's alone (test audit M12, 7 October 2026: removing the owner check in authorizeRun was not
 * caught). The production request handler runs over the real migrations; a signed-in person who does not own the run
 * is refused 403 E_RUN_FORBIDDEN on each route, and nothing about the run changes.
 */
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const PACK = fixtures.syntheticPack(1);
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: 'project-pack:run-authorization', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:run-authorization' ? { format: 'json', source: JSON.stringify(PACK), shortCircuit: true } : next(url, context);
  }
});
const { handleWithCloudflareIdentity } = await import('./api.ts');
const FP = '1'.repeat(64), NO_COUNTS = { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null };
const UPLOAD = { fingerprint: FP, originalFilename: 'synthetic.pdf', fullText: 'Synthetic text.', outline: { headings: [], tables: [], blocks: [] },
  extractorVersion: 'synthetic', parserVersions: { pdf: 'synthetic' }, needsOutlineRecovery: false, tokenCounts: NO_COUNTS, tokenizerIds: { reader: null, confidence: null } };

function fixture(status: 'uploading' | 'complete') {
  const db = migratedDatabase(), at = new Date().toISOString();
  const env = { DB: localD1(db), ARTIFACTS: memoryR2(), MODEL_CALLS_ENABLED: 'true', PROJECT_ID: PACK.id, BUILD_COMMIT: 'run-authorization-test',
    DEFINITION_EDITORS: JSON.stringify(['site-owner']), OPENAI_API_KEY: { get: async () => 'local-test-only' }, JEV_API_KEY: { get: async () => 'local-test-only' },
    DOCUMENT_WORKFLOW: { createBatch: async () => { throw new Error('No Workflow may be created in this test.'); } } } as unknown as Env;
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false }, 'owner', at);
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','owner',?,'interactive','types','pack','[]','{}')").run(at);
  db.prepare("INSERT INTO quote_documents(quote_id,ordinal,fingerprint,original_filename,token_counts_json,needs_outline_recovery,failed) VALUES('q',1,?,'synthetic.pdf',?,0,0)").run(FP, JSON.stringify(NO_COUNTS));
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner',?,?,'interactive',1,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(status, at, JSON.stringify(PACK), JSON.stringify(budget));
  const call = (actor: string, method: string, action: string, body?: unknown) => handleWithCloudflareIdentity(new Request('https://unit.invalid/api/runs/run' + (action ? '/' + action : ''), {
    method, headers: { Origin: 'https://unit.invalid', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, actor);
  const snapshot = () => JSON.stringify(['runs', 'documents', 'events', 'artifacts', 'corrections'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  return { db, call, snapshot };
}

const ROUTES: [string, string, unknown?][] = [
  ['GET', 'status'], ['POST', 'start', {}], ['POST', 'close', { discardUnfinished: true }], ['GET', 'results'],
  ['POST', 'documents', UPLOAD], ['GET', ''], ['GET', 'plan'], ['GET', 'results/compact'], ['GET', 'manifest']
];

for (const status of ['uploading', 'complete'] as const)
  test(`another person is refused 403 on every route of a run that is ${status}, and nothing about the run changes`, async () => {
    const f = fixture(status);
    try {
      const before = f.snapshot();
      for (const [method, action, body] of ROUTES) {
        const response = await f.call('visitor', method, action, body);
        assert.equal(response.status, 403, `${method} ${action}`);
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'E_RUN_FORBIDDEN', `${method} ${action}`);
      }
      assert.equal(f.snapshot(), before);
      // The owner is answered on the same run.
      assert.equal((await f.call('owner', 'GET', 'status')).status, 200);
    } finally { f.db.close(); }
  });
