/**
 * Pieces Home, Welcome and Runs share: the run list with each run's number, a run's card facts (which step it is on,
 * in which words, and whether the next step is the person's), the run cards, the run waiting for the person, and the
 * Sorting Room's story (the hero chapter, the four "How it works" chapters and the picture that follows them).
 *
 * A run's step is read from the run list (status, counts, and which later run was checked against its answers) and
 * from this computer's records of its local steps (folders made, review saved, answers, categories): everything Home
 * can know without opening the run. Not known here: a review saved in another browser (the run's own page reads the
 * server's corrections), and whether a send has stalled (the run's page has the send lock and this browser's text).
 * Such a run shows the last step this computer knows. The cards and the picture are drawn from one `CardRow` per
 * run, so they cannot disagree.
 */
import { computed, effect, onCleanup, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { runOrdinals } from '../../../core/ui/run-naming.ts';
import { dateShort, epoch, timeShort } from '../../../core/ui/format.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText, type StepId } from '../../../core/ui/journey.ts';
import type { Light, LightKind, LightWord } from '../../../core/ui/live-light.ts';
import type { UiCopy } from '../../../core/ui/project-copy.ts';
import type { RunSummaryView } from '../../../core/ui/wire.ts';
import { continueLabel } from '../../../core/ui/home-continue.ts';
import type { ActionSpec } from '../view/action.ts';
import { each, h, show } from '../view/dom.ts';
import { glyph, type GlyphName } from '../view/glyphs.ts';
import { actionSlot } from '../components/action-slot.ts';
import { runCard, STEP_COUNT, type CardState } from '../components/run-card.ts';
import { words } from '../components/words.ts';
import { sheetsScene } from '../components/sheets-scene.ts';
import type { AppStore, RunLocalRecords } from '../state/types.ts';

export interface NamedRun { run: RunSummaryView; ordinal: number }

/** The run list (newest first), each run with its number. Reads the list now and while mounted (SPEC §4.5). */
export function watchedRuns(store: AppStore): Read<readonly NamedRun[] | null> {
  onCleanup(store.watchRunList());
  return computed(() => {
    const list = store.runList();
    if (list.state === 'ready') return named(list.value);
    if ((list.state === 'loading' || list.state === 'error') && list.previous !== null) return named(list.previous);
    return null;
  });
}

function named(runs: readonly RunSummaryView[]): NamedRun[] {
  const ordinals = runOrdinals(runs);
  return runs.map(run => ({ run, ordinal: ordinals.get(run.id) ?? 0 }));
}

/** A stopped run reads as a failure (VISUAL-SPEC §6: red), never as a pulse. Home and Runs never offer its actions. */
export function runFailed(run: RunSummaryView): boolean {
  return run.status === 'halted';
}

/** Every document has an outcome (the rule journey.ts uses for its complete rows). */
export function runComplete(run: RunSummaryView): boolean {
  return run.status === 'complete' || (run.status === 'closed' && run.completed === run.total);
}

const nextFinished = (next: RunSummaryView): boolean =>
  next.status === 'complete' || ((next.status === 'closed' || next.status === 'closing') && next.completed === next.total);

/** Where a run is, for its card and its place on the loop. */
export interface RunCardFacts {
  /** 1–8. */
  step: number;
  state: CardState;
  /** The still light's kind and word (the run's own words; the card never pulses). */
  light: Light;
  /** The card's sentence. */
  now: string;
  /** The short line under the run's name on the loop. */
  line: string;
  /** The next step is the person's: a finished run with steps left, or a run stopped or waiting for a check. */
  yours: boolean;
}

const stillLight = (kind: LightKind, word: LightWord): Light =>
  ({ kind, word, reason: { kind: 'none' }, key: `${kind}|${word}|none`, liveUntil: null });

const stepNumber = (id: StepId): number => STEPS.indexOf(id) + 1;

export function stepLabel(copy: UiCopy, step: number): string {
  return phraseText({ key: STEP_LABEL_KEYS[STEPS[step - 1]] }, copy);
}

export function cardFacts(copy: UiCopy, entry: NamedRun, local: RunLocalRecords | null, runs: readonly NamedRun[], now = Date.now()): RunCardFacts {
  const c = copy.home, r = entry.run;
  const at = (step: StepId, state: CardState, light: Light, now: string, line: string): RunCardFacts =>
    ({ step: stepNumber(step), state, light, now, line,
      yours: state === 'failed' || (state === 'still' && (line === c.arena.waiting || line === c.arena.runtimeWait)) });
  switch (r.status) {
    case 'uploading':
      return at('send', 'live', stillLight('live', 'sending'), c.now.sending(r.uploaded, r.total), c.sent(r.uploaded, r.total));
    case 'running':
      if (r.runtimeWait) return at('sort', 'still', stillLight('waiting', 'waiting'),
        now >= Date.parse(r.runtimeWait.deadlineAt) ? c.now.runtimeOverdue : c.now.runtimeWait, c.arena.runtimeWait);
      return r.uploaded < r.total
        ? at('send', 'live', stillLight('live', 'handingOver'), c.now.sending(r.uploaded, r.total), c.sent(r.uploaded, r.total))
        : at('sort', 'live', stillLight('live', 'working'), c.now.sorting(r.completed, r.total), c.outcomes(r.completed, r.total));
    case 'halted':
      return at(r.uploaded < r.total ? 'send' : 'sort', 'failed', stillLight('failed', 'stopped'), c.now.stopped(r.completed, r.total), c.arena.stopped);
    case 'closing':
      return r.completed === r.total
        ? at('results', 'still', stillLight('waiting', 'closing'), c.now.deletingText, c.arena.closing)
        : at('sort', 'still', stillLight('waiting', 'closing'), c.now.discarding, c.arena.closing);
    default:
      break;
  }
  if (!runComplete(r)) return at('sort', 'still', stillLight('idle', 'discarded'), c.now.discarded, c.arena.discarded);
  const sorted = stillLight('done', 'sorted');
  // Server evidence first: a later run checked against this run's answers means every step was taken and the
  // optional Improve area was used. A saved review means every step is done (the area after it is optional).
  const next = runs.find(item => item.run.comparedWith?.sourceRunId === r.id);
  if (next !== undefined) {
    const name = c.runNumber(next.ordinal);
    if (nextFinished(next.run)) return at('review', 'done', sorted, c.now.finished(name), c.arena.done);
    const active = next.run.status === 'uploading' || next.run.status === 'running';
    return at('review', 'done', sorted, active ? c.now.nextRunning(name) : c.now.nextStopped(name), c.arena.waiting);
  }
  // Then this computer's records of the local steps, latest first.
  if (local?.improve && (local.improve.keptAsIs !== null || local.improve.activatedRevisionId !== null))
    return at('review', 'done', sorted, local.answers?.saved ? c.now.answersSaved : c.now.decided, c.arena.waiting);
  if (local?.walk?.correctionId) return at('review', 'done', sorted, c.now.reviewed, c.arena.waiting);
  if (local?.build?.complete) return at('review', 'still', sorted, c.now.built, c.arena.waiting);
  if (local?.build) return at('build', 'still', sorted, c.now.building, c.arena.waiting);
  return at('results', 'still', sorted, c.now.sorted, c.arena.waiting);
}

export interface CardRow { entry: NamedRun; facts: RunCardFacts }

const sameFacts = (a: RunCardFacts, b: RunCardFacts): boolean =>
  a.step === b.step && a.state === b.state && a.light.key === b.light.key && a.now === b.now && a.line === b.line &&
  a.yours === b.yours;

function localOf(store: AppStore, run: RunSummaryView): RunLocalRecords | null {
  if (!runComplete(run)) return null;
  const state = store.runStore(run.id).local();
  return state.state === 'ready' ? state.value : state.state === 'idle' ? null : state.previous;
}

/** One row per listed run, with the facts its card and its place on the loop are drawn from. */
export function cardRows(store: AppStore, copy: UiCopy, runs: Read<readonly NamedRun[]>): Read<readonly CardRow[]> {
  // This computer's records of a finished run's local steps are read once per run while the list is shown.
  effect(() => {
    for (const { run } of runs()) {
      if (!runComplete(run)) continue;
      const runStore = store.runStore(run.id);
      if (runStore.local.peek().state === 'idle') untrack(() => void runStore.loadLocal());
    }
  });
  return computed(() => {
    const all = runs();
    const now = store.minuteClock();
    return all.map(entry => ({ entry, facts: cardFacts(copy, entry, localOf(store, entry.run), all, now) }));
  });
}

/** The keyed rows of `each()`: one Read per run id, following the list. */
export function rowById(rows: Read<readonly CardRow[]>): (id: string) => Read<CardRow> {
  return id => {
    const found = computed(() => rows().find(row => row.entry.run.id === id));
    let last: CardRow | undefined;
    return computed(() => (last = found() ?? last) as CardRow, { equals: (a, b) => a.entry === b.entry && sameFacts(a.facts, b.facts) });
  };
}

/** The status word on a card: "Waiting for you" when the next step is the person's, else the run's own light word. */
export function statusWord(copy: UiCopy, facts: RunCardFacts): string {
  return facts.yours && facts.state !== 'failed' ? copy.home.arena.waiting : copy.light.word[facts.light.word];
}

/** "Step 5 of 8 · Sort", or "All 8 steps done". */
export function stepLine(copy: UiCopy, facts: RunCardFacts): string {
  return facts.state === 'done' ? copy.home.allDone(STEP_COUNT) : copy.journey.stepOf(facts.step, STEP_COUNT, stepLabel(copy, facts.step));
}

/** The run cards, keyed by run id: an unchanged list changes no DOM. The list itself lays out as part of `.runs-row`. */
export function runCards(copy: UiCopy, rows: Read<readonly CardRow[]>, testid: string, heading: 'h2' | 'h4' = 'h4'): HTMLOListElement {
  const c = copy.home;
  const keys = computed(() => rows().map(row => row.entry.run.id));
  return h('ol', { class: 'run-cards', testid, attrs: { role: 'list' } },
    each(keys, rowById(rows), (row, id) => runCard({
      name: computed(() => c.runNumber(row().entry.ordinal)),
      when: computed(() => { const at = epoch(row().entry.run.createdAt); return c.runWhen(dateShort(at), timeShort(at)); }),
      startedAt: computed(() => row().entry.run.createdAt),
      badge: computed(() => row().entry.run.pilotSkipped ? copy.trial.withoutTrial : null),
      href: computed(() => formatRoute({ view: 'run', runId: id })),
      open: computed(() => c.open(c.runNumber(row().entry.ordinal))),
      step: computed(() => row().facts.step),
      state: computed(() => row().facts.state),
      yours: computed(() => row().facts.yours),
      status: computed(() => statusWord(copy, row().facts)),
      now: computed(() => row().facts.now),
      stepText: computed(() => stepLine(copy, row().facts)),
      heading
    })));
}

// ---------- The run waiting for the person ----------

/** A run that stopped, or waits for a check of interrupted work: the person should open it. */
export function needsAttention(run: RunSummaryView): boolean {
  return runFailed(run) || (run.status === 'running' && run.runtimeWait !== null && run.runtimeWait !== undefined);
}

/** The run Home's Continue card opens: one that needs attention first, else the newest whose next step is the person's. */
export function waitingRow(rows: Read<readonly CardRow[]>): Read<CardRow | null> {
  return computed(() => {
    const all = rows();
    return all.find(row => needsAttention(row.entry.run)) ?? all.find(row => row.facts.yours) ?? null;
  }, { equals: (a, b) => (a?.entry.run.id ?? null) === (b?.entry.run.id ?? null) && (a === null || b === null || sameFacts(a.facts, b.facts)) });
}

/** The pink Continue card: a link into the run, never an operation (recovery and discard stay on the run). */
export function continueCard(copy: UiCopy, row: Read<CardRow>): HTMLAnchorElement {
  const c = copy.home;
  return h('a', { class: 'continue', testid: 'home-continue', attrs: { href: computed(() => formatRoute({ view: 'run', runId: row().entry.run.id })) } },
    h('span', { class: 'pulse', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'cont-t' },
      h('span', { class: 'eyebrow continue__eyebrow' }, computed(() => c.continueEyebrow(c.runNumber(row().entry.ordinal)))),
      h('b', null, computed(() => row().facts.now)),
      h('span', null, computed(() => stepLine(copy, row().facts)))),
    // A stopped run is never continued: the label names what its page offers (core/ui/home-continue.ts).
    h('span', { class: 'btn go' }, computed(() => continueLabel(copy, row().entry.run, c.runNumber(row().entry.ordinal))), glyph('arrow-right')));
}

// ---------- The story: hero chapter, four chapters, and the picture ----------

/** Copy text parts: a plain string, `{ b }` in bold, `{ mark }` highlighted, `{ markPink }` highlighted in pink. */
type Part = string | { readonly b: string } | { readonly mark: string } | { readonly markPink: string };

function rich(parts: readonly Part[]): Node[] {
  return parts.map(part => typeof part === 'string' ? document.createTextNode(part)
    : 'b' in part ? h('b', null, part.b)
      : 'mark' in part ? h('span', { class: 'mark' }, part.mark)
        : h('span', { class: 'mark p' }, part.markPink));
}

const promise = (name: GlyphName, lead: string, more?: string): HTMLLIElement =>
  h('li', null, glyph(name, { size: 20 }), h('span', null, h('b', null, lead), more ? ` ${more}` : null));

export interface StoryParts {
  primary: Read<ActionSpec | null>;
  testid: string;
  /** A run is waiting for the person: the Continue card shows, and the primary steps back to a plain button. */
  waiting?: Read<CardRow | null>;
  /** A line above the action (Welcome: why the first step is the categories). */
  beforeAction?: Node;
  /** A line beneath the action row (Welcome: who can edit). */
  afterAction?: Node;
  /** The active categories' filing certainty (0–1), for chapter 4; null when there are none. */
  certainty: Read<number | null>;
  /** The active category names, for the picture's piles. */
  piles: Read<readonly string[]>;
}

/** Whether the chapters stack above the picture (one column): the picture then sits on top, pinned. */
const stacked = (story: Element): boolean => getComputedStyle(story).gridTemplateColumns.split(' ').length < 2;

/**
 * The Sorting Room's Home story: the hero chapter (overline, heading, lede, Continue card, primary, "How it works ↓",
 * promises), then four chapters; the picture beside them is pinned and follows the chapter being read. The chapter
 * nearest the reading line is lit, the others dimmed.
 */
export function story(copy: UiCopy, parts: StoryParts): HTMLElement {
  const c = copy.home, how = c.how;
  const waiting = parts.waiting ?? computed(() => null);
  const isWaiting = computed(() => waiting() !== null);
  const sure = computed(() => { const t = parts.certainty(); return t === null ? how.outcome.sureEnough : how.outcome.sureAt(Math.round(t * 100)); });
  const chapterDefs = [how.read, how.travel, how.readers] as const;
  // Chapter 4 names the active categories' certainty; its text is rebuilt when that changes.
  const outcomeText = h('p', null);
  effect(() => {
    const body: readonly Part[] = [...how.outcome.body, sure(), ...how.outcome.bodyEnd];
    untrack(() => { outcomeText.textContent = ''; outcomeText.append(...rich(body)); });
  });
  const chapters = [
    ...chapterDefs.map((ch, i) => h('section', { class: 'chapter dim', attrs: { 'data-ch': i + 1 } },
      h('div', { class: 'num' }, how.number(i + 1, 4)), h('h2', null, ch.title), h('p', null, ...rich(ch.body)))),
    h('section', { class: 'chapter dim', attrs: { 'data-ch': 4 } },
      h('div', { class: 'num' }, how.number(4, 4)), h('h2', null, how.outcome.title), outcomeText)
  ];
  const progress = signal(0), captionHidden = signal(false);
  const hero = h('section', { class: 'chapter hero-ch', classes: { 'is-waiting': isWaiting }, attrs: { 'data-ch': 0 } },
    h('div', { class: 'eyebrow' }, c.overline),
    h('h1', { class: 'h-display home-h1', attrs: { tabindex: -1 } }, words(c.headingTop), ' ', h('em', null, words(c.headingEm))),
    h('p', { class: 'lede' }, c.lede, ' ', h('span', { class: 'mark' }, c.ledeMark), c.ledeEnd),
    show(isWaiting, () => continueCard(copy, computed(() => waiting() ?? waiting.peek()!))),
    parts.beforeAction,
    h('div', { class: 'hero-cta' },
      actionSlot(parts.primary, { testid: parts.testid }),
      // ui-rules: non-operational button: scrolls the page to the first chapter.
      h('button', { class: 'link', attrs: { type: 'button' }, on: { click: () => scrollToHow() } },
        c.howItWorks, h('span', { attrs: { 'aria-hidden': 'true' } }, ' ↓'))),
    parts.afterAction,
    h('ul', { class: 'promises' },
      promise('lock', c.promises.originals, c.promises.originalsMore),
      promise('two', c.promises.agree),
      promise('shield', c.promises.control)));

  const all = [hero, ...chapters];
  const text = h('div', { class: 'story-text' },
    hero,
    h('div', { class: 'how-head', attrs: { id: 'how' } },
      h('div', { class: 'eyebrow how-head__eyebrow' }, how.eyebrow),
      h('p', { class: 'hint how-head__hint' }, how.hint)),
    ...chapters,
    h('div', { class: 'how-more', attrs: { 'data-build': '' } },
      h('div', null, h('b', null, how.moreTitle), h('span', null, how.moreText)),
      h('a', { class: 'btn go', attrs: { href: formatRoute({ view: 'help' }) } }, how.moreAction, glyph('arrow-right'))));
  const stage = h('div', { class: 'story-stage' },
    sheetsScene({
      progress, piles: parts.piles, caption: copy.home.scene.stir, captionHidden,
      labels: { check: c.scene.check, reader: c.scene.reader, filed: c.scene.filed, review: c.scene.review, failed: c.scene.failed }
    }));
  const root = h('div', { class: 'story home-story' }, text, stage);

  // The reading line: the chapter whose top has passed it is lit; the picture moves on through the second half of it.
  const onScroll = () => {
    if (!root.isConnected) return;
    const one = stacked(root);
    const mid = innerHeight * (one ? .74 : .5);
    let best = 0, prog = 0;
    all.forEach((ch, i) => {
      const r = ch.getBoundingClientRect();
      if (r.top < mid) { best = i; prog = Math.max(0, Math.min(1, (mid - r.top) / Math.max(1, r.height))); }
    });
    const s = Math.max(0, Math.min(4, best + (best < 4 ? Math.max(0, prog - .5) * 2 : 0)));
    all.forEach((ch, i) => { if (i) ch.classList.toggle('dim', i !== best); });
    progress.set(s);
    captionHidden.set(s >= .5);
  };
  const scrollToHow = () => {
    const first = chapters[0];
    const top = first.getBoundingClientRect().top + scrollY - innerHeight * (stacked(root) ? .6 : .3);
    scrollTo({ top, behavior: 'smooth' });
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  const laidOut = new ResizeObserver(onScroll);
  laidOut.observe(root);
  onCleanup(() => {
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onScroll);
    laidOut.disconnect();
  });
  return root;
}
