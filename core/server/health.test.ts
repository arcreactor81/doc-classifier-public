import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { typeVersion } from '../config/project.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

// Health's `project-pack` import is a build-time alias; here it is served in-process. health.ts sees a 40-category
// synthetic pack (above today's confidence capacity); health.ts?unready, a second instance, sees the shipped
// generic pack with no categories. Registered before either import.
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
// Both name today's answer format and question layout, so the test does not depend on the shipped pack's copy of them.
const TODAY = { readerContract: 'reader-exact-evidence-v2', confidenceQuestionPolicy: 'confidence-single-request-v1' };
const PACKS: Record<string, unknown> = {
  ready: fixtures.syntheticPack(40, { settings: TODAY }),
  unready: { ...fixtures.shippedGenericPack(), settings: { ...fixtures.shippedGenericPack().settings, ...TODAY } },
  menu: { ...ownerPack, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== 'project-pack') return next(specifier, context);
    const parent = context.parentURL ?? '';
    return { url: `project-pack:${parent.endsWith('?unready') ? 'unready' : parent.endsWith('?menu') ? 'menu' : 'ready'}`, format: 'json', shortCircuit: true };
  },
  load(url, context, next) {
    const name = url.startsWith('project-pack:') ? url.slice('project-pack:'.length) : null;
    return name ? { format: 'json', source: JSON.stringify(PACKS[name]), shortCircuit: true } : next(url, context);
  }
});
const { health } = await import('./health.ts');
const unready = (await import(('./health.ts?unready') as string)) as typeof import('./health.ts');
const menu = (await import(('./health.ts?menu') as string)) as typeof import('./health.ts');

function env(extra: Record<string, unknown> = {}) {
  const db = migratedDatabase();
  return {
    db,
    env: {
      DB: localD1(db), ARTIFACTS: memoryR2(), DOCUMENT_WORKFLOW: {}, MODEL_CALLS_ENABLED: 'true', PROJECT_ID: 'synthetic',
      BUILD_COMMIT: 'health-local-test', OPENAI_API_KEY: { get: async () => 'local-test-only' },
      JEV_API_KEY: { get: async () => 'local-test-only' }, DEFINITION_EDITORS: JSON.stringify(['health-test-owner']), ...extra
    } as unknown as Env
  };
}

test('Health shows capacity: reader and confidence limits beside the number of categories in force', async () => {
  const git = env();
  try {
    // 40 synthetic categories exceed the 32 the confidence check carries; Health shows it, and stays READY.
    const view = await health(git.env, 'cloudflare');
    assert.deepEqual(view.capacity, { reader: 89, confidence: 32, categories: 40 });
    assert.equal(view.status, 'READY');
  } finally { git.db.close(); }
  const runtime = env({ DEFINITION_MODE: 'runtime' });
  try {
    // With website-managed categories the active set is measured.
    const typeFile = fixtures.syntheticTypeFile(4);
    runtime.db.prepare('INSERT INTO definition_revisions(id,base_revision_id,type_version,type_file_json,display_names_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)')
      .run('revision', null, await typeVersion(JSON.stringify(typeFile)), JSON.stringify(typeFile), '{}', '2026-10-01T00:00:00.000Z', 'editor');
    runtime.db.prepare("UPDATE definition_active SET revision_id='revision'").run();
    assert.deepEqual((await health(runtime.env, 'cloudflare')).capacity, { reader: 89, confidence: 4, categories: 4 });
  } finally { runtime.db.close(); }
});

// F4 (independent review, 7 October 2026): without a listed owner nobody can stop all runs, so Health says so loudly.
test('an empty, missing, unreadable or email editor list reads NOT READY with its own numbered blocker', async () => {
  const noOwner = "No site owner is listed, so nobody can stop all runs. Add the owner's Cloudflare Access user ID to DEFINITION_EDITORS.";
  const email = 'The editor list holds an email address; it needs Cloudflare Access user IDs.';
  for (const [value, code, headline] of [
    [undefined, 'E_EDITORS_MISSING', noOwner], ['', 'E_EDITORS_MISSING', noOwner], ['[]', 'E_EDITORS_MISSING', noOwner],
    ['not json', 'E_EDITORS_MISSING', noOwner], ['"owner-id"', 'E_EDITORS_MISSING', noOwner], ['{"owner":"id"}', 'E_EDITORS_MISSING', noOwner],
    ['[""]', 'E_EDITORS_MISSING', noOwner], ['[1]', 'E_EDITORS_MISSING', noOwner], ['["owner-id", null]', 'E_EDITORS_MISSING', noOwner],
    ['["owner@example.invalid"]', 'E_EDITORS_EMAIL', email], ['["owner-id", "editor@example.invalid"]', 'E_EDITORS_EMAIL', email]
  ] as const) {
    const site = env({ DEFINITION_EDITORS: value });
    if (value === undefined) delete (site.env as { DEFINITION_EDITORS?: string }).DEFINITION_EDITORS;
    try {
      const view = await health(site.env, 'cloudflare') as { status: string; blockers: { code: string; headline: string; action: string }[] };
      assert.equal(view.status, 'NOT READY', String(value));
      assert.deepEqual(view.blockers.map(blocker => [blocker.code, blocker.headline]), [[code, headline]], String(value));
      assert.ok(view.blockers[0].action.length > 0, 'a blocker carries its action sentence');
    } finally { site.db.close(); }
  }
  for (const value of ['["owner-id"]', '["c0ffee00-0000-4000-8000-000000000000","second-id"]']) {
    const site = env({ DEFINITION_EDITORS: value });
    try { assert.equal((await health(site.env, 'cloudflare')).status, 'READY', value); } finally { site.db.close(); }
  }
});

// DECISIONS 150 (owner, 9 October 2026): the trusted-users list is checked as the editor list is, by the same code, except
// that no trusted user at all is fine.
test('a malformed trusted-users list reads NOT READY with its own numbered blocker; an absent or empty one is fine', async () => {
  const invalid = 'The list of trusted users can\'t be used: TRUSTED_USERS must be a list of Cloudflare Access user IDs, with no email addresses or empty entries.';
  for (const [value, problem] of [
    ['', 'unreadable'], ['not json', 'unreadable'], ['"person-id"', 'unreadable'], ['{"person":"id"}', 'unreadable'], ['[""]', 'unreadable'],
    ['["person-id", ""]', 'unreadable'], ['[1]', 'unreadable'], ['["person-id", null]', 'unreadable'],
    ['["person@example.invalid"]', 'email'], ['["person-id", "reviewer@example.invalid"]', 'email']
  ] as const) {
    const site = env({ TRUSTED_USERS: value });
    try {
      const view = await health(site.env, 'cloudflare') as { status: string; blockers: { code: string; headline: string; action: string; details?: unknown }[] };
      assert.equal(view.status, 'NOT READY', value);
      assert.deepEqual(view.blockers.map(blocker => [blocker.code, blocker.headline, blocker.details]), [['E_TRUSTED_USERS_INVALID', invalid, { problem }]], value);
      assert.ok(view.blockers[0].action.length > 0, 'a blocker carries its action sentence');
    } finally { site.db.close(); }
  }
  for (const value of [undefined, '[]', '["person-id"]', '["c0ffee00-0000-4000-8000-000000000000","second-id"]']) {
    const site = env(value === undefined ? {} : { TRUSTED_USERS: value });
    try {
      const view = await health(site.env, 'cloudflare') as { status: string; blockers: unknown[] };
      assert.equal(view.status, 'READY', String(value));
      assert.deepEqual(view.blockers, [], String(value));
    } finally { site.db.close(); }
  }
  // A malformed trusted list beside a missing editor list: each says what is wrong with it.
  const both = env({ DEFINITION_EDITORS: '[]', TRUSTED_USERS: 'not json' });
  try {
    const view = await health(both.env, 'cloudflare') as { blockers: { code: string }[] };
    assert.deepEqual(view.blockers.map(blocker => blocker.code), ['E_EDITORS_MISSING', 'E_TRUSTED_USERS_INVALID']);
  } finally { both.db.close(); }
});

test('Health capacity is null while the configuration itself is not ready', async () => {
  const shipped = env({ PROJECT_ID: 'generic' });
  try {
    const view = await unready.health(shipped.env, 'cloudflare');
    assert.equal(view.status, 'NOT READY');
    assert.equal(view.capacity, null);
  } finally { shipped.db.close(); }
});

test('a missing AI binding or DeepSeek key blocks only that reader; the site stays READY (DECISIONS 136)', async () => {
  const site = env({ PROJECT_ID: 'owner' });
  try {
    const view = await menu.health(site.env, 'cloudflare') as { status: string; readerOptions: { id: string; ready: boolean; blockers: { code: string }[] }[] };
    assert.equal(view.status, 'READY');
    assert.deepEqual(view.readerOptions.map(row => [row.id, row.ready, row.blockers.map(b => b.code)]),
      [['standard', true, []], ['mini', true, []], ['qwen', false, ['E_READER_BINDING']], ['deepseek', false, ['E_VENDOR_KEY']]]);
    const notes = (view as unknown as { notes: { code: string; headline: string }[] }).notes.filter(note => note.code === 'N_READER_MODEL_UNLOCKED');
    // DECISIONS 154 (no lock) and 155 (the OpenAI readers by name): every reader says its name is not locked.
    assert.deepEqual(notes.map(note => note.headline), ['GPT-5.4', 'GPT-5.4 mini', 'Qwen 3.8 27B (Cloudflare)', 'DeepSeek Flash']
      .map(name => `The model name behind ${name} is not locked; each run freezes the first name it reports and stops if it changes.`));
  } finally { site.db.close(); }
  const bound = env({ PROJECT_ID: 'owner', AI: { run: async () => new Response('{}') }, DEEPSEEK_API_KEY: { get: async () => 'local-test-only' } });
  try {
    const view = await menu.health(bound.env, 'cloudflare') as { status: string; readerOptions: { ready: boolean }[] };
    assert.equal(view.status, 'READY'); assert.ok(view.readerOptions.every(row => row.ready));
  } finally { bound.db.close(); }
});
