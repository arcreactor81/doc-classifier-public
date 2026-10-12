import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SQLInputValue } from 'node:sqlite';
import { Store } from './store.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';

const transient = () => new Error('D1_ERROR: Network connection lost.');
type Operation = 'register' | 'complete' | 'event' | 'other';
interface Write { sql: string; values: unknown[]; operation: Operation; attempt: number }
interface Hooks {
  before?(write: Write): Promise<void> | void;
  after?(write: Write): Promise<void> | void;
  read?(sql: string): Promise<void> | void;
}

function fixture() {
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2(), hooks: Hooks = {};
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-01','interactive','types','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner','running','2026-10-01','interactive',1,0.9,'initial_design_threshold','types','{}','{}','q')").run();
  const writes: Write[] = [], counts: Record<Operation, number> = { register: 0, complete: 0, event: 0, other: 0 };
  const prepare = DB.prepare.bind(DB);
  DB.prepare = sql => {
    const operation: Operation = sql.startsWith('INSERT INTO artifacts') ? 'register'
      : sql.startsWith("UPDATE artifacts SET state='complete'") ? 'complete'
      : sql.startsWith('INSERT INTO events') ? 'event' : 'other';
    const wrap = (statement: D1PreparedStatement, values: unknown[]): D1PreparedStatement => {
      const run = statement.run.bind(statement), first = statement.first.bind(statement), bind = statement.bind.bind(statement);
      statement.run = async <T = Record<string, unknown>>() => {
        const write = { sql, values: [...values], operation, attempt: ++counts[operation] };
        writes.push(write); await hooks.before?.(write);
        const result = await run<T>(); await hooks.after?.(write); return result;
      };
      statement.first = async <T = unknown>(column?: string) => {
        await hooks.read?.(sql);
        return column === undefined ? first<T>() : first<T>(column);
      };
      statement.bind = (...bound) => wrap(bind(...bound), bound);
      return statement;
    };
    return wrap(prepare(sql), []);
  };
  let puts = 0, streams = 0;
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, body, options) => {
    puts++;
    if (body instanceof ReadableStream) { streams++; return put(key, await new Response(body).text(), options); }
    return put(key, body, options);
  };
  const store = new Store({ DB, ARTIFACTS: bucket } as unknown as Env);
  const row = () => db.prepare('SELECT * FROM artifacts WHERE key=?').get('artifact');
  const recoveries = () => db.prepare("SELECT details_json FROM events WHERE stage='artifact' AND kind='d1_recovered' ORDER BY rowid").all()
    .map(value => JSON.parse(String(value.details_json)) as { operation: string; attempts: number; errors: string[]; resolution: string });
  const write = (kind: 'json' | 'raw', containsText = false) => kind === 'json'
    ? store.put('run', 'fingerprint', 'input', { text: 'Synthetic text.' }, containsText, 'artifact')
    : store.putRawStream('run', 'fingerprint', new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('Synthetic raw response.')); controller.close();
    } }), 'artifact');
  return { db, DB, bucket, hooks, writes, counts, store, row, recoveries, write, puts: () => puts, streams: () => streams };
}

for (const kind of ['json', 'raw'] as const) {
  test(`${kind}: an ordinary artifact has a unique invocation owner and needs no recovery event`, async () => {
    const f = fixture();
    try {
      assert.equal(await f.write(kind), 'artifact');
      assert.equal(f.row()!.state, 'complete'); assert.equal(typeof f.row()!.registration_token, 'string');
      assert.equal(f.puts(), 1); assert.equal(f.streams(), kind === 'raw' ? 1 : 0); assert.deepEqual(f.recoveries(), []);
    } finally { f.db.close(); }
  });

  for (const operation of ['register', 'complete'] as const) for (const acknowledgement of ['before', 'after'] as const) {
    test(`${kind}: ${operation} ${acknowledgement}-commit transient failure recovers without repeating R2`, async () => {
      const f = fixture();
      f.hooks[acknowledgement] = write => { if (write.operation === operation && write.attempt === 1) throw transient(); };
      try {
        assert.equal(await f.write(kind), 'artifact');
        assert.equal(f.counts[operation], acknowledgement === 'before' ? 2 : 1);
        assert.equal(f.puts(), 1); assert.equal(f.streams(), kind === 'raw' ? 1 : 0);
        assert.equal(f.row()!.state, 'complete'); assert.equal(f.row()!.deleted_at, null);
        const attempts = f.writes.filter(write => write.operation === operation);
        for (const attempt of attempts) assert.deepEqual([attempt.sql, attempt.values], [attempts[0]!.sql, attempts[0]!.values]);
        const observations = f.recoveries(); assert.equal(observations.length, 1);
        assert.equal(observations[0]!.operation, operation); assert.equal(observations[0]!.attempts, f.counts[operation]);
        assert.deepEqual(observations[0]!.errors, ['D1_NETWORK_CONNECTION_LOST']);
      } finally { f.db.close(); }
    });
  }

  for (const operation of ['register', 'complete'] as const) {
    test(`${kind}: ${operation} stops after three uncommitted transient attempts`, async () => {
      const f = fixture();
      f.hooks.before = write => { if (write.operation === operation) throw transient(); };
      try {
        await assert.rejects(f.write(kind), /Network connection lost/);
        assert.equal(f.counts[operation], 3); assert.equal(f.puts(), operation === 'register' ? 0 : 1);
        assert.equal(f.row()?.state ?? null, operation === 'register' ? null : 'writing');
        assert.deepEqual(f.recoveries(), []);
      } finally { f.db.close(); }
    });
  }

  test(`${kind}: an ordinary duplicate is rejected even when all metadata matches`, async () => {
    const f = fixture();
    try {
      await f.write(kind); const before = f.row();
      await assert.rejects(f.write(kind), /UNIQUE constraint/);
      assert.deepEqual(f.row(), before); assert.equal(f.puts(), 1); assert.equal(f.counts.register, 2);
      assert.deepEqual(f.recoveries(), []);
    } finally { f.db.close(); }
  });
}

test('an overlapping fresh invocation cannot adopt the first caller\'s ambiguously registered explicit key', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const registered = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.hooks.after = async write => {
    if (write.operation === 'register' && write.attempt === 1) { entered(); await held; throw transient(); }
  };
  try {
    const first = f.write('json'); await registered;
    const original = f.row();
    await assert.rejects(f.write('json'), /UNIQUE constraint/);
    assert.deepEqual(f.row(), original);
    release(); assert.equal(await first, 'artifact');
    const attempts = f.writes.filter(write => write.operation === 'register');
    assert.notEqual(attempts[0]!.values[6], attempts[1]!.values[6]);
    assert.equal(f.row()!.registration_token, original!.registration_token);
    assert.equal(f.puts(), 1); assert.equal(f.recoveries().length, 1);
  } finally { release(); f.db.close(); }
});

for (const mutation of ["UPDATE artifacts SET registration_token='different-invocation' WHERE key='artifact'",
  "DELETE FROM artifacts WHERE key='artifact'"]) {
  test(`completion cannot retry after losing its owned registration: ${mutation}`, async () => {
    const f = fixture();
    f.hooks.before = write => {
      if (write.operation === 'complete') { f.db.prepare(mutation).run(); throw transient(); }
    };
    try {
      await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_WRITE' });
      assert.equal(f.counts.complete, 1); assert.equal(f.puts(), 1); assert.deepEqual(f.recoveries(), []);
    } finally { f.db.close(); }
  });
}

test('completion accepts the same owned object already marked complete without rewriting or inventing a recovery', async () => {
  const f = fixture();
  f.hooks.before = write => {
    if (write.operation === 'complete') f.db.prepare("UPDATE artifacts SET state='complete' WHERE key='artifact'").run();
  };
  try {
    assert.equal(await f.write('json'), 'artifact');
    assert.equal(f.counts.complete, 1); assert.equal(f.puts(), 1); assert.deepEqual(f.recoveries(), []);
    assert.equal(f.row()!.state, 'complete'); assert.equal(f.row()!.deleted_at, null);
  } finally { f.db.close(); }
});

for (const kind of ['json', 'raw'] as const) for (const owner of ['same', 'different'])
for (const duplicateFormat of ['sqlite', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']) {
  test(`${kind}: a late registration commit followed by ${duplicateFormat} duplicate requires ${owner} invocation ownership`, async () => {
    const f = fixture();
    f.hooks.before = write => {
      if (write.operation !== 'register') return;
      if (write.attempt === 1) throw transient();
      if (write.attempt === 2) {
        const original = f.writes.find(value => value.operation === 'register')!;
        f.db.prepare(original.sql).run(...original.values as SQLInputValue[]);
        if (owner === 'different') f.db.prepare("UPDATE artifacts SET registration_token='other-invocation'").run();
        if (duplicateFormat !== 'sqlite') throw new Error(
          `D1_ERROR: UNIQUE constraint failed: artifacts.key: SQLITE_CONSTRAINT (extended: ${duplicateFormat})`);
      }
    };
    try {
      if (owner === 'same') {
        assert.equal(await f.write(kind), 'artifact'); assert.equal(f.puts(), 1);
        assert.equal(f.recoveries()[0]!.attempts, 2);
        assert.deepEqual(f.recoveries()[0]!.errors, ['D1_NETWORK_CONNECTION_LOST']);
      } else {
        await assert.rejects(f.write(kind), /UNIQUE constraint failed: artifacts.key/);
        assert.equal(f.puts(), 0); assert.deepEqual(f.recoveries(), []);
      }
      assert.equal(f.counts.register, 2);
    } finally { f.db.close(); }
  });
}

for (const kind of ['json', 'raw'] as const) {
  test(`${kind}: a recovery-observation error retains the primary R2 failure and both causes`, async () => {
    const f = fixture(), r2Error = new Error('R2 acknowledgement lost'), observationError = new Error('Observation unavailable');
    f.hooks.before = write => {
      if (write.operation === 'register' && write.attempt === 1) throw transient();
      if (write.operation === 'event' && write.values[5] === 'd1_recovered') throw observationError;
    };
    let puts = 0;
    f.bucket.put = async () => { puts++; throw r2Error; };
    try {
      await assert.rejects(f.write(kind), error => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code: string }).code, kind === 'json' ? 'E_ARTIFACT_WRITE' : 'E_INTERNAL');
        assert.match(error.message, kind === 'json' ? /artifact write outcome is uncertain/ : /R2 acknowledgement lost/);
        assert.match(error.message, /recovery observation/);
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.length, 2); assert.equal(error.cause.errors[1], observationError);
        if (kind === 'raw') assert.equal(error.cause.errors[0], r2Error);
        return true;
      });
      assert.equal(puts, 1); assert.equal(f.row()!.state, 'writing'); assert.equal(f.counts.complete, 0);
    } finally { f.db.close(); }
  });
}

for (const error of ['D1_ERROR: no such table: artifacts', 'D1_ERROR: D1 DB is overloaded. Too many requests queued.',
  'Network connection lost while parsing user text', 'D1_ERROR: Exceeded maximum DB size.']) {
  test(`unapproved D1 errors do not retry: ${error}`, async () => {
    const f = fixture();
    f.hooks.before = write => { if (write.operation === 'register') throw new Error(error); };
    try {
      await assert.rejects(f.write('json'), { message: error });
      assert.equal(f.counts.register, 1); assert.equal(f.puts(), 0); assert.deepEqual(f.recoveries(), []);
    } finally { f.db.close(); }
  });
}

for (const mutation of ["registration_token='different-invocation'", 'registration_token=NULL',
  "kind='different-kind'", "state='complete'", "deleted_at='recorded-deletion'"]) {
  test(`ambiguous registration cannot claim an unexpected ledger row: ${mutation}`, async () => {
    const f = fixture();
    f.hooks.after = write => {
      if (write.operation !== 'register') return;
      f.db.prepare(`UPDATE artifacts SET ${mutation} WHERE key='artifact'`).run(); throw transient();
    };
    try {
      await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_WRITE' });
      assert.equal(f.counts.register, 1); assert.equal(f.puts(), 0); assert.deepEqual(f.recoveries(), []);
    } finally { f.db.close(); }
  });
}

test('an unreadable reconciliation does not repeat a registration with unknown outcome', async () => {
  const f = fixture(); let reads = 0;
  f.hooks.after = write => { if (write.operation === 'register') throw transient(); };
  f.hooks.read = sql => { if (sql.includes('FROM artifacts')) { reads++; throw new Error('Reconciliation unavailable'); } };
  try {
    await assert.rejects(f.write('json'), /Reconciliation unavailable/);
    assert.equal(reads, 1); assert.equal(f.counts.register, 1); assert.equal(f.puts(), 0);
  } finally { f.db.close(); }
});

test('the third registration attempt may reconcile its own committed row but cannot send a fourth INSERT', async () => {
  const f = fixture();
  f.hooks.before = write => { if (write.operation === 'register' && write.attempt < 3) throw transient(); };
  f.hooks.after = write => { if (write.operation === 'register') throw transient(); };
  try {
    await f.write('json'); assert.equal(f.counts.register, 3); assert.equal(f.puts(), 1);
    assert.equal(f.recoveries()[0]!.attempts, 3); assert.equal(f.recoveries()[0]!.errors.length, 3);
  } finally { f.db.close(); }
});

test('a close before an uncommitted registration retry refuses its identical guarded INSERT without R2', async () => {
  const f = fixture();
  f.hooks.before = write => {
    if (write.operation === 'register' && write.attempt === 1) {
      f.db.prepare("UPDATE runs SET status='closed',text_held=0 WHERE id='run'").run(); throw transient();
    }
  };
  try {
    await assert.rejects(f.write('json', true), { code: 'E_RUN_CLOSED' });
    assert.equal(f.counts.register, 2); assert.equal(f.puts(), 0); assert.equal(f.row(), undefined);
  } finally { f.db.close(); }
});

test('a recovered owned text registration completes one late R2 write and does not strand closure', async () => {
  const f = fixture();
  f.hooks.after = async write => {
    if (write.operation !== 'register') return;
    await assert.rejects(f.store.close('run', 'synthetic-owner'), { code: 'E_CLOSE_WRITES_PENDING' });
    throw transient();
  };
  try {
    await assert.rejects(f.write('json', true), { code: 'E_RUN_CLOSED' });
    assert.equal(f.puts(), 1); assert.equal(f.bucket.objects.has('artifact'), false);
    assert.equal(f.row()!.state, 'complete'); assert.equal(typeof f.row()!.deleted_at, 'string');
    assert.deepEqual(await f.store.close('run', 'synthetic-owner'), { closed: true });
    assert.equal(f.recoveries().length, 1);
  } finally { f.db.close(); }
});

const HOUR = 60 * 60 * 1000;
/** A text registration left `writing` by a Worker that stopped before its R2 put, made `ageMs` ago. */
function pendingText(f: ReturnType<typeof fixture>, key: string, ageMs: number) {
  f.db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,contains_text,created_at,registration_token) VALUES(?,'run','fingerprint','input',1,?,'synthetic-token')")
    .run(key, new Date(Date.now() - ageMs).toISOString());
}
const closureEvents = (f: ReturnType<typeof fixture>): Record<string, unknown>[] => f.db.prepare("SELECT kind,details_json FROM events WHERE stage='closure' ORDER BY rowid").all()
  .map(row => ({ kind: String(row.kind), ...JSON.parse(String(row.details_json)) as Record<string, unknown> }));
const runState = (f: ReturnType<typeof fixture>) => ({ ...f.db.prepare("SELECT status,text_held FROM runs WHERE id='run'").get() });

test('closure releases a text write registered over an hour ago and absent from storage, and finishes', async () => {
  const f = fixture(), deleted: string[] = [];
  const remove = f.bucket.delete.bind(f.bucket);
  f.bucket.delete = async key => { deleted.push(String(key)); return remove(key); };
  try {
    pendingText(f, 'abandoned', HOUR + 60 * 1000);
    assert.equal(await f.write('json', true), 'artifact');
    assert.deepEqual(await f.store.close('run', 'synthetic-owner'), { closed: true });
    assert.deepEqual(runState(f), { status: 'closed', text_held: 0 });
    const row = f.db.prepare("SELECT state,deleted_at FROM artifacts WHERE key='abandoned'").get()!;
    assert.equal(row.state, 'complete'); assert.equal(typeof row.deleted_at, 'string');
    assert.deepEqual(deleted.sort(), ['abandoned', 'artifact']); assert.equal(f.bucket.objects.size, 0);
    const events = closureEvents(f);
    assert.deepEqual(events.map(event => event.kind), ['requested', 'write_abandoned', 'page', 'completed']);
    const abandoned = events[1]!;
    assert.equal(abandoned.key, 'abandoned'); assert.equal(abandoned.actor, 'synthetic-owner');
    assert.ok(typeof abandoned.ageMs === 'number' && abandoned.ageMs >= HOUR + 60 * 1000, String(abandoned.ageMs));
    assert.deepEqual(events[2], { kind: 'page', actor: 'synthetic-owner', deleted: 2, remaining: 0 });
  } finally { f.db.close(); }
});

test('closure still refuses a text write absent from storage and registered under an hour ago', async () => {
  const f = fixture();
  try {
    pendingText(f, 'young', HOUR - 60 * 1000);
    await assert.rejects(f.store.close('run', 'synthetic-owner'), error => {
      assert.equal((error as { code?: unknown }).code, 'E_CLOSE_WRITES_PENDING');
      assert.match((error as Error).message, /Try closing again after \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
      return true;
    });
    assert.deepEqual(runState(f), { status: 'closing', text_held: 1 });
    assert.deepEqual({ ...f.db.prepare("SELECT state,deleted_at FROM artifacts WHERE key='young'").get() }, { state: 'writing', deleted_at: null });
    assert.deepEqual(closureEvents(f), [
      { kind: 'requested', actor: 'synthetic-owner' },
      { kind: 'failed', actor: 'synthetic-owner', operation: 'pending_write_young', code: 'E_CLOSE_WRITES_PENDING',
        key: 'young', deleted: 0 }
    ]);
  } finally { f.db.close(); }
});

test('closure marks an old pending text write complete when its object exists, then deletes it as held text', async () => {
  const f = fixture();
  try {
    pendingText(f, 'landed', 2 * HOUR); f.bucket.objects.set('landed', '{"text":"Synthetic text."}');
    assert.deepEqual(await f.store.close('run', 'synthetic-owner'), { closed: true });
    assert.equal(f.bucket.objects.size, 0);
    assert.deepEqual(closureEvents(f), [
      { kind: 'requested', actor: 'synthetic-owner' }, { kind: 'write_reconciled', key: 'landed', actor: 'synthetic-owner' },
      { kind: 'page', actor: 'synthetic-owner', deleted: 1, remaining: 0 }, { kind: 'completed', actor: 'synthetic-owner' }
    ]);
  } finally { f.db.close(); }
});

test('a released text write that lands after closure finished is deleted by the late-write guard', async () => {
  const f = fixture(); let released: unknown;
  f.hooks.after = async write => {
    if (write.operation !== 'register' || released !== undefined) return;
    // The registration is backdated so this closure treats the write as never made; then the put lands anyway.
    f.db.prepare("UPDATE artifacts SET created_at=? WHERE key='artifact'").run(new Date(Date.now() - 2 * HOUR).toISOString());
    assert.deepEqual(await f.store.close('run', 'synthetic-owner'), { closed: true });
    released = f.row()!.deleted_at;
  };
  try {
    await assert.rejects(f.write('json', true), error => {
      assert.equal((error as { code?: unknown }).code, 'E_RUN_CLOSED');
      assert.equal(((error as Error).cause as { code?: unknown } | undefined)?.code, 'E_ARTIFACT_WRITE');
      return true;
    });
    assert.equal(f.puts(), 1); assert.equal(f.bucket.objects.has('artifact'), false);
    assert.equal(typeof released, 'string'); assert.equal(f.row()!.deleted_at, released); assert.equal(f.row()!.state, 'complete');
    assert.deepEqual(runState(f), { status: 'closed', text_held: 0 });
    const events = closureEvents(f), ageMs = events[1]?.ageMs;
    assert.ok(typeof ageMs === 'number' && ageMs >= 2 * HOUR, String(ageMs));
    assert.deepEqual(events, [
      { kind: 'requested', actor: 'synthetic-owner' },
      { kind: 'write_abandoned', key: 'artifact', ageMs, actor: 'synthetic-owner' },
      { kind: 'page', actor: 'synthetic-owner', deleted: 1, remaining: 0 },
      { kind: 'completed', actor: 'synthetic-owner' }
    ]);
  } finally { f.db.close(); }
});

test('completion never clears a concurrent deletion or recreates its R2 object', async () => {
  const f = fixture();
  f.hooks.after = write => {
    if (write.operation === 'complete' && write.attempt === 1) {
      f.bucket.objects.delete('artifact');
      f.db.prepare("UPDATE artifacts SET deleted_at='recorded-deletion' WHERE key='artifact'").run();
      throw transient();
    }
  };
  try {
    await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_WRITE' });
    assert.equal(f.row()!.deleted_at, 'recorded-deletion'); assert.equal(f.row()!.state, 'complete');
    assert.equal(f.puts(), 1); assert.equal(f.bucket.objects.has('artifact'), false);
  } finally { f.db.close(); }
});

test('a failed recovery observation propagates once after the artifact write, without recursively retrying events', async () => {
  const f = fixture();
  f.hooks.before = write => {
    if (write.operation === 'register' && write.attempt === 1) throw transient();
    if (write.operation === 'event') throw new Error('Recovery observation failed');
  };
  try {
    await assert.rejects(f.write('json'), /Recovery observation failed/);
    assert.equal(f.puts(), 1); assert.equal(f.row()!.state, 'complete'); assert.equal(f.counts.event, 1);
  } finally { f.db.close(); }
});

for (const kind of ['json', 'raw'] as const) {
  test(`${kind}: R2 uncertainty is never retried even after a recovered registration`, async () => {
    const f = fixture(); let puts = 0;
    f.hooks.before = write => { if (write.operation === 'register' && write.attempt === 1) throw transient(); };
    f.bucket.put = async () => { puts++; throw new Error('R2 acknowledgement lost'); };
    try {
      await assert.rejects(f.write(kind), kind === 'json' ? { code: 'E_ARTIFACT_WRITE' } : /R2 acknowledgement lost/);
      assert.equal(puts, 1); assert.equal(f.row()!.state, 'writing'); assert.equal(f.counts.complete, 0);
      assert.equal(f.recoveries().length, 1);
    } finally { f.db.close(); }
  });
}

// R2 create-only puts under the one rule (DECISIONS 135): a documented retryable error (r2-write-policy.ts) is settled by
// reading the key back; this invocation's token and SHA-256 prove its own bytes landed; nothing else is ever replaced.
const r2Transient = () => new Error('put: We encountered an internal error. Please try again. (10001)');
for (const kind of ['json', 'raw'] as const) for (const landed of [false, true]) {
  test(`${kind}: a retryable R2 error ${landed ? 'after' : 'before'} storing is settled by readback, never a second different write`, async () => {
    const f = fixture(); let puts = 0;
    const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (key, body, options) => {
      puts++;
      const value = body instanceof ReadableStream ? await new Response(body).text() : body;
      if (puts === 1) { if (landed) await put(key, value, options); throw r2Transient(); }
      return put(key, value, options);
    };
    try {
      if (kind === 'raw' && !landed) {
        // A stream is consumed by the first put: it is confirmed, never sent again.
        await assert.rejects(f.write(kind), /\(10001\)/); assert.equal(puts, 1); assert.equal(f.row()!.state, 'writing');
      } else {
        assert.equal(await f.write(kind), 'artifact'); assert.equal(f.row()!.state, 'complete');
        assert.equal(puts, landed ? 1 : 2); assert.equal(f.bucket.objects.size, 1);
      }
    } finally { f.db.close(); }
  });
}

test('json: an object at the key with another token or other bytes is refused, never adopted or replaced', async () => {
  for (const foreign of ['token', 'bytes'] as const) {
    const f = fixture(); let puts = 0;
    const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (key, body, options) => {
      puts++;
      if (puts === 1) {
        const other = foreign === 'bytes' ? '{"text":"Other bytes."}' : body;
        const otherSha = foreign === 'bytes' ? undefined : (options as R2PutOptions).sha256;
        await put(key, other, { ...(options as R2PutOptions), sha256: otherSha,
          customMetadata: { registrationToken: foreign === 'token' ? 'another-invocation' : (options as R2PutOptions).customMetadata!.registrationToken } });
        throw r2Transient();
      }
      return put(key, body, options);
    };
    try {
      const before = () => f.bucket.objects.get('artifact');
      await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_EXISTS' });
      assert.equal(puts, 1); assert.equal(f.row()!.state, 'writing'); assert.ok(before());
    } finally { f.db.close(); }
  }
});

test('json: persistent retryable R2 errors stop at the bound with the existing uncertain-write failure', async () => {
  const f = fixture(); let puts = 0;
  f.bucket.put = async () => { puts++; throw r2Transient(); };
  try {
    await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_WRITE' });
    assert.equal(puts, 3); assert.equal(f.row()!.state, 'writing'); assert.equal(f.counts.complete, 0);
  } finally { f.db.close(); }
});

test('json: an unreadable confirmation after a retryable R2 error is the uncertain-write failure, with no second put', async () => {
  const f = fixture(); let puts = 0, heads = 0;
  f.bucket.put = async () => { puts++; throw r2Transient(); };
  f.bucket.head = async () => { heads++; throw new Error('head: We encountered an internal error. Please try again. (10001)'); };
  try {
    await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_WRITE' });
    assert.equal(puts, 1); assert.equal(heads, 3);
  } finally { f.db.close(); }
});

test('register: a lost INSERT followed by a lost reconciliation read retries only that read', async () => {
  const f = fixture(); let reads = 0;
  f.hooks.before = write => { if (write.operation === 'register' && write.attempt === 1) throw transient(); };
  f.hooks.read = sql => { if (sql.includes('FROM artifacts') && ++reads === 1) throw transient(); };
  try {
    assert.equal(await f.write('json'), 'artifact'); assert.equal(f.counts.register, 2); assert.equal(reads, 2);
    assert.equal(f.puts(), 1); assert.equal(f.row()!.state, 'complete');
  } finally { f.db.close(); }
});

test('register: a lost INSERT whose reconciliation read stays lost past the bound is the typed artifact failure', async () => {
  const f = fixture(); let reads = 0;
  f.hooks.before = write => { if (write.operation === 'register') throw transient(); };
  f.hooks.read = sql => { if (sql.includes('FROM artifacts')) { reads++; throw transient(); } };
  try {
    await assert.rejects(f.write('json'), { code: 'E_ARTIFACT_WRITE' });
    assert.equal(f.counts.register, 1); assert.equal(reads, 3); assert.equal(f.puts(), 0);
  } finally { f.db.close(); }
});
