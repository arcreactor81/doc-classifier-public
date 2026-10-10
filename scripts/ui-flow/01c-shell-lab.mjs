/**
 * Script 1c (SPEC §11 WP-6 acceptance): the shell lab. Headless Edge, the stateful fake API, placeholder content only.
 *
 * Part A drives the real app (index.html → main.ts → shell/app-shell.ts):
 * - Shell nodes are never removed across route changes: the TopBar, links, subject region, RunHeader, rail and its ten
 *   steps, narration, RunStrip, the stage's <main> and the announcer are the same nodes after a tour of every view,
 *   and a MutationObserver saw none of them removed (only stage content is replaced).
 * - Narration Next focuses the stage's [data-primary] button (mouse and keyboard), says the button's own label
 *   (REG 13), and never changes location.hash or history.
 * - The RunHeader's chips are the server's facts (the recorded mode, category version and count, filing certainty,
 *   spending with "Unknown" for an unaccounted charge, text held), repeated in the Run facts sheet.
 * - The RunStrip appears when the RunHeader scrolls out of view, and goes when it is back; at 390 px, where the TopBar
 *   wraps to two rows, it still appears once the header is behind the TopBar and sits right under it.
 * - The browser gate (no folder access): the local steps are gated, viewing still works, nothing is sent.
 * - No horizontal overflow at 390 px in dark mode, on every kind of view; old light preferences still render dark.
 * Part B mounts the shell's rail and narration with journey() fixtures and every shared component (SPEC §7.1) on a lab
 * page (a virtual module in the Vite root, as in 00-dom-lab and 01b-state-lab):
 * - The rail renders each §2.2 status (upcoming, current, done, attention, blocked, skipped) as journey() says, with
 *   its node mark, link or disabled span, reason and words; the compact form and the Set up line; M2 honesty.
 * - Each component's catalogue states: ActionSlot, Notice, Chip, Disclosure, Timestamp, Track, OutcomePill,
 *   ShowControl, SearchBox, FolderPick, RadioCards, MoneyField, ConfirmSheet, DefinitionCard, JudgedAgainst.
 * Part C (a profile of its own, because its injected 500s are console errors by design): subject addresses whose
 * resolution meets a failure never stay on a loading stage — a failed fresh status read waits for the next read; a
 * `#/new` that cannot begin a draft shows the Fallback with its problem.
 *
 * Evidence: .local/qa/ui-rebuild/01c-shell-lab.json and PNGs (01c-shell-lab-*.png).
 */
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createFakeApi, fakeApiMiddleware } from '../ui-harness/fake-api.mjs';
import { APP_ROOT, REPO_ROOT, isAppFile, launchEdgeProfile, servingAllowList, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { noHorizontalOverflow, watchMutations } from '../ui-harness/dom.mjs';

const SCRIPT = '01c-shell-lab';
const LAB_PAGE = '/__shell-lab.html';
const LAB_MODULE = '/__shell-lab.ts';
const LAB_FILE = path.join(APP_ROOT, '__shell-lab.ts');
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

// ================================================================================================================
// The lab page (Part B). Runs in the browser; `m` holds the real modules.
// ================================================================================================================
function labMain(m) {
  const { signal, computed } = m.reactive;
  const { h, mount } = m.dom;
  const copy = m.projectCopy.activeUiCopy;
  const operations = m.operations.createOperations();
  m.action.configureActions({
    operations, presentError: (error, context) => m.errorCopy.presentError(error, context),
    phrase: phrase => m.journey.phraseText(phrase, copy),
    copy: { whyUnavailable: copy.common.whyUnavailable, at: copy.common.at, stillWorking: copy.common.stillWorking, details: copy.details },
    time: m.format.time, confirmSheet: m.confirmSheet.openConfirmSheet
  });
  const byTestId = id => document.querySelector(`[data-testid="${id}"]`);
  const section = (name, ...children) => h('section', { class: 'lab-section', testid: `cat-${name}` }, h('h2', null, name), ...children);

  // --- Journey fixtures (placeholder content only) ---------------------------------------------------------------
  const NOW = Date.now();
  const facts = over => ({
    now: NOW, viewing: null,
    setup: { ready: true, blockerCodes: [], categoriesActive: true, canEdit: true, definitionMode: 'runtime' },
    draft: null, run: null,
    local: { buildStarted: false, buildComplete: false, walk: 'none' },
    corrections: { count: 0, latestId: null, improvable: false }, improve: { keptAsIs: false, activatedRevisionId: null },
    answers: { marks: 0, savedReferenceId: null, savedRevisionId: null },
    activeRevisionId: 'rev-4', runRevisionId: 'rev-4', activeVersion: 4, nextRun: null, ...over
  });
  const run = over => ({
    id: 'run-7', status: 'complete', total: 5, uploaded: 5, undispatched: 0, decided: 5, filed: 2, review: 2, couldNotProcess: 1,
    storageSetAsides: 0, stopCode: null, send: { kind: 'not-applicable' }, sortQuiet: false, sendState: 'idle', ...over
  });
  const draft = over => ({ localId: 'local-1', frozenRunId: null, intentPending: false, scan: 'done', looked: 0, total: 5, settled: 5, failed: 1, duplicates: 0, ...over });
  const built = { buildStarted: true, buildComplete: true, walk: 'saved' };
  const FIXTURES = {
    sorting: facts({ viewing: 'progress', run: run({ status: 'running', total: 114, uploaded: 114, decided: 83, filed: 60, review: 23, couldNotProcess: 0 }) }),
    complete: facts({ viewing: 'progress', run: run() }),
    stalled: facts({ viewing: 'progress', run: run({ status: 'uploading', total: 114, uploaded: 13, undispatched: 13, decided: 0, filed: 0, review: 0, couldNotProcess: 0,
      send: { kind: 'upload-stalled', since: NOW - 2_460_000, remaining: 101, canContinueHere: true } }) }),
    discarded: facts({ viewing: 'progress', run: run({ status: 'closed', total: 114, uploaded: 114, decided: 40, filed: 30, review: 10, couldNotProcess: 0 }) }),
    setupBlocked: facts({ viewing: 'confirm', draft: draft(), setup: { ready: false, blockerCodes: ['E_MODEL_CALLS_DISABLED'], categoriesActive: true, canEdit: true, definitionMode: 'runtime' } }),
    keptAsIs: facts({ viewing: 'improve', run: run(), local: built, corrections: { count: 1, latestId: 'c-1', improvable: true }, improve: { keptAsIs: true, activatedRevisionId: null } }),
    allDone: facts({ viewing: 'improve', run: run(), local: built, corrections: { count: 1, latestId: 'c-1', improvable: true }, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' },
      nextRun: { id: 'run-10', name: 'Run 10', status: 'complete', decided: 5, total: 5 } }),
    setupFirst: facts({ draft: draft({ scan: 'none', total: 0, settled: 0, failed: 0 }), setup: { ready: false, blockerCodes: ['E_DEFINITIONS_EMPTY'], categoriesActive: false, canEdit: true, definitionMode: 'runtime' } })
  };
  const railSubject = signal({ kind: 'run', runId: 'run-7' });
  const railState = signal({ state: 'loading' });
  const railStore = { route: signal({ view: 'progress', runId: 'run-7' }),
    runStore: () => ({ view: () => railState().state === 'ready' ? { ...railState().facts.run, campaign: null } : null }) };
  const railHost = document.getElementById('rail');
  mount(railHost, () => h('div', { class: 'wrap' },
    m.rail.journeyRail({ store: railStore, subject: railSubject, journey: railState }),
    m.narration.narrationStrip({ store: railStore, subject: railSubject, journey: railState })));
  const lab = { ready: true };
  lab.rail = {
    names: () => Object.keys(FIXTURES),
    show(name, subjectId = 'run-7') {
      const f = FIXTURES[name];
      const view = m.journey.journey(f);
      // In the app the subject and its journey both follow the route, so they change in one flush: so here.
      m.reactive.batch(() => {
        railSubject.set({ kind: 'run', runId: subjectId });
        railState.set({ state: 'ready', facts: f, view });
      });
      return { rule: view.rule, current: view.current, steps: view.steps.map(step => ({ id: step.id, status: step.status,
        href: step.href, reason: step.reason ? m.journey.phraseText(step.reason, copy) : null })) };
    },
    loading() { railState.set({ state: 'loading' }); return true; },
    read() {
      const rail = railHost.querySelector('.rail');
      return {
        busy: rail.getAttribute('aria-busy'), instant: rail.classList.contains('rail--instant'),
        chaptersHidden: rail.querySelector('.rail__chapters').hidden, setupHidden: rail.querySelector('.rail__setup').hidden,
        setupText: rail.querySelector('.rail__setup').textContent.trim(),
        compact: rail.querySelector('.rail__compact-text').textContent.trim(),
        compactAriaHidden: rail.querySelector('.rail__compact').getAttribute('aria-hidden'),
        pipsAriaHidden: rail.querySelector('.rail__compact .pips').getAttribute('aria-hidden'),
        pips: [...rail.querySelectorAll('.pip')].map(pip => pip.className),
        overlines: [...rail.querySelectorAll('.rail__overline')].map(el => el.textContent.trim()),
        steps: [...rail.querySelectorAll('li.rail-item')].map(li => {
          const inner = li.querySelector('.step__in'), tip = li.querySelector('.step__tip'), node = li.querySelector('.step__node');
          const markEl = node.querySelector('svg');
          return {
            id: li.dataset.step, status: li.dataset.status, className: li.className, lit: li.classList.contains('is-lit'),
            tag: inner.tagName.toLowerCase(), href: inner.getAttribute('href'), current: inner.getAttribute('aria-current'),
            disabled: inner.getAttribute('aria-disabled'), tabindex: inner.getAttribute('tabindex'),
            describedBy: inner.getAttribute('aria-describedby'), tipId: tip.id, tip: tip.textContent.trim(), tipHidden: tip.hidden,
            mark: markEl ? (markEl.getAttribute('data-glyph') ?? [...markEl.classList].find(c => c.startsWith('rail-mark--'))) : null,
            markHidden: markEl ? markEl.getAttribute('aria-hidden') : null,
            nodeText: node.textContent.trim(), label: li.querySelector('.step__label').textContent.trim(),
            words: li.querySelector('.visually-hidden').textContent.trim()
          };
        }),
        narration: { now: railHost.querySelector('[data-testid="shell-narration-now"]').textContent.trim(),
          next: railHost.querySelector('.narration__next').hidden ? null : railHost.querySelector('[data-testid="shell-narration-next"]').textContent.trim() }
      };
    },
    finishAnimations() { for (const a of document.getAnimations()) a.finish(); return document.getAnimations().length; },
    animations: () => document.getAnimations().filter(a => a.effect?.target?.closest?.('#rail')).map(a => a.constructor.name)
  };

  // --- Components (SPEC §7.1) --------------------------------------------------------------------------------------
  const catHost = document.getElementById('catalogue');
  const cat = {};
  mount(catHost, () => {
    // ActionSlot: nothing, then A; A's success hands its position to B.
    const slotSpec = signal(null);
    const b = { id: 'lab:second:one', label: 'Second', kind: 'primary', primary: true, run: async fb => fb.done('Second done') };
    const a = { id: 'lab:first:one', label: 'First', kind: 'primary', primary: true, run: async fb => { fb.done('First done', { handoff: b.id }); slotSpec.set(b); } };
    cat.slot = { setA: () => { slotSpec.set(a); return true; }, clear: () => { slotSpec.set(null); return true; } };
    const slot = m.actionSlot.actionSlot(slotSpec, { testid: 'lab-slot' });

    // Notice
    const notices = [
      m.notice.notice({ kind: 'info', headline: 'Information headline', testid: 'lab-notice-info' }),
      m.notice.notice({ kind: 'problem', headline: 'Problem headline', action: 'What to do', technical: { code: 'E_LAB' }, testid: 'lab-notice-problem' }),
      m.notice.notice({ kind: 'blocker', headline: 'Blocker headline', link: { text: 'Open System', href: '#/system' }, testid: 'lab-notice-blocker' }),
      m.notice.errorNotice(m.errorCopy.presentError(new TypeError('Failed to fetch'), 'read'), 'problem', 'lab-notice-error')
    ];

    // Chip
    const chipValue = signal(null);
    cat.chip = { set: value => { chipValue.set(value); return true; } };
    const chips = h('div', { class: 'lab-row' },
      m.chip.chip({ label: 'Pending', value: chipValue, testid: 'lab-chip-pending' }),
      m.chip.chip({ label: 'Plain', value: signal('Interactive'), testid: 'lab-chip-plain' }),
      m.chip.chip({ label: 'Dashed', value: signal('Filing certainty 90% · untested'), style: 'dashed', testid: 'lab-chip-dashed' }),
      m.chip.chip({ label: 'Accent', value: signal('Filing certainty 97% · confirmed'), style: 'accent', testid: 'lab-chip-accent' }),
      m.chip.chip({ label: 'Glyph', value: signal('Filing certainty 90% · unverified'), style: 'dashed', glyph: 'caution', testid: 'lab-chip-glyph' }));

    // Disclosure
    let built = 0;
    const disclosures = h('div', null,
      m.disclosure.disclosure({ summary: 'Lazy', id: 'lab-lazy', content: () => { built++; return h('p', { testid: 'lab-lazy-content' }, 'Built on open'); }, testid: 'lab-disclosure-lazy' }),
      m.disclosure.disclosure({ summary: 'Technical', technical: true, open: true, content: () => h('pre', null, '{"code":"E_LAB"}'), testid: 'lab-disclosure-technical' }));
    cat.disclosure = { built: () => built };

    // Timestamp
    const at = signal(null);
    const minute = signal(Date.now());
    cat.timestamp = { set: (value, now) => { at.set(value); minute.set(now); return true; } };
    const stamps = h('div', { class: 'lab-row' },
      m.timestamp.timestamp({ at, testid: 'lab-time' }),
      m.timestamp.timestamp({ at, relativeTo: minute, wrap: t => copy.common.checkedAt(t), testid: 'lab-time-relative' }));

    // Track
    const trackDone = signal(0), trackTotal = signal(null), trackState = signal('moving');
    cat.track = {
      set: (done, total, state) => { trackDone.set(done); trackTotal.set(total); trackState.set(state); return true; },
      sweep() {
        const el = byTestId('lab-track').querySelector('.track');
        const records = [];
        const observer = new MutationObserver(list => records.push(...list));
        observer.observe(el, { childList: true, subtree: true, attributes: true });
        const ran = m.motion.sweepOnce(el);
        const pending = observer.takeRecords();
        observer.disconnect();
        return { ran, mutations: records.length + pending.length };
      }
    };
    const tracks = m.track.track({ done: trackDone, total: trackTotal, state: trackState, label: 'Sent', testid: 'lab-track',
      valueText: computed(() => (trackTotal() === null ? copy.common.starting : `${copy.common.ofTotal(trackDone(), trackTotal())} sent`)) });

    // OutcomePill
    const outcome = signal(null), first = signal(false);
    cat.pill = { set: (value, isFirst = false) => { outcome.set(value); first.set(isFirst); return true; } };
    const pills = h('div', { class: 'lab-row' },
      m.outcomePill.outcomePill({ outcome, first, phaseLabel: signal('Reader'), testid: 'lab-pill' }),
      m.outcomePill.outcomePill({ outcome: signal('review'), testid: 'lab-pill-review' }),
      m.outcomePill.outcomePill({ outcome: signal('failed'), testid: 'lab-pill-failed' }));

    // ShowControl
    const showValue = signal('all');
    const showOptions = signal([
      { value: 'all', label: 'All', count: 5 }, { value: 'filed', label: 'Filed', count: 2, dot: 'filed' },
      { value: 'review', label: 'Review', count: 2, dot: 'review' }, { value: 'failed', label: 'Could not process', count: 0, dot: 'failed' },
      { value: 'first', label: 'Review first', count: 1 }, { value: 'moved', label: 'Moved', count: null }
    ]);
    const showChanges = [];
    const show = m.showControl.showControl({ id: 'lab-show', label: 'Show', options: showOptions, value: showValue,
      onChange: value => { showChanges.push(value); showValue.set(value); }, testid: 'lab-show' });
    cat.show = { changes: () => [...showChanges], value: () => showValue.peek(), set: value => { showValue.set(value); return true; } };

    // SearchBox
    const q = signal('');
    const searches = [];
    const search = m.searchBox.searchBox({ id: 'lab-search', label: 'Search documents', value: q, onInput: text => { searches.push(text); q.set(text); }, testid: 'lab-search' });
    cat.search = { calls: () => [...searches], set: text => { q.set(text); return true; } };

    // FolderPick
    const pickState = signal({ kind: 'none' }), remembered = signal(null), busy = signal(null);
    let choose = 0;
    // A FolderPick that is the view's primary: its one filled [data-primary] button follows the (async) offer.
    const primaryRemembered = signal(null);
    cat.folder = {
      set: (state, rememberedName, busyKey) => {
        pickState.set(state); remembered.set(rememberedName ? { name: rememberedName } : null);
        busy.set(busyKey ? { key: busyKey } : null); return true;
      },
      setPrimaryOffer: name => { primaryRemembered.set(name ? { name } : null); return true; },
      chooseCalls: () => choose
    };
    const folderPrimary = m.folderPick.folderPick({
      id: 'lab:reviewed:run-7', purpose: 'reviewed', explanation: 'Choose the folder that holds your sorted copies.',
      state: signal({ kind: 'none' }), remembered: primaryRemembered, primary: true, useLabel: name => `Use '${name}'`,
      chooseLabel: 'Choose the sorted folder', onUseRemembered: async fb => fb.done('Using it'), onChoose: async fb => fb.done('Chosen'),
      testid: 'lab-folder-primary'
    });
    const folder = m.folderPick.folderPick({
      id: 'lab:originals:run-7', purpose: 'originals', explanation: 'Choose the folder that holds the original files.',
      state: pickState, remembered, busy, useLabel: name => `Use '${name}' again`, chooseLabel: 'Choose a different folder',
      onUseRemembered: async fb => fb.done('Using it'),
      onChoose: async fb => { choose++; fb.problem(new DOMException('The request is not allowed.', 'NotAllowedError'), 'build'); },
      testid: 'lab-folder'
    });

    // RadioCards
    const mode = signal(null);
    const chosen = [];
    const radios = m.radioCards.radioCards({ name: 'lab-mode', legend: 'How to run it', value: mode,
      onChoose: value => { chosen.push(value); mode.set(value); }, testid: 'lab-radios',
      options: [
        { value: 'interactive', title: 'Interactive', detail: 'Each document is sorted as soon as it arrives.' },
        { value: 'batch', title: 'Batch', groupLabel: 'Other option', disabledReason: 'Paused while it is being checked.' }
      ] });
    // A caller that does not record the choice (for example a frozen draft refusing it): the radio must not stay checked.
    const refusedValue = signal(null);
    const refused = [];
    const radiosRefusing = m.radioCards.radioCards({ name: 'lab-refuse', legend: 'How to run it', value: refusedValue,
      onChoose: value => { refused.push(value); }, testid: 'lab-radios-refusing',
      options: [{ value: 'interactive', title: 'Interactive' }, { value: 'other', title: 'Other' }] });
    cat.radios = { chosen: () => [...chosen], value: () => mode.peek(), refused: () => [...refused], refusedValue: () => refusedValue.peek() };

    // MoneyField
    const money = signal('');
    const moneyError = computed(() => (m.moneyField.amountProblem(money()) === null ? null : 'Enter an amount in dollars, like 5 or 2.50.'));
    const moneyInput = m.moneyField.moneyField({ id: 'lab-money', label: 'Stop this run if spending reaches', value: money, onInput: text => money.set(text),
      error: moneyError, hint: 'Leave it empty for no overall limit.', testid: 'lab-money' });
    cat.money = { problems: texts => texts.map(text => m.moneyField.amountProblem(text)) };

    // ConfirmSheet (through an ActionBlock, as every irreversible action uses it)
    let sheetRuns = 0;
    const sheetAction = m.action.action({ id: 'lab:stop:all', label: 'Stop all runs…', kind: 'secondary',
      confirm: { title: 'Stop all runs for everyone?', lines: ['This stops every run that is sending or sorting.', 'Stopped runs can’t be continued.'],
        confirmLabel: 'Stop all runs', checkbox: 'I understand this affects everyone.' },
      run: async fb => { sheetRuns++; fb.done('Stopped all runs'); } });
    cat.sheet = { runs: () => sheetRuns, open: () => Boolean(m.confirmSheet.currentSheet()) };

    // DefinitionCard and JudgedAgainst
    const procedures = { id: 'procedures', name: 'Procedures', what: 'Step-by-step instructions for a task. Not slides that explain a topic, which are Explainers.',
      not_for: 'Slide decks that mainly explain a topic belong in Explainers. Reports belong elsewhere.', examples: ['A checklist.', 'A how-to guide that names Explainers.'] };
    const explainers = { id: 'explainers', name: 'Explainers', what: 'Material that explains a topic.', not_for: 'Step-by-step Procedures.', examples: ['Week 3 slides.'] };
    const confusion = signal('10 moved out → Explainers');
    const definition = m.definitionCard.definitionCard({ type: procedures, displayName: 'Procedures', neighbours: ['Explainers'], confusion, testid: 'lab-definition' });
    const judged = m.judgedAgainst.judgedAgainst({ left: { label: copy.evidence.systemPlaced, type: procedures, displayName: 'Procedures' },
      right: { label: copy.evidence.youPlaced, type: explainers, displayName: 'Explainers' }, testid: 'lab-judged' });
    const judgedSingle = m.judgedAgainst.judgedAgainst({ left: { label: copy.evidence.systemPlaced, type: explainers, displayName: 'Explainers' }, testid: 'lab-judged-single' });

    return h('div', { class: 'wrap lab-catalogue' },
      section('action-slot', slot), section('notice', ...notices), section('chip', chips), section('disclosure', disclosures),
      section('timestamp', stamps), section('track', tracks), section('outcome-pill', pills), section('show-control', show),
      section('search-box', search), section('folder-pick', folder, folderPrimary), section('radio-cards', radios, radiosRefusing),
      section('money-field', moneyInput),
      section('confirm-sheet', sheetAction), section('definition-card', definition), section('judged-against', judged, judgedSingle));
  });
  lab.cat = cat;
  lab.animationsOf = testid => document.getAnimations().filter(a => {
    const target = a.effect?.target;
    return target instanceof Element && target.closest(`[data-testid="${testid}"]`);
  }).length;
  window.lab = lab;
}

const LAB_SOURCE = [
  "import './styles/tokens.css';",
  "import './styles/motion.css';",
  "import './styles/base.css';",
  "import * as reactive from '../../core/ui/reactive.ts';",
  "import * as journey from '../../core/ui/journey.ts';",
  "import * as projectCopy from '../../core/ui/project-copy.ts';",
  "import * as errorCopy from '../../core/ui/error-copy.ts';",
  "import * as format from '../../core/ui/format.ts';",
  "import * as dom from './view/dom.ts';",
  "import * as action from './view/action.ts';",
  "import * as motion from './view/motion.ts';",
  "import * as operations from './state/operations.ts';",
  "import * as rail from './shell/journey-rail.ts';",
  "import * as narration from './shell/narration.ts';",
  "import * as actionSlot from './components/action-slot.ts';",
  "import * as notice from './components/notice.ts';",
  "import * as chip from './components/chip.ts';",
  "import * as disclosure from './components/disclosure.ts';",
  "import * as timestamp from './components/timestamp.ts';",
  "import * as track from './components/track.ts';",
  "import * as outcomePill from './components/outcome-pill.ts';",
  "import * as showControl from './components/show-control.ts';",
  "import * as searchBox from './components/search-box.ts';",
  "import * as folderPick from './components/folder-pick.ts';",
  "import * as radioCards from './components/radio-cards.ts';",
  "import * as moneyField from './components/money-field.ts';",
  "import * as confirmSheet from './components/confirm-sheet.ts';",
  "import * as definitionCard from './components/definition-card.ts';",
  "import * as judgedAgainst from './components/judged-against.ts';",
  `(${labMain.toString()})({ reactive, journey, projectCopy, errorCopy, format, dom, action, motion, operations, rail, narration,
    actionSlot, notice, chip, disclosure, timestamp, track, outcomePill, showControl, searchBox, folderPick, radioCards, moneyField,
    confirmSheet, definitionCard, judgedAgainst });`
].join('\n');

const LAB_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shell lab</title><link rel="icon" href="data:,">
<style>.lab-section { margin: 24px 0; display: grid; gap: 12px; } .lab-row { display: flex; flex-wrap: wrap; gap: 8px; }</style>
</head><body><main id="main"><h1>Shell lab</h1><div id="rail"></div><div id="catalogue"></div></main>
<script type="module" src="${LAB_MODULE}"></script></body></html>`;

const labPlugin = {
  name: 'shell-lab',
  enforce: 'pre',
  resolveId(id) { return id === LAB_MODULE ? LAB_FILE : null; },
  load(id) { return same(id.split('?')[0], LAB_FILE) ? LAB_SOURCE : null; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== LAB_PAGE) return next();
      try {
        const html = await server.transformIndexHtml(LAB_PAGE, LAB_HTML);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(html);
      } catch (error) {
        next(error);
      }
    });
  }
};

/** The harness's app server (scripts/ui-harness/app.mjs startApp), plus the lab page; the fake can be swapped. */
async function startLabApp(initial) {
  let current = initial;
  const server = await createServer({
    configFile: false, root: APP_ROOT, appType: 'spa', logLevel: 'error', clearScreen: false,
    cacheDir: path.join(os.tmpdir(), 'doc-classifier-ui-harness-vite'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, fs: { allow: servingAllowList() } },
    worker: { format: 'es' },
    optimizeDeps: { include: ['@zip.js/zip.js', 'fast-xml-parser', 'pdfjs-dist'] },
    plugins: [labPlugin, {
      name: 'ui-harness-fake-api',
      configureServer(dev) { dev.middlewares.use(fakeApiMiddleware(() => current, { passThrough: url => isAppFile(url, APP_ROOT) })); }
    }]
  });
  await server.listen();
  const address = server.httpServer?.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, url: hash => `${origin}/${hash}`, setFake: fake => { current = fake; }, close: () => server.close() };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await runScript(SCRIPT, 'SPEC §11 WP-6 acceptance (shell lab)', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  fake.categories();
  const complete = fake.completed({});
  const sorting = fake.sorting({ total: 12, decided: 5 });
  // A Batch run with a charge not accounted for: its chips must show the recorded mode and "Unknown" spending.
  const unknownSpend = fake.completed({ mode: 'batch', unaccountedCalls: 1 });
  const app = await startLabApp(fake);
  defer(() => app.close());
  evidence.app = { origin: app.origin, vite: viteVersion,
    runs: { complete: complete.runId, sorting: sorting.runId, unknownSpend: unknownSpend.runId } };

  const profile = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  defer(() => profile.close());
  const context = profile.context;
  const watch = watchContext(context, { origin: app.origin, root: APP_ROOT });
  const page = context.pages()[0] ?? await context.newPage();

  const until = async (target, fn, arg, what, timeout = 10_000) => {
    const started = Date.now();
    for (;;) {
      const value = await target.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  };
  const shapeIs = (shape, screen) => until(page, ([s, k]) => {
    const stage = document.querySelector('[data-seam-shape]');
    return stage?.getAttribute('data-seam-shape') === s && (k === null || stage.getAttribute('data-screen') === k);
  }, [shape, screen ?? null], `the stage for ${shape}`);
  const go = async (hash, shape, screen) => {
    await page.evaluate(h => { location.hash = h; }, hash);
    await shapeIs(shape, screen);
  };

  // ==============================================================================================================
  // Part A: the real app
  // ==============================================================================================================
  await page.goto(app.url('#/'));
  await shapeIs('home', 'home');

  // --- A1: shell nodes survive a tour of every view ------------------------------------------------------------
  const SHELL = ['shell', 'shell-skip', 'shell-topbar', 'shell-brand', 'shell-nav', 'shell-setup', 'shell-run-strip',
    'shell-subject', 'shell-run-header', 'shell-run-name', 'shell-chips', 'shell-run-status', 'seam-checked', 'seam-read-problem',
    'shell-rail', 'shell-narration', 'shell-narration-now', 'shell-narration-next', 'shell-stage'];
  await page.evaluate(ids => {
    window.__shell = ids.map(id => [id, document.querySelector(`[data-testid="${id}"]`)]);
    window.__shell.push(['announcer', document.querySelector('[data-announcer]')]);
    for (const step of document.querySelectorAll('[data-testid="shell-rail"] li.rail-item')) window.__shell.push([`step:${step.dataset.step}`, step]);
    window.__stages = new Set();
    window.__removedShell = [];
    const shellNodes = () => window.__shell.map(([, node]) => node).filter(Boolean);
    window.__shellObserver = new MutationObserver(list => {
      for (const record of list) for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        for (const shellNode of shellNodes()) if (node === shellNode || node.contains(shellNode))
          window.__removedShell.push(`${node.tagName.toLowerCase()} ${node.getAttribute('data-testid') ?? ''}`);
        if (node.getAttribute('data-testid') === 'stage') window.__stages.add(node.getAttribute('data-seam-shape'));
      }
    });
    window.__shellObserver.observe(document.getElementById('app'), { childList: true, subtree: true });
  }, SHELL);
  const found = await page.evaluate(() => window.__shell.filter(([, node]) => node === null).map(([id]) => id));
  checks.check('every shell region exists once mounted (TopBar, links, subject, RunHeader, rail with 8 steps, narration, strip, stage, announcer)',
    found.length === 0 && await page.evaluate(() => window.__shell.length) === SHELL.length + 1 + 8, found);
  const tour = [
    ['#/runs', 'runs', 'runs'], [`#/run/${complete.runId}/progress`, `progress:${complete.runId}`, 'progress'],
    [`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results'], [`#/run/${complete.runId}/build`, `build:${complete.runId}`, 'build'],
    [`#/run/${complete.runId}/review`, `review:${complete.runId}`, 'review'], [`#/run/${complete.runId}/improve`, `improve:${complete.runId}`, 'improve'],
    [`#/run/${complete.runId}/compare`, `compare:${complete.runId}`, 'compare'], [`#/run/${sorting.runId}/progress`, `progress:${sorting.runId}`, 'progress'],
    ['#/categories', 'categories', 'categories'], ['#/categories/edit', 'category-edit', 'category-editor'],
    [`#/categories/edit?from=${complete.runId}`, 'category-edit', 'category-editor'], ['#/system', 'system', 'system'], ['#/help', 'help', 'help'],
    ['#/nope', 'unknown', 'fallback'], [`#/run/${complete.runId}`, `results:${complete.runId}`, 'results'], ['#/', 'home', 'home']
  ];
  const visited = [];
  for (const [hash, shape, screen] of tour) {
    await go(hash, shape, screen);
    visited.push(await page.evaluate(() => ({ hash: location.hash, shape: document.querySelector('[data-seam-shape]')?.getAttribute('data-seam-shape'),
      screen: document.querySelector('[data-seam-shape]')?.getAttribute('data-screen'), subjectHidden: document.querySelector('[data-testid="shell-subject"]').hidden })));
  }
  await page.evaluate(() => { location.hash = '#/new'; });
  await until(page, () => /^#\/new\/[^/]+\/files$/.test(location.hash) && document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === 'files', null, 'a new draft');
  visited.push(await page.evaluate(() => ({ hash: location.hash, screen: document.querySelector('[data-seam-shape]')?.getAttribute('data-screen'),
    subjectHidden: document.querySelector('[data-testid="shell-subject"]').hidden })));
  await go('#/', 'home', 'home');
  const persistence = await page.evaluate(ids => {
    const missing = [], moved = [];
    for (const [id, node] of window.__shell) {
      if (!node || !node.isConnected) missing.push(id);
      else if (!id.startsWith('step:') && id !== 'announcer' && document.querySelector(`[data-testid="${id}"]`) !== node) moved.push(id);
    }
    window.__shellObserver.disconnect();
    return { missing, moved, removedShell: window.__removedShell, stagesReplaced: [...window.__stages] };
  }, SHELL);
  evidence.tour = { visited, persistence };
  checks.check('the tour reached every view: each route shape mounted its screen (run-less views hide the subject, run views show it)',
    visited.every((v, i) => i === visited.length - 1 || v.screen === tour[i][2]) &&
    visited.find(v => v.screen === 'progress')?.subjectHidden === false && visited.find(v => v.screen === 'system')?.subjectHidden === true &&
    visited.find(v => v.hash.includes('edit?from='))?.subjectHidden === false && visited.at(-1).screen === 'files' && visited.at(-1).subjectHidden === false,
    visited);
  checks.check('#/run/<id> resolves through journey() to the run\'s view (a complete run with no build → Results)',
    visited.find(v => v.hash === `#/run/${complete.runId}/results` && v.screen === 'results') !== undefined, visited);
  checks.check('shell nodes are never removed across route changes (MutationObserver: 0 shell removals; same nodes after the tour)',
    persistence.missing.length === 0 && persistence.moved.length === 0 && persistence.removedShell.length === 0 && persistence.stagesReplaced.length >= 10,
    persistence);

  // --- A2: narration Next → [data-primary] ------------------------------------------------------------------------
  await go(`#/run/${complete.runId}/progress`, `progress:${complete.runId}`, 'progress');
  await until(page, () => document.querySelector('#main [data-primary]') !== null && !document.querySelector('.narration__next').hidden, null, 'the primary and Next');
  const before = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
  await page.click('[data-testid="shell-narration-next"]');
  const afterClick = await page.evaluate(() => ({
    hash: location.hash, length: history.length, focusedPrimary: document.activeElement?.hasAttribute('data-primary') ?? false,
    focused: document.activeElement?.textContent?.trim() ?? null, next: document.querySelector('[data-testid="shell-narration-next"]').textContent.trim(),
    primary: document.querySelector('#main [data-primary]')?.textContent?.trim() ?? null, primaries: document.querySelectorAll('[data-primary]').length
  }));
  await page.evaluate(() => document.querySelector('[data-testid="shell-narration-next"]').focus());
  await page.keyboard.press('Enter');
  const afterKey = await page.evaluate(() => ({ hash: location.hash, length: history.length, focusedPrimary: document.activeElement?.hasAttribute('data-primary') ?? false }));
  evidence.narrationNext = { before, afterClick, afterKey };
  checks.check('narration Next focuses [data-primary] (click and keyboard) and never changes location.hash or history',
    afterClick.focusedPrimary && afterKey.focusedPrimary && afterClick.hash === before.hash && afterKey.hash === before.hash &&
    afterClick.length === before.length && afterKey.length === before.length, evidence.narrationNext);
  checks.check('Next says the primary\'s own label (REG 13), and the view has exactly one [data-primary]',
    afterClick.next === afterClick.primary && afterClick.primary !== null && afterClick.primaries === 1, afterClick);
  // The primary really goes where Next says: a route-link primary navigates (pushState), and focus goes to the new h1.
  await page.keyboard.press('Enter');
  await shapeIs(`results:${complete.runId}`, 'results');
  const landed = await page.evaluate(() => ({ focusH1: document.activeElement?.tagName === 'H1', hash: location.hash, length: history.length }));
  checks.check('the primary navigates to its view with a history entry, and focus moves to the new h1 (SPEC §2.6 rule 4)',
    landed.focusH1 && landed.length === before.length + 1, landed);

  // --- A2b: links, Back and Forward move focus too (the router's hashchange/popstate path, not a click handler) --------
  // The router writes the route and then the move's record; outside a click handler they arrive in two flushes, so a
  // stage that read the record only while mounting would focus nothing (or act on the previous move).
  const focusState = () => page.evaluate(() => {
    const h1 = document.querySelector('#main h1');
    return { focusH1: document.activeElement === h1 && h1 !== null, h1: h1?.textContent.trim() ?? null,
      active: document.activeElement ? `${document.activeElement.tagName.toLowerCase()} ${document.activeElement.getAttribute('data-nav') ?? ''}`.trim() : null,
      announced: document.querySelector('[data-announcer]')?.textContent ?? '' };
  });
  const announcedFor = async what => {
    try {
      await until(page, () => {
        const h1 = document.querySelector('#main h1')?.textContent.trim() ?? '';
        return h1 !== '' && document.querySelector('[data-announcer]')?.textContent === `Now showing: ${h1}`;
      }, null, what, 3_000);
    } catch { /* recorded by the check below */ }
    return focusState();
  };
  const moves = {};
  await page.click('[data-testid="shell-nav"] [data-nav="runs"]');
  await shapeIs('runs', 'runs');
  moves.navLink = await announcedFor('the Runs link announcement');
  await page.goBack();
  await shapeIs(`results:${complete.runId}`, 'results');
  moves.back = await announcedFor('the Back announcement');
  await page.goForward();
  await shapeIs('runs', 'runs');
  moves.forward = await announcedFor('the Forward announcement');
  await go(`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results');
  await until(page, () => document.querySelector('[data-testid="shell-rail"] [data-step="sort"] a.step__in') !== null, null, 'the rail link to Sort');
  await page.click('[data-testid="shell-rail"] [data-step="sort"] a.step__in');
  await shapeIs(`progress:${complete.runId}`, 'progress');
  moves.railLink = await announcedFor('the rail link announcement');
  // A query change keeps the shape: no remount, and focus stays where the person put it.
  await go(`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results');
  await page.focus('[data-testid="shell-nav"] [data-nav="categories"]');
  const stageBefore = await page.evaluate(() => { window.__stageNode = document.querySelector('[data-testid="stage"]'); return true; });
  await page.evaluate(h => { location.hash = h; }, `#/run/${complete.runId}/results?q=week`);
  await until(page, h => location.hash === h, `#/run/${complete.runId}/results?q=week`, 'the query change');
  await sleep(100);
  moves.query = { ...(await focusState()), sameStage: stageBefore && await page.evaluate(() => document.querySelector('[data-testid="stage"]') === window.__stageNode) };
  await go(`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results');
  evidence.linkMoves = moves;
  checks.check('a link, Back and Forward move focus to the new h1 and announce "Now showing: ‹that h1›" (SPEC §2.6 rule 4, §5.4)',
    ['navLink', 'back', 'forward', 'railLink'].every(k => moves[k].focusH1 && moves[k].announced === `Now showing: ${moves[k].h1}`), moves);
  checks.check('a query change in place keeps focus where it was and does not remount the stage',
    moves.query.sameStage && moves.query.active === 'a categories' && !moves.query.focusH1, moves.query);

  // --- A2c: Live updates in the RunHeader (SPEC §2.1, §4.5; WCAG 2.2.2) ---------------------------------------------
  const liveRead = () => page.evaluate(() => {
    const button = document.querySelector('[data-testid="shell-live"]');
    const paused = document.querySelector('[data-testid="shell-live-paused"]');
    return { hidden: button.hidden, pressed: button.getAttribute('aria-pressed'), label: button.textContent.trim(),
      paused: paused === null ? null : paused.textContent.replace(/\s+/g, ' ').trim() };
  });
  const statusReadsOf = id => fake.requests.filter(r => r.method === 'GET' && r.path === `/api/runs/${id}/status`).length;
  const liveCase = { complete: await liveRead() };
  await go(`#/run/${sorting.runId}/progress`, `progress:${sorting.runId}`, 'progress');
  await until(page, () => !document.querySelector('[data-testid="shell-live"]').hidden, null, 'the Live updates toggle');
  liveCase.on = await liveRead();
  await page.click('[data-testid="shell-live"]');
  liveCase.off = await liveRead();
  const pausedFrom = statusReadsOf(sorting.runId);
  await sleep(4_000);
  liveCase.readsWhilePaused = statusReadsOf(sorting.runId) - pausedFrom;
  const resumeFrom = statusReadsOf(sorting.runId);
  await page.click('[data-testid="shell-live-paused"] button');
  liveCase.resumedReadMs = null;
  for (const started = Date.now(); Date.now() - started < 2_000; await sleep(20)) {
    if (statusReadsOf(sorting.runId) > resumeFrom) { liveCase.resumedReadMs = Date.now() - started; break; }
  }
  liveCase.resumed = await liveRead();
  await go(`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results');
  evidence.live = liveCase;
  checks.check('Live updates: shown only while the run is live; pressed; turning it off shows "Live updates paused at HH:MM:SS · Resume"',
    liveCase.complete.hidden && !liveCase.on.hidden && liveCase.on.pressed === 'true' && liveCase.on.label === 'Live updates' && liveCase.on.paused === null &&
    liveCase.off.pressed === 'false' && /^Live updates paused at \d\d:\d\d:\d\d ?· ?Resume$/.test(liveCase.off.paused ?? ''), liveCase);
  checks.check('Live updates off: no status read for 4 s (view polling paused); Resume reads at once and the toggle is on again',
    liveCase.readsWhilePaused === 0 && liveCase.resumedReadMs !== null && liveCase.resumed.pressed === 'true' && liveCase.resumed.paused === null, liveCase);

  // --- A2d: the RunHeader's chips are the server's facts (SPEC §2.1, §7.2, §0.1 rule 4) ---------------------------
  const chipsOf = () => page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="shell-chips"] li')].filter(li => !li.hidden);
    return {
      chips: Object.fromEntries(items.map(li => [li.dataset.chip, { text: li.querySelector('.chip__text')?.textContent ?? null,
        style: li.querySelector('.chip')?.dataset.chipStyle ?? null }])),
      setup: document.querySelector('[data-testid="shell-setup"] .setup-word__text')?.textContent.trim() ?? null
    };
  });
  const chipsReady = what => until(page, () => {
    const items = [...document.querySelectorAll('[data-testid="shell-chips"] li')].filter(li => !li.hidden);
    return items.length >= 1 && items.every(li => li.querySelector('.chip__text')?.textContent !== '…');
  }, null, what);
  await go(`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results');
  await chipsReady('the chips of the complete run');
  const chipsComplete = await chipsOf();
  await page.click('[data-testid="shell-run-facts"] > summary');
  const factsSheet = await until(page, () => {
    const dl = document.querySelector('[data-testid="shell-run-facts"] .run-facts');
    return dl ? [...dl.querySelectorAll('dd')].map(dd => dd.textContent.trim()) : null;
  }, null, 'the run facts sheet');
  await page.click('[data-testid="shell-run-facts"] > summary');
  await go(`#/run/${unknownSpend.runId}/results`, `results:${unknownSpend.runId}`, 'results');
  await chipsReady('the chips of the Batch run with an unaccounted charge');
  const chipsUnknown = await chipsOf();
  await go(`#/run/${complete.runId}/results`, `results:${complete.runId}`, 'results');
  evidence.runHeader = { chipsComplete, factsSheet, chipsUnknown };
  // The calm header (owner, 6 October 2026): one chip, the spending rounded to cents; the rest in Run facts.
  checks.check('RunHeader chips: only the spending, rounded to cents; no mode, categories, filing, text-held or lineage chip; setup chip "Ready"',
    Object.keys(chipsComplete.chips).join() === 'spending' && /^Spent \$\d+\.\d\d$/.test(chipsComplete.chips.spending?.text ?? '') &&
    chipsComplete.setup === 'Ready', chipsComplete);
  checks.check('an unaccounted charge makes the spending chip "Unknown" with the known part stated, rounded to cents',
    Object.keys(chipsUnknown.chips).join() === 'spending' && /^Spent: Unknown \(\$\d+\.\d\d known\)$/.test(chipsUnknown.chips.spending?.text ?? ''), chipsUnknown);
  checks.check('the Run facts sheet holds the mode the service recorded, the category version and count, the filing certainty with its status, the exact spending and whether text is held',
    factsSheet.includes('Interactive') && factsSheet.some(f => /^Categories version \d+ · 4$/.test(f)) && factsSheet.some(f => /^Filing certainty \d+% · untested$/.test(f)) &&
    factsSheet.some(f => /^Spent \$\d+\.\d+ of \$5\.00$/.test(f)) && factsSheet.includes('Text in the cloud: yes'), { chips: chipsComplete.chips, factsSheet });

  // --- A3: RunStrip on scroll --------------------------------------------------------------------------------------
  // A long view: the spacer goes inside the stage, where a long screen's content would be.
  await page.evaluate(() => { const spacer = document.createElement('div'); spacer.id = 'lab-spacer'; spacer.style.setProperty('height', '3000px'); document.querySelector('[data-testid="stage"]').append(spacer); });
  const stripTop = await page.evaluate(() => ({ hidden: document.querySelector('[data-testid="shell-run-strip"]').hidden, children: document.querySelector('[data-testid="shell-run-strip"]').childElementCount }));
  await page.evaluate(() => window.scrollTo(0, 1500));
  await until(page, () => !document.querySelector('[data-testid="shell-run-strip"]').hidden, null, 'the RunStrip');
  const stripShown = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="shell-run-strip"]');
    const box = strip.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="shell-topbar"]').getBoundingClientRect();
    return { text: strip.textContent.replace(/\s+/g, ' ').trim(), top: Math.round(box.top), height: Math.round(box.height),
      topbarTop: Math.round(bar.top), topbarBottom: Math.round(bar.bottom), name: document.querySelector('[data-testid="shell-run-name"]').textContent.trim() };
  });
  evidence.stripShot = await screenshot(page, `${SCRIPT}-strip`, { fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 0));
  await until(page, () => document.querySelector('[data-testid="shell-run-strip"]').hidden, null, 'the RunStrip to go');
  // Below 760 px the TopBar wraps to two rows (the links go to a second row), so it is taller than 56 px. The strip
  // must still sit right under it, not behind it, and must appear as soon as the header is behind the taller TopBar.
  await page.setViewportSize({ width: 390, height: 844 });
  let stripNarrow = null;
  try {
    await until(page, () => document.querySelector('[data-testid="shell-run-strip"]').hidden, null, 'the RunStrip hidden at 390 px');
    const narrowAt = await page.evaluate(() => ({
      topbarBottom: document.querySelector('[data-testid="shell-topbar"]').getBoundingClientRect().bottom,
      headerBottom: document.querySelector('[data-testid="shell-run-header"]').getBoundingClientRect().bottom
    }));
    // The header's bottom edge 4 px behind the TopBar's bottom edge.
    await page.evaluate(y => window.scrollTo(0, y), Math.ceil(narrowAt.headerBottom - narrowAt.topbarBottom + 4));
    await until(page, () => !document.querySelector('[data-testid="shell-run-strip"]').hidden, null, 'the RunStrip at 390 px', 3_000);
    stripNarrow = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="shell-run-strip"]').getBoundingClientRect();
      const bar = document.querySelector('[data-testid="shell-topbar"]').getBoundingClientRect();
      const nav = document.querySelector('[data-testid="shell-nav"]').getBoundingClientRect();
      return { stripTop: Math.round(strip.top), stripHeight: Math.round(strip.height), topbarTop: Math.round(bar.top),
        topbarBottom: Math.round(bar.bottom), navBottom: Math.round(nav.bottom) };
    });
  } catch (error) {
    stripNarrow = { error: error.message };
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1280, height: 900 });
  await until(page, () => document.querySelector('[data-testid="shell-run-strip"]').hidden, null, 'the RunStrip to go at 1280 px');
  await page.evaluate(() => document.getElementById('lab-spacer').remove());
  evidence.runStrip = { stripTop, stripShown, stripNarrow };
  checks.check('the RunStrip appears under the TopBar when the RunHeader scrolls out of view, with name, step and checked time; it goes when back',
    stripTop.hidden && stripTop.children === 0 && stripShown.text.includes(stripShown.name) && /Step \d+ of 8/.test(stripShown.text) &&
    // The TopBar is at least --topbar-h (64 px in VISUAL-SPEC-v2, plus its cornice line); the strip sits right under it.
    /Checked \d\d:\d\d:\d\d/.test(stripShown.text) && stripShown.top >= 60 && stripShown.top <= 70 && stripShown.topbarTop === 0 &&
    Math.abs(stripShown.topbarBottom - stripShown.top) <= 2, evidence.runStrip);
  // The Sorting Room: at 390 px the TopBar is one row (the links move to the bottom bar), so it is shorter than 64 px.
  checks.check('at 390 px the RunStrip appears once the header is behind the TopBar, and sits right under it',
    stripNarrow !== null && stripNarrow.error === undefined && stripNarrow.topbarTop === 0 && stripNarrow.topbarBottom >= 50 &&
    Math.abs(stripNarrow.topbarBottom - stripNarrow.stripTop) <= 2 && stripNarrow.navBottom <= stripNarrow.stripTop + 1 &&
    stripNarrow.stripHeight >= 38, stripNarrow);

  // Dark remains the product theme even after an old saved/system-light preference.
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await page.waitForSelector('[data-testid="stage"] h1');
  checks.check('old saved/system-light preferences still render dark, with no theme switch',
    await page.evaluate(() => document.documentElement.dataset.theme === 'dark' &&
      getComputedStyle(document.documentElement).colorScheme === 'dark' && !document.querySelector('[data-testid="shell-theme"]')));
  // Motion always runs (DECISIONS 155 addendum, 10 October 2026): the TopBar offers no Motion switch; script 42 checks
  // the motion itself.
  const motionSwitch = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="shell-topbar"]');
    return { switches: bar.querySelectorAll('[role="switch"], [data-motion]').length, noMotion: document.documentElement.classList.contains('no-motion') };
  });
  checks.check('the TopBar has no Motion switch and <html> never carries no-motion', motionSwitch.switches === 0 && !motionSwitch.noMotion, motionSwitch);
  // --- A4: overflow at 390 px, dark-only responsive layout ----------------------------------------
  const overflow = [];
  const views = [['#/', 'home'], [`#/run/${complete.runId}/progress`, `progress:${complete.runId}`], [`#/run/${sorting.runId}/results`, `results:${sorting.runId}`],
    ['#/system', 'system'], ['#/nope', 'unknown'], ['#/categories', 'categories']];
  await page.setViewportSize({ width: 390, height: 844 });
  let compact = null;
  for (const theme of ['dark']) {
    for (const [hash, shape] of views) {
      await go(hash, shape);
      await sleep(150);
      const result = await noHorizontalOverflow(page);
      overflow.push({ theme, hash, ...result });
      if (hash === `#/run/${complete.runId}/progress`) {
        evidence[`shot390${theme}`] = await screenshot(page, `${SCRIPT}-390-${theme}`);
        await until(page, () => /^Step \d+ of 8 · /.test(document.querySelector('.rail__compact-text')?.textContent.trim() ?? ''), null, 'the compact rail');
        await sleep(700);
        compact = await page.evaluate(() => {
          const rail = document.querySelector('[data-testid="shell-rail"]'), now = rail.querySelector('.step.now');
          const r = rail.getBoundingClientRect(), n = now?.getBoundingClientRect();
          return { direction: getComputedStyle(rail).flexDirection, steps: rail.querySelectorAll('li.rail-item').length,
            nowVisible: n !== undefined && n.left >= r.left - 1 && n.right <= r.right + 1, label: now?.textContent.trim() ?? null,
            ariaHidden: rail.closest('[aria-hidden="true"]') !== null };
        });
      }
    }
  }
  evidence.overflow = overflow;
  checks.check('no horizontal overflow at 390 px on any view, in dark mode', overflow.every(o => o.ok), overflow.filter(o => !o.ok));
  // The Sorting Room: below 980 px the ledger is one scrolling row with the current step scrolled into view.
  checks.check('at 390 px the ledger is one row of all 8 steps, the current step in view, readable by assistive technology',
    compact !== null && compact.direction === 'row' && compact.steps === 8 && compact.nowVisible && compact.ariaHidden === false, compact);
  await page.setViewportSize({ width: 1280, height: 900 });
  evidence.shotWide = await screenshot(page, `${SCRIPT}-1280`);

  // --- A5: the browser gate (local actions only) -------------------------------------------------------------------
  const other = await launchEdgeProfile({ viewport: { width: 1280, height: 900 }, userAgent: FIREFOX_UA });
  defer(() => other.close());
  const otherWatch = watchContext(other.context, { origin: app.origin, root: APP_ROOT });
  const firefox = other.context.pages()[0] ?? await other.context.newPage();
  const mark = fake.requests.length;
  const gateViews = [];
  for (const [hash, expected] of [['#/new', 'browser-gate'], [`#/run/${complete.runId}/build`, 'browser-gate'], [`#/run/${complete.runId}/review`, 'browser-gate'],
    [`#/run/${complete.runId}/results`, 'results'], [`#/run/${complete.runId}/progress`, 'progress'], ['#/', 'home'], ['#/help', 'help']]) {
    await firefox.goto(app.url(hash));
    let screen = null;
    try {
      screen = await until(firefox, want => {
        const s = document.querySelector('[data-seam-shape]')?.getAttribute('data-screen');
        return s === want ? s : null;
      }, expected, `${hash} in the other browser`);
    } catch {
      screen = await firefox.evaluate(() => document.querySelector('[data-seam-shape]')?.getAttribute('data-screen') ?? null);
    }
    gateViews.push({ hash, expected, screen, h1: await firefox.evaluate(() => document.querySelector('#main h1')?.textContent.trim() ?? null) });
  }
  const browserWrites = fake.requests.slice(mark).filter(r => r.method !== 'GET');
  evidence.browserGate = { gateViews, writes: browserWrites.map(r => `${r.method} ${r.path}`), console: otherWatch.record.consoleErrors };
  checks.check('without folder access the local steps (files, build, review) show the browser gate; results, progress, Home and Help still show',
    gateViews.every(v => v.screen === v.expected) && gateViews.filter(v => v.expected === 'browser-gate').every(v => v.h1 === 'Use Chrome or Edge'), gateViews);
  checks.check('the browser gate sends nothing (no state-changing request)', browserWrites.length === 0, evidence.browserGate.writes);
  await other.close();

  // --- Hygiene of Part A ----------------------------------------------------------------------------------------
  evidence.partA = watch.summary();
  checks.check('Part A: no page errors and no console errors', watch.record.pageErrors.length === 0 && watch.record.consoleErrors.length === 0,
    { pageErrors: watch.record.pageErrors, consoleErrors: watch.record.consoleErrors });
  checks.check('Part A: zero requests to any origin other than the app\'s, and no state-changing request',
    watch.record.external.length === 0 && fake.requests.every(r => r.method === 'GET'), { external: watch.record.external,
      writes: fake.requests.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path}`) });
  checks.check('Part A: every fake answer matched the wire contract (strict check)', fake.problems.length === 0, fake.problems);

  // ==============================================================================================================
  // Part B: rail fixtures and the component catalogue
  // ==============================================================================================================
  const lab = await context.newPage();
  const labErrors = [];
  lab.on('pageerror', error => labErrors.push(error.message));
  lab.on('console', message => { if (message.type() === 'error') labErrors.push(message.text()); });
  await lab.goto(`${app.origin}${LAB_PAGE}`);
  await until(lab, () => window.lab?.ready === true, null, 'the lab page', 20_000);
  const L = (name, ...args) => lab.evaluate(([n, a]) => {
    const parts = n.split('.');
    const fn = parts.reduce((obj, key) => obj[key], window.lab);
    const self = parts.slice(0, -1).reduce((obj, key) => obj[key], window.lab);
    return fn.apply(self, a);
  }, [name, args]);

  // --- B1: every §2.2 status -------------------------------------------------------------------------------------
  const loading = await L('rail.read');
  checks.check('before facts arrive the rail is busy and says "Checking…" (never a guessed step)', loading.busy === 'true' && loading.compact === 'Checking…' && loading.narration.now === 'Checking…', loading);
  const statusSeen = new Set();
  const railCases = [];
  const MARK = { done: 'check', attention: 'rail-mark--bang', blocked: 'rail-mark--lock', skipped: 'rail-mark--dash' };
  const WORDS = { upcoming: 'not available yet', current: 'current step', done: 'done', attention: 'needs attention', blocked: 'blocked', skipped: 'skipped' };
  for (const name of ['sorting', 'complete', 'stalled', 'discarded', 'setupBlocked', 'keptAsIs', 'allDone']) {
    const expected = await L('rail.show', name, `run-${name}`);
    const shown = await L('rail.read');
    const problems = [];
    expected.steps.forEach((step, i) => {
      const dom = shown.steps[i];
      statusSeen.add(step.status);
      if (dom.id !== step.id || dom.status !== step.status || !dom.className.includes(`step--${step.status}`)) problems.push(`${step.id}: status ${dom.status} ≠ ${step.status}`);
      if (step.href !== null && (dom.tag !== 'a' || dom.href !== step.href)) problems.push(`${step.id}: should link to ${step.href}`);
      if (step.href === null && (dom.tag !== 'span' || dom.disabled !== 'true' || dom.tabindex !== '0')) problems.push(`${step.id}: should be a focusable aria-disabled span`);
      if ((dom.current === 'step') !== (step.id === expected.current)) problems.push(`${step.id}: aria-current`);
      if (step.reason !== null && (dom.tip !== step.reason || dom.describedBy !== dom.tipId || dom.tipHidden)) problems.push(`${step.id}: reason "${dom.tip}"`);
      if (step.reason === null && !dom.tipHidden) problems.push(`${step.id}: a tip without a reason`);
      const wantMark = MARK[step.status] ?? null;
      if (wantMark !== null ? dom.mark !== wantMark || dom.markHidden !== 'true' : dom.nodeText !== String(i + 1)) problems.push(`${step.id}: node ${dom.mark ?? dom.nodeText}`);
      if (!dom.words.endsWith(WORDS[step.status])) problems.push(`${step.id}: words "${dom.words}"`);
    });
    const currentIndex = expected.steps.findIndex(step => step.id === expected.current);
    if (!shown.compact.startsWith(`Step ${currentIndex + 1} of 8 · `)) problems.push(`compact "${shown.compact}"`);
    railCases.push({ name, rule: expected.rule, statuses: expected.steps.map(s => s.status).join(' '), problems, narration: shown.narration });
  }
  evidence.rail = railCases;
  // No journey row emits `skipped` since the Improve step became an optional area (6 October 2026); the mark is kept.
  checks.check('the rail renders every §2.2 status from journey() fixtures: upcoming, current, done, attention, blocked',
    ['upcoming', 'current', 'done', 'attention', 'blocked'].every(s => statusSeen.has(s)) && railCases.every(c => c.problems.length === 0),
    railCases.filter(c => c.problems.length) );
  checks.check('each status has its mark and words: a check (done), "!" (attention), a lock (blocked), a dash (skipped), the number otherwise',
    railCases.every(c => c.problems.every(p => !p.includes('node') && !p.includes('words'))), railCases.map(c => c.problems));
  checks.check('the rail\'s chapter overlines are the four journey chapters', eq((await L('rail.read')).overlines, ['Your files', 'Start', 'Sorting', 'Your folders']),
    (await L('rail.read')).overlines);
  await L('rail.show', 'setupFirst', 'run-setup');
  const setupRail = await L('rail.read');
  checks.check('before the first run with no categories the rail is one line: "Before your first run: set up categories"',
    setupRail.chaptersHidden && setupRail.setupHidden === false && setupRail.setupText.startsWith('Before your first run: set up categories'), setupRail);
  // Below 640 px the compact rail is the only rail on screen: its sentence must reach assistive technology.
  checks.check('the compact rail\'s "Step n of 8 · Label" is readable by assistive technology (only the pips are aria-hidden)',
    loading.compactAriaHidden === null && loading.pipsAriaHidden === 'true', { compact: loading.compactAriaHidden, pips: loading.pipsAriaHidden });
  // M2: the same subject advancing animates the connector; a new subject does not.
  await L('rail.show', 'sorting', 'run-m2');
  await L('rail.finishAnimations');
  await L('rail.show', 'complete', 'run-m2');
  const advancing = await L('rail.animations');
  await L('rail.finishAnimations');
  await L('rail.show', 'sorting', 'run-other');
  const switching = await L('rail.animations');
  evidence.m2 = { advancing, switching };
  checks.check('M2: a step that was current turning done in this session moves the connector; a change of subject applies without motion',
    advancing.length > 0 && switching.length === 0, evidence.m2);

  // --- B2: the component catalogue --------------------------------------------------------------------------------
  const q = (selector, fn) => lab.evaluate(([s, f]) => { const el = document.querySelector(s); return el ? new Function('el', `return (${f})(el);`)(el) : null; }, [selector, fn.toString()]);
  const cat = {};

  // ActionSlot
  cat.slotEmpty = await q('[data-testid="lab-slot"]', el => ({ buttons: el.querySelectorAll('button').length }));
  await L('cat.slot.setA');
  const slotNode = await lab.evaluate(() => { window.__slot = document.querySelector('[data-testid="lab-slot"]'); return window.__slot.querySelectorAll('button[data-op]').length; });
  await lab.click('button[data-op="lab:first:one"]');
  await until(lab, () => document.querySelector('button[data-op="lab:second:one"]') !== null && document.activeElement?.getAttribute('data-op') === 'lab:second:one', null, 'the handoff');
  cat.slotHandoff = await lab.evaluate(() => {
    const slot = document.querySelector('[data-testid="lab-slot"]');
    return { same: slot === window.__slot, ops: [...slot.querySelectorAll('button[data-op]')].map(b => b.dataset.op),
      focused: document.activeElement?.dataset.op ?? null, message: slot.querySelector('[data-feedback] .feedback__status')?.textContent.trim() ?? '' };
  });
  checks.check('ActionSlot: empty for no spec; success hands its position to the next action, with the message and focus',
    cat.slotEmpty.buttons === 0 && slotNode === 1 && cat.slotHandoff.same && eq(cat.slotHandoff.ops, ['lab:second:one']) &&
    cat.slotHandoff.focused === 'lab:second:one' && cat.slotHandoff.message.startsWith('First done'), { empty: cat.slotEmpty, handoff: cat.slotHandoff });

  // Notice
  cat.notice = await lab.evaluate(() => ['info', 'problem', 'blocker', 'error'].map(kind => {
    const el = document.querySelector(`[data-testid="lab-notice-${kind}"]`);
    return { kind, role: el.getAttribute('role'), classes: el.className, glyph: el.querySelector('svg')?.getAttribute('data-glyph'),
      headline: el.querySelector('.notice__headline')?.textContent.trim(), action: el.querySelector('.notice__action')?.textContent.trim() ?? null,
      technical: el.querySelector('details[data-technical]') !== null, link: el.querySelector('.notice__link')?.getAttribute('href') ?? null };
  }));
  const [info, problem, blocker, network] = cat.notice;
  checks.check('Notice: info and problem are not live, a blocker is role=alert; glyph and words (never an outcome colour); technical in Details',
    info.role === null && problem.role === null && blocker.role === 'alert' && info.glyph === 'info' && problem.glyph === 'problem' &&
    problem.technical && !info.technical && blocker.link === '#/system' && network.headline.length > 0 && network.technical, cat.notice);

  // Chip
  cat.chipPending = await q('[data-testid="lab-chip-pending"]', el => ({ text: el.querySelector('.chip__text').textContent, busy: el.getAttribute('aria-busy') }));
  await L('cat.chip.set', 'Batch');
  cat.chips = await lab.evaluate(() => ['pending', 'plain', 'dashed', 'accent', 'glyph'].map(name => {
    const el = document.querySelector(`[data-testid="lab-chip-${name}"]`);
    return { name, text: el.querySelector('.chip__text').textContent, style: el.dataset.chipStyle, busy: el.getAttribute('aria-busy'),
      label: el.querySelector('.visually-hidden')?.textContent.trim(), glyph: el.querySelector('svg')?.getAttribute('data-glyph') ?? null };
  }));
  checks.check('Chip: "…" while unknown (aria-busy), then its text; plain, dashed and accent styles; a glyph where given; text labels throughout',
    cat.chipPending.text === '…' && cat.chipPending.busy === 'true' && cat.chips[0].text === 'Batch' && cat.chips[0].busy === null &&
    eq(cat.chips.map(c => c.style), ['plain', 'plain', 'dashed', 'accent', 'dashed']) && cat.chips[4].glyph === 'caution' &&
    cat.chips.every(c => c.label), { pending: cat.chipPending, chips: cat.chips });

  // Disclosure
  const lazyBefore = await q('[data-testid="lab-disclosure-lazy"]', el => ({ open: el.open, content: el.querySelector('[data-testid="lab-lazy-content"]') !== null, id: el.getAttribute('data-disclosure') }));
  await lab.click('[data-testid="lab-disclosure-lazy"] > summary');
  await until(lab, () => document.querySelector('[data-testid="lab-lazy-content"]') !== null, null, 'the lazy content');
  const lazyAfter = await q('[data-testid="lab-disclosure-lazy"]', el => ({ open: el.open, content: el.querySelector('[data-testid="lab-lazy-content"]') !== null }));
  const technical = await q('[data-testid="lab-disclosure-technical"]', el => ({ open: el.open, technical: el.hasAttribute('data-technical'), summary: el.querySelector('summary').textContent.trim() }));
  const builds = await L('cat.disclosure.built');
  cat.disclosure = { lazyBefore, lazyAfter, technical, builds };
  checks.check('Disclosure: content is built on first opening (lazy), keeps its view-state id; a technical one is data-technical and can start open',
    !lazyBefore.open && !lazyBefore.content && lazyBefore.id === 'lab-lazy' && lazyAfter.open && lazyAfter.content && builds === 1 &&
    technical.open && technical.technical, cat.disclosure);

  // Timestamp
  const unknownTime = await q('[data-testid="lab-time"]', el => ({ text: el.textContent.trim(), datetime: el.querySelector('time').getAttribute('datetime') }));
  const stampAt = Date.UTC(2026, 8, 25, 12, 0, 0);
  await L('cat.timestamp.set', stampAt, stampAt + 41 * 60_000);
  const knownTime = await q('[data-testid="lab-time"]', el => ({ text: el.textContent.trim(), datetime: el.querySelector('time').getAttribute('datetime') }));
  const relativeTime = await q('[data-testid="lab-time-relative"]', el => el.textContent.trim());
  cat.timestamp = { unknownTime, knownTime, relativeTime };
  checks.check('Timestamp: "Unknown" with no datetime when missing; <time datetime> with the local time; the relative part from the minute clock',
    unknownTime.text === 'Unknown' && unknownTime.datetime === null && knownTime.datetime === new Date(stampAt).toISOString() &&
    /^\d\d:\d\d:\d\d$/.test(knownTime.text) && /^Checked \d\d:\d\d:\d\d · 41 min ago$/.test(relativeTime), cat.timestamp);

  // Track
  const trackRead = () => q('[data-testid="lab-track"]', el => {
    const bar = el.querySelector('.track'), head = el.querySelector('.track__head');
    return { state: bar.dataset.state, valuenow: bar.getAttribute('aria-valuenow'), valuemax: bar.getAttribute('aria-valuemax'),
      valuetext: bar.getAttribute('aria-valuetext'), busy: bar.getAttribute('aria-busy'), role: bar.getAttribute('role'), fill: bar.style.getPropertyValue('--fill'),
      head: getComputedStyle(head).display, caption: el.querySelector('.track__caption').textContent.trim(),
      sweep: bar.querySelector(':scope > .motion-sweep') !== null, host: bar.classList.contains('motion-sweep-host') };
  });
  const tracks = {};
  tracks.loading = await trackRead();
  for (const [name, args] of [['empty', [0, 10, 'moving']], ['moving', [3, 10, 'moving']], ['still', [3, 10, 'still']], ['stalled', [3, 10, 'stalled']],
    ['waiting', [3, 10, 'waiting']], ['done', [10, 10, 'moving']]]) {
    await L('cat.track.set', ...args);
    tracks[name] = await trackRead();
  }
  await L('cat.track.set', 4, 10, 'moving');
  tracks.sweep = await L('cat.track.sweep');
  cat.track = tracks;
  checks.check('Track: "Starting…" with no total (no value); "0 of N"; the fill at n/N with the head while moving; no head when still, stalled or done',
    tracks.loading.state === 'loading' && tracks.loading.valuenow === null && tracks.loading.busy === 'true' && tracks.loading.caption === 'Starting…' &&
    tracks.empty.caption === '0 of 10' && tracks.empty.valuenow === '0' && tracks.moving.fill === '0.3' && tracks.moving.head === 'block' &&
    tracks.still.head === 'none' && tracks.stalled.state === 'stalled' && tracks.stalled.head === 'none' && tracks.waiting.state === 'waiting' &&
    tracks.done.state === 'done' && tracks.done.head === 'none' && tracks.done.fill === '1', tracks);
  checks.check('Track: role=progressbar with aria-valuemin/max/now/valuetext; the M5 sweep head is pre-rendered, so a sweep changes no DOM',
    tracks.moving.role === 'progressbar' && tracks.moving.valuemax === '10' && tracks.moving.valuenow === '3' && tracks.moving.valuetext === '3 of 10 sent' &&
    tracks.moving.sweep && tracks.moving.host && tracks.sweep.ran === true && tracks.sweep.mutations === 0, { moving: tracks.moving, sweep: tracks.sweep });

  // OutcomePill
  const pillRead = testid => q(`[data-testid="${testid}"]`, el => ({ classes: el.className, word: el.querySelector('.pill__word').textContent.trim(),
    glyph: el.querySelector('svg')?.getAttribute('data-glyph') ?? null, outcome: el.dataset.outcome ?? null,
    first: el.parentElement.querySelector('.first-tag')?.textContent.trim() ?? null }));
  const pills = { phase: await pillRead('lab-pill') };
  await L('rail.finishAnimations');
  await L('cat.pill.set', 'filed', true);
  pills.landedAnimations = await lab.evaluate(() => document.getAnimations().filter(a => a.effect?.target?.dataset?.testid === 'lab-pill').length);
  pills.filed = await pillRead('lab-pill');
  pills.review = await pillRead('lab-pill-review');
  pills.failed = await pillRead('lab-pill-failed');
  cat.pills = pills;
  checks.check('OutcomePill: a neutral phase pill before an outcome; word plus glyph (check, person, slash) after; "Review first" as text; M7 fade only on arrival',
    pills.phase.classes.includes('pill--phase') && pills.phase.word === 'Reader' && pills.phase.glyph === null &&
    pills.filed.classes.includes('pill--filed') && pills.filed.word === 'Filed' && pills.filed.glyph === 'check' && pills.filed.first === 'Review first' &&
    pills.review.word === 'Review' && pills.review.glyph === 'person' && pills.failed.word === 'Could not process' && pills.failed.glyph === 'slash' &&
    pills.landedAnimations === 1, pills);

  // ShowControl
  const showRead = () => q('[data-testid="lab-show"]', el => ({
    role: el.getAttribute('role'), options: [...el.querySelectorAll('[role="radio"]')].map(b => ({ value: b.dataset.value, checked: b.getAttribute('aria-checked'),
      disabled: b.disabled, tabindex: b.getAttribute('tabindex'), text: b.textContent.trim() })),
    width: getComputedStyle(el.querySelector('.show__bar')).getPropertyValue('--w').trim(), ready: el.querySelector('.show__bar').classList.contains('is-ready')
  }));
  const showInitial = await showRead();
  const showAnimationsAtLoad = await L('animationsOf', 'lab-show');
  await lab.focus('[data-testid="lab-show"] [data-value="all"]');
  await lab.keyboard.press('ArrowRight');
  await lab.keyboard.press('ArrowRight');
  const afterTwo = await L('cat.show.value');
  await lab.keyboard.press('ArrowRight');
  const skipped = await L('cat.show.value');
  const showSlide = await L('animationsOf', 'lab-show');
  const showFocus = await lab.evaluate(() => document.activeElement?.dataset.value ?? null);
  cat.show = { showInitial, showAnimationsAtLoad, afterTwo, skipped, showSlide, showFocus };
  checks.check('ShowControl: a radiogroup of radios with counts; 0 disabled; an unknown count not shown as 0; arrows move and skip disabled options',
    showInitial.role === 'radiogroup' && showInitial.options[0].checked === 'true' && showInitial.options[0].tabindex === '0' &&
    showInitial.options[3].disabled && showInitial.options[5].text === 'Moved' && afterTwo === 'review' && skipped === 'first' && showFocus === 'first', cat.show);
  checks.check('ShowControl M8: the indicator is placed without motion on load and slides when the person changes the filter',
    Number(showInitial.width) > 0 && showInitial.ready && showAnimationsAtLoad === 0 && showSlide > 0, cat.show);
  // The chosen filter can have a count of 0 (for example from the address): the group must still have a tab stop.
  await L('cat.show.set', 'failed');
  const showDisabledChosen = await showRead();
  await L('cat.show.set', 'first');
  cat.showDisabledChosen = showDisabledChosen;
  checks.check('ShowControl: when the chosen option has 0 (disabled), the first enabled option is the tab stop, so the group stays reachable',
    showDisabledChosen.options.find(o => o.value === 'failed')?.checked === 'true' && showDisabledChosen.options.find(o => o.value === 'failed')?.disabled === true &&
    eq(showDisabledChosen.options.filter(o => o.tabindex === '0').map(o => o.value), ['all']), showDisabledChosen);

  // SearchBox
  await lab.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await lab.keyboard.press('/');
  const searchFocused = await lab.evaluate(() => document.activeElement?.id ?? null);
  await lab.keyboard.type('week', { delay: 10 });
  const callsWhileTyping = (await L('cat.search.calls')).length;
  await until(lab, () => window.lab.cat.search.calls().length > 0, null, 'the debounced search');
  await sleep(150);
  const searchCalls = await L('cat.search.calls');
  const searchLabel = await q('[data-testid="lab-search"]', el => ({ type: el.type, labelled: document.querySelector('label[for="lab-search"]')?.textContent.trim() }));
  cat.search = { searchFocused, callsWhileTyping, searchCalls, searchLabel };
  checks.check('SearchBox: a labelled type=search input; "/" focuses it; typing reaches onInput once, debounced after the last key',
    searchFocused === 'lab-search' && callsWhileTyping === 0 && eq(searchCalls, ['week']) && searchLabel.type === 'search' && searchLabel.labelled === 'Search documents', cat.search);

  // FolderPick
  const folderRead = () => q('[data-testid="lab-folder"]', el => ({ state: el.dataset.state, status: el.querySelector('.folder-pick__name').textContent.trim(),
    permission: el.querySelector('.folder-pick__permission')?.textContent.trim() ?? null, explain: el.querySelector('.folder-pick__explain').textContent.trim(),
    buttons: [...el.querySelectorAll('button[data-op]')].map(b => ({ op: b.dataset.op, label: b.textContent.trim(), disabled: b.disabled })),
    why: [...el.querySelectorAll('.feedback__why')].map(p => p.textContent.trim()) }));
  const folder = { none: await folderRead() };
  for (const [name, state] of [['checking', { kind: 'checking' }], ['waiting', { kind: 'waiting' }], ['granted', { kind: 'chosen', name: 'Sorted', permission: 'granted' }],
    ['prompt', { kind: 'chosen', name: 'Sorted', permission: 'prompt' }], ['denied', { kind: 'chosen', name: 'Sorted', permission: 'denied' }]]) {
    await L('cat.folder.set', state, null, null);
    folder[name] = await folderRead();
  }
  await L('cat.folder.set', { kind: 'none' }, 'Archive', null);
  folder.remembered = await folderRead();
  await L('cat.folder.set', { kind: 'none' }, 'Archive', 'journey.reason.needsFolder');
  folder.busy = await folderRead();
  await L('cat.folder.set', { kind: 'none' }, null, null);
  await lab.click('button[data-op="lab:originals-choose:run-7"]');
  await until(lab, () => document.querySelector('[data-feedback="lab:originals-choose:run-7"]')?.dataset.state === 'problem', null, 'the permission problem');
  folder.problem = await q('[data-feedback="lab:originals-choose:run-7"]', el => ({ state: el.dataset.state, headline: el.querySelector('.notice__headline')?.textContent.trim() }));
  cat.folder = folder;
  checks.check('FolderPick: explained before the dialog; "Not chosen yet", checking, waiting, the chosen name with its permission (granted, needs asking, denied)',
    folder.none.status === 'Not chosen yet' && folder.none.explain.length > 0 && folder.checking.status === 'Checking permission…' &&
    folder.waiting.status === 'Waiting for your browser…' && folder.granted.status === 'Chosen: Sorted' && folder.granted.permission !== null &&
    folder.prompt.permission !== folder.granted.permission && folder.denied.permission !== folder.prompt.permission && folder.none.buttons.length === 1, folder);
  checks.check('FolderPick: a remembered folder is an offer (its own button), disabled with the reason while busy; a permission problem lands in its slot',
    folder.remembered.buttons.length === 2 && folder.remembered.buttons[0].label === "Use 'Archive' again" && folder.busy.buttons.every(b => b.disabled) &&
    folder.busy.why.length === 2 && folder.problem.state === 'problem' && (folder.problem.headline ?? '').length > 0, folder);
  // As a view's primary: exactly one filled [data-primary] button, "Choose" alone and the offer once it arrives (async).
  const primaryRead = () => q('[data-testid="lab-folder-primary"]', el => ({
    buttons: [...el.querySelectorAll('button[data-op]')].map(b => ({ op: b.dataset.op, primary: b.hasAttribute('data-primary'), filled: b.classList.contains('btn--primary') }))
  }));
  const folderPrimary = { alone: await primaryRead() };
  await L('cat.folder.setPrimaryOffer', 'Sorted');
  folderPrimary.offered = await primaryRead();
  await L('cat.folder.setPrimaryOffer', null);
  folderPrimary.gone = await primaryRead();
  cat.folderPrimary = folderPrimary;
  const onePrimary = (read, op) => read.buttons.filter(b => b.primary).map(b => b.op).join() === op && read.buttons.filter(b => b.filled).map(b => b.op).join() === op;
  checks.check('FolderPick as the primary: one filled [data-primary] button — "Choose" alone, the remembered offer once it arrives, "Choose" again when it goes',
    onePrimary(folderPrimary.alone, 'lab:reviewed-choose:run-7') && folderPrimary.offered.buttons.length === 2 &&
    onePrimary(folderPrimary.offered, 'lab:reviewed-use:run-7') && onePrimary(folderPrimary.gone, 'lab:reviewed-choose:run-7'), folderPrimary);

  // RadioCards
  const radioRead = () => q('[data-testid="lab-radios"]', el => ({ tag: el.tagName.toLowerCase(), legend: el.querySelector('legend')?.textContent.trim(),
    inputs: [...el.querySelectorAll('input[type="radio"]')].map(i => ({ value: i.value, checked: i.checked, disabled: i.disabled, describedBy: i.getAttribute('aria-describedby') })),
    reason: el.querySelector('.rcard__reason')?.textContent.trim() ?? null, reasonId: el.querySelector('.rcard__reason')?.id ?? null, group: el.querySelector('.cards__group')?.textContent.trim() ?? null }));
  const radiosBefore = await radioRead();
  await lab.click('label[for="lab-mode-interactive"]');
  const firstChoice = await L('cat.radios.chosen');
  await lab.click('label[for="lab-mode-interactive"]');
  const again = await L('cat.radios.chosen');
  await lab.click('label[for="lab-mode-batch"]', { force: true });
  const afterDisabled = await L('cat.radios.chosen');
  const radiosAfter = await radioRead();
  cat.radios = { radiosBefore, firstChoice, again, afterDisabled, radiosAfter };
  checks.check('RadioCards: a fieldset with a legend and nothing selected; a click records the choice, and choosing it again records it again (M2)',
    radiosBefore.tag === 'fieldset' && radiosBefore.legend === 'How to run it' && radiosBefore.inputs.every(i => !i.checked) &&
    firstChoice.length >= 1 && firstChoice.every(v => v === 'interactive') && again.length > firstChoice.length && radiosAfter.inputs[0].checked, cat.radios);
  checks.check('RadioCards: a disabled option shows why beneath it, linked with aria-describedby, and cannot be chosen',
    radiosBefore.inputs[1].disabled && radiosBefore.reason === 'Paused while it is being checked.' &&
    (radiosBefore.inputs[1].describedBy ?? '').split(' ').includes(radiosBefore.reasonId) && afterDisabled.length === again.length &&
    radiosBefore.group === 'Other option', cat.radios);
  // The browser checks a radio before onChoose runs: a choice the caller did not record must not stay shown (M1).
  await lab.click('label[for="lab-refuse-interactive"]');
  const refusedRead = await q('[data-testid="lab-radios-refusing"]', el => [...el.querySelectorAll('input[type="radio"]')].map(i => i.checked));
  cat.radiosRefused = { refusedRead, calls: await L('cat.radios.refused'), value: await L('cat.radios.refusedValue') };
  checks.check('RadioCards: when the caller does not record the choice, no radio stays checked (the radios always show the recorded value)',
    cat.radiosRefused.calls.length >= 1 && cat.radiosRefused.value === null && refusedRead.every(checked => checked === false), cat.radiosRefused);

  // MoneyField
  const moneyRead = () => q('[data-testid="lab-money"]', el => ({ inputmode: el.getAttribute('inputmode'), invalid: el.getAttribute('aria-invalid'),
    describedBy: el.getAttribute('aria-describedby'), error: document.getElementById('lab-money-error')?.textContent.trim() ?? null,
    hint: document.getElementById('lab-money-hint')?.textContent.trim() ?? null, value: el.value }));
  const moneyEmpty = await moneyRead();
  await lab.fill('[data-testid="lab-money"]', '2.5x');
  const moneyBad = await moneyRead();
  await lab.fill('[data-testid="lab-money"]', '2.50');
  const moneyGood = await moneyRead();
  const moneyProblems = await L('cat.money.problems', ['', '5', '2.50', '0', 'abc', '1.1234567891', '-1']);
  cat.money = { moneyEmpty, moneyBad, moneyGood, moneyProblems };
  checks.check('MoneyField: inputmode=decimal; an invalid amount shows its error beneath, linked by aria-describedby, aria-invalid; never a float',
    moneyEmpty.inputmode === 'decimal' && moneyEmpty.error === null && moneyEmpty.invalid === null && moneyBad.invalid === 'true' &&
    (moneyBad.describedBy ?? '').includes('lab-money-error') && moneyBad.error !== null && moneyGood.error === null && moneyGood.value === '2.50' &&
    eq(moneyProblems, [null, null, null, 'invalid', 'invalid', 'invalid', 'invalid']), cat.money);

  // ConfirmSheet
  const trigger = 'button[data-op="lab:stop:all"]';
  await lab.click(trigger);
  await until(lab, () => document.querySelector('dialog.sheet')?.open === true, null, 'the sheet');
  const sheetOpen = await lab.evaluate(() => {
    const dialog = document.querySelector('dialog.sheet');
    return { modal: dialog.matches(':modal'), focusInside: dialog.contains(document.activeElement), focused: document.activeElement?.type ?? null,
      confirmDisabled: dialog.querySelector('[data-sheet="confirm"]').disabled, title: dialog.querySelector('h2').textContent.trim(),
      labelled: dialog.getAttribute('aria-labelledby') === dialog.querySelector('h2').id, primaries: dialog.querySelectorAll('[data-primary]').length };
  });
  await lab.keyboard.press('Escape');
  await until(lab, () => document.querySelector('dialog.sheet') === null, null, 'the sheet to close');
  const sheetEsc = await lab.evaluate(() => ({ focusTrigger: document.activeElement?.dataset.op ?? null, runs: window.lab.cat.sheet.runs() }));
  await lab.click(trigger);
  await until(lab, () => document.querySelector('dialog.sheet')?.open === true, null, 'the sheet again');
  await lab.check('dialog.sheet input[type="checkbox"]');
  const enabled = await lab.evaluate(() => !document.querySelector('dialog.sheet [data-sheet="confirm"]').disabled);
  await lab.click('dialog.sheet [data-sheet="confirm"]');
  await until(lab, () => document.querySelector('[data-feedback="lab:stop:all"]')?.dataset.state === 'done', null, 'the outcome in the trigger\'s slot');
  const sheetDone = await lab.evaluate(() => ({ runs: window.lab.cat.sheet.runs(), dialogs: document.querySelectorAll('dialog').length,
    message: document.querySelector('[data-feedback="lab:stop:all"] .feedback__message')?.textContent.trim() }));
  cat.sheet = { sheetOpen, sheetEsc, enabled, sheetDone };
  checks.check('ConfirmSheet: a modal dialog with focus inside; confirm disabled until the box is ticked; Esc closes it, nothing runs, focus returns to the trigger',
    sheetOpen.modal && sheetOpen.focusInside && sheetOpen.focused === 'checkbox' && sheetOpen.confirmDisabled && sheetOpen.labelled && sheetOpen.primaries === 0 &&
    sheetEsc.focusTrigger === 'lab:stop:all' && sheetEsc.runs === 0, cat.sheet);
  checks.check('ConfirmSheet: confirming runs the action once and its outcome goes to the triggering action\'s own slot; the sheet is gone',
    enabled && sheetDone.runs === 1 && sheetDone.dialogs === 0 && sheetDone.message === 'Stopped all runs', cat.sheet);

  // DefinitionCard and JudgedAgainst
  cat.definition = await q('[data-testid="lab-definition"]', el => ({ tag: el.tagName.toLowerCase(), heading: el.querySelector('h3')?.textContent.trim(),
    labelled: el.getAttribute('aria-labelledby') === el.querySelector('h3')?.id, mentions: [...el.querySelectorAll('.mention')].map(m => m.querySelector('.mention__tag')?.textContent.trim()),
    rule: getComputedStyle(el.querySelector('.mention')).boxShadow, examplesLazy: el.querySelector('.def__example-list') === null,
    folder: el.querySelector('.def__folder')?.textContent.trim(), confusion: el.querySelector('.def__confusion')?.textContent.trim(),
    labels: [...el.querySelectorAll('dt')].map(dt => dt.textContent.trim()) }));
  cat.judged = await lab.evaluate(() => ['lab-judged', 'lab-judged-single'].map(id => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return { articles: el.querySelectorAll(':scope > article').length, labels: [...el.querySelectorAll(':scope > article > h4')].map(h => h.textContent.trim()),
      single: el.classList.contains('judged--single'), leftMentions: [...el.querySelectorAll(':scope > article[data-side="left"] .mention__tag')].map(t => t.textContent.trim()) };
  }));
  checks.check('DefinitionCard: an <article> with a heading; what belongs, what doesn\'t, examples on demand, the folder name and the confusion line',
    cat.definition.tag === 'article' && cat.definition.heading === 'Procedures' && cat.definition.labelled && eq(cat.definition.labels, ['What belongs here', "What doesn't belong here"]) &&
    cat.definition.examplesLazy && cat.definition.folder === 'Folder: procedures' && cat.definition.confusion === '10 moved out → Explainers', cat.definition);
  checks.check('DefinitionCard: the sentences that name the neighbour are marked by a 2px accent rule and the words "names Explainers"',
    cat.definition.mentions.length >= 2 && cat.definition.mentions.every(t => t === 'names Explainers') && cat.definition.rule.includes('inset'), cat.definition);
  checks.check('JudgedAgainst: two articles with headings ("The systems placed it in" / "You placed it in"), each marking the other side; one card when alone',
    cat.judged[0].articles === 2 && eq(cat.judged[0].labels, ['The systems placed it in', 'You placed it in']) && cat.judged[0].leftMentions.includes('names Explainers') &&
    cat.judged[1].articles === 1 && cat.judged[1].single, cat.judged);

  evidence.catalogue = cat;
  evidence.labShot = await screenshot(lab, `${SCRIPT}-catalogue`);
  await lab.emulateMedia({ colorScheme: 'dark' });
  await lab.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  evidence.labShotDark = await screenshot(lab, `${SCRIPT}-catalogue-dark`);
  await lab.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['dark']) {
    await lab.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    // Let a frame pass, so resize observers have answered the new width.
    await lab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await noHorizontalOverflow(lab);
    checks.check(`the component catalogue has no horizontal overflow at 390 px (${theme})`, result.ok, result);
  }
  checks.check('Part B: no page errors and no console errors on the lab page', labErrors.length === 0, labErrors);

  // ==============================================================================================================
  // Part C: subject addresses whose resolution meets a failure — never a loading stage for ever (SPEC §2.6 rule 6).
  // A profile of its own: the injected 500s are console errors by design, so Part A's hygiene is not affected.
  // ==============================================================================================================
  const failing = createFakeApi();
  failing.categories();
  const runA = failing.completed({});
  const runB = failing.completed({});
  const runC = failing.completed({});
  app.setFake(failing);
  const third = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  defer(() => third.close());
  const partC = third.context.pages()[0] ?? await third.context.newPage();
  const partCErrors = [];
  partC.on('pageerror', error => partCErrors.push(error.message));
  await partC.goto(app.url('#/'));
  await until(partC, () => document.querySelector('[data-seam-shape]')?.getAttribute('data-screen') === 'home', null, 'Home in part C');
  const follow = async (hash, want, timeout) => {
    const seen = [];
    let problemShown = false;
    await partC.evaluate(h => { location.hash = h; }, hash);
    const started = Date.now();
    for (;;) {
      const now = await partC.evaluate(() => ({ hash: location.hash, screen: document.querySelector('[data-seam-shape]')?.getAttribute('data-screen') ?? null,
        problem: document.querySelector('[data-testid="seam-read-problem"]')?.hidden === false }));
      problemShown ||= now.problem;
      if (seen.at(-1)?.screen !== now.screen || seen.at(-1)?.hash !== now.hash) seen.push({ hash: now.hash, screen: now.screen, at: Date.now() - started });
      if (now.hash === want && now.screen === 'results') return { ok: true, seen, problemShown };
      if (Date.now() - started > timeout) return { ok: false, seen, problemShown };
      await sleep(50);
    }
  };
  const statusOf = id => ({ method: 'GET', path: `/api/runs/${id}/status` });
  // Only the resolver's fresh read fails (the watch's first read answers, but after the resolver's read was issued, so
  // it is not applied): the resolution waits for the next read instead of stopping.
  failing.failNext(statusOf(runA.runId), 'E_INTERNAL', 'Something failed.', { status: 500, skip: 1 });
  const resolverFailed = await follow(`#/run/${runA.runId}`, `#/run/${runA.runId}/results`, 10_000);
  // Every read fails for a while: the Fallback and the RunHeader show the problem while the watch backs off, then the
  // address resolves by itself once a read answers. Nothing but GETs is sent.
  failing.failNext(statusOf(runB.runId), 'E_INTERNAL', 'Something failed.', { status: 500, times: 3 });
  const allFailed = await follow(`#/run/${runB.runId}`, `#/run/${runB.runId}/results`, 20_000);
  // "Check now" (SPEC §4.5): a failed read shows "Couldn't check for updates at … · next check … · Check now" in the
  // RunHeader; the button reads at once instead of waiting for the backoff, and a good answer clears the line.
  failing.failNext(statusOf(runC.runId), 'E_INTERNAL', 'Something failed.', { status: 500, times: 1 });
  const readsOfC = () => failing.requests.filter(r => r.method === 'GET' && r.path === `/api/runs/${runC.runId}/status`).length;
  await partC.evaluate(h => { location.hash = h; }, `#/run/${runC.runId}/results`);
  await until(partC, () => document.querySelector('[data-testid="seam-read-problem"]')?.hidden === false, null, 'the read problem of run C');
  const checkNow = await partC.evaluate(() => {
    const line = document.querySelector('[data-testid="seam-read-problem"]');
    return { text: line.textContent.replace(/\s+/g, ' ').trim(), nextAt: Date.parse(line.querySelector('time')?.getAttribute('datetime') ?? '') };
  });
  const readsBefore = readsOfC();
  const clickedAt = Date.now();
  await partC.click('[data-testid="shell-check-now"]');
  checkNow.readAfterMs = null;
  for (; Date.now() - clickedAt < 2_500; await sleep(20)) if (readsOfC() > readsBefore) { checkNow.readAfterMs = Date.now() - clickedAt; break; }
  checkNow.readBeforeNextCheck = checkNow.readAfterMs !== null && clickedAt + checkNow.readAfterMs < checkNow.nextAt - 500;
  checkNow.cleared = await until(partC, () => document.querySelector('[data-testid="seam-read-problem"]')?.hidden === true, null, 'the read problem to clear', 5_000)
    .then(() => true, () => false);
  // #/new cannot begin a draft (this browser refuses to store it): the router notes it, and the stage shows the Fallback.
  await partC.evaluate(() => { location.hash = '#/'; });
  await until(partC, () => document.querySelector('[data-seam-shape]')?.getAttribute('data-screen') === 'home', null, 'Home again in part C');
  await partC.evaluate(() => {
    Storage.prototype.setItem = function refuse() { throw new DOMException('This browser refused to store it (lab).', 'QuotaExceededError'); };
    location.hash = '#/new';
  });
  let newFailed = null;
  try {
    await until(partC, () => document.querySelector('[data-seam-shape]')?.getAttribute('data-screen') === 'fallback', null, 'the Fallback for #/new');
  } finally {
    newFailed = await partC.evaluate(() => ({ hash: location.hash, screen: document.querySelector('[data-seam-shape]')?.getAttribute('data-screen') ?? null,
      h1: document.querySelector('#main h1')?.textContent.trim() ?? null, lead: document.querySelector('#main .lead')?.textContent.trim() ?? null,
      primary: document.querySelector('#main [data-primary]')?.textContent.trim() ?? null,
      details: document.querySelector('[data-testid="fallback"] details[data-technical] pre')?.textContent ?? '' }));
  }
  if (newFailed.details === '') {
    // Details are built when the disclosure first opens (its toggle event comes after the click).
    await partC.click('[data-testid="fallback"] details[data-technical] > summary');
    newFailed.details = await until(partC, () => document.querySelector('[data-testid="fallback"] details[data-technical] pre')?.textContent ?? '',
      null, 'the Fallback\'s Details').catch(() => '');
  }
  const partCWrites = failing.requests.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path}`);
  evidence.partC = { resolverFailed, allFailed, checkNow, newFailed, writes: partCWrites, pageErrors: partCErrors };
  checks.check('#/run/<id> still resolves to its view when the resolver\'s fresh status read fails (no endless loading stage)',
    resolverFailed.ok, resolverFailed);
  checks.check('while every read fails the stage shows the Fallback and the RunHeader the problem; the address resolves by itself once a read answers',
    allFailed.ok && allFailed.seen.some(s => s.screen === 'fallback') && allFailed.problemShown, allFailed);
  checks.check('the RunHeader\'s read problem says when and when next, and "Check now" reads at once (before the next check) and clears it',
    /^Couldn't check for updates at \d\d:\d\d:\d\d · next check \d\d:\d\d:\d\d · Check now$/.test(checkNow.text) &&
    checkNow.readBeforeNextCheck && checkNow.cleared, checkNow);
  checks.check('#/new that cannot begin a draft shows the Fallback with its problem and "Go to Home" (never an endless loading stage)',
    newFailed.screen === 'fallback' && newFailed.hash === '#/new' && newFailed.h1 === "This page can't be shown" &&
    newFailed.lead === "The app couldn't get what this page needs." && newFailed.primary === 'Go to Home' &&
    newFailed.details.includes('refused to store it'), newFailed);
  checks.check('Part C: no page errors, and nothing but GETs was sent', partCErrors.length === 0 && partCWrites.length === 0, evidence.partC);
});
