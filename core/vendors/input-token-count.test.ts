import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInputTokenCountRequest, readInputTokenCount, reservationForRequest } from './input-token-count.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { buildReaderRequest, buildConfidenceRequest } from './requests.ts';

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
