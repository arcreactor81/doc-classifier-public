// DOM lab (SPEC §11 WP-1, §10.2): drives the real ui/app/view modules and core/ui/reactive.ts in headless Edge.
// Vite serves a virtual lab page on port 0 (nothing is written into ui/app). No network beyond 127.0.0.1.
// It shows: `each` reorders without losing focus or the caret (native moveBefore, the forced fallback, and a
// moveBefore that throws); show/match dispose their branches; action() produces the SPEC §5.3 DOM contract; a
// handoff moves focus; each motion helper starts its animations, once where it promises once. Evidence:
// .local/qa/ui-rebuild/00-dom-lab.json + PNGs.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const APP_ROOT = join(REPO, 'ui', 'app');
const EVIDENCE = join(REPO, '.local', 'qa', 'ui-rebuild');
const LAB_URL_MODULE = '/__dom-lab.ts';
const LAB_URL_PAGE = '/__dom-lab.html';
/** A virtual module id inside the Vite root, so its relative imports resolve exactly like the app's own. */
const LAB_FILE = join(APP_ROOT, '__dom-lab.ts');
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** The in-page half of the lab. It is stringified into the virtual module, so it may use only its arguments. */
function labMain({ reactive, dom, actions, motion, a11y, glyphs }) {
  const { signal, computed, effect, onCleanup, liveEffectCount, KeyedCollection } = reactive;
  const { h, each, show, match, mount, text } = dom;
  const host = document.getElementById('lab');
  const baseline = liveEffectCount();
  const state = {};
  let disposeView = null;
  const unmount = () => { if (disposeView !== null) { disposeView(); disposeView = null; } };
  const remount = view => { unmount(); disposeView = mount(host, view); };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
  };
  const observe = target => {
    const records = [];
    const observer = new MutationObserver(list => records.push(...list));
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => {
      records.push(...observer.takeRecords());
      observer.disconnect();
      const count = type => records.filter(record => record.type === type).length;
      return { childList: count('childList'), attributes: count('attributes'), characterData: count('characterData'),
        removed: records.reduce((n, record) => n + record.removedNodes.length, 0) };
    };
  };

  // ---- move primitives: spies and the forced modes --------------------------------------------------------------
  const PROTOS = [Element.prototype, DocumentFragment.prototype, Document.prototype];
  const nativeMove = new Map(PROTOS.map(proto => [proto, Object.getOwnPropertyDescriptor(proto, 'moveBefore')]));
  const moves = { moveBefore: 0, threw: 0, insertBefore: 0 };
  const nativeInsert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, child) {
    if (this instanceof Element && this.id === 'rows') moves.insertBefore++;
    return nativeInsert.call(this, node, child);
  };
  function setMoveMode(mode) {
    for (const proto of PROTOS) {
      const native = nativeMove.get(proto);
      if (mode === 'missing') { delete proto.moveBefore; continue; }
      const value = mode === 'throws'
        ? function () { moves.threw++; throw new DOMException('Forced by the DOM lab.', 'HierarchyRequestError'); }
        : function (node, child) { moves.moveBefore++; return native.value.call(this, node, child); };
      Object.defineProperty(proto, 'moveBefore', { value, configurable: true, writable: true, enumerable: true });
    }
  }
  const nativeMoveBefore = PROTOS.every(proto => typeof nativeMove.get(proto)?.value === 'function');

  // ---- each ------------------------------------------------------------------------------------------------------
  const list = {
    setup(mode) {
      setMoveMode(mode);
      moves.moveBefore = 0; moves.threw = 0; moves.insertBefore = 0;
      const rows = new KeyedCollection();
      rows.reconcile(['a', 'b', 'c', 'd', 'e'].map(id => ({ id, label: `Row ${id}` })), row => row.id);
      const order = signal(rows.keys.peek());
      const stats = { created: 0, cleanups: 0 };
      remount(() => h('ul', { attrs: { id: 'rows' } }, each(order, key => rows.get(key), (item, key) => {
        stats.created++;
        onCleanup(() => { stats.cleanups++; });
        return h('li', { attrs: { 'data-key': key } },
          h('span', { class: 'row-label' }, computed(() => item().label)), ' ',
          h('input', { attrs: { type: 'text', 'data-input': key, 'aria-label': `Field ${key}` } }));
      })));
      state.list = { rows, order, stats, inputs: new Map([...document.querySelectorAll('[data-input]')].map(el => [el.dataset.input, el])) };
      return list.inspect();
    },
    inspect() {
      const active = document.activeElement;
      const key = active instanceof HTMLInputElement ? active.dataset.input ?? null : null;
      return {
        order: [...document.querySelectorAll('#rows > li')].map(li => li.dataset.key),
        activeKey: key,
        sameNode: key !== null && state.list.inputs.get(key) === active,
        selection: active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null,
        value: active instanceof HTMLInputElement ? active.value : null,
        moves: { ...moves },
        moveBeforePresent: typeof Element.prototype.moveBefore === 'function',
        stats: { ...state.list.stats },
        live: liveEffectCount(),
      };
    },
    reorder(keys) { state.list.order.set(keys); return list.inspect(); },
    relabel(key, label) {
      const stop = observe(document.getElementById('rows'));
      const movesBefore = { ...moves };
      const items = state.list.order.peek().map(k => {
        const current = state.list.rows.get(k).peek();
        return k === key ? { ...current, label } : current;
      });
      const outcome = state.list.rows.reconcile(items, row => row.id);
      return { outcome, mutations: stop(), movesBefore, movesAfter: { ...moves },
        text: document.querySelector(`[data-key="${key}"] .row-label`).textContent };
    },
    remove(key) {
      const before = liveEffectCount();
      const keys = state.list.order.peek().filter(k => k !== key);
      reactive.batch(() => {
        state.list.rows.reconcile(keys.map(k => state.list.rows.get(k).peek()), row => row.id);
        state.list.order.set(keys);
      });
      return { ...list.inspect(), liveBefore: before, gone: document.querySelector(`[data-key="${key}"]`) === null };
    },
    restore() { setMoveMode('native'); },
  };

  // ---- show / match ----------------------------------------------------------------------------------------------
  const branches = {
    setup() {
      unmount();
      const before = liveEffectCount();
      const flag = signal(true);
      const count = signal(1);
      const mode = signal('one');
      const tick = signal(0);
      const log = { runs: {}, cleanups: {} };
      const branch = name => () => {
        log.runs[name] = log.runs[name] ?? 0;
        effect(() => { tick(); log.runs[name]++; });
        onCleanup(() => { log.cleanups[name] = (log.cleanups[name] ?? 0) + 1; });
        return h('p', { attrs: { 'data-branch': name } }, name);
      };
      // A non-memoised Read: it re-evaluates on every count change, so show() itself must skip equal booleans.
      const positive = Object.assign(() => count() > 0, { peek: () => count.peek() > 0 });
      remount(() => h('div', { attrs: { id: 'branches' } },
        h('div', { attrs: { id: 'show-host' } }, show(flag, branch('then'), branch('otherwise'))),
        h('div', { attrs: { id: 'raw-host' } }, show(positive, branch('positive'))),
        h('div', { attrs: { id: 'match-host' } }, match(mode, { one: branch('one'), two: branch('two') }, branch('fallback')))));
      state.branches = { flag, count, mode, tick, log, before };
      return branches.inspect();
    },
    inspect() {
      const shown = id => [...document.querySelectorAll(`#${id} [data-branch]`)].map(el => el.dataset.branch);
      return { show: shown('show-host'), raw: shown('raw-host'), match: shown('match-host'),
        runs: { ...state.branches.log.runs }, cleanups: { ...state.branches.log.cleanups }, live: liveEffectCount() };
    },
    act(step) {
      const { flag, count, mode, tick } = state.branches;
      const stop = observe(document.getElementById('branches'));
      if (step.flag !== undefined) flag.set(step.flag);
      if (step.count !== undefined) count.set(step.count);
      if (step.mode !== undefined) mode.set(step.mode);
      if (step.tick) tick.set(tick.peek() + 1);
      return { ...branches.inspect(), mutations: stop() };
    },
    dispose() { unmount(); return { live: liveEffectCount(), before: state.branches.before, cleanups: { ...state.branches.log.cleanups } }; },
  };

  // ---- bindings --------------------------------------------------------------------------------------------------
  const bindings = {
    run() {
      const attr = signal(null), cls = signal('one two'), on = signal(true), fill = signal(0.5), label = signal('Alpha');
      const value = signal('start'), other = signal(0);
      let el, input, node;
      remount(() => h('div', { attrs: { id: 'bind' } },
        (el = h('p', { class: cls, classes: { active: on }, attrs: { 'data-x': attr, 'data-other': other }, vars: { '--fill': fill }, testid: 'bound' },
          (node = text(label)))),
        (input = h('input', { props: { value }, attrs: { 'aria-label': 'Bound field' } }))));
      const out = { initial: { hasAttr: el.hasAttribute('data-x'), cls: el.className, fill: el.style.getPropertyValue('--fill'), text: node.data, testid: el.dataset.testid, value: input.value } };
      attr.set(true); out.afterTrue = el.getAttribute('data-x');
      attr.set(3); out.afterNumber = el.getAttribute('data-x');
      attr.set(false); out.afterFalse = el.hasAttribute('data-x');
      cls.set('two three'); out.cls = el.className;
      on.set(false); out.clsOff = el.className;
      let stop = observe(el);
      fill.set(0.5); label.set('Alpha'); cls.set('two  three'); attr.set(null);
      out.equalWrites = stop();
      stop = observe(el); label.set('Beta'); out.textChange = stop(); out.text = node.data;
      input.value = 'typed by a person';
      other.set(1);
      out.typedSurvives = input.value;
      value.set('set by the app'); out.valueWritten = input.value;
      // A select's value is a DOM prop: it must be written after its options exist, or the first option shows.
      const chosen = signal('b');
      let select;
      remount(() => (select = h('select', { props: { value: chosen }, attrs: { 'aria-label': 'Bound select' } },
        h('option', { attrs: { value: 'a' } }, 'A'), h('option', { attrs: { value: 'b' } }, 'B'), h('option', { attrs: { value: 'c' } }, 'C'))));
      out.selectInitial = select.value;
      chosen.set('c'); out.selectChanged = select.value;
      return out;
    },
    guards() {
      const out = {};
      const attempt = (name, fn) => { try { fn(); out[name] = 'no error'; } catch (error) { out[name] = error.message; } };
      attempt('unowned', () => h('p', { text: signal('x') }));
      attempt('styleAttr', () => h('p', { attrs: { style: 'color: red' } }));
      attempt('stylesProp', () => h('p', { props: { style: 'x' } }));
      attempt('handlerAttr', () => h('p', { attrs: { onclick: 'x' } }));
      attempt('textAndChildren', () => h('p', { text: 'x' }, 'y'));
      attempt('varsName', () => reactive.root(dispose => { try { h('p', { vars: { color: 'red' } }); } finally { dispose(); } }));
      // A markup property reached through a computed key (the static rule only sees literal names).
      const markupName = ['inner', 'HTML'].join('');
      attempt('markupProp', () => h('p', { props: { [markupName]: '<b>x</b>' } }));
      attempt('srcdocAttr', () => h('iframe', { attrs: { srcdoc: '<b>x</b>' } }));
      return out;
    },
  };

  // ---- actions ---------------------------------------------------------------------------------------------------
  const opsMap = new Map();
  const operations = { get(id) { let s = opsMap.get(id); if (s === undefined) { s = signal({ state: 'idle' }); opsMap.set(id, s); } return s; } };
  const PHRASES = { 'lab.needsFolder': 'Choose a folder first.', 'lab.needsLimit': 'Set a spending limit.', 'lab.tryAgain': 'Select the button again.', 'lab.openSystem': 'Open the system page',
    'lab.alreadyDone': 'This was already done.' };
  let clockOffset = 0;
  /** A frozen clock, like page.clock in the flow scripts: every now() returns the same millisecond. */
  let frozenAt = null;
  const sheet = { answer: true, calls: [] };
  actions.configureActions({
    operations,
    presentError(error, context) {
      return { headline: error instanceof Error ? error.message : String(error), action: { key: 'lab.tryAgain' },
        link: error?.withLink ? { phrase: { key: 'lab.openSystem' }, href: '#/system' } : null,
        technical: { name: error?.name ?? null, context }, code: error?.code ?? null, kind: 'local' };
    },
    phrase(phrase) {
      const value = PHRASES[phrase.key];
      if (value === undefined) throw new Error(`DOM lab: no phrase ${phrase.key}`);
      return value;
    },
    copy: { whyUnavailable: 'Why this is unavailable:', details: 'Technical details', at: t => `at ${t}`,
      stillWorking: (t, s) => `Still working · started ${t} · ${s} s` },
    time(ms) { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); },
    confirmSheet(spec, trigger) { sheet.calls.push({ title: spec.title, trigger: trigger.dataset.op }); return Promise.resolve(sheet.answer); },
    now: () => frozenAt ?? Date.now() + clockOffset,
  });

  function describe(id) {
    const block = document.querySelector(`[data-action="${id}"]`);
    if (block === null) return null;
    const button = block.querySelector('button');
    const note = block.querySelector('.action__note');
    const fb = block.querySelector('.feedback');
    const status = fb.querySelector('.feedback__status');
    const alertEl = fb.querySelector('.feedback__alert');
    const meter = fb.querySelector('.feedback__meter');
    const refs = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return {
      blockTag: block.tagName.toLowerCase(), blockClass: block.className,
      children: [...block.children].map(child => `${child.tagName.toLowerCase()}.${child.className}`),
      lastChildIsFeedback: block.lastElementChild === fb && fb.getAttribute('data-feedback') === id,
      button: { type: button.getAttribute('type'), class: button.className, op: button.dataset.op,
        primary: button.getAttribute('data-primary'), describedBy: button.getAttribute('aria-describedby'),
        disabled: button.disabled, text: button.textContent },
      note: note === null ? null : { id: note.id, text: note.textContent, hidden: note.hidden },
      describedByResolves: refs.length > 0 && refs.every(ref => document.getElementById(ref) !== null),
      feedback: {
        id: fb.id, key: fb.dataset.feedback, state: fb.dataset.state, children: [...fb.children].map(child => child.className),
        status: { role: status.getAttribute('role'), live: status.getAttribute('aria-live'), atomic: status.getAttribute('aria-atomic'),
          text: status.innerText.trim(), headline: status.querySelector('.notice__headline')?.textContent ?? null,
          technical: status.querySelector('details[data-technical] pre')?.textContent ?? null,
          reasons: [...status.querySelectorAll('.feedback__reasons li')].map(li => li.textContent) },
        alert: { role: alertEl.getAttribute('role'), text: alertEl.innerText.trim(), headline: alertEl.querySelector('.notice__headline')?.textContent ?? null },
        elapsed: fb.querySelector('.feedback__elapsed')?.textContent ?? null,
        sweep: fb.querySelector('.feedback__sweep') !== null,
        meter: meter === null ? null : { now: meter.getAttribute('aria-valuenow'), max: meter.getAttribute('aria-valuemax'), fill: meter.style.getPropertyValue('--fill') },
        workHidden: fb.querySelector('.feedback__work').hidden,
      },
      slotBelowButton: fb.getBoundingClientRect().top >= button.getBoundingClientRect().bottom,
      active: document.activeElement?.dataset?.op ?? document.activeElement?.id ?? document.activeElement?.tagName ?? null,
    };
  }

  const gates = new Map();
  const gate = name => { const d = deferred(); gates.set(name, d); return d.promise; };
  const runs = {};
  const counted = (name, body) => async (fb, abort) => { runs[name] = (runs[name] ?? 0) + 1; await body(fb, abort); };
  const actionLab = {
    describe,
    runs: () => ({ ...runs }),
    open(name) { gates.get(name)?.resolve(); },
    fail(name, error) { gates.get(name)?.reject(error); },
    advanceClock(ms) { clockOffset += ms; },
    freezeClock(on) { frozenAt = on ? Date.now() + clockOffset : null; return frozenAt; },
    mountOrdering() {
      const selfBlocked = signal(null);
      const lateBlocked = signal(null);
      state.ordering = { selfBlocked, lateBlocked };
      remount(() => h('section', { attrs: { id: 'ordering' } },
        // Its own success blocks it (for example "already applied"), set just before done, in the same millisecond.
        actions.action({ id: 'lab:apply:1', label: 'Apply', blockedBy: selfBlocked,
          run: counted('apply', async fb => { fb.working('Applying'); await gate('apply'); selfBlocked.set([{ key: 'lab.alreadyDone' }]); fb.done('Applied'); }) }),
        // Reasons that arrive after the outcome are newer, so they replace it.
        actions.action({ id: 'lab:late:1', label: 'Finish', blockedBy: lateBlocked,
          run: counted('late', async fb => { fb.working('Finishing'); await gate('late'); fb.done('Finished'); lateBlocked.set([{ key: 'lab.alreadyDone' }]); }) }),
        actions.action({ id: 'lab:wait:1', label: 'Wait',
          run: counted('wait', async fb => { fb.waiting('Waiting for the other system', Date.now() + clockOffset); await gate('wait'); fb.done('Waited'); }) })));
      return true;
    },
    sheet(answer) { sheet.answer = answer; return sheet.calls.length; },
    mountMain() {
      const blocked = signal(null);
      const note = signal('Saves the lab draft.');
      state.main = { blocked, note };
      remount(() => h('section', { attrs: { id: 'actions' } },
        actions.action({ id: 'lab:save:1', label: 'Save', primary: true, note, blockedBy: blocked,
          run: counted('save', async fb => { fb.working('Saving'); await gate('save'); fb.done('Saved'); }) }),
        actions.action({ id: 'lab:throw:1', label: 'Throw',
          run: counted('throw', async () => { await gate('throw'); }) }),
        actions.action({ id: 'lab:block:1', label: 'Stop',
          run: counted('block', async fb => { fb.problem(new Error('Stopped by the lab.'), 'send', { blocker: true }); }) }),
        actions.action({ id: 'lab:prepare:1', label: 'Prepare',
          run: counted('prepare', async fb => { fb.working('Preparing'); await gate('prepare'); fb.done('Prepared'); }) }),
        actions.action({ id: 'lab:copy:1', label: 'Copy',
          run: counted('copy', async fb => {
            fb.working('Copying', { done: 3, total: 10 });
            await gate('copy-1');
            fb.working('Copying', { done: 7, total: 10 });
            await gate('copy-2');
            fb.done('Copied');
          }) }),
        actions.action({ id: 'lab:cancel:1', label: 'Wait',
          run: counted('cancel', (fb, abort) => new Promise((resolve, reject) => {
            state.cancelSignal = abort;
            fb.working('Waiting for the lab');
            abort.addEventListener('abort', () => reject(new DOMException('Cancelled by the lab.', 'AbortError')));
          })) }),
        actions.action({ id: 'lab:delete:1', label: 'Delete', confirm: { title: 'Delete it?', lines: ['It cannot be undone.'], confirmLabel: 'Delete' },
          run: counted('delete', async fb => { fb.done('Deleted'); }) })));
      return describe('lab:save:1');
    },
    setBlocked(reasons) { state.main.blocked.set(reasons); return describe('lab:save:1'); },
    setNote(note) { state.main.note.set(note); return describe('lab:save:1'); },
    clickTwiceMore(id) {
      const button = document.querySelector(`[data-op="${id}"]`);
      button.click();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { ...runs };
    },
    observeSlot(id) { state.slotStop = observe(document.querySelector(`[data-feedback="${id}"] .feedback__status`)); },
    slotMutations() { return state.slotStop(); },
    observeBlock(id) { state.blockStop = observe(document.querySelector(`[data-action="${id}"]`)); },
    blockMutations() { return state.blockStop(); },
    cancel(id) { return { cancelled: actions.cancelAction(id), unknown: actions.cancelAction('lab:none:1'), aborted: state.cancelSignal?.aborted ?? null }; },
    remountMain() { return actionLab.mountMain(); },
    unmount() { unmount(); return document.querySelector('[data-op]') === null; },
    mountScroll() {
      remount(() => h('section', null, h('div', { attrs: { id: 'spacer' } }),
        actions.action({ id: 'lab:far:1', label: 'Far away',
          run: counted('far', async fb => { fb.working('Working far away'); await gate('far'); window.scrollTo(0, 0); fb.done('Done far away'); }) })));
      return true;
    },
    slotInView(id) {
      const rect = document.querySelector(`[data-feedback="${id}"]`).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, innerHeight: window.innerHeight, inView: rect.top >= 0 && rect.bottom <= window.innerHeight, scrollY: window.scrollY };
    },
    mountHandoff(variant) {
      const current = signal('first');
      const blocked = signal([{ key: 'lab.needsFolder' }]);
      if (variant === 'swap') {
        // Like ActionSlot: the view swaps the first action for the next one in the same position.
        remount(() => h('section', null, h('input', { attrs: { id: 'elsewhere', 'aria-label': 'Elsewhere' } }), match(current, {
          first: () => actions.action({ id: 'lab:make:1', label: 'Make', primary: true,
            run: counted('make', async fb => { await gate('make'); fb.done('Made', { handoff: 'lab:review:1' }); current.set('next'); }) }),
          next: () => actions.action({ id: 'lab:review:1', label: 'Review', primary: true, run: counted('review', async fb => { fb.done('Reviewed'); }) }),
        })));
      } else {
        remount(() => h('section', null,
          actions.action({ id: 'lab:make:2', label: 'Make', primary: true,
            run: counted('make2', async fb => { await gate('make2'); fb.done('Made', { handoff: 'lab:review:2' }); blocked.set(null); }) }),
          actions.action({ id: 'lab:review:2', label: 'Review', blockedBy: blocked, run: counted('review2', async fb => { fb.done('Reviewed'); }) })));
      }
      return true;
    },
  };

  // ---- motion ----------------------------------------------------------------------------------------------------
  const motionHost = document.getElementById('motion');
  /** Places a new element in the motion host (connected), so a helper can animate it. */
  const place = (tag, className, ...children) => { const el = h(tag, { class: className }, ...children); motionHost.append(el); return el; };
  /** One animation as plain data (an Animation does not cross page.evaluate): its timing and first and last frames. */
  const timing = animation => {
    if (!animation) return null;
    const { duration, delay, fill } = animation.effect.getTiming();
    const frames = animation.effect.getKeyframes();
    const read = frame => ({ opacity: frame.opacity === undefined ? null : String(frame.opacity),
      transform: frame.transform ?? null, filter: frame.filter ?? null });
    return { duration, delay, fill, playState: animation.playState, first: read(frames[0]), last: read(frames[frames.length - 1]) };
  };
  const motionLab = {
    animate() {
      const el = place('div', 'lab-cell', 'Plain');
      const started = motion.animate(el, [{ opacity: 0 }, { opacity: 1 }]);
      return { started: el.getAnimations().length, same: el.getAnimations()[0] === started, timing: timing(started),
        reveal: motion.ms('--dur-reveal'), detached: motion.animate(h('div', null), [{ opacity: 0 }]) === null,
        missing: motion.animate(null, [{ opacity: 0 }]) === null };
    },
    reveal() {
      const kinds = {};
      for (const [kind, token] of [['open', '--dur-reveal'], ['word', '--dur-word'], ['change', '--dur-change'], ['fail', '--dur-fail']]) {
        const el = place('p', 'lab-text', `Reveal ${kind}`);
        const started = motion.reveal(el, 20, kind);
        kinds[kind] = { started: el.getAnimations().length, returned: started !== null, same: el.getAnimations()[0] === started,
          timing: timing(started), token: motion.ms(token), detached: motion.reveal(h('p', null, 'Detached'), 0, kind) === null };
      }
      return { kinds, missing: motion.reveal(null) === null };
    },
    trace() {
      const pane = place('div', 'lab-pane', 'Pane');
      const rings = () => [...pane.children].filter(child => child.classList.contains('trace'));
      const ringState = () => {
        const all = rings();
        const ring = all[0] ?? null;
        return { rings: all.length, children: ring === null ? [] : [...ring.children].map(child => child.tagName.toLowerCase()),
          hidden: ring?.getAttribute('aria-hidden') ?? null, fail: ring?.classList.contains('is-fail') ?? null };
      };
      const first = motion.trace(pane);
      const ring = rings()[0] ?? null;
      const band = ring?.firstElementChild ?? null;
      const one = { ...ringState(), onBand: band !== null && band.getAnimations()[0] === first, timing: timing(first), token: motion.ms('--dur-trace') };
      const second = motion.trace(pane, { fail: true, delay: 30 });
      const two = { ...ringState(), reused: rings()[0] === ring && ring?.firstElementChild === band, firstState: first?.playState ?? null,
        bandAnimations: band?.getAnimations().length ?? null, secondRunning: band !== null && band.getAnimations()[0] === second, timing: timing(second) };
      const third = motion.trace(pane, { open: true });
      const three = { ...ringState(), reused: rings()[0] === ring, secondState: second?.playState ?? null,
        bandAnimations: band?.getAnimations().length ?? null, timing: timing(third), token: motion.ms('--dur-trace-open') };
      const loose = h('div', null);
      return { one, two, three, detached: motion.trace(loose) === null && loose.childElementCount === 0, missing: motion.trace(null) === null };
    },
    helpers() {
      const cell = place('span', 'lab-cell', '12');
      motion.flash(cell);
      const flash = { started: cell.getAnimations().length, timing: timing(cell.getAnimations()[0]), token: motion.ms('--dur-flash') };
      const pill = place('span', 'lab-pill', 'Filed');
      motion.enterOnce(pill);
      const first = pill.getAnimations().length;
      motion.enterOnce(pill);
      const other = place('span', 'lab-pill', 'Queued');
      motion.enterOnce(other);
      const enter = { first, replayed: pill.getAnimations().length - first, other: other.getAnimations().length };
      const track = place('div', 'lab-track', h('span', { class: 'motion-sweep', attrs: { 'aria-hidden': 'true' } }));
      const swept = [motion.sweepOnce(track), motion.sweepOnce(track)];
      const bare = place('div', 'lab-track');
      const bareSwept = motion.sweepOnce(bare);
      const heads = el => [...el.children].filter(child => child.classList.contains('motion-sweep'));
      const sweep = { swept, heads: heads(track).length, headAnimations: heads(track)[0]?.getAnimations().length ?? null,
        other: { swept: bareSwept, heads: heads(bare).length, host: bare.classList.contains('motion-sweep-host'),
          headAnimations: heads(bare)[0]?.getAnimations().length ?? null } };
      const bar = place('div', 'lab-fill');
      motion.fillTo(bar, 0.4);
      const fill = { value: bar.style.getPropertyValue('--fill') };
      motion.fillTo(bar, 1.7);
      fill.clamped = bar.style.getPropertyValue('--fill');
      try { motion.fillTo(bar, Number.NaN); fill.nan = 'no error'; } catch (error) { fill.nan = `${error.name}: ${error.message}`; }
      return { flash, enter, sweep, fill };
    },
    stage() {
      const stage = place('div', 'lab-stage');
      for (const name of ['One', 'Two', 'Three', 'Four']) stage.append(h('div', { attrs: { 'data-stage-group': '' } }, name));
      motion.stageTransition('forward').enter(stage);
      const plain = place('div', 'lab-stage', 'No groups');
      motion.stageTransition('back').enter(plain);
      return { stagger: motion.ms('--stagger'), stageItself: stage.getAnimations().length,
        groups: [...stage.children].map(group => { const all = group.getAnimations(); return { count: all.length, timing: timing(all[0]) }; }),
        plain: plain.getAnimations().map(timing) };
    },
    async leave() {
      const el = place('div', 'lab-leave', 'Leaving');
      const start = performance.now();
      await motion.stageTransition('back').leave(el);
      return { ms: performance.now() - start, animations: el.getAnimations().length };
    },
    tokens() {
      const attempt = fn => { try { return `no error: ${fn()}`; } catch (error) { return error.message; } };
      return { missingToken: attempt(() => motion.token('--lab-missing')), missingMs: attempt(() => motion.ms('--lab-missing')),
        missingEase: attempt(() => motion.ease('--lab-missing')), notDuration: attempt(() => motion.ms('--ease-out')), exit: motion.ms('--dur-exit') };
    },
  };

  // ---- accessibility helpers and glyphs ------------------------------------------------------------------------
  const a11yLab = {
    announce() {
      const el = a11y.announcer();
      const first = a11y.announce('First sentence.');
      const out = { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic'),
        className: el.className, first, text1: el.textContent, inBody: el.parentNode === document.body };
      out.throttled = [a11y.announce('Count one', { throttleKey: 'lab' }), a11y.announce('Count two', { throttleKey: 'lab' })];
      out.text2 = el.textContent;
      out.blank = a11y.announce('   ');
      out.single = document.querySelectorAll('[data-announcer]').length;
      a11y.announce('Same sentence.');
      out.repeat = a11y.announce('Same sentence.');
      out.clearedForRepeat = el.textContent;
      return out;
    },
    announcerText: () => a11y.announcer().textContent,
    narrate() {
      const realNow = Date.now;
      let fake = realNow.call(Date);
      Date.now = () => fake;
      try {
        const results = [];
        results.push(a11y.narrate('Sending 1 of 100', { key: 'lab.sending', done: 1, total: 100 }));
        fake += 1000; results.push(a11y.narrate('Sending 30 of 100', { key: 'lab.sending', done: 30, total: 100 }));
        fake += 15000; results.push(a11y.narrate('Sending 31 of 100', { key: 'lab.sending', done: 31, total: 100 }));
        fake += 16000; results.push(a11y.narrate('Sending 35 of 100', { key: 'lab.sending', done: 35, total: 100 }));
        fake += 1000; results.push(a11y.narrate('Sorting 0 of 100', { key: 'lab.sorting', done: 0, total: 100 }));
        return { results, text: a11y.announcer().textContent };
      } finally {
        Date.now = realNow;
      }
    },
    focusHeading() {
      const ok = a11y.focusHeading();
      const heading = document.querySelector('#main h1');
      return { ok, tabindex: heading.getAttribute('tabindex'), active: document.activeElement === heading };
    },
    openTrap() {
      const dialogHost = document.getElementById('dialog-host');
      const trigger = document.getElementById('trigger');
      trigger.focus();
      const dialog = h('div', { attrs: { id: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lab dialog' } },
        h('button', { attrs: { id: 'd1', type: 'button' } }, 'One'),
        h('button', { attrs: { id: 'd2', type: 'button' } }, 'Two'),
        h('button', { attrs: { id: 'd3', type: 'button' } }, 'Three'));
      dialogHost.append(dialog);
      state.trap = { release: a11y.trapFocus(dialog), dialog, trigger };
      return document.activeElement?.id ?? null;
    },
    activeId: () => document.activeElement?.id ?? null,
    closeTrap() {
      state.trap.release();
      state.trap.dialog.remove();
      const restored = a11y.restoreFocus(state.trap.trigger);
      return { restored, active: document.activeElement?.id ?? null, gone: a11y.restoreFocus(null) };
    },
  };
  const glyphLab = {
    render() {
      const holder = document.getElementById('glyphs');
      return glyphs.GLYPH_NAMES.map(name => {
        const el = glyphs.glyph(name);
        holder.append(el);
        return { name, tag: el.tagName, hidden: el.getAttribute('aria-hidden'), focusable: el.getAttribute('focusable'),
          viewBox: el.getAttribute('viewBox'), data: el.dataset.glyph, parts: el.childElementCount, box: el.getBoundingClientRect().width };
      });
    },
  };

  window.lab = {
    ready: true, nativeMoveBefore, baseline,
    live: () => liveEffectCount(),
    list, branches, bindings, actions: actionLab, motion: motionLab, a11y: a11yLab, glyphs: glyphLab,
    finish() { unmount(); return { live: liveEffectCount(), baseline }; },
  };
}

const LAB_SOURCE = [
  "import * as reactive from '../../core/ui/reactive.ts';",
  "import * as dom from './view/dom.ts';",
  "import * as actions from './view/action.ts';",
  "import * as motion from './view/motion.ts';",
  "import * as a11y from './view/a11y.ts';",
  "import * as glyphs from './view/glyphs.ts';",
  "import './styles/tokens.css';",
  "import './styles/motion.css';",
  `(${labMain.toString()})({ reactive, dom, actions, motion, a11y, glyphs });`,
].join('\n');

const LAB_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOM lab</title>
<link rel="icon" href="data:,">
<style>
  body { margin: 0; padding: 24px; font: 15px/1.5 var(--font-sans); background: var(--canvas); color: var(--ink); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .action { display: grid; justify-items: start; gap: var(--sp-2); margin-block: var(--sp-4); }
  .btn { min-height: var(--control-h); padding: 0 18px; border-radius: var(--r-pill); font: 500 14px var(--font-sans); border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
  .btn--primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  .btn:disabled { background: var(--surface-2); color: var(--ink-3); }
  .action__note, .feedback { font-size: 13px; color: var(--ink-2); margin: 0; }
  .feedback p { margin: 0; }
  .feedback__meter { width: 160px; height: 6px; overflow: hidden; border-radius: var(--r-pill); background: var(--track); }
  .feedback__meter-fill { background: var(--accent); }
  .notice { display: flex; gap: var(--sp-2); }
  .notice__headline { color: var(--ink); font-weight: 600; }
  .lab-track { height: 6px; width: 200px; background: var(--track); }
  .lab-pane { position: relative; width: 200px; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-xs); }
  .lab-cell, .lab-pill { display: inline-block; padding: 2px 6px; }
  #spacer { height: 2400px; }
</style></head>
<body><main id="main"><h1>DOM lab</h1><div id="lab"></div><div id="motion"></div><div id="glyphs"></div>
<button id="trigger" type="button">Open</button><div id="dialog-host"></div></main>
<script type="module" src="${LAB_URL_MODULE}"></script></body></html>`;

const labPlugin = {
  name: 'dom-lab',
  enforce: 'pre',
  resolveId(id) { return id === LAB_URL_MODULE ? LAB_FILE : null; },
  load(id) { return same(id.split('?')[0], LAB_FILE) ? LAB_SOURCE : null; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== LAB_URL_PAGE) return next();
      try {
        const html = await server.transformIndexHtml(LAB_URL_PAGE, LAB_HTML);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(html);
      } catch (error) {
        next(error);
      }
    });
  },
};

// ---- the Node side ---------------------------------------------------------------------------------------------
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     ${JSON.stringify(detail)}`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

mkdirSync(EVIDENCE, { recursive: true });
const server = await createServer({
  root: APP_ROOT, configFile: false, logLevel: 'error', appType: 'custom', clearScreen: false,
  server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [REPO] } },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [labPlugin],
});
await server.listen();
const { port } = server.httpServer.address();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const foreign = [];
const failedResponses = [];
page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('ws://127.0.0.1')) foreign.push(request.url()); });

const lab = (path, ...args) => page.evaluate(([p, a]) => {
  const parts = p.split('.');
  const fn = parts.reduce((obj, key) => obj[key], window.lab);
  const self = parts.slice(0, -1).reduce((obj, key) => obj[key], window.lab);
  return fn.apply(self, a);
}, [path, args]);
const waitState = (id, stateName) => page.waitForFunction(([i, s]) => document.querySelector(`[data-feedback="${i}"]`)?.dataset.state === s,
  [id, stateName], { timeout: 5000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const TIME = /\d\d:\d\d:\d\d/;

let exitCode = 1;
try {
  await page.goto(`${origin}${LAB_URL_PAGE}`);
  await page.waitForFunction(() => window.lab?.ready === true, null, { timeout: 15000 });
  const edgeVersion = browser.version();
  check('the lab page loaded the real view modules in Edge', true);
  check('Edge has a native moveBefore on Element, DocumentFragment and Document', await page.evaluate(() => window.lab.nativeMoveBefore));

  // ---- each: focus and caret survive reorders, in all three move modes ------------------------------------------
  for (const mode of ['native', 'missing', 'throws']) {
    const setup = await lab('list.setup', mode);
    check(`each [${mode}]: five rows render in key order`, eq(setup.order, ['a', 'b', 'c', 'd', 'e']) && setup.stats.created === 5, setup);
    await page.click('[data-input="c"]');
    await page.keyboard.type('hello world');
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    const orders = [['c', 'a', 'b', 'd', 'e'], ['e', 'd', 'b', 'a', 'c'], ['b', 'e', 'c', 'a', 'd']];
    for (const order of orders) {
      const after = await lab('list.reorder', order);
      check(`each [${mode}]: reorder to ${order.join('')} keeps focus, node and selection`,
        eq(after.order, order) && after.activeKey === 'c' && after.sameNode && eq(after.selection.slice(0, 2), [3, 5]) && after.value === 'hello world',
        after);
    }
    await page.keyboard.type('X');
    const typed = await lab('list.inspect');
    check(`each [${mode}]: typing after the moves replaces the preserved selection`, typed.value === 'helX world' && typed.activeKey === 'c', typed);
    const path = typed.moves;
    if (mode === 'native') check('each [native]: moves used moveBefore, not insertBefore', path.moveBefore > 0 && path.insertBefore === 0 && typed.moveBeforePresent, path);
    if (mode === 'missing') check('each [missing]: moveBefore absent, moves used the insertBefore fallback', !typed.moveBeforePresent && path.moveBefore === 0 && path.insertBefore > 0, path);
    if (mode === 'throws') check('each [throws]: moveBefore threw, moves used the insertBefore fallback', path.threw > 0 && path.insertBefore > 0 && path.moveBefore === 0, path);
    const relabel = await lab('list.relabel', 'a', 'Row A renamed');
    check(`each [${mode}]: a content-only change mutates text only and moves nothing`,
      eq(relabel.outcome, { added: [], removed: [], changed: ['a'] }) && relabel.mutations.childList === 0 && relabel.mutations.characterData === 1 &&
      eq(relabel.movesBefore, relabel.movesAfter) && relabel.text === 'Row A renamed', relabel);
    const removed = await lab('list.remove', 'b');
    check(`each [${mode}]: a removed key disposes its row root and removes its row`,
      removed.gone && removed.stats.cleanups === 1 && removed.live < removed.liveBefore && removed.activeKey === 'c', removed);
  }
  await lab('list.restore');

  // ---- show / match dispose their branches -----------------------------------------------------------------------
  const b0 = await lab('branches.setup');
  check('show/match: initial branches', eq(b0.show, ['then']) && eq(b0.raw, ['positive']) && eq(b0.match, ['one']), b0);
  const b1 = await lab('branches.act', { tick: true });
  check('show/match: live branches react', b1.runs.then === 2 && b1.runs.one === 2 && b1.runs.positive === 2, b1);
  const b2 = await lab('branches.act', { flag: false });
  check('show: leaving a branch disposes it (cleanup ran, node gone)', eq(b2.show, ['otherwise']) && b2.cleanups.then === 1 && b2.live === b1.live, b2);
  const b3 = await lab('branches.act', { tick: true });
  check('show: the disposed branch no longer runs', b3.runs.then === 2 && b3.runs.otherwise === 2, b3);
  const b4 = await lab('branches.act', { flag: false });
  check('show: an equal value swaps nothing (zero mutations)', b4.mutations.childList === 0 && b4.mutations.attributes === 0 && b4.mutations.removed === 0, b4);
  const b5 = await lab('branches.act', { count: 5 });
  check('show: a re-evaluated but equal boolean swaps nothing', b5.mutations.childList === 0 && b5.cleanups.positive === undefined && eq(b5.raw, ['positive']), b5);
  const b6 = await lab('branches.act', { count: 0 });
  check('show: without an otherwise branch, false renders nothing and disposes', eq(b6.raw, []) && b6.cleanups.positive === 1, b6);
  const b7 = await lab('branches.act', { mode: 'two' });
  check('match: a key change disposes the old case', eq(b7.match, ['two']) && b7.cleanups.one === 1, b7);
  const b8 = await lab('branches.act', { mode: 'three' });
  check('match: an unlisted key renders the fallback and disposes the case', eq(b8.match, ['fallback']) && b8.cleanups.two === 1, b8);
  const b9 = await lab('branches.act', { mode: 'three' });
  check('match: an equal key swaps nothing', b9.mutations.childList === 0, b9);
  const b10 = await lab('branches.act', { tick: true });
  check('show/match: after a change, only the live branches run (disposed ones never again)',
    b10.runs.fallback === b9.runs.fallback + 1 && b10.runs.otherwise === b9.runs.otherwise + 1 &&
    b10.runs.one === b9.runs.one && b10.runs.two === b9.runs.two && b10.runs.positive === b9.runs.positive && b10.runs.then === b9.runs.then,
    { before: b9.runs, after: b10.runs });
  const bEnd = await lab('branches.dispose');
  check('show/match: disposing the view disposes every branch (no live effects left)', bEnd.live === bEnd.before && bEnd.cleanups.otherwise === 1 && bEnd.cleanups.fallback === 1, bEnd);

  // ---- bindings ----------------------------------------------------------------------------------------------------
  const bind = await lab('bindings.run');
  check('bindings: attrs null/false removed, true → "", numbers stringified',
    !bind.initial.hasAttr && bind.afterTrue === '' && bind.afterNumber === '3' && bind.afterFalse === false, bind);
  check('bindings: class tokens and classes toggles combine', bind.initial.cls === 'one two active' && bind.cls === 'two active three' && bind.clsOff === 'two three', bind);
  check('bindings: vars, text and testid', bind.initial.fill === '0.5' && bind.initial.text === 'Alpha' && bind.initial.testid === 'bound', bind);
  check('bindings: equal writes produce zero mutations', eq(bind.equalWrites, { childList: 0, attributes: 0, characterData: 0, removed: 0 }), bind.equalWrites);
  check('bindings: a text change writes Text.data only', bind.textChange.characterData === 1 && bind.textChange.childList === 0 && bind.text === 'Beta', bind.textChange);
  check('bindings: a person\'s typing survives an unrelated update; a changed value is written',
    bind.typedSurvives === 'typed by a person' && bind.valueWritten === 'set by the app', bind);
  check('bindings: a select shows the value it was given (props are written after the options exist) and follows changes',
    bind.selectInitial === 'b' && bind.selectChanged === 'c', { selectInitial: bind.selectInitial, selectChanged: bind.selectChanged });
  const guards = await lab('bindings.guards');
  check('bindings: an unowned binding, inline styles, inline handlers, text+children, non-custom vars and markup props/attrs all throw',
    /needs an owner/.test(guards.unowned) && /inline styles/.test(guards.styleAttr) && /inline styles/.test(guards.stylesProp) &&
    /handler/.test(guards.handlerAttr) && /either text or children/.test(guards.textAndChildren) && /custom properties only/.test(guards.varsName) &&
    /markup property/.test(guards.markupProp) && /markup attributes/.test(guards.srcdocAttr), guards);

  // ---- action(): the §5.3 DOM contract and its states --------------------------------------------------------------
  const contract = await lab('actions.mountMain');
  check('action: DOM contract (div.action > button, p.action__note, div.feedback as the last child)',
    contract.blockTag === 'div' && contract.blockClass === 'action' &&
    eq(contract.children, ['button.btn btn--primary', 'p.action__note', 'div.feedback']) && contract.lastChildIsFeedback, contract);
  check('action: button attributes (type, data-op, data-primary, aria-describedby → note and slot)',
    contract.button.type === 'button' && contract.button.op === 'lab:save:1' && contract.button.primary === '' &&
    contract.button.describedBy === 'lab:save:1-note lab:save:1-fb' && contract.describedByResolves && !contract.button.disabled && contract.button.text === 'Save', contract.button);
  check('action: note and slot ids; status is role=status polite atomic; alert is role=alert; slot sits below',
    contract.note.id === 'lab:save:1-note' && contract.note.text === 'Saves the lab draft.' && !contract.note.hidden &&
    contract.feedback.id === 'lab:save:1-fb' && contract.feedback.key === 'lab:save:1' && contract.feedback.state === 'idle' &&
    eq(contract.feedback.children, ['feedback__status', 'feedback__alert', 'feedback__work']) &&
    contract.feedback.status.role === 'status' && contract.feedback.status.live === 'polite' && contract.feedback.status.atomic === 'true' &&
    contract.feedback.alert.role === 'alert' && contract.feedback.status.text === '' && contract.slotBelowButton, contract.feedback);
  const secondary = await lab('actions.describe', 'lab:throw:1');
  check('action: a non-primary action has btn--secondary, no data-primary, and no note reference',
    secondary.button.class === 'btn btn--secondary' && secondary.button.primary === null && secondary.button.describedBy === 'lab:throw:1-fb' &&
    secondary.note.hidden === true && secondary.describedByResolves, secondary);
  const noteless = await lab('actions.setNote', null);
  check('action: a note that becomes null is hidden and dropped from aria-describedby', noteless.note.hidden && noteless.button.describedBy === 'lab:save:1-fb', noteless);
  await lab('actions.setNote', 'Saves the lab draft.');

  await page.click('[data-op="lab:save:1"]');
  await waitState('lab:save:1', 'working');
  const working = await lab('actions.describe', 'lab:save:1');
  const again = await lab('actions.clickTwiceMore', 'lab:save:1');
  check('action: working disables the button, shows the step line, and a second click is impossible',
    working.button.disabled && working.feedback.status.text === 'Saving' && !working.feedback.workHidden && working.feedback.sweep && again.save === 1, { working, again });
  await lab('actions.open', 'save');
  await waitState('lab:save:1', 'done');
  const done = await lab('actions.describe', 'lab:save:1');
  check('action: done shows the message with "at HH:MM:SS" and re-enables the button',
    /^Saved at \d\d:\d\d:\d\d$/.test(done.feedback.status.text) && !done.button.disabled && done.feedback.workHidden && done.feedback.alert.text === '', done.feedback);

  const blocked = await lab('actions.setBlocked', [{ key: 'lab.needsFolder' }, { key: 'lab.needsLimit' }]);
  check('action: blocked reasons disable the button and appear in the slot after "Why this is unavailable:"',
    blocked.button.disabled && blocked.feedback.state === 'blocked' && blocked.feedback.status.text.startsWith('Why this is unavailable:') &&
    eq(blocked.feedback.status.reasons, ['Choose a folder first.', 'Set a spending limit.']), blocked.feedback);
  const unblocked = await lab('actions.setBlocked', null);
  check('action: clearing the reasons re-enables the button and leaves the blocked state',
    !unblocked.button.disabled && unblocked.feedback.state !== 'blocked', unblocked.feedback);
  const empty = await lab('actions.setBlocked', []);
  check('action: an empty reason list does not block', !empty.button.disabled && empty.feedback.state !== 'blocked', empty.feedback);
  await lab('actions.setBlocked', null);

  await page.click('[data-op="lab:throw:1"]');
  await waitState('lab:throw:1', 'working');
  await page.evaluate(() => window.lab.actions.fail('throw', Object.assign(new Error('The lab run failed.'), { code: 'E_LAB' })));
  await waitState('lab:throw:1', 'problem');
  const problem = await lab('actions.describe', 'lab:throw:1');
  check('action: an exception from run becomes a problem notice in the status region, with time and technical Details',
    problem.feedback.status.headline === 'The lab run failed.' && TIME.test(problem.feedback.status.text) &&
    problem.feedback.status.text.includes('Select the button again.') && /"code": "E_LAB"/.test(problem.feedback.status.technical ?? '') &&
    problem.feedback.alert.text === '' && !problem.button.disabled, problem.feedback);

  await page.click('[data-op="lab:block:1"]');
  await waitState('lab:block:1', 'problem');
  const blocker = await lab('actions.describe', 'lab:block:1');
  check('action: problem(…, {blocker: true}) uses role=alert only, and the status region stays empty (one message)',
    blocker.feedback.alert.headline === 'Stopped by the lab.' && blocker.feedback.status.text === '', blocker.feedback);

  await page.click('[data-op="lab:prepare:1"]');
  await waitState('lab:prepare:1', 'working');
  const early = await lab('actions.describe', 'lab:prepare:1');
  await lab('actions.advanceClock', 6000);
  await page.waitForFunction(() => document.querySelector('[data-feedback="lab:prepare:1"] .feedback__elapsed') !== null, null, { timeout: 3000 });
  const late = await lab('actions.describe', 'lab:prepare:1');
  check('action: before 5 s a sweep and no timer; after 5 s "Still working · started HH:MM:SS · N s"',
    early.feedback.elapsed === null && early.feedback.sweep && /^Still working · started \d\d:\d\d:\d\d · [67] s$/.test(late.feedback.elapsed ?? ''),
    { early: early.feedback, late: late.feedback });
  await lab('actions.open', 'prepare');
  await waitState('lab:prepare:1', 'done');
  await lab('actions.observeBlock', 'lab:prepare:1');
  await pause(1500);
  const quiet = await lab('actions.blockMutations');
  const prepared = await lab('actions.describe', 'lab:prepare:1');
  check('action: the elapsed ticker stops with the work (no mutations for 1.5 s after done)',
    eq(quiet, { childList: 0, attributes: 0, characterData: 0, removed: 0 }) && prepared.feedback.elapsed === null, { quiet, prepared: prepared.feedback });

  await page.click('[data-op="lab:copy:1"]');
  await waitState('lab:copy:1', 'working');
  const copy1 = await lab('actions.describe', 'lab:copy:1');
  await lab('actions.observeSlot', 'lab:copy:1');
  await lab('actions.open', 'copy-1');
  await page.waitForFunction(() => document.querySelector('[data-feedback="lab:copy:1"] .feedback__meter')?.getAttribute('aria-valuenow') === '7', null, { timeout: 3000 });
  const statusQuiet = await lab('actions.slotMutations');
  const copy2 = await lab('actions.describe', 'lab:copy:1');
  check('action: progress is a meter outside the live region; a count change does not touch the status region',
    eq(copy1.feedback.meter, { now: '3', max: '10', fill: '0.3' }) && !copy1.feedback.sweep && copy2.feedback.meter.fill === '0.7' &&
    eq(statusQuiet, { childList: 0, attributes: 0, characterData: 0, removed: 0 }) && copy2.feedback.status.text === 'Copying', { copy1: copy1.feedback, copy2: copy2.feedback, statusQuiet });
  await lab('actions.open', 'copy-2');
  await waitState('lab:copy:1', 'done');

  await page.click('[data-op="lab:cancel:1"]');
  await waitState('lab:cancel:1', 'working');
  const navigated = await lab('actions.unmount');
  const remounted = await lab('actions.remountMain');
  const stillWorking = await lab('actions.describe', 'lab:cancel:1');
  const savedAgain = await lab('actions.describe', 'lab:save:1');
  check('action: navigation never aborts a run; a remount re-binds the working state and the last outcomes',
    navigated && stillWorking.button.disabled && stillWorking.feedback.state === 'working' && /^Saved at /.test(savedAgain.feedback.status.text) &&
    remounted !== null, { stillWorking: stillWorking.feedback, savedAgain: savedAgain.feedback });
  const cancel = await lab('actions.cancel', 'lab:cancel:1');
  await waitState('lab:cancel:1', 'problem');
  const cancelled = await lab('actions.describe', 'lab:cancel:1');
  check('action: only cancelAction(id) aborts the run signal; the abort becomes a problem in the slot',
    cancel.cancelled === true && cancel.unknown === false && cancel.aborted === true && cancelled.feedback.status.headline === 'Cancelled by the lab.', { cancel, cancelled: cancelled.feedback });

  const sheetsBefore = await lab('actions.sheet', false);
  await page.click('[data-op="lab:delete:1"]');
  await pause(100);
  const declined = await lab('actions.describe', 'lab:delete:1');
  const runsDeclined = await lab('actions.runs');
  await lab('actions.sheet', true);
  await page.click('[data-op="lab:delete:1"]');
  await waitState('lab:delete:1', 'done');
  const runsConfirmed = await lab('actions.runs');
  const sheetsAfter = await lab('actions.sheet', true);
  check('action: a confirm spec opens the sheet first; declining runs nothing, confirming runs once',
    sheetsBefore === 0 && sheetsAfter === 2 && runsDeclined.delete === undefined && declined.feedback.state === 'idle' && runsConfirmed.delete === 1, { runsDeclined, runsConfirmed, sheetsAfter });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: join(EVIDENCE, '00-dom-lab-actions-dark.png'), fullPage: true });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  await lab('actions.mountScroll');
  await page.click('[data-op="lab:far:1"]');
  await waitState('lab:far:1', 'working');
  await lab('actions.open', 'far');
  await waitState('lab:far:1', 'done');
  await page.waitForFunction(() => window.lab.actions.slotInView('lab:far:1').inView, null, { timeout: 3000 }).catch(() => {});
  const scrolled = await lab('actions.slotInView', 'lab:far:1');
  await page.evaluate(() => window.scrollTo(0, 0));
  await lab('actions.mountScroll');
  await pause(200);
  const notScrolled = await lab('actions.slotInView', 'lab:far:1');
  check('action: a terminal state of a run started here scrolls its slot into view; a remount does not scroll',
    scrolled.inView && scrolled.scrollY > 0 && !notScrolled.inView && notScrolled.scrollY === 0, { scrolled, notScrolled });

  // ---- handoff moves focus -----------------------------------------------------------------------------------------
  await lab('actions.mountHandoff', 'swap');
  await page.focus('[data-op="lab:make:1"]');
  await page.keyboard.press('Enter');
  await waitState('lab:make:1', 'working');
  await lab('actions.open', 'make');
  await page.waitForFunction(() => document.activeElement?.dataset?.op === 'lab:review:1', null, { timeout: 3000 }).catch(() => {});
  const handed = await lab('actions.describe', 'lab:review:1');
  check('handoff: success turns the button: the next action shows the done message and receives focus',
    handed !== null && handed.active === 'lab:review:1' && /^Made at \d\d:\d\d:\d\d$/.test(handed.feedback.status.text), handed);

  await lab('actions.mountHandoff', 'swap');
  await page.click('[data-op="lab:make:1"]');
  await waitState('lab:make:1', 'working');
  await page.focus('#elsewhere');
  await lab('actions.open', 'make');
  await page.waitForFunction(() => document.querySelector('[data-op="lab:review:1"]') !== null, null, { timeout: 3000 });
  await pause(100);
  const kept = await page.evaluate(() => document.activeElement?.id ?? null);
  check('handoff: focus is not moved when the person had moved it elsewhere', kept === 'elsewhere', { kept });

  await lab('actions.mountHandoff', 'side-by-side');
  await page.focus('[data-op="lab:make:2"]');
  await page.keyboard.press('Enter');
  await waitState('lab:make:2', 'working');
  await lab('actions.open', 'make2');
  await page.waitForFunction(() => document.activeElement?.dataset?.op === 'lab:review:2', null, { timeout: 3000 }).catch(() => {});
  const sideBySide = await lab('actions.describe', 'lab:review:2');
  check('handoff: a next action that is enabled by the same step receives focus once enabled',
    sideBySide.active === 'lab:review:2' && !sideBySide.button.disabled && /^Made at /.test(sideBySide.feedback.status.text), sideBySide);

  // ---- blocked reasons versus outcomes: ordered by change, never by the clock ----------------------------------------
  await lab('actions.mountOrdering');
  await lab('actions.freezeClock', true);
  await page.click('[data-op="lab:apply:1"]');
  await waitState('lab:apply:1', 'working');
  await lab('actions.open', 'apply');
  await waitState('lab:apply:1', 'done').catch(() => {});
  const selfBlock = await lab('actions.describe', 'lab:apply:1');
  check('ordering: a run that blocks its own button just before done still shows its done message (frozen clock)',
    selfBlock.feedback.state === 'done' && /^Applied at \d\d:\d\d:\d\d$/.test(selfBlock.feedback.status.text) && selfBlock.button.disabled, selfBlock.feedback);
  await page.click('[data-op="lab:late:1"]');
  await waitState('lab:late:1', 'working');
  await lab('actions.open', 'late');
  await waitState('lab:late:1', 'blocked').catch(() => {});
  const lateBlock = await lab('actions.describe', 'lab:late:1');
  check('ordering: reasons that arrive after the outcome replace it (frozen clock)',
    lateBlock.feedback.state === 'blocked' && eq(lateBlock.feedback.status.reasons, ['This was already done.']) && lateBlock.button.disabled, lateBlock.feedback);
  await lab('actions.freezeClock', false);
  await page.click('[data-op="lab:wait:1"]');
  await waitState('lab:wait:1', 'waiting');
  const waitingSlot = await lab('actions.describe', 'lab:wait:1');
  check('action: waiting is a still state: disabled button, the label with a time, and no meter, sweep or timer',
    waitingSlot.button.disabled && /^Waiting for the other system · \d\d:\d\d:\d\d$/.test(waitingSlot.feedback.status.text) &&
    waitingSlot.feedback.workHidden && !waitingSlot.feedback.sweep && waitingSlot.feedback.elapsed === null, waitingSlot.feedback);
  await lab('actions.open', 'wait');
  await waitState('lab:wait:1', 'done');

  // ---- motion: each helper starts its own animations, once where it promises once ----------------------------------
  const animated = await lab('motion.animate');
  check('motion: animate() starts one animation, by default --dur-reveal with fill "backwards"; null for a detached or missing element',
    animated.started === 1 && animated.same && animated.timing?.fill === 'backwards' && animated.timing?.duration === animated.reveal &&
    animated.detached && animated.missing, animated);
  const revealed = await lab('motion.reveal');
  const kinds = Object.entries(revealed.kinds);
  check('motion: reveal() starts one animation for each kind (open, word, change, fail) with its duration token, the delay, a fade and a rise; only word blurs 4px → 0',
    eq(kinds.map(([kind]) => kind), ['open', 'word', 'change', 'fail']) && kinds.every(([kind, k]) => k.started === 1 && k.returned && k.same &&
      k.timing.duration === k.token && k.timing.delay === 20 && k.timing.first.opacity === '0' && k.timing.last.opacity === '1' &&
      /^translateY\(\d+px\)$/.test(k.timing.first.transform ?? '') && k.timing.last.transform === 'none' &&
      (kind === 'word' ? k.timing.first.filter === 'blur(4px)' && k.timing.last.filter === 'blur(0px)' : k.timing.first.filter === null && k.timing.last.filter === null)),
    revealed.kinds);
  check('motion: reveal() returns null for a detached element (every kind) and for no element',
    kinds.every(([, k]) => k.detached) && revealed.missing, { detached: kinds.map(([kind, k]) => [kind, k.detached]), missing: revealed.missing });
  const traced = await lab('motion.trace');
  check('motion: the first trace() adds one aria-hidden .trace span with one i child and starts its band (--dur-trace)',
    traced.one.rings === 1 && eq(traced.one.children, ['i']) && traced.one.hidden === 'true' && traced.one.fail === false && traced.one.onBand &&
    traced.one.timing?.duration === traced.one.token && traced.one.timing?.fill === 'none', traced.one);
  check('motion: a second trace() reuses the span, sets is-fail for fail: true and cancels the running band before it starts the next',
    traced.two.rings === 1 && traced.two.reused && traced.two.fail === true && traced.two.firstState === 'idle' && traced.two.bandAnimations === 1 &&
    traced.two.secondRunning && traced.two.timing?.delay === 30, traced.two);
  check('motion: a third trace() clears is-fail, cancels the fail band and runs --dur-trace-open for open: true; a detached pane gets null and no span',
    traced.three.rings === 1 && traced.three.reused && traced.three.fail === false && traced.three.secondState === 'idle' &&
    traced.three.bandAnimations === 1 && traced.three.timing?.duration === traced.three.token && traced.detached && traced.missing, traced);
  const helpers = await lab('motion.helpers');
  check('motion: flash() starts one animation on the cell (--dur-flash, fill "none")',
    helpers.flash.started === 1 && helpers.flash.timing?.duration === helpers.flash.token && helpers.flash.timing?.fill === 'none', helpers.flash);
  check('motion: enterOnce() starts one animation the first time and nothing the second; another element enters on its own',
    helpers.enter.first === 1 && helpers.enter.replayed === 0 && helpers.enter.other === 1, helpers.enter);
  check('motion: sweepOnce() runs once per 5 s per element (a second call sweeps nothing); a track without a head gets one and sweeps',
    eq(helpers.sweep.swept, [true, false]) && helpers.sweep.heads === 1 && helpers.sweep.headAnimations === 1 && helpers.sweep.other.swept === true &&
    helpers.sweep.other.heads === 1 && helpers.sweep.other.host && helpers.sweep.other.headAnimations === 1, helpers.sweep);
  check('motion: fillTo() writes the final --fill at once, clamped to 0…1, and throws on a non-finite fraction',
    helpers.fill.value === '0.4' && helpers.fill.clamped === '1' && /^RangeError: .*finite number/.test(helpers.fill.nan), helpers.fill);
  const staged = await lab('motion.stage');
  check('motion: stageTransition().enter() staggers the first three [data-stage-group] children by --stagger from +16 px; a fourth and the stage itself get nothing',
    staged.stagger > 0 && eq(staged.groups.map(g => g.count), [1, 1, 1, 0]) &&
    eq(staged.groups.slice(0, 3).map(g => g.timing.delay), [0, staged.stagger, 2 * staged.stagger]) &&
    staged.groups.slice(0, 3).every(g => g.timing.first.transform === 'translateX(16px)') && staged.stageItself === 0, staged);
  check('motion: without stage groups the element itself enters (back: from -16 px, no delay)',
    staged.plain.length === 1 && staged.plain[0].first.transform === 'translateX(-16px)' && staged.plain[0].delay === 0, staged.plain);
  const left = await lab('motion.leave');
  const exitMs = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-exit')));
  check('motion: leave() fades the element and resolves on a timer after --dur-exit', exitMs > 0 && left.ms >= exitMs - 2 && left.animations === 1, { ...left, exitMs });
  const tokens = await lab('motion.tokens');
  check('motion: token(), ms() and ease() throw on a missing token; ms() throws on a token that is not a duration and reads one that is',
    /--lab-missing is missing/.test(tokens.missingToken) && /--lab-missing is missing/.test(tokens.missingMs) &&
    /--lab-missing is missing/.test(tokens.missingEase) && /--ease-out is not a duration/.test(tokens.notDuration) && tokens.exit === exitMs, tokens);

  // ---- accessibility helpers and glyphs ------------------------------------------------------------------------------
  const announced = await lab('a11y.announce');
  await pause(120);
  const repeated = await lab('a11y.announcerText');
  check('a11y: one visually hidden polite status announcer; throttleKey limits a key to one per 15 s; a repeat is re-written',
    announced.role === 'status' && announced.live === 'polite' && announced.atomic === 'true' && announced.className === 'visually-hidden' &&
    announced.first && announced.text1 === 'First sentence.' && announced.inBody && eq(announced.throttled, [true, false]) &&
    announced.text2 === 'Count one' && announced.blank === false && announced.single === 1 && announced.repeat && announced.clearedForRepeat === '' &&
    repeated === 'Same sentence.', { announced, repeated });
  const narration = await lab('a11y.narrate');
  check('a11y: narration announces key changes at once, counts at most every 15 s and only across a 10 % boundary',
    eq(narration.results, [true, false, true, false, true]) && narration.text === 'Sorting 0 of 100', narration);
  const heading = await lab('a11y.focusHeading');
  check('a11y: focusHeading() focuses the stage h1 with tabindex -1', heading.ok && heading.tabindex === '-1' && heading.active, heading);
  const trapStart = await lab('a11y.openTrap');
  await page.keyboard.press('Shift+Tab');
  const wrappedBack = await lab('a11y.activeId');
  await page.keyboard.press('Tab');
  const wrappedForward = await lab('a11y.activeId');
  await page.focus('#trigger');
  const pulledBack = await lab('a11y.activeId');
  const closed = await lab('a11y.closeTrap');
  check('a11y: trapFocus wraps Tab and Shift+Tab and pulls escaping focus back; restoreFocus returns it to the trigger',
    trapStart === 'd1' && wrappedBack === 'd3' && wrappedForward === 'd1' && pulledBack === 'd1' && closed.restored && closed.active === 'trigger' && closed.gone === false,
    { trapStart, wrappedBack, wrappedForward, pulledBack, closed });
  const glyphList = await lab('glyphs.render');
  check(`glyphs: all ${glyphList.length} glyphs are aria-hidden, unfocusable 16 px SVGs with content`,
    glyphList.length >= 10 && glyphList.every(g => g.tag === 'svg' && g.hidden === 'true' && g.focusable === 'false' && g.viewBox === '0 0 16 16' && g.data === g.name && g.parts > 0 && g.box === 16),
    glyphList.filter(g => !(g.hidden === 'true' && g.parts > 0)));

  // ---- leaks, errors and requests -------------------------------------------------------------------------------------
  const finish = await lab('finish');
  check('no leaks: after the last unmount, liveEffectCount() is back at its baseline', finish.live === finish.baseline, finish);
  check('no page errors, no console errors and no failed responses',
    pageErrors.length === 0 && consoleErrors.length === 0 && failedResponses.length === 0, { pageErrors, consoleErrors, failedResponses });
  check('zero requests to any origin other than the local lab server', foreign.length === 0, foreign);

  const failed = checks.filter(c => !c.ok);
  writeFileSync(join(EVIDENCE, '00-dom-lab.json'), JSON.stringify({
    script: 'scripts/ui-flow/00-dom-lab.mjs', at: new Date().toISOString(), browser: `msedge ${edgeVersion} (headless)`,
    node: process.version, passed: checks.length - failed.length, failed: failed.length, checks,
    screenshots: ['00-dom-lab-actions-dark.png'],
  }, null, 2) + '\n');
  console.log(`\nDOM lab: ${checks.length - failed.length} of ${checks.length} checks passed on Edge ${edgeVersion}.`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  writeFileSync(join(EVIDENCE, '00-dom-lab.json'), JSON.stringify({
    script: 'scripts/ui-flow/00-dom-lab.mjs', at: new Date().toISOString(), error: String(error?.stack ?? error), checks, pageErrors, consoleErrors,
  }, null, 2) + '\n');
} finally {
  await browser.close();
  await server.close();
}
process.exit(exitCode);
