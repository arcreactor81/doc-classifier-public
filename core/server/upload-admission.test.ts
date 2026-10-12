import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import type { SQLInputValue } from 'node:sqlite';
import { Store } from './store.ts';
import { failureResponse, ServerFailure } from './errors.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const PACK = syntheticPack(1);
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack'
      ? { url: 'project-pack:upload-admission', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:upload-admission'
      ? { format: 'json', source: JSON.stringify(PACK), shortCircuit: true } : next(url, context);
  }
});
const { uploadDocument } = await import('./intake.ts');
const FP = '1'.repeat(64), AT = '2026-10-01T00:00:00.000Z';
const transient = () => new Error('D1_ERROR: Network connection lost.');
interface Bound { sql: string; values: SQLInputValue[] }
interface Attempt { statements: Bound[]; number: number }
interface Hooks {
  before?(attempt: Attempt): Promise<void> | void;
  after?(attempt: Attempt): Promise<void> | void;
  read?(sql: string): Promise<void> | void;
  readResult?(result: unknown): unknown;
  result?(result: unknown): unknown;
}

function fixture(extractionFailed = false) {
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2(), hooks: Hooks = {};
  const counts = { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null };
  db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)')
    .run('quote', 'synthetic-owner', AT, 'interactive', 'types', 'pack', '[]', '{}');
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'uploading',?,'interactive',1,0.9,'initial','types',?,'{}','quote')")
    .run('run', 'synthetic-owner', AT, JSON.stringify(PACK));
  db.prepare('INSERT INTO quote_documents(quote_id,ordinal,fingerprint,original_filename,token_counts_json,needs_outline_recovery,failed) VALUES(?,?,?,?,?,0,?)')
    .run('quote', 1, FP, 'synthetic.pdf', JSON.stringify(counts), Number(extractionFailed));
  const input = extractionFailed
    ? { fingerprint: FP, originalFilename: 'synthetic.pdf', failure: { code: 'E_SYNTHETIC_EXTRACTION', message: 'Synthetic extraction failure.' } }
    : { fingerprint: FP, originalFilename: 'synthetic.pdf', fullText: 'Synthetic input text.',
      outline: { headings: [], tables: [], blocks: [] }, extractorVersion: 'synthetic-extractor',
      parserVersions: { pdf: 'synthetic-parser' }, needsOutlineRecovery: false, tokenCounts: counts,
      tokenizerIds: { reader: null, confidence: null } };
  const attempts: Attempt[] = [], prepare = DB.prepare.bind(DB), batch = DB.batch.bind(DB);
  DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), first = statement.first.bind(statement);
      statement.bind = (...values) => wrap(bind(...values));
      statement.first = async <T = unknown>(column?: string) => {
        await hooks.read?.(sql);
        const result = column === undefined ? await first<T>() : await first<T>(column);
        return (sql.includes('AS document_json') && hooks.readResult ? hooks.readResult(result) : result) as T | null;
      };
      return statement;
    };
    return wrap(prepare(sql));
  };
  DB.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    const bound = statements as unknown as Bound[];
    if (!bound[0]?.sql.startsWith('INSERT INTO documents')) return batch<T>(statements);
    const attempt = { statements: bound.map(value => ({ sql: value.sql, values: [...value.values] })), number: attempts.length + 1 };
    attempts.push(attempt); await hooks.before?.(attempt);
    const result = await batch<T>(statements); await hooks.after?.(attempt);
    return (hooks.result ? hooks.result(result) : result) as typeof result;
  };
  let puts = 0;
  const put = bucket.put.bind(bucket);
  bucket.put = async (...args) => { puts++; return put(...args); };
  const store = new Store({ DB, ARTIFACTS: bucket } as unknown as Env);
  const send = async () => uploadDocument(new Request('https://unit.invalid/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
  }), store.env, store, await store.run('run'));
  const rows = () => ({ documents: db.prepare('SELECT * FROM documents').all(),
    events: db.prepare("SELECT * FROM events WHERE stage='upload' AND kind='completed'").all(),
    artifacts: db.prepare('SELECT * FROM artifacts').all() });
  const commit = (attempt: Attempt) => {
    db.exec('BEGIN');
    try { for (const item of attempt.statements) db.prepare(item.sql).run(...item.values); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, DB, hooks, attempts, send, rows, commit, puts: () => puts, bucket, store };
}

for (const failed of [false, true]) {
  test(`a same-payload concurrent invocation cannot be adopted (extraction failed: ${failed})`, async () => {
    const f = fixture(failed);
    let winner: Response | undefined;
    f.hooks.before = async attempt => {
      if (attempt.number === 1) { winner = await f.send(); throw transient(); }
    };
    try {
      await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
      assert.equal(winner?.status, 201); assert.equal(f.attempts.length, 2);
      assert.notEqual(f.attempts[0]!.statements[1]!.values[0], f.attempts[1]!.statements[1]!.values[0]);
      assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
      assert.equal(f.puts(), failed ? 0 : 2);
    } finally { f.db.close(); }
  });
}

for (const failed of [false, true]) {
  test(`two concurrent uploads of the same document: one is admitted, the other answers as a repeat, never an internal error (extraction failed: ${failed})`, async () => {
    const f = fixture(failed);
    let winner: Response | undefined;
    // The other upload commits between this one's duplicate check and its admission batch; nothing here is transient.
    f.hooks.before = async attempt => { if (attempt.number === 1) winner = await f.send(); };
    try {
      const repeat = await f.send();
      assert.equal(winner?.status, 201);
      assert.equal(repeat.status, 200);
      assert.deepEqual(await repeat.json(), { uploaded: true, idempotent: true });
      assert.equal(f.attempts.length, 2);
      assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
    } finally { f.db.close(); }
  });
}

test('a concurrent upload of the same fingerprint with different content is refused as a repeat with different content', async () => {
  const f = fixture();
  f.hooks.before = async attempt => {
    if (attempt.number !== 1) return;
    // The first admission to commit carries other text for the same fingerprint.
    f.db.prepare(attempt.statements[0]!.sql).run(...attempt.statements[0]!.values.map((value, index) => index === 6 ? 'other-input-hash' : value));
  };
  try {
    await assert.rejects(f.send(), { code: 'E_REQUEST', message: 'An upload with this fingerprint already exists with different content.' });
    assert.equal(f.rows().documents.length, 1);
  } finally { f.db.close(); }
});

test('post-commit explicit closure can reconcile admission without restoring deleted text', async () => {
  const f = fixture();
  f.hooks.after = async () => { await f.store.close('run', 'synthetic-owner'); throw transient(); };
  try {
    assert.equal((await f.send()).status, 201);
    assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1); assert.equal(f.bucket.objects.size, 0);
    assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'closed');
  } finally { f.db.close(); }
});

for (const result of [null, {}, { document_json: null }, { event_json: null },
  { document_json: 'null', event_json: 'null' }, { document_json: '{', event_json: '{' }]) {
  test(`incomplete or malformed readback never proves absence: ${JSON.stringify(result)}`, async () => {
    const f = fixture(); f.hooks.before = () => { throw transient(); }; f.hooks.readResult = () => result;
    try {
      await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
      assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1);
      assert.equal(f.rows().documents.length, 0); assert.equal(f.rows().events.length, 0);
    } finally { f.db.close(); }
  });
}

test('a late uniqueness error without the owned pair cannot authorize a third attempt', async () => {
  const f = fixture();
  f.hooks.before = attempt => {
    if (attempt.number === 1) throw transient();
    throw new Error('D1_ERROR: UNIQUE constraint failed: documents.run_id, documents.tag: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)');
  };
  try {
    await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
    assert.equal(f.attempts.length, 2); assert.equal(f.puts(), 1);
    assert.equal(f.rows().documents.length, 0); assert.equal(f.rows().events.length, 0);
  } finally { f.db.close(); }
});

test('the final permitted transient attempt is reconciled if its commit succeeded', async () => {
  const f = fixture();
  f.hooks.before = attempt => { if (attempt.number < 3) throw transient(); };
  f.hooks.after = () => { throw transient(); };
  try {
    assert.equal((await f.send()).status, 201); assert.equal(f.attempts.length, 3); assert.equal(f.puts(), 1);
    assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
  } finally { f.db.close(); }
});

test('diagnostics and the public typed failure contain no input, filename, SQL or arbitrary exception details', async context => {
  const logs: string[] = [];
  context.mock.method(console, 'log', (value: string) => logs.push(value));
  context.mock.method(console, 'error', (value: string) => logs.push(value));
  const f = fixture();
  const secretDetail = 'Synthetic private SQL or request content.';
  f.hooks.before = () => { throw transient(); };
  f.hooks.read = sql => { if (sql.includes('AS document_json')) throw new Error(secretDetail); };
  try {
    await assert.rejects(f.send(), error => {
      assert.ok(error instanceof ServerFailure); assert.equal(error.code, 'E_UPLOAD_ADMISSION');
      assert.ok(error.cause instanceof AggregateError);
      assert.ok(!JSON.stringify(failureResponse(error)).includes(secretDetail)); return true;
    });
    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]!);
    assert.deepEqual(Object.keys(entry).sort(), ['attempts', 'errors', 'eventId', 'fingerprint', 'operation', 'outcome', 'runId']);
    assert.equal(entry.operation, 'upload_admission'); assert.equal(entry.outcome, 'failed');
    assert.deepEqual(entry.errors, ['D1_NETWORK_CONNECTION_LOST']); assert.equal(entry.attempts, 1);
    for (const forbidden of [secretDetail, 'synthetic.pdf', 'Synthetic input text.', 'INSERT INTO'])
      assert.ok(!logs[0]!.includes(forbidden));
  } finally { f.db.close(); }
});

for (const failed of [false, true]) {
  const kind = failed ? 'extraction failure' : 'text';
  test(`${kind}: ordinary upload admits exactly one document and completion event`, async () => {
    const f = fixture(failed);
    try {
      assert.equal((await f.send()).status, 201);
      assert.equal(f.attempts.length, 1); assert.equal(f.puts(), failed ? 0 : 1);
      assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
    } finally { f.db.close(); }
  });
  for (const when of ['before', 'after'] as const) {
    test(`${kind}: ${when}-commit transient recovers this admission without another artifact write`, async () => {
      const f = fixture(failed);
      f.hooks[when] = attempt => { if (attempt.number === 1) throw transient(); };
      try {
        const response = await f.send();
        assert.equal(response.status, 201); assert.deepEqual(await response.json(), { uploaded: true, idempotent: false });
        assert.equal(f.attempts.length, when === 'before' ? 2 : 1); assert.equal(f.puts(), failed ? 0 : 1);
        assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
        for (const attempt of f.attempts) assert.deepEqual(attempt.statements, f.attempts[0]!.statements);
      } finally { f.db.close(); }
    });
  }
  test(`${kind}: three uncommitted transient failures stop with a typed admission failure`, async () => {
    const f = fixture(failed); f.hooks.before = () => { throw transient(); };
    try {
      await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
      assert.equal(f.attempts.length, 3); assert.equal(f.puts(), failed ? 0 : 1);
      assert.equal(f.rows().documents.length, 0); assert.equal(f.rows().events.length, 0);
      assert.equal(f.rows().artifacts.length, failed ? 0 : 1);
    } finally { f.db.close(); }
  });
  for (const status of ['closing', 'closed', 'halted']) {
    test(`${kind}: ${status} before retry prevents admission`, async () => {
      const f = fixture(failed);
      f.hooks.before = attempt => {
        if (attempt.number === 1) {
          f.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, 'run'); throw transient();
        }
      };
      try {
        await assert.rejects(f.send(), /no longer accepting uploads/);
        assert.equal(f.attempts.length, 2); assert.equal(f.puts(), failed ? 0 : 1);
        assert.equal(f.rows().documents.length, 0); assert.equal(f.rows().events.length, 0);
        assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, status);
      } finally { f.db.close(); }
    });
  }
  test(`${kind}: a late first commit is reconciled after its identical retry collides`, async () => {
    const f = fixture(failed);
    f.hooks.before = attempt => {
      if (attempt.number === 1) throw transient();
      if (attempt.number === 2) f.commit(f.attempts[0]!);
    };
    try {
      assert.equal((await f.send()).status, 201);
      assert.equal(f.attempts.length, 2); assert.equal(f.puts(), failed ? 0 : 1);
      assert.equal(f.rows().documents.length, 1); assert.equal(f.rows().events.length, 1);
    } finally { f.db.close(); }
  });
}

for (const message of ['D1 DB is overloaded. Requests queued for too long.', 'D1 storage timeout',
  'D1_ERROR: Network connection lost. extra', 'UNIQUE constraint failed: documents.run_id, documents.tag']) {
  test(`unrecognized admission failure has no retry: ${message}`, async () => {
    const f = fixture(); f.hooks.before = () => { throw new Error(message); };
    try {
      await assert.rejects(f.send()); assert.equal(f.attempts.length, 1);
      assert.equal(f.puts(), 1); assert.equal(f.rows().documents.length, 0);
    } finally { f.db.close(); }
  });
}

for (const mutation of [
  "DELETE FROM events WHERE stage='upload' AND kind='completed'",
  'DELETE FROM documents',
  "UPDATE documents SET input_key='other-invocation'",
  "UPDATE documents SET input_hash='other-content'",
  "UPDATE documents SET extraction_json='{}'",
  "UPDATE events SET created_at='other-time' WHERE stage='upload'",
  "UPDATE events SET details_json='{}' WHERE stage='upload'"
]) {
  test(`partial or changed admission cannot be adopted: ${mutation}`, async () => {
    const f = fixture(); f.hooks.after = () => { f.db.exec(mutation); throw transient(); };
    try {
      await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
      assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1);
    } finally { f.db.close(); }
  });
}

test('a committed admission remains owned when separately authorized processing advances mutable fields', async () => {
  const f = fixture();
  f.hooks.after = () => {
    f.db.exec("UPDATE runs SET status='running'; UPDATE documents SET status='complete',notes_json='[\"N_SYNTHETIC\"]',decision_json='{}',failure_json='{}'");
    throw transient();
  };
  try {
    assert.equal((await f.send()).status, 201); assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1);
    assert.equal(f.rows().documents[0]!.status, 'complete');
    assert.equal(f.rows().documents[0]!.notes_json, '["N_SYNTHETIC"]');
  } finally { f.db.close(); }
});

test('another invocation with the same payload but another completion event cannot be adopted', async () => {
  const f = fixture();
  f.hooks.after = () => {
    f.db.exec("UPDATE events SET id='another-invocation' WHERE stage='upload' AND kind='completed'");
    throw transient();
  };
  try {
    await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
    assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1);
  } finally { f.db.close(); }
});

test('a failed authoritative readback never authorizes a second admission attempt', async () => {
  const f = fixture(); let rejected = false;
  f.hooks.before = () => { rejected = true; throw transient(); };
  f.hooks.read = () => { if (rejected) throw new Error('Synthetic unreadable database.'); };
  try {
    await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
    assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1);
    assert.equal(f.rows().documents.length, 0); assert.equal(f.rows().events.length, 0);
  } finally { f.db.close(); }
});

for (const result of [[], [{ meta: { changes: 1 } }], [{ meta: { changes: 1 } }, { meta: { changes: 0 } }],
  [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
  [{ success: false, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } }],
  [{ success: false, meta: { changes: 0 } }, { success: false, meta: { changes: 0 } }]]) {
  test(`malformed or contradictory batch result is refused: ${JSON.stringify(result)}`, async () => {
    const f = fixture(); f.hooks.result = () => result;
    try {
      await assert.rejects(f.send(), { code: 'E_UPLOAD_ADMISSION' });
      assert.equal(f.attempts.length, 1); assert.equal(f.puts(), 1);
    } finally { f.db.close(); }
  });
}
