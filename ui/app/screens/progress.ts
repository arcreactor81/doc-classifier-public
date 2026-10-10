/**
 * Progress (journey steps 4 and 5; The Sorting Room's "Send" and "Sort"): the step body of a run that is being sent,
 * then sorted. The page changes in place as the run moves (SPEC §2.6 rule 2); no poll changes the address.
 *
 * Send (step 4): one paper sheet per document the run expects (`/plan`), under the uplink. A sheet turns into a strip
 * and flies up when its text has been sent (the run's real upload count, and this tab's own count while it sends);
 * files that could not be read are dark sheets. Beneath them the big count and the bar.
 *
 * Sort (step 5): the three trays (a canvas illustration) fill from the run's real decided counts, with the counts in
 * the DOM beneath them; the big count and the three-part bar; "Spending"; "What's happening now" (the run's recorded
 * events). When sorting finishes the status group becomes the done banner with its check stamp.
 *
 * The status group (the live light, a provider wait, a refused document, the one action of the state from
 * `journeyPrimary`, and "Discard this run…" while sorting) is built once and never rebuilt, so an action's outcome
 * stays where the action was (SPEC §5.3). A stopped run is never continued: its action starts a new run with the
 * unfinished documents (core/ui/new-run-documents.ts).
 *
 * Motion: sheets fly, sorted documents drop into their trays and new log lines slide in only on a real change; it
 * always plays, whatever the system's motion setting (DECISIONS 155 addendum, 10 October 2026).
 */
import './progress.css';
import { computed, effect, onCleanup, untrack, type Read } from '../../../core/ui/reactive.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText, progressStep } from '../../../core/ui/journey.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { money, time } from '../../../core/ui/format.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { newRunDocuments } from '../../../core/ui/new-run-documents.ts';
import type { DocView, PlanView, RunView } from '../../../core/ui/run-view.ts';
import { readerFamilyOf, type ModelVendor } from '../../../core/config/project.ts';
import { each, h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { frameLoop, onSignature } from '../view/motion.ts';
import { navigate } from '../router.ts';
import type { RunStore, SendState } from '../state/types.ts';
import { beat, statusLight } from '../components/status-light.ts';
import { runLightOf } from '../shell/subject-light.ts';
import { actionSlot } from '../components/action-slot.ts';
import { count } from '../components/count.ts';
import { errorNotice, notice } from '../components/notice.ts';
import { words } from '../components/words.ts';
import { journeyPrimary, type PrimaryHandlers } from '../shell/primary.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import type { ActionSpec } from '../view/action.ts';

type Phase = 'sending' | 'handingOver' | 'sorting' | 'sorted' | 'stopped' | 'closing' | 'discarded' | 'loading';

function phaseOf(view: RunView | null): Phase {
  if (view === null) return 'loading';
  switch (view.status) {
    case 'uploading': return 'sending';
    case 'running': return view.undispatched > 0 ? 'handingOver' : 'sorting';
    case 'complete': return 'sorted';
    case 'halted': return 'stopped';
    case 'closing': return 'closing';
    case 'closed': return view.decided === view.total ? 'sorted' : 'discarded';
  }
}

type Counts = { filed: number; review: number; failed: number };

/** What every part of the page reads. */
interface Live {
  ctx: ViewContext;
  run: RunStore;
  view: Read<RunView | null>;
  phase: Read<Phase>;
  /** Step 4 (send and hand over) is under way, or the run is still being read for the first time. */
  sendPhase: Read<boolean>;
  total: Read<number | null>;
  /** Documents sent: the service's count, or this tab's while it sends (it runs ahead of the next status read). */
  sent: Read<number>;
  decided: Read<number>;
  counts: Read<Counts>;
  plan: Read<PlanView | null>;
  /** Files the run expects that could not be read. */
  unread: Read<number>;
  failed: Read<boolean>;
  sending: Read<boolean>;
  readerVendor: Read<ModelVendor | null>;
}

export function progressScreen(ctx: ViewContext<RouteOf<'progress'>>): Node {
  const copy = ctx.copy, c = copy.screenProgress;
  const runId = ctx.route.peek().runId;
  const run = ctx.store.runStore(runId);
  const view = run.view;
  const phase = computed(() => phaseOf(view()));

  const handlers: PrimaryHandlers = {
    [`progress:continue-send:${runId}`]: async fb => { await ctx.controllers.send(runId).run(fb); },
    [`progress:discard:${runId}`]: async fb => { await ctx.controllers.send(runId).discard(fb); },
    [`progress:retry-unfinished:${runId}`]: async () => {
      const documents = await unfinishedDocuments(run, c.retryUnfinishedFailed);
      const { localId } = ctx.store.startRetryDraft({ parentRunId: runId, documents });
      navigate(formatRoute({ view: 'files', localId }));
    }
  };
  const discardSheet = { title: c.discardSheet.title, lines: c.discardSheet.lines, confirmLabel: c.discardSheet.confirm };
  const primary = journeyPrimary(ctx.journey, handlers, id =>
    id === `progress:discard:${runId}` ? { confirm: discardSheet, errorContext: 'close' }
      : id === `progress:retry-unfinished:${runId}` ? { note: c.retryUnfinishedNote, errorContext: 'read' }
        : { errorContext: 'send' });

  const total = computed(() => view()?.total ?? null);
  const sending = computed(() => { const s = run.send(); return s.kind === 'sending' || s.kind === 'handing-over'; });
  const sent = computed(() => {
    const s = run.send(), n = view()?.uploaded ?? 0;
    return s.kind === 'sending' ? Math.max(n, s.sent) : n;
  });
  const decided = computed(() => view()?.decided ?? 0);
  const counts = computed<Counts>(() => {
    const o = view()?.outcomes;
    return { filed: o?.filed ?? 0, review: o?.review ?? 0, failed: o?.couldNotProcess ?? 0 };
  }, { equals: (a, b) => a.filed === b.filed && a.review === b.review && a.failed === b.failed });
  const sendPhase = computed(() => { const p = phase(); return p === 'sending' || p === 'handingOver' || p === 'loading'; });
  const runLight = runLightOf(ctx.store, runId, ctx.journey);
  const failed = computed(() => runLight.light().kind === 'failed');
  if (run.plan.peek().state === 'idle') void run.loadPlan();
  const plan = computed(() => { const p = run.plan(); return p.state === 'ready' ? p.value : null; });
  const unread = computed(() => plan()?.expected.filter(doc => doc.extractionFailed).length ?? 0);
  const readerVendor = computed(() => {
    const pin = plan()?.readerModel?.pin;
    return pin === undefined ? null : readerFamilyOf(pin)?.vendor ?? null;
  });
  const live: Live = { ctx, run, view, phase, sendPhase, total, sent, decided, counts, plan, unread, failed, sending, readerVendor };

  const title = computed(() => {
    const p = phase(), t = total();
    return p === 'loading' || t === null ? copy.loading : c.title[p](t);
  });
  // "Step 4 of 8 · Send" while sending, "Step 5 of 8 · Sort" from then on: the step the ledger marks, so a run stopped
  // part-way through sending says Send.
  const eyebrow = computed(() => {
    const state = ctx.journey();
    const step = progressStep(state.state === 'ready' ? state.view.current : null, sendPhase());
    return copy.journey.stepOf(STEPS.indexOf(step) + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS[step] }, copy));
  });

  const light = statusLight({ ...runLight, testid: 'progress-light' });
  const discardWhileSorting: ActionSpec = {
    id: `progress:discard-sorting:${runId}`, label: c.discard, kind: 'quiet', confirm: discardSheet, errorContext: 'close',
    run: async fb => { await ctx.controllers.send(runId).discard(fb); }
  };
  const sortingDiscard = computed(() => (view()?.status === 'running' && !sending() ? discardWhileSorting : null));
  const done = computed(() => phase() === 'sorted');
  // The status group. Sorted, it is the done banner: the check stamp, "Sorting finished" and its summary, the action.
  const head = h('div', { class: 'live-head', classes: { 'done-banner': done, 'is-failed': failed } },
    show(done, () => h('span', { class: 'check-stamp', attrs: { 'aria-hidden': 'true' } }, glyph('check', { size: 18 }))),
    h('div', { class: 'live-head__text' },
      show(done, () => h('b', null, c.sortedTitle)),
      show(done, () => h('span', null, computed(() => { const k = counts(); return c.sortedSummary(k.filed, k.review, k.failed); }))),
      light,
      waitNotices(run.providerWaits),
      rejectedNotice(ctx, run.send, phase),
      show(computed(() => phase() === 'stopped'), () => stopCard(view))),
    h('div', { class: 'live-head__acts' },
      actionSlot(primary, { testid: 'progress-primary' }),
      actionSlot(sortingDiscard, { testid: 'progress-discard' })));

  onSignature(run, event => {
    if (event.kind !== 'outcome' || event.outcome !== 'failed') return;
    beat(light);
  });

  return h('section', { class: 'progress', testid: 'progress', attrs: { 'data-phase': phase } },
    h('div', { class: 'step-eyebrow' }, eyebrow),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(title)),
    show(sendPhase, () => h('p', { class: 'lede' }, c.sendLede)),
    head,
    show(sendPhase, () => sendPanel(live), () => sortBody(live)));
}

// ---------- Step 4: Send ----------

/** At most this many sheets; past it each sheet stands for several documents. */
const MAX_SHEETS = 240;

function sendPanel(live: Live): HTMLElement {
  const { total, sent, plan, sending, failed } = live;
  const c = live.ctx.copy.screenProgress;
  // The sheets: one per expected document (grouped past MAX_SHEETS), dark when its file could not be read.
  const sheets = computed(() => {
    const expected = plan()?.expected ?? [];
    const n = expected.length > 0 ? expected.length : total() ?? 0;
    const per = Math.max(1, Math.ceil(n / MAX_SHEETS));
    const out: { bad: boolean; last: number }[] = [];
    for (let i = 0; i < n; i += per) {
      const group = expected.slice(i, i + per);
      out.push({ bad: group.length > 0 && group.every(doc => doc.extractionFailed), last: Math.min(n, i + per) });
    }
    return out;
  }, { equals: (a, b) => a.length === b.length && a.every((s, i) => s.bad === b[i].bad && s.last === b[i].last) });
  const grid = h('div', { class: 'sendgrid', attrs: { 'aria-hidden': 'true' } });
  effect(() => {
    const list = sheets();
    untrack(() => {
      while (grid.firstChild) grid.firstChild.remove();
      for (const sheet of list) grid.append(h('i', { classes: { bad: sheet.bad } }));
    });
  });
  // A sheet flies when every document it stands for has been sent (plan order is the send order).
  effect(() => {
    const n = sent(), list = sheets();
    untrack(() => list.forEach((sheet, i) => grid.children[i]?.classList.toggle('gone', sheet.last <= n)));
  });
  const fraction = computed(() => { const t = total() ?? 0; return t === 0 ? 0 : Math.min(1, sent() / t); });
  const allSent = computed(() => total() !== null && sent() >= (total() ?? 0) && (total() ?? 0) > 0);
  return h('div', { class: 'panel send' },
    h('div', { class: 'uplink', attrs: { 'aria-hidden': 'true' } }, h('span', null, c.uplink)),
    grid,
    h('p', { class: 'visually-hidden' }, c.sendSheets),
    h('p', { class: 'bigcount', testid: 'progress-count' },
      h('b', null, count(sent, { class: 'count__n num' })), ' ',
      h('span', null, computed(() => c.countSent(total() ?? 0)))),
    h('div', {
      class: 'bar', classes: { live: computed(() => sending() && !failed()) },
      attrs: {
        role: 'progressbar', 'aria-label': c.sentTrack, 'aria-valuemin': 0, 'aria-valuemax': computed(() => total() ?? 0),
        'aria-valuenow': sent, 'aria-valuetext': computed(() => c.sent(sent(), total() ?? 0))
      },
      testid: 'progress-sent'
    }, h('i', { vars: { '--f': fraction } })),
    show(allSent,
      () => h('div', { class: 'done-banner', attrs: { role: 'status' } },
        h('span', { class: 'check-stamp', attrs: { 'aria-hidden': 'true' } }, glyph('check', { size: 18 })),
        h('div', { class: 'done-banner__text' },
          h('b', null, computed(() => c.allSent(total() ?? 0))),
          show(computed(() => live.unread() > 0), () => h('span', null, computed(() => c.unreadNote(live.unread())))))),
      () => h('p', { class: 'hint' }, c.sendHint)));
}

// ---------- Step 5: Sort ----------

function sortBody(live: Live): HTMLElement {
  const { total, sent, decided, counts, phase, unread } = live;
  const c = live.ctx.copy.screenProgress;
  const t = c.tally;
  const fill = (key: keyof Counts) => computed(() => { const n = total() ?? 0; return n === 0 ? 0 : counts()[key] / n; });
  const undecided = computed(() => Math.max(0, (total() ?? 0) - decided()));
  const allSent = computed(() => { const n = total(); return n !== null && sent() >= n; });
  return h('div', { class: 'sort-body' },
    show(computed(() => phase() !== 'sorted'), () => h('div', { class: 'panel sentline' },
      show(allSent, () => glyph('check', { class: 'sentline__glyph' })),
      h('b', null, computed(() => allSent() ? c.allSent(total() ?? 0) : c.sentSoFar(sent(), total() ?? 0))),
      show(computed(() => unread() > 0), () => h('span', { class: 'sentline__note' }, computed(() => c.unreadNote(unread())))))),
    h('div', { class: 'grid-2 sort-grid' },
      h('div', { class: 'stack-v' },
        trays(live),
        h('div', { class: 'panel' },
          h('p', { class: 'bigcount', testid: 'progress-count' },
            h('b', null, count(decided, { class: 'count__n num' })), ' ',
            h('span', null, computed(() => c.countDecided(total() ?? 0)))),
          h('div', {
            class: 'bar tri', testid: 'progress-sorted',
            attrs: {
              role: 'img', 'aria-label': computed(() => {
                const k = counts(); return c.pipeValue(total() ?? 0, k.filed, k.review, k.failed, undecided());
              })
            }
          },
          h('i', { class: 'tri-f', vars: { '--f': fill('filed') } }),
          h('i', { class: 'tri-p', vars: { '--f': fill('review') } }),
          h('i', { class: 'tri-u', vars: { '--f': fill('failed') } })),
          show(computed(() => phase() === 'sorting' || phase() === 'handingOver'), () => h('p', { class: 'hint' }, c.closeHint)))),
      h('div', { class: 'stack-v' },
        spendPane(live),
        activity(live))),
    h('p', { class: 'visually-hidden', testid: 'progress-tallies' },
      computed(() => { const k = counts(); return `${t.filed} ${k.filed}, ${t.review} ${k.review}, ${t.couldNotProcess} ${k.failed}`; })));
}

/** Tray colours (the canvas cannot read CSS custom properties cheaply on every frame; the trays are always dark). */
const SHEET = ['#F1ECE2', '#FF5AA8', '#8C877C'];
const RIM = ['#E6FF3B', '#FF5AA8', '#8C877C'];
const GLOW = ['rgba(230,255,59,.10)', 'rgba(255,90,168,.10)', 'rgba(200,194,180,.06)'];
/** At most this many sheets fall for one change; each stands for its share of the change. */
const MAX_FALLING = 10;

interface Falling { k: number; docs: number; x: number; rot: number; t: number; delay: number }

/**
 * The three trays: a canvas illustration over the counts. Documents already decided when the page opens are stacked
 * at once; each later change drops sheets from the slot into their tray. The counts are DOM text beneath the canvas.
 */
function trays(live: Live): HTMLElement {
  const { counts, total } = live;
  const c = live.ctx.copy.screenProgress, t = c.tally;
  const canvas = h('canvas', { attrs: { 'aria-hidden': 'true' } });
  const landed = [0, 0, 0];
  const target = [0, 0, 0];
  let falling: Falling[] = [];
  let first = true;
  let W = 0, H = 0, loop: (() => void) | null = null;

  const size = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const draw = (dt: number): boolean => {
    const g = canvas.getContext('2d');
    if (g === null || W === 0) return falling.length > 0;
    g.clearRect(0, 0, W, H);
    const floorY = H - 58, tw = Math.min(150, W / 3 - 28), tray = (k: number) => W * (k + 0.5) / 3;
    const room = Math.max(8, floorY - 40), maxStrips = Math.max(1, Math.floor(room / 8));
    const all = Math.max(1, total() ?? 1);
    const per = Math.max(1, Math.ceil(all / maxStrips));
    const step = Math.min(8, room / Math.ceil(all / per));
    const stripH = Math.max(2, Math.min(7, step - 1));
    for (let k = 0; k < 3; k++) {
      const x = tray(k);
      const gr = g.createLinearGradient(0, floorY - 140, 0, floorY);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, GLOW[k]);
      g.fillStyle = gr; g.fillRect(x - tw / 2, floorY - 140, tw, 140);
      g.fillStyle = '#2E2C27'; g.fillRect(x - tw / 2 - 6, floorY, tw + 12, 6);
      g.fillStyle = RIM[k]; g.fillRect(x - tw / 2 - 6, floorY + 6, tw + 12, 2);
      const strips = Math.ceil(landed[k] / per);
      for (let i = 0; i < strips; i++) {
        const w2 = tw * 0.42;
        g.save(); g.translate(x + Math.sin(i * 2.1) * 5, floorY - 5 - i * step); g.rotate(Math.sin(i * 1.3) * 0.05);
        g.fillStyle = SHEET[k]; g.fillRect(-w2, -stripH / 2, w2 * 2, stripH);
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(-w2, stripH / 2 - 1, w2 * 2, 1);
        g.restore();
      }
    }
    g.fillStyle = '#2E2C27'; g.fillRect(W / 2 - 80, 0, 160, 8); g.fillStyle = '#E6FF3B'; g.fillRect(W / 2 - 80, 8, 160, 2);
    const still: Falling[] = [];
    for (const p of falling) {
      if (p.delay > 0) { p.delay -= dt; still.push(p); continue; }
      p.t = Math.min(1, p.t + dt * 1.5);
      const e = 1 - Math.pow(1 - p.t, 3);
      const tx = tray(p.k), ty = floorY - 5 - Math.ceil(landed[p.k] / per) * step;
      const cx = p.x + (tx - p.x) * e, cy = -40 + (ty + 40) * e - Math.sin(e * Math.PI) * 60;
      g.save(); g.translate(cx, cy); g.rotate(p.rot * (1 - e));
      g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 16; g.fillStyle = SHEET[p.k]; g.fillRect(-24, -31, 48, 62);
      g.shadowBlur = 0; g.fillStyle = 'rgba(30,28,23,.6)'; g.fillRect(-17, -22, 26, 5);
      for (let l = 0; l < 6; l++) g.fillRect(-17, -10 + l * 6, 34, 2);
      g.restore();
      if (p.t >= 1) landed[p.k] += p.docs; else still.push(p);
    }
    falling = still;
    return falling.length > 0;
  };
  const play = (): void => {
    if (!canvas.isConnected) {
      for (const p of falling) landed[p.k] += p.docs;
      falling = [];
      draw(0);
      return;
    }
    if (loop !== null) return;
    let last = performance.now();
    loop = frameLoop(now => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const more = draw(dt);
      if (!more) loop = null;
      return more;
    });
  };
  effect(() => {
    const k = counts();
    untrack(() => {
      const next = [k.filed, k.review, k.failed];
      for (let i = 0; i < 3; i++) {
        const diff = next[i] - target[i];
        target[i] = next[i];
        if (first || diff <= 0) {
          falling = falling.filter(p => p.k !== i);
          landed[i] = next[i];
          continue;
        }
        const drops = Math.min(MAX_FALLING, diff);
        for (let d = 0; d < drops; d++) {
          const docs = Math.floor(diff / drops) + (d < diff % drops ? 1 : 0);
          falling.push({ k: i, docs, x: W / 2 + (Math.random() - 0.5) * 60, rot: (Math.random() - 0.5) * 0.6, t: 0, delay: d * 0.12 });
        }
      }
      first = false;
      queueMicrotask(play);
    });
  });
  const observer = new ResizeObserver(() => { size(); if (loop === null) draw(0); });
  observer.observe(canvas);
  onCleanup(() => { observer.disconnect(); loop?.(); loop = null; });

  const label = (word: string, n: Read<number>, cls: string) =>
    h('div', null, h('span', null, word), h('b', { class: cls }, count(n, { class: 'num' })));
  return h('div', { class: 'trays-wrap', attrs: { role: 'group', 'aria-label': c.trays } },
    canvas,
    h('div', { class: 'trays-lbl' },
      label(t.filed, computed(() => counts().filed), 'tray-f'),
      label(t.review, computed(() => counts().review), 'tray-p'),
      label(t.couldNotProcess, computed(() => counts().failed), 'tray-u')));
}

/**
 * The stopped run's documents for its new run (core/ui/new-run-documents.ts: those without an outcome, and those set
 * aside because their saved records could not be confirmed in storage). The plan is read first, so a document never
 * sent counts as unfinished too; when it cannot be read nothing is started and the plain sentence is the problem.
 */
async function unfinishedDocuments(run: RunStore, unavailable: string): Promise<{ fingerprint: string; originalFilename: string }[]> {
  if ((await run.loadPlan()) === null) throw new Error(unavailable);
  const docs = run.order.peek().map(key => run.docs.get(key)?.peek()).filter((doc): doc is DocView => doc !== undefined);
  return newRunDocuments(docs);
}

function stopCard(view: Read<RunView | null>): Node {
  const stop = computed(() => view()?.stop ?? null);
  return show(computed(() => stop() !== null), () => errorNotice(computed(() => stop()!), 'problem', 'progress-stopped'));
}

/** A refused document, while the run is still sending (its advice, "discard it", means nothing once it is closed). */
function rejectedNotice(ctx: ViewContext, send: Read<SendState>, phase: Read<Phase>): Node {
  const c = ctx.copy.screenProgress;
  return show(computed(() => send().kind === 'rejected' && phase() === 'sending'), () => notice({
    kind: 'problem', testid: 'progress-rejected', failure: true,
    headline: computed(() => { const s = send(); return c.rejected(s.kind === 'rejected' ? s.filename : ''); })
  }));
}

function waitNotices(waits: Read<readonly { scope: 'openai' | 'typesafe'; until: number }[]>): Node {
  const c = activeUiCopy.screenProgress;
  const line = computed(() => waits().map(wait => c.providerWait(c.services[wait.scope], time(wait.until))).join(' '));
  return show(computed(() => waits().length > 0), () => notice({ kind: 'info', headline: line, testid: 'progress-wait' }));
}

/** "What's happening now": the run's recorded events, newest first; each row keeps its element as the list moves. */
function activity(live: Live): HTMLElement {
  const { run } = live;
  const c = live.ctx.copy.screenProgress;
  const keys = computed(() => run.recent().map(entry => entry.id));
  const atMount = new Set(run.recent.peek().map(entry => entry.id));
  const byId = (id: string) => {
    let last = run.recent.peek().find(entry => entry.id === id)!;
    return computed(() => (last = run.recent().find(entry => entry.id === id) ?? last));
  };
  return h('section', { class: 'panel activity', testid: 'progress-activity' },
    h('h3', null, c.activityTitle),
    show(computed(() => run.recent().length > 0), () => h('ul', { class: 'log' },
      each(keys, byId, entry => h('li', { class: atMount.has(entry.peek().id) ? '' : 'row-in' },
        h('time', { attrs: { datetime: computed(() => new Date(entry().at).toISOString()) } }, computed(() => time(entry().at))),
        h('span', null, computed(() => phraseText(entry().line, activeUiCopy)))))),
    () => h('p', { class: 'hint' }, c.activityEmpty)));
}

/**
 * "Spending": what the run has cost so far and its limit. Unknown spend is never shown as a number (SPEC §0.1 rule 4):
 * while a charge is unaccounted the amount reads Unknown, with the known part beneath it.
 */
function spendPane(live: Live): HTMLElement {
  const { view, phase } = live;
  const c = live.ctx.copy.screenProgress.spend, p = live.ctx.copy.screenProgress, common = live.ctx.copy.common;
  const spend = computed(() => view()?.spend ?? null);
  const budget = computed(() => view()?.budget ?? null);
  const amount = computed(() => { const s = spend(); return s === null || s.unknown ? common.unknown : money(s.blended); });
  const limit = computed(() => {
    const b = budget();
    if (b === null) return '';
    if (b.mode === 'unlimited') return c.noLimit;
    return b.limits.blended === null ? c.providerLimits : c.of(money(b.limits.blended));
  });
  const fraction = computed(() => {
    const b = budget(), s = spend();
    if (b === null || s === null || b.mode === 'unlimited' || b.limits.blended === null) return null;
    const cap = BigInt(b.limits.blended);
    return cap <= 0n ? null : Math.min(1, Number((BigInt(s.blended) * 1000n) / cap) / 1000);
  });
  const known = computed(() => { const s = spend(); return s !== null && s.unknown ? c.known(money(s.blended)) : ''; });
  const split = computed(() => {
    const s = spend(), vendor = live.readerVendor();
    if (s === null) return '';
    return vendor === 'cloudflare' || vendor === 'deepseek'
      ? c.splitReader(c.readerServices[vendor], money(s.openai), money(s.typesafe)) : c.split(money(s.openai), money(s.typesafe));
  });
  const note = computed(() => {
    const s = spend();
    if (s === null) return '';
    if (s.pendingAccounting > 0) return c.pending(s.pendingAccounting);
    return phase() === 'sorted' ? c.allReported : '';
  });
  const line = (text: Read<string>) => show(computed(() => text() !== ''), () => h('p', { class: 'hint' }, text));
  return h('section', { class: 'panel spend', testid: 'progress-spend' },
    h('h3', null, c.title),
    h('p', { class: 'spendbig num' }, amount),
    h('p', { class: 'hint' }, computed(() => [limit(), p.fromVendors].filter(text => text !== '').join(' · '))),
    show(computed(() => fraction() !== null), () => h('div', { class: 'bar', attrs: { 'aria-hidden': 'true' } },
      h('i', { vars: { '--f': computed(() => fraction() ?? 0) } }))),
    line(known), line(split), line(note));
}
