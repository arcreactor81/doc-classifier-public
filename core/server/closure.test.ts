import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { reconcileTextWrites, closeNeedsDiscard, confirmsDiscard, TEXT_WRITE_ABANDONED_AFTER_MS } from './closure.ts';
import { readOptionalJson } from './contracts.ts';
import { Store, CLOSE_PAGE } from './store.ts';
const NOW=Date.parse('2026-10-05T12:00:00.000Z'), MINUTE=60*1000;
const registered=(key:string,ageMs:number)=>({key,registeredAt:new Date(NOW-ageMs).toISOString()});
const neverAbandon=async()=>{throw new Error('A write that may still land must never be released.');};
test('two explicit closure attempts cannot complete while an R2 write is still unresolved', async () => {
 let committed=false,marked=false;
 let resolveWrite!:()=>void;
 const heldPut=new Promise<void>(resolve=>{resolveWrite=()=>{committed=true;resolve();};});
 const deps={pendingWrites:async()=>marked?[]:[registered('input_a',MINUTE)],exists:async()=>committed,wasRejected:async()=>false,markComplete:async()=>{marked=true;},now:()=>NOW,abandon:neverAbandon};
 await assert.rejects(reconcileTextWrites(deps),{code:'E_CLOSE_WRITES_PENDING'});
 await assert.rejects(reconcileTextWrites(deps),{code:'E_CLOSE_WRITES_PENDING'});
 assert.equal(marked,false);
 resolveWrite();await heldPut;
 await reconcileTextWrites(deps);assert.equal(marked,true);
});
test('an explicitly recorded completed rejection can be reconciled without inventing an object', async () => {
 let marked=false;
 await reconcileTextWrites({pendingWrites:async()=>[registered('input_a',MINUTE)],exists:async()=>false,wasRejected:async()=>true,markComplete:async()=>{marked=true;},now:()=>NOW,abandon:neverAbandon});
 assert.equal(marked,true);
});
test('a rejected transport promise without a visible object remains uncertain', async () => {
 let marked=false;
 await assert.rejects(reconcileTextWrites({pendingWrites:async()=>[registered('input_a',MINUTE)],exists:async()=>false,wasRejected:async()=>false,markComplete:async()=>{marked=true;},now:()=>NOW,abandon:neverAbandon}),{code:'E_CLOSE_WRITES_PENDING'});
 assert.equal(marked,false);
});

test('a text write absent from storage and registered at least an hour ago is released as never written', async () => {
  assert.equal(TEXT_WRITE_ABANDONED_AFTER_MS, 60 * MINUTE);
  for (const age of [TEXT_WRITE_ABANDONED_AFTER_MS, TEXT_WRITE_ABANDONED_AFTER_MS + 1, 72 * 60 * MINUTE]) {
    const abandoned: [string, number][] = []; let marked = false;
    await reconcileTextWrites({
      pendingWrites: async () => [registered('input_a', age)], exists: async () => false, wasRejected: async () => false,
      markComplete: async () => { marked = true; }, now: () => NOW, abandon: async (key, ageMs) => { abandoned.push([key, ageMs]); }
    });
    assert.deepEqual([abandoned, marked], [[['input_a', age]], false], String(age));
  }
});

test('a younger text write absent from storage still refuses closure and says when closing can be tried again', async () => {
  // The retry time is the registration time plus one hour, rounded up to the minute; a clock-skewed future time still refuses.
  for (const [age, retry] of [[0, '13:00'], [59 * MINUTE, '12:01'], [TEXT_WRITE_ABANDONED_AFTER_MS - 1, '12:01'], [-5 * MINUTE, '13:05']] as const) {
    let marked = false;
    await assert.rejects(reconcileTextWrites({
      pendingWrites: async () => [registered('input_a', age)], exists: async () => false, wasRejected: async () => false,
      markComplete: async () => { marked = true; }, now: () => NOW, abandon: neverAbandon
    }), error => {
      assert.equal((error as { code?: unknown }).code, 'E_CLOSE_WRITES_PENDING');
      assert.match((error as Error).message, new RegExp(`Try closing again after 2026-10-05 ${retry} UTC\\.$`), String(age));
      return true;
    });
    assert.equal(marked, false);
  }
});

test('an object in storage is marked complete however old its registration, and never released', async () => {
  const marked: string[] = [];
  await reconcileTextWrites({
    pendingWrites: async () => [registered('input_a', 72 * 60 * MINUTE)], exists: async () => true, wasRejected: async () => false,
    markComplete: async key => { marked.push(key); }, now: () => NOW, abandon: neverAbandon
  });
  assert.deepEqual(marked, ['input_a']);
});

test('a write whose registration time cannot be read is never released', async () => {
  let marked = false;
  await assert.rejects(reconcileTextWrites({
    pendingWrites: async () => [{ key: 'input_a', registeredAt: 'not a time' }], exists: async () => false,
    wasRejected: async () => false, markComplete: async () => { marked = true; }, now: () => NOW, abandon: neverAbandon
  }), { code: 'E_CLOSE_WRITES_PENDING' });
  assert.equal(marked, false);
});

test('S3: only an unfinished run needs an explicit discard to close (all six statuses)', () => {
  const table: Record<string, boolean> = {
    uploading: true,
    running: true,
    halted: true,
    complete: false,
    closing: false,
    closed: false
  };
  for (const [status, needed] of Object.entries(table)) assert.equal(closeNeedsDiscard(status), needed, status);
  // A status this release does not know is treated as unfinished: closing it must be deliberate.
  assert.equal(closeNeedsDiscard('paused'), true);
});

test('S3: only exactly {discardUnfinished: true} confirms a discard', () => {
  assert.equal(confirmsDiscard({ discardUnfinished: true }), true);
  for (const body of [
    undefined, null, {}, [], 'discardUnfinished', true, { discardUnfinished: 'true' }, { discardUnfinished: 1 },
    { discardUnfinished: false }, { discardUnfinished: true, extra: 1 }, [{ discardUnfinished: true }]
  ]) assert.equal(confirmsDiscard(body), false, JSON.stringify(body));
});

test('S3: an optional JSON body is undefined when absent or empty and null when unreadable', async () => {
  const post = (body?: BodyInit, type: string | null = 'application/json') => new Request('https://unit.invalid/close', {
    method: 'POST',
    ...(type ? { headers: { 'content-type': type } } : {}),
    ...(body === undefined ? {} : { body })
  });
  assert.equal(await readOptionalJson(post()), undefined);
  assert.equal(await readOptionalJson(post('')), undefined);
  assert.equal(await readOptionalJson(post(undefined, null)), undefined);
  assert.deepEqual(await readOptionalJson(post('{}')), {});
  assert.deepEqual(await readOptionalJson(post('{"discardUnfinished":true}', 'application/json; charset=utf-8')),
    { discardUnfinished: true });
  assert.equal(await readOptionalJson(post('{"discardUnfinished":')), null);
  assert.equal(await readOptionalJson(post(new Uint8Array([0x7b, 0xff, 0x7d]))), null);
  assert.equal(await readOptionalJson(post('{"discardUnfinished":true}', 'text/plain')), null);
  assert.equal(await readOptionalJson(post('{"discardUnfinished":true}', null)), null);
});

// Real SQL over the closure tables (the closeFixture pattern of execution-budget.test.ts) with `textObjects` held texts.
function pagedFixture(textObjects: number) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,mode TEXT,closed_at TEXT,text_held INTEGER,pack_json TEXT);
  CREATE TABLE events(id TEXT,run_id TEXT,fingerprint TEXT,created_at TEXT,stage TEXT,kind TEXT,elapsed_ms INTEGER,details_json TEXT);
  CREATE TABLE artifacts(key TEXT PRIMARY KEY,run_id TEXT,contains_text INTEGER,state TEXT,deleted_at TEXT,created_at TEXT);`);
  db.prepare('INSERT INTO runs VALUES(?,?,?,NULL,1,?)').run('run', 'complete', 'interactive', '{}');
  const insert = db.prepare("INSERT INTO artifacts VALUES(?,?,1,?,NULL,'2026-10-01T00:00:00.000Z')");
  for (let i = 0; i < textObjects; i++) insert.run(`run/doc-${String(i).padStart(5, '0')}/input/a.json`, 'run', 'complete');
  insert.run('other/doc/input/a.json', 'other', 'complete');
  let deletes = 0;
  const env = {
    DB: { prepare: (text: string) => { let values: SQLInputValue[] = []; return {
      bind(...input: SQLInputValue[]) { values = input; return this; },
      first: async () => db.prepare(text).get(...values) ?? null,
      all: async () => ({ success: true, results: db.prepare(text).all(...values) }),
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(text).run(...values).changes) } })
    }; } },
    ARTIFACTS: { head: async () => ({}), delete: async () => { deletes++; } }
  } as unknown as Env;
  return {
    db, store: new Store(env), deletes: () => deletes,
    run: () => ({ ...db.prepare('SELECT status,text_held FROM runs WHERE id=?').get('run') }) as { status: string; text_held: number },
    held: () => Number((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id='run' AND deleted_at IS NULL").get() as { n: number }).n),
    events: () => db.prepare("SELECT kind,details_json FROM events WHERE run_id='run' AND stage='closure' ORDER BY rowid").all()
      .map(row => ({ kind: String(row.kind), ...JSON.parse(String(row.details_json)) as Record<string, unknown> }))
  };
}

test('closing deletes held text in pages of 400 and reports what remains until the last page closes the run', async () => {
  assert.equal(CLOSE_PAGE, 400);
  const f = pagedFixture(1000);
  try {
    assert.deepEqual(await f.store.close('run', 'person'), { closed: false, remaining: 600 });
    assert.deepEqual([f.run(), f.held(), f.deletes()], [{ status: 'closing', text_held: 1 }, 600, 400]);
    assert.equal(closeNeedsDiscard(f.run().status), false); // the next click needs no discard body
    assert.deepEqual(await f.store.close('run', 'person'), { closed: false, remaining: 200 });
    assert.deepEqual([f.run(), f.held(), f.deletes()], [{ status: 'closing', text_held: 1 }, 200, 800]);
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.deepEqual([f.run(), f.held(), f.deletes()], [{ status: 'closed', text_held: 0 }, 0, 1000]);
    // Another run's text is untouched; a call on the closed run changes nothing more.
    assert.equal(Number((f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id='other' AND deleted_at IS NULL").get() as { n: number }).n), 1);
    assert.deepEqual(await f.store.close('run', 'person'), { closed: true });
    assert.equal(f.deletes(), 1000);
    assert.deepEqual(f.events(), [
      { kind: 'requested', actor: 'person' }, { kind: 'page', actor: 'person', deleted: 400, remaining: 600 },
      { kind: 'requested', actor: 'person' }, { kind: 'page', actor: 'person', deleted: 400, remaining: 200 },
      { kind: 'requested', actor: 'person' }, { kind: 'page', actor: 'person', deleted: 200, remaining: 0 },
      { kind: 'completed', actor: 'person' }
    ]);
  } finally { f.db.close(); }
});

test('a run with at most one page of held text closes in one call, as before', async () => {
  for (const held of [0, 1, 400]) {
    const f = pagedFixture(held);
    try {
      assert.deepEqual(await f.store.close('run', 'person'), { closed: true }, String(held));
      assert.deepEqual([f.run(), f.held(), f.deletes()], [{ status: 'closed', text_held: 0 }, 0, held], String(held));
      assert.deepEqual(f.events().map(e => e.kind), held === 0 ? ['requested', 'completed'] : ['requested', 'page', 'completed'], String(held));
    } finally { f.db.close(); }
  }
});
