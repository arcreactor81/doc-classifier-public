/**
 * Script 5 of SPEC §10.2 — the improvement loop (walkthrough 3c), driven through the real app against the fake API
 * in headless Edge (persistent profile: the app keeps folder handles in IndexedDB and reads them back).
 *
 * Setup: a complete run seeded in the fake (54 documents: 50 filed automatically, 3 for review, 1 could not be read),
 * so the saved review reaches the project's real minimumFiledCount (50) and a filing-certainty suggestion exists.
 * The originals go into OPFS; the person opens the run from Home, and Results → Make folders builds the copies.
 *
 * Then, as a person would: in "File Explorer" (OPFS, native move) one filed copy is moved into another category
 * folder and one review copy into a new folder; Review folders as cards (owner, 6 October 2026): read the folder →
 * the moved review copy shows as a move → answer the new folder → mark the moved filed document "Either folder is
 * right" → say Right to every other filed document (each folder then counts) → reload (same state) → Save my review
 * (exactly one POST …/corrections, with folderDecisions) → the optional Improve area: sentences, "Apply: 95%" →
 * provisional, never confirmed → Update the categories → editor → review → activate keeping the filing certainty →
 * Categories → edit → review → activate without keeping it → the area's answers: Save my answers (against the active
 * revision) → Run again and compare starts a new draft, with nothing sent.
 *
 * Throughout: at most one [data-primary] per view, focus on the h1 after navigation, no jargon outside Details,
 * every button's feedback slot beneath it, no write request without a click, nothing to any other origin.
 * Evidence: .local/qa/ui-rebuild/05-loop.json and 05-loop-*.png.
 *
 * Exports `builtRun()` (the seeded run built into OPFS folders through the real UI) for script 08.
 */
import { pathToFileURL } from 'node:url';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { launchEdgeProfile, startApp, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { installPicker, listFolder, moveFile, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { feedbackAdjacency, focusedElement, visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '05-loop';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `fn` until it returns something truthy; throws with `what` after `timeout` ms. */
export async function until(fn, what, timeout = 20_000, every = 100) {
  const started = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); } catch (error) { last = null; if (Date.now() - started > timeout) throw error; }
    if (last) return last;
    if (Date.now() - started > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(every);
  }
}

/** The action button inside an ActionSlot / block with this testid. */
export const slotButton = (page, testid) => page.locator(`[data-testid="${testid}"] button[data-op]`).first();
export const labelOf = async locator => ((await locator.textContent({ timeout: 2_000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();

/** Waits until the slot's button has a label matching `re` and is enabled; returns the locator. */
export async function slotReady(page, testid, re, timeout = 20_000) {
  const button = slotButton(page, testid);
  await until(async () => (await button.count()) > 0 && re.test(await labelOf(button)) && !(await button.isDisabled()),
    `[${testid}] button matching ${re} and enabled`, timeout);
  return button;
}

/** The text of the feedback slot of operation `op` (or of the slot inside the testid block). */
export const feedbackText = async (page, selector) =>
  ((await page.locator(selector).first().textContent({ timeout: 2_000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();

export const JARGON = /\b(git|json|manifests?|fingerprints?|thresholds?|probabilit(?:y|ies)|tokens?)\b|\bE_[A-Z0-9_]{2,}\b/gi;

/**
 * A complete run seeded in a fresh fake, opened from Home in a persistent Edge profile, and built into OPFS folders
 * through the real Results → Make folders screens. Returns everything a script needs to carry on from Review.
 * @param {{ outcomes?: any, viewport?: {width: number, height: number}, label?: string, defer: (fn: () => unknown) => void }} options
 */
export async function builtRun({ outcomes, viewport = { width: 1280, height: 900 }, label = 'loop', defer, fake: givenFake = null, seeded: givenSeeded = null }) {
  // A script may bring its own fake and seeded run (script 30 seeds a trial and its full run first).
  const fake = givenFake ?? createFakeApi();
  const seeded = givenSeeded ?? fake.completed(outcomes === undefined ? {} : { outcomes });
  const runId = seeded.runId;
  const app = await startApp({ fake });
  defer(() => app.close());
  const profile = await launchEdgeProfile({ viewport });
  defer(() => profile.close());
  const context = profile.context;
  const picker = await installPicker(context);
  const watch = watchContext(context, { origin: app.origin, root: app.root });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(app.url('#/'));
  await page.waitForSelector('[data-testid="home"]', { timeout: 60_000 });

  const root = opfsRoot(label);
  const originals = `${root}/Originals`, sorted = `${root}/Sorted`;
  await writeFolder(page, originals, seeded.files.map(file => ({ name: file.name, bytes: file.bytes })));

  // Home run cards are links: open the run, then Results → Make folders.
  const card = page.locator(`a[href="#/run/${runId}"]`).first();
  await card.waitFor({ timeout: 30_000 });
  await card.click();
  await page.waitForSelector('[data-testid="results"], [data-testid="build"]', { timeout: 30_000 });
  if (await page.locator('[data-testid="results"]').count()) {
    const make = await slotReady(page, 'results-primary', /folder/i);
    await make.click();
    await page.waitForSelector('[data-testid="build"]', { timeout: 30_000 });
  }
  picker.queue(originals);
  await page.locator('[data-testid="build-originals"] button[data-op^="build:originals-choose:"]').click();
  await until(async () => /Originals/.test(await labelOf(page.locator('[data-testid="build-originals"] .folder-pick__name'))),
    'the originals folder chosen');
  picker.queue(sorted, { create: true });
  await page.locator('[data-testid="build-output"] button[data-op^="build:output-choose:"]').click();
  await until(async () => /Sorted/.test(await labelOf(page.locator('[data-testid="build-output"] .folder-pick__name'))),
    'the copies folder chosen');
  const make = await slotReady(page, 'build-primary', /make folders/i, 30_000);
  await make.click();
  await slotReady(page, 'build-primary', /review/i, 120_000);
  const listing = await listFolder(page, sorted);

  const run = fake.getRun(runId);
  const docs = [...run.docs.values()].map(doc => ({
    fingerprint: doc.fingerprint, tag: doc.tag, name: doc.originalFilename, folder: doc.decision?.destinationFolder ?? null,
    rule: doc.decision?.ruleId ?? null, certainty: doc.confidence?.confidence ?? null
  }));
  /** The path (relative to `sorted`) of a document's copy: same folder, its own name, not a note beside it. */
  const copyOf = doc => {
    const ext = doc.name.slice(doc.name.lastIndexOf('.'));
    const stem = doc.name.slice(0, doc.name.lastIndexOf('.'));
    const inFolder = listing.filter(entry => entry.path.startsWith(`${doc.folder}/`) && entry.path.split('/').length === 2);
    return (inFolder.find(entry => entry.path === `${doc.folder}/${doc.name}`) ??
      inFolder.find(entry => entry.path.endsWith(ext) && entry.path.includes(stem)))?.path ?? null;
  };
  const typeIds = run.pack.typeFile.types.map(type => type.id);
  return { fake, app, profile, context, picker, watch, page, runId, root, originals, sorted, listing, docs, copyOf, typeIds, seeded };
}

/** Facts about the view on screen: h1, focus, primaries, jargon outside Details, the §5.3 slot contract. */
export async function viewFacts(page) {
  const h1 = ((await page.locator('#app h1').first().textContent({ timeout: 5_000 }).catch(() => null)) ?? '').trim();
  let focused = null;
  try {
    await until(async () => (await focusedElement(page))?.tag === 'h1', 'focus on the h1', 2_500);
  } catch { /* recorded below */ }
  focused = await focusedElement(page);
  const text = await visibleText(page, { root: '#app' });
  const jargon = [...new Set((text.match(JARGON) ?? []).map(word => word))];
  const jargonLines = text.split('\n').filter(line => new RegExp(JARGON.source, 'i').test(line)).slice(0, 8);
  const adjacency = await feedbackAdjacency(page);
  return {
    hash: new URL(page.url()).hash, h1, focusedTag: focused?.tag ?? null, focused,
    primaryCount: adjacency.primaryCount, jargon, jargonLines,
    slotProblems: adjacency.buttons.filter(button => button.visible && !button.ok).map(button => ({ id: button.id, label: button.label })),
    strayNotices: adjacency.strayNotices
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------------------------------------------

/** 50 filed (one at 91% that the person will move), 2 agreed-but-unsure, 1 unsure, 1 unreadable. */
export const LOOP_OUTCOMES = Object.freeze([
  'R1:procedures@0.91',
  ...Array(24).fill('R1:procedures@0.95'),
  ...Array(25).fill('R1:explainers@0.96'),
  'R2', 'R2', 'R5', 'unreadable'
]);
const NEW_FOLDER = 'Letters';

async function main() {
  await runScript(SCRIPT, 'SPEC §10.2 script 5 (the loop: review → improve → activate → compare)', async ({ checks, evidence, defer }) => {
    const { check } = checks;
    const ctx = await builtRun({ outcomes: LOOP_OUTCOMES, label: 'loop', defer });
    const { fake, app, page, picker, watch, runId, sorted, docs, copyOf, typeIds } = ctx;
    evidence.app = { origin: app.origin, vite: viteVersion, runId, typeIds, documents: docs.length };
    evidence.listingAfterBuild = ctx.listing.map(entry => entry.path);
    check('setup: the run was built into folders through Results → Make folders (54 document copies)',
      docs.every(doc => doc.rule === 'R0' || copyOf(doc) !== null), { missing: docs.filter(doc => doc.rule !== 'R0' && !copyOf(doc)).map(d => d.name) });

    const writes = () => fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
    /** API requests after sequence number `seq`, as `METHOD path status`. */
    const since = seq => fake.requests.filter(r => r.seq > seq).map(r => `${r.method} ${r.path} ${r.status}`);
    const allowed = new Set();
    const actions = [];
    /** Runs one person action and records the write requests it caused; `expected` lists `METHOD path-regex`. */
    const acting = async (label, expected, fn) => {
      const before = writes().length;
      const result = await fn();
      await sleep(400);
      const caused = writes().slice(before);
      for (const request of caused) allowed.add(request.seq);
      const got = caused.map(r => `${r.method} ${r.path}`);
      const ok = got.length === expected.length && expected.every((re, i) => re.test(got[i]));
      actions.push({ label, expected: expected.map(String), got, ok });
      return { result, caused, ok };
    };
    const views = [];
    const shoot = async name => screenshot(page, `${SCRIPT}-${name}`);
    const view = async (name, { navigated = true } = {}) => {
      const facts = await viewFacts(page);
      views.push({ name, navigated, ...facts, screenshot: await shoot(name) });
      return facts;
    };

    try {
    // ============================================================================================================
    // 1. The person's moves in File Explorer (OPFS native move): one filed copy to another category, one review
    //    copy into a folder they made.
    // ============================================================================================================
    const wrong =docs.find(doc => doc.rule === 'R1' && doc.certainty === 0.91);
    const unsure = docs.find(doc => doc.rule === 'R5');
    const [procedures, explainers] = typeIds;
    const wrongFrom = copyOf(wrong), unsureFrom = copyOf(unsure);
    const wrongTo = await moveFile(page, `${sorted}/${wrongFrom}`, `${sorted}/${explainers}`);
    const unsureTo = await moveFile(page, `${sorted}/${unsureFrom}`, `${sorted}/${NEW_FOLDER}`);
    evidence.moves = [{ doc: wrong.name, from: wrongFrom, to: wrongTo }, { doc: unsure.name, from: unsureFrom, to: unsureTo }];

    // ============================================================================================================
    // 2. Review folders: read the folder → the cards (needs you, then the spot-check)
    // ============================================================================================================
    await acting('open Review the folders (build slot)', [], async () => {
      await (await slotReady(page, 'build-primary', /review/i)).click();
      await page.waitForSelector('[data-testid="review"]', { timeout: 20_000 });
    });
    await until(async () => (await page.locator('[data-testid="review-definitions"] article').count()) === typeIds.length,
      'the definitions on Review', 20_000).catch(() => {});
    const reviewMove = await view('review-folder');
    const definitionsShown = await page.locator('[data-testid="review-definitions"] article').count();
    check('Review folders: the category definitions are on screen before the folder is read (one card per category)',
      definitionsShown === typeIds.length, { definitionsShown, typeIds });
    const firstPrimary = await labelOf(slotButton(page, 'review-primary'));
    const readBlocked = await slotButton(page, 'review-primary').isDisabled();
    check('Review folders starts at "Read my changes", which waits for the folder (reason beneath it)',
      /read my changes/i.test(firstPrimary) && readBlocked, { firstPrimary, readBlocked });

    // The folder of copies: a remembered offer is used if shown (a click), else the picker.
    const useAgain = page.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]');
    const offered = (await useAgain.count()) > 0 ? await labelOf(useAgain) : null;
    evidence.reviewFolderOffer = offered;
    check('Review offers the copies folder again ("Use \'Sorted\' again"), used only on a click', offered !== null && /Sorted/.test(offered), offered);
    await acting('choose the folder of copies', [], async () => {
      if (offered !== null) await useAgain.click();
      else {
        picker.queue(sorted);
        await page.locator('[data-testid="review-folder"] button[data-op^="review:folder-choose:"]').click();
      }
      await until(async () => /Sorted/.test(await labelOf(page.locator('[data-testid="review-folder"] .folder-pick__name'))), 'the review folder chosen');
    });

    await acting('Read my changes', [], async () => {
      await (await slotReady(page, 'review-primary', /read my changes/i)).click();
      await page.waitForSelector('[data-testid="review-cards"] [data-testid="review-card"]', { timeout: 60_000 });
      await until(async () => /save my review/i.test(await labelOf(slotButton(page, 'review-primary'))), 'Save my review', 20_000);
    });
    const readFeedback = await feedbackText(page, '[data-testid="review-primary"] [data-feedback]');
    const cardFacts = () => page.evaluate(() => {
      const card = document.querySelector('[data-testid="review-card"]');
      return card === null ? null : { fingerprint: card.dataset.fingerprint, queue: card.dataset.queue, state: card.dataset.state,
        position: document.querySelector('[data-testid="review-card-position"]')?.textContent.trim() ?? null,
        facts: (document.querySelector('[data-testid="review-card"] .card__facts')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        said: (document.querySelector('[data-testid="review-card-answer"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) };
    });
    const deck = page.locator('[data-testid="review-cards"]');
    const pressUntil = async (key, done, what, tries = 80) => {
      for (let i = 0; i < tries; i++) {
        if (await done()) return true;
        await page.keyboard.press(key);
        await sleep(120);
      }
      throw new Error(`gave up on ${what}`);
    };
    // Needs you: three documents came to the person; the one moved into the new folder shows as a move.
    const needsStrip = await labelOf(page.locator('[data-testid="review-queue-needs"]'));
    check('the Needs-you queue holds the three documents that came to the person, the moved one already answered', /1 of 3/.test(needsStrip), needsStrip);
    await deck.focus();
    // The deck opens on the first open card; ← reaches the first card, → then visits each one whatever its state.
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowLeft'); await sleep(120); }
    let unsureCard = null;
    await pressUntil('ArrowRight', async () => { const c = await cardFacts(); if (c?.fingerprint === unsure.fingerprint) unsureCard = c; return unsureCard !== null; }, 'the moved review document\'s card', 6);
    check('the review document moved into the new folder shows as a move to that folder, in the names the person sees ("Now in Letters")',
      unsureCard?.state === 'moved' && new RegExp(`Now in ${NEW_FOLDER}`).test(unsureCard.facts) && /You moved it to/.test(unsureCard.said), unsureCard);
    check('"Either folder is right" is not offered for the document moved from Needs review into a new folder (not two categories)',
      (await page.locator('[data-testid="review-card-either"]').count()) === 0);
    const newFolderRow = page.locator(`[data-testid="review-folder-${NEW_FOLDER}"]`);
    check('the new folder the person made is asked about: a new category, or ignore these files',
      (await newFolderRow.count()) === 1 && (await newFolderRow.locator('input[type="radio"]').count()) === 2,
      await labelOf(newFolderRow));
    const definitionsWhileChecking = await page.locator('[data-testid="review-definitions"] article').count();
    check('the definitions are still on screen with the cards', definitionsWhileChecking === typeIds.length, definitionsWhileChecking);
    await view('review-cards', { navigated: false });

    // The spot-check: the moved filed document shows as a move with "Either folder is right"; every other one is Right.
    await acting('answer the new folder, mark "Either folder is right", say Right to every other filed document', [], async () => {
      const radio = newFolderRow.locator('input[type="radio"]').first();
      await radio.check();
      await until(async () => radio.isChecked(), 'new folder answered', 5_000);
      await page.locator('[data-testid="review-queue-spot"]').click();
      await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 10_000 });
      await deck.focus();
    });
    const progress = () => labelOf(page.locator('[data-testid="review-spot-progress"]'));
    check('the spot-check progress starts at the moved document alone: "1 of 50 checked"', (await progress()) === '1 of 50 checked', await progress());
    await page.keyboard.press('ArrowLeft');
    await until(async () => (await cardFacts())?.fingerprint === wrong.fingerprint, 'the moved filed document\'s card', 5_000);
    const wrongCard = await cardFacts();
    const eitherBox = page.locator('[data-testid="review-card-either"] input[type="checkbox"]');
    const eitherLabel = await labelOf(page.locator('[data-testid="review-card-either"]'));
    check('the filed document moved between two categories shows as a move ("Procedures" → now in "Explainers") with "Either folder is right"',
      wrongCard?.state === 'moved' && /Filed in Procedures/.test(wrongCard.facts) && /Now in Explainers/.test(wrongCard.facts) &&
        (await eitherBox.count()) === 1 && /either folder is right/i.test(eitherLabel), { wrongCard, eitherLabel });
    await acting('mark "Either folder is right"', [], async () => {
      await eitherBox.check();
      await until(async () => eitherBox.isChecked(), 'either mark kept', 5_000);
    });
    await acting('Right for every other filed document (R, auto-advancing)', [], async () => {
      await page.keyboard.press('ArrowRight');
      await pressUntil('r', async () => (await page.locator('[data-testid="review-queue-done"][data-queue="spot"]').count()) > 0, 'the spot-check summary');
    });
    const spotDone = await labelOf(page.locator('[data-testid="review-queue-done"]'));
    await until(async () => (await progress()) === '50 of 50 checked', 'every folder counted', 10_000);
    check('with every filed document answered, both folders count: "50 of 50 checked" and the queue summary says so',
      /every filed document: 50/.test(spotDone) && (await progress()) === '50 of 50 checked', { spotDone, progress: await progress() });
    const saveReady = !(await slotButton(page, 'review-primary').isDisabled());
    check('with the new folder answered, Save my review is available', saveReady,
      await feedbackText(page, '[data-testid="review-primary"] [data-feedback]'));
    const localMarks = await page.evaluate(async fp => {
      const dbs = await indexedDB.databases();
      return { dbs: dbs.map(db => db.name), fp };
    }, wrong.fingerprint);
    evidence.localStores = localMarks;
    await view('review-spot-done', { navigated: false });

    // Reload mid-review: same place, same state, nothing sent.
    const writesBeforeReload = writes().length;
    const hashBefore = new URL(page.url()).hash;
    await page.reload();
    await page.waitForSelector('[data-testid="review-cards"]', { timeout: 30_000 }).catch(() => {});
    await sleep(1_000);
    await page.locator('[data-testid="review-queue-spot"]').click();
    await sleep(300);
    const afterReload = {
      hash: new URL(page.url()).hash,
      primary: await labelOf(slotButton(page, 'review-primary')),
      progress: await progress(),
      answered: await page.locator(`[data-testid="review-folder-${NEW_FOLDER}"] input[type="radio"]:checked`).count(),
      writes: writes().slice(writesBeforeReload).map(r => `${r.method} ${r.path}`)
    };
    evidence.reviewReload = { hashBefore, ...afterReload };
    check('reloading mid-review returns to the same place with the same answers (every folder still counted), the new-folder answer, and sends nothing',
      afterReload.hash === hashBefore && /save my review/i.test(afterReload.primary) && afterReload.progress === '50 of 50 checked' &&
        afterReload.answered === 1 && afterReload.writes.length === 0, evidence.reviewReload);

    // Save my review: one POST …/corrections, with folderDecisions in the first submission.
    const saved = await acting('Save my review', [/^POST \/api\/runs\/[^/]+\/corrections$/], async () => {
      await (await slotReady(page, 'review-primary', /save my review/i)).click();
      await until(async () => /improve your categories/i.test(await labelOf(slotButton(page, 'review-primary'))), 'the hand-over to the Improve area', 20_000);
    });
    const correctionPosts = fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections' });
    const body = correctionPosts[0]?.body ?? null;
    evidence.correctionBody = body && { checkedFolders: body.checkedFolders, folderDecisions: body.folderDecisions, files: body.files?.length,
      keys: Object.keys(body) };
    check('Save my review sends exactly one POST …/corrections', correctionPosts.length === 1 && saved.ok, saved.caused.map(r => r.path));
    check('the first (only) submission carries folderDecisions for the new folder (a new category)',
      Array.isArray(body?.folderDecisions) && body.folderDecisions.length === 1 && body.folderDecisions[0].folder === NEW_FOLDER &&
        body.folderDecisions[0].action === 'new_type', body?.folderDecisions);
    check('the submission holds paths and identities only, with every category folder ticked',
      Array.isArray(body?.files) && body.files.every(file => Object.keys(file).every(key => ['folder', 'filename', 'tag', 'fingerprint'].includes(key))) &&
        typeIds.every(id => body.checkedFolders?.includes(id) || !docs.some(doc => doc.folder === id)), evidence.correctionBody);
    const savedSlot = await feedbackText(page, '[data-testid="review-primary"] [data-feedback]');
    const savedNarration = await labelOf(page.locator('[data-testid="shell-narration-now"]'));
    evidence.reviewSaved = { slot: savedSlot, narrationAtTop: savedNarration, primary: await labelOf(slotButton(page, 'review-primary')) };
    check('"Your review is saved" appears beneath the action (its slot), which hands over to the optional Improve area',
      /saved/i.test(savedSlot) && /improve your categories/i.test(evidence.reviewSaved.primary), evidence.reviewSaved);
    await view('review-saved', { navigated: false });

    // ============================================================================================================
    // 3. The Improve area: sentences; Apply the proposed filing certainty → provisional, never confirmed
    // ============================================================================================================
    await acting('Improve your categories', [], async () => {
      await (await slotReady(page, 'review-primary', /improve your categories/i)).click();
      await page.waitForSelector('[data-testid="improve"]', { timeout: 20_000 });
      await page.waitForSelector('[data-testid="improve-sentences"] li', { timeout: 20_000 });
    });
    const improveFacts = await view('improve');
    const sentences = await page.locator('[data-testid="improve-sentences"] li').allTextContents();
    const raiseText = await labelOf(page.locator('[data-testid="improve-raise"]'));
    evidence.improve = { sentences, raiseText };
    check('Improve shows what the review found, in sentences (moved filing, new folder)',
      sentences.length >= 2 && sentences.some(s => /wrong folder|belonged/i.test(s)) && sentences.some(s => s.includes(NEW_FOLDER)), sentences);
    check('Improve explains the proposed filing certainty (95%) in plain words', /95%/.test(raiseText), raiseText);
    const apply = page.locator(`button[data-op="improve:apply:${runId}"]`);
    const applyLabel = (await apply.count()) ? await labelOf(apply) : null;
    check('an editor is offered "Apply: 95%" (a quiet action; nothing applied without the click)',
      applyLabel === 'Apply: 95%' && fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections/*/apply' }).length === 0, applyLabel);
    const healthReadsBefore = fake.requestsTo({ method: 'GET', path: '/api/health' }).length;
    const applied = await acting('Apply: 95%', [/^POST \/api\/runs\/[^/]+\/corrections\/[^/]+\/apply$/], async () => {
      await apply.click();
      await until(async () => (await feedbackText(page, `[data-feedback="improve:apply:${runId}"]`)).length > 0, 'the Apply feedback', 10_000);
    });
    const applyBody = fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections/*/apply' })[0]?.body ?? null;
    const applySlot = await feedbackText(page, `[data-feedback="improve:apply:${runId}"]`);
    const activeAfterApply = { ...fake.state.active };
    evidence.apply = { body: applyBody, slot: applySlot, active: activeAfterApply, response: fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections/*/apply' })[0]?.response };
    check('Apply sends one POST …/apply with the stored proposal {direction: raise, threshold: 0.95}',
      applied.ok && applyBody?.direction === 'raise' && applyBody?.threshold === 0.95, applyBody);
    check('after one review the filing certainty is provisional on the server, never calibrated',
      activeAfterApply.threshold === 0.95 && activeAfterApply.status === 'provisional', activeAfterApply);
    check('beneath Apply: the new certainty and that it stays provisional (the word for calibrated, "confirmed", is not used)',
      /95%/.test(applySlot) && /provisional/i.test(applySlot) && !/confirmed|calibrated/i.test(applySlot), applySlot);
    check('SPEC §3c.6: beneath Apply, the caution that changing what the categories mean resets filing to 90% unless kept',
      /90%/.test(applySlot), applySlot);
    const healthReadsAfter = fake.requestsTo({ method: 'GET', path: '/api/health' }).length;
    check('SPEC §3c.6: Health is read again after Apply (so the setup and filing chip are current)', healthReadsAfter > healthReadsBefore,
      { before: healthReadsBefore, after: healthReadsAfter });
    await view('improve-applied', { navigated: false });

    // Reload Improve: nothing is sent; Apply is not offered as if nothing had happened.
    const writesBeforeImproveReload = writes().length;
    const seqBeforeImproveReload = fake.seq;
    const correctionReads = () => fake.requestsTo({ method: 'GET', path: /^\/api\/runs\/[^/]+\/corrections\/[^/]+$/ }).length;
    const correctionReadsBeforeImproveReload = correctionReads();
    await page.reload();
    await page.waitForSelector('[data-testid="improve"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="improve-sentences"] li', { timeout: 15_000 }).catch(() => {});
    await until(() => correctionReads() > correctionReadsBeforeImproveReload, 'the saved review read again', 5_000).catch(() => {});
    await sleep(500);
    evidence.improveReloadCorrectionReads = { before: correctionReadsBeforeImproveReload, after: correctionReads() };
    const improveReload = { hash: new URL(page.url()).hash, writes: writes().slice(writesBeforeImproveReload).map(r => `${r.method} ${r.path}`),
      apply: (await apply.count()) ? await labelOf(apply) : null, primary: await labelOf(slotButton(page, 'improve-primary')),
      sentences: await page.locator('[data-testid="improve-sentences"] li').count(),
      reads: since(seqBeforeImproveReload) };
    evidence.improveReload = improveReload;
    check('reloading Improve returns to Improve and sends nothing', /\/improve$/.test(improveReload.hash) && improveReload.writes.length === 0, improveReload);
    check('after reloading, Improve still shows what the review found (the same sentences)', improveReload.sentences === sentences.length,
      { before: sentences.length, after: improveReload.sentences, savedReviewReads: evidence.improveReloadCorrectionReads });

    // The System check (Health) — AGENTS §6.1: the provisional status is shown there.
    await acting('open the System check', [], async () => {
      await page.locator('[data-testid="shell-setup"]').click();
      await page.waitForSelector('[data-testid="system"] [data-testid="system-ready"]', { timeout: 20_000 });
    });
    const systemFacts = await view('system-after-apply');
    const systemText = await visibleText(page, { root: '#app' });
    evidence.systemText = systemText.split('\n').slice(0, 40);
    check('the System check never calls the filing certainty confirmed after one review', !/\bconfirmed\b|calibrated/i.test(systemText),
      systemText.split('\n').filter(line => /confirmed|calibrated/i.test(line)));
    check('AGENTS §6.1: the System check shows the filing certainty as provisional (outside Details)', /provisional/i.test(systemText),
      systemText.split('\n').filter(line => /certainty|filing|95/i.test(line)));
    await page.goBack();
    await page.waitForSelector('[data-testid="improve"]', { timeout: 20_000 });
    await view('improve-back');

    // ============================================================================================================
    // 4. Update the categories → editor → review → activate KEEPING the filing certainty
    // ============================================================================================================
    const updateLabel = await labelOf(slotButton(page, 'improve-primary'));
    check('Improve\'s primary is "Update the categories"', /update the categories/i.test(updateLabel), updateLabel);
    await acting('Update the categories', [], async () => {
      await (await slotReady(page, 'improve-primary', /update the categories/i)).click();
      await page.waitForSelector('[data-testid="category-editor"] [data-testid="category-card"]', { timeout: 20_000 });
    });
    const editorHash = new URL(page.url()).hash;
    await until(async () => (await page.locator('[data-testid="category-card"]').count()) === typeIds.length, 'the editor cards', 10_000).catch(() => {});
    const editorFacts = await view('editor-1');
    const cards = await page.locator('[data-testid="category-card"]').count();
    check('the editor opens from the run and its review (from=, c=) with the active categories',
      editorHash.includes(`from=${runId}`) && /[?&]c=/.test(editorHash) && cards === typeIds.length, { editorHash, cards });
    const editorText = await visibleText(page, { root: '#app' });
    // SPEC §3c.7, minimal (sweep LOOP-6): the new folder the person made is offered as a category, added only by a
    // click. Example and exclusion suggestions are a known gap, recorded in HANDOFF.md.
    const suggested = await page.locator('[data-testid="category-suggestions"] button[data-op^="categories:add-suggested:"]').allTextContents();
    check('the editor offers the new folder from the review as a category, and adds nothing until it is clicked',
      suggested.length === 1 && cards === typeIds.length, { suggested, cards, text: editorText.split('\n').slice(0, 12) });
    const firstWhat = page.locator('[data-testid="category-card"]').first().locator('textarea').first();
    const whatBefore = await firstWhat.inputValue();
    await firstWhat.fill(`${whatBefore} It also covers short checklists a reader follows once.`);
    const draft1 = await acting('Review changes (first edit)', [/^POST \/api\/definitions\/drafts$/], async () => {
      await (await slotReady(page, 'category-editor-primary', /review changes/i)).click();
      await page.waitForSelector('[data-testid="category-review"] [data-testid="category-review-cards"]', { timeout: 20_000 });
    });
    const draftBody1 = draft1.caused[0]?.body ?? null;
    check('Review changes saves one draft (POST …/drafts) based on the active revision, with the edited wording',
      draft1.ok && draftBody1?.baseRevisionId === activeAfterApply.revisionId &&
        draftBody1?.typeFile?.types?.[0]?.what?.includes('short checklists'), { base: draftBody1?.baseRevisionId, what: draftBody1?.typeFile?.types?.[0]?.what });
    const review1Facts = await view('category-review-1');
    const inherit = page.locator('#category-inherit');
    const inheritDefault = (await inherit.count()) ? await inherit.isChecked() : null;
    const resetText = await visibleText(page, { root: '[data-testid="category-review"]' });
    check('the category review says filing restarts at 90%, and "Keep the current filing certainty" is unticked by default',
      inheritDefault === false && /90%/.test(resetText) && /keep the current filing certainty/i.test(resetText), { inheritDefault });
    await inherit.check();
    const activation1 = await acting('Activate these categories (keeping the filing certainty)', [/^POST \/api\/definitions\/[^/]+\/activate$/], async () => {
      await (await slotReady(page, 'category-review-primary', /activate|start using/i)).click();
      await until(async () => (await page.locator('[data-testid="improve"]').count()) > 0 ||
        /activated|in use/i.test(await feedbackText(page, '[data-testid="category-review-primary"] [data-feedback]')), 'activation', 20_000);
    });
    const activeAfterKeep = { ...fake.state.active };
    const activateBody1 = activation1.caused[0]?.body ?? null;
    check('activating with the tick sends inheritThreshold: true (one POST …/activate)', activation1.ok && activateBody1?.inheritThreshold === true, activateBody1);
    check('kept: the new categories file at 95% and the status is unverified (not confirmed, not reset)',
      activeAfterKeep.threshold === 0.95 && activeAfterKeep.status === 'unverified' && activeAfterKeep.revisionId !== activeAfterApply.revisionId, activeAfterKeep);
    // The view stays put after activating (sweep LOOP-5): the success shows beneath the action, and the primary
    // becomes the next step, which the person chooses.
    const review1Text = await visibleText(page, { root: '#app' });
    const activatedSeen = review1Text.split('\n').filter(line => /in use for new runs|categories are now|version \d+ is active/i.test(line));
    check('the activation\'s success is shown beneath its action, and the view does not move on by itself',
      activatedSeen.length > 0 && (await page.locator('[data-testid="category-review"]').count()) > 0, { seen: activatedSeen, hash: new URL(page.url()).hash });
    await acting('Next: your answers', [], async () => {
      await (await slotReady(page, 'category-review-primary', /next: your answers/i)).click();
      await page.waitForSelector('[data-testid="improve"]', { timeout: 20_000 });
    }).catch(() => {});
    const landing1 = new URL(page.url()).hash;
    evidence.activation1 = { landing: landing1, body: activateBody1, active: activeAfterKeep, seen: activatedSeen };
    check('after activation from the run, "Next: your answers" leads back to that run\'s Improve area', landing1 === `#/run/${runId}/improve`, landing1);
    await view('compare-after-activate-1');

    // ============================================================================================================
    // 5. Categories → Edit → review → activate WITHOUT keeping the filing certainty
    // ============================================================================================================
    await acting('Categories (top bar)', [], async () => {
      await page.locator('a[data-nav="categories"]').click();
      await page.waitForSelector('[data-testid="categories"] [data-testid="categories-active"]', { timeout: 20_000 });
    });
    const categoriesText = await visibleText(page, { root: '#app' });
    check('Categories shows the activated wording', categoriesText.includes('short checklists a reader follows once'), categoriesText.split('\n').slice(0, 10));
    await view('categories');
    await acting('Edit categories', [], async () => {
      await (await slotReady(page, 'categories-primary', /edit categories/i)).click();
      await page.waitForSelector('[data-testid="category-editor"] [data-testid="category-card"]', { timeout: 20_000 });
    });
    await until(async () => (await page.locator('[data-testid="category-card"]').count()) === typeIds.length, 'the editor cards', 10_000).catch(() => {});
    await view('editor-2');
    const secondWhat = page.locator('[data-testid="category-card"]').nth(1).locator('textarea').first();
    const secondBefore = await secondWhat.inputValue();
    await secondWhat.fill(`${secondBefore} It includes lecture slides that explain a topic.`);
    const draft2 = await acting('Review changes (second edit)', [/^POST \/api\/definitions\/drafts$/], async () => {
      await (await slotReady(page, 'category-editor-primary', /review changes/i)).click();
      await page.waitForSelector('[data-testid="category-review"] [data-testid="category-review-cards"]', { timeout: 20_000 });
    });
    check('the second draft is based on the revision just activated', draft2.ok && draft2.caused[0]?.body?.baseRevisionId === activeAfterKeep.revisionId,
      draft2.caused[0]?.body?.baseRevisionId);
    await view('category-review-2');
    const inheritDefault2 = (await inherit.count()) ? await inherit.isChecked() : null;
    check('"Keep the current filing certainty" is unticked by default again', inheritDefault2 === false, inheritDefault2);
    const activation2 = await acting('Activate these categories (not keeping)', [/^POST \/api\/definitions\/[^/]+\/activate$/], async () => {
      await (await slotReady(page, 'category-review-primary', /activate|start using/i)).click();
      await until(async () => (await page.locator('[data-testid="categories"]').count()) > 0 ||
        /activated|in use/i.test(await feedbackText(page, '[data-testid="category-review-primary"] [data-feedback]')), 'activation', 20_000);
    });
    const activeAfterReset = { ...fake.state.active };
    check('activating without the tick sends inheritThreshold: false', activation2.ok && activation2.caused[0]?.body?.inheritThreshold === false,
      activation2.caused[0]?.body);
    check('not kept: filing starts again at 90%, untested', activeAfterReset.threshold === 0.9 && activeAfterReset.status === 'untested' &&
      activeAfterReset.revisionId !== activeAfterKeep.revisionId, activeAfterReset);
    await acting('Next: add documents', [], async () => {
      await (await slotReady(page, 'category-review-primary', /next: add documents/i)).click();
      await page.waitForSelector('[data-testid="files"]', { timeout: 20_000 });
    }).catch(() => {});
    evidence.activation2 = { landing: new URL(page.url()).hash, active: activeAfterReset };
    await view('categories-after-activate-2');

    // ============================================================================================================
    // 6. The area's answers: Save my answers (against the active revision) → Run again and compare starts a new draft
    // ============================================================================================================
    await acting('Home → the run card', [], async () => {
      await page.locator('[data-testid="shell-brand"]').click();
      await page.waitForSelector('[data-testid="home"]', { timeout: 20_000 });
      await page.locator(`[data-testid="home"] a[href="#/run/${runId}"]`).first().click();
      await page.waitForSelector('[data-testid="improve"]', { timeout: 20_000 });
      await page.waitForSelector('[data-testid="compare-summary"]', { timeout: 20_000 });
    });
    const compareFacts = await view('compare');
    const summary = await labelOf(page.locator('[data-testid="compare-summary"]'));
    evidence.compareSummary = summary;
    check('the run card on Home returns the person to this run\'s Improve area (the answers are there)', new URL(page.url()).hash.startsWith(`#/run/${runId}/improve`), page.url());
    check('the summary counts the "either" answer (1 fits either of two)', /\b1 fit either/.test(summary), summary);
    const compareText = await visibleText(page, { root: '#app' });
    // SPEC §3c.9 (Compare maps a new folder to a new category) is deferred by the owner (26 Sep 2026, LOOP-6): not
    // checked here until it is built; the gap is recorded in HANDOFF.md.
    evidence.newFolderOnCompare = { folder: NEW_FOLDER, shown: compareText.includes(NEW_FOLDER) };

    const writesBeforeCompareReload = writes().length;
    const seqBeforeCompareReload = fake.seq;
    const correctionReadsBeforeCompareReload = correctionReads();
    await page.reload();
    await page.waitForSelector('[data-testid="compare-summary"]', { timeout: 15_000 }).catch(() => {});
    await until(() => correctionReads() > correctionReadsBeforeCompareReload, 'the saved review read again', 5_000).catch(() => {});
    await sleep(500);
    evidence.compareReloadCorrectionReads = { before: correctionReadsBeforeCompareReload, after: correctionReads() };
    const compareReload = { hash: new URL(page.url()).hash, summary: await labelOf(page.locator('[data-testid="compare-summary"]')),
      primary: await labelOf(slotButton(page, 'improve-primary')), primaryDisabled: await slotButton(page, 'improve-primary').isDisabled().catch(() => null),
      slot: await feedbackText(page, '[data-testid="improve-primary"] [data-feedback]'),
      writes: writes().slice(writesBeforeCompareReload).map(r => `${r.method} ${r.path}`), requests: since(seqBeforeCompareReload),
      savedReviewReads: evidence.compareReloadCorrectionReads };
    evidence.compareReload = compareReload;
    evidence.compareReloadShot = await shoot('compare-after-reload');
    check('reloading the Improve area keeps the place and the answers (summary, Save my answers available), and sends nothing',
      compareReload.hash.startsWith(`#/run/${runId}/improve`) && compareReload.summary === summary && compareReload.primaryDisabled === false &&
        compareReload.writes.length === 0, compareReload);
    if (compareReload.summary !== summary || compareReload.primaryDisabled !== false) {
      // Recover the way a person would (Home → the run card) so the rest of the loop is still exercised.
      await page.locator('[data-testid="shell-brand"]').click();
      await page.waitForSelector('[data-testid="home"]', { timeout: 20_000 });
      await page.locator(`[data-testid="home"] a[href="#/run/${runId}"]`).first().click();
      await page.waitForSelector('[data-testid="compare-summary"]', { timeout: 20_000 }).catch(() => {});
      evidence.compareRecovered = { hash: new URL(page.url()).hash, summary: await labelOf(page.locator('[data-testid="compare-summary"]')) };
    }

    const answers = await acting('Save my answers', [/^POST \/api\/runs\/[^/]+\/corrections\/[^/]+\/reference$/], async () => {
      await (await slotReady(page, 'improve-primary', /save my answers/i)).click();
      await until(async () => /run again/i.test(await labelOf(slotButton(page, 'improve-primary'))), 'Run again and compare', 20_000);
    });
    const referenceBody = answers.caused[0]?.body ?? null;
    const eitherLabel2 = referenceBody?.labels?.find(label => label.fingerprint === wrong.fingerprint) ?? null;
    evidence.referenceBody = referenceBody && { definitionRevisionId: referenceBody.definitionRevisionId, labels: referenceBody.labels?.length,
      either: eitherLabel2, folderLabels: referenceBody.folderLabels,
      newFolderDocument: referenceBody.labels?.find(label => label.fingerprint === unsure.fingerprint) ?? 'not sent (left unconfirmed)' };
    check('Save my answers sends one POST …/reference, against the active revision',
      answers.ok && referenceBody?.definitionRevisionId === fake.state.active.revisionId, evidence.referenceBody);
    check('the "either folder is right" mark is saved as an answer that fits either of the two categories',
      eitherLabel2?.status === 'ambiguous' && [...(eitherLabel2?.labels ?? [])].sort().join() === [procedures, explainers].sort().join(), eitherLabel2);
    const answersSlot = await feedbackText(page, '[data-testid="improve-primary"] [data-feedback]');
    evidence.answersSaved = { slot: answersSlot, narrationAtTop: await labelOf(page.locator('[data-testid="shell-narration-now"]')),
      primary: await labelOf(slotButton(page, 'improve-primary')) };
    check('"Your answers are saved" appears beneath the action, which becomes "Run again and compare"', /saved/i.test(answersSlot), evidence.answersSaved);
    await view('compare-saved', { navigated: false });

    const runAgain = await acting('Run again and compare', [], async () => {
      await (await slotReady(page, 'improve-primary', /run again/i)).click();
      await until(async () => /^#\/new\/[^/?]+/.test(new URL(page.url()).hash), 'a new draft', 20_000);
      await page.waitForSelector('[data-testid="files"], [data-testid="confirm"]', { timeout: 20_000 });
    });
    const draftHash = new URL(page.url()).hash;
    const draftFacts = await view('new-draft');
    const draftText = await visibleText(page, { root: '#app' });
    // The filing certainty is a Run fact since the calm header (6 October 2026); the lineage stays a chip (SPEC §3c.10).
    await page.locator('[data-testid="shell-run-facts"] > summary').click();
    const factRows = await until(async () => { const list = await page.locator('[data-testid="shell-run-facts"] .run-facts dd').allTextContents(); return list.length > 0 ? list : null; }, 'the run facts sheet');
    const filingChip = factRows.map(s => s.trim()).find(s => /^Filing certainty/.test(s)) ?? '';
    const filingVisible = filingChip !== '';
    await page.locator('[data-testid="shell-run-facts"] > summary').click();
    const lineageChip = await labelOf(page.locator('[data-chip="lineage"]'));
    const lineageVisible = await page.locator('[data-chip="lineage"]').isVisible();
    const lineageLines = draftText.split('\n').filter(line => /checked against|your answers|compared with/i.test(line));
    evidence.newDraft = { hash: draftHash, filingChip, filingVisible, lineageChip, lineageVisible, lineageLines, text: draftText.split('\n').slice(0, 40) };
    check('Run again and compare starts a new draft (#/new/<id>/files) and sends nothing', /^#\/new\/[^/?]+(\/files)?$/.test(draftHash) && runAgain.ok,
      { draftHash, caused: runAgain.caused.map(r => `${r.method} ${r.path}`) });
    const localId = /^#\/new\/([^/?]+)/.exec(draftHash)?.[1] ?? null;
    const savedReferenceId = answers.caused[0]?.response?.id ?? null;
    const frozenTo = localId === null ? null : await page.evaluate(id => localStorage.getItem(`local-reference:${id}`), localId);
    evidence.newDraft.link = { localId, savedReferenceId, frozenTo };
    check('the new draft is linked to the answers just saved (this browser keeps its reference for the quote)',
      savedReferenceId !== null && frozenTo === savedReferenceId, evidence.newDraft.link);
    check('SPEC §3c.10: the new draft visibly says it will be checked against the answers saved from Run 1',
      lineageLines.some(line => /checked against/i.test(line)), { lineageChip, lineageVisible, lineageLines });
    check('the new draft\'s Run facts show the filing certainty at the current 90%, untested (never "confirmed")',
      filingVisible && /90%/.test(filingChip) && /untested/i.test(filingChip) && !/confirmed/i.test(filingChip), { filingChip, filingVisible });
    const writesBeforeDraftReload = writes().length;
    await page.reload();
    await page.waitForSelector('[data-testid="files"], [data-testid="confirm"]', { timeout: 30_000 }).catch(() => {});
    const draftReload = { hash: new URL(page.url()).hash, writes: writes().slice(writesBeforeDraftReload).map(r => `${r.method} ${r.path}`) };
    check('reloading the new draft keeps it (same address), and sends nothing', draftReload.hash === draftHash && draftReload.writes.length === 0, draftReload);

    } finally {
    // ============================================================================================================
    // 7. Across the loop (also recorded when a step above failed)
    // ============================================================================================================
    evidence.views = views;
    evidence.actions = actions;
    const navigatedViews = views.filter(v => v.navigated);
    check('focus moves to the view\'s h1 on every navigation in the loop',
      navigatedViews.every(v => v.focusedTag === 'h1'), navigatedViews.filter(v => v.focusedTag !== 'h1').map(v => ({ view: v.name, focused: v.focused })));
    check('at most one [data-primary] on every view of the loop', views.every(v => v.primaryCount <= 1),
      views.filter(v => v.primaryCount > 1).map(v => ({ view: v.name, primaries: v.primaryCount })));
    check('no Git / JSON / manifest / fingerprint / threshold / probability / token / error-code words outside Details',
      views.every(v => v.jargon.length === 0), views.filter(v => v.jargon.length).map(v => ({ view: v.name, words: v.jargon, lines: v.jargonLines })));
    check('every visible button keeps its feedback slot beneath it; no problem notice outside an action',
      views.every(v => v.slotProblems.length === 0 && v.strayNotices.length === 0),
      views.filter(v => v.slotProblems.length || v.strayNotices.length).map(v => ({ view: v.name, slots: v.slotProblems, stray: v.strayNotices })));
    const unexplained = writes().filter(r => !allowed.has(r.seq)).map(r => `${r.method} ${r.path}`);
    check('every write request followed a click that asked for it, and each action sent exactly what it should',
      unexplained.length === 0 && actions.every(a => a.ok), { unexplained, wrong: actions.filter(a => !a.ok) });
    const record = watch.record;
    evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
    evidence.consoleErrors = record.consoleErrors;
    evidence.pageErrors = record.pageErrors;
    evidence.external = record.external;
    evidence.fakeProblems = fake.problems;
    evidence.internalErrors = fake.internalErrors;
    check('zero requests to any other origin', record.external.length === 0, record.external);
    check('no console errors and no uncaught page errors', record.consoleErrors.length === 0 && record.pageErrors.length === 0,
      { console: record.consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
    check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
    }
  });
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href.toLowerCase() : '';
if (invoked === import.meta.url.toLowerCase()) await main();
