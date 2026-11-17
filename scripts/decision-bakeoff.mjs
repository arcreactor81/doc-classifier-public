/**
 * Offline, decision-only preparation and scoring. No execute mode, network calls, credential reads or LLM endpoints.
 *
 * prepare --manifest <JSON> --output <NEW_DIRECTORY>
 * Manifest: {version:1, threshold:0.9, liquidBudgetUsd:2,
 *   groups:[{id,typeFilePath}], documents:[{opaqueId,group,textPath,outlinePath,expectedLabel:string|null,outlineSource?}],
 *   arms:[{id,model,contextPolicy?,representation?}]}
 * Paths are relative to the manifest. Arms explicitly select Jev 1.13 standard, Jev 1.14 standard/long, d1.1 or d1-ultra.
 *
 * score --prepared <DIRECTORY> --responses <JSON> --output <NEW_FILE>
 * Responses: {version:1,responses:[{armId,opaqueId,requestHash,status,rawPath}]}; paths relative to this JSON file.
 * One retained response per prepared request; duplicates are refused rather than choosing a favorable answer.
 */
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfidenceRequest, confidenceRequestParts, decodeConfidence } from '../core/vendors/requests.ts';
import { validateTypes } from '../core/config/project.ts';
import { validateConfidence } from '../core/vendors/validate.ts';
import { liquidConfidenceBody, liquidInputByteBound, LIQUID_CONFIDENCE_REPRESENTATION, LIQUID_NATIVE_CONFIDENCE_REPRESENTATION, LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION } from '../core/vendors/confidence-providers.ts';
import { authorizeRunBudget, readRunBudget } from '../core/cost/run-budget.ts';

const CONTRACT = 'decision-blind-full-text-outline-v1';
const SPENDING_POLICY = 'reported-usage-or-balance-stop-v1';
const UNLIMITED_POLICY = 'isolate-unlimited-v1';
const BUDGET = 2_000_000_000n;
const LIQUID_RATES = { 'd1.1': 20_000_000n, 'd1-ultra': 42_000_000n };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const encode = value => JSON.stringify(value, null, 2) + '\n';
const decodeText = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function json(bytes, kind) {
  try { return JSON.parse(decodeText(bytes).replace(/^\uFEFF/, '')); }
  catch { return fail(`Invalid UTF-8 JSON in ${kind}.`); }
}
function exact(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('Missing or unexpected fields.');
}
function unique(values, message) { if (new Set(values).size !== values.length) fail(message); }
function localPath(base, value) {
  // Reject UNC/device paths and every URL scheme before filesystem access, including file: and smb:.
  // A rooted drive path is local syntax; drive-relative forms such as C:file are not accepted.
  const unsafe = item => typeof item !== 'string' || !item || item.includes('\0') || /^[\\/]{2}/.test(item) ||
    /^[a-z][a-z0-9+.-]*:/i.test(item) && !/^[a-z]:[\\/]/i.test(item);
  if (unsafe(base) || unsafe(value)) fail('Explicit local filesystem paths are required; network paths and URLs are not accepted.');
  const resolved = path.resolve(base, value);
  if (unsafe(resolved)) fail('Explicit local filesystem paths are required; network paths and URLs are not accepted.');
  return resolved;
}
function armConfig(arm) {
  exact(arm, ['id', 'model'], ['contextPolicy', 'representation']);
  if (!identifier(arm.id)) fail('Invalid arm identifier.');
  if (arm.representation === undefined && (arm.model === 'jev-1.13.0' && arm.contextPolicy === 'standard-v1' ||
      arm.model === 'jev-1.14.0' && ['standard-v1', 'long-context-262k-v1'].includes(arm.contextPolicy)))
    return { ...arm, vendor: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone',
      representation: CONTRACT, pin: { id: arm.model, policy: 'versioned', date: '2026-11-04', reason: 'Explicit offline comparison arm.' } };
  if (Object.hasOwn(LIQUID_RATES, arm.model) && arm.contextPolicy === undefined &&
      (arm.representation === undefined || [LIQUID_CONFIDENCE_REPRESENTATION, LIQUID_NATIVE_CONFIDENCE_REPRESENTATION, LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION].includes(arm.representation)))
    return { ...arm, vendor: 'liquid', endpoint: 'https://api.liquid.ai/decisions/v1/systemone',
      representation: arm.representation ?? LIQUID_CONFIDENCE_REPRESENTATION, pin: { id: arm.model, policy: 'owner_approved_undated', date: '2026-11-04', reason: 'Explicit offline comparison arm.' } };
  return fail('Unsupported decision-only arm.');
}
async function loadManifest(manifestPath) {
  const bytes = await readFile(manifestPath), manifest = json(bytes, 'manifest'), base = path.dirname(path.resolve(manifestPath));
  const unlimited = manifest.version === 2;
  exact(manifest, unlimited
    ? ['version', 'threshold', 'budget', 'budgetActor', 'budgetTimestamp', 'unknownSpendPolicy', 'groups', 'documents', 'arms']
    : ['version', 'threshold', 'liquidBudgetUsd', 'groups', 'documents', 'arms']);
  if (![1, 2].includes(manifest.version) || typeof manifest.threshold !== 'number' || !Number.isFinite(manifest.threshold) ||
      manifest.threshold < 0 || manifest.threshold > 1) fail('Invalid manifest version or threshold.');
  let runBudget;
  if (unlimited) {
    runBudget = authorizeRunBudget(manifest.budget, manifest.budgetActor, manifest.budgetTimestamp);
    if (runBudget.mode !== 'unlimited' || manifest.unknownSpendPolicy !== UNLIMITED_POLICY)
      fail('Manifest v2 requires the explicit unlimited acknowledgement and isolating policy.');
  } else if (manifest.liquidBudgetUsd !== 2) fail('The authorized Liquid campaign budget is exactly USD 2.');
  for (const key of ['groups', 'documents', 'arms']) if (!Array.isArray(manifest[key]) || !manifest[key].length) fail('Manifest collections must be nonempty.');
  const arms = manifest.arms.map(armConfig);
  unique(arms.map(arm => arm.id), 'Duplicate arm identifier.');
  unique(arms.map(arm => `${arm.model}/${arm.contextPolicy ?? ''}/${arm.representation}`), 'Duplicate model arm.');
  const groups = [];
  for (const group of manifest.groups) {
    exact(group, ['id', 'typeFilePath']);
    if (!identifier(group.id)) fail('Invalid group identifier.');
    const file = await readFile(localPath(base, group.typeFilePath)), typeFile = json(file, 'taxonomy');
    exact(typeFile, ['types', 'none_of_these']);
    if (validateTypes(typeFile).length) fail('Invalid taxonomy.');
    for (const type of typeFile.types) exact(type, ['id', 'name', 'what', 'not_for', 'examples']);
    exact(typeFile.none_of_these, ['name', 'what']);
    groups.push({ id: group.id, typeFile, typeFileSha256: sha(file), typeIds: typeFile.types.map(t => t.id) });
  }
  unique(groups.map(group => group.id), 'Duplicate group identifier.');
  for (const document of manifest.documents) {
    exact(document, ['opaqueId', 'group', 'textPath', 'outlinePath', 'expectedLabel'], ['outlineSource']);
    if (document.outlineSource !== undefined && !['native-extractor', 'verified-recovery'].includes(document.outlineSource))
      fail('Unknown outline source.');
    const group = groups.find(g => g.id === document.group);
    if (!identifier(document.opaqueId) || !group || document.expectedLabel !== null &&
        ![...group.typeIds, 'none_of_these'].includes(document.expectedLabel)) fail('Invalid document identity, group or reference label.');
    localPath(base, document.textPath); localPath(base, document.outlinePath);
  }
  unique(manifest.documents.map(document => document.opaqueId), 'Duplicate document identifier.');
  return { manifest, manifestSha256: sha(bytes), base, groups, arms, runBudget };
}

/** Metadata titles and source heading identifiers are discarded, never copied into the blinded request state. */
async function blindedDocument(base, document) {
  const [textBytes, outlineBytes] = await Promise.all([
    readFile(localPath(base, document.textPath)), readFile(localPath(base, document.outlinePath))
  ]);
  let fullText; try { fullText = decodeText(textBytes); } catch { fail('Invalid UTF-8 source text.'); }
  if (!fullText) fail('Empty source text.');
  const outline = json(outlineBytes, 'outline');
  exact(outline, ['headings', 'tables', 'blocks'], ['title']);
  if (![outline.headings, outline.tables, outline.blocks].every(Array.isArray)) fail('Invalid outline arrays.');
  const position = n => Number.isSafeInteger(n) && n >= 0 && n <= fullText.length;
  const verbatim = value => typeof value === 'string' && value.length > 0 && fullText.includes(value);
  // PDF bookmarks and native table labels need not be literal body substrings. Only recovered headings carry that SOP check.
  // Omission preserves the earlier preparation contract; it never silently assumes native provenance.
  const outlineSource = document.outlineSource ?? 'legacy-verbatim-v1';
  const headings = outline.headings.map((heading, index) => {
    exact(heading, ['id', 'text', 'position', 'level']);
    if (typeof heading.text !== 'string' || !heading.text.length || !position(heading.position) ||
        !Number.isSafeInteger(heading.level) || heading.level < 1) fail('Invalid outline heading text, position or level.');
    if (outlineSource !== 'native-extractor' && !verbatim(heading.text)) fail('Recovered or legacy outline headings must be verbatim source text.');
    return { id: `h${String(index + 1).padStart(6, '0')}`, text: heading.text, level: heading.level, position: heading.position };
  });
  const tables = outline.tables.map(table => {
    exact(table, ['position', 'headers']);
    if (!position(table.position) || !Array.isArray(table.headers) || !table.headers.every(value => typeof value === 'string'))
      fail('Invalid native table headers or position.');
    if (outlineSource === 'legacy-verbatim-v1' && !table.headers.every(value => value === '' || verbatim(value)))
      fail('Legacy table headers must be verbatim source text.');
    return { position: table.position, headers: [...table.headers] };
  });
  return { state: { fullText, title: null, headings, tables }, textSha256: sha(textBytes), outlineSha256: sha(outlineBytes) };
}
function requestFor(arm, typeFile, state) {
  const serializedDigest = JSON.stringify(state);
  let payload;
  if (arm.vendor === 'typesafe') payload = JSON.parse(buildConfidenceRequest({ pin: arm.pin, typeFile, serializedDigest, contextPolicy: arm.contextPolicy }).body);
  else {
    const parts = confidenceRequestParts({ pin: arm.pin, typeFile, serializedDigest });
    payload = liquidConfidenceBody(arm.model, parts.state, parts.questions, arm.representation);
  }
  const headers = arm.contextPolicy === 'long-context-262k-v1' ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {};
  const contractVersion = `${CONTRACT}/${arm.representation}`;
  const body = JSON.stringify(payload), bodySha256 = sha(body);
  const requestHash = sha(JSON.stringify({ contractVersion, headers, body }));
  const byteBound = arm.vendor === 'liquid' ? liquidInputByteBound(body, arm.representation) : null;
  const reservationNano = byteBound === null ? null : ((BigInt(byteBound) * LIQUID_RATES[arm.model] + 999_999n) / 1_000_000n).toString();
  return { payload, headers, contractVersion, bodySha256, requestHash, byteBound, reservationNano };
}

export async function prepareDecisionBakeoff(manifestPath, outputDirectory) {
  manifestPath = localPath(process.cwd(), manifestPath);
  outputDirectory = localPath(process.cwd(), outputDirectory);
  const input = await loadManifest(manifestPath), documents = [...input.manifest.documents].sort((a, b) => a.opaqueId.localeCompare(b.opaqueId));
  const requests = [], sources = [];
  const groupTexts = new Set();
  let liquidTotal = 0n;
  for (const document of documents) {
    const source = await blindedDocument(input.base, document), group = input.groups.find(g => g.id === document.group);
    const fullTextSha256 = sha(source.state.fullText), groupText = `${document.group}/${fullTextSha256}`;
    if (groupTexts.has(groupText)) fail('Duplicate full text within a group. Sources are not silently dropped.');
    groupTexts.add(groupText);
    sources.push({ opaqueId: document.opaqueId, group: document.group, textSha256: source.textSha256,
      fullTextSha256, outlineSha256: source.outlineSha256, outlineSource: document.outlineSource ?? 'legacy-verbatim-v1' });
    for (const arm of input.arms) {
      const request = requestFor(arm, group.typeFile, source.state);
      if (request.reservationNano !== null) liquidTotal += BigInt(request.reservationNano);
      requests.push({ armId: arm.id, opaqueId: document.opaqueId, group: document.group, requestHash: request.requestHash,
        bodySha256: request.bodySha256, contractVersion: request.contractVersion, reservationNano: request.reservationNano });
    }
  }
  // Owner direction, 4 November: the byte reservation is informational, never a selection or admission gate.
  const budgetBlocked = false;
  for (const request of requests) request.scheduled = true;
  // Exclusive creation: no existing artifact is overwritten, even for a preparation that previously stopped midway.
  try { await mkdir(outputDirectory); } catch (error) { if (error.code === 'EEXIST') fail('Output directory already exists.'); throw error; }
  await mkdir(path.join(outputDirectory, 'requests'));
  const handles = new Map();
  try {
    for (const arm of input.arms) handles.set(arm.id, await open(path.join(outputDirectory, 'requests', `${arm.id}.jsonl`), 'wx'));
    for (const document of documents) {
      const source = await blindedDocument(input.base, document), prior = sources.find(s => s.opaqueId === document.opaqueId);
      if (source.textSha256 !== prior.textSha256 || source.outlineSha256 !== prior.outlineSha256) fail('Source changed during preparation. Output is incomplete.');
      const group = input.groups.find(g => g.id === document.group);
      for (const arm of input.arms) {
        const request = requestFor(arm, group.typeFile, source.state), planned = requests.find(r => r.armId === arm.id && r.opaqueId === document.opaqueId);
        if (request.requestHash !== planned.requestHash) fail('Request changed during preparation. Output is incomplete.');
        // Only opaque identity outside the payload. No group name, reference label, path, filename or earlier result.
        await handles.get(arm.id).writeFile(JSON.stringify({ opaqueId: document.opaqueId, scheduled: planned.scheduled,
          requestHash: request.requestHash, bodySha256: request.bodySha256, contractVersion: request.contractVersion,
          headers: request.headers, payload: request.payload }) + '\n');
      }
    }
  } finally { await Promise.all([...handles.values()].map(handle => handle.close())); }
  const privateText = encode({ version: 1, documents: documents.map(({ opaqueId, group, expectedLabel }) => ({ opaqueId, group, expectedLabel })) });
  await writeFile(path.join(outputDirectory, 'private-scoring.json'), privateText, { flag: 'wx' });
  const unlimited = input.manifest.version === 2;
  const plan = { version: input.manifest.version, status: 'prepared', contractVersion: CONTRACT, inferenceCalls: 0,
    outlineValidationPolicy: 'declared-outline-source-v2',
    maxAttemptsPerRequest: 1,
    spendingPolicy: unlimited ? UNLIMITED_POLICY : SPENDING_POLICY, unknownCostAction: unlimited ? 'isolate-document' : 'pause', automaticRecharge: false,
    ...(unlimited ? { runBudget: input.runBudget, unknownSpendPolicy: UNLIMITED_POLICY } : {}),
    stopConditions: unlimited ? ['Provider balance or authentication rejection, model identity drift, kill switch or storage failure.',
      'A document failure or unknown charge is retained without retry; other documents may continue under the acknowledged unlimited policy.']
      : ['Reported aggregate Liquid usage cost reaches USD 2 across both Liquid arms.',
        'The provider reports exhausted balance with HTTP 402, or a verified provider balance is zero.'],
    threshold: input.manifest.threshold, manifestSha256: input.manifestSha256,
    privateScoringSha256: sha(privateText), groups: input.groups.map(({ id, typeFileSha256, typeIds }) => ({ id, typeFileSha256, typeIds })),
    documents: sources, arms: input.arms, requests, liquidBudgetNano: unlimited ? null : BUDGET.toString(), liquidReservationNano: liquidTotal.toString(), budgetBlocked,
    reservationMeaning: unlimited ? 'Informational UTF-8 estimate under each declared representation; never a document-size gate, token count or invoice cap.'
      : 'Informational repeated-state UTF-8 estimate only; non-gating, not reported tokens, actual spending or a guaranteed invoice cap.',
    budgetScope: unlimited ? 'One attempt per frozen request. Unlimited spending was explicitly acknowledged; each provider account remains separate.'
      : 'One attempt per frozen Liquid request across both Liquid models. No retries are authorized by this plan.',
    budgetAction: unlimited ? 'Keep every document. Isolate per-document failures and unknown charges without retry. Stop on provider balance/authentication, model drift, kill or storage failures. Never recharge automatically.'
      : 'Keep the entire frozen plan. A future executor must stop on reported usage or exhausted balance, pause unknown cost, and never recharge or retry automatically. No executor is implemented here.',
    blockedModels: [{ model: '@cf/cloudflare/clef', reason: 'Excluded pending proof that full input is not silently truncated.' },
      { model: '@cf/cloudflare/clef-flash', reason: 'Excluded pending proof that full input is not silently truncated.' }] };
  await writeFile(path.join(outputDirectory, 'plan.json'), encode(plan), { flag: 'wx' });
  return plan;
}

function decodeDecision(raw, arm, typeIds) {
  if (!object(raw) || !object(raw.usage) || !Number.isSafeInteger(raw.usage.input_tokens) || raw.usage.input_tokens < 0 ||
      !Number.isSafeInteger(raw.usage.output_tokens) || raw.usage.output_tokens < 0 || arm.vendor === 'liquid' && raw.usage.output_tokens !== 0)
    fail('Invalid retained usage.');
  if (arm.vendor === 'typesafe') return decodeConfidence(raw, arm.pin, typeIds);
  if (raw.model !== arm.model || !object(raw.answers)) fail('Invalid retained model or answers.');
  exact(raw.answers, ['classification', ...typeIds.map(id => `is_${id}`)]);
  const choice = raw.answers.classification;
  exact(choice, ['type', 'choice', 'probabilities', 'confidence']);
  if (choice.type !== 'choice') fail('Invalid retained Choice.');
  const nouls = Object.fromEntries(typeIds.map(id => {
    const answer = raw.answers[`is_${id}`]; exact(answer, ['type', 'noul']);
    if (answer.type !== 'noul') fail('Invalid retained Noul.');
    return [id, answer.noul];
  }));
  return validateConfidence({ model: raw.model, choice: choice.choice, probabilities: choice.probabilities, confidence: choice.confidence, nouls },
    { pin: arm.model, typeIds });
}
const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
function counts(rows) {
  return { scheduled: rows.length, valid: rows.filter(r => r.state === 'valid').length,
    missing: rows.filter(r => r.state === 'missing').length,
    refused: rows.filter(r => r.state === 'refused').length, invalid: rows.filter(r => r.state === 'invalid').length,
    unlabelled: rows.filter(r => r.expectedLabel === null).length };
}
function metrics(rows) {
  const valid = rows.filter(r => r.state === 'valid'), compared = valid.filter(r => r.expectedLabel !== null);
  const correct = compared.filter(r => r.correct).length, labelled = rows.filter(r => r.expectedLabel !== null).length;
  const candidates = compared.filter(r => r.candidate), errors = candidates.filter(r => !r.correct).length;
  return { ...counts(rows),
    choiceAccuracy: { correct, compared: compared.length, value: ratio(correct, compared.length) },
    thresholdCoverage: { candidates: candidates.length, labelledScheduled: labelled, value: ratio(candidates.length, labelled) },
    thresholdErrorRate: { errors, compared: candidates.length, value: ratio(errors, candidates.length) } };
}
function preparedMembership(plan, labels) {
  const bad = () => fail('Prepared artifact integrity failed.');
  if (!object(plan) || !object(labels) || labels.version !== 1 ||
      ![plan.arms, plan.groups, plan.documents, plan.requests, labels.documents].every(value => Array.isArray(value) && value.length > 0) ||
      typeof plan.threshold !== 'number' || !Number.isFinite(plan.threshold) || plan.threshold < 0 || plan.threshold > 1 ||
      plan.maxAttemptsPerRequest !== 1 || plan.budgetBlocked !== false || plan.automaticRecharge !== false) bad();
  if (plan.version === 2) {
    let budget; try { budget = readRunBudget(plan.runBudget); } catch { bad(); }
    if (budget.version !== 1 || budget.mode !== 'unlimited' || plan.liquidBudgetNano !== null ||
        plan.spendingPolicy !== UNLIMITED_POLICY || plan.unknownSpendPolicy !== UNLIMITED_POLICY || plan.unknownCostAction !== 'isolate-document') bad();
  } else if (plan.version !== 1 || plan.liquidBudgetNano !== BUDGET.toString() ||
      plan.spendingPolicy !== SPENDING_POLICY || plan.unknownCostAction !== 'pause') bad();
  const groups = new Map(), arms = new Map(), documents = new Map(), referenceIds = new Set(), pairs = new Set();
  for (const group of plan.groups) {
    if (!object(group) || !identifier(group.id) || groups.has(group.id) || !Array.isArray(group.typeIds) || !group.typeIds.length ||
        group.typeIds.some(id => typeof id !== 'string' || !id || id === 'none_of_these') || new Set(group.typeIds).size !== group.typeIds.length) bad();
    groups.set(group.id, group);
  }
  for (const arm of plan.arms) {
    if (!object(arm) || arms.has(arm.id)) bad();
    let expected;
    try { expected = armConfig({ id: arm.id, model: arm.model,
      ...(Object.hasOwn(arm, 'contextPolicy') ? { contextPolicy: arm.contextPolicy } : {}),
      ...(arm.vendor === 'liquid' ? { representation: arm.representation } : {}) }); } catch { bad(); }
    if (arm.vendor !== expected.vendor || arm.endpoint !== expected.endpoint || arm.representation !== expected.representation ||
        !object(arm.pin) || arm.pin.id !== expected.pin.id || arm.pin.policy !== expected.pin.policy) bad();
    arms.set(arm.id, arm);
  }
  for (const document of plan.documents) {
    if (!object(document) || !identifier(document.opaqueId) || !groups.has(document.group) || documents.has(document.opaqueId) ||
        document.outlineSource !== undefined && !['native-extractor', 'verified-recovery', 'legacy-verbatim-v1'].includes(document.outlineSource)) bad();
    documents.set(document.opaqueId, document);
  }
  if (labels.documents.length !== documents.size || plan.requests.length !== arms.size * documents.size) bad();
  for (const label of labels.documents) {
    const document = object(label) && documents.get(label.opaqueId);
    if (!document || label.group !== document.group || referenceIds.has(label.opaqueId) ||
        label.expectedLabel !== null && ![...groups.get(document.group).typeIds, 'none_of_these'].includes(label.expectedLabel)) bad();
    referenceIds.add(label.opaqueId);
  }
  for (const request of plan.requests) {
    const document = object(request) && documents.get(request.opaqueId), arm = object(request) && arms.get(request.armId);
    if (!document || !arm || request.group !== document.group ||
        request.scheduled !== true) bad();
    const pair = `${request.armId}/${request.opaqueId}`;
    if (pairs.has(pair)) bad();
    pairs.add(pair);
  }
}
export async function scoreDecisionBakeoff(preparedDirectory, responsesPath, outputPath) {
  preparedDirectory = localPath(process.cwd(), preparedDirectory);
  responsesPath = localPath(process.cwd(), responsesPath);
  outputPath = localPath(process.cwd(), outputPath);
  const planBytes = await readFile(path.join(preparedDirectory, 'plan.json')), plan = json(planBytes, 'prepared plan');
  const privateBytes = await readFile(path.join(preparedDirectory, 'private-scoring.json'));
  if (plan.status !== 'prepared' || ![1, 2].includes(plan.version) || sha(privateBytes) !== plan.privateScoringSha256) fail('Prepared artifact integrity failed.');
  const labels = json(privateBytes, 'private scoring file');
  preparedMembership(plan, labels);
  // Verify the payload files as well as their plan entries; an altered file cannot silently keep its old request hash.
  for (const arm of plan.arms) {
    if (!identifier(arm.id)) fail('Prepared artifact integrity failed.');
    const payloadFile = decodeText(await readFile(path.join(preparedDirectory, 'requests', `${arm.id}.jsonl`)));
    const entries = payloadFile.split('\n').filter(line => line.length > 0).map(line => json(Buffer.from(line), 'request file'));
    const expected = plan.requests.filter(r => r.armId === arm.id);
    if (entries.length !== expected.length) fail('Prepared request integrity failed.');
    unique(entries.map(entry => entry.opaqueId), 'Prepared request integrity failed.');
    for (const entry of entries) {
      exact(entry, ['opaqueId', 'scheduled', 'requestHash', 'bodySha256', 'contractVersion', 'headers', 'payload']);
      const recorded = expected.find(r => r.opaqueId === entry.opaqueId), body = JSON.stringify(entry.payload);
      const hash = sha(JSON.stringify({ contractVersion: entry.contractVersion, headers: entry.headers, body }));
      if (!recorded || entry.requestHash !== hash || recorded.requestHash !== hash ||
          entry.bodySha256 !== sha(body) || recorded.bodySha256 !== sha(body) ||
          recorded.scheduled !== entry.scheduled || recorded.contractVersion !== entry.contractVersion)
        fail('Prepared request integrity failed.');
    }
  }
  const sourceBytes = await readFile(responsesPath), source = json(sourceBytes, 'response manifest'), base = path.dirname(path.resolve(responsesPath));
  exact(source, ['version', 'responses']);
  if (source.version !== 1 || !Array.isArray(source.responses)) fail('Invalid response manifest.');
  const byPair = new Map();
  for (const row of source.responses) {
    exact(row, ['armId', 'opaqueId', 'requestHash', 'status', 'rawPath']);
    const key = `${row.armId}/${row.opaqueId}`, request = plan.requests.find(r => r.armId === row.armId && r.opaqueId === row.opaqueId);
    if (byPair.has(key)) fail('Response manifest has duplicate request entries.');
    if (!request || !request.scheduled || request.requestHash !== row.requestHash) fail('Response request hash or schedule mismatch.');
    if (!Number.isSafeInteger(row.status) || row.status < 100 || row.status > 599) fail('Invalid retained HTTP status.');
    localPath(base, row.rawPath);
    byPair.set(key, row);
  }
  const rows = [], rawHashes = [];
  for (const request of plan.requests.filter(r => r.scheduled)) {
    const label = labels.documents.find(d => d.opaqueId === request.opaqueId), arm = plan.arms.find(a => a.id === request.armId),
      group = plan.groups.find(g => g.id === request.group), response = byPair.get(`${request.armId}/${request.opaqueId}`);
    if (!label || !arm || !group) fail('Prepared artifact integrity failed.');
    const row = { armId: arm.id, group: group.id, opaqueId: request.opaqueId, expectedLabel: label.expectedLabel, state: 'missing' };
    if (response) {
      const bytes = await readFile(localPath(base, response.rawPath));
      rawHashes.push({ armId: arm.id, opaqueId: request.opaqueId, rawSha256: sha(bytes), status: response.status });
      if (response.status < 200 || response.status > 299) row.state = 'refused';
      else {
        try {
          const value = decodeDecision(json(bytes, 'retained response'), arm, group.typeIds);
          row.state = 'valid'; row.correct = value.choice === row.expectedLabel;
          row.candidate = value.choice !== 'none_of_these' && value.confidence >= plan.threshold && value.nouls[value.choice] >= 0.5;
        } catch { row.state = 'invalid'; }
      }
    }
    rows.push(row);
  }
  const report = { version: 1, kind: 'decision-only-score', inferenceCalls: 0, threshold: plan.threshold,
    definition: 'Threshold candidates require a named Choice, certainty at threshold and its independent Noul at least 0.5. No reader or product filing decision is present.',
    denominator: 'Choice accuracy uses valid labelled responses. Coverage uses all labelled scheduled requests, including missing, refused and invalid. Error rate uses labelled threshold candidates.',
    planSha256: sha(planBytes), responseManifestSha256: sha(sourceBytes), rawResponses: rawHashes,
    aggregation: 'Arm totals are operational counts only. Accuracy, threshold coverage and error rates are separate per group; no pooled ranking.',
    arms: plan.arms.map(arm => ({ armId: arm.id, model: arm.model, ...counts(rows.filter(r => r.armId === arm.id)),
      groups: plan.groups.map(group => ({ group: group.id, ...metrics(rows.filter(r => r.armId === arm.id && r.group === group.id)) })) })) };
  await writeFile(outputPath, encode(report), { flag: 'wx' });
  return report;
}

async function main(args) {
  if (args.length === 0 || args[0] === '--help') {
    console.log('Offline only: prepare --manifest FILE --output NEW_DIRECTORY | score --prepared DIRECTORY --responses FILE --output NEW_FILE. See the manifest and response schemas in scripts/decision-bakeoff.mjs. No execute mode.'); return;
  }
  const mode = args.shift(), options = {};
  while (args.length) { const key = args.shift(), value = args.shift(); if (!key?.startsWith('--') || !value || Object.hasOwn(options, key)) fail('Invalid command arguments.'); options[key] = value; }
  if (mode === 'prepare') {
    exact(options, ['--manifest', '--output']);
    const plan = await prepareDecisionBakeoff(options['--manifest'], options['--output']);
    console.log(JSON.stringify({ status: plan.status, documents: plan.documents.length, arms: plan.arms.length,
      liquidBudgetNano: plan.liquidBudgetNano, liquidReservationNano: plan.liquidReservationNano, budgetBlocked: plan.budgetBlocked, inferenceCalls: 0 }));
  } else if (mode === 'score') {
    exact(options, ['--prepared', '--responses', '--output']);
    const report = await scoreDecisionBakeoff(options['--prepared'], options['--responses'], options['--output']);
    console.log(JSON.stringify({ status: 'scored', arms: report.arms.length, inferenceCalls: 0 }));
  } else fail('Unsupported mode: this tool only prepares or scores offline.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(`Decision bake-off failed: ${error.message}`); process.exitCode = 1; });
