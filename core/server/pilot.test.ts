import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { decide } from '../domain/decision.ts';
import { typeVersion, type ProjectPack } from '../config/project.ts';

// Real SQL over the real migrations (migration 0019's tables and triggers included). pilot.ts reaches health.ts
// through api.ts, whose `project-pack` import is a build-time alias; here it is served in-process as a one-category
// synthetic pack, so the "active" category version in git mode is that pack's type file. Registered before the import.
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const PACK = fixtures.syntheticPack(1) as { id: string; typeFile: { types: { id: string }[] } };
const PACK_URL = 'project-pack:synthetic-pilot';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: PACK_URL, format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === PACK_URL ? { format: 'json', source: JSON.stringify(PACK), shortCircuit: true } : next(url, context);
  }
});
const { pilotView, pilotReview, pilotConfirm, pilotCopy, trialChecksForFullRun } = await import('./pilot.ts');
const { requirePilotRule } = await import('./intake.ts');

const OWNER = 'owner';
const FP = (n: number) => String(n).padStart(64, '0');
const TYPE_IDS = PACK.typeFile.types.map(type => type.id);
const ACTIVE_VERSION = await typeVersion(JSON.stringify(PACK.typeFile));
/** Person-facing sentences carry no codes and neither of these words (the browser hides such headlines). */
const BANNED = /threshold|fingerprint|E_[A-Z_]+/;

interface Seed {
  id: string;
  status?: string;
  campaign?: { id: string; role: 'pilot' | 'full' } | null;
  /** The frozen category version; defaults to the active one. */
  typeVersion?: string;
  expectedCount?: number;
  revisionId?: string;
  /** The person started this run without a pilot (migration 0020); such a run has no campaign. */
  pilotSkipped?: boolean;
  /** Documents by ordinal: R1 filed, R2 review, R0 failure. */
  documents?: ('R1' | 'R2' | 'R0')[]
}

function fixture() {
  const db = migratedDatabase({ foreignKeys: false });
  const env = { DB: localD1(db), ARTIFACTS: memoryR2(), PROJECT_ID: PACK.id, BUILD_COMMIT: 'pilot-local-test' } as unknown as Env;
  const store = new Store(env);
  const seed = (run: Seed) => {
    const campaign = run.campaign === undefined ? { id: 'campaign-1', role: 'pilot' as const } : run.campaign;
    db.prepare(
      "INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,campaign_id,campaign_role,pilot_skipped) VALUES(?,?,?,'2026-09-29T00:00:00.000Z','interactive',?,0.9,'initial',?,?,'{}',?,?,?,?)"
    ).run(run.id, OWNER, run.status ?? 'complete', run.expectedCount ?? (run.documents ?? []).length, run.typeVersion ?? ACTIVE_VERSION,
      JSON.stringify({ ...PACK, ...(run.revisionId ? { definitionRevisionId: run.revisionId } : {}) }), `quote-${run.id}`, campaign?.id ?? null, campaign?.role ?? null,
      run.pilotSkipped ? 1 : 0);
    (run.documents ?? []).forEach((rule, index) => {
      const decision = rule === 'R0'
        ? decide({ typeIds: TYPE_IDS, threshold: 0.9, failures: ['E_READER_SCHEMA'], notes: [] })
        : decide({ typeIds: TYPE_IDS, threshold: 0.9, failures: [], notes: [],
          confidence: { choice: TYPE_IDS[0], certainty: rule === 'R1' ? 0.95 : 0.6, noul: { [TYPE_IDS[0]]: 0.9 } }, readerYes: [TYPE_IDS[0]] });
      assert.equal(decision.ruleId, rule);
      db.prepare(
        "INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json,decision_json,ordinal) VALUES(?,?,?,?,'complete','h','[]',?,?)"
      ).run(run.id, FP(index + 1), `r${run.id}-${String(index + 1).padStart(4, '0')}`, `document-${index + 1}.pdf`, JSON.stringify(decision), index + 1);
    });
  };
  const post = (runId: string, action: string, body: unknown) => new Request(`https://unit.invalid/api/runs/${runId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const run = (id: string) => store.run(id);
  const view = async (id: string) => pilotView(env, store, await run(id));
  const review = async (id: string, n: number, verdict: string, actor = OWNER) =>
    pilotReview(post(id, 'pilot-review', { fingerprint: FP(n), verdict }), env, store, await run(id), actor);
  const confirm = async (id: string, body: unknown = {}, actor = OWNER) =>
    pilotConfirm(post(id, 'pilot-confirmation', body), env, store, await run(id), actor);
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, e => e);
    assert.ok(error, 'expected a refusal');
    assert.equal(BANNED.test(error.message), false, error.message);
    return [error.code, error.status, error.message] as [string, number, string];
  };
  const count = (sql: string, ...values: (string | number)[]) => Number((db.prepare(sql).get(...values) as { n: number }).n);
  return { db, env, store, seed, run, view, review, confirm, failure, count };
}

const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });

test('the view: the filed documents in order with no verdicts yet, the counts, the pilot size and the category version', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'pilot', documents: ['R1', 'R2', 'R1', 'R0', 'R1'] });
    const view = await f.view('pilot');
    assert.deepEqual(Object.keys(view), ['campaignId', 'role', 'pilotSize', 'filed', 'counts', 'confirmation', 'categoryVersion']);
    assert.deepEqual([view.campaignId, view.role, view.pilotSize], ['campaign-1', 'pilot', 25]);
    assert.deepEqual(view.filed, [1, 3, 5].map(n => ({
      fingerprint: FP(n), ordinal: n, tag: `rpilot-000${n}`, originalFilename: `document-${n}.pdf`, destinationFolder: TYPE_IDS[0], verdict: null
    })));
    assert.deepEqual(view.counts, { filed: 3, reviewed: 0, right: 0, wrong: 0 });
    assert.equal(view.confirmation, null);
    assert.deepEqual(view.categoryVersion, { frozen: ACTIVE_VERSION, active: ACTIVE_VERSION, matches: true });
  } finally { f.db.close(); }
});

test('a pilot whose run recorded older settings stays viewable; confirming it is still refused', async () => {
  const f = fixture();
  try {
    // One document sent to review, so nothing waits for a verdict and the confirmation reaches its settings check.
    f.seed({ id: 'older', documents: ['R2'] });
    const recorded = (PACK as unknown as { settings: Record<string, unknown> }).settings;
    const { readerContract: _contract, pilotSize: _size, ...older } = recorded;
    const store = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify({ ...PACK, ...extra, settings }), 'older');
    store(older);
    const view = await f.view('older');
    assert.equal(view.pilotSize, 25, 'the standing trial size is shown when the run recorded none');
    assert.deepEqual(view.filed, []);
    assert.deepEqual(view.categoryVersion, { frozen: ACTIVE_VERSION, active: ACTIVE_VERSION, matches: true });
    await assert.rejects(() => f.confirm('older'), { code: 'E_PROJECT_CONFIG' });
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    // A recorded trial size and category version are shown as recorded.
    store({ ...older, pilotSize: 7 }, { definitionRevisionId: 'rev-older' });
    const recordedView = await f.view('older');
    assert.equal(recordedView.pilotSize, 7);
    assert.equal(recordedView.categoryVersion.frozen, 'rev-older');
    // A recorded value that cannot be read still fails loudly.
    for (const [settings, extra] of [[{ ...older, pilotSize: 0 }, {}], [{ ...older, pilotSize: '25' }, {}], [older, { definitionRevisionId: 5 }]] as const) {
      store(settings, extra);
      await assert.rejects(() => f.view('older'), { code: 'E_RUN_STATUS_UNREADABLE' });
    }
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify({ ...PACK, settings: null }), 'older');
    await assert.rejects(() => f.view('older'), { code: 'E_RUN_STATUS_UNREADABLE' });
  } finally { f.db.close(); }
});

test('refusals: not a pilot, not finished, not filed, malformed bodies; nothing is written by a refusal', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'full', campaign: { id: 'campaign-1', role: 'full' }, documents: ['R1'] });
    f.seed({ id: 'old', campaign: null, documents: ['R1'] });
    f.seed({ id: 'running', status: 'running', documents: ['R1'] });
    f.seed({ id: 'closed', status: 'closed', documents: ['R1', 'R2', 'R0'] });
    for (const id of ['full', 'old']) {
      assert.deepEqual(await f.failure(f.view(id)), ['E_PILOT_REVIEW', 409, pilotCopy.notPilot], id);
      assert.deepEqual(await f.failure(f.review(id, 1, 'right')), ['E_PILOT_REVIEW', 409, pilotCopy.notPilot], id);
      assert.deepEqual(await f.failure(f.confirm(id)), ['E_PILOT_REVIEW', 409, pilotCopy.notPilot], id);
    }
    assert.deepEqual(await f.failure(f.view('running')), ['E_PILOT_REVIEW', 409, pilotCopy.notFinished]);
    assert.deepEqual(await f.failure(f.review('running', 1, 'right')), ['E_PILOT_REVIEW', 409, pilotCopy.notFinished]);
    assert.deepEqual(await f.failure(f.confirm('running')), ['E_PILOT_REVIEW', 409, pilotCopy.notFinished]);
    // A closed pilot (text deleted) is reviewed like a complete one; only filed documents take a verdict.
    assert.equal((await f.view('closed')).counts.filed, 1);
    for (const n of [2, 3, 9])
      assert.deepEqual(await f.failure(f.review('closed', n, 'right')), ['E_PILOT_REVIEW', 409, pilotCopy.notFiled], String(n));
    for (const body of [{}, { fingerprint: FP(1) }, { fingerprint: FP(1), verdict: 'maybe' }, { fingerprint: 'abc', verdict: 'right' }, { fingerprint: FP(1), verdict: 'right', extra: 1 }]) {
      const request = new Request('https://unit.invalid/api/runs/closed/pilot-review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const [code] = await f.failure(pilotReview(request, f.env, f.store, await f.run('closed'), OWNER));
      assert.equal(code, 'E_REQUEST', JSON.stringify(body));
    }
    assert.equal((await f.failure(f.confirm('closed', { sure: true })))[0], 'E_REQUEST');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 0);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM events'), 0);
  } finally { f.db.close(); }
});

test('verdicts append; the latest wins; the confirmation needs every filed document right, then is idempotent and closes the review', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'pilot', documents: ['R1', 'R1', 'R2', 'R1', 'R0'] });
    // right -> wrong -> right on the first document keeps three rows; the view shows the latest.
    for (const verdict of ['right', 'wrong', 'right']) {
      const recorded = await json(await f.review('pilot', 1, verdict));
      assert.equal(recorded.status, 201);
      assert.deepEqual([recorded.body.fingerprint, recorded.body.tag, recorded.body.verdict], [FP(1), 'rpilot-0001', verdict]);
    }
    assert.deepEqual(f.db.prepare('SELECT verdict FROM pilot_reviews WHERE run_id=? AND fingerprint=? ORDER BY created_at, rowid').all('pilot', FP(1)).map(row => ({ ...row })),
      [{ verdict: 'right' }, { verdict: 'wrong' }, { verdict: 'right' }]);
    assert.deepEqual((await f.view('pilot')).filed.map(doc => doc.verdict), ['right', null, null]);
    assert.deepEqual((await f.view('pilot')).counts, { filed: 3, reviewed: 1, right: 1, wrong: 0 });
    // A wrong verdict outstanding refuses the confirmation and names the document; that comes before "unreviewed".
    assert.equal((await json(await f.review('pilot', 2, 'wrong'))).status, 201);
    assert.deepEqual(await f.failure(f.confirm('pilot')), ['E_PILOT_MISFILED', 409, `${pilotCopy.misfiled} Marked wrong: rpilot-0002.`]);
    assert.equal((await json(await f.review('pilot', 2, 'right'))).status, 201);
    // One filed document without a verdict refuses it.
    assert.deepEqual(await f.failure(f.confirm('pilot')), ['E_PILOT_INCOMPLETE', 409, pilotCopy.incomplete]);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    assert.equal((await json(await f.review('pilot', 4, 'right'))).status, 201);
    // The person's confirmation: one immutable row, returned again unchanged on a repeat.
    const confirmed = await json(await f.confirm('pilot'));
    assert.equal(confirmed.status, 201);
    assert.deepEqual(Object.keys(confirmed.body), ['id', 'createdAt', 'confirmedBy', 'filedCount']);
    assert.deepEqual([confirmed.body.confirmedBy, confirmed.body.filedCount], [OWNER, 3]);
    const again = await json(await f.confirm('pilot'));
    assert.deepEqual([again.status, again.body], [200, confirmed.body]);
    assert.deepEqual({ ...f.db.prepare('SELECT campaign_id,pilot_run_id,definition_revision_id,filed_count,actor FROM pilot_confirmations').get() },
      { campaign_id: 'campaign-1', pilot_run_id: 'pilot', definition_revision_id: ACTIVE_VERSION, filed_count: 3, actor: OWNER });
    assert.deepEqual((await f.view('pilot')).confirmation, confirmed.body);
    // After the confirmation no verdict changes; what was confirmed stays as confirmed.
    assert.deepEqual(await f.failure(f.review('pilot', 1, 'wrong')), ['E_PILOT_CONFIRMED', 409, pilotCopy.confirmed]);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 6);
    // Record, never edit: the migration's triggers refuse updates and deletes on both tables.
    assert.throws(() => f.db.prepare("UPDATE pilot_reviews SET verdict='wrong'").run(), /immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM pilot_reviews').run(), /immutable/);
    assert.throws(() => f.db.prepare('UPDATE pilot_confirmations SET filed_count=0').run(), /immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM pilot_confirmations').run(), /immutable/);
    // The confirmation is what unlocks a full run above the pilot size, for this person, on this category version.
    const pack = PACK as unknown as Parameters<typeof requirePilotRule>[2];
    await requirePilotRule(f.env, OWNER, pack, ACTIVE_VERSION, 30, { id: 'campaign-1', role: 'full' }, false);
    await requirePilotRule(f.env, 'someone-else', pack, ACTIVE_VERSION, 25, null, false);
    await assert.rejects(requirePilotRule(f.env, 'someone-else', pack, ACTIVE_VERSION, 30, { id: 'campaign-1', role: 'full' }, false), { code: 'E_PILOT_REQUIRED' });
    // Confirmed only on an older category version: stale, with the same sentence the confirmation route uses.
    await assert.rejects(requirePilotRule(f.env, OWNER, pack, 'a-later-version', 30, { id: 'campaign-1', role: 'full' }, false), { code: 'E_PILOT_STALE', status: 409, message: pilotCopy.stale });
    await assert.rejects(requirePilotRule(f.env, OWNER, pack, ACTIVE_VERSION, 30, { id: 'campaign-2', role: 'full' }, false), { code: 'E_PILOT_REQUIRED' });
    // A pilot itself is never larger than the pilot size (owner decision, 5 October 2026), whatever else it carries.
    const tooLarge = 'A pilot can include up to 25 documents. Choose 25 or fewer for the pilot.';
    assert.equal(BANNED.test(tooLarge), false);
    await requirePilotRule(f.env, OWNER, pack, ACTIVE_VERSION, 25, { id: 'campaign-3', role: 'pilot' }, false);
    for (const skipPilot of [false, true])
      await assert.rejects(requirePilotRule(f.env, OWNER, pack, ACTIVE_VERSION, 26, { id: 'campaign-3', role: 'pilot' }, skipPilot), { code: 'E_PILOT_SIZE', status: 409, message: tooLarge });
    assert.deepEqual(f.db.prepare("SELECT stage,kind FROM events WHERE run_id='pilot' ORDER BY rowid").all().map(row => ({ ...row })),
      [...Array.from({ length: 6 }, () => ({ stage: 'pilot', kind: 'reviewed' })), { stage: 'pilot', kind: 'confirmed' }]);
  } finally { f.db.close(); }
});

test('a pilot on an older category version cannot be confirmed; the refusal order is wrong, unreviewed, then stale', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'stale', typeVersion: 'older-categories', documents: ['R1', 'R1'] });
    assert.deepEqual((await f.view('stale')).categoryVersion, { frozen: 'older-categories', active: ACTIVE_VERSION, matches: false });
    await f.review('stale', 1, 'wrong');
    assert.equal((await f.failure(f.confirm('stale')))[0], 'E_PILOT_MISFILED');
    await f.review('stale', 1, 'right');
    assert.equal((await f.failure(f.confirm('stale')))[0], 'E_PILOT_INCOMPLETE');
    await f.review('stale', 2, 'right');
    assert.deepEqual(await f.failure(f.confirm('stale')), ['E_PILOT_STALE', 409, pilotCopy.stale]);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    // A pilot that filed nothing has nothing to review; confirming it is the person's decision, recorded as such.
    f.seed({ id: 'empty', documents: ['R2', 'R0'] });
    const confirmed = await json(await f.confirm('empty'));
    assert.deepEqual([confirmed.status, confirmed.body.filedCount], [201, 0]);
  } finally { f.db.close(); }
});

// DECISIONS 88: a run the person started without a pilot has no pilot review, whatever its state.
test('a run started without a pilot: every pilot route says there is nothing to confirm, and nothing is written', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'skipped', campaign: null, pilotSkipped: true, documents: ['R1', 'R2'] });
    f.seed({ id: 'skipped-running', campaign: null, pilotSkipped: true, status: 'running', expectedCount: 2, documents: ['R1'] });
    for (const id of ['skipped', 'skipped-running'])
      for (const action of [() => f.view(id), () => f.review(id, 1, 'right'), () => f.confirm(id)])
        assert.deepEqual(await f.failure(action()), ['E_PILOT_REVIEW', 409, pilotCopy.skipped], id);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 0);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM events'), 0);
    // The rule itself: the person's explicit choice passes any size with no campaign and no confirmation anywhere.
    const pack = PACK as unknown as Parameters<typeof requirePilotRule>[2];
    await requirePilotRule(f.env, OWNER, pack, ACTIVE_VERSION, 10_000, null, true);
    await assert.rejects(requirePilotRule(f.env, OWNER, pack, ACTIVE_VERSION, 10_000, null, false), { code: 'E_PILOT_REQUIRED' });
  } finally { f.db.close(); }
});

/** Pause one handler immediately before its real SQL write; the competitor uses the same database. */
function pauseNextInsert(env: Env, table: 'pilot_reviews' | 'pilot_confirmations') {
  let markReached!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { markReached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === 'run' && sql.includes(`INSERT INTO ${table}(`)) return async () => {
          env.DB.prepare = prepare;
          markReached();
          await resume;
          return target.run();
        };
        return Reflect.get(target, key);
      }
    });
    return wrap(prepare(sql));
  };
  return { reached, release };
}

test('closed or complete pilots require every expected document to have an outcome before review or confirmation', async () => {
  const f = fixture();
  try {
    for (const status of ['closed', 'complete']) {
      for (const condition of ['none', 'missing', 'undecided', 'unfinished']) {
        const id = `${status}-${condition}`;
        f.seed({ id, status, expectedCount: 2, documents: condition === 'none' ? [] : condition === 'missing' ? ['R1'] : ['R1', 'R2'] });
        if (condition === 'undecided') f.db.prepare('UPDATE documents SET decision_json=NULL WHERE run_id=? AND fingerprint=?').run(id, FP(2));
        if (condition === 'unfinished') f.db.prepare("UPDATE documents SET status='uploaded' WHERE run_id=? AND fingerprint=?").run(id, FP(2));
        for (const action of [() => f.view(id), () => f.review(id, 1, 'right'), () => f.confirm(id)])
          assert.deepEqual(await f.failure(action()), ['E_PILOT_REVIEW', 409, pilotCopy.notFinished], id);
      }
    }
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 0);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    await assert.rejects(requirePilotRule(f.env, OWNER, PACK as unknown as Parameters<typeof requirePilotRule>[2], ACTIVE_VERSION, 30,
      { id: 'campaign-1', role: 'full' }, false), { code: 'E_PILOT_REQUIRED' });
    for (const status of ['complete', 'closed']) {
      const id = `zero-filed-${status}`;
      f.seed({ id, status, documents: ['R2', 'R0'] });
      assert.equal((await f.view(id)).confirmation, null);
      const confirmed = await json(await f.confirm(id));
      assert.deepEqual([confirmed.status, confirmed.body.filedCount], [201, 0]);
    }
  } finally { f.db.close(); }
});

test('a confirmation committed while a review is pending prevents that late verdict and its event', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'pilot', documents: ['R1'] });
    await f.review('pilot', 1, 'right');
    const gate = pauseNextInsert(f.env, 'pilot_reviews');
    const review = f.failure(f.review('pilot', 1, 'wrong'));
    await gate.reached;
    try { assert.equal((await f.confirm('pilot')).status, 201); }
    finally { gate.release(); }
    assert.deepEqual(await review, ['E_PILOT_CONFIRMED', 409, pilotCopy.confirmed]);
    assert.equal((await f.view('pilot')).filed[0].verdict, 'right');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 1);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM events WHERE stage='pilot' AND kind='reviewed'"), 1);
  } finally { f.db.close(); }
});

test('a wrong verdict committed while confirmation is pending prevents that confirmation and full-run unlock', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'pilot', documents: ['R1'] });
    await f.review('pilot', 1, 'right');
    const gate = pauseNextInsert(f.env, 'pilot_confirmations');
    const confirmation = f.failure(f.confirm('pilot'));
    await gate.reached;
    try { assert.equal((await f.review('pilot', 1, 'wrong')).status, 201); }
    finally { gate.release(); }
    assert.equal((await confirmation)[0], 'E_PILOT_MISFILED');
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 2);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM events WHERE stage='pilot' AND kind='confirmed'"), 0);
    await assert.rejects(requirePilotRule(f.env, OWNER, PACK as unknown as Parameters<typeof requirePilotRule>[2], ACTIVE_VERSION, 30,
      { id: 'campaign-1', role: 'full' }, false), { code: 'E_PILOT_REQUIRED' });
  } finally { f.db.close(); }
});

test('concurrent confirmations return the same immutable confirmation and record one event', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'pilot', documents: ['R1'] });
    await f.review('pilot', 1, 'right');
    const gate = pauseNextInsert(f.env, 'pilot_confirmations');
    const pending = f.confirm('pilot');
    await gate.reached;
    let winner: Awaited<ReturnType<typeof json>>;
    try { winner = await json(await f.confirm('pilot')); }
    finally { gate.release(); }
    assert.equal(winner.status, 201);
    assert.deepEqual(await json(await pending), { status: 200, body: winner.body });
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 1);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM events WHERE stage='pilot' AND kind='confirmed'"), 1);
  } finally { f.db.close(); }
});

test('an activation committed while confirmation is pending refuses the stale pilot', async () => {
  const f = fixture();
  try {
    const { createDefinitionDraft, activateDefinition } = await import('./definitions.ts');
    f.env.DEFINITION_MODE = 'runtime';
    f.env.DEFINITION_EDITORS = JSON.stringify([OWNER]);
    const pack = PACK as unknown as Parameters<typeof createDefinitionDraft>[1];
    const first = await createDefinitionDraft(f.env, pack, OWNER, { baseRevisionId: null, typeFile: PACK.typeFile, displayNames: {} });
    await activateDefinition(f.env, pack, OWNER, first.id, { inheritThreshold: false });
    f.seed({ id: 'pilot', revisionId: first.id, documents: ['R1'] });
    await f.review('pilot', 1, 'right');
    const second = await createDefinitionDraft(f.env, pack, OWNER, { baseRevisionId: first.id, typeFile: PACK.typeFile, displayNames: { [TYPE_IDS[0]]: 'Updated display name' } });
    const gate = pauseNextInsert(f.env, 'pilot_confirmations');
    const pending = f.failure(f.confirm('pilot'));
    await gate.reached;
    try { await activateDefinition(f.env, pack, OWNER, second.id, { inheritThreshold: false }); }
    finally { gate.release(); }
    assert.deepEqual(await pending, ['E_PILOT_STALE', 409, pilotCopy.stale]);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 0);
  } finally { f.db.close(); }
});

test('a reader menu full run can unlock and carry trial checks only from the same explicitly recorded reader', async () => {
  const f = fixture();
  try {
    f.seed({ id: 'pilot', documents: ['R1'] });
    await f.review('pilot', 1, 'right'); await f.confirm('pilot');
    f.seed({ id: 'full', campaign: { id: 'campaign-1', role: 'full' }, documents: ['R1'] });
    const original = PACK as unknown as ProjectPack;
    const menu = (id: string): ProjectPack => {
      const pack = structuredClone(original), pin = { ...pack.pins.reader, id };
      return { ...pack, pins: { ...pack.pins, reader: pin }, selectedReaderModel: 'selected',
        readerModels: { defaultId: 'selected', options: [{ id: 'selected', label: 'Selected reader', pin,
          rates: pack.prices.interactive.reader, promptCachePolicy: pack.settings.promptCachePolicy ?? 'explicit-no-cache-v1',
          contextTokens: pack.limits.readerContextTokens }] } };
    };
    const same = menu(original.pins.reader.id), other = menu('gpt-5.6-terra');
    await requirePilotRule(f.env, OWNER, same, ACTIVE_VERSION, 30, { id: 'campaign-1', role: 'full' }, false);
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(same), 'full');
    assert.deepEqual(await trialChecksForFullRun(f.env, f.store, await f.run('full')),
      [{ fingerprint: FP(1), destinationFolder: TYPE_IDS[0], verdict: 'right' }]);
    await assert.rejects(requirePilotRule(f.env, OWNER, other, ACTIVE_VERSION, 30, { id: 'campaign-1', role: 'full' }, false),
      { code: 'E_PILOT_READER' });
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(other), 'full');
    assert.deepEqual(await trialChecksForFullRun(f.env, f.store, await f.run('full')), []);
    // Old saved review remains visible, but an absent identity cannot become evidence for a newly selected reader.
    const { pins: _pins, ...unknownReader } = original;
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(unknownReader), 'pilot');
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(same), 'full');
    await assert.rejects(requirePilotRule(f.env, OWNER, same, ACTIVE_VERSION, 30, { id: 'campaign-1', role: 'full' }, false),
      { code: 'E_PILOT_READER' });
    assert.deepEqual(await trialChecksForFullRun(f.env, f.store, await f.run('full')), []);
    assert.equal((await f.view('pilot')).counts.right, 1);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_reviews'), 1);
    assert.equal(f.count('SELECT COUNT(*) AS n FROM pilot_confirmations'), 1);
  } finally { f.db.close(); }
});
