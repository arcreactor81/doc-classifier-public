/**
 * Script 15 of the click-through acceptance sweep — the emergency stop (SPEC §10.2 script 15; owner non-negotiables
 * 4, 5, 6 and 14).
 *
 * - The stop exists only on System: no stop control on Home, Runs, Categories, Help, Files, Confirm or a run's
 *   Progress; exactly one "Stop all runs…" on System.
 * - The global stop is the owner's alone (DECISIONS 140): someone who is not a listed category editor sees no stop
 *   control on System, only who can stop all runs and how to stop their own, and nothing is sent.
 * - Its sheet copy is exactly systemCopy.stopSheet and plain (no jargon, no codes); Cancel sends nothing.
 * - After stopping: one POST /api/kill {enabled: true}; the outcome is reported beneath the action; System's text
 *   stays plain; Confirm's Start run is blocked with the emergency-stop reason and a link to System.
 * - A run halted by the stop shows the stop message and a failed light; nothing continues, resumes or sends it. Its
 *   one action is "New run with the unfinished documents", offered while the stop is on too (Confirm blocks starting
 *   that run until new runs are allowed, which is where the block belongs).
 * - Someone who is not a category editor sees no "Allow new runs…" while stopped, only who can allow runs again.
 * - "Allow new runs…": exact sheet copy, one POST /api/kill {enabled: false}; Confirm can start again; the halted run
 *   stays stopped.
 * - A run stopped by the storage brake with every document decided (DECISIONS 135 addendum, 7 October 2026) still
 *   offers "New run with the unfinished documents", with its note; its draft holds exactly the documents set aside
 *   because their saved records could not be confirmed (not a charge set aside, a reader failure, a file that could
 *   not be read, or a filed or review document), and nothing is sent.
 * Evidence: .local/qa/ui-rebuild/15-system-stop.json and 15-system-stop-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { focusedElement, visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { systemCopy } from '../../core/ui/copy-system.ts';
import { confirmCopy } from '../../core/ui/copy-confirm.ts';
import { errorsCopy } from '../../core/ui/copy-errors.ts';
import { progressCopy } from '../../core/ui/copy-progress.ts';
import { uiCopy } from '../../core/ui/copy.ts';
import { decide } from '../../core/domain/decision.ts';
import { serverCopy } from '../../core/server/errors.ts';

const SCRIPT = '15-system-stop';

/** core/ui/error-copy.ts's normal-path jargon pattern, plus error codes. */
const JARGON = /\b(manifest|json|fingerprint|sidecar|git|repository|project pack|pins?|workflow|tokens?|http|inference|aud|uuid|technical contact|kill switch|threshold|filing bar|noul|probability)\b|\bE_[A-Z_]{3,}\b/i;

// ---------------------------------------------------------------------------------------------------------------
// Helpers (kept inside this file: the group owns its scripts only)
// ---------------------------------------------------------------------------------------------------------------

const sel = testid => `[data-testid="${testid}"]`;

async function button(page, testid, timeout = 20_000) {
  const b = page.locator(`${sel(testid)} button`).first();
  await b.waitFor({ timeout });
  return b;
}

async function waitEnabled(page, locator, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await locator.isDisabled().catch(() => true))) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function go(page, hash, testid, timeout = 20_000) {
  await page.evaluate(next => { location.hash = next; }, hash);
  await page.waitForSelector(sel(testid), { timeout });
  await page.waitForTimeout(500);
}

async function toConfirm(page, picker, files, label) {
  await page.waitForSelector(`${sel('home')}, ${sel('welcome')}`, { timeout: 20_000 });
  const root = opfsRoot(label);
  await writeFolder(page, `${root}/docs`, files);
  await (await button(page, 'home-primary')).click();
  await page.waitForSelector(sel('files'), { timeout: 20_000 });
  picker.queue(`${root}/docs`);
  await (await button(page, 'files-primary')).click();
  await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 60_000 });
  await (await button(page, 'files-primary')).click();
  await page.waitForSelector(sel('confirm-summary'), { timeout: 20_000 });
  await page.fill('#confirm-limit-blended', '5');
  return new URL(page.url()).hash;
}

/** Every visible control that stops runs globally. */
async function stopControls(page) {
  return page.evaluate(() => {
    const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
    return [...document.querySelectorAll('button, a[href], [role="button"]')].filter(visible)
      .map(el => ({ tag: el.tagName.toLowerCase(), op: el.getAttribute('data-op'), text: el.textContent.trim() }))
      .filter(c => (c.op ?? '').startsWith('system:stop') || /stop all|halt all|emergency stop|kill/i.test(c.text));
  });
}

async function sheetFacts(page) {
  const sheet = page.locator('dialog.sheet[open]');
  await sheet.waitFor({ timeout: 5000 });
  return sheet.evaluate(dialog => ({
    title: dialog.querySelector('h2')?.textContent.trim() ?? null,
    lines: [...dialog.querySelectorAll('.sheet__body p')].map(p => p.textContent.trim()),
    confirm: dialog.querySelector('button[data-sheet="confirm"]')?.textContent.trim() ?? null,
    cancel: dialog.querySelector('button[data-sheet="cancel"]')?.textContent.trim() ?? null,
    text: dialog.innerText
  }));
}

/** The outcome text of any [data-feedback] slot on the page. */
async function slotTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-feedback]')]
    .map(slot => ({ id: slot.getAttribute('data-feedback'), state: slot.getAttribute('data-state'), text: slot.innerText.trim() }))
    .filter(slot => slot.text));
}

const posts = (fake, path) => fake.requestsTo({ method: 'POST', path });

// ---------------------------------------------------------------------------------------------------------------

await runScript(SCRIPT, 'Sweep script 15 — the emergency stop lives on System only', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  const { runId: runningId } = fake.sorting({ total: 6, decided: 2 });
  const { files } = fake.run(5);
  const app = await startApp({ fake });
  defer(() => app.close());
  const opened = await openApp(app, { hash: '#/' });
  defer(() => opened.close());
  const { page, watch, picker } = opened;
  evidence.app = { origin: app.origin, runningId };
  evidence.stopControls = {};

  const onlyOnSystem = async (name) => {
    const found = await stopControls(page);
    evidence.stopControls[name] = found;
    checks.check(`no emergency-stop control on ${name}`, found.length === 0, found);
  };

  // 1. The stop exists only on System.
  await page.waitForSelector(sel('home'), { timeout: 20_000 });
  await onlyOnSystem('Home');
  for (const [hash, testid, name] of [['#/runs', 'runs', 'Runs'], ['#/categories', 'categories', 'Categories'], ['#/help', 'help', 'Help'],
    [`#/run/${runningId}/progress`, 'progress', 'a running run\'s Progress']]) {
    await go(page, hash, testid);
    await onlyOnSystem(name);
  }
  await go(page, '#/', 'home');
  const confirmHash = await toConfirm(page, picker, files, 'stop');
  await onlyOnSystem('Confirm');
  const startBefore = await button(page, 'confirm-primary');
  checks.check('before the stop, Start run is available', await waitEnabled(page, startBefore, 10_000));

  // 1b. Not an editor (DECISIONS 140): no stop control on System, and a line saying who can stop all runs.
  await go(page, '#/system', 'system');
  fake.state.editor = false;
  await page.reload();
  await go(page, '#/system', 'system-ready');
  await page.waitForTimeout(800);
  const nonEditorControls = await stopControls(page);
  evidence.stopControls['System, not an editor'] = nonEditorControls;
  const nonEditorSystem = await visibleText(page, { excludeTechnical: true });
  evidence.systemTextNotEditor = nonEditorSystem.split('\n');
  checks.check('a person who is not an editor sees no stop control on System',
    nonEditorControls.length === 0 && await page.locator('button[data-op="system:stop-all:page"]').count() === 0, nonEditorControls);
  checks.check(`a person who is not an editor is told "${systemCopy.stopOwnerOnly}"`,
    nonEditorSystem.includes(systemCopy.stopOwnerOnly), evidence.systemTextNotEditor);
  checks.check('nothing was sent for the person who is not an editor (before the stop)', posts(fake, '/api/kill').length === 0,
    posts(fake, '/api/kill').map(r => r.body));
  evidence.screenshotNotEditor = await screenshot(page, `${SCRIPT}-not-editor`);
  fake.state.editor = true;
  await page.reload();
  await go(page, '#/system', 'system-ready');
  const editorSystem = await visibleText(page, { excludeTechnical: true });
  checks.check(`an editor is not told "${systemCopy.stopOwnerOnly}"`, !editorSystem.includes(systemCopy.stopOwnerOnly));

  // 2. System: exactly one "Stop all runs…", and its sheet.
  await page.locator(sel('shell-setup')).click();
  await page.waitForSelector(sel('system-ready'), { timeout: 20_000 });
  await page.waitForTimeout(500);
  const onSystem = await stopControls(page);
  evidence.stopControls.System = onSystem;
  checks.check(`System has exactly one "${systemCopy.stopAll}" control`,
    onSystem.length === 1 && onSystem[0].op === 'system:stop-all:page' && onSystem[0].text === systemCopy.stopAll, onSystem);
  const stopButton = page.locator('button[data-op="system:stop-all:page"]');

  await stopButton.click();
  const cancelled = await sheetFacts(page);
  await page.locator('dialog.sheet[open] button[data-sheet="cancel"]').click();
  await page.waitForTimeout(500);
  checks.check('Cancel on the stop sheet sends nothing', posts(fake, '/api/kill').length === 0, posts(fake, '/api/kill').length);

  await stopButton.click();
  const stopSheet = await sheetFacts(page);
  evidence.stopSheet = stopSheet;
  checks.check('the stop sheet title is exact', stopSheet.title === systemCopy.stopSheet.title, stopSheet.title);
  checks.check('the stop sheet lines are exact', JSON.stringify(stopSheet.lines) === JSON.stringify(systemCopy.stopSheet.lines), stopSheet.lines);
  checks.check('the stop sheet buttons are exact', stopSheet.confirm === systemCopy.stopSheet.confirm && stopSheet.cancel === uiCopy.common.cancel,
    { confirm: stopSheet.confirm, cancel: stopSheet.cancel });
  checks.check('the stop sheet copy is plain (no jargon or codes)', !JARGON.test(stopSheet.text), stopSheet.text);
  checks.check('the same sheet opened both times', cancelled.title === stopSheet.title);
  evidence.screenshotStopSheet = await screenshot(page, `${SCRIPT}-stop-sheet`);
  await page.locator('dialog.sheet[open] button[data-sheet="confirm"]').click();
  await page.locator('button[data-op="system:allow:page"]').waitFor({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(800);

  // 3. After stopping.
  const kill = posts(fake, '/api/kill');
  checks.check('one POST /api/kill {enabled: true}', kill.length === 1 && kill[0].body?.enabled === true, kill.map(r => r.body));
  checks.check('the running run is halted by the stop (precondition)', fake.getRun(runningId)?.status === 'halted', fake.getRun(runningId)?.status);
  const afterStop = await slotTexts(page);
  evidence.slotsAfterStop = afterStop;
  checks.check(`"${systemCopy.done.stopped}" is reported beneath the action that caused it`,
    afterStop.some(slot => slot.text.includes(systemCopy.done.stopped)), afterStop);
  const focusAfterStop = await focusedElement(page);
  evidence.focusAfterStop = focusAfterStop;
  checks.check('focus is not lost to the page after the stop (it stays in the System actions)', focusAfterStop !== null, focusAfterStop);
  const systemText = await visibleText(page, { excludeTechnical: true });
  evidence.systemTextAfterStop = systemText.split('\n');
  checks.check('System shows that all runs are stopped', systemText.includes(systemCopy.stopped));
  checks.check(`while it says "${systemCopy.notReady}", System does not also say "${systemCopy.readyMeaning.split('.')[0]}."`,
    !(systemText.includes(systemCopy.notReady) && systemText.includes(systemCopy.readyMeaning)),
    systemText.split('\n').filter(line => line === systemCopy.notReady || line === systemCopy.readyMeaning));
  checks.check('System text after the stop is plain (no "kill switch", no codes)', !JARGON.test(systemText),
    systemText.split('\n').filter(line => JARGON.test(line)));
  checks.check(`"${systemCopy.allowRuns}" replaces the stop`, await page.locator('button[data-op="system:allow:page"]').isVisible() &&
    (await stopControls(page)).length === 0, await stopControls(page));
  evidence.screenshotStopped = await screenshot(page, `${SCRIPT}-system-stopped`);

  // 4. Confirm is blocked with the reason and a link to System.
  const quotesBefore = posts(fake, '/api/quote').length;
  await go(page, confirmHash, 'confirm-summary');
  await page.waitForTimeout(1500);
  const start = page.locator(`${sel('confirm-primary')} button`).first();
  const startShown = await start.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const blocked = await page.evaluate(() => {
    const slot = document.querySelector('[data-feedback^="confirm:start:"]');
    const stage = document.querySelector('#main');
    return {
      hash: location.hash,
      primarySlot: document.querySelector('[data-testid="confirm-primary"]')?.innerHTML.slice(0, 400) ?? null,
      state: slot?.getAttribute('data-state') ?? null,
      text: slot?.innerText.trim() ?? '',
      slotLinks: [...(slot?.querySelectorAll('a[href]') ?? [])].map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim() })),
      stageLinks: [...document.querySelectorAll('a[href="#/system"]')].filter(a => !a.closest('[data-testid="shell-topbar"]'))
        .map(a => a.textContent.trim()),
      stageText: stage?.innerText.split('\n').map(line => line.trim()).filter(Boolean) ?? [],
      narration: document.querySelector('[data-testid="shell-subject"]')?.innerText.split('\n').map(line => line.trim()).filter(Boolean) ?? []
    };
  });
  // SPEC J9: while setup is blocked Confirm has no primary ("none, link to System"); the view says why, and links to
  // System, directly beneath the empty primary place (sweep AS-1).
  const blockedNotice = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="confirm-primary"]');
    const next = slot?.nextElementSibling ?? null;
    return next?.getAttribute('data-testid') !== 'confirm-blocked' ? null : {
      text: next.innerText.trim(), links: [...next.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim() }))
    };
  });
  evidence.confirmBlocked = { ...blocked, notice: blockedNotice };
  checks.check('after the stop, Confirm offers no Start run (SPEC J9)', !startShown, { startShown, primarySlot: blocked.primarySlot });
  checks.check('the emergency-stop reason is shown directly beneath the primary place',
    blockedNotice !== null && blockedNotice.text.includes(confirmCopy.blockers.emergencyStop), { notice: blockedNotice, stage: blocked.stageText });
  checks.check('the reason links to the System page', blockedNotice?.links.some(link => link.href === '#/system') === true,
    { notice: blockedNotice, systemLinksElsewhereInTheStage: blocked.stageLinks });
  if (startShown) await start.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  checks.check('selecting the disabled Start run sends nothing', posts(fake, '/api/quote').length === quotesBefore);
  evidence.screenshotConfirmBlocked = await screenshot(page, `${SCRIPT}-confirm-blocked`);

  // 5. The run the stop halted.
  await go(page, `#/run/${runningId}/progress`, 'progress');
  await page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') === 'stopped', null, { timeout: 20_000 }).catch(() => {});
  const halted = async () => page.evaluate(() => {
    const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
    const card = document.querySelector('[data-testid="progress-stopped"]');
    return {
      phase: document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') ?? null,
      headline: card?.querySelector('.notice__headline')?.textContent.trim() ?? null,
      action: card?.querySelector('.notice__action')?.textContent.trim() ?? null,
      primary: document.querySelector('[data-testid="progress-primary"] button')?.textContent.trim() ?? null,
      buttons: [...document.querySelectorAll('button')].filter(visible).map(b => ({ op: b.getAttribute('data-op'), text: b.textContent.trim() })),
      light: document.querySelector('[data-testid="progress-light"]')?.getAttribute('data-light') ?? null
    };
  });
  const checkHalted = async (when) => {
    const facts = await halted();
    const text = await visibleText(page, { excludeTechnical: true });
    evidence[`halted ${when}`] = { ...facts, killStoppedShown: text.includes(progressCopy.killStopped) };
    checks.check(`${when}: the halted run shows as stopped`, facts.phase === 'stopped', facts.phase);
    checks.check(`${when}: the stop card says the emergency stop halted it`, facts.headline === errorsCopy.stop.killedHeadline, facts.headline);
    checks.check(`${when}: the stop card says it can't be continued`, facts.action === errorsCopy.stop.killed, facts.action);
    const continues = facts.buttons.filter(b => /continue|recover|resume|send/i.test(`${b.op ?? ''} ${b.text}`));
    checks.check(`${when}: no continue, recover, resume or send action is offered on the halted run`, continues.length === 0, continues);
    const retry = facts.buttons.filter(b => (b.op ?? '').startsWith(`progress:retry-unfinished:${runningId}`));
    checks.check(`${when}: the one action is "${progressCopy.retryUnfinished}"`,
      facts.primary === progressCopy.retryUnfinished && retry.length === 1 && retry[0].text === progressCopy.retryUnfinished,
      { primary: facts.primary, retry });
    checks.check(`${when}: the live light is failed (red)`, facts.light === 'failed', facts.light);
    checks.check(`${when}: the halted run's page is plain (no "kill switch", no codes)`, !JARGON.test(text),
      text.split('\n').filter(line => JARGON.test(line)));
  };
  await checkHalted('while stopped');
  evidence.screenshotHalted = await screenshot(page, `${SCRIPT}-halted-run`);

  // 6a. Not an editor: no Allow action, and the stop says who can allow runs again (DECISIONS 129a).
  fake.state.editor = false;
  await page.reload();
  await go(page, '#/system', 'system');
  await page.waitForTimeout(800);
  const nonEditorText = await visibleText(page, { excludeTechnical: true });
  checks.check('a person who is not an editor is told who can allow runs again', nonEditorText.includes(systemCopy.allowEditorsOnly), nonEditorText);
  checks.check('a person who is not an editor is offered no Allow action', await page.locator('button[data-op="system:allow:page"]').count() === 0);
  checks.check('while stopped, a person who is not an editor sees no stop control either', (await stopControls(page)).length === 0, await stopControls(page));
  checks.check('nothing was sent for the person who is not an editor', posts(fake, '/api/kill').length === 1, posts(fake, '/api/kill').map(r => r.body));
  fake.state.editor = true;
  await page.reload();

  // 6. Allow new runs.
  await go(page, '#/system', 'system');
  const allowButton = page.locator('button[data-op="system:allow:page"]');
  await allowButton.waitFor({ timeout: 20_000 });
  await allowButton.click();
  const allowSheet = await sheetFacts(page);
  evidence.allowSheet = allowSheet;
  checks.check('the allow sheet title is exact', allowSheet.title === systemCopy.allowSheet.title, allowSheet.title);
  checks.check('the allow sheet lines are exact', JSON.stringify(allowSheet.lines) === JSON.stringify(systemCopy.allowSheet.lines), allowSheet.lines);
  checks.check('the allow sheet buttons are exact', allowSheet.confirm === systemCopy.allowSheet.confirm && allowSheet.cancel === uiCopy.common.cancel,
    { confirm: allowSheet.confirm, cancel: allowSheet.cancel });
  checks.check('the allow sheet copy is plain', !JARGON.test(allowSheet.text), allowSheet.text);
  await page.locator('dialog.sheet[open] button[data-sheet="confirm"]').click();
  await stopButton.waitFor({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const allow = posts(fake, '/api/kill');
  checks.check('one POST /api/kill {enabled: false}', allow.length === 2 && allow[1].body?.enabled === false, allow.map(r => r.body));
  const afterAllow = await slotTexts(page);
  evidence.slotsAfterAllow = afterAllow;
  checks.check(`"${systemCopy.done.allowed}" is reported beneath the action that caused it`,
    afterAllow.some(slot => slot.text.includes(systemCopy.done.allowed)), afterAllow);
  checks.check(`"${systemCopy.stopAll}" is back on System`, await stopButton.isVisible());
  const systemAfterAllow = await visibleText(page, { excludeTechnical: true });
  checks.check('System no longer says all runs are stopped', !systemAfterAllow.includes(systemCopy.stopped));
  checks.check(`after new runs are allowed, no stale "${systemCopy.done.stopped}" is shown`, !systemAfterAllow.includes(systemCopy.done.stopped),
    systemAfterAllow.split('\n').filter(line => line.includes(systemCopy.done.stopped)));
  evidence.screenshotAllowed = await screenshot(page, `${SCRIPT}-system-allowed`);

  // 7. The halted run stays stopped; Confirm can start again.
  checks.check('the halted run is still halted on the service', fake.getRun(runningId)?.status === 'halted', fake.getRun(runningId)?.status);
  await go(page, `#/run/${runningId}/progress`, 'progress');
  await page.waitForTimeout(500);
  await checkHalted('after new runs are allowed');
  await go(page, confirmHash, 'confirm-summary');
  const startAgain = page.locator(`${sel('confirm-primary')} button`).first();
  const againShown = await startAgain.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const restored = againShown && await waitEnabled(page, startAgain, 10_000);
  const slotAfter = (await page.locator('[data-feedback^="confirm:start:"]').first().innerText().catch(() => '')).trim();
  checks.check('after "Allow new runs", Start run is available again', restored, slotAfter);
  checks.check('the emergency-stop reason is gone', !slotAfter.includes(confirmCopy.blockers.emergencyStop), slotAfter);
  if (restored) {
    await startAgain.click();
    await page.waitForSelector(sel('progress'), { timeout: 30_000 }).catch(() => {});
    checks.check('a new run starts after new runs are allowed', posts(fake, '/api/runs').length === 1, posts(fake, '/api/runs').length);
  }

  // 8. A run stopped by the storage brake with every document decided: its storage set-asides go into a new run.
  const { runId: brakedId, files: brakedFiles } = fake.completed({ outcomes: ['R1', 'R5', 'R0', 'R0', 'R0', 'R0', 'R0', 'unreadable'] });
  const braked = fake.getRun(brakedId);
  const setAside = (index, code) => {
    const doc = braked.docs.get(brakedFiles[index].fingerprint);
    doc.failure = { code, message: serverCopy.documentStorageUnconfirmed };
    doc.decision = decide({ notePolicy: braked.pack.settings.decisionNotePolicy, confidenceStatePolicy: braked.pack.settings.confidenceStatePolicy,
      typeIds: braked.pack.typeFile.types.map(type => type.id), threshold: braked.threshold, failures: [code], notes: [] });
  };
  ['E_ARTIFACT_WRITE', 'E_CHECKPOINT_FINISH', 'E_STORAGE_READ'].forEach((code, i) => setAside(2 + i, code));
  setAside(5, 'E_VENDOR_LEDGER_WRITE'); // a charge set aside; index 6 keeps its reader failure, index 7 could not be read
  braked.status = 'halted';
  braked.halt = { code: 'E_STORAGE_CIRCUIT', message: serverCopy.storageCircuit(3) };
  const runsBefore = posts(fake, '/api/runs').length, quotesBeforeRetry = posts(fake, '/api/quote').length;
  await go(page, `#/run/${brakedId}/progress`, 'progress');
  await page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') === 'stopped', null, { timeout: 20_000 }).catch(() => {});
  const brakedFacts = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="progress-primary"]');
    return { phase: document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') ?? null,
      primary: slot?.querySelector('button')?.textContent.trim() ?? null, op: slot?.querySelector('button')?.getAttribute('data-op') ?? null,
      note: slot?.querySelector('.action__note')?.textContent.trim() ?? null };
  });
  const brakedText = await visibleText(page, { excludeTechnical: true });
  evidence.storageBrake = { ...brakedFacts, decided: [...braked.docs.values()].every(doc => doc.status === 'complete') };
  checks.check('storage brake: every document of the stopped run has an outcome (precondition)', evidence.storageBrake.decided && brakedFacts.phase === 'stopped', brakedFacts.phase);
  checks.check(`storage brake: the one action is "${progressCopy.retryUnfinished}"`,
    brakedFacts.primary === progressCopy.retryUnfinished && brakedFacts.op === `progress:retry-unfinished:${brakedId}`, brakedFacts);
  checks.check('storage brake: the note beneath it says storage set-asides are included', brakedFacts.note === progressCopy.retryUnfinishedNote, brakedFacts.note);
  checks.check('storage brake: the stopped run\'s page is plain (no codes)', !JARGON.test(brakedText), brakedText.split('\n').filter(line => JARGON.test(line)));
  evidence.screenshotStorageBrake = await screenshot(page, `${SCRIPT}-storage-brake`);
  await page.locator(`button[data-op="progress:retry-unfinished:${brakedId}"]`).click();
  await page.waitForSelector(sel('files'), { timeout: 20_000 });
  const retry = await page.evaluate(async () => {
    const keys = await import('/persist/local-keys.ts');
    return keys.readRetry(location.hash.split('/')[2]);
  });
  const expected = brakedFiles.slice(2, 5).map(file => file.fingerprint).sort();
  evidence.storageBrakeRetry = retry;
  checks.check('storage brake: the new run\'s draft holds exactly the three documents set aside for storage',
    retry?.parentRunId === brakedId && JSON.stringify(retry.documents.map(doc => doc.fingerprint).sort()) === JSON.stringify(expected), retry);
  checks.check('storage brake: nothing was quoted or started by the action', posts(fake, '/api/runs').length === runsBefore &&
    posts(fake, '/api/quote').length === quotesBeforeRetry, { runs: posts(fake, '/api/runs').length, quotes: posts(fake, '/api/quote').length });
  checks.check('storage brake: the stopped run stays stopped', fake.getRun(brakedId)?.status === 'halted', fake.getRun(brakedId)?.status);

  const record = watch.record;
  checks.check('no console errors', record.consoleErrors.length === 0, record.consoleErrors.slice(0, 5));
  checks.check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  checks.check('zero requests to any other origin', record.external.length === 0, record.external.slice(0, 5));
  checks.check('every fake API answer matched the wire contract', fake.problems.length === 0, fake.problems.slice(0, 5));
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
});
