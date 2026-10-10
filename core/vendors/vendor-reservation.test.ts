import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readerContextBound, reservationForRequest } from './input-token-count.ts';
import { buildReaderRequest, buildRecoveryRequest } from './requests.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { ValidationFailure } from './validate.ts';

/**
 * DECISIONS 136 admission. Neither DeepSeek nor Workers AI documents an input-count endpoint, so the reservation uses
 * the bound the project already relies on (DECISIONS 95): a token is never fewer than one byte, so the request's UTF-8
 * byte length bounds its input tokens. Input is reserved uncached at the full rate, output at the unchanged full cap.
 */
const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const pack = (id: string): ProjectPack => selectReaderModel(requireProject({ ...structuredClone(owner), typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), id);
const request = (selected: ProjectPack, text = 'Synthetic source.') => buildReaderRequest({ pin: selected.pins.reader, typeFile: selected.typeFile, text,
  effort: selected.settings.readerEffort, maxOutputTokens: selected.settings.readerMaxOutputTokens, contract: selected.settings.readerContract,
  cachePolicy: selected.settings.promptCachePolicy });
const bytes = (value: string) => new TextEncoder().encode(value).length;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const cost = (input: number, output: number, rates: { inputNanodollarsPerMillion: string; outputNanodollarsPerMillion: string }) =>
  Number(ceilDiv(BigInt(input) * BigInt(rates.inputNanodollarsPerMillion), 1000000n) + ceilDiv(BigInt(output) * BigInt(rates.outputNanodollarsPerMillion), 1000000n));

test('the reader context bound (DESIGN §6) is the byte bound or the exact count, plus the request\'s own output cap; never an estimate', () => {
  for (const [id, capField] of [['qwen', 'max_completion_tokens'], ['deepseek', 'max_output_tokens']] as const) {
    const selected = pack(id), sent = request(selected), cap = JSON.parse(sent.body)[capField];
    assert.ok(Number.isSafeInteger(cap) && cap > 0);
    assert.equal(readerContextBound(sent, null), bytes(sent.body) + cap);
    assert.equal(readerContextBound(sent, 5), bytes(sent.body) + cap, 'a count never replaces the byte bound of a reader without a count endpoint');
  }
  const mini = pack('mini'), sent = request(mini);
  assert.equal(readerContextBound(sent, 1_234), 1_234 + JSON.parse(sent.body).max_output_tokens);
  assert.equal(readerContextBound(sent, null), null, 'without the exact count there is no bound, and nothing is estimated');
  const recovery = buildRecoveryRequest({ pin: mini.pins.recovery, text: 'Synthetic source.', effort: mini.settings.recoveryEffort,
    maxOutputTokens: mini.settings.recoveryMaxOutputTokens, cachePolicy: mini.settings.promptCachePolicy });
  assert.equal(readerContextBound(recovery, 1_234), null, 'only the reader\'s context is bounded here');
});

test('a Qwen request reserves its byte bound and the run cap in Neurons from the site-wide Workers AI pool', () => {
  const selected = pack('qwen'), sent = request(selected);
  const reservation = reservationForRequest(selected, sent, null)!;
  assert.deepEqual(reservation.pool, { id: 'workers-ai', unit: 'nanodollars', modelIds: ['@cf/qwen/qwen3.8-27b'] });
  assert.equal(reservation.limitUnits, 9000 * 11000, '9,000 Neurons, kept in nanodollars at USD 0.011 per 1,000 Neurons');
  // The run's cap (owner decision of 7 October 2026): 2,048 + 320 per category, here two categories.
  assert.equal(JSON.parse(sent.body).max_completion_tokens, 2688);
  assert.equal(reservation.reservedUnits, cost(bytes(sent.body), 2688, selected.prices.interactive.reader));
  assert.ok(reservation.reservedUnits < 9000 * 11000 / 5, 'several Qwen calls now fit in the pool at once');
});

test('a DeepSeek request reserves its byte bound and the run cap at peak rates from the USD 0.50 pool', () => {
  const selected = pack('deepseek'), sent = request(selected);
  const reservation = reservationForRequest(selected, sent, null)!;
  assert.deepEqual(reservation.pool, { id: 'deepseek', unit: 'nanodollars', modelIds: ['deepseek-flash'] });
  assert.equal(reservation.limitUnits, 500000000);
  assert.equal(JSON.parse(sent.body).max_output_tokens, 2688);
  assert.equal(reservation.reservedUnits, cost(bytes(sent.body), 2688, { inputNanodollarsPerMillion: '300000000', outputNanodollarsPerMillion: '1200000000' }));
});

test('the byte bound counts bytes, not characters, so multi-byte text is never under-reserved', () => {
  const selected = pack('qwen');
  const ascii = reservationForRequest(selected, request(selected, 'aaaa'), null)!;
  const wide = reservationForRequest(selected, request(selected, 'éééé'), null)!;
  assert.equal(request(selected, 'aaaa').body.length, request(selected, 'éééé').body.length);
  assert.ok(wide.reservedUnits > ascii.reservedUnits);
});

test('no count is requested or accepted for these vendors, and v1 limits have no pool for them', () => {
  const selected = pack('deepseek'), sent = request(selected);
  assert.throws(() => reservationForRequest(selected, sent, 1300), (error: unknown) => error instanceof ValidationFailure && error.code === 'E_INPUT_TOKEN_COUNT');
  const v1 = structuredClone(selected) as any;
  v1.settings.usageLimits.policy = 'daily-usage-v1'; delete v1.settings.usageLimits.workersAiDailyNeurons; delete v1.settings.usageLimits.deepseekDailyNano;
  assert.throws(() => reservationForRequest(v1, sent, null), (error: unknown) => error instanceof ValidationFailure && error.code === 'E_DAILY_MODEL');
  // The practice pack has no limits: nothing is reserved.
  const practice = structuredClone(selected) as any; delete practice.settings.usageLimits;
  assert.equal(reservationForRequest(practice, sent, null), null);
});

test('a request larger than the whole daily pool is refused plainly instead of waiting for a reset that cannot help', () => {
  const selected = pack('qwen');
  const huge = request(selected, 'x'.repeat(230_000));
  assert.throws(() => reservationForRequest(selected, huge, null),
    (error: unknown) => error instanceof ValidationFailure && error.code === 'E_DAILY_REQUEST_BOUND' && error.kind === 'blocker' && /larger than/i.test(error.message));
});
