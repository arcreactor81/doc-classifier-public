import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, CLOSE_PAGE, CLOSE_PENDING_PAGE, CLOSE_WORST_CASE_D1_QUERIES } from './store.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { persistTextDeletion } from './text-deletion-persistence.ts';
import { serverCopy } from './errors.ts';
// Execute the real browser paging helper without pulling its DOM-only dependencies into the Worker typecheck.
const closeInRounds: (close: () => ReturnType<Store['close']>, progress: (remaining: number) => void | Promise<void>) => Promise<void> =
  (await import(new URL('../ui/results-pages.ts', import.meta.url).href)).closeInRounds;

const lost = () => new Error('D1_ERROR: Network connection lost.');
type Query = { sql: string; values: unknown[]; method: 'run' | 'first' | 'all' };
const marker = (query: Query) => query.method === 'run' && query.sql.startsWith('UPDATE artifacts SET deleted_at=');
const markerRead = (query: Query) => query.method === 'first' && query.sql.startsWith('SELECT key,run_id,contains_text,state,deleted_at FROM artifacts');

function fixture(count = 1, pending: 'none' | 'present' | 'absent' | 'young' = 'none', alsoComplete = 0) {
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2();
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','person','2026-10-08','interactive','types','pack','[]','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','person','complete','2026-10-08','interactive',?,0.9,'initial','types','{}','{}','q')").run(count);
  const keys = Array.from({ length: count }, (_, index) => `run/${String(index).padStart(5, '0')}/input.json`);
  for (const key of keys) {
    db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,'run','fingerprint','input',?,1,?)")
      .run(key, pending === 'none' ? 'complete' : 'writing', pending === 'young' ? new Date().toISOString() : '2026-10-01T00:00:00.000Z');
    if (pending === 'none' || pending === 'present') bucket.objects.set(key, 'synthetic retained text');
  }
  for (let index = 0; index < alsoComplete; index++) {
    const key = `run/z${String(index).padStart(5, '0')}/input.json`;
    db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,'run','fingerprint','input','complete',1,'2026-10-01T00:00:00.000Z')").run(key);
    bucket.objects.set(key, 'synthetic retained text');
  }
  const hooks: { before?(query: Query): void | Promise<void>; after?(query: Query, result: unknown): unknown | Promise<unknown> } = {};
  const writes: Query[] = [], deletes: string[] = [];
  let queries = 0;
  const prepare = DB.prepare.bind(DB);
  const wrap = (sql: string, values: unknown[], statement: D1PreparedStatement): D1PreparedStatement => {
    const bind = statement.bind.bind(statement), run = statement.run.bind(statement), all = statement.all.bind(statement);
    const first = statement.first.bind(statement) as (column?: string) => Promise<unknown>;
    const invoke = async (method: Query['method'], work: () => Promise<unknown>) => {
      const query = { sql, values, method };
      if (++queries > 1000) throw new Error('Synthetic D1 invocation query limit exceeded');
      if (marker(query)) writes.push(query);
      await hooks.before?.(query);
      const result = await work(), altered = await hooks.after?.(query, result);
      return altered === undefined ? result : altered;
    };
    return Object.assign(statement, {
      bind: (...next: unknown[]) => wrap(sql, next, bind(...next)),
      run: () => invoke('run', () => run()), all: () => invoke('all', () => all()),
      first: (column?: string) => invoke('first', () => first(column))
    }) as D1PreparedStatement;
  };
  DB.prepare = sql => wrap(sql, [], prepare(sql));
  const remove = bucket.delete.bind(bucket);
  bucket.delete = async value => { deletes.push(...(Array.isArray(value) ? value : [value])); await remove(value); };
  const store = new Store({ DB, ARTIFACTS: bucket } as unknown as Env);
  return { db, DB, bucket, store, hooks, keys, writes, deletes,
    queries: () => queries, resetQueries: () => { queries = 0; },
    held: () => Number(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE deleted_at IS NULL").get()!.n),
    /** The `deleted` figure of each closure event of this kind, in order (a failed page and a finished page both carry it). */
    counts: (kind: 'page' | 'failed') => db.prepare("SELECT details_json FROM events WHERE stage='closure' AND kind=? ORDER BY rowid").all(kind)
      .map(row => (JSON.parse(String(row.details_json)) as { deleted?: unknown }).deleted),
    state: () => ({ ...db.prepare("SELECT status,text_held FROM runs WHERE id='run'").get()! }) };
}

for (const phase of ['before', 'after'] as const)
  test(`a deletion-marker ${phase}-commit network loss recovers without repeating the R2 delete`, async () => {
    const f = fixture(); let interrupted = false;
    try {
      f.hooks[phase] = query => { if (marker(query) && !interrupted) { interrupted = true; throw lost(); } };
      assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
      assert.equal(interrupted, true); assert.equal(f.deletes.length, 1);
      assert.equal(f.writes.length, phase === 'before' ? 2 : 1);
      assert.deepEqual(f.counts('page'), [1], 'a deletion this request marked is counted even when its acknowledgement was lost');
      if (f.writes.length > 1) assert.deepEqual(f.writes[0]!.values, f.writes[1]!.values, 'the same frozen timestamp and request are retried');
      assert.deepEqual(f.state(), { status: 'closed', text_held: 0 });
    } finally { f.db.close(); }
  });

test('healthy closure keeps the 400-object cap without an extra read after every successful marker', async () => {
  const f = fixture(CLOSE_PAGE);
  try {
    let readbacks = 0;
    f.hooks.before = query => { if (markerRead(query)) readbacks++; };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.deletes.length, 400); assert.equal(f.writes.length, 400); assert.equal(readbacks, 0);
    assert.ok(f.queries() < 500, String(f.queries()));
  } finally { f.db.close(); }
});

test('retry-heavy deletion pages stay below the D1 limit and report only completed deletions', async t => {
  const f = fixture(400), attempts = new Map<string, number>();
  // Keep the production retry count; remove only wall-clock sleeping in this deterministic local budget test.
  const schedule = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => { args[1] = 0; return schedule(...args); });
  try {
    f.hooks.before = query => {
      if (!marker(query)) return;
      const key = String(query.values[1]), count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count); if (count <= 2) throw lost();
    };
    const first = await f.store.close('run', 'person');
    assert.equal(first.closed, false); assert.ok(f.deletes.length > 0 && f.deletes.length < 400);
    assert.ok(f.queries() <= 1000); assert.equal('remaining' in first && first.remaining, f.held());
    const event = f.db.prepare("SELECT details_json FROM events WHERE stage='closure' AND kind='page'").get()!;
    assert.equal(JSON.parse(String(event.details_json)).deleted, f.deletes.length);
    await closeInRounds(async () => { f.resetQueries(); const result = await f.store.close('run', 'person'); assert.ok(f.queries() <= 1000); return result; }, () => {});
    assert.equal(f.held(), 0); assert.equal(f.deletes.length, 400);
  } finally { f.db.close(); }
});

for (const pending of ['present', 'absent'] as const)
  test(`75 pending ${pending} text writes close through monotonic bounded pages`, async () => {
    const f = fixture(75, pending); const remaining: number[] = [], perPageQueries: number[] = [];
    try {
      await closeInRounds(async () => {
        f.resetQueries(); const result = await f.store.close('run', 'person');
        perPageQueries.push(f.queries());
        if (!result.closed) assert.equal(result.remaining, f.held());
        return result;
      }, count => { remaining.push(count); });
      assert.ok(remaining.length >= 2, 'pending writes are reconciled in bounded pages');
      assert.ok(remaining.every((value, index) => index === 0 || value < remaining[index - 1]!));
      assert.ok(perPageQueries.every(count => count <= 1000));
      assert.equal(f.held(), 0); assert.deepEqual(f.state(), { status: 'closed', text_held: 0 });
      assert.equal(f.deletes.length, 75);
    } finally { f.db.close(); }
  });

test('the marker UPDATE cannot normalize an invalid prior ledger state on its successful path', async () => {
  const f = fixture();
  try {
    f.db.exec('PRAGMA ignore_check_constraints=ON');
    f.db.prepare("UPDATE artifacts SET state='invalid'").run();
    await assert.rejects(persistTextDeletion(f.DB, 'run', f.keys[0]!), { code: 'E_CLOSE_DELETE_RECORD' });
    assert.equal(f.writes.length, 1);
    assert.equal(f.db.prepare('SELECT state FROM artifacts').get()!.state, 'invalid');
    assert.equal(f.held(), 1);
  } finally { f.db.close(); }
});

for (const field of ['run_id', 'contains_text'] as const)
  test(`the marker successful path fences ${field} before updating`, async () => {
    const f = fixture();
    try {
      f.db.exec('PRAGMA foreign_keys=OFF');
      f.db.prepare(`UPDATE artifacts SET ${field}=?`).run(field === 'run_id' ? 'other-run' : 0);
      await assert.rejects(persistTextDeletion(f.DB, 'run', f.keys[0]!), { code: 'E_CLOSE_DELETE_RECORD' });
      assert.equal(f.writes.length, 1); assert.equal(f.held(), 1);
    } finally { f.db.close(); }
  });

test('a lost marker acknowledgement and two lost readbacks confirm one deletion without rewriting it', async () => {
  const f = fixture(); let interrupted = false, reads = 0;
  try {
    f.hooks.after = query => { if (marker(query) && !interrupted) { interrupted = true; throw lost(); } };
    f.hooks.before = query => { if (markerRead(query) && ++reads <= 2) throw lost(); };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(reads, 3); assert.equal(f.writes.length, 1); assert.equal(f.deletes.length, 1);
  } finally { f.db.close(); }
});

test('a delayed first marker commit before its retry is acknowledged with the original timestamp', async () => {
  const f = fixture(); let first: Query | undefined;
  try {
    f.hooks.before = query => {
      if (!marker(query)) return;
      if (!first) { first = query; throw lost(); }
      if (f.writes.length === 2) f.db.prepare(first.sql).run(...first.values as (string | number | null)[]);
    };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.deletes.length, 1); assert.equal(f.writes.length, 2);
    assert.deepEqual(f.writes[0]!.values, f.writes[1]!.values);
    assert.equal(f.db.prepare('SELECT deleted_at FROM artifacts').get()!.deleted_at, first!.values[0]);
    assert.deepEqual(f.counts('page'), [1], 'the delayed commit is counted once');
  } finally { f.db.close(); }
});

test('a peer deletion timestamp is preserved exactly when its completed record wins the update', async () => {
  const f = fixture(); const earlier = '2026-10-01T01:02:03.004Z';
  try {
    f.hooks.before = query => { if (marker(query)) f.db.prepare("UPDATE artifacts SET deleted_at=?,state='complete'").run(earlier); };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.db.prepare('SELECT deleted_at FROM artifacts').get()!.deleted_at, earlier);
    assert.equal(f.writes.length, 1); assert.equal(f.deletes.length, 1);
    assert.deepEqual(f.counts('page'), [1], 'the object this request removed is counted, whoever wrote its tombstone');
  } finally { f.db.close(); }
});

test('a page counts every object it confirmed removed, keeping the first tombstone a peer closer wrote', async () => {
  const f = fixture(3); const earlier = '2026-10-01T01:02:03.004Z';
  try {
    f.hooks.before = query => {
      if (marker(query) && query.values[1] === f.keys[1]) f.db.prepare("UPDATE artifacts SET deleted_at=?,state='complete' WHERE key=?").run(earlier, f.keys[1]!);
    };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.deletes.length, 3); assert.equal(f.held(), 0);
    assert.deepEqual(f.counts('page'), [3], 'two overlapping closers may both report the same object');
    assert.equal(f.db.prepare('SELECT deleted_at FROM artifacts WHERE key=?').get(f.keys[1]!)!.deleted_at, earlier);
  } finally { f.db.close(); }
});

test('a request whose every tombstone was won by a peer still reports progress rather than a stuck page', async () => {
  const f = fixture(); let inserted = false;
  try {
    f.hooks.before = query => {
      if (!marker(query) || inserted) return;
      inserted = true;
      f.db.prepare("UPDATE artifacts SET deleted_at=?,state='complete'").run('2026-10-01T01:02:03.004Z');
      f.db.prepare("INSERT INTO artifacts(key,run_id,kind,state,contains_text,created_at) VALUES('run/late/input.json','run','input','writing',1,?)").run(new Date().toISOString());
    };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: false, remaining: 1 });
    assert.deepEqual(f.counts('page'), [1]); assert.deepEqual(f.counts('failed'), []);
    assert.deepEqual(f.state(), { status: 'closing', text_held: 1 });
  } finally { f.db.close(); }
});

test('an unconfirmed deletion marker exhausts three metadata writes loudly and leaves Finish closing possible', async () => {
  const f = fixture();
  try {
    f.hooks.before = query => { if (marker(query)) throw lost(); };
    await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_DELETE_RECORD' });
    assert.equal(f.writes.length, 3); assert.equal(f.deletes.length, 1); assert.equal(f.held(), 1);
    assert.deepEqual(f.state(), { status: 'closing', text_held: 1 });
    const event = JSON.parse(String(f.db.prepare("SELECT details_json FROM events WHERE stage='closure' AND kind='failed'").get()!.details_json));
    assert.equal(event.operation, 'record_text_deletion'); assert.equal(event.code, 'E_CLOSE_DELETE_RECORD');
    assert.equal(event.deleted, 0, 'nothing was marked before the object whose record failed');
    f.hooks.before = undefined; f.resetQueries();
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.deletes.length, 2, 'only a separate explicit Close repeats the already removed object key');
  } finally { f.db.close(); }
});

test('a failed page records how many objects it had already deleted and marked', async () => {
  const f = fixture(3), original = new TypeError('Synthetic unrecognized marker failure');
  try {
    f.hooks.before = query => { if (marker(query) && query.values[1] === f.keys[2]) throw original; };
    await assert.rejects(f.store.close('run', 'person'), error => error === original);
    // The third object was removed from storage but its record failed, so only the first two were deleted and marked.
    assert.equal(f.deletes.length, 3); assert.equal(f.held(), 1);
    const event = JSON.parse(String(f.db.prepare("SELECT details_json FROM events WHERE stage='closure' AND kind='failed'").get()!.details_json));
    // No storage rule recognizes this error, so no error class is recorded.
    assert.deepEqual(event, { actor: 'person', operation: 'record_text_deletion', code: 'E_INTERNAL', key: f.keys[2], deleted: 2 });
    assert.deepEqual(f.counts('page'), [], 'a failed page writes no page event, so the failure event carries the count');
  } finally { f.db.close(); }
});

test('unreadable marker proof keeps the original write failure and never repeats the R2 action', async () => {
  const f = fixture(), original = lost(); let reads = 0;
  try {
    f.hooks.before = query => {
      if (marker(query)) throw original;
      if (markerRead(query)) { reads++; throw lost(); }
    };
    await assert.rejects(f.store.close('run', 'person'), error => {
      assert.equal((error as { code?: string }).code, 'E_CLOSE_DELETE_RECORD');
      const cause = (error as Error).cause;
      assert.ok(cause instanceof AggregateError); assert.equal(cause.errors[0], original); return true;
    });
    assert.equal(reads, 3); assert.equal(f.writes.length, 1); assert.equal(f.deletes.length, 1);
  } finally { f.db.close(); }
});

for (const mismatch of ['missing', 'key', 'run', 'text', 'state', 'timestamp'] as const)
  test(`a ${mismatch} mismatch in deletion readback never becomes success or another write`, async () => {
    const f = fixture();
    try {
      f.hooks.before = query => { if (marker(query)) throw lost(); };
      f.hooks.after = (query, result) => {
        if (!markerRead(query)) return;
        if (mismatch === 'missing') return null;
        const row = { ...(result as Record<string, unknown>) };
        if (mismatch === 'key') row.key = 'other-key';
        if (mismatch === 'run') row.run_id = 'other-run';
        if (mismatch === 'text') row.contains_text = 0;
        if (mismatch === 'state') row.state = { toString: () => 'writing' };
        if (mismatch === 'timestamp') row.deleted_at = 'not-a-timestamp';
        return row;
      };
      await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_DELETE_RECORD' });
      assert.equal(f.writes.length, 1); assert.equal(f.deletes.length, 1); assert.equal(f.held(), 1);
    } finally { f.db.close(); }
  });

test('an unrecognized marker error and a failed failure-event write preserve the original exception without leaking its text', async t => {
  const f = fixture(), original = new TypeError('Synthetic credential-bearing provider detail'); const logs: string[] = [];
  t.mock.method(console, 'info', (value: string) => { logs.push(value); });
  try {
    f.hooks.before = query => {
      if (marker(query)) throw original;
      if (query.sql.startsWith('INSERT INTO events(') && query.values.includes('failed')) throw new Error('Synthetic diagnostic failure');
    };
    await assert.rejects(f.store.close('run', 'person'), error => error === original);
    assert.equal(f.writes.length, 1); assert.equal(f.deletes.length, 1);
    assert.equal(logs.join('').includes('credential-bearing'), false);
    assert.ok(logs.some(value => value.includes('closure_failure_record')));
  } finally { f.db.close(); }
});

test('a malformed marker acknowledgement fails without treating an unverified write as success', async () => {
  const f = fixture();
  try {
    f.hooks.after = query => marker(query) ? { success: true, meta: {} } : undefined;
    await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_DELETE_RECORD' });
    assert.equal(f.writes.length, 1); assert.equal(f.deletes.length, 1);
    assert.deepEqual(f.state(), { status: 'closing', text_held: 1 });
  } finally { f.db.close(); }
});

test('600 present pending objects stay within actual query limits and make monotonic UI closure progress', async () => {
  const f = fixture(600, 'present'); const counts: number[] = [], remaining: number[] = [];
  try {
    await closeInRounds(async () => {
      f.resetQueries(); const result = await f.store.close('run', 'person'); counts.push(f.queries());
      if (!result.closed) assert.equal(result.remaining, f.held());
      return result;
    }, count => { remaining.push(count); });
    assert.ok(counts.length > 1); assert.ok(counts.every(count => count <= 1000));
    assert.ok(remaining.every((count, index) => index === 0 || count < remaining[index - 1]!));
    assert.equal(f.deletes.length, 600); assert.equal(f.held(), 0);
  } finally { f.db.close(); }
});

test('a young absent pending object still refuses closure before any deletion', async () => {
  const f = fixture(1, 'young');
  try {
    await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_WRITES_PENDING' });
    assert.equal(f.deletes.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.held(), 1);
    assert.deepEqual(f.state(), { status: 'closing', text_held: 1 });
  } finally { f.db.close(); }
});

test('an unreadable pending object HEAD cannot authorize deletion or closure', async () => {
  const f = fixture(1, 'present'), original = new Error('Synthetic unreadable HEAD');
  try {
    f.bucket.head = async () => { throw original; };
    await assert.rejects(f.store.close('run', 'person'), error => error === original);
    assert.equal(f.deletes.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.held(), 1);
  } finally { f.db.close(); }
});

test('a put acknowledged after closure reconciles and removes its pending object through the existing late-write guard', async () => {
  const f = fixture(0); const put = f.bucket.put.bind(f.bucket); let closing = false;
  try {
    f.db.prepare("UPDATE runs SET status='running'").run();
    f.bucket.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (!closing) { closing = true; await f.store.close('run', 'person'); }
      return result;
    };
    await assert.rejects(f.store.put('run', null, 'input', 'synthetic late text', true), { code: 'E_RUN_CLOSED' });
    assert.deepEqual(f.state(), { status: 'closed', text_held: 0 });
    assert.equal(f.held(), 0); assert.equal(f.bucket.objects.size, 0);
  } finally { f.db.close(); }
});

for (const phase of ['begin', 'finish'] as const)
  for (const timing of ['before', 'after'] as const)
    test(`the ${phase} closure transition recovers a ${timing}-commit network loss`, async () => {
      const f = fixture(); let writes = 0; const values: unknown[][] = [];
      const target = (query: Query) => query.method === 'run' && query.sql.startsWith(phase === 'begin' ? "UPDATE runs SET status='closing'" : "UPDATE runs SET status='closed'");
      try {
        f.hooks[timing] = query => {
          if (!target(query)) return;
          values.push([...query.values]); if (++writes === 1) throw lost();
        };
        assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
        assert.equal(writes, timing === 'before' ? 2 : 1); assert.equal(f.deletes.length, 1);
        if (writes > 1) assert.deepEqual(values[0], values[1]);
      } finally { f.db.close(); }
    });

test('a peer final acknowledgement preserves its first closed_at exactly', async () => {
  const f = fixture(); const earlier = '2026-10-01T02:03:04.005Z';
  try {
    f.hooks.before = query => {
      if (query.method === 'run' && query.sql.startsWith("UPDATE runs SET status='closed'"))
        f.db.prepare("UPDATE runs SET status='closed',closed_at=?,text_held=0").run(earlier);
    };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.db.prepare('SELECT closed_at FROM runs').get()!.closed_at, earlier);
    assert.equal(f.deletes.length, 1);
  } finally { f.db.close(); }
});

test('a new pending text registration before the final update cannot be reported closed', async () => {
  const f = fixture(); let inserted = false;
  try {
    f.hooks.before = query => {
      if (!inserted && query.method === 'run' && query.sql.startsWith("UPDATE runs SET status='closed'")) {
        inserted = true;
        f.db.prepare("INSERT INTO artifacts(key,run_id,kind,state,contains_text,created_at) VALUES('run/late/input.json','run','input','writing',1,?)").run(new Date().toISOString());
      }
    };
    assert.deepEqual(await f.store.close('run', 'person'), { closed: false, remaining: 1 });
    assert.deepEqual(f.state(), { status: 'closing', text_held: 1 });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='closure' AND kind='completed'").get()!.n, 0);
    await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_WRITES_PENDING' });
  } finally { f.db.close(); }
});

for (const operation of ['head', 'delete'] as const)
  test(`a recognized R2 ${operation} interruption repeats only the identical key within its existing bound`, async () => {
    const f = fixture(1, operation === 'head' ? 'present' : 'none'); const seen: unknown[] = [];
    try {
      if (operation === 'head') {
        const head = f.bucket.head.bind(f.bucket);
        f.bucket.head = async key => { seen.push(key); if (seen.length <= 2) throw new Error('head: temporarily unavailable (10043)'); return head(key); };
      } else {
        const remove = f.bucket.delete.bind(f.bucket);
        f.bucket.delete = async key => { seen.push(key); await remove(key); if (seen.length <= 2) throw new Error('delete: connection lost (10054)'); };
      }
      assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
      assert.equal(seen.length, 3); assert.ok(seen.every(key => key === f.keys[0]));
      assert.equal(f.writes.length, 1);
    } finally { f.db.close(); }
  });

for (const kind of ['pending', 'page', 'remaining'] as const)
  test(`a transient ${kind} closure read follows the existing read retry bound`, async () => {
    const f = fixture(); let reads = 0;
    try {
      f.hooks.before = query => {
        const matches = kind === 'pending' ? query.sql.startsWith('SELECT key,created_at FROM artifacts')
          : kind === 'page' ? query.sql.startsWith('SELECT key FROM artifacts') : query.sql.startsWith('SELECT COUNT(*) AS count,COUNT(');
        if (matches && ++reads <= 2) throw lost();
      };
      assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
      assert.equal(reads, kind === 'remaining' ? 4 : 3); assert.equal(f.deletes.length, 1);
    } finally { f.db.close(); }
  });

for (const mode of ['exhausted', 'unrecognized'] as const)
  test(`an ${mode} R2 deletion stops before marking text removed`, async () => {
    const f = fixture(); let attempts = 0;
    const original = new Error(mode === 'exhausted' ? 'delete: unavailable (10043)' : 'delete: concurrent requests (10058)');
    try {
      f.bucket.delete = async () => { attempts++; throw original; };
      await assert.rejects(f.store.close('run', 'person'), error => error === original);
      assert.equal(attempts, mode === 'exhausted' ? 3 : 1);
      assert.equal(f.writes.length, 0); assert.equal(f.held(), 1);
      assert.deepEqual(f.state(), { status: 'closing', text_held: 1 });
    } finally { f.db.close(); }
  });

for (const corrupt of ['closed_at', 'text_held', 'remaining'] as const)
  test(`a ${corrupt} mismatch cannot acknowledge a lost final closure transition`, async () => {
    const f = fixture();
    try {
      f.hooks.after = (query, result) => {
        if (query.method === 'run' && query.sql.startsWith("UPDATE runs SET status='closed'")) throw lost();
        if (query.method !== 'first' || !query.sql.startsWith('SELECT r.id,r.status,r.text_held,r.closed_at')) return;
        const value = { ...(result as Record<string, unknown>) };
        if (value.status !== 'closed') return;
        value[corrupt] = corrupt === 'closed_at' ? 'invalid' : 1;
        return value;
      };
      await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_STATE' });
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='closure' AND kind='completed'").get()!.n, 0);
      assert.equal(f.deletes.length, 1);
    } finally { f.db.close(); }
  });

test('a closed run whose records still hold a text row refuses loudly, names the rule and promises no retry', async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE runs SET status='closed',closed_at='2026-10-08T00:00:00.000Z',text_held=0").run();
    await assert.rejects(f.store.close('run', 'person'), { code: 'E_CLOSE_STATE', message: serverCopy.closedStateInconsistent });
    assert.equal(f.deletes.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.held(), 1);
    const event = JSON.parse(String(f.db.prepare("SELECT details_json FROM events WHERE stage='closure' AND kind='failed'").get()!.details_json));
    assert.deepEqual(event, { actor: 'person', operation: 'closed_state_inconsistent', code: 'E_CLOSE_STATE', deleted: 0 });
  } finally { f.db.close(); }
});

test('an unreadable final-transition readback remains loud and retains its lost-write cause', async () => {
  const f = fixture(), original = lost(); let reads = 0;
  try {
    f.hooks.after = query => { if (query.method === 'run' && query.sql.startsWith("UPDATE runs SET status='closed'")) throw original; };
    f.hooks.before = query => {
      if (query.method === 'first' && query.sql.startsWith('SELECT r.id,r.status,r.text_held,r.closed_at')) { reads++; throw lost(); }
    };
    await assert.rejects(f.store.close('run', 'person'), error => {
      assert.equal((error as { code?: string }).code, 'E_CLOSE_STATE');
      assert.ok((error as Error).cause instanceof AggregateError);
      assert.equal(((error as Error).cause as AggregateError).errors[0], original);
      return true;
    });
    assert.equal(reads, 3); assert.equal(f.deletes.length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='closure' AND kind='completed'").get()!.n, 0);
  } finally { f.db.close(); }
});

test('the worst nested retry paths leave room for transition, events, reads and final diagnostics within 1000 queries', async t => {
  const f = fixture(80); const calls = new Map<string, number>(), pageCounts: number[] = [];
  const schedule = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => { args[1] = 0; return schedule(...args); });
  // This makes each new write lose two pre-commit attempts then the successful acknowledgement, and makes each
  // reconciliation/read need all three allowed attempts. The adapter's independent 1000-query cap is authoritative.
  const identity = (query: Query) => query.method + query.sql + JSON.stringify(query.values);
  try {
    f.hooks.before = query => {
      const key = identity(query), n = (calls.get(key) ?? 0) + 1; calls.set(key, n);
      if (n % 3 !== 0) throw lost();
    };
    f.hooks.after = query => { if (query.method === 'run') throw lost(); };
    await closeInRounds(async () => {
      f.resetQueries(); await f.store.run('run'); // Include the API ownership lookup's full read bound.
      const result = await f.store.close('run', 'person'); pageCounts.push(f.queries());
      if (!result.closed) assert.equal(result.remaining, f.held());
      return result;
    }, () => {});
    assert.ok(pageCounts.length > 1); assert.ok(pageCounts.every(n => n <= 1000));
    assert.equal(f.deletes.length, 80); assert.equal(f.held(), 0);
  } finally { f.db.close(); }
});

test('the closure query budget leaves at least 40 spare queries under the D1 limit and keeps the healthy page at 400', () => {
  assert.equal(CLOSE_PAGE, 400);
  assert.ok(CLOSE_WORST_CASE_D1_QUERIES <= 1000 - 40, `worst case ${CLOSE_WORST_CASE_D1_QUERIES} leaves under 40 spare`);
  assert.equal(CLOSE_PENDING_PAGE, 35, 'floor(840 / 24): the pending page follows from the data budget');
});

for (const kind of ['present', 'absent'] as const)
  test(`a pending-heavy page of ${kind} text writes with failing D1 calls and a failing diagnostic stays within the worst-case bound`, async t => {
    // The maximum pending objects per page beside plenty of complete ones, on a run that was not finished (so closure also
    // reconciles spend). The reviewer's probe peaked at 930 queries on the previous bound.
    const f = fixture(CLOSE_PENDING_PAGE, kind, 400), calls = new Map<string, number>();
    // Production backoff, minus its wall-clock wait: a zero-delay timer still costs a full timer tick on some platforms.
    t.mock.method(globalThis, 'setTimeout', ((handler: () => void) => setImmediate(handler)) as unknown as typeof setTimeout);
    const identity = (query: Query) => query.method + query.sql + JSON.stringify(query.values);
    const countRead = (query: Query) => query.method === 'first' && query.sql.startsWith('SELECT COUNT(*) AS count,COUNT(');
    let failFinalCount = true, countsDone = 0;
    try {
      f.db.prepare("UPDATE runs SET status='running'").run();
      // Each identical call loses two attempts and succeeds on the third; every write also loses its acknowledgement, so the
      // readbacks (also two lost of three) run. Failing event writes are included. On the first pages the count read taken
      // after the deletions is lost on all three attempts, so the page fails and records its failure event the same way.
      f.hooks.before = query => {
        if (failFinalCount && countRead(query) && countsDone >= 1) throw lost();
        const key = identity(query), n = (calls.get(key) ?? 0) + 1; calls.set(key, n);
        if (n % 3 !== 0) throw lost();
      };
      f.hooks.after = query => { if (countRead(query)) countsDone++; if (query.method === 'run') throw lost(); };
      const perPage: number[] = [], failedPages: { before: number; after: number }[] = [];
      let result: Awaited<ReturnType<Store['close']>> | undefined, guard = 0;
      do {
        f.resetQueries(); countsDone = 0; failFinalCount = perPage.length < 4;
        const before = f.held(); await f.store.run('run'); // Include the API ownership lookup's full read bound.
        try { result = await f.store.close('run', 'person'); } catch { result = undefined; failedPages.push({ before, after: -1 }); }
        perPage.push(f.queries());
        if (result === undefined) failedPages[failedPages.length - 1]!.after = f.held();
      } while (result?.closed !== true && ++guard < 200);
      assert.ok(result?.closed, 'closure finishes across pages'); assert.equal(f.held(), 0);
      assert.ok(failedPages.length >= 2, 'some pages fail after deleting, so the failure event is exercised');
      assert.ok(Math.max(...perPage) <= CLOSE_WORST_CASE_D1_QUERIES, `peak ${Math.max(...perPage)} of ${CLOSE_WORST_CASE_D1_QUERIES}`);
      assert.ok(Math.max(...perPage) <= 1000 - 40, `peak ${Math.max(...perPage)} leaves under 40 spare`);
      // Each failure event records exactly what its page had deleted and marked.
      assert.deepEqual(f.counts('failed'), failedPages.map(page => page.before - page.after));
      assert.ok(failedPages.every(page => page.before > page.after), 'every failed page made progress that its event reports');
      assert.ok(f.deletes.length >= CLOSE_PENDING_PAGE + 400); assert.deepEqual(f.state(), { status: 'closed', text_held: 0 });
    } finally { f.db.close(); }
  });
