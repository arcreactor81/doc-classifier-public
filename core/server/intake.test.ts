import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';

// Real SQL over the real migrations (the same harness idea as execution-budget.test.ts). The Worker's `project-pack`
// import is a build-time alias; here it is served in-process as a one-category synthetic pack, so `requireReady`
// sees a valid, unconfigured-by-nothing project. The hook is registered before intake.ts (and so health.ts) loads.
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const PACK = fixtures.syntheticPack(1) as { id: string };
const PACK_URL = 'project-pack:synthetic';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: PACK_URL, format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === PACK_URL ? { format: 'json', source: JSON.stringify(PACK), shortCircuit: true } : next(url, context);
  }
});
const { quote, createRun, uploadDocument, runPlan, documentTag, MAX_QUOTE_DOCUMENTS, skipPilotCopy } = await import('./intake.ts');
const { PILOT_SKIPPED_NOTE } = await import('./run-status-read.ts');

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'migrations');
const NO_COUNTS = { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null };
const FP = (n: number) => String(n).padStart(64, '0');
const BUDGET = { mode: 'limited', limits: { blended: '1000000', openai: null, typesafe: null }, unlimitedAcknowledged: false };

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
  const batches: number[][] = [];
  // Faults sit at database call boundaries; every statement still executes against SQLite.
  const writeHooks: {
    before?: (sql: string[]) => Promise<void>;
    after?: (sql: string[]) => Promise<void>;
  } = {};
  const statement = (sql: string) => {
    let values: SQLInputValue[] = [];
    const bound = {
      sql,
      bind(...input: SQLInputValue[]) { values = input; return bound; },
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => {
        await writeHooks.before?.([sql]);
        const result = { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } };
        await writeHooks.after?.([sql]);
        return result;
      },
      execute: () => db.prepare(sql).run(...values),
      size: () => values.reduce<number>((sum, v) => sum + (typeof v === 'string' ? v.length : 0), 0)
    };
    return bound;
  };
  const DB = {
    prepare: statement,
    batch: async (statements: ReturnType<typeof statement>[]) => {
      const sql = statements.map(s => s.sql);
      await writeHooks.before?.(sql);
      batches.push(statements.map(s => s.size()));
      db.exec('BEGIN');
      let results;
      try {
        results = statements.map(s => ({ success: true, meta: { changes: Number(s.execute().changes) } }));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      // Losing an acknowledgement cannot roll back a transaction that already committed.
      await writeHooks.after?.(sql);
      return results;
    }
  };
  const objects = new Map<string, string>();
  const env = {
    DB,
    ARTIFACTS: {
      head: async (key: string) => objects.has(key) ? {} : null,
      put: async (key: string, value: string) => { objects.set(key, value); return {}; },
      delete: async (key: string) => { objects.delete(key); },
      get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null
    },
    DOCUMENT_WORKFLOW: {},
    OPENAI_API_KEY: { get: async () => 'local-test-only' },
    JEV_API_KEY: { get: async () => 'local-test-only' },
    MODEL_CALLS_ENABLED: 'true',
    PROJECT_ID: PACK.id,
    BUILD_COMMIT: 'intake-local-test',
    // Health needs a listed site owner (F4); this one is never an actor here.
    DEFINITION_EDITORS: JSON.stringify(['intake-test-owner'])
  } as unknown as Env;
  const store = new Store(env);
  const post = (path: string, body: unknown) => new Request('https://unit.invalid/api/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const documents = (count: number, failedAt: number[] = []) => Array.from({ length: count }, (_, i) => ({
    fingerprint: FP(i + 1), originalFilename: `document-${i + 1}.pdf`, tokenCounts: NO_COUNTS,
    needsOutlineRecovery: false, failed: failedAt.includes(i + 1)
  }));
  const upload = (n: number) => ({
    fingerprint: FP(n), originalFilename: `document-${n}.pdf`, fullText: 'Placeholder text for a local intake check.',
    outline: { headings: [], tables: [], blocks: [] }, extractorVersion: 'local-test', parserVersions: { pdf: 'local-test' },
    needsOutlineRecovery: false, tokenCounts: NO_COUNTS, tokenizerIds: { reader: null, confidence: null }
  });
  const count = (sql: string, ...values: SQLInputValue[]) => Number((db.prepare(sql).get(...values) as { n: number }).n);
  return { db, env, store, batches, writeHooks, objects, post, documents, upload, count };
}

async function body(response: Response) { return { status: response.status, body: await response.json() as Record<string, unknown> }; }

async function uploadFixture(failed: boolean) {
  const f = fixture();
  try {
    const quoted = await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(1, failed ? [1] : []) }),
      f.env, f.store, 'person', 'cloudflare'));
    const created = await body(await createRun(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }),
      f.env, f.store, 'person', 'cloudflare'));
    const runId = String(created.body.runId), run = await f.store.run(runId);
    const failure = { code: 'E_SYNTHETIC_EXTRACTION', message: 'Synthetic extraction failure' };
    const input = failed ? { fingerprint: FP(1), originalFilename: 'document-1.pdf', failure } : f.upload(1);
    const send = (value: unknown = input) => uploadDocument(f.post('runs/' + runId + '/documents', value), f.env, f.store, run);
    const events = () => f.db.prepare("SELECT * FROM events WHERE run_id=? AND stage='upload' AND kind='completed'").all(runId);
    return { ...f, runId, run, input, send, events };
  } catch (error) { f.db.close(); throw error; }
}

for (const failed of [false, true]) {
  const kind = failed ? 'failed-extraction' : 'text';
  test('upload atomicity: an event insert failure rolls back the ' + kind + ' acceptance without retry', async () => {
    const f = await uploadFixture(failed);
    try {
      let attempts = 0;
      f.db.function('observe_upload_event', () => { attempts++; return 1; });
      f.db.exec(`CREATE TRIGGER fail_upload_event BEFORE INSERT ON events
        WHEN NEW.stage='upload' AND NEW.kind='completed'
        BEGIN SELECT observe_upload_event(); SELECT RAISE(ABORT, 'synthetic upload event failure'); END`);
      await assert.rejects(f.send(), /synthetic upload event failure/);
      assert.equal(attempts, 1, 'the failed acceptance must not retry itself');
      assert.equal(f.count('SELECT COUNT(*) AS n FROM documents WHERE run_id=?', f.runId), 0);
      assert.equal(f.events().length, 0);
      assert.equal((await f.store.run(f.runId)).status, 'uploading');
      const retained = f.db.prepare('SELECT key,state,deleted_at FROM artifacts WHERE run_id=? AND contains_text=1').all(f.runId);
      assert.equal(retained.length, failed ? 0 : 1);
      for (const artifact of retained) {
        assert.equal(artifact.state, 'complete'); assert.equal(artifact.deleted_at, null);
        assert.deepEqual(JSON.parse(f.objects.get(String(artifact.key))!), f.input);
      }
    } finally { f.db.close(); }
  });

  test('upload atomicity: a lost ' + kind + ' commit acknowledgement preserves the event and explicit replay identity', async () => {
    const f = await uploadFixture(failed);
    try {
      let attempts = 0;
      f.writeHooks.after = async sql => {
        if (!sql.some(s => s.startsWith('INSERT INTO documents('))) return;
        attempts++;
        throw new Error('synthetic lost commit acknowledgement');
      };
      await assert.rejects(f.send(), /synthetic lost commit acknowledgement/);
      assert.equal(attempts, 1, 'an uncertain commit must not retry itself');
      const original = await f.store.document(f.runId, FP(1));
      assert.equal(original.status, failed ? 'complete' : 'uploaded');
      const originalEvents = f.events();
      assert.equal(originalEvents.length, 1);
      assert.deepEqual(JSON.parse(String(originalEvents[0].details_json)), { failed });
      const originalArtifacts = f.db.prepare('SELECT * FROM artifacts WHERE run_id=?').all(f.runId);
      assert.deepEqual(await body(await f.send()), { status: 200, body: { uploaded: true, idempotent: true } });
      const different = failed ? { ...f.input, failure: { code: 'E_SYNTHETIC_OTHER', message: 'Different failure' } }
        : { ...f.input, fullText: 'Different synthetic content' };
      await assert.rejects(f.send(different), /already exists with different content/);
      assert.equal(attempts, 1);
      assert.deepEqual(await f.store.document(f.runId, FP(1)), original);
      assert.deepEqual(f.events(), originalEvents);
      assert.deepEqual(f.db.prepare('SELECT * FROM artifacts WHERE run_id=?').all(f.runId), originalArtifacts);
    } finally { f.db.close(); }
  });

  test('upload atomicity: close after ' + kind + ' acceptance sees the matching event before the acknowledgement', async () => {
    const f = await uploadFixture(failed);
    try {
      const { handleWithCloudflareIdentity } = await import('./api.ts');
      let closed = false;
      f.writeHooks.after = async sql => {
        if (!sql.some(s => s.startsWith('INSERT INTO documents('))) return;
        assert.equal(f.events().length, 1, 'a committed document must already have its event when closure starts');
        assert.equal(closed, false); closed = true;
        assert.deepEqual(await body(await handleWithCloudflareIdentity(f.post('runs/' + f.runId + '/close', { discardUnfinished: true }), f.env, 'person')),
          { status: 200, body: { closed: true } });
      };
      assert.deepEqual(await body(await f.send()), { status: 201, body: { uploaded: true, idempotent: false } });
      assert.equal(closed, true);
      assert.equal((await f.store.run(f.runId)).status, 'closed');
      assert.equal(f.count('SELECT COUNT(*) AS n FROM documents WHERE run_id=?', f.runId), 1);
      assert.equal(f.events().length, 1);
      assert.equal(f.count('SELECT COUNT(*) AS n FROM artifacts WHERE run_id=? AND contains_text=1 AND deleted_at IS NULL', f.runId), 0);
      await assert.rejects(uploadDocument(f.post('runs/' + f.runId + '/documents', f.input), f.env, f.store,
        await f.store.run(f.runId)), /no longer accepting uploads/);
    } finally { f.db.close(); }
  });
}

test('upload atomicity: replay does not reconstruct a missing historical completed event', async () => {
  const f = await uploadFixture(false);
  try {
    await f.send();
    f.db.prepare("DELETE FROM events WHERE run_id=? AND stage='upload' AND kind='completed'").run(f.runId);
    const original = await f.store.document(f.runId, FP(1));
    assert.deepEqual(await body(await f.send()), { status: 200, body: { uploaded: true, idempotent: true } });
    assert.equal(f.events().length, 0);
    assert.deepEqual(await f.store.document(f.runId, FP(1)), original);
  } finally { f.db.close(); }
});

test('intake parity: a small quote yields the same tags, ordinals and expected_count as the JSON list did', async () => {
  const f = fixture();
  try {
    const docs = f.documents(3, [2]);
    const quoted = await body(await quote(f.post('quote', { mode: 'interactive', documents: docs }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(quoted.status, 200);
    const quoteId = String(quoted.body.quoteId);
    assert.deepEqual(f.db.prepare('SELECT ordinal,fingerprint,original_filename,token_counts_json,needs_outline_recovery,failed FROM quote_documents WHERE quote_id=? ORDER BY ordinal').all(quoteId).map(r => ({ ...r })),
      docs.map((d, i) => ({ ordinal: i + 1, fingerprint: d.fingerprint, original_filename: d.originalFilename, token_counts_json: JSON.stringify(NO_COUNTS), needs_outline_recovery: 0, failed: d.failed ? 1 : 0 })));
    assert.equal((f.db.prepare('SELECT request_json FROM quotes WHERE id=?').get(quoteId) as { request_json: string }).request_json, '[]');
    assert.deepEqual(f.batches.map(b => b.length), [2]); // one batch: the quote row plus one document chunk

    const created = await body(await createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(created.status, 201);
    const runId = String(created.body.runId);
    assert.equal(f.count('SELECT expected_count AS n FROM runs WHERE id=?', runId), 3);
    // Idempotent: the same confirmation and the same spending decision return the same run.
    const again = await body(await createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    assert.deepEqual([again.status, again.body], [200, { runId }]);
    // A quote made by someone else stays unavailable.
    assert.equal((await createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, 'other', 'cloudflare').catch(e => e)).code, 'E_REQUEST');

    const run = await f.store.run(runId);
    // Upload out of quote order: ordinals and tags still follow the quote.
    assert.equal((await uploadDocument(f.post(`runs/${runId}/documents`, f.upload(3)), f.env, f.store, run)).status, 201);
    // The same checks as before, now against the quoted row: each is refused and stores nothing.
    const failure = { code: 'E_LOCAL_SAMPLE', message: 'Could not be read.' };
    for (const [label, bad] of [
      ['not quoted', f.upload(4)],
      ['renamed', { ...f.upload(1), originalFilename: 'other.pdf' }],
      ['text for a document quoted as failed', f.upload(2)],
      ['failure for a document quoted as read', { fingerprint: FP(1), originalFilename: 'document-1.pdf', failure }],
      ['different token counts', { ...f.upload(1), tokenCounts: { ...NO_COUNTS, readerInputTokens: 5 } }],
      ['different recovery need', { ...f.upload(1), needsOutlineRecovery: true }]
    ] as const) {
      const attempt = await uploadDocument(f.post(`runs/${runId}/documents`, bad), f.env, f.store, run).then(r => r.status, e => e.code);
      assert.equal(attempt, 'E_REQUEST', label);
    }
    assert.equal(f.count('SELECT COUNT(*) AS n FROM documents WHERE run_id=?', runId), 1);
    assert.equal((await uploadDocument(f.post(`runs/${runId}/documents`, { fingerprint: FP(2), originalFilename: 'document-2.pdf', failure }), f.env, f.store, run)).status, 201);
    const plan = await runPlan(f.store, run);
    assert.deepEqual(plan.expected, [
      { fingerprint: FP(1), originalFilename: 'document-1.pdf', extractionFailed: false, uploaded: false, ordinal: 1 },
      { fingerprint: FP(2), originalFilename: 'document-2.pdf', extractionFailed: true, uploaded: true, ordinal: 2 },
      { fingerprint: FP(3), originalFilename: 'document-3.pdf', extractionFailed: false, uploaded: true, ordinal: 3 }
    ]);
    // Extraction notes travel with the upload and become the document's notes (extractor 1.1.0+); older uploads send none.
    const withNote = { ...f.upload(1), notes: ['N_PAGES_WITHOUT_TEXT'] };
    assert.equal((await uploadDocument(f.post(`runs/${runId}/documents`, withNote), f.env, f.store, run)).status, 201);
    // Re-sending the same document (same bytes) is acknowledged without a second row.
    const repeat = await body(await uploadDocument(f.post(`runs/${runId}/documents`, withNote), f.env, f.store, run));
    assert.deepEqual([repeat.status, repeat.body], [200, { uploaded: true, idempotent: true }]);
    const legacyTag = (index: number) => `r${runId.slice(0, 8)}-${String(index + 1).padStart(4, '0')}`;
    assert.deepEqual((await f.store.documents(runId)).map(d => [d.tag, d.ordinal]), [[legacyTag(0), 1], [legacyTag(1), 2], [legacyTag(2), 3]]);
    assert.deepEqual((await f.store.documents(runId)).map(d => d.notes_json), ['["N_PAGES_WITHOUT_TEXT"]', '[]', '[]']);
  } finally { f.db.close(); }
});

test('a 10,000-document quote round trip: rows, expected_count, 5-digit tags and ordinals', async () => {
  const f = fixture();
  try {
    const docs = f.documents(10_000);
    // Step 4: above the pilot size a quote must be a confirmed full run or skip the pilot explicitly; this one skips it.
    const quoted = await body(await quote(f.post('quote', { mode: 'interactive', documents: docs, skipPilot: true }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(quoted.status, 200);
    const quoteId = String(quoted.body.quoteId);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quote_documents WHERE quote_id=?', quoteId), 10_000);
    assert.equal(f.count('SELECT MIN(ordinal) AS n FROM quote_documents WHERE quote_id=?', quoteId), 1);
    assert.equal(f.count('SELECT MAX(ordinal) AS n FROM quote_documents WHERE quote_id=?', quoteId), 10_000);
    // One atomic batch: the quote row plus five chunks of 2,000, each bound parameter far under 2 MB.
    assert.equal(f.batches.length, 1);
    assert.equal(f.batches[0].length, 6);
    assert.ok(f.batches[0].every(size => size < 2 * 1024 * 1024), String(f.batches[0]));
    const created = await body(await createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(created.status, 201);
    const runId = String(created.body.runId);
    assert.equal(f.count('SELECT expected_count AS n FROM runs WHERE id=?', runId), 10_000);
    const run = await f.store.run(runId);
    assert.equal((await uploadDocument(f.post(`runs/${runId}/documents`, f.upload(10_000)), f.env, f.store, run)).status, 201);
    assert.equal((await uploadDocument(f.post(`runs/${runId}/documents`, f.upload(1)), f.env, f.store, run)).status, 201);
    assert.deepEqual((await f.store.documents(runId)).map(d => [d.tag, d.ordinal]),
      [[`r${runId.slice(0, 8)}-00001`, 1], [`r${runId.slice(0, 8)}-10000`, 10_000]]);
    const plan = await runPlan(f.store, run);
    assert.equal(plan.expected.length, 10_000);
    assert.deepEqual(plan.expected.map(d => d.ordinal).slice(0, 3), [1, 2, 3]);
    assert.deepEqual(plan.expected.filter(d => d.uploaded).map(d => d.ordinal), [1, 10_000]);
  } finally { f.db.close(); }
});

test('the tag width follows the run: four digits below 10,000 documents, five from 10,000', () => {
  assert.equal(documentTag('1a2b3c4d-0000-4000-8000-000000000000', 114, 7), 'r1a2b3c4d-0007');
  assert.equal(documentTag('1a2b3c4d-0000-4000-8000-000000000000', 9_999, 9_999), 'r1a2b3c4d-9999');
  assert.equal(documentTag('1a2b3c4d-0000-4000-8000-000000000000', 10_000, 1), 'r1a2b3c4d-00001');
  assert.equal(documentTag('1a2b3c4d-0000-4000-8000-000000000000', 10_000, 10_000), 'r1a2b3c4d-10000');
});

// Step 4: the pilot rule at quote time and again at run creation, and the campaign echoed and copied to the run.
test('the pilot rule: a pilot is at most the pilot size; above it a quote is a confirmed full run; the campaign follows the run', async () => {
  const f = fixture();
  const owner = 'person', PILOT_SIZE = 25, banned = /threshold|fingerprint/i;
  const quoteOf = (documents: unknown[], campaign?: unknown, actor = owner) =>
    quote(f.post('quote', { mode: 'interactive', documents, ...(campaign === undefined ? {} : { campaign }) }), f.env, f.store, actor, 'cloudflare');
  const SENTENCES = {
    E_PILOT_REQUIRED: `Run a pilot first: classify up to ${PILOT_SIZE} documents and confirm every filed one before the rest.`,
    E_PILOT_STALE: 'The categories changed after this pilot. Run a new pilot on the current categories.',
    E_PILOT_SIZE: `A pilot can include up to ${PILOT_SIZE} documents. Choose ${PILOT_SIZE} or fewer for the pilot.`
  };
  const refused = async (documents: unknown[], campaign?: unknown, actor = owner, code: keyof typeof SENTENCES = 'E_PILOT_REQUIRED') => {
    const error = await quoteOf(documents, campaign, actor).then(() => null, e => e);
    assert.ok(error, 'expected a refusal');
    assert.deepEqual([error.code, error.status, error.message], [code, 409, SENTENCES[code]]);
    assert.equal(banned.test(error.message), false);
  };
  try {
    assert.equal((PACK as unknown as { settings: { pilotSize: number } }).settings.pilotSize, PILOT_SIZE);
    // Up to the pilot size no campaign is needed; the quote records and echoes none.
    const small = await body(await quoteOf(f.documents(PILOT_SIZE)));
    assert.deepEqual([small.status, small.body.campaign], [200, null]);
    // One more document: refused without a campaign, and with a full-run campaign that has no confirmation.
    await refused(f.documents(PILOT_SIZE + 1));
    await refused(f.documents(PILOT_SIZE + 1), { role: 'full', id: 'campaign-1' });
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 1);
    // A malformed campaign is a request error, not a pilot refusal.
    for (const bad of [null, 'pilot', { role: 'owner' }, { role: 'pilot', id: 'x' }, { role: 'full' }, { role: 'full', id: '' }])
      assert.equal((await quoteOf(f.documents(3), bad).catch(e => e)).code, 'E_REQUEST', JSON.stringify(bad));
    // A pilot is never larger than the pilot size (owner decision, 5 October 2026); the refusal stores nothing...
    await refused(f.documents(PILOT_SIZE + 1), { role: 'pilot' }, owner, 'E_PILOT_SIZE');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 1);
    // ...and at the pilot size the server issues the campaign id, stores it on the quote and copies it to the run.
    const pilot = await body(await quoteOf(f.documents(PILOT_SIZE), { role: 'pilot' }));
    assert.equal(pilot.status, 200);
    const campaign = pilot.body.campaign as { id: string; role: string };
    assert.equal(campaign.role, 'pilot');
    assert.match(campaign.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse((f.db.prepare('SELECT estimate_json FROM quotes WHERE id=?').get(String(pilot.body.quoteId)) as { estimate_json: string }).estimate_json).campaign, campaign);
    const pilotRun = await body(await createRun(f.post('runs', { quoteId: pilot.body.quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare'));
    assert.equal(pilotRun.status, 201);
    const pilotRunId = String(pilotRun.body.runId);
    assert.deepEqual({ ...f.db.prepare('SELECT campaign_id,campaign_role FROM runs WHERE id=?').get(pilotRunId) }, { campaign_id: campaign.id, campaign_role: 'pilot' });
    // No computed result unlocks the full run: a full quote is refused until a person's confirmation row exists...
    await refused(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id });
    // ...on this category version, recorded for this person's pilot: a confirmation only on an older version is stale.
    const version = String(pilot.body.typeVersion);
    f.db.prepare("INSERT INTO pilot_confirmations(id,campaign_id,pilot_run_id,definition_revision_id,filed_count,actor,created_at) VALUES('conf-old',?,?,'older-categories',3,?,'2026-09-29T00:00:00.000Z')").run(campaign.id, pilotRunId, owner);
    await refused(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id }, owner, 'E_PILOT_STALE');
    // Another person sees no confirmation at all on it (the pilot run is not theirs), so for them a pilot is required.
    await refused(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id }, 'other');
    f.db.prepare("INSERT INTO pilot_confirmations(id,campaign_id,pilot_run_id,definition_revision_id,filed_count,actor,created_at) VALUES('conf-1',?,?,?,3,?,'2026-09-29T00:00:01.000Z')").run(campaign.id, pilotRunId, version, owner);
    const full = await body(await quoteOf(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id }));
    assert.deepEqual([full.status, full.body.campaign], [200, { id: campaign.id, role: 'full' }]);
    // Another person cannot ride on this confirmation (the pilot run is not theirs).
    await refused(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id }, 'other');
    const fullRun = await body(await createRun(f.post('runs', { quoteId: full.body.quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare'));
    assert.equal(fullRun.status, 201);
    assert.deepEqual({ ...f.db.prepare('SELECT campaign_id,campaign_role FROM runs WHERE id=?').get(String(fullRun.body.runId)) }, { campaign_id: campaign.id, campaign_role: 'full' });
    // A small full run on the campaign needs no confirmation check and still carries the campaign.
    const smallFull = await body(await quoteOf(f.documents(2), { role: 'full', id: 'campaign-unconfirmed' }));
    assert.deepEqual([smallFull.status, smallFull.body.campaign], [200, { id: 'campaign-unconfirmed', role: 'full' }]);
    // The rule again at run creation: a confirmation stored before the pilot step (no campaign) above the pilot
    // size creates no run; one from before the step at or below the pilot size still does, with no campaign.
    const oldQuote = await body(await quoteOf(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id }));
    f.db.prepare("UPDATE quotes SET estimate_json=json_remove(estimate_json,'$.campaign') WHERE id=?").run(String(oldQuote.body.quoteId));
    const late = await createRun(f.post('runs', { quoteId: oldQuote.body.quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare').catch(e => e);
    assert.deepEqual([late.code, late.status], ['E_PILOT_REQUIRED', 409]);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs WHERE quote_id=?', String(oldQuote.body.quoteId)), 0);
    // A pilot confirmation above the pilot size creates no run either.
    const largePilot = await body(await quoteOf(f.documents(PILOT_SIZE + 1), { role: 'full', id: campaign.id }));
    f.db.prepare("UPDATE quotes SET estimate_json=json_set(estimate_json,'$.campaign',json(?)) WHERE id=?").run(JSON.stringify({ id: campaign.id, role: 'pilot' }), String(largePilot.body.quoteId));
    const tooLarge = await createRun(f.post('runs', { quoteId: largePilot.body.quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare').catch(e => e);
    assert.deepEqual([tooLarge.code, tooLarge.status, tooLarge.message], ['E_PILOT_SIZE', 409, SENTENCES.E_PILOT_SIZE]);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs WHERE quote_id=?', String(largePilot.body.quoteId)), 0);
    f.db.prepare("UPDATE quotes SET estimate_json=json_remove(estimate_json,'$.campaign') WHERE id=?").run(String(small.body.quoteId));
    const oldSmall = await body(await createRun(f.post('runs', { quoteId: small.body.quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare'));
    assert.equal(oldSmall.status, 201);
    assert.deepEqual({ ...f.db.prepare('SELECT campaign_id,campaign_role FROM runs WHERE id=?').get(String(oldSmall.body.runId)) }, { campaign_id: null, campaign_role: null });
    // An unreadable stored campaign is refused loudly, never read as "no campaign".
    f.db.prepare("UPDATE quotes SET estimate_json=json_set(estimate_json,'$.campaign',json('{\"role\":\"pilot\"}')) WHERE id=?").run(String(smallFull.body.quoteId));
    assert.equal((await createRun(f.post('runs', { quoteId: smallFull.body.quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare').catch(e => e)).code, 'E_STORAGE_D1');
  } finally { f.db.close(); }
});

// DECISIONS 88: the one way around the pilot rule is the person's explicit `skipPilot: true`, recorded and labelled.
test('skipPilot: only an explicit true, never beside a campaign; the run is labelled in its row, its note and its event', async () => {
  const f = fixture();
  const owner = 'person', PILOT_SIZE = 25, banned = /threshold|fingerprint|E_[A-Z_]+/;
  const quoteOf = (body: Record<string, unknown>) =>
    quote(f.post('quote', { mode: 'interactive', ...body }), f.env, f.store, owner, 'cloudflare');
  const refused = async (body: Record<string, unknown>, message: string) => {
    const error = await quoteOf(body).then(() => null, e => e);
    assert.ok(error, 'expected a refusal');
    assert.deepEqual([error.code, error.status, error.message], ['E_REQUEST', 400, message]);
    assert.equal(banned.test(error.message), false);
  };
  const create = (quoteId: unknown) =>
    createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, owner, 'cloudflare');
  const estimate = (quoteId: unknown) => JSON.parse((f.db.prepare('SELECT estimate_json FROM quotes WHERE id=?')
    .get(String(quoteId)) as { estimate_json: string }).estimate_json) as Record<string, unknown>;
  const created = (runId: unknown) => JSON.parse((f.db.prepare("SELECT details_json FROM events WHERE run_id=? AND stage='run' AND kind='created'")
    .get(String(runId)) as { details_json: string }).details_json) as Record<string, unknown>;
  try {
    // Only `true` is the choice: false or anything else is refused, and a campaign beside it is refused. Nothing is stored.
    for (const bad of [false, 'true', 1, null])
      await refused({ documents: f.documents(3), skipPilot: bad }, skipPilotCopy.notExplicit);
    await refused({ documents: f.documents(3), skipPilot: true, campaign: { role: 'pilot' } }, skipPilotCopy.notBoth);
    await refused({ documents: f.documents(PILOT_SIZE + 1), skipPilot: true, campaign: { role: 'full', id: 'campaign-1' } }, skipPilotCopy.notBoth);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 0);
    // Above the pilot size, with no campaign and no confirmation anywhere: accepted, recorded and echoed.
    const skipped = await body(await quoteOf({ documents: f.documents(PILOT_SIZE + 1), skipPilot: true }));
    assert.equal(skipped.status, 200);
    assert.deepEqual([skipped.body.campaign, skipped.body.pilotSkipped], [null, true]);
    assert.deepEqual([estimate(skipped.body.quoteId).campaign, estimate(skipped.body.quoteId).pilotSkipped], [null, true]);
    // A quote without the choice records false and echoes nothing: the key is absent, never false.
    const plain = await body(await quoteOf({ documents: f.documents(2) }));
    assert.deepEqual([plain.status, Object.hasOwn(plain.body, 'pilotSkipped'), estimate(plain.body.quoteId).pilotSkipped], [200, false, false]);
    // The run: the column, the run-level note and the event; no campaign; no document is touched.
    const run = await body(await create(skipped.body.quoteId));
    assert.equal(run.status, 201);
    assert.deepEqual({ ...f.db.prepare('SELECT campaign_id,campaign_role,pilot_skipped,notes_json,expected_count FROM runs WHERE id=?').get(String(run.body.runId)) },
      { campaign_id: null, campaign_role: null, pilot_skipped: 1, notes_json: JSON.stringify([PILOT_SKIPPED_NOTE]), expected_count: PILOT_SIZE + 1 });
    assert.deepEqual([created(run.body.runId).pilotSkipped, created(run.body.runId).campaign], [true, null]);
    const plainRun = await body(await create(plain.body.quoteId));
    assert.deepEqual({ ...f.db.prepare('SELECT pilot_skipped,notes_json FROM runs WHERE id=?').get(String(plainRun.body.runId)) }, { pilot_skipped: 0, notes_json: '[]' });
    assert.equal(Object.hasOwn(created(plainRun.body.runId), 'pilotSkipped'), false);
    // At or below the pilot size the choice is harmless, explicit and still labelled.
    const small = await body(await quoteOf({ documents: f.documents(2), skipPilot: true }));
    assert.deepEqual([small.status, small.body.pilotSkipped], [200, true]);
    const smallRun = await body(await create(small.body.quoteId));
    assert.deepEqual([smallRun.status, f.count('SELECT pilot_skipped AS n FROM runs WHERE id=?', String(smallRun.body.runId))], [201, 1]);
    // The rule again at creation reads the recorded choice: without it the oversize confirmation needs a pilot; an
    // unreadable value is refused loudly, never read as "not skipped".
    const later = await body(await quoteOf({ documents: f.documents(PILOT_SIZE + 1), skipPilot: true }));
    f.db.prepare("UPDATE quotes SET estimate_json=json_remove(estimate_json,'$.pilotSkipped') WHERE id=?").run(String(later.body.quoteId));
    assert.deepEqual([(await create(later.body.quoteId).catch(e => e)).code], ['E_PILOT_REQUIRED']);
    f.db.prepare("UPDATE quotes SET estimate_json=json_set(estimate_json,'$.pilotSkipped','yes') WHERE id=?").run(String(later.body.quoteId));
    assert.equal((await create(later.body.quoteId).catch(e => e)).code, 'E_STORAGE_D1');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs WHERE quote_id=?', String(later.body.quoteId)), 0);
  } finally { f.db.close(); }
});

test('a quote above the ceiling is refused with a plain sentence and stores nothing', async () => {
  const f = fixture();
  try {
    assert.equal(MAX_QUOTE_DOCUMENTS, 100_000);
    const docs = f.documents(MAX_QUOTE_DOCUMENTS + 1);
    const error = await quote(f.post('quote', { mode: 'interactive', documents: docs }), f.env, f.store, 'person', 'cloudflare').catch(e => e);
    assert.equal(error.code, 'E_REQUEST');
    assert.match(error.message, /at most 100,000 documents/);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 0);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quote_documents'), 0);
    assert.equal(f.batches.length, 0);
  } finally { f.db.close(); }
});


for (const failed of [true, false]) {
  test('a final ' + (failed ? 'failed-extraction' : 'text') + ' upload cannot commit after explicit discard', async () => {
    const f = fixture();
    try {
      const quoted = await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(1, failed ? [1] : []) }),
        f.env, f.store, 'person', 'cloudflare'));
      const created = await body(await createRun(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }),
        f.env, f.store, 'person', 'cloudflare'));
      const runId = String(created.body.runId), frozenRun = await f.store.run(runId);
      const { handleWithCloudflareIdentity } = await import('./api.ts');
      let closed = false;
      f.writeHooks.before = async sql => {
        if (!sql.some(s => s.startsWith('INSERT INTO documents('))) return;
        assert.equal(closed, false); closed = true;
        assert.deepEqual(await body(await handleWithCloudflareIdentity(f.post('runs/' + runId + '/close', { discardUnfinished: true }), f.env, 'person')),
          { status: 200, body: { closed: true } });
      };
      const failure = { code: 'E_SYNTHETIC_EXTRACTION', message: 'Synthetic extraction failure' };
      const input = failed ? { fingerprint: FP(1), originalFilename: 'document-1.pdf', failure } : f.upload(1);
      await assert.rejects(() => uploadDocument(f.post('runs/' + runId + '/documents', input), f.env, f.store, frozenRun),
        { code: 'E_REQUEST', message: 'This run is no longer accepting uploads.' });
      assert.equal(closed, true);
      const run = await f.store.run(runId);
      assert.equal(run.status, 'closed'); assert.equal(run.text_held, 0);
      assert.equal(f.count('SELECT COUNT(*) AS n FROM documents WHERE run_id=?', runId), 0);
      assert.equal(f.count("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND stage='upload' AND kind='completed'", runId), 0);
      const observed = f.db.prepare("SELECT details_json FROM events WHERE run_id=? AND stage='upload' AND kind='rejected_after_stop'").get(runId);
      assert.ok(observed); assert.deepEqual(JSON.parse(String(observed.details_json)), { failed, failure: failed ? failure : null });
      const results = await handleWithCloudflareIdentity(new Request('https://unit.invalid/api/runs/' + runId + '/results'), f.env, 'person');
      assert.equal(results.status, 409);
      assert.equal(f.count('SELECT COUNT(*) AS n FROM artifacts WHERE run_id=? AND contains_text=1 AND deleted_at IS NULL', runId), 0);
    } finally { f.db.close(); }
  });
}

// Reader choices exercise the real quote/create handlers against SQLite; no model is called.
async function withReaderMenu<T>(action: () => Promise<T>, limits = false): Promise<T> {
  const { projectSource } = await import('./health.ts');
  const source = projectSource as unknown as Record<string, unknown>, original = structuredClone(source);
  const owner = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'projects', 'owner', 'project.json'), 'utf8'));
  owner.id = PACK.id; owner.typeFile = original.typeFile; owner.structuralVocabulary = [];
  if (!limits) delete owner.settings.usageLimits;
  for (const key of Object.keys(source)) delete source[key];
  Object.assign(source, owner);
  try { return await action(); }
  finally { for (const key of Object.keys(source)) delete source[key]; Object.assign(source, original); }
}

test('reader choices: a menu refuses absent or unknown choices before recording a quote', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    for (const selectedReaderModel of [undefined, null, '', 'other', 'gpt-5.4-mini-2026-03-17']) {
      const request = { mode: 'interactive', documents: f.documents(1), ...(selectedReaderModel === undefined ? {} : { selectedReaderModel }) };
      await assert.rejects(quote(f.post('quote', request), f.env, f.store, 'person', 'cloudflare'));
      assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 0);
    }
  } finally { f.db.close(); }
}));

test('reader choices: the quote and run freeze mini; idempotent create survives a changed current menu', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    const quoted = await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(quoted.body.selectedReaderModel, 'mini');
    assert.deepEqual(quoted.body.readerModel, { id: 'mini', label: 'GPT-5.4 mini', pin: 'gpt-5.4-mini' });
    const id = String(quoted.body.quoteId);
    const stored = f.db.prepare('SELECT estimate_json FROM quotes WHERE id=?').get(id) as { estimate_json: string };
    assert.equal(JSON.parse(stored.estimate_json).selectedReaderModel, 'mini');
    const created = await body(await createRun(f.post('runs', { quoteId: id, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    const run = await f.store.run(String(created.body.runId)), pack = JSON.parse(run.pack_json);
    assert.equal(pack.selectedReaderModel, 'mini'); assert.equal(pack.pins.reader.id, 'gpt-5.4-mini');
    assert.equal(pack.prices.interactive.reader.inputNanodollarsPerMillion, '750000000');
    assert.equal(pack.prices.interactive.reader.outputNanodollarsPerMillion, '4500000000');
    assert.equal(pack.limits.readerContextTokens, 400000); assert.equal(pack.pins.recovery.id, 'gpt-5.4-nano');
    assert.equal(pack.settings.readerMaxOutputTokens, 16384); assert.equal(pack.settings.readerEffort, 'low');
    const plan = await runPlan(f.store, run); assert.equal(plan.selectedReaderModel, 'mini'); assert.deepEqual(plan.readerModel, quoted.body.readerModel);
    const { projectSource } = await import('./health.ts');
    delete (projectSource as unknown as { readerModels?: unknown }).readerModels;
    const again = await body(await createRun(f.post('runs', { quoteId: id, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(again.status, 200); assert.equal(again.body.runId, created.body.runId);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs'), 1);
  } finally { f.db.close(); }
}));

test('reader choices: changed selected rates invalidate an uncreated quote instead of silently substituting settings', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    const quoted = await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), f.env, f.store, 'person', 'cloudflare'));
    const { projectSource } = await import('./health.ts');
    const menu = (projectSource as unknown as { readerModels: { options: { id: string; rates: { outputNanodollarsPerMillion: string } }[] } }).readerModels;
    menu.options.find(option => option.id === 'mini')!.rates.outputNanodollarsPerMillion = '4500000001';
    await assert.rejects(createRun(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'), /project changed/);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs'), 0);
  } finally { f.db.close(); }
}));

test('usage limits: quote and create enforce the document and actor-day caps while returning an existing run idempotently', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    await assert.rejects(quote(f.post('quote', { mode: 'interactive', documents: f.documents(61), selectedReaderModel: 'standard', skipPilot: true }), f.env, f.store, 'person', 'cloudflare'), /60/);
    const newQuote = async () => (await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), f.env, f.store, 'person', 'cloudflare'))).body.quoteId;
    const make = async (quoteId: unknown) => body(await createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    await make(await newQuote()); await make(await newQuote());
    const thirdQuote = await newQuote(), fourthQuote = await newQuote();
    const third = await make(thirdQuote);
    await assert.rejects(make(fourthQuote));
    await assert.rejects(newQuote());
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs'), 3);
    assert.equal((await make(thirdQuote)).body.runId, third.body.runId);
  } finally { f.db.close(); }
}, true));

// F2 (independent review, 7 October 2026): price checks (quotes) are counted per person per UTC day, at ten times the
// daily run allowance, inside the quote's own insert, as comparison plans are; category editors are exempt.
const QUOTE_REFUSAL = { code: 'E_DAILY_QUOTE_LIMIT', status: 429,
  message: 'This site allows 30 price checks per person each UTC day. The allowance resets at 00:00 UTC.' };

test('usage limits: thirty price checks per person each UTC day; another person, an editor and the next day are unaffected', () => withReaderMenu(async () => {
  const f = fixture();
  f.env.DEFINITION_EDITORS = JSON.stringify(['editor']);
  try {
    const check = (actor: string) => quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), f.env, f.store, actor, 'cloudflare');
    for (let i = 0; i < 30; i++) assert.equal((await check('person')).status, 200);
    await assert.rejects(check('person'), QUOTE_REFUSAL);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM quotes WHERE actor='person'"), 30);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM quote_documents d JOIN quotes q ON q.id=d.quote_id WHERE q.actor='person'"), 30);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs'), 0, 'price checks are not runs');
    assert.equal((await check('other')).status, 200);
    for (let i = 0; i < 31; i++) assert.equal((await check('editor')).status, 200);
    // Checks made on an earlier UTC day do not count today.
    f.db.prepare("UPDATE quotes SET created_at=? WHERE actor='person'").run(new Date(Date.now() - 86_400_000).toISOString());
    assert.equal((await check('person')).status, 200);
  } finally { f.db.close(); }
}, true));

// DECISIONS 150 (owner, 9 October 2026): a person on the trusted-users list is exempt from the per-person daily caps, as a
// category editor is, without being one; the per-run document cap still applies to them.
test('usage limits: a trusted user passes the daily run and price-check caps that refuse an ordinary visitor, never the document cap', () => withReaderMenu(async () => {
  const f = fixture();
  f.env.TRUSTED_USERS = JSON.stringify(['trusted']);
  try {
    const quoteFor = async (actor: string, documents = 1, extra: Record<string, unknown> = {}) =>
      (await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(documents), selectedReaderModel: 'mini', ...extra }), f.env, f.store, actor, 'cloudflare'))).body.quoteId;
    const make = async (actor: string) => body(await createRun(f.post('runs', { quoteId: await quoteFor(actor), budget: BUDGET }), f.env, f.store, actor, 'cloudflare'));
    // A new run answers 201 (an idempotent repeat answers 200).
    for (let i = 0; i < 3; i++) { assert.equal((await make('person')).status, 201); assert.equal((await make('trusted')).status, 201); }
    // The visitor has used today's three runs; the trusted user has not been counted against any.
    await assert.rejects(quoteFor('person'), { code: 'E_DAILY_RUN_LIMIT' });
    for (let i = 0; i < 2; i++) assert.equal((await make('trusted')).status, 201);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM runs WHERE actor='person'"), 3);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM runs WHERE actor='trusted'"), 5);
    // Price checks: thirty for a visitor, then refused; the trusted user (five checks so far) passes thirty-one more.
    for (let i = 0; i < 30; i++) assert.ok(await quoteFor('visitor'));
    await assert.rejects(quoteFor('visitor'), QUOTE_REFUSAL);
    for (let i = 0; i < 31; i++) assert.ok(await quoteFor('trusted'));
    assert.equal(f.count("SELECT COUNT(*) AS n FROM quotes WHERE actor='trusted'"), 36);
    // The per-run document cap is everyone's: 61 documents are refused for the trusted user before anything is stored.
    const before = f.count('SELECT COUNT(*) AS n FROM quotes');
    await assert.rejects(quoteFor('trusted', 61, { skipPilot: true }), { code: 'E_RUN_DOCUMENT_LIMIT' });
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), before);
  } finally { f.db.close(); }
}, true));

test('usage limits: the price-check count is part of the quote insert, so a check committed meanwhile is counted', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    const check = () => quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), f.env, f.store, 'person', 'cloudflare');
    for (let i = 0; i < 29; i++) assert.equal((await check()).status, 200);
    let raced = false;
    f.writeHooks.before = async sql => {
      if (raced || !sql[0]?.startsWith('INSERT INTO quotes(')) return;
      raced = true;
      // Another price check by the same person commits between this one's own check and its insert.
      f.db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('raced','person',?,'interactive','types','pack','[]','{}')")
        .run(new Date().toISOString());
    };
    await assert.rejects(check(), QUOTE_REFUSAL);
    assert.equal(raced, true);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM quotes WHERE actor='person'"), 30);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM quote_documents d JOIN quotes q ON q.id=d.quote_id WHERE q.actor='person'"), 29);
  } finally { f.db.close(); }
}, true));

test('without usage limits a site has no price-check allowance', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 31; i++)
      assert.equal((await quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), f.env, f.store, 'person', 'cloudflare')).status, 200);
  } finally { f.db.close(); }
}, false));

// Abuse resistance (owner requirement, 6 October 2026). Crafted bodies cannot choose a model outside the pack's menu or
// slip past the per-run and per-person caps, and nothing happens without a verified sign-in. The site-wide pool caps,
// which bound any number of identities, are tested in execution-daily-usage.test.ts.
test('crafted model choice: raw model names, unknown ids and extra fields are refused before any quote or run exists', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    const attempt = (extra: Record<string, unknown>) => quote(f.post('quote', { mode: 'interactive', documents: f.documents(1), ...extra }), f.env, f.store, 'person', 'cloudflare');
    for (const selectedReaderModel of ['gpt-5.4-2026-03-05', 'gpt-5.4-mini-2026-03-17', 'gpt-6-sol', 'gpt-5.4', '__proto__', 'constructor',
      'toString', 'Standard', ' standard', 'standard ', 'mini\u0000', 0, true, null, { id: 'mini' }, ['mini']])
      await assert.rejects(attempt({ selectedReaderModel }), Error, JSON.stringify(selectedReaderModel));
    for (const extra of [{ pins: { reader: { id: 'gpt-6-sol' } } }, { pack: {} }, { model: 'gpt-6-sol' }, { readerModels: {} },
      { settings: { usageLimits: null } }, { usageLimits: null }, { selectedReaderPin: 'gpt-6-sol' }])
      await assert.rejects(attempt({ selectedReaderModel: 'mini', ...extra }), Error, JSON.stringify(extra));
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 0);
    // A valid quote, then a run request that tries to carry its own pack, pins or model: refused, nothing created.
    const quoted = await body(await attempt({ selectedReaderModel: 'mini' }));
    for (const extra of [{ pack: {} }, { pins: {} }, { selectedReaderModel: 'standard' }, { model: 'gpt-6-sol' }])
      await assert.rejects(createRun(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET, ...extra }), f.env, f.store, 'person', 'cloudflare'));
    assert.equal(f.count('SELECT COUNT(*) AS n FROM runs'), 0);
    const created = await body(await createRun(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }), f.env, f.store, 'person', 'cloudflare'));
    const pack = JSON.parse((await f.store.run(String(created.body.runId))).pack_json);
    assert.equal(pack.pins.reader.id, 'gpt-5.4-mini', 'the run carries the menu pin the server chose');
  } finally { f.db.close(); }
}, true));

test('request limits: crafted bodies cannot pass the per-run document cap or the per-person run cap', () => withReaderMenu(async () => {
  const f = fixture();
  try {
    const quoteFor = async (actor: string, documents: number, extra: Record<string, unknown> = {}) =>
      (await body(await quote(f.post('quote', { mode: 'interactive', documents: f.documents(documents), selectedReaderModel: 'mini', ...extra }), f.env, f.store, actor, 'cloudflare'))).body.quoteId;
    const make = (actor: string, quoteId: unknown) => createRun(f.post('runs', { quoteId, budget: BUDGET }), f.env, f.store, actor, 'cloudflare');
    // A huge count, with or without the trial bypass, is refused before anything is stored.
    for (const documents of [61, 1000, MAX_QUOTE_DOCUMENTS])
      await assert.rejects(quoteFor('person', documents, { skipPilot: true }));
    assert.equal(f.count('SELECT COUNT(*) AS n FROM quotes'), 0);
    // Quotes are not runs: four confirmations, then four concurrent creations, still give exactly three runs.
    const quotes = [await quoteFor('person', 1), await quoteFor('person', 1), await quoteFor('person', 1), await quoteFor('person', 1)];
    const outcomes = await Promise.allSettled(quotes.map(id => make('person', id)));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 3);
    assert.equal((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason.code, 'E_DAILY_RUN_LIMIT');
    assert.equal(f.count("SELECT COUNT(*) AS n FROM runs WHERE actor='person'"), 3);
    await assert.rejects(quoteFor('person', 1), { code: 'E_DAILY_RUN_LIMIT' });
    // A run cannot grow past its confirmed documents: an upload outside the confirmation is refused.
    const runId = String((await body(await make('other', await quoteFor('other', 1)))).body.runId);
    await assert.rejects(uploadDocument(f.post('runs/' + runId + '/documents', f.upload(2)), f.env, f.store, await f.store.run(runId)),
      /not included in the confirmed preflight/);
    assert.equal((await f.store.run(runId)).expected_count, 1);
    // Honest limit: the run cap is per signed-in identity. A different identity is a different person here, so the
    // site-wide pools, not this cap, are what bound someone who signs in with many identities.
    assert.ok(await quoteFor('third-identity', 1));
  } finally { f.db.close(); }
}, true));

test('sign-in: without a verified identity no route quotes, creates, starts or reaches a vendor; health and project call nothing', () => withReaderMenu(async () => {
  const f = fixture();
  const { handle, handleWithCloudflareIdentity } = await import('./api.ts');
  const network: string[] = [], created: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => { network.push(String(input instanceof Request ? input.url : input)); throw new Error('No network in this test.'); }) as typeof fetch;
  const env = { ...f.env, ACCESS_TEAM_DOMAIN: 'synthetic.cloudflareaccess.com', ACCESS_AUD: 'synthetic-audience',
    DOCUMENT_WORKFLOW: { createBatch: async (batch: unknown) => { created.push(batch); return []; } } } as unknown as Env;
  try {
    // The owner's own run exists, so start and upload routes have a real target.
    const quoted = await body(await handleWithCloudflareIdentity(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }), env, 'person'));
    const runId = String((await body(await handleWithCloudflareIdentity(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }), env, 'person'))).body.runId);
    const before = { quotes: f.count('SELECT COUNT(*) AS n FROM quotes'), runs: f.count('SELECT COUNT(*) AS n FROM runs') };
    const routes: [string, string, unknown?][] = [
      ['POST', 'quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel: 'mini' }],
      ['POST', 'runs', { quoteId: quoted.body.quoteId, budget: BUDGET }],
      ['POST', 'runs/' + runId + '/documents', f.upload(1)],
      ['POST', 'runs/' + runId + '/start', {}],
      ['POST', 'bakeoffs', {}],
      ['GET', 'usage'], ['GET', 'runs'], ['GET', 'runs/' + runId]
    ];
    for (const token of [null, 'not-a-signed-assertion'])
      for (const [method, path, payload] of routes) {
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}) };
        const response = await handle(new Request('https://unit.invalid/api/' + path, { method, headers,
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), env);
        assert.equal(response.status, 401, method + ' ' + path + ' with ' + (token ? 'an unsigned token' : 'no token'));
      }
    assert.deepEqual({ quotes: f.count('SELECT COUNT(*) AS n FROM quotes'), runs: f.count('SELECT COUNT(*) AS n FROM runs') }, before);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM documents WHERE run_id=?", runId), 0);
    assert.deepEqual(created, [], 'no Workflow was started');
    for (const path of ['health', 'project', 'project?selectedReaderModel=mini'])
      await handle(new Request('https://unit.invalid/api/' + path), env);
    assert.deepEqual(network, [], 'no request left the Worker: no vendor call and no key lookup');
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
}, true));

// DECISIONS 136, addendum item 4: the server refuses an unusable reader at Start as the backstop behind the greyed-out
// menu. A run created while its reader was usable is refused at Start once the reader's binding or key is gone, before
// anything is dispatched; a run whose reader is still usable starts exactly as before.
test('Start refuses a reader that has become unusable since the run was created; a usable reader starts as before', () => withReaderMenu(async () => {
  const f = fixture();
  const { handleWithCloudflareIdentity } = await import('./api.ts');
  const network: string[] = [], created: { id: string }[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => { network.push(String(input instanceof Request ? input.url : input)); throw new Error('No network in this test.'); }) as typeof fetch;
  const usable = { ...f.env, DEEPSEEK_API_KEY: { get: async () => 'local-test-only' },
    AI: { run: async () => { throw new Error('No model call in this test.'); } },
    DOCUMENT_WORKFLOW: { createBatch: async (batch: { id: string }[]) => { created.push(batch); return batch.map(item => ({ id: item.id })); } } } as unknown as Env;
  const { DEEPSEEK_API_KEY: _key, ...withoutKey } = usable as unknown as Record<string, unknown>;
  const { AI: _ai, ...withoutBinding } = usable as unknown as Record<string, unknown>;
  const runFor = async (selectedReaderModel: string) => {
    const quoted = await body(await handleWithCloudflareIdentity(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel }), usable, 'person'));
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    const runId = String((await body(await handleWithCloudflareIdentity(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }), usable, 'person'))).body.runId);
    assert.equal((await handleWithCloudflareIdentity(f.post('runs/' + runId + '/documents', f.upload(1)), usable, 'person')).status, 201);
    return runId;
  };
  const start = async (runId: string, env: unknown) => body(await handleWithCloudflareIdentity(f.post('runs/' + runId + '/start', {}), env as Env, 'person'));
  try {
    for (const [reader, env] of [['deepseek', withoutKey], ['qwen', withoutBinding]] as const) {
      const runId = await runFor(reader);
      const refused = await start(runId, env);
      assert.equal(refused.status, 409, reader);
      assert.equal((refused.body.error as { code?: string } | undefined)?.code ?? refused.body.code, 'E_READER_UNAVAILABLE', JSON.stringify(refused.body));
      assert.equal((await f.store.run(runId)).status, 'uploading', 'the run did not start');
    }
    assert.deepEqual(created, [], 'no document Workflow was dispatched');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM daily_usage_reservations'), 0, 'nothing was reserved');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM vendor_calls'), 0, 'nothing was sent');
    // A run whose reader is still usable starts exactly as before.
    const runId = await runFor('deepseek');
    const started = await start(runId, usable);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.started, 1);
    assert.equal((await f.store.run(runId)).status, 'running');
    assert.equal(created.length, 1);
    // Its first Start reads DeepSeek's model list once (here the network refuses it, which never blocks); nothing else leaves.
    assert.deepEqual(network, ['https://api.deepseek.com/models'], 'only the model list was asked for');
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
}, true));

// Owner decision of 7 October 2026 (DECISIONS 136 addendum, as revised that day): DeepSeek moves `deepseek-flash` forward
// to newer versions and its replies report only that id. When a DeepSeek run first starts, DeepSeek's model list is read
// once, its raw reply kept, and the `name` it gives the run's model recorded on the run. A record, never a gate: a list
// that cannot be read is recorded as not known, with the reason, and the run starts as before.
test('a DeepSeek run records the version DeepSeek lists at its first Start; a failed lookup is recorded and never blocks', () => withReaderMenu(async () => {
  const f = fixture();
  const { handleWithCloudflareIdentity } = await import('./api.ts');
  const LIST = JSON.stringify({ object: 'list', data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro' }] });
  const calls: { url: string; method: string | undefined; authorization: string | null; redirect: string | undefined; body: unknown }[] = [];
  let answer: () => Response = () => new Response(LIST, { status: 200, headers: { 'content-type': 'application/json' } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect, body: init?.body });
    return answer();
  }) as typeof fetch;
  const env = { ...f.env, DEEPSEEK_API_KEY: { get: async () => 'local-test-only' },
    AI: { run: async () => { throw new Error('No model call in this test.'); } },
    DOCUMENT_WORKFLOW: { createBatch: async (batch: { id: string }[]) => batch.map(item => ({ id: item.id })) } } as unknown as Env;
  // One person per run: the per-person daily run count is not what this test is about.
  const runFor = async (selectedReaderModel: string, actor: string) => {
    const quoted = await body(await handleWithCloudflareIdentity(f.post('quote', { mode: 'interactive', documents: f.documents(1), selectedReaderModel }), env, actor));
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    const runId = String((await body(await handleWithCloudflareIdentity(f.post('runs', { quoteId: quoted.body.quoteId, budget: BUDGET }), env, actor))).body.runId);
    assert.equal((await handleWithCloudflareIdentity(f.post('runs/' + runId + '/documents', f.upload(1)), env, actor)).status, 201);
    return runId;
  };
  const start = async (runId: string, actor: string) => body(await handleWithCloudflareIdentity(f.post('runs/' + runId + '/start', {}), env, actor));
  const status = async (runId: string, actor: string) =>
    (await body(await handleWithCloudflareIdentity(new Request('https://unit.invalid/api/runs/' + runId + '/status'), env, actor))).body.run as Record<string, unknown>;
  const recorded = (runId: string) => (f.db.prepare("SELECT details_json FROM events WHERE run_id=? AND stage='start' AND kind='reader_version'")
    .all(runId) as { details_json: string }[]).map(row => JSON.parse(row.details_json) as { name: string | null; reason: string | null; status: number | null; responseKey: string | null });
  const shown = (run: Record<string, unknown>) => {
    const version = run.readerVersion as Record<string, unknown>;
    assert.match(String(version.recordedAt), /^\d{4}-\d{2}-\d{2}T/);
    return { ...version, recordedAt: 'at' };
  };
  try {
    const runId = await runFor('deepseek', 'person');
    const started = await start(runId, 'person');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.started, 1);
    assert.equal((await f.store.run(runId)).status, 'running');
    assert.deepEqual(calls, [{ url: 'https://api.deepseek.com/models', method: 'GET', authorization: 'Bearer local-test-only', redirect: 'manual', body: undefined }]);
    const [event, ...more] = recorded(runId);
    assert.equal(more.length, 0);
    assert.deepEqual([event.name, event.reason, event.status], ['DeepSeek-V4.1-Flash', null, 200]);
    // The raw reply is kept as received, in the run's own immutable artifact, before anything reads it.
    const stored = JSON.parse(f.objects.get(String(event.responseKey))!) as { raw: string; status: number; networkFailure: boolean };
    assert.deepEqual([stored.raw, stored.status, stored.networkFailure], [LIST, 200, false]);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM artifacts WHERE run_id=? AND kind='reader_version_response' AND state='complete' AND contains_text=0", runId), 1);
    assert.deepEqual(shown(await status(runId, 'person')), { model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reason: null, recordedAt: 'at' });
    // A repeated Start on the running run reads nothing again.
    assert.equal((await start(runId, 'person')).status, 200);
    assert.equal(calls.length, 1); assert.equal(recorded(runId).length, 1);
    // Every way the list can fail is recorded as not known, with one read and no retry, and the run starts as before.
    const failures: [string, () => Response][] = [
      ['network', () => { throw new TypeError('fetch failed'); }],
      ['status', () => new Response('{"error":{"message":"overloaded"}}', { status: 503 })],
      ['missing_entry', () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro' }] }), { status: 200 })],
      ['missing_name', () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }] }), { status: 200 })],
      ['unreadable', () => new Response('<html>gateway</html>', { status: 200 })]
    ];
    for (const [reason, failing] of failures) {
      answer = failing;
      const actor = 'person-' + reason, id = await runFor('deepseek', actor);
      const before: number = calls.length;
      const result = await start(id, actor);
      assert.equal(result.status, 200, reason + ' ' + JSON.stringify(result.body));
      assert.equal(result.body.started, 1, reason);
      assert.equal((await f.store.run(id)).status, 'running', reason);
      assert.equal(calls.length, before + 1, reason + ': one read');
      const [record] = recorded(id);
      assert.deepEqual([record.name, record.reason], [null, reason]);
      // Every request sent is kept, as a model call's is: the reply as received, or the typed fact that none arrived.
      const kept = JSON.parse(f.objects.get(String(record.responseKey))!) as { raw: string | null; networkFailure: boolean };
      assert.equal(kept.networkFailure, reason === 'network', reason);
      assert.equal(kept.raw === null, reason === 'network', reason);
      assert.deepEqual(shown(await status(id, actor)), { model: 'deepseek-flash', name: null, reason, recordedAt: 'at' });
    }
    // Runs with any other reader never read the list, and carry no reader version.
    answer = () => { throw new Error('No other request in this test.'); };
    for (const reader of ['standard', 'mini', 'qwen']) {
      const actor = 'person-' + reader, id = await runFor(reader, actor);
      const before: number = calls.length;
      assert.equal((await start(id, actor)).status, 200, reader);
      assert.equal(calls.length, before, reader);
      assert.equal(recorded(id).length, 0, reader);
      assert.equal(Object.hasOwn(await status(id, actor), 'readerVersion'), false, reader);
    }
  } finally { globalThis.fetch = originalFetch; f.db.close(); }
}, true));
