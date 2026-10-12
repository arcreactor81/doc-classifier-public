import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1 } from './testing/local-bindings.ts';
import { activateDefinition, createDefinitionDraft, effectiveProject } from './definitions.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { sameTrialReader } from './model-calibration.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

/**
 * DECISIONS 134 track record, applied to the DECISIONS 136 readers: each exact reader pin keeps its own checked history
 * and threshold for the category version. Qwen and DeepSeek start at 0.90, untested, and borrow nothing from GPT-5.4.
 */
const OWNER = 'editor';
const SEED = requireProject({ ...structuredClone(ownerPack), typeFile: syntheticPack(2).typeFile, structuralVocabulary: [] }) as ProjectPack;
const pinOf = (id: string) => SEED.readerModels!.options.find(option => option.id === id)!.pin;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: 'project-pack:reader-vendors', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:reader-vendors' ? { format: 'json', source: JSON.stringify(SEED), shortCircuit: true } : next(url, context);
  }
});

async function fixture() {
  const db = migratedDatabase({ foreignKeys: false });
  const env = { DB: localD1(db), DEFINITION_MODE: 'runtime', DEFINITION_EDITORS: JSON.stringify([OWNER]) };
  const draft = await createDefinitionDraft(env, SEED, OWNER, { baseRevisionId: null, typeFile: structuredClone(SEED.typeFile), displayNames: {} });
  const active = (await activateDefinition(env, SEED, OWNER, draft.id, { inheritThreshold: false })).active;
  const revision = db.prepare('SELECT type_version FROM definition_revisions WHERE id=?').get(active.id)!;
  let n = 0;
  const selected = (id: string) => effectiveProject(env, SEED, { selectedReaderModel: id });
  // A run frozen with that reader, as a real confirmation records it (with its calibration identity).
  const applied = async (option: string, threshold: number) => {
    const at = `2026-10-06T00:00:${String(++n).padStart(2, '0')}.000Z`, pack = await selected(option);
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'closed',?,'interactive',0,.9,'initial',?,?,'{}',?)")
      .run(`source-${n}`, OWNER, at, String(revision.type_version), JSON.stringify(pack), `quote-${n}`);
    db.prepare('INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES(?,?,?,?,?,?,?)')
      .run(`correction-${n}`, `source-${n}`, OWNER, at, `raw-${n}`, `analysis-${n}`, JSON.stringify({ raise: { threshold } }));
    db.prepare('INSERT INTO threshold_history(id,correction_id,actor,created_at,threshold,direction) VALUES(?,?,?,?,?,?)')
      .run(`history-${n}`, `correction-${n}`, OWNER, at, threshold, 'raise');
  };
  return { db, applied, selected };
}

test('Qwen and DeepSeek start at 0.90, untested, whatever GPT-5.4\'s record is', async () => {
  const f = await fixture();
  try {
    await f.applied('standard', .95); await f.applied('standard', .95);
    const standard = await f.selected('standard');
    assert.deepEqual([standard.definitionThreshold, standard.definitionThresholdStatus], [.95, 'calibrated']);
    for (const id of ['qwen', 'deepseek']) {
      const pack = await f.selected(id);
      assert.deepEqual([pack.pins.reader.id, pack.definitionThreshold, pack.definitionThresholdStatus], [pinOf(id).id, .9, 'untested'], id);
      assert.notEqual(pack.readerCalibrationKey, standard.readerCalibrationKey);
    }
  } finally { f.db.close(); }
});

test('each experimental reader keeps only its own record', async () => {
  const f = await fixture();
  try {
    await f.applied('qwen', .94);
    assert.deepEqual([(await f.selected('qwen')).definitionThreshold, (await f.selected('qwen')).definitionThresholdStatus], [.94, 'provisional']);
    for (const id of ['standard', 'mini', 'deepseek'])
      assert.deepEqual([(await f.selected(id)).definitionThreshold, (await f.selected(id)).definitionThresholdStatus], [.9, 'untested'], id);
  } finally { f.db.close(); }
});

test('a trial checked with one reader never carries into a full run with another', () => {
  const trial = { ...structuredClone(SEED) }; trial.pins.reader = structuredClone(pinOf('standard'));
  const full = { ...structuredClone(SEED) }; full.pins.reader = structuredClone(pinOf('qwen'));
  assert.equal(sameTrialReader(full, JSON.stringify(trial)), false);
  assert.equal(sameTrialReader(full, JSON.stringify(full)), true);
  const deepseek = { ...structuredClone(SEED) }; deepseek.pins.reader = structuredClone(pinOf('deepseek'));
  assert.equal(sameTrialReader(deepseek, JSON.stringify(full)), false);
});
