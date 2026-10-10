import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAKE_TOO_LARGE_BODY, FAKE_VENDOR_MARKER, bucketOf, createFakeVendorFetch, fakeOutcome, hashDocument, rateLimited, withFakeSecrets
} from './fake-vendors.ts';
// Every request is built by the real request builders from synthetic documents; the fixtures are plain modules.
import { buildConfidenceRequest, buildReaderRequest, buildRecoveryRequest, decodeConfidence, decodeReader, decodeRecovery } from './requests.ts';
import { buildConfidenceRequests, decodeConfidenceGroup, mergeConfidenceGroups, packQuestionBudget } from './confidence-grouping.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { decide } from '../domain/decision.ts';
import { actualUsageCost } from '../cost/cost.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { syntheticDocuments } from '../../scripts/fixtures/synthetic-docs.mjs';
import type { ProjectPack } from '../config/project.ts';
import { buildInputTokenCountRequest, readInputTokenCount } from './input-token-count.ts';
import { DEEPSEEK_MODELS_ENDPOINT, listedVersion } from './model-list.ts';

// The pretend vendors' bodies must pass the real decoders unchanged, and each bucket must land on the rule it was
// crafted for at the design threshold. The rate limit is a test option: on, it answers once per role with a real-shaped
// 429 (no usage); off (the default), no call is ever rate-limited.
const counts = [1, 4, 254];
const EVERY = 40;

test('pretend input counting is marked and does not consume the inference fault schedule or change its answer', async () => {
  const pack = syntheticPack(1) as ProjectPack;
  const request = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: 'Synthetic count input.', effort: 'low', maxOutputTokens: 1000 });
  const counted = buildInputTokenCountRequest(request), fetcher = createFakeVendorFetch({ rateLimitEveryNth: 1 });
  const count = await call(fetcher, counted);
  assert.equal(count.status, 200); assert.equal(count.headers.get('x-fake-vendor'), FAKE_VENDOR_MARKER);
  assert.ok(readInputTokenCount(JSON.parse(count.text)) > 0);
  assert.equal((await call(fetcher, request)).status, 429, 'counting must not consume the first inference failure');
  const afterCount = await call(fetcher, request), withoutCount = await call(createFakeVendorFetch(), request);
  assert.equal(afterCount.text, withoutCount.text, 'the original inference response remains byte-identical');
});

async function call(fetchLike: ReturnType<typeof createFakeVendorFetch>, request: { endpoint: string; body: string }, typeIds?: readonly string[]) {
  const response = await fetchLike(request.endpoint, { method: 'POST', body: request.body, headers: {} }, typeIds ? {confidenceTypeIds:typeIds} : undefined);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

for (const categories of counts) test(`bodies decode and land on the crafted rule at ${categories} categories`, async () => {
  const pack = syntheticPack(categories) as ProjectPack, typeIds = pack.typeFile.types.map(type => type.id);
  const fetchLike = createFakeVendorFetch({ rateLimitEveryNth: EVERY });
  const seen = new Set<string>();
  let rateLimits = 0;
  for (const document of syntheticDocuments(categories === 254 ? 60 : 300, { seed: 7 })) {
    const digest = buildConfidenceState(pack.settings.confidenceStatePolicy, document.fullText, document.outline, pack.structuralVocabulary);
    const confidenceRequest = buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile, serializedDigest: digest.serialized });
    const readerRequest = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: document.fullText, effort: 'low', maxOutputTokens: 1000 });
    const hash = hashDocument(document.fullText, typeIds), expected = fakeOutcome(hash, typeIds);
    const answers = [];
    for (const request of [confidenceRequest, readerRequest]) {
      let answer = await call(fetchLike, request);
      if (rateLimited(hash, EVERY)) {
        assert.equal(answer.status, 429); assert.equal(answer.headers.get('retry-after'), '1'); rateLimits++;
        // As a vendor sends it: an error and no usage at all, so the ledger records the charge as unknown.
        const body = JSON.parse(answer.text);
        assert.equal(Object.hasOwn(body, 'usage'), false); assert.equal(body.error.code, 'rate_limit_exceeded');
        assert.throws(() => actualUsageCost(body.usage, pack.prices.interactive[request.role], 'not_applicable'), { code: 'E_VENDOR_USAGE' });
        answer = await call(fetchLike, request);
      }
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get('x-fake-vendor'), FAKE_VENDOR_MARKER);
      assert.equal(answer.headers.get('x-request-id'), `fake-${hash.toString(16).padStart(8, '0')}`);
      answers.push(JSON.parse(answer.text));
    }
    const confidence = decodeConfidence(answers[0], pack.pins.confidence, typeIds);
    const reader = decodeReader(answers[1], pack.pins.reader, typeIds, document.fullText, undefined, pack.settings.readerEvidencePolicy);
    assert.equal(confidence.model, pack.pins.confidence.id); assert.equal(reader.model, pack.pins.reader.id);
    // Both roles are priced from the usage they state.
    assert.match(actualUsageCost(answers[0].usage, pack.prices.interactive.confidence, 'not_applicable'), /^\d+$/);
    assert.match(actualUsageCost(answers[1].usage, pack.prices.interactive.reader, 'disabled'), /^\d+$/);
    const decision = decide({
      notePolicy: pack.settings.decisionNotePolicy, confidenceStatePolicy: pack.settings.confidenceStatePolicy, typeIds,
      threshold: 0.9, failures: [], notes: [],
      confidence: { choice: confidence.choice, certainty: confidence.confidence, noul: confidence.nouls },
      readerYes: reader.verdicts.filter(verdict => verdict.is_type).map(verdict => verdict.type_id)
    });
    assert.equal(decision.ruleId, expected.bucket, `document ${document.index}`);
    assert.equal(bucketOf(hash, categories), expected.bucket);
    seen.add(decision.ruleId);
  }
  const rules = [...seen].sort();
  if (categories === 254) assert.ok(rules.every(rule => ['R1', 'R2', 'R3', 'R4', 'R5'].includes(rule)));
  else assert.deepEqual(rules, categories >= 2 ? ['R1', 'R2', 'R3', 'R4', 'R5'] : ['R1', 'R2', 'R4', 'R5']);
  assert.ok(rateLimits >= 1, 'at least one document hit the rate-limit schedule');
});

test('a compact reader request gets the compact answer, with the same types judged true as the exact answer', async () => {
  const fetchLike = createFakeVendorFetch();
  for (const categories of counts) {
    const pack = syntheticPack(categories) as ProjectPack, typeIds = pack.typeFile.types.map(type => type.id);
    for (const document of syntheticDocuments(40, { seed: 11 })) {
      const request = (contract: 'reader-exact-evidence-v2' | 'reader-compact-verdicts-v1') => buildReaderRequest({
        pin: pack.pins.reader, typeFile: pack.typeFile, text: document.fullText, effort: 'low', maxOutputTokens: 1000, contract });
      const [exact, compact] = await Promise.all([request('reader-exact-evidence-v2'), request('reader-compact-verdicts-v1')]
        .map(async built => JSON.parse((await call(fetchLike, built)).text)));
      const structured = JSON.parse(compact.output[0].content[0].text);
      assert.deepEqual(Object.keys(structured), ['judgements', 'positives', 'near_misses']);
      assert.deepEqual(structured.near_misses, []);
      const decoded = (raw: unknown, contract: 'reader-exact-evidence-v2' | 'reader-compact-verdicts-v1') => decodeReader(
        raw, pack.pins.reader, typeIds, document.fullText, undefined, pack.settings.readerEvidencePolicy, contract).verdicts;
      const yes = (verdicts: ReturnType<typeof decoded>) => verdicts.filter(verdict => verdict.is_type).map(verdict => [verdict.type_id, verdict.rationale]);
      const expected = fakeOutcome(hashDocument(document.fullText, typeIds), typeIds).readerYes;
      assert.deepEqual(yes(decoded(compact, 'reader-compact-verdicts-v1')), yes(decoded(exact, 'reader-exact-evidence-v2')));
      assert.deepEqual(yes(decoded(compact, 'reader-compact-verdicts-v1')).map(([id]) => id).sort(), [...expected].sort());
    }
  }
});

test('grouped confidence requests at 254 categories (ratio 4) merge to the single-request answer and the same rule', async () => {
  const pack = syntheticPack(254) as ProjectPack, typeIds = pack.typeFile.types.map(type => type.id), pin = pack.pins.confidence;
  const budget = packQuestionBudget(pack);
  assert.equal(budget.tokenBytesRatio, 4);
  const fetchLike = createFakeVendorFetch();
  const rules = new Set<string>();
  for (const document of syntheticDocuments(60, { seed: 13 })) {
    const serializedDigest = buildConfidenceState(pack.settings.confidenceStatePolicy, document.fullText, document.outline, pack.structuralVocabulary).serialized;
    const groups = buildConfidenceRequests({ pin, typeFile: pack.typeFile, serializedDigest, budget });
    assert.ok(groups.length >= 2, 'the 254-category questions need more than one request');
    const hash = hashDocument(document.fullText, typeIds), requestId = `fake-${hash.toString(16).padStart(8, '0')}`;
    // Every group of the document, sent in order, hashes from the full id list: one request id, no note.
    const answers = [];
    for (const group of groups) {
      const answer = await call(fetchLike, group.request, typeIds);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get('x-request-id'), requestId);
      assert.equal(answer.headers.get('x-fake-vendor-note'), null);
      answers.push(decodeConfidenceGroup(JSON.parse(answer.text), pin, group));
    }
    const merged = mergeConfidenceGroups(answers, { typeIds, requestCount: groups.length, pin: pin.id });
    const singleRequest = buildConfidenceRequest({ pin, typeFile: pack.typeFile, serializedDigest });
    const single = decodeConfidence(JSON.parse((await call(fetchLike, singleRequest)).text), pin, typeIds);
    assert.equal(merged.choice, single.choice); assert.deepEqual(merged.nouls, single.nouls);
    assert.deepEqual(merged, single);
    const readerRequest = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: document.fullText, effort: 'low', maxOutputTokens: 1000 });
    const reader = decodeReader(JSON.parse((await call(fetchLike, readerRequest)).text), pack.pins.reader, typeIds, document.fullText, undefined, pack.settings.readerEvidencePolicy);
    const readerYes = reader.verdicts.filter(verdict => verdict.is_type).map(verdict => verdict.type_id);
    const rule = (confidence: typeof merged) => decide({
      notePolicy: pack.settings.decisionNotePolicy, confidenceStatePolicy: pack.settings.confidenceStatePolicy, typeIds,
      threshold: 0.9, failures: [], notes: [],
      confidence: { choice: confidence.choice, certainty: confidence.confidence, noul: confidence.nouls }, readerYes
    }).ruleId;
    assert.equal(rule(merged), rule(single), `document ${document.index}`);
    assert.equal(rule(merged), fakeOutcome(hash, typeIds).bucket, `document ${document.index}`);
    rules.add(rule(merged));
  }
  assert.deepEqual([...rules].sort(), ['R1', 'R2', 'R3', 'R4', 'R5']);
});

test('the default fake never rate-limits, whatever the hash', async () => {
  const pack = syntheticPack(3) as ProjectPack, typeIds = pack.typeFile.types.map(type => type.id), fetchLike = createFakeVendorFetch();
  let onSchedule = 0;
  for (const document of syntheticDocuments(200, { seed: 7 })) {
    const hash = hashDocument(document.fullText, typeIds);
    if (rateLimited(hash, EVERY)) onSchedule++;
    const request = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: document.fullText, effort: 'low', maxOutputTokens: 1000 });
    assert.equal((await call(fetchLike, request)).status, 200);
  }
  assert.ok(onSchedule >= 1, 'the sample contains documents the schedule would have rate-limited');
  assert.equal(rateLimited(123, null), false); assert.equal(rateLimited(123, undefined), false);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => createFakeVendorFetch({ rateLimitEveryNth: bad }), { code: 'E_FAKE_OPTION' });
});

test('recovery answers with no headings, in the same envelope', async () => {
  const pack = syntheticPack(2) as ProjectPack, fetchLike = createFakeVendorFetch();
  const request = buildRecoveryRequest({ pin: pack.pins.recovery, text: 'A line\nAnother line', effort: 'low', maxOutputTokens: 100 });
  const answer = await call(fetchLike, request);
  assert.equal(answer.status, 200);
  assert.deepEqual(decodeRecovery(JSON.parse(answer.text), pack.pins.recovery), { model: pack.pins.recovery.id, headings: [] });
});

test('the same document hashes the same from both request bodies and the proportions hold over a large sample', () => {
  const typeIds = ['type_001', 'type_002', 'type_003'];
  assert.equal(hashDocument('text', typeIds), hashDocument('text', [...typeIds]));
  assert.notEqual(hashDocument('text', typeIds), hashDocument('text ', typeIds));
  assert.notEqual(hashDocument('text', typeIds), hashDocument('text', typeIds.slice(0, 2)));
  const tally: Record<string, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0 };
  let limited = 0;
  for (let i = 0; i < 20000; i++) { const hash = hashDocument(`document ${i}`, typeIds); tally[bucketOf(hash, 3)]++; if (rateLimited(hash, EVERY)) limited++; }
  const share = (rule: string) => tally[rule] / 20000;
  assert.ok(Math.abs(share('R1') - 0.7) < 0.02 && Math.abs(share('R2') - 0.1) < 0.02 && Math.abs(share('R5') - 0.1) < 0.02);
  assert.ok(Math.abs(share('R3') - 0.05) < 0.02 && Math.abs(share('R4') - 0.05) < 0.02);
  assert.ok(Math.abs(limited / 20000 - 1 / EVERY) < 0.01);
  // One category: the R3 slice becomes R5 and nothing else moves.
  for (let i = 0; i < 500; i++) { const hash = hashDocument(`document ${i}`, ['only']); const one = bucketOf(hash, 1), three = bucketOf(hash, 3); assert.equal(one, three === 'R3' ? 'R5' : three); }
});

test('any other URL, a missing body or a wrong endpoint shape is refused loudly', async () => {
  const fetchLike = createFakeVendorFetch();
  await assert.rejects(() => fetchLike('https://example.invalid/anything', { body: '{}' }), { code: 'E_FAKE_OUTBOUND' });
  await assert.rejects(() => fetchLike('https://api.typesafe.ai/v1/systemone'), { code: 'E_FAKE_REQUEST' });
  await assert.rejects(() => fetchLike('https://api.openai.com/v1/responses', { body: '{"model":"x"}' }), { code: 'E_FAKE_REQUEST' });
  await assert.rejects(() => fetchLike(new URL('https://api.typesafe.ai/v1/systemone'), { body: 'not json' }), { code: 'E_FAKE_REQUEST' });
});

test('the malformed option answers one role with a body that is not JSON, at status 200', async () => {
  const pack = syntheticPack(2) as ProjectPack, fetchLike = createFakeVendorFetch({ malformedRole: 'reader' });
  const reader = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: 'Some text', effort: 'low', maxOutputTokens: 1000 });
  const answer = await call(fetchLike, reader);
  assert.equal(answer.status, 200); assert.throws(() => JSON.parse(answer.text));
  assert.equal(answer.headers.get('x-fake-vendor'), FAKE_VENDOR_MARKER);
});

// DECISIONS 152, evening addendum (owner, 9 October 2026): a document chosen by the size of its request is refused.
test('the refusal option answers one role with a 400 and no usage above a request size, every time; by default as TypeSafe refuses an oversized request', async () => {
  const pack = syntheticPack(2) as ProjectPack, typeIds = pack.typeFile.types.map(type => type.id);
  const confidenceOf = (text: string) => buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile,
    serializedDigest: buildConfidenceState(pack.settings.confidenceStatePolicy, text, { headings: [], tables: [], blocks: [] }, pack.structuralVocabulary).serialized });
  const short = confidenceOf('Synthetic short text.'), long = confidenceOf('Synthetic long text. '.repeat(400));
  const bound = new TextEncoder().encode(short.body).byteLength;
  const fetchLike = createFakeVendorFetch({ refusal: { role: 'confidence', aboveBytes: bound } });
  const body = JSON.parse(FAKE_TOO_LARGE_BODY);
  assert.equal(body.error_type, 'max_tokens_exceeded'); assert.equal(Object.hasOwn(body, 'usage'), false);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const answer = await call(fetchLike, long, typeIds);
    assert.equal(answer.status, 400, 'refused every time, not once'); assert.equal(answer.text, FAKE_TOO_LARGE_BODY);
    assert.equal(answer.headers.get('x-fake-vendor'), FAKE_VENDOR_MARKER); assert.equal(answer.headers.get('content-type'), 'application/json');
  }
  assert.equal((await call(fetchLike, short, typeIds)).status, 200, 'a request exactly at the bound is answered');
  const reader = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: 'Synthetic long text. '.repeat(400), effort: 'low', maxOutputTokens: 1000 });
  assert.equal((await call(fetchLike, reader)).status, 200, 'another role is answered');
  // A chosen body for another role, so a test can send a 400 that only resembles the refusal.
  const other = createFakeVendorFetch({ refusal: { role: 'reader', aboveBytes: 0, body: '{"error_type":"other"}' } });
  const refused = await call(other, reader);
  assert.deepEqual([refused.status, refused.text], [400, '{"error_type":"other"}']);
  assert.equal((await call(other, long, typeIds)).status, 200);
  for (const bad of [{ role: 'confidence', aboveBytes: -1 }, { role: 'confidence', aboveBytes: 1.5 }, { role: 'judge', aboveBytes: 1 }, { role: 'reader', aboveBytes: 1, body: 7 }])
    assert.throws(() => createFakeVendorFetch({ refusal: bad as never }), { code: 'E_FAKE_OPTION' });
});

test('DeepSeek\'s model list is answered as DeepSeek documents it, a failure only by option, and only to a GET', async () => {
  const listed = await createFakeVendorFetch()(DEEPSEEK_MODELS_ENDPOINT, { method: 'GET', headers: { authorization: 'Bearer fake-vendor-key' } });
  assert.equal(listed.status, 200); assert.equal(listed.headers.get('x-fake-vendor'), FAKE_VENDOR_MARKER);
  const text = await listed.text();
  assert.deepEqual(JSON.parse(text).data.map((entry: { id: string; object: string; owned_by: string }) => [entry.id, entry.object, entry.owned_by]),
    [['deepseek-flash', 'model', 'deepseek'], ['deepseek-v4-pro', 'model', 'deepseek']]);
  assert.deepEqual(listedVersion(200, text, 'deepseek-flash'), { name: 'DeepSeek-V4.1-Flash', reason: null });
  const failing = await createFakeVendorFetch({ modelListFailure: true })(DEEPSEEK_MODELS_ENDPOINT, { method: 'GET' });
  assert.equal(failing.status, 503);
  assert.deepEqual(listedVersion(failing.status, await failing.text(), 'deepseek-flash'), { name: null, reason: 'status' });
  await assert.rejects(() => createFakeVendorFetch()(DEEPSEEK_MODELS_ENDPOINT, { method: 'POST', body: '{}' }), { code: 'E_FAKE_REQUEST' });
  await assert.rejects(() => createFakeVendorFetch()(DEEPSEEK_MODELS_ENDPOINT + '/deepseek-flash', { method: 'GET' }), { code: 'E_FAKE_OUTBOUND' });
});

test('withFakeSecrets supplies both credentials and keeps every other binding', async () => {
  const env = withFakeSecrets({ DB: 'db', ASSETS: 'assets' });
  assert.equal(env.DB, 'db'); assert.equal(env.ASSETS, 'assets');
  assert.equal(await env.JEV_API_KEY.get(), 'fake-vendor-key'); assert.equal(await env.OPENAI_API_KEY.get(), 'fake-vendor-key');
});


test('review V4: grouped fake calls carry frozen category context across interleaving and fresh isolates',async()=>{
 const packs=[50,60].map(n=>syntheticPack(n,{settings:{confidenceQuestionPolicy:'confidence-grouped-nouls-v1'}}) as ProjectPack);
 const source='Synthetic concurrency probe 0';
 const state=buildConfidenceState(packs[0].settings.confidenceStatePolicy,source,{headings:[],tables:[],blocks:[]},[]).serialized;
 const groups=packs.map(pack=>buildConfidenceRequests({pin:pack.pins.confidence,typeFile:pack.typeFile,serializedDigest:state,budget:packQuestionBudget(pack)}));
 const ids=packs.map(pack=>pack.typeFile.types.map(t=>t.id));
 const fetchLike=createFakeVendorFetch();
 const send=async(fetcher:typeof fetchLike,group:typeof groups[0][0],typeIds:readonly string[])=>{
  const response=await fetcher(group.request.endpoint,{method:'POST',body:group.request.body},{confidenceTypeIds:typeIds});
  assert.equal(response.headers.get('x-fake-vendor-note'),null);
  return decodeConfidenceGroup(await response.json(),packs[0].pins.confidence,group);
 };
 const first=await send(fetchLike,groups[0][0],ids[0]);
 await send(fetchLike,groups[1][0],ids[1]);
 const second=await send(fetchLike,groups[0][1],ids[0]);
 const expected=fakeOutcome(hashDocument(source,ids[0]),ids[0]);
 const merged=mergeConfidenceGroups([first,second],{typeIds:ids[0],requestCount:2,pin:packs[0].pins.confidence.id});
 assert.deepEqual(merged.nouls,expected.nouls);
 const isolated=await import(new URL('./fake-vendors.ts?fresh-review-isolate',import.meta.url).href);
 const fresh=isolated.createFakeVendorFetch() as typeof fetchLike;
 assert.deepEqual(await send(fresh,groups[0][1],ids[0]),second,'a Noul-only request has the same answer in a fresh module');
 await assert.rejects(()=>fresh(groups[0][1].request.endpoint,{body:groups[0][1].request.body}),{code:'E_FAKE_REQUEST'});
 await assert.rejects(()=>send(fetchLike,groups[0][0],ids[1]),{code:'E_FAKE_REQUEST'},'Choice IDs and explicit context must agree');
});
