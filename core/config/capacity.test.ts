import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_READER_CONTRACT, EXACT_READER_CONTRACT, GROUPED_CONFIDENCE_POLICY, SINGLE_CONFIDENCE_POLICY,
  capacityRefusal, capacitySentence, confidenceCapacity, readerCapacity
} from './capacity.ts';
import { buildConfidenceRequest } from '../vendors/requests.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { hasJargon } from '../ui/error-copy.ts';
import { validateProject, type ProjectPack, type TypeFile } from './project.ts';
import { LARGE_SET_SETTINGS, syntheticPack, syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

const COUNTS = [4, 25, 50, 89, 90, 110, 254];
/** Any setting, including values the pack type does not admit, so that refusals can be tested. */
const pack = (settings: Record<string, unknown> = {}): ProjectPack => syntheticPack(4, { settings: settings as never });
const EXACT = pack(), COMPACT = pack({ readerContract: COMPACT_READER_CONTRACT });
const GROUPED = pack({ confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY });
const COMPACT_GROUPED = pack({ readerContract: COMPACT_READER_CONTRACT, confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY });
const synthetic = (n: number): TypeFile => syntheticTypeFile(n);
/**
 * Placeholder definitions at the size the 25 September measurement found for real ones: about 1,269 bytes of
 * confidence questions and about 288 bytes of Choice question per category.
 */
const typical = (n: number): TypeFile => {
  const file = synthetic(n);
  return { ...file, types: file.types.map(type => ({ ...type,
    what: type.what + ' Placeholder wording at the length of a typical written definition.',
    not_for: type.not_for + ' Placeholder exclusion wording.' })) };
};
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** The questions as the request builder sends them, measured independently of capacity.ts's search. */
function questionBytes(from: ProjectPack, typeFile: TypeFile, choiceOnly: boolean): number {
  const serializedDigest = buildConfidenceState(from.settings.confidenceStatePolicy, 'x', { headings: [], tables: [], blocks: [] }, from.structuralVocabulary).serialized;
  const { questions } = JSON.parse(buildConfidenceRequest({ pin: from.pins.confidence, typeFile, serializedDigest }).body);
  return bytes(JSON.stringify(choiceOnly ? { classification: questions.classification } : questions));
}
const refusedCode = (run: () => unknown, path: string) => assert.throws(run, (error: { code?: string; issues?: { path: string }[] }) =>
  error.code === 'E_PROJECT_CONFIG' && error.issues?.[0]?.path === path);

test('reader capacity: floor((max output - 2,048) / 160) exact, and 260 + 9n within the same room compact', () => {
  assert.deepEqual(readerCapacity(EXACT), { limit: 89, formula: 'reader-exact-evidence-v2: floor((16384 - 2048) / 160) = 89' });
  assert.deepEqual(readerCapacity(COMPACT), { limit: 1564, formula: 'reader-compact-verdicts-v1: largest n with 260 + 9n <= 16384 - 2048; n = 1564' });
  // A pack naming the exact format and a pack without the setting (a frozen one) read the same.
  assert.equal(readerCapacity(pack({ readerContract: EXACT_READER_CONTRACT })).limit, 89);
  const frozen = pack({ readerContract: undefined });
  assert.equal(Object.hasOwn(frozen.settings, 'readerContract'), false);
  assert.equal(readerCapacity(frozen).limit, 89);
  // Edges: 2,048 + 160 x 90 is the first cap that carries 90 verdicts; 2,048 + 260 + 9 x 1,565 the first for 1,565.
  assert.equal(readerCapacity(pack({ readerMaxOutputTokens: 2048 + 160 * 90 - 1 })).limit, 89);
  assert.equal(readerCapacity(pack({ readerMaxOutputTokens: 2048 + 160 * 90 })).limit, 90);
  assert.equal(readerCapacity(pack({ readerContract: COMPACT_READER_CONTRACT, readerMaxOutputTokens: 2048 + 260 + 9 * 1565 })).limit, 1565);
  assert.equal(readerCapacity(pack({ readerMaxOutputTokens: 2048 })).limit, 0);
  assert.equal(readerCapacity(pack({ readerContract: COMPACT_READER_CONTRACT, readerMaxOutputTokens: 2048 + 259 })).limit, 0);
  // An unknown format, or no output cap, is refused rather than defaulted.
  refusedCode(() => readerCapacity(pack({ readerContract: 'reader-other-v9' })), 'settings.readerContract');
  refusedCode(() => readerCapacity(pack({ readerContract: null })), 'settings.readerContract');
  refusedCode(() => readerCapacity(pack({ readerMaxOutputTokens: undefined })), 'settings.readerMaxOutputTokens');
});

test('confidence capacity at 4, 25, 50, 89, 90, 110 and 254 categories, single and grouped', () => {
  // Synthetic definitions (177 bytes each): the questions fit 32 in one request; the Choice question alone fits 166.
  const expected = { single: 32, grouped: 166, typicalSingle: 24, typicalGrouped: 109 };
  for (const n of COUNTS) {
    assert.equal(confidenceCapacity(EXACT, synthetic(n)).limit, Math.min(n, expected.single), `single ${n}`);
    assert.equal(confidenceCapacity(GROUPED, synthetic(n)).limit, Math.min(n, expected.grouped), `grouped ${n}`);
    // At the measured real size: about 25 in one request (32,000 / 1,269), about 110 grouped (32,000 / 288).
    assert.equal(confidenceCapacity(EXACT, typical(n)).limit, Math.min(n, expected.typicalSingle), `typical single ${n}`);
    assert.equal(confidenceCapacity(GROUPED, typical(n)).limit, Math.min(n, expected.typicalGrouped), `typical grouped ${n}`);
    // The reader contract does not move the confidence limit.
    assert.equal(confidenceCapacity(COMPACT, synthetic(n)).limit, Math.min(n, expected.single));
  }
  // The per-category sizes behind the ~25 / ~110 figures.
  const perCategory = (file: (n: number) => TypeFile, choiceOnly: boolean) =>
    questionBytes(EXACT, file(101), choiceOnly) - questionBytes(EXACT, file(100), choiceOnly);
  assert.deepEqual([perCategory(typical, false), perCategory(typical, true)], [1266, 287]);
  assert.deepEqual([perCategory(synthetic, false), perCategory(synthetic, true)], [972, 189]);
  // Each limit is the last prefix whose measured questions fit 64,000 - 32,000 bytes; one more does not fit.
  for (const [from, file, limit, choiceOnly] of [
    [EXACT, synthetic, expected.single, false], [GROUPED, synthetic, expected.grouped, true],
    [EXACT, typical, expected.typicalSingle, false], [GROUPED, typical, expected.typicalGrouped, true]
  ] as const) {
    assert.ok(questionBytes(from, file(limit), choiceOnly) <= 32000);
    assert.ok(questionBytes(from, file(limit + 1), choiceOnly) > 32000);
  }
  assert.equal(confidenceCapacity(EXACT, synthetic(254)).formula,
    'confidence-single-request-v1: largest n <= 254 whose questions fit 64000 - 32000 = 32000 tokens at ceil(bytes / 1); n = 32 (31630 bytes, 31630 tokens, for the first 32)');
  assert.equal(confidenceCapacity(GROUPED, synthetic(254)).formula,
    'confidence-grouped-nouls-v1: largest n <= 254 whose Choice and each Noul question fit 64000 - 32000 = 32000 tokens at ceil(bytes / 1); n = 166 (31900 bytes, 31900 tokens, for the first 166)');
  assert.equal(confidenceCapacity(pack({ confidenceQuestionPolicy: SINGLE_CONFIDENCE_POLICY }), synthetic(254)).limit, 32);
  // The room is the difference of the two declared limits; with none left, not even one category fits.
  const room = (all: number, state: number) => confidenceCapacity({ ...EXACT, limits: { ...EXACT.limits,
    confidenceAllQuestionTokens: all, confidenceStateQuestionTokens: state } }, synthetic(254)).limit;
  assert.equal(room(96000, 32000), 65);
  assert.equal(room(32000, 32000), 0);
  // The older structured input policy sends shorter instructions; its questions are measured from those.
  assert.equal(confidenceCapacity(pack({ confidenceStatePolicy: 'untrimmed-structured-state-v2' }), synthetic(254)).limit, 33);
  refusedCode(() => confidenceCapacity(pack({ confidenceQuestionPolicy: 'confidence-other-v9' }), synthetic(4)), 'settings.confidenceQuestionPolicy');
});

test('the bytes-per-token ratio: absent reads 1; 4 counts a quarter of the bytes; anything below 1 is refused', () => {
  // At 254 synthetic categories: one request carries 32 at ratio 1 and 131 at ratio 4; grouped, 166 and all 254.
  const at = (settings: Record<string, unknown>) => confidenceCapacity(pack(settings), synthetic(254));
  assert.deepEqual([at({}).limit, at({ tokenBytesRatio: 1 }).limit, at({ tokenBytesRatio: 4 }).limit], [32, 32, 131]);
  assert.deepEqual([at({ confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY }).limit,
    at({ confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY, tokenBytesRatio: 4 }).limit], [166, 254]);
  assert.equal(at({ tokenBytesRatio: 4 }).formula,
    'confidence-single-request-v1: largest n <= 254 whose questions fit 64000 - 32000 = 32000 tokens at ceil(bytes / 4); n = 131 (127858 bytes, 31965 tokens, for the first 131)');
  // The limit is the last prefix whose ceil(bytes / 4) fits; one more does not.
  assert.ok(Math.ceil(questionBytes(EXACT, synthetic(131), false) / 4) <= 32000);
  assert.ok(Math.ceil(questionBytes(EXACT, synthetic(132), false) / 4) > 32000);
  // The reader limit is measured output, not a byte proxy: the ratio does not move it.
  assert.equal(readerCapacity(pack({ tokenBytesRatio: 4 })).limit, 89);
  for (const bad of [0.5, 0, Number.NaN, Number.POSITIVE_INFINITY, '4', null])
    refusedCode(() => at({ tokenBytesRatio: bad }), 'settings.tokenBytesRatio');
  const ratioIssues = (tokenBytesRatio: unknown) => validateProject({ settings: { tokenBytesRatio } })
    .filter(issue => issue.path === 'settings.tokenBytesRatio').map(issue => issue.detail);
  for (const good of [undefined, 1, 2.5, 4]) assert.deepEqual(ratioIssues(good), [], String(good));
  for (const bad of [0.5, Number.NaN, '4', null]) assert.deepEqual(ratioIssues(bad), ['A number of at least 1 is required.'], String(bad));
  // The synthetic gate pack declares the compact answer, grouped questions and ratio 4 above the exact reader capacity
  // only; below it the shipped generic pack's explicit ratio 1 stands.
  assert.deepEqual(LARGE_SET_SETTINGS, { readerContract: COMPACT_READER_CONTRACT, confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY, tokenBytesRatio: 4 });
  for (const n of [4, 89]) assert.equal(syntheticPack(n).settings.tokenBytesRatio, 1, String(n));
  for (const n of [90, 254]) {
    const { readerContract, confidenceQuestionPolicy, tokenBytesRatio } = syntheticPack(n).settings;
    assert.deepEqual([readerContract, confidenceQuestionPolicy, tokenBytesRatio], [COMPACT_READER_CONTRACT, GROUPED_CONFIDENCE_POLICY, 4], String(n));
  }
  assert.equal(syntheticPack(254, { settings: { tokenBytesRatio: undefined } }).settings.tokenBytesRatio, undefined);
});

test('refusal: the smaller exceeded limit is named in one plain sentence, under both reader contracts', () => {
  const named = (from: ProjectPack, n: number) => {
    const refusal = capacityRefusal(from, synthetic(n));
    return refusal && [refusal.check, refusal.limit];
  };
  const table: Record<number, unknown[]> = {
    4: [null, null, null, null],
    25: [null, null, null, null],
    50: [['confidence check', 32], ['confidence check', 32], null, null],
    89: [['confidence check', 32], ['confidence check', 32], null, null],
    90: [['confidence check', 32], ['confidence check', 32], ['reader', 89], null],
    110: [['confidence check', 32], ['confidence check', 32], ['reader', 89], null],
    254: [['confidence check', 32], ['confidence check', 32], ['reader', 89], ['confidence check', 166]]
  };
  for (const n of COUNTS)
    assert.deepEqual([EXACT, COMPACT, GROUPED, COMPACT_GROUPED].map(from => named(from, n)), table[n], String(n));
  // A tie names the reader.
  const tie = pack({ confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY, readerMaxOutputTokens: 2048 + 160 * 166 });
  assert.deepEqual(named(tie, 254), ['reader', 166]);
  const reader = capacityRefusal(GROUPED, synthetic(254))!, confidence = capacityRefusal(EXACT, synthetic(254))!;
  assert.equal(reader.sentence, 'These 254 categories exceed what the reader can handle in one call (89 under the current settings). Reduce the set, or change the answer format in the project settings.');
  assert.equal(confidence.sentence, 'These 254 categories exceed what the confidence check can handle in one call (32 under the current settings). Reduce the set, or change the answer format in the project settings.');
  assert.equal(capacitySentence(90, 'reader', 89), 'These 90 categories exceed what the reader can handle in one call (89 under the current settings). Reduce the set, or change the answer format in the project settings.');
  // The browser shows it as written: no code, no technical word.
  for (const { sentence } of [reader, confidence])
    assert.equal(hasJargon(sentence) || /threshold|fingerprint|E_[A-Z_]+/.test(sentence), false, sentence);
});


test('review V2: grouped capacity refuses an individual Noul that does not fit, before activation', () => {
  const from = pack({ confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY });
  const long = { ...synthetic(1), types: [{ id: 'type_long', name: 'Long', what: 'w'.repeat(20000), not_for: 'x', examples: ['y'] }] };
  assert.equal(confidenceCapacity(from, long).limit, 0);
  assert.deepEqual(capacityRefusal(from, long), {count:1,check:'confidence check',limit:0,sentence:capacitySentence(1,'confidence check',0)});
  const mixed = { ...long, types: [synthetic(1).types[0], ...long.types] };
  assert.equal(confidenceCapacity(from,mixed).limit,1,'the failing Noul is included in every larger prefix');
});
