import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDatabase, localD1 } from './testing/local-bindings.ts';
import { activateDefinition, createDefinitionDraft, definitionState } from './definitions.ts';
import { capacitySentence } from '../config/capacity.ts';
import { typeVersion, type ProjectPack, type TypeFile } from '../config/project.ts';
import { syntheticPack, syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

// Real SQL over the real migrations. The seed pack names today's reader answer format and confidence question layout
// explicitly, so these tests do not depend on the shipped pack's copy of those settings.
const EDITOR = 'editor';
const seed = (settings: Record<string, unknown> = {}): ProjectPack => syntheticPack(4, { settings: {
  readerContract: 'reader-exact-evidence-v2', confidenceQuestionPolicy: 'confidence-single-request-v1', ...settings } as never });
const GROUPED = seed({ confidenceQuestionPolicy: 'confidence-grouped-nouls-v1' });

function fixture() {
  const db = migratedDatabase();
  const env = { DB: localD1(db), DEFINITION_MODE: 'runtime', DEFINITION_EDITORS: JSON.stringify([EDITOR]) };
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const active = () => db.prepare('SELECT * FROM definition_active').get();
  /** A draft saved directly, as one saved before this release (or under other settings) would be stored. */
  const storedDraft = async (typeFile: TypeFile) => {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO definition_revisions(id,base_revision_id,type_version,type_file_json,display_names_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)')
      .run(id, null, await typeVersion(JSON.stringify(typeFile)), JSON.stringify(typeFile), '{}', '2026-10-01T00:00:00.000Z', EDITOR);
    return id;
  };
  const draft = (pack: ProjectPack, typeFile: TypeFile) =>
    createDefinitionDraft(env, pack, EDITOR, { baseRevisionId: null, typeFile, displayNames: {} });
  return { db, env, count, active, storedDraft, draft };
}

/**
 * The refusal a person sees: its code, status and sentence, and that the sentence carries no code and neither banned
 * word (the browser's own jargon filter is checked against the same sentences in core/config/capacity.test.ts).
 */
async function refusal(promise: Promise<unknown>): Promise<[string, number, string]> {
  const error = await promise.then(() => null, (e: { code: string; status: number; message: string }) => e);
  assert.ok(error, 'expected a refusal');
  assert.equal(/threshold|fingerprint|E_[A-Z_]+/.test(error.message), false, error.message);
  return [error.code, error.status, error.message];
}

test('a draft above either capacity is refused with the numbers and nothing is stored', async () => {
  const f = fixture();
  try {
    // The confidence check binds first under today's single request: 32 synthetic categories fit, 33 do not.
    assert.deepEqual(await refusal(f.draft(seed(), syntheticTypeFile(33))),
      ['E_CATEGORY_CAPACITY', 409, capacitySentence(33, 'confidence check', 32)]);
    assert.deepEqual(await refusal(f.draft(seed(), syntheticTypeFile(254))),
      ['E_CATEGORY_CAPACITY', 409, 'These 254 categories exceed what the confidence check can handle in one call (32 under the current settings). Reduce the set, or change the answer format in the project settings.']);
    // With the confidence questions grouped, the reader binds: 89 fit, 90 do not.
    assert.deepEqual(await refusal(f.draft(GROUPED, syntheticTypeFile(90))),
      ['E_CATEGORY_CAPACITY', 409, 'These 90 categories exceed what the reader can handle in one call (89 under the current settings). Reduce the set, or change the answer format in the project settings.']);
    assert.equal(f.count('definition_revisions'), 0);
    // The 254 ceiling is still refused first, as a configuration issue naming the field.
    const over = await f.draft(seed(), syntheticTypeFile(255)).then(() => null, (e: { code: string; issues: { path: string }[] }) => e);
    assert.equal(over?.code, 'E_PROJECT_CONFIG');
    assert.deepEqual(over?.issues.map(issue => issue.path), ['typeFile.types']);
    // At the limit the draft is saved.
    assert.equal((await f.draft(seed(), syntheticTypeFile(32))).typeFile.types.length, 32);
    assert.equal((await f.draft(GROUPED, syntheticTypeFile(89))).typeFile.types.length, 89);
    assert.equal(f.count('definition_revisions'), 2);
  } finally { f.db.close(); }
});

test('activation re-checks capacity under the current settings; a refused set leaves the categories in force unchanged', async () => {
  const f = fixture();
  try {
    const before = f.active();
    const confidence = await f.storedDraft(syntheticTypeFile(254));
    assert.deepEqual(await refusal(activateDefinition(f.env, seed(), EDITOR, confidence, { inheritThreshold: false })),
      ['E_CATEGORY_CAPACITY', 409, capacitySentence(254, 'confidence check', 32)]);
    assert.deepEqual(await refusal(activateDefinition(f.env, GROUPED, EDITOR, confidence, { inheritThreshold: false })),
      ['E_CATEGORY_CAPACITY', 409, capacitySentence(254, 'reader', 89)]);
    assert.deepEqual(f.active(), before);
    assert.equal(f.count('definition_activations'), 0);
    // A draft saved under settings that carried it (grouped) is refused once those settings no longer do.
    const saved = await f.draft(GROUPED, syntheticTypeFile(40));
    assert.deepEqual(await refusal(activateDefinition(f.env, seed(), EDITOR, saved.id, { inheritThreshold: false })),
      ['E_CATEGORY_CAPACITY', 409, capacitySentence(40, 'confidence check', 32)]);
    assert.equal((await activateDefinition(f.env, GROUPED, EDITOR, saved.id, { inheritThreshold: false })).active.id, saved.id);
    assert.equal((await definitionState(f.env, GROUPED, EDITOR)).active?.typeFile.types.length, 40);
    assert.equal(f.count('definition_activations'), 1);
  } finally { f.db.close(); }
});

// DECISIONS 150: a trusted user is exempt from the per-person caps only; category editing stays with the editor list.
test('a trusted user who is not a listed editor cannot edit categories and is not offered editing', async () => {
  const f = fixture();
  try {
    const env = { ...f.env, TRUSTED_USERS: JSON.stringify(['trusted']) };
    const refused = await createDefinitionDraft(env, seed(), 'trusted', { baseRevisionId: null, typeFile: syntheticTypeFile(2), displayNames: {} })
      .then(() => null, (error: { code: string; status: number }) => [error.code, error.status]);
    assert.deepEqual(refused, ['E_EDITOR_REQUIRED', 403]);
    assert.equal(f.count('definition_revisions'), 0);
    assert.equal((await definitionState(env, seed(), 'trusted')).canEdit, false);
    assert.equal((await definitionState(env, seed(), EDITOR)).canEdit, true);
  } finally { f.db.close(); }
});
