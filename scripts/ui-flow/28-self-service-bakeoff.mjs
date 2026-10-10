/** Synthetic browser mechanics only. This script makes no Cloudflare or model calls. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { startApp, openApp } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot, REPO_ROOT } from '../ui-harness/evidence.mjs';
import { applyBakeoffCandidate, bakeoffHash, createBakeoffPlan, assertBakeoffUpload } from '../../core/bakeoff/plan.ts';
import { compareBakeoff } from '../../core/bakeoff/comparison.ts';
import { failureResponse, ServerFailure } from '../../core/server/errors.ts';
import { FAKE_VENDORS_SENTENCE, runVendors } from '../../core/vendors/outbound.ts';

await runScript('28-self-service-bakeoff', 'Two independent confirmations, frozen inputs/settings and truthful comparison results', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi();
  fake.categories(['procedures', 'explainers']); fake.state.seed.settings.pilotSize = 2; fake.state.vendors = 'fake';
  const files = corpus(3), source = fake.completed({ files, outcomes: ['R1', 'R1', 'R1'] });
  const linked = fake.linkedRun(source, { either: [{ index: 1, labels: ['procedures', 'explainers'] }], leaveOut: [2] });
  const initialRuns = fake.state.runs.size, originalHandle = fake.handle.bind(fake), experiments = new Map(), observed = [];
  let build = 'synthetic-browser-build', losePlan = true, loseCreate = true;
  const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), value });
  const error = async (message, status = 409) => json(failureResponse(new ServerFailure('E_REQUEST', 'request', message, status)), status);
  const baseline = async () => {
    const pack = (await originalHandle({ method: 'GET', url: '/api/project' })).value;
    const value = { pack, threshold: pack.definitionThreshold, thresholdJustification: pack.definitionThresholdJustification,
      buildCommit: build, requestContractHash: 'a'.repeat(64) };
    return { baseline: value, baselineHash: await bakeoffHash(JSON.stringify(value)) };
  };
  const experimentView = entry => {
    const arms = Object.fromEntries(['baseline', 'candidate'].map(arm => {
      const quoteId = entry.quotes[arm]?.quoteId ?? null, run = [...fake.state.runs.values()].find(run => run.quoteId === quoteId);
      return [arm, { quoteId, runId: run?.id ?? null }];
    }));
    const inputs = Object.fromEntries(['baseline', 'candidate'].map(arm => {
      const run = fake.getRun(arms[arm].runId);
      return [arm, !run ? null : { runId: run.id, status: run.status, expectedCount: run.expectedCount,
        ...runVendors(run.notes),
        provenance: { id: entry.plan.id, arm, planHash: entry.plan.planHash, manifestHash: entry.plan.manifestHash },
        documents: [...run.docs.values()].map(doc => ({ fingerprint: doc.fingerprint,
          inputHash: entry.plan.documents.find(item => item.fingerprint === doc.fingerprint).uploadHash,
          rule: doc.decision?.ruleId ?? null, destinationFolder: doc.decision?.destinationFolder ?? null })),
        spend: { openai: String(run.spend.openai), typesafe: String(run.spend.typesafe), blended: String(run.spend.openai + run.spend.typesafe) },
        unknownCostAttempts: run.unaccountedCalls, pendingAccounting: run.pendingAccounting, durationMs: null }];
    }));
    return { plan: entry.plan, arms, comparison: compareBakeoff(entry.plan, fake.state.references.get(entry.plan.referenceId).entries, inputs) };
  };
  fake.handle = async request => {
    const url = new URL(request.url, 'http://fake.invalid');
    const bodyText = request.body ? new TextDecoder().decode(typeof request.body === 'string' ? new TextEncoder().encode(request.body) : request.body) : '';
    const raw = bodyText === '' ? null : JSON.parse(bodyText);
    observed.push({ method: request.method, path: url.pathname, body: raw });
    if (url.pathname === '/api/bakeoffs/baseline') return json(await baseline());
    if (url.pathname === '/api/bakeoffs' && request.method === 'POST') {
      let entry = experiments.get(raw.id);
      if (!entry) {
        const now = await baseline(); if (now.baselineHash !== raw.baselineHash) return error('The comparison baseline changed.');
        const reference = fake.state.references.get(raw.referenceId);
        entry = { plan: await createBakeoffPlan({ id: raw.id, actor: fake.state.actor, createdAt: new Date().toISOString(),
          referenceId: raw.referenceId, referenceDefinitionRevisionId: reference.definitionRevisionId,
          baseline: now.baseline, candidate: raw.candidate, documents: raw.documents }), quotes: {} };
        experiments.set(raw.id, entry);
      }
      if (losePlan) { losePlan = false; return error('The saved comparison reply was unavailable.', 503); }
      return json(experimentView(entry));
    }
    if (url.pathname.startsWith('/api/bakeoffs/')) return json(experimentView(experiments.get(url.pathname.split('/').at(-1))));
    if (url.pathname === '/api/quote' && raw?.bakeoff) {
      const entry = experiments.get(raw.bakeoff.id), arm = raw.bakeoff.arm;
      if ((await baseline()).baselineHash !== entry.plan.baselineHash) return error('The comparison baseline changed.');
      if (entry.quotes[arm]) return json(entry.quotes[arm]);
      const { bakeoff: _context, ...ordinary } = raw;
      const answer = await originalHandle({ ...request, body: JSON.stringify(ordinary) });
      if (answer.status >= 400) return answer;
      entry.quotes[arm] = { ...answer.value, bakeoff: { id: entry.plan.id, arm, planHash: entry.plan.planHash, manifestHash: entry.plan.manifestHash } };
      return json(entry.quotes[arm]);
    }
    const contextForQuote = quoteId => [...experiments.values()].flatMap(entry => ['baseline', 'candidate']
      .filter(arm => entry.quotes[arm]?.quoteId === quoteId).map(arm => ({ entry, arm })))[0];
    if (url.pathname === '/api/runs' && request.method === 'POST') {
      const context = contextForQuote(raw.quoteId), prior = [...fake.state.runs.values()].find(run => run.quoteId === raw.quoteId);
      if (context && !prior && (await baseline()).baselineHash !== context.entry.plan.baselineHash) return error('The comparison baseline changed.');
      const response = await originalHandle(request);
      if (response.status < 400 && context) {
        const run = fake.getRun(response.value.runId);
        run.pack = context.arm === 'baseline' ? structuredClone(context.entry.plan.baseline.pack)
          : applyBakeoffCandidate(context.entry.plan.baseline.pack, context.entry.plan.candidate);
        if (loseCreate) { loseCreate = false; return error('The creation reply was unavailable.', 503); }
      }
      return response;
    }
    if (/\/api\/runs\/[^/]+\/documents$/.test(url.pathname) && request.method === 'POST') {
      const run = fake.getRun(url.pathname.split('/')[3]), context = contextForQuote(run.quoteId);
      if (context) await assertBakeoffUpload(context.entry.plan.documents.find(item => item.fingerprint === raw.fingerprint), raw);
    }
    if (/\/api\/runs\/[^/]+\/start$/.test(url.pathname) && request.method === 'POST') {
      const run = fake.getRun(url.pathname.split('/')[3]), context = contextForQuote(run.quoteId);
      if (context && context.entry.plan.baseline.buildCommit !== build)
        return error('The processing build changed after this comparison was prepared.');
    }
    if (/\/api\/runs\/[^/]+\/plan$/.test(url.pathname) && request.method === 'GET') {
      const run = fake.getRun(url.pathname.split('/')[3]), context = contextForQuote(run.quoteId);
      const answer = await originalHandle(request);
      return context && answer.status < 400 ? json({ ...answer.value, bakeoff: context.entry.quotes[context.arm].bakeoff }) : answer;
    }
    return originalHandle(request);
  };
  const routed = fake.handle.bind(fake);
  fake.handle = async request => {
    try { return await routed(request); }
    catch (error) { (evidence.backendErrors ??= []).push(String(error?.stack ?? error)); throw error; }
  };
  // Keep every new browser/cache/temp file on E: in this worktree.
  const temporary = path.join(REPO_ROOT, '.local', 'tmp', 'bakeoff-browser'); mkdirSync(temporary, { recursive: true });
  process.env.TEMP = temporary; process.env.TMP = temporary;
  const app = await startApp({ fake, cacheDir: path.join(temporary, 'vite-cache') }); defer(() => app.close());
  const session = await openApp(app); defer(() => session.close());
  const { page, picker, watch } = session, folder = opfsRoot('bakeoff-source');
  defer(async () => { evidence.finalPage = { url: page.url(), text: await page.locator('body').innerText(), errors: watch.record.pageErrors, problems: fake.problems };
    evidence.lastScreenshot = await screenshot(page, '28-bakeoff-last-' + Date.now()); });
  const button = id => page.locator(`button[data-op="${id}"]`);
  const until = async (fn, label) => { const end = Date.now() + 20000; while (!fn()) {
    if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 25)); } };
  await writeFolder(page, folder, files); await page.goto(app.url('#/new')); await page.locator('[data-testid="files"]').waitFor();
  const sourceLocalId = await page.evaluate(() => location.hash.split('/')[2]);
  picker.queue(folder); await button(`files:choose-folder:${sourceLocalId}`).click();
  await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 30000 });
  await page.evaluate(async ({ runId, referenceId, revisionId, localId }) => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    await journeyDb.put('answers', runId, { marks: {}, folderLabels: {}, excludedAck: true,
      saved: { referenceId, revisionId, at: Date.now() }, updatedAt: Date.now() });
    const { openLocalRunStore } = await import('/persist/local-records.ts'), db = await openLocalRunStore();
    try { for (const record of await db.list(localId)) if (record.state === 'extracted') await db.put({ ...record, state: 'uploaded' }); }
    finally { db.close(); }
  }, { runId: source.runId, referenceId: linked.referenceId, revisionId: fake.state.active.revisionId, localId: sourceLocalId });
  await page.goto(app.url(`#/run/${source.runId}/compare`)); await button(`bakeoff:open:${source.runId}`).click();
  await page.locator('[data-testid="bakeoff-candidate"]').waitFor();
  check('there is no default candidate, local collection or document selection', await page.locator('[data-testid="bakeoff-candidate"]').inputValue() === '' &&
    await page.locator('[data-testid="bakeoff-source"]').inputValue() === '' && await button(`bakeoff:prepare:${source.runId}`).isDisabled());
  await page.locator('[data-testid="bakeoff-source"]').selectOption(sourceLocalId); await button(`bakeoff:source:${source.runId}`).click();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.locator('[data-testid="bakeoff-candidate"]').selectOption(JSON.stringify({ axis: 'readerEffort', value: 'medium' }));
  check('a selection above the configured trial size requires the explicit bypass choice', await button(`bakeoff:prepare:${source.runId}`).isDisabled());
  await page.getByLabel('Run this selection without a trial', { exact: true }).check();
  await button(`bakeoff:prepare:${source.runId}`).click();
  await page.locator('[data-experiment]').waitFor();
  const local = await page.evaluate(async referenceId => (await import('/persist/local-keys.ts')).listLocalBakeoffs(referenceId)[0], linked.referenceId);
  check('preparation creates no server experiment, quote, run or spending decision', experiments.size === 0 && fake.state.runs.size === initialRuns &&
    !observed.some(r => r.method === 'POST' && ['/api/bakeoffs', '/api/quote', '/api/runs'].includes(r.path)));
  const localState = await page.evaluate(async local => {
    const { listLocalRecords } = await import('/persist/local-records.ts');
    return { source: await listLocalRecords(local.sourceLocalId), baseline: await listLocalRecords(local.localIds.baseline), candidate: await listLocalRecords(local.localIds.candidate) };
  }, local);
  check('both separate drafts clone the same inputs without rewinding the uploaded source', local.localIds.baseline !== local.localIds.candidate &&
    localState.source.every(r => r.state === 'uploaded') && [...localState.baseline, ...localState.candidate].every(r => r.state === 'extracted'));
  // Simulate browser storage losing the entire arm. Recovery must be an explicit source reselection and action.
  await page.evaluate(async ({ localId, sourcePaths }) => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('document-classifier-local', 1);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    try { await new Promise((resolve, reject) => { const tx = db.transaction('documents', 'readwrite');
      for (const sourcePath of sourcePaths) tx.objectStore('documents').delete([localId, sourcePath]);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); }
    finally { db.close(); }
  }, { localId: local.localIds.candidate, sourcePaths: localState.candidate.map(record => record.sourcePath) });
  await button(`bakeoff:restore:${local.id}`).click();
  await page.locator(`[data-feedback="bakeoff:restore:${local.id}"][data-state="done"]`).waitFor();
  const restored = await page.evaluate(async id => (await import('/persist/local-records.ts')).listLocalRecords(id), local.localIds.candidate);
  check('explicit reselection restores every missing arm reading with its frozen payload and creates no run',
    JSON.stringify(restored) === JSON.stringify(localState.candidate) && fake.state.runs.size === initialRuns && experiments.size === 0);
  await page.locator('[data-testid="bakeoff-baseline"] a').click(); await page.locator('[data-testid="confirm-bakeoff"]').waitFor();
  check('baseline uses the ordinary empty spending confirmation and immutable selection', await page.locator('#confirm-limit-blended').inputValue() === '' &&
    await page.locator('[data-testid="trial-selection"]').count() === 0);
  await page.locator('#confirm-limit-blended').fill('1');
  // Same fingerprint/count/category, but changed reading notes after Confirm was displayed.
  await page.evaluate(async record => {
    const { openLocalRunStore } = await import('/persist/local-records.ts'), db = await openLocalRunStore();
    try { await db.put({ ...record, document: { ...record.document, notes: [...record.document.notes, 'N_EXTRACTION_EMBEDDED_UNREAD'] } }); }
    finally { db.close(); }
  }, localState.baseline[0]);
  await button(`confirm:start:${local.localIds.baseline}`).click();
  await page.locator(`[data-feedback="confirm:start:${local.localIds.baseline}"][data-state="problem"]`).waitFor();
  check('the confirmation lock rechecks every exact reading before any plan or quote is sent', experiments.size === 0 &&
    !observed.some(r => r.method === 'POST' && ['/api/bakeoffs', '/api/quote', '/api/runs'].includes(r.path)));
  // Restore only the synthetic test's tamper, then exercise ordinary explicit Start again.
  await page.evaluate(async record => { const { openLocalRunStore } = await import('/persist/local-records.ts'), db = await openLocalRunStore();
    try { await db.put(record); } finally { db.close(); } }, localState.baseline[0]);
  await button(`confirm:start:${local.localIds.baseline}`).click();
  await page.locator(`[data-feedback="confirm:start:${local.localIds.baseline}"][data-state="problem"]`).waitFor();
  check('an uncertain plan reply keeps the same local experiment identity and starts no run', experiments.size === 1 && fake.state.runs.size === initialRuns &&
    observed.filter(r => r.path === '/api/quote').length === 0);
  const hold = fake.hold({ method: 'POST', path: '/api/quote' }); defer(() => hold.release());
  await button(`confirm:start:${local.localIds.baseline}`).click(); await until(() => hold.waiting === 1, 'baseline quote held');
  const other = await session.context.newPage(); defer(() => other.close()); await other.goto(app.url('#/'));
  const refused = await other.evaluate(async localId => {
    const { createDraftStore } = await import('/state/draft-store.ts'), draft = createDraftStore(localId, { note() {}, linked() {} });
    const value = await draft.loadTrial(); try { await draft.setTrial({ ...value, selected: value.selected.slice(0, 1) }); return false; } catch { return true; }
  }, local.localIds.baseline);
  check('another tab cannot change the frozen selection while Start holds its lock', refused && await page.locator('#confirm-limit-blended').isDisabled());
  hold.release(); await button(`confirm:finish-starting:${local.localIds.baseline}`).waitFor();
  const intent = await page.evaluate(async id => (await import('/persist/local-keys.ts')).readConfirmIntent(id), local.localIds.baseline);
  check('uncertain run creation leaves only baseline created and candidate unstarted', fake.state.runs.size === initialRuns + 1 &&
    experimentView(experiments.get(local.id)).arms.candidate.runId === null && intent.runId === null);
  const beforeReload = observed.filter(r => r.method === 'POST').length; build = 'changed-build';
  await page.reload(); await button(`confirm:finish-starting:${local.localIds.baseline}`).waitFor();
  check('reload sends no POST and preserves the exact pending quote and budget', observed.filter(r => r.method === 'POST').length === beforeReload &&
    JSON.stringify(await page.evaluate(async id => (await import('/persist/local-keys.ts')).readConfirmIntent(id), local.localIds.baseline)) === JSON.stringify(intent));
  const beforeFinishProject = observed.filter(r => r.path === '/api/project').length;
  await button(`confirm:finish-starting:${local.localIds.baseline}`).click(); await page.waitForURL(url => url.hash.endsWith('/progress'));
  const baselineRun = experimentView(experiments.get(local.id)).arms.baseline.runId;
  await until(() => fake.getRun(baselineRun).docs.size === 3, 'baseline inputs uploaded');
  await button(`progress:continue-send:${baselineRun}`).waitFor();
  check('created baseline recovers after a build change using the same quote/budget and frozen inputs',
    fake.state.runs.size === initialRuns + 1 && observed.filter(r => r.path === '/api/quote').length === 1 &&
    observed.filter(r => r.path === '/api/project').length === beforeFinishProject && fake.getRun(baselineRun).budget.limits.blended === '1000000000');
  check('recovering the run identity after a build change does not authorize new dispatch',
    fake.getRun(baselineRun).status === 'uploading' && [...fake.getRun(baselineRun).docs.values()].every(document => document.workflowId === null));
  build = 'synthetic-browser-build';
  await button(`progress:continue-send:${baselineRun}`).click();
  await until(() => fake.getRun(baselineRun).status === 'running' &&
    [...fake.getRun(baselineRun).docs.values()].every(document => document.workflowId !== null), 'explicit baseline dispatch under its original build');
  build = 'changed-build';
  await page.goto(app.url(`#/new/${local.localIds.candidate}/confirm`)); await page.locator('[data-testid="confirm-bakeoff"]').waitFor();
  await page.locator('#confirm-limit-blended').fill('2');
  await page.waitForTimeout(250);
  check('an uncreated candidate refuses the changed baseline and does not refresh it', await button(`confirm:start:${local.localIds.candidate}`).isDisabled() &&
    experimentView(experiments.get(local.id)).arms.candidate.runId === null);
  build = 'synthetic-browser-build'; await page.reload(); await page.locator('[data-testid="confirm-summary"]').waitFor();
  check('candidate has its own explicit spending amount, not baseline’s amount', await page.locator('#confirm-limit-blended').inputValue() === '2');
  await button(`confirm:start:${local.localIds.candidate}`).click(); await page.waitForURL(url => url.hash.endsWith('/progress'));
  const candidateRun = experimentView(experiments.get(local.id)).arms.candidate.runId;
  await until(() => { const run = fake.getRun(candidateRun); return run.docs.size === 3 && run.status === 'running' &&
    [...run.docs.values()].every(document => document.workflowId !== null); }, 'candidate inputs uploaded and handed over');
  check('exactly two ordinary runs were separately confirmed with distinct quotes and budgets', fake.state.runs.size === initialRuns + 2 &&
    fake.getRun(candidateRun).quoteId !== fake.getRun(baselineRun).quoteId && fake.getRun(candidateRun).budget.limits.blended === '2000000000' &&
    fake.getRun(candidateRun).pack.settings.readerEffort === 'medium' && fake.getRun(baselineRun).pack.settings.readerEffort === 'low');
  fake.finish(baselineRun); fake.getRun(candidateRun).status = 'closed'; fake.getRun(candidateRun).textHeld = false;
  await page.goto(app.url(`#/run/${source.runId}/compare`)); await button(`bakeoff:refresh:${local.id}`).click();
  await page.locator('[data-testid="bakeoff-comparison"]').waitFor();
  check('a closed arm without outcomes cannot be presented as a complete comparison', await page.locator('[data-testid="bakeoff-comparison"]').getAttribute('data-complete') === 'false');
  fake.getRun(candidateRun).status = 'running'; fake.finish(candidateRun); fake.getRun(candidateRun).unaccountedCalls = 1; fake.getRun(candidateRun).pendingAccounting = 2;
  fake.state.vendors = 'live'; // Recorded run provenance must survive a change in today's service setting.
  await button(`bakeoff:refresh:${local.id}`).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="bakeoff-comparison"]')?.getAttribute('data-complete') === 'true');
  const comparisonText = await page.locator('[data-testid="bakeoff-comparison"]').innerText();
  check('classification completion and unresolved accounting are separate, with explicit denominators and exclusions',
    comparisonText.includes('Some charges are unresolved') && comparisonText.includes('Correct among scored automatic filings') &&
    comparisonText.includes('More than one acceptable category') && comparisonText.includes('Excluded by you'));
  check('recorded simulated arms retain the prominent warning and arm labels after the current service setting changes',
    comparisonText.includes(FAKE_VENDORS_SENTENCE) && await page.locator('[data-testid="bakeoff-baseline-simulated"]').isVisible() &&
      await page.locator('[data-testid="bakeoff-candidate-simulated"]').isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  evidence.mobile = await screenshot(page, '28-bakeoff-mobile-' + Date.now());
  check('comparison remains within a narrow viewport', await page.locator('[data-testid="bakeoff"]').evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
  check('no uncaught browser errors, real model requests or external requests', watch.record.pageErrors.length === 0 && watch.record.external.length === 0, watch.summary());
  evidence.experiment = { id: local.id, baselineRun, candidateRun }; evidence.requests = observed;
});
