/**
 * Script 41 — the no-limit acknowledgement on Confirm is not unticked by the first preparation (9 October 2026, the
 * hosted practice site, build 83a683a). A one-document journey through the real interface: fresh draft, read one file,
 * Confirm, tick "Run with no spending limit", tick "I understand this run has no spending limit…". About a second later
 * the second box was unticked again and the screen said only that the box had to be ticked, never what had changed.
 *
 * Cause: Confirm prepares the run when it opens. On a project that offers a reader menu that preparation writes the
 * default reader into the draft's saved selection (and, for a draft with no selection yet, the first selection) through
 * `DraftStore.setTrial`, and `setTrial` always cleared the acknowledgement. On the hosted site the preparation waits on
 * the network for about a second, so a tick made in that time was thrown away. Nothing the person had been shown had
 * changed: no preparation was on screen yet.
 *
 * This script holds the project read that the preparation waits on, ticks both boxes in that time, and then checks:
 * - the acknowledgement is still ticked when the first preparation finishes, Start run is offered, and no "something
 *   changed" sentence is shown (nothing changed); the same for a draft with no saved selection at all;
 * - the rule is kept: the person's own change of selection still clears it, and so does a real change found at Start,
 *   which says what changed (SPEC §4.7 step 3; CUI §16), after which it is ticked again and the run starts unlimited;
 * - the draft store's contract: a write that only fills in a default clears it only when a preparation was on show.
 * Evidence: .local/qa/ui-rebuild/41-no-limit-acknowledgement.json and 41-no-limit-acknowledgement-*.png.
 */
import { readFileSync } from 'node:fs';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp, viteVersion } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { confirmCopy } from '../../core/ui/copy-confirm.ts';
import { slotReady, until } from './05-loop.mjs';

const SCRIPT = '41-no-limit-acknowledgement';

await runScript(SCRIPT, 'The no-limit acknowledgement survives the first preparation; a real change still clears it and says what changed', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  // The owner pack offers a reader menu, as the hosted site does: its preparation writes the default reader.
  const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
  fake.state.seed = { ...owner, id: fake.state.seed.id, typeFile: fake.state.seed.typeFile, structuralVocabulary: [] };
  const app = await startApp({ fake });
  defer(() => app.close());
  const session = await openApp(app, { hash: '#/' });
  defer(() => session.close());
  const { page, picker, watch } = session;
  const root = opfsRoot('no-limit-ack');
  await writeFolder(page, root, corpus(1));
  evidence.app = { origin: app.origin, vite: viteVersion };

  const ack = page.locator('#confirm-ack'), noLimit = page.locator('#confirm-no-limit'), ackLabel = page.locator('[data-testid="confirm-ack"]');
  const changedSentence = page.getByText('Something changed since you reviewed this', { exact: false });
  const startReady = async () => slotReady(page, 'confirm-primary', /^Start run$/i, 5000).then(() => true, () => false);
  const savedSelection = id => page.evaluate(async key => { const { journeyDb } = await import('/persist/journey-db.ts'); return journeyDb.get('trials', key); }, id);

  /** A fresh draft with the one file read; Confirm opened while the project read its preparation waits on is held. */
  const confirmWithPreparationHeld = async ({ forgetSelection = false } = {}) => {
    await page.goto(app.url('#/new'));
    await page.waitForSelector('[data-testid="files"]');
    const localId = await page.evaluate(() => location.hash.split('/')[2]);
    picker.queue(root);
    await page.locator(`button[data-op="files:choose-folder:${localId}"]`).click();
    await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 60_000 });
    // A draft with no saved selection at all (the preparation then writes the first selection as well as the reader).
    if (forgetSelection) await page.evaluate(id => new Promise((resolve, reject) => {
      const open = indexedDB.open('document-classifier-journey');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('trials', 'readwrite');
        tx.objectStore('trials').delete(id);
        tx.oncomplete = () => { open.result.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
    }), localId);
    const hold = fake.hold({ method: 'GET', path: '/api/project' });
    defer(() => hold.release());
    await page.locator('[data-testid="files-primary"] button').click();
    await page.waitForSelector('[data-testid="confirm"]');
    await until(() => hold.waiting > 0, 'the preparation waiting for the project');
    return { localId, hold };
  };
  /** Both boxes ticked while the preparation waits, then the preparation allowed to finish. */
  const tickThenFinishPreparation = async hold => {
    await page.locator('[data-testid="confirm-more"] summary').first().click();
    await page.locator('[data-testid="confirm-no-limit"]').click();
    await ackLabel.click();
    const ticked = await noLimit.isChecked() && await ack.isChecked() && hold.waiting > 0;
    hold.release();
    await page.locator('[data-testid="confirm-summary"]').waitFor({ timeout: 20_000 });
    return ticked;
  };

  // --- A fresh draft: Confirm with its preparation held, both boxes ticked in that time -----------------------------
  const { localId, hold } = await confirmWithPreparationHeld();
  check('setup: the draft has its first selection but no reader chosen yet, so the preparation will write the default',
    (await savedSelection(localId))?.selectedReaderModel === undefined);
  check('setup: "Run with no spending limit" and the acknowledgement are both ticked while the preparation waits',
    await tickThenFinishPreparation(hold));
  await until(async () => (await savedSelection(localId))?.selectedReaderModel === 'standard', 'the default reader saved by the preparation');
  const afterFirst = { ack: await ack.isChecked(), noLimit: await noLimit.isChecked(), start: await startReady(), changedSentences: await changedSentence.count() };
  evidence.afterFirstPreparation = afterFirst;
  check('the acknowledgement is still ticked when the first preparation finishes', afterFirst.ack && afterFirst.noLimit, afterFirst);
  check('Start run is offered without ticking again', afterFirst.start, afterFirst);
  check('no "something changed" sentence is shown, because nothing the person was shown has changed', afterFirst.changedSentences === 0, afterFirst);
  evidence.afterFirstShot = await screenshot(page, SCRIPT + '-after-first-preparation');

  // --- The draft store's contract (this draft has not started; a second store reads the same saved selection) ----------
  const contract = await page.evaluate(async id => {
    const { createDraftStore } = await import('/state/draft-store.ts');
    const { journeyDb } = await import('/persist/journey-db.ts');
    const saved = await journeyDb.get('trials', id), draft = createDraftStore(id, { note() {}, linked() {} });
    const after = async (options, shown) => {
      draft.acknowledgeUnlimited.set(true);
      draft.prepared.set(shown ? { total: 1, failed: 0, shown: true } : null);
      await draft.setTrial(saved, options);
      return draft.acknowledgeUnlimited.peek();
    };
    return {
      choiceByPerson: await after(undefined, false),
      defaultNothingShown: await after({ fillsDefault: true }, false),
      defaultPreparationShown: await after({ fillsDefault: true }, true)
    };
  }, localId);
  evidence.draftStoreContract = contract;
  check('a selection written by the person clears the acknowledgement', contract.choiceByPerson === false, contract);
  check('a write that only fills in a default keeps it when no preparation was on show', contract.defaultNothingShown === true, contract);
  check('a write that fills in a default clears it when a preparation was on show: a real change is never kept', contract.defaultPreparationShown === false, contract);

  // --- The person changes the selection: the acknowledgement is cleared ------------------------------------------------
  if (!await ack.isChecked()) await ackLabel.click();
  const trialBox = page.locator('[data-testid="trial-selection"] input[type="checkbox"]:not([data-trial-document])').first();
  await trialBox.click();
  check('choosing a small trial (the person\'s own change of selection) clears the acknowledgement', !await ack.isChecked());
  await trialBox.click();
  await page.locator(`button[data-op="trial:save-selection:${localId}"]`).click();
  await page.locator('[data-testid="confirm-summary"]').waitFor({ timeout: 20_000 });
  check('after the person applies the selection the acknowledgement is still clear and Start run says why it is unavailable',
    !await ack.isChecked() && !await startReady());

  // --- A real change found at Start: cleared, and the screen says what changed ---------------------------------------
  await ackLabel.click();
  check('ticked again, Start run is offered', await ack.isChecked() && await startReady());
  fake.categories(['procedures', 'explainers', 'reports']);
  const quotesBefore = fake.requestsTo({ method: 'POST', path: '/api/quote' }).length;
  await (await slotReady(page, 'confirm-primary', /^Start run$/i)).click();
  const said = page.locator(`[data-feedback="confirm:start:${localId}"][data-state="problem"]`).filter({ hasText: confirmCopy.changedParts.categories });
  await said.waitFor({ timeout: 20_000 });
  const sentence = ((await said.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  evidence.changedAtStart = { sentence, ack: await ack.isChecked(), runs: fake.state.runs.size };
  check('a real change found at Start says what changed', sentence.includes(confirmCopy.changed([confirmCopy.changedParts.categories])), sentence);
  check('and clears the acknowledgement; nothing was sent', !await ack.isChecked() && fake.state.runs.size === 0 &&
    fake.requestsTo({ method: 'POST', path: '/api/quote' }).length === quotesBefore, evidence.changedAtStart);
  evidence.changedShot = await screenshot(page, SCRIPT + '-changed');

  // --- Ticked again, the run starts with no limit ---------------------------------------------------------------------
  await ackLabel.click();
  await (await slotReady(page, 'confirm-primary', /^Start run$/i)).click();
  await page.waitForURL(url => url.hash.endsWith('/progress'), { timeout: 30_000 });
  const run = [...fake.state.runs.values()][0];
  check('the run is created once, with no spending limit', fake.state.runs.size === 1 && run?.budget?.mode === 'unlimited', run?.budget);

  // --- A draft with no saved selection: the preparation writes the first selection too, and the tick is still kept -------
  const second = await confirmWithPreparationHeld({ forgetSelection: true });
  check('setup: the second draft has no saved selection when its preparation starts', await savedSelection(second.localId) === null);
  check('setup: both boxes ticked while that preparation waits', await tickThenFinishPreparation(second.hold));
  await until(async () => (await savedSelection(second.localId))?.selectedReaderModel === 'standard', 'the first selection and default reader saved');
  const afterSecond = { ack: await ack.isChecked(), start: await startReady(), changedSentences: await changedSentence.count() };
  evidence.afterSecondPreparation = afterSecond;
  check('with no saved selection the acknowledgement is also still ticked, Start run is offered, and nothing is said to have changed',
    afterSecond.ack && afterSecond.start && afterSecond.changedSentences === 0, afterSecond);

  check('no uncaught browser errors or external requests', watch.record.pageErrors.length === 0 && watch.record.external.length === 0, watch.summary());
  check('fake contracts remain valid', fake.problems.length === 0, fake.problems);
});
