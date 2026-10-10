/** Incomplete local copies must name their problems without overwriting originals or existing output. */
import path from 'node:path';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { startApp, openApp, REPO_ROOT } from '../ui-harness/app.mjs';
import { writeFolder, readFile, moveFile, opfsRoot } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('26-incomplete-build', 'Missing originals and different destination files remain actionable through reload and explicit resume', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi(); fake.state.vendors = 'fake';
  const seed = fake.completed(), runId = seed.runId, record = fake.getRun(runId);
  record.resultsPageLimit = 2;
  const app = await startApp({ fake, cacheDir: path.join(REPO_ROOT, '.local', 'qa', 'incomplete-build-vite-cache') }); defer(() => app.close());
  const session = await openApp(app, { hash: `#/run/${runId}/build` }); defer(() => session.close());
  const { page, picker, watch } = session, root = opfsRoot('incomplete-build');
  const active = selector => page.locator('[data-testid="stage"] ' + selector);
  const op = id => page.locator(`button[data-op="${id}"]`);
  const local = () => page.evaluate(async id => (await import('/persist/journey-db.ts')).journeyDb.get('builds', id), runId);
  const until = async (fn, label) => {
    const end = Date.now() + 20_000;
    while (!await fn()) { if (Date.now() >= end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const docs = [...record.docs.values()];
  const [conflicting, missing] = docs.filter(doc => doc.decision.ruleId === 'R1');
  const copyPath = doc => `${doc.decision.destinationFolder}/${doc.tag}--${doc.originalFilename}`;
  const conflictingPath = copyPath(conflicting), missingPath = copyPath(missing);
  const missingFile = seed.files.find(file => file.fingerprint === missing.fingerprint);
  const originalFiles = seed.files.filter(file => file.fingerprint !== missing.fingerprint);
  const retainedText = 'An existing different local copy, retained by this test.';
  await writeFolder(page, root + '/originals', originalFiles);
  await writeFolder(page, root + '/copies', [{ name: conflictingPath, bytes: retainedText }]);
  const chooseFolders = async () => {
    await active('[data-testid="build"]').waitFor();
    picker.queue(root + '/originals'); await op('build:originals-choose:' + runId).click();
    await until(() => active('[data-testid="build-originals"]').getAttribute('data-state').then(s => s === 'chosen'), 'originals chosen');
    picker.queue(root + '/copies'); await op('build:output-choose:' + runId).click();
    await until(() => active('[data-testid="build-output"]').getAttribute('data-state').then(s => s === 'chosen'), 'copies chosen');
    await until(() => op('build:make:' + runId).isDisabled().then(v => !v), 'Make folders enabled');
  };
  const buildAttempt = async () => {
    await op('build:make:' + runId).click();
    await until(() => page.locator(`[data-feedback="build:make:${runId}"]`).getAttribute('data-state').then(s => s === 'done' || s === 'problem'), 'build settled');
  };
  const actualCopy = doc => readFile(page, root + '/copies/' + copyPath(doc), { base64: true });
  const expectedCopy = doc => Buffer.from(seed.files.find(file => file.fingerprint === doc.fingerprint).bytes).toString('base64');
  await chooseFolders(); await buildAttempt();
  const first = await local();
  check('the real builder records missing and conflicting files as an incomplete attempt', first.complete === false &&
    first.counts.copied === 3 && first.counts.not_found === 1 && first.counts.destination_conflict === 1, first);
  check('a different preexisting destination file is kept byte-for-byte', await readFile(page, root + '/copies/' + conflictingPath) === retainedText);
  const copied = docs.filter(doc => doc !== conflicting && doc !== missing), before = await Promise.all(copied.map(actualCopy));
  check('the other copies match their originals', before.every((bytes, i) => bytes === expectedCopy(copied[i])));
  check('incomplete feedback is a problem with an explicit ready/total count',
    await page.locator(`[data-feedback="build:make:${runId}"]`).getAttribute('data-state') === 'problem' &&
    /3 of 5 documents are ready/i.test(await active('[data-testid="build-primary"]').innerText()));
  const issueText = async status => {
    const rows = active(`[data-build-problem="${status}"]`); return await rows.count() ? rows.first().innerText() : '';
  };
  const conflictText = await issueText('destination_conflict'), missingText = await issueText('not_found');
  check('the conflict names the document and copies path, says it was kept, and gives a safe next step',
    conflictText.includes(conflicting.originalFilename) && conflictText.includes(conflictingPath) && /different file/i.test(conflictText) &&
    /kept unchanged/i.test(conflictText) && /empty folder|safe place/i.test(conflictText), conflictText);
  check('the missing original names the document and planned copies path with a recovery direction',
    missingText.includes(missing.originalFilename) && missingText.includes(missingPath) && /not found/i.test(missingText) &&
    /unchanged original/i.test(missingText), missingText);
  check('the next attempt remains an explicit available action', await op('build:make:' + runId).count() === 1 && !await op('build:make:' + runId).isDisabled());
  evidence.incomplete = await screenshot(page, '26-incomplete-build-problems');

  // A repeated explicit attempt cannot resolve either problem by itself, and must not rewrite the good copies.
  await buildAttempt(); const repeated = await local();
  check('an unchanged explicit retry preserves the good copies and still reports both problems', repeated.complete === false &&
    repeated.counts.copied === 0 && repeated.counts.already_present === 3 && repeated.counts.not_found === 1 &&
    repeated.counts.destination_conflict === 1 && (await Promise.all(copied.map(actualCopy))).every((bytes, i) => bytes === before[i]) &&
    await readFile(page, root + '/copies/' + conflictingPath) === retainedText, repeated);

  await page.reload(); await active('[data-testid="build"]').waitFor();
  await page.getByText(/Making the folders stopped before it finished/).first().waitFor();
  await until(async () => (await local())?.complete === false, 'saved incomplete record');
  const reloaded = active('[data-testid="build-incomplete"]');
  const reloadText = await reloaded.count() ? await reloaded.innerText() : '';
  check('reload displays the saved incomplete counts without inventing retained file details', /3 of 5 documents are ready/i.test(reloadText) &&
    /build summary/i.test(reloadText) && /file details.*not available/i.test(reloadText) &&
    await active('[data-build-problem]').count() === 0, reloadText);
  evidence.reloaded = await screenshot(page, '26-incomplete-build-reload');

  // The person resolves the problem: keep the conflicting copy elsewhere and make the unchanged missing original available.
  const keptPath = await moveFile(page, root + '/copies/' + conflictingPath, root + '/kept');
  await writeFolder(page, root + '/originals', [missingFile]);
  await chooseFolders(); await op('build:make:' + runId).click();
  await until(() => active('[data-testid="build-primary"] button').innerText().then(text => /Review the folders/i.test(text)), 'completed build offers review');
  const complete = await local();
  check('only explicit resume after resolution completes the two missing copies', complete.complete === true &&
    complete.counts.copied === 2 && complete.counts.already_present === 3 && complete.counts.not_found === 0 && complete.counts.destination_conflict === 0, complete);
  check('every final copy is exact and the preexisting conflicting file is still safely kept',
    (await Promise.all(docs.map(actualCopy))).every((bytes, i) => bytes === expectedCopy(docs[i])) && await readFile(page, keptPath) === retainedText);
  check('completion removes the incomplete report and offers the existing Review next step', await active('[data-testid="build-incomplete"]').count() === 0 &&
    /Made 5 copies/.test(await active('[data-testid="build-primary"]').innerText()));
  const originalsAfter = await Promise.all(seed.files.map(file => readFile(page, root + '/originals/' + file.name, { base64: true })));
  check('every unchanged original remains intact', originalsAfter.every((bytes, i) => bytes === Buffer.from(seed.files[i].bytes).toString('base64')));
  check('local builds and reloads send only GETs and leave the cloud run open', fake.requests.every(r => r.method === 'GET') && record.status === 'complete' && record.textHeld);
  check('no browser errors, external requests or wire-contract drift', watch.record.pageErrors.length === 0 &&
    watch.record.consoleErrors.length === 0 && watch.record.external.length === 0 && fake.problems.length === 0,
    { browser: watch.summary(), problems: fake.problems });
  evidence.finished = await screenshot(page, '26-incomplete-build-resumed');
});
