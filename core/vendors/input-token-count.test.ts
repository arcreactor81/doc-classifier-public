import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInputTokenCountRequest, readInputTokenCount, reservationForRequest } from './input-token-count.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { buildReaderRequest, buildConfidenceRequest, buildRecoveryRequest } from './requests.ts';

function fixture() {
  const pack = syntheticPack(1);
  pack.settings.usageLimits = { policy: 'daily-usage-v1', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
    openaiTokenPools: [{ id: 'test', modelIds: [pack.pins.reader.id, pack.pins.recovery.id], limitTokens: 225000 }], typesafeDailyNano: '1000000000' };
  const request = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: 'Synthetic content.',
    effort: pack.settings.readerEffort, maxOutputTokens: pack.settings.readerMaxOutputTokens,
    contract: pack.settings.readerContract });
  return { pack, request };
}

test('counting carries the identical model input, schema, effort and truncation without changing the inference bytes', () => {
  const { request } = fixture(), original = request.body;
  const count = buildInputTokenCountRequest(request), parsed = JSON.parse(original), body = JSON.parse(count.body);
  assert.equal(count.endpoint, 'https://api.openai.com/v1/responses/input_tokens');
  assert.deepEqual(body.input, parsed.input); assert.deepEqual(body.text, parsed.text);
  assert.deepEqual(body.reasoning, parsed.reasoning); assert.equal(body.model, parsed.model);
  assert.equal(body.truncation, 'disabled');
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false); assert.equal(Object.hasOwn(body, 'store'), false);
  assert.equal(request.body, original);
});

test('only an explicit nonnegative safe count from the documented response is accepted', () => {
  assert.equal(readInputTokenCount({ object: 'response.input_tokens', input_tokens: 123 }), 123);
  for (const raw of [null, {}, { object: 'response', input_tokens: 1 }, { object: 'response.input_tokens', input_tokens: -1 },
    { object: 'response.input_tokens', input_tokens: 1.5 }, { object: 'response.input_tokens', input_tokens: '1' },
    { object: 'response.input_tokens', input_tokens: Number.MAX_SAFE_INTEGER + 1 }])
    assert.throws(() => readInputTokenCount(raw), { code: 'E_INPUT_TOKEN_COUNT' });
});

test('the OpenAI reservation covers counted input plus the unchanged complete output cap', () => {
  const { pack, request } = fixture();
  const result = reservationForRequest(pack, request, 2048)!;
  assert.equal(result.reservedUnits, 2048 + JSON.parse(request.body).max_output_tokens);
  assert.equal(result.limitUnits, 225000); assert.equal(result.pool.unit, 'tokens');
  assert.throws(() => reservationForRequest(pack, request, null), { code: 'E_INPUT_TOKEN_COUNT' });
  const plain = structuredClone(pack); delete plain.settings.usageLimits;
  assert.equal(reservationForRequest(plain, request, null), null, 'a frozen pack with no daily policy retains its behavior');
});

test('the confidence reservation prices the documented full request ceiling, without changing its payload', () => {
  const { pack } = fixture();
  const request = buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile,
    serializedDigest: JSON.stringify({ fullText: 'Synthetic content.', title: null, headings: [], tables: [] }) });
  const original = request.body, result = reservationForRequest(pack, request, null)!;
  const expected = (BigInt(pack.limits.confidenceAllQuestionTokens) * BigInt(pack.prices.interactive.confidence.inputNanodollarsPerMillion) + 999999n) / 1000000n;
  assert.equal(result.reservedUnits, Number(expected)); assert.equal(result.pool.unit, 'nanodollars');
  assert.equal(request.body, original);
});

function paidFixture() {
  const { pack } = fixture();
  pack.settings.usageLimits = { policy: 'daily-usage-v4', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
    openaiTokenPools: [{ id: 'paid', modelIds: [pack.pins.reader.id, pack.pins.recovery.id], limitNano: '48000000000' }],
    typesafeDailyNano: '1000000000', workersAiDailyNeurons: 9000, deepseekDailyNano: '500000000', anthropicDailyNano: '100000000000' };
  pack.prices.interactive.reader = { inputNanodollarsPerMillion: '2000000000', cachedInputNanodollarsPerMillion: '500000000',
    outputNanodollarsPerMillion: '10000000000', longContext: { aboveInputTokens: 100,
      inputMultiplier: { numerator: '2', denominator: '1' }, outputMultiplier: { numerator: '3', denominator: '2' } } };
  pack.prices.interactive.recovery = { inputNanodollarsPerMillion: '100000000', outputNanodollarsPerMillion: '500000000' };
  const reader = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: 'Synthetic source.',
    effort: pack.settings.readerEffort, maxOutputTokens: 10, contract: pack.settings.readerContract });
  const recovery = buildRecoveryRequest({ pin: pack.pins.recovery, text: 'Synthetic source.', effort: pack.settings.recoveryEffort, maxOutputTokens: 20 });
  return { pack, reader, recovery };
}

test('v4 shared monetary reservations use exact counted input, full request cap and each role\'s rates', () => {
  const { pack, reader, recovery } = paidFixture(), before = [reader.body, recovery.body];
  const read = reservationForRequest(pack, reader, 100)!, recover = reservationForRequest(pack, recovery, 100)!;
  assert.deepEqual(read.pool, { id: 'openai/paid', unit: 'nanodollars', modelIds: [pack.pins.reader.id, pack.pins.recovery.id] });
  assert.deepEqual(recover.pool, read.pool);
  assert.equal(read.limitUnits, 48000000000); assert.equal(recover.limitUnits, 48000000000);
  assert.equal(read.reservedUnits, 300000, '100 uncached input tokens at 2000 nanodollars plus all 10 output tokens at 10000');
  assert.equal(recover.reservedUnits, 20000, 'the recovery role has its own input/output prices and 20-token cap');
  assert.deepEqual([reader.body, recovery.body], before);
});

test('monetary bounds retain long-context multipliers and never reserve discounted cached input', () => {
  const { pack, reader } = paidFixture();
  assert.equal(reservationForRequest(pack, reader, 100)!.reservedUnits, 300000);
  assert.equal(reservationForRequest(pack, reader, 101)!.reservedUnits, 554000,
    'above the boundary: 101*4000 input plus 10*15000 output; cached-input discount is not a bound');
  const largerCap = { ...reader, body: JSON.stringify({ ...JSON.parse(reader.body), max_output_tokens: 20 }) };
  assert.equal(reservationForRequest(pack, largerCap, 101)!.reservedUnits, 704000);
  for (const count of [null, -1, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => reservationForRequest(pack, reader, count), { code: 'E_INPUT_TOKEN_COUNT' });
  const tooSmall = structuredClone(pack); tooSmall.settings.usageLimits!.openaiTokenPools[0] =
    { id: 'paid', modelIds: [pack.pins.reader.id, pack.pins.recovery.id], limitNano: '299999' };
  assert.throws(() => reservationForRequest(tooSmall, reader, 100), { code: 'E_DAILY_REQUEST_BOUND' });
});
