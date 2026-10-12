/**
 * Script 06 — polling never re-renders the page (owner non-negotiable 2), click-through against the fake API.
 *
 *   1. Unchanged polls: on Progress and on Results of a sorting run, three status checks answered "unchanged"
 *      remove 0 nodes and add 0 nodes under #app, and change no text except the "Checked" time.
 *   2. One changed document (the only undecided one moves from Reader to Deciding): on Results only its own row
 *      mutates.
 *   3. A changing poll on Results keeps a half-typed search (value, focus, caret; also while the typed text is still
 *      waiting for its debounce), the open evidence row ("Why?") and the scroll offset.
 *   4. Live updates off: no status request at all; the light says "Updates paused"; Resume reads at once.
 *
 * Real time throughout (status checks every 3 s); no clock is installed. The windows start early in a minute so the
 * minute clock's relative texts ("no new activity for 19 min") cannot tick inside them.
 * Evidence: .local/qa/ui-rebuild/06-poll-stability.json and 06-poll-stability-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { watchMutations } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '06-poll-stability';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, what, timeout = 30_000, every = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(every);
  }
}

/** Waits until the wall clock is early enough in its minute that a window of `ms` ends before the next minute. */
async function roomInMinute(ms) {
  for (;;) {
    const into = Date.now() % 60_000;
    if (into + ms + 2000 < 60_000) return;
    await sleep(60_000 - into + 200);
  }
}

/** A mutation recorder under #app that remembers one element (`window.__watched`) to classify against. */
async function recordMutations(page) {
  await page.evaluate(() => {
    window.__mut?.observer.disconnect();
    const records = [];
    const observer = new MutationObserver(list => { for (const m of list) records.push(m); });
    observer.observe(document.querySelector('#app'), { subtree: true, childList: true, attributes: true, characterData: true,
      attributeOldValue: true, characterDataOldValue: true });
    window.__mut = { observer, records };
  });
  return () => page.evaluate(() => {
    const { observer, records } = window.__mut;
    records.push(...observer.takeRecords());
    observer.disconnect();
    const watched = window.__watched ?? null;
    const results = document.querySelector('[data-testid="results"]');
    return records.map(m => {
      const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
      return {
        type: m.type, attributeName: m.attributeName, oldValue: m.oldValue,
        value: m.type === 'attributes' ? m.target.getAttribute(m.attributeName) : m.type === 'characterData' ? m.target.data : null,
        added: m.addedNodes.length, removed: m.removedNodes.length,
        removedText: [...m.removedNodes].map(n => (n.textContent ?? '').slice(0, 60)),
        addedText: [...m.addedNodes].map(n => (n.textContent ?? '').slice(0, 60)),
        testid: el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        element: el ? `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}` : null,
        inWatched: watched ? watched.contains(m.target) : null,
        inResults: results ? results.contains(m.target) : null,
        inHeader: Boolean(el?.closest('[data-testid="shell-run-header"]')),
        // The screen-reader announcer (view/a11y.ts): a visually hidden live region whose sentence is replaced.
        inAnnouncer: Boolean(el?.closest('[data-announcer]'))
      };
    });
  });
}

await runScript(SCRIPT, 'Owner non-negotiable 2 — no whole-page re-render on poll; typed search, evidence and scroll survive', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  const app = await startApp({ fake });
  defer(() => app.close());
  const opened = await openApp(app, { hash: null, viewport: { width: 1280, height: 640 } });
  defer(() => opened.close());
  const { page, watch } = opened;
  page.setDefaultTimeout(60_000);
  const statusReads = (runId, mark = 0) => fake.requests.slice(mark).filter(r => r.method === 'GET' && r.path === `/api/runs/${runId}/status`);
  const unchangedReads = (runId, mark) => statusReads(runId, mark).filter(r => r.status === 200 && r.response?.unchanged === true);
  const changedReads = (runId, mark) => statusReads(runId, mark).filter(r => r.status === 200 && r.response && r.response.unchanged !== true);
  const shots = [];
  const shot = async name => { shots.push(await screenshot(page, `${SCRIPT}-${name}`, { fullPage: false })); };

  /** Three unchanged polls on the current screen: 0 removed, 0 added, text changes only in the Checked time. */
  async function unchangedWindow(label, runId) {
    await roomInMinute(13_000);
    const harness = await watchMutations(page, { key: label });
    const take = await recordMutations(page);
    const mark = fake.requests.length;
    const checkedBefore = await page.locator('[data-testid="seam-checked"]').textContent();
    await until(() => unchangedReads(runId, mark).length >= 3, `three unchanged status checks on ${label}`, 15_000);
    await sleep(400);
    const records = await take();
    const summary = harness.summarize(await harness.stop());
    const checkedAfter = await page.locator('[data-testid="seam-checked"]').textContent();
    const textChanges = records.filter(r => r.type === 'characterData');
    const otherText = textChanges.filter(r => r.testid !== 'seam-checked');
    const nodeChanges = records.filter(r => r.type === 'childList');
    const attributes = records.filter(r => r.type === 'attributes');
    const sameValueAttributes = attributes.filter(r => r.oldValue === r.value).length;
    const out = {
      reads: statusReads(runId, mark).map(r => ({ status: r.status, unchanged: r.response?.unchanged === true })),
      harnessSummary: summary, checkedBefore, checkedAfter,
      textChanges: textChanges.map(r => ({ testid: r.testid, from: r.oldValue, to: r.value })),
      nodeChanges: nodeChanges.map(r => ({ testid: r.testid, element: r.element, removed: r.removedText, added: r.addedText })).slice(0, 20),
      attributeChanges: attributes.map(r => ({ testid: r.testid, element: r.element, name: r.attributeName, from: r.oldValue, to: r.value })).slice(0, 30),
      attributeChangeCount: attributes.length, sameValueAttributes
    };
    check(`${label}: during 3 unchanged status checks, 0 nodes are removed and 0 added under #app`,
      summary.removedNodes === 0 && summary.addedNodes === 0 && nodeChanges.length === 0, { summary, nodeChanges: out.nodeChanges });
    check(`${label}: the only text that changes is the "Checked" time`,
      otherText.length === 0 && textChanges.length > 0 && checkedBefore !== checkedAfter,
      { otherText: out.textChanges.filter(t => t.testid !== 'seam-checked'), checkedBefore, checkedAfter });
    return out;
  }

  // ==============================================================================================================
  // 1. Unchanged polls, on Progress and on Results
  // ==============================================================================================================
  const quiet = fake.sorting({ total: 40, decided: 20 });
  const Q = quiet.runId;
  await page.goto(app.url(`#/run/${Q}/progress`));
  await page.waitForSelector('[data-testid="progress"][data-phase="sorting"]');
  await page.waitForSelector('[data-testid="progress-activity"]');
  await sleep(4000);
  evidence.progressUnchanged = await unchangedWindow('Progress', Q);
  await shot('progress');
  await page.goto(app.url(`#/run/${Q}/results`));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="results-table"] tbody tr').length === 40);
  await sleep(4000);
  evidence.resultsUnchanged = await unchangedWindow('Results', Q);

  // ==============================================================================================================
  // 2. One changed document mutates only its own row
  // ==============================================================================================================
  const one = fake.sorting({ total: 40, decided: 39 });
  const O = one.runId;
  const openDoc = [...fake.getRun(O).docs.values()].find(doc => doc.status !== 'complete');
  await page.goto(app.url(`#/run/${O}/results`));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="results-table"] tbody tr').length === 40);
  await sleep(3500);
  const rowBefore = await page.evaluate(name => {
    const row = [...document.querySelectorAll('[data-testid="results-table"] tbody tr')].find(tr => tr.querySelector('a')?.textContent.trim() === name);
    window.__watched = row ?? null;
    return row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
  }, openDoc.originalFilename);
  const rowIndexBefore = await page.evaluate(() => [...document.querySelectorAll('[data-testid="results-table"] tbody tr')].indexOf(window.__watched));
  await roomInMinute(10_000);
  const takeOne = await recordMutations(page);
  const markOne = fake.requests.length;
  fake.advance(O);
  await until(() => changedReads(O, markOne).length >= 1, 'a status check that carries the change', 10_000);
  await until(() => page.evaluate(() => window.__watched?.textContent.includes('Deciding')), 'the row to say Deciding', 5_000).catch(() => null);
  await sleep(600);
  const recordsOne = await takeOne();
  const rowAfter = await page.evaluate(() => window.__watched?.isConnected ? window.__watched.textContent.replace(/\s+/g, ' ').trim() : null);
  const rowIndexAfter = await page.evaluate(() => [...document.querySelectorAll('[data-testid="results-table"] tbody tr')].indexOf(window.__watched));
  const inScreenOutsideRow = recordsOne.filter(r => r.inResults && !r.inWatched);
  const outsideScreen = recordsOne.filter(r => !r.inResults && !r.inAnnouncer);
  const announcer = recordsOne.filter(r => r.inAnnouncer).map(r => ({ removed: r.removedText, added: r.addedText }));
  evidence.oneChanged = {
    document: openDoc.originalFilename, rowBefore, rowAfter, rowIndexBefore, rowIndexAfter, announcer,
    inRow: recordsOne.filter(r => r.inWatched).map(r => ({ type: r.type, testid: r.testid, element: r.element, from: r.oldValue, to: r.value, removed: r.removedText, added: r.addedText })),
    inScreenOutsideRow: inScreenOutsideRow.map(r => ({ type: r.type, testid: r.testid, element: r.element, from: r.oldValue, to: r.value, removed: r.removedText, added: r.addedText })),
    outsideScreen: outsideScreen.map(r => ({ type: r.type, testid: r.testid, element: r.element, attribute: r.attributeName, from: r.oldValue, to: r.value, removed: r.removedText, added: r.addedText })).slice(0, 30)
  };
  check('Results: the changed document\'s row changed in place (Reader → Deciding), same element, same position',
    rowBefore !== null && /Reader/.test(rowBefore) && /Deciding/.test(rowAfter ?? '') && rowIndexBefore === rowIndexAfter,
    { rowBefore, rowAfter, rowIndexBefore, rowIndexAfter });
  check('Results: one changed document mutates only its own row (nothing else in the Results screen changes)',
    inScreenOutsideRow.length === 0 && recordsOne.some(r => r.inWatched), evidence.oneChanged.inScreenOutsideRow.slice(0, 10));
  check('Results: outside the screen, no nodes were removed (the header and shell were updated in place; the screen-reader announcer is recorded, not counted)',
    outsideScreen.every(r => r.removed === 0), evidence.oneChanged.outsideScreen.filter(r => r.removed.length).slice(0, 10));
  await shot('one-row');

  // ==============================================================================================================
  // 3. A changing poll keeps the typed search, the open evidence and the scroll offset
  // ==============================================================================================================
  const busy = fake.sorting({ total: 60, decided: 40 });
  const S = busy.runId;
  await page.goto(app.url(`#/run/${S}/results`));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="results-table"] tbody tr').length === 60);
  // Open "Why?" for a decided document whose name matches the search below.
  const decidedGuide = [...fake.getRun(S).docs.values()].find(doc => doc.status === 'complete' && doc.originalFilename.startsWith('Guide'));
  await page.locator('[data-testid="results-table"] tbody tr a', { hasText: decidedGuide.originalFilename }).click();
  await page.waitForSelector('[data-testid="results-evidence"]');
  await sleep(1500);
  const evidenceBefore = await page.evaluate(() => ({
    open: document.querySelector('[data-testid="results-table"] tr[data-open]:not([data-open=\"false\"]) a')?.textContent.trim() ?? null,
    panel: document.querySelector('[data-testid="results-evidence"]')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) ?? null
  }));
  const panelElementBefore = await page.evaluate(() => { window.__panel = document.querySelector('[data-testid="results-evidence"]'); return Boolean(window.__panel); });
  // Type half a word; the debounce (80 ms) writes it to the address.
  await page.locator('#results-search').click();
  await page.keyboard.type('Gui');
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes('q=Gui'));
  await page.evaluate(() => window.scrollTo(0, 260));
  await sleep(300);
  const before = await page.evaluate(() => {
    const input = document.querySelector('#results-search');
    return { value: input.value, focused: document.activeElement === input, caret: [input.selectionStart, input.selectionEnd], scrollY: Math.round(window.scrollY),
      rows: document.querySelectorAll('[data-testid="results-table"] tbody tr').length, hash: decodeURIComponent(location.hash) };
  });
  const markS = fake.requests.length;
  fake.advance(S);
  await until(() => changedReads(S, markS).length >= 1, 'a changing status check', 10_000);
  await sleep(800);
  const after = await page.evaluate(() => {
    const input = document.querySelector('#results-search');
    return { value: input.value, focused: document.activeElement === input, caret: [input.selectionStart, input.selectionEnd], scrollY: Math.round(window.scrollY),
      rows: document.querySelectorAll('[data-testid="results-table"] tbody tr').length, hash: decodeURIComponent(location.hash),
      open: document.querySelector('[data-testid="results-table"] tr[data-open]:not([data-open=\"false\"]) a')?.textContent.trim() ?? null,
      samePanel: window.__panel?.isConnected === true && window.__panel === document.querySelector('[data-testid="results-evidence"]'),
      panel: document.querySelector('[data-testid="results-evidence"]')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) ?? null };
  });
  evidence.survival = { document: decidedGuide.originalFilename, evidenceBefore, panelElementBefore, before, after,
    reads: statusReads(S, markS).map(r => ({ status: r.status, unchanged: r.response?.unchanged === true })) };
  check('a changing poll keeps the typed search: same value, focus and caret, and it stays in the address',
    after.value === 'Gui' && after.focused && after.caret[0] === 3 && after.caret[1] === 3 && after.hash.includes('q=Gui'), { before, after });
  check('a changing poll keeps the open evidence ("Why?"): the same row open and the same panel element, not rebuilt',
    after.open === decidedGuide.originalFilename && after.samePanel && after.panel === evidenceBefore.panel, { evidenceBefore, after });
  check('a changing poll keeps the scroll offset', Math.abs(after.scrollY - before.scrollY) <= 2 && before.scrollY > 100, { before: before.scrollY, after: after.scrollY });

  // The same while the typed text is still waiting for its debounce: the answer lands between two key presses.
  const hold = fake.hold({ method: 'GET', path: `/api/runs/${S}/status` });
  await until(() => hold.waiting >= 1, 'the next status check to be held', 10_000);
  fake.advance(S);
  await page.keyboard.type('d');
  hold.release();
  await sleep(30);
  await page.keyboard.type('e');
  await sleep(1200);
  const typed = await page.evaluate(() => {
    const input = document.querySelector('#results-search');
    return { value: input.value, focused: document.activeElement === input, caret: [input.selectionStart, input.selectionEnd],
      hash: decodeURIComponent(location.hash), scrollY: Math.round(window.scrollY),
      open: document.querySelector('[data-testid="results-table"] tr[data-open]:not([data-open=\"false\"]) a')?.textContent.trim() ?? null };
  });
  evidence.survival.whileTyping = { typed, heldAnswered: hold.requests.map(r => ({ status: r.status, dropped: r.dropped === true })) };
  check('a poll answered mid-typing loses no key press: "Guide", focus and caret kept, the address follows',
    typed.value === 'Guide' && typed.focused && typed.caret[0] === 5 && typed.hash.includes('q=Guide') && typed.open === decidedGuide.originalFilename,
    evidence.survival.whileTyping);
  await shot('survival');

  // ==============================================================================================================
  // 4. Live updates off: no status requests
  // ==============================================================================================================
  await page.goto(app.url(`#/run/${Q}/progress`));
  await page.waitForSelector('[data-testid="progress"][data-phase="sorting"]');
  await sleep(1000);
  const markLive = fake.requests.length;
  await sleep(7000);
  const readsWhileOn = statusReads(Q, markLive).length;
  const toggle = page.locator('[data-testid="shell-live"]');
  const pressedBefore = await toggle.getAttribute('aria-pressed');
  await toggle.click();
  await sleep(800);
  const markOff = fake.requests.length;
  await sleep(10_000);
  const readsWhileOff = statusReads(Q, markOff);
  const pausedFacts = await page.evaluate(() => ({
    pressed: document.querySelector('[data-testid="shell-live"]')?.getAttribute('aria-pressed') ?? null,
    paused: document.querySelector('[data-testid="shell-live-paused"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    light: document.querySelector('[data-testid="progress-light"]')?.getAttribute('data-light') ?? null,
    word: document.querySelector('[data-testid="progress-light"] .status__state')?.textContent.trim() ?? null,
    headerWord: document.querySelector('[data-testid="shell-light"] .status__state')?.textContent.trim() ?? null
  }));
  await shot('live-off');
  const markResume = fake.requests.length;
  await page.locator('[data-testid="shell-live-paused"] button').click();
  await sleep(1500);
  const readsAfterResume = statusReads(Q, markResume).length;
  const resumed = await page.evaluate(() => document.querySelector('[data-testid="shell-live"]')?.getAttribute('aria-pressed') ?? null);
  evidence.liveToggle = { readsWhileOn, pressedBefore, pausedFacts, readsWhileOff: readsWhileOff.length, readsAfterResume, resumed };
  check('with Live updates on, the run is checked every 3 s (at least 2 checks in 7 s)', readsWhileOn >= 2 && pressedBefore === 'true', { readsWhileOn, pressedBefore });
  check('Live updates off: no status request at all for 10 s', readsWhileOff.length === 0, readsWhileOff.map(r => r.at));
  check('Live updates off is shown: the toggle is not pressed, "Live updates paused at …", the light says "Updates paused" in both places',
    pausedFacts.pressed === 'false' && /paused/i.test(pausedFacts.paused ?? '') && pausedFacts.light === 'paused' &&
    pausedFacts.word === 'Updates paused' && pausedFacts.headerWord === 'Updates paused', pausedFacts);
  check('Resume checks at once and turns Live updates back on', readsAfterResume >= 1 && resumed === 'true', { readsAfterResume, resumed });

  // ==============================================================================================================
  // Hygiene
  // ==============================================================================================================
  evidence.consoleErrors = watch.record.consoleErrors;
  evidence.pageErrors = watch.record.pageErrors;
  evidence.external = watch.record.external;
  evidence.screenshots = shots;
  const writes = fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  check('no console errors and no page errors', watch.record.consoleErrors.length === 0 && watch.record.pageErrors.length === 0,
    { consoleErrors: watch.record.consoleErrors.map(e => e.text), pageErrors: watch.record.pageErrors });
  check('nothing was posted (this script never clicks an operational button)', writes.length === 0, writes.map(r => `${r.method} ${r.path}`));
  check('zero requests to any other origin', watch.record.external.length === 0, watch.record.external);
  check('every fake answer matched the wire contract', fake.problems.length === 0 && fake.internalErrors.length === 0, { problems: fake.problems, internal: fake.internalErrors });
});
