/** An empty folder must not freeze the collection before the person chooses documents. Synthetic mechanics only. */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import path from 'node:path';
import { openApp, startApp, REPO_ROOT } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('25-empty-folder-recovery', 'Empty collection recovery preserves later explicit and frozen selections', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi();
  fake.categories(['procedures', 'explainers']); fake.state.seed.settings.pilotSize = 2; fake.state.vendors = 'fake';
  const app = await startApp({ fake, cacheDir: path.join(REPO_ROOT, '.local', 'qa', 'empty-folder-vite-cache') }); defer(() => app.close());
  const session = await openApp(app, { hash: '#/new' }); defer(() => session.close());
  const { page, picker, watch } = session, root = opfsRoot('empty-folder-recovery');
  await writeFolder(page, root + '/empty', []);
  await writeFolder(page, root + '/one', corpus(1, { kinds: ['docx'] }));
  await writeFolder(page, root + '/many', corpus(4, { kinds: ['docx'] }));
  const active = selector => page.locator('[data-testid="stage"] ' + selector);
  const button = id => page.locator(`button[data-op="${id}"]`);
  const selection = id => page.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts'); return journeyDb.get('trials', id);
  }, id);
  const begin = async () => {
    const id = await page.evaluate(async () => {
      const { beginDraft } = await import('/persist/local-keys.ts'); return beginDraft(crypto.randomUUID(), null);
    });
    await page.goto(app.url(`#/new/${id}/files`)); await active('[data-testid="files"]').waitFor(); return id;
  };
  const choose = async (id, folder) => {
    picker.queue(folder); await button('files:choose-folder:' + id).click();
    await active('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 30_000 });
  };
  const confirm = async () => {
    await active('[data-testid="files-primary"] button').click();
    await active('[data-testid="confirm-summary"]').waitFor();
    await page.locator('#confirm-limit-blended').fill('5');
  };
  await active('[data-testid="files"]').waitFor();
  const id = await page.evaluate(() => location.hash.split('/')[2]);
  await choose(id, root + '/empty'); await active('[data-testid="files-empty"]').waitFor();
  check('an empty first folder does not persist a fixed empty collection', await selection(id) === null);
  await choose(id, root + '/one');
  await page.waitForFunction(() => document.querySelector('[data-testid="files-count"]')?.textContent.includes('of 1 read'));
  const recovered = await selection(id);
  check('the offered replacement folder initializes the actual one-document selection', recovered?.order.length === 1 && recovered?.selected.length === 1 && recovered?.role === 'ordinary', recovered);
  await confirm();
  check('the recovered document reaches an enabled Start with the explicit budget', !await button('confirm:start:' + id).isDisabled() &&
    await active('[data-testid="trial-selection-count"]').innerText() === '1 of 1 documents selected for this run.');
  await page.reload(); await active('[data-testid="confirm-summary"]').waitFor();
  check('recovered selection and enabled Start survive reload', !await button('confirm:start:' + id).isDisabled() &&
    JSON.stringify(await selection(id)) === JSON.stringify(recovered));
  evidence.recovered = await screenshot(page, '25-empty-then-valid-confirm');

  // The old release saved this empty default. A person re-choosing a folder must recover that stored draft too.
  const legacyId = await begin();
  await choose(legacyId, root + '/empty');
  await page.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    await journeyDb.put('trials', id, { version: 1, sourceLocalId: id, role: 'ordinary', campaignId: null,
      trialRunId: null, order: [], selected: [] });
  }, legacyId);
  await page.reload(); await button('files:choose-folder:' + legacyId).waitFor();
  await choose(legacyId, root + '/many');
  const legacyRecovered = await selection(legacyId);
  check('a stored empty default recovers with the configured trial size and complete collection',
    legacyRecovered?.role === 'pilot' && legacyRecovered.order.length === 4 && legacyRecovered.selected.length === 2, legacyRecovered);

  // A real current selection is never widened by rereading its source. Use the real public controller/store API.
  const chosenId = await begin(); await choose(chosenId, root + '/many'); await confirm();
  await active('[data-testid="trial-selection"] details summary').click();
  await page.locator('[data-trial-document]:checked').last().uncheck();
  await button('trial:save-selection:' + chosenId).click();
  await page.locator(`[data-feedback="trial:save-selection:${chosenId}"][data-state="done"]`).waitFor();
  const chosen = await selection(chosenId);
  const reread = async (id, change = null, frozen = false) => page.evaluate(async ({ id, source, change, frozen }) => {
    const { createAppStore } = await import('/state/app-store.ts');
    const { endpoints } = await import('/api/endpoints.ts');
    const { isLatest } = await import('/api/client.ts');
    const { documentVisibility } = await import('/state/poller.ts');
    const { LOCK_NAMES, lockState } = await import('/controllers/locks.ts');
    const { createRegistry } = await import('/controllers/registry.ts');
    const { registerControllers } = await import('/controllers/index.ts');
    const { writeServerRun } = await import('/persist/local-keys.ts');
    const store = createAppStore({ api: endpoints, isLatest, now: () => Date.now(), visibility: documentVisibility(),
      sendLock: run => lockState(LOCK_NAMES.send(run)), newId: () => crypto.randomUUID() }, { view: 'files', localId: id });
    const draft = store.draftStore(id);
    if (change) await draft.setTrial({ ...await draft.loadTrial(), ...change });
    if (frozen) writeServerRun(id, 'run-frozen-for-mechanics');
    let folder = await navigator.storage.getDirectory();
    for (const part of source.split('/')) folder = await folder.getDirectoryHandle(part);
    const registry = createRegistry(store); registerControllers(registry);
    return registry.extraction(id).readFolder(folder);
  }, { id, source: root + '/many', change, frozen });
  const repeated = await reread(chosenId);
  check('rereading preserves the explicitly chosen trial subset exactly', repeated.kind === 'read' &&
    JSON.stringify(await selection(chosenId)) === JSON.stringify(chosen) && chosen.selected.length === 1);
  await reread(chosenId, { selected: [] });
  const intentionalEmpty = await selection(chosenId);
  check('an intentionally empty subset of a nonempty collection is not reset', intentionalEmpty.order.length === 4 && intentionalEmpty.selected.length === 0 && intentionalEmpty.role === 'pilot');
  await reread(chosenId, { role: 'full', selected: chosen.order, campaignId: 'campaign-for-mechanics', trialRunId: 'trial-for-mechanics' });
  const full = await selection(chosenId);
  check('rereading preserves an explicit full-run campaign selection', full.role === 'full' && full.campaignId === 'campaign-for-mechanics' && full.selected.length === 4);
  const frozen = await reread(chosenId, null, true);
  check('a confirmed draft still refuses extraction and keeps its selection', frozen.kind === 'failed' && JSON.stringify(await selection(chosenId)) === JSON.stringify(full));
  check('reading, recovery and reload send no POST and create no cloud run', fake.requests.every(r => r.method === 'GET') && fake.state.runs.size === 0);
  check('no browser errors, external requests or fake contract drift', watch.record.pageErrors.length === 0 &&
    watch.record.consoleErrors.length === 0 && watch.record.external.length === 0 && fake.problems.length === 0,
    { browser: watch.summary(), problems: fake.problems });
  evidence.requests = fake.requests.map(r => ({ method: r.method, path: r.path, status: r.status }));
});
