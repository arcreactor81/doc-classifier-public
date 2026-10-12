/**
 * Review the folders (SPEC §2.3, walkthroughs 3a steps 13–15 and 3c steps 3–5; journey step 8), in The Sorting Room's
 * card deck: one document at a time, in two queues, over the same folder review as before (core/ui/review-cards.ts
 * says what each answer is and writes; nothing here changes what the saved review contains).
 *
 * - First the sorted folder is chosen and read (the walk controller, as before).
 * - The deck: the two queue tabs (.rtabs), the keys, then the document as a sheet of paper on a small pile (the pile is
 *   the open cards still to come), with the reader's own quotes highlighted and the two systems' answers beneath, and
 *   beside it the question with its choices (.choices, each with its key), the progress dots and Back / Skip / Undo.
 * - **Needs you**: every document that came to the person, in the results' order; a folder choice names the move to
 *   make in File Explorer (the app never moves a copy); Look again reads the folder back and the move becomes the
 *   correction it is. Skipping leaves it in Needs review.
 * - **Spot-check, optional**: the filed documents, folder by folder. "Right" is remembered on this computer and becomes
 *   the folder's tick once every filed document still in that folder is right; "Wrong" asks where it belongs instead.
 * - "Either folder is right" (a copy moved between two categories) and "Leave it out" are the answer marks the saved
 *   answers are compared with (walk controller `mark`), as before.
 * - Keys: 1–9 a folder, R right, W wrong, E either, L leave out, U undo the last answer, ← back, → next. An answer
 *   flies the card off the pile and a toast offers Undo.
 * - The category definitions stay on screen (beside the deck on wide screens, below it otherwise, with a link).
 */
import './review.css';
import { computed, effect, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText, type Phrase } from '../../../core/ui/journey.ts';
import { NONE_OF_THESE, categoryName, categoryNames, docFromEntry, presentRow, FAILED_FOLDER, REVIEW_FOLDER, type CategoryNames } from '../../../core/ui/result-presenter.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { percent } from '../../../core/ui/format.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import type { ChecklistFolder } from '../../../core/ui/folder-checklist.ts';
import type { AnswerMark } from '../../../core/ui/answers-draft.ts';
import { reviewSources } from '../../../core/ui/walk-review.ts';
import {
  answeredFolders, cardSaveBlockers, filedCheckCount, firstOpen, nextOpen, queueCounts, reviewCards, tickChanges, tickWrites,
  type CardAnswer, type CardQueue, type ReviewCard, type TrialCheck, type TrialChecksState
} from '../../../core/ui/review-cards.ts';
import type { DecisionFacts } from '../../../core/ui/rule-sentence.ts';
import { each, h, match, show } from '../view/dom.ts';
import { action } from '../view/action.ts';
import { glyph } from '../view/glyphs.ts';
import { actionSlot } from '../components/action-slot.ts';
import { definitionCard } from '../components/definition-card.ts';
import { evidencePanel, type EvidenceAnswers, type EvidenceLoad } from '../components/evidence-panel.ts';
import { folderPick } from '../components/folder-pick.ts';
import { notice } from '../components/notice.ts';
import { toast } from '../components/toast.ts';
import { words } from '../components/words.ts';
import { journeyPrimary, type PrimaryHandlers } from '../shell/primary.ts';
import { runDisplayName } from '../shell/run-names.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import { doneBanner, whenComplete } from './review-parts.ts';
import { fileExtension } from './results.ts';

type Ctx = ViewContext<RouteOf<'review'>>;
type Decision = 'new_type' | 'ignore';
/** Where an answered card flies: a folder to the right, "right where it is" up, "leave it out" to the left. */
type Fly = 'right' | 'up' | 'left';
/** One undoable answer of this visit: a card answer, or an answer mark with what it replaced. */
type Undo = { kind: 'card'; tag: string; queue: CardQueue; index: number } | { kind: 'mark'; fingerprint: string; before: AnswerMark | null; queue: CardQueue; index: number };

const DEFINITIONS_ID = 'review-definitions';
/** The card deck (the queue tabs, the card and its choices) is one keyboard region. */
const DECK_ID = 'review-deck';
const MAX_QUOTES = 3;
const FLY_MS = 380;

export function reviewScreen(ctx: Ctx): Node {
  const copy = ctx.copy, c = copy.review, k = c.cards;
  const runId = ctx.route.peek().runId;
  const run = ctx.store.runStore(runId);
  const walk = ctx.controllers.walk(runId);
  whenComplete(run, () => { void walk.prepare(); });
  void walk.loadRemembered();
  if (run.plan.peek().state === 'idle') void run.loadPlan();

  const plan = computed(() => { const p = run.plan(); return p.state === 'ready' ? p.value : null; });
  const names = computed<CategoryNames | null>(() => { const p = plan(); return p === null ? null : categoryNames(p.typeFile, p.displayNames); });
  const typeIds = computed(() => plan()?.typeFile.types.map(type => type.id) ?? []);
  const sources = computed(() => reviewSources(runId, run.results(), run.plan()).sources);
  const results = computed(() => { const r = run.results(); return r.state === 'ready' ? r.value : null; });
  const notesOf = computed(() => new Map((results()?.notes ?? []).map(note => [note.fingerprint, note])));

  // --- The trial's checks, for the full run of a campaign ------------------------------------------------------------
  const pilotRunId = computed<string | null>(() => {
    const view = run.view(), list = ctx.store.runList();
    const campaign = view?.campaign ?? null;
    if (campaign === null || campaign.role !== 'full' || list.state !== 'ready') return null;
    return list.value.find(item => item.campaign?.id === campaign.id && item.campaign.role === 'pilot')?.id ?? null;
  });
  const trialView = computed(() => { const id = pilotRunId(); return id === null ? null : ctx.controllers.trial(id).view(); });
  effect(() => {
    const id = pilotRunId();
    // A failed read is shown by `trialChecks` (the notice beside "Read the trial checks again"), not thrown here.
    if (id !== null) untrack(() => { void ctx.controllers.trial(id).load().catch(() => undefined); });
  });
  const trial = computed<ReadonlyMap<string, TrialCheck>>(() =>
    new Map((plan()?.trialChecksCarry === false ? [] : trialView()?.filed ?? []).map(entry => [entry.fingerprint, { destinationFolder: entry.destinationFolder, verdict: entry.verdict }])));
  /**
   * Where the trial's checks stand: `none` for a run that carries none, `loading` until they are read, `ready`, or
   * `failed`. Until they are `ready` (or `none`), the cards show the carried documents as unanswered and no folder tick
   * is changed.
   */
  const trialChecks = computed<TrialChecksState>(() => {
    const view = run.view();
    if (view === null) return 'loading';
    const campaign = view.campaign ?? null;
    if (campaign === null || campaign.role !== 'full' || plan()?.trialChecksCarry === false) return 'none';
    const list = ctx.store.runList();
    if (list.state === 'error') return 'failed';
    if (list.state !== 'ready') return 'loading';
    const id = pilotRunId();
    if (id === null) return 'none';
    const checks = ctx.controllers.trial(id);
    return checks.error() !== null ? 'failed' : checks.view() === null ? 'loading' : 'ready';
  });

  // --- The card answers (the walk controller keeps them in this browser's local storage until the review is saved) ---
  const answers = computed(() => walk.cards().answers);
  const recheck = computed<ReadonlySet<string>>(() => new Set(walk.cards().recheck));

  const usable = computed(() => (walk.recordProblem() === null ? walk.record() : null));
  const queues = computed(() => {
    const from = sources();
    return from === null ? null : reviewCards({ sources: from, walk: usable(), answers: answers(), trial: trial(), recheck: recheck() });
  });
  const carriedChecks = computed(() => {
    const q = queues();
    return q === null ? [] : [...q.spot, ...q.carried].filter(card => card.trialConfirmed && card.now === card.destination);
  });
  const saved = computed(() => { const record = usable(); return record !== null && record.correctionId !== null; });
  const read = computed(() => walk.checklist() !== null);
  const minimum = computed(() => plan()?.minimumFiledCount ?? null);
  const checked = computed(() => { const q = queues(); return q === null ? 0 : filedCheckCount(q, walk.checklist(), typeIds()); });
  /** "3 of 50 checked" against the run's minimum sample ("3 checked" on a plan that does not say it). */
  const spotProgress = computed(() => { const m = minimum(); return m === null ? k.spotProgressNoMinimum(checked()) : k.spotProgress(checked(), m); });
  /** An empty Needs-you queue: nothing came to the person, or the copies of what did are not in the sorted folder. */
  const needsEmpty = computed(() => { const missing = queues()?.needsMissing ?? 0; return missing > 0 ? k.missing(missing) : k.needsNone; });

  // The folder ticks follow the answers (a folder counts once every filed document still in it is right), once both the
  // card answers and the trial's checks are known; a folder in which the person gave no card answer keeps its tick.
  // `tickWork` is what is still to write (null until it can be worked out); Save waits for it (DECISIONS 140 (b)).
  const tickWork = computed(() => {
    const q = queues(), list = walk.checklist(), checks = trialChecks();
    if (q === null || list === null || saved() || walk.editBlocked() !== null) return null;
    if (!walk.cardsLoaded() || (checks !== 'ready' && checks !== 'none')) return null;
    const current = new Map(list.groups.flatMap(group => group.folders).map(folder => [folder.folder, folder.tick]));
    return tickChanges(q, typeIds(), current, answeredFolders(q, answers(), walk.withdrawn()));
  });
  // Each change of what is to write is one batch of writes. A write this computer refused (its storage failed) is kept
  // as the batch's outcome until the next batch: Save then says so, with Look again (review F7). Nothing is retried.
  const writes = tickWrites();
  effect(() => {
    const changes = tickWork();
    untrack(() => {
      const report = writes.begin();
      if (changes !== null) for (const change of changes) void walk.tick(change.folder, change.on).then(report);
    });
  });
  /** Save's reasons: the walk's own, then the cards' (the trial's checks unread, ticks not written, or still to write). */
  const saveBlockers = computed(() => [...walk.saveBlockers(),
    ...cardSaveBlockers({ read: read(), saved: saved(), trialChecks: trialChecks(), pendingTicks: tickWork()?.length ?? 0, ticksFailed: writes.failed() })]);

  // --- The deck: which queue, which card ------------------------------------------------------------------------------
  const queue = signal<CardQueue>('needs');
  const position = signal(0);
  const cards = computed(() => { const q = queues(); return q === null ? [] : queue() === 'needs' ? q.needs : q.spot; });
  const current = computed<ReviewCard | null>(() => cards()[position()] ?? null);
  // The first time the queues are known: start where the person is (the first open card; the spot-check if nothing needs them).
  let started = false;
  effect(() => {
    const q = queues();
    if (q === null || started || !read()) return;
    started = true;
    untrack(() => {
      if (q.needs.length === 0 || firstOpen(q.needs) === null) { if (q.spot.length > 0) queue.set('spot'); }
      position.set(firstOpen(cards.peek()) ?? Math.max(0, cards.peek().length - 1));
    });
  });
  const showQueue = (which: CardQueue) => {
    queue.set(which);
    const list = cards.peek();
    position.set(firstOpen(list) ?? Math.max(0, list.length - 1));
    focusDeck();
  };
  const goTo = (index: number) => { position.set(Math.max(0, Math.min(index, cards.peek().length - 1))); };
  const advance = () => {
    const list = cards.peek(), next = nextOpen(list, position.peek());
    // Every card answered: the summary takes the card's place (position past the end).
    position.set(next ?? list.length);
  };
  /** The next card whatever its state (→ and "Skip for now"); past the last one, the queue's summary. */
  const forward = () => { position.set(Math.min(position.peek() + 1, cards.peek().length)); };
  const atSummary = computed(() => cards().length > 0 && position() >= cards().length);
  const choosing = signal(false);
  effect(() => { current(); untrack(() => choosing.set(false)); });
  /** The open cards still to come in this queue: the pile beneath the card. */
  const pile = computed(() => cards().filter(card => card.state === 'open').length);

  // --- Answers, with the fly-out, the toast and Undo ---------------------------------------------------------------
  const undos = signal<readonly Undo[]>([]);
  /** Set while the next card arrives after an answer, so it lands on the pile (the artifact's `.in`). */
  let arriving = false;
  const n = () => names.peek()!;
  const placeLabel = (folder: string) => (folder === REVIEW_FOLDER ? copy.reasons.placeReview : categoryName(folder, n()));
  const marks = computed(() => walk.marks());

  /** The card leaves the pile: a copy of it (inert, hidden from assistive technology) flies off while the next one lands. */
  function flyOut(direction: Fly): void {
    if (deck === null) return;
    const card = deck.querySelector<HTMLElement>('[data-testid="review-card"]');
    if (card === null) return;
    const box = card.getBoundingClientRect(), host = deck.getBoundingClientRect();
    const ghost = card.cloneNode(true) as HTMLElement;
    for (const el of [ghost, ...ghost.querySelectorAll('[id],[data-testid]')]) { el.removeAttribute('id'); el.removeAttribute('data-testid'); }
    const wrap = h('div', {
      class: 'card-ghost', attrs: { 'aria-hidden': 'true', inert: true },
      vars: { '--gx': `${box.left - host.left}px`, '--gy': `${box.top - host.top}px`, '--gw': `${box.width}px` }
    }, ghost);
    deck.append(wrap);
    const to = direction === 'right' ? 'translate(60%, -14px) rotate(9deg)' : direction === 'left' ? 'translate(-60%, -14px) rotate(-9deg)' : 'translateY(-40%) scale(.92)';
    const flight = ghost.animate([{ transform: 'none', opacity: 1 }, { transform: to, opacity: 0 }],
      { duration: FLY_MS, easing: 'cubic-bezier(.6,0,.4,1)', fill: 'forwards' });
    void flight.finished.then(() => wrap.remove(), () => wrap.remove());
  }

  function answer(card: ReviewCard, value: CardAnswer, label: string, direction: Fly): void {
    flyOut(direction);
    undos.update(list => [...list, { kind: 'card', tag: card.tag, queue: card.queue, index: position.peek() }]);
    walk.answer(card.tag, value);
    arriving = true;
    advance();
    focusDeck();
    toast(k.toast.answered(label), { label: k.undoShort, run: undoLast });
  }

  function setMark(card: ReviewCard, value: AnswerMark | null, label: string, direction: Fly | null): void {
    const before = marks.peek()[card.fingerprint] ?? null;
    if (direction !== null) flyOut(direction);
    undos.update(list => [...list, { kind: 'mark', fingerprint: card.fingerprint, before, queue: card.queue, index: position.peek() }]);
    void walk.mark([card.fingerprint], value);
    if (direction !== null) { arriving = true; forward(); }
    focusDeck();
    toast(label, { label: k.undoShort, run: undoLast });
  }

  function undoLast(): void {
    const list = undos.peek(), last = list.at(-1);
    if (last === undefined) return;
    undos.set(list.slice(0, -1));
    if (last.kind === 'card') walk.answer(last.tag, null);
    else void walk.mark([last.fingerprint], last.before);
    queue.set(last.queue);
    arriving = true;
    goTo(last.index);
    focusDeck();
    toast(k.toast.undone);
  }

  const handlers: PrimaryHandlers = {
    [`review:read-changes:${runId}`]: async fb => { await ctx.controllers.walk(runId).read(fb); },
    [`review:save:${runId}`]: async fb => { await ctx.controllers.walk(runId).save(fb); }
  };
  const primary = journeyPrimary(ctx.journey, handlers, id =>
    id === `review:read-changes:${runId}` ? { blockedBy: walk.readBlockers, errorContext: 'walk' }
      : id === `review:save:${runId}` ? { blockedBy: saveBlockers, errorContext: 'review-save', note: k.saveHint } : { errorContext: 'walk' });

  // The same words as the rail and the run strip: "Step 8 of 8 · Review folders".
  const stepLabel = copy.journey.stepOf(STEPS.indexOf('review') + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS.review }, copy));
  const runName = computed(() => runDisplayName(ctx.store, runId));
  const definitionsTitle = computed(() => { const name = runName(); return name === null ? c.definitionsTitleNoRun : c.definitionsTitle(name); });
  const lookAgainBlocked = computed<readonly Phrase[] | null>(() => {
    const busy = walk.folderBusy();
    if (busy !== null) return [busy];
    if (walk.folder().kind === 'chosen' || walk.remembered()?.source === 'reviewed') return null;
    return [{ key: 'review.blockers.chooseFolder' }];
  });
  const lookAgain = (id: string) => action({
    id, label: c.lookAgain, kind: 'quiet', blockedBy: lookAgainBlocked, errorContext: 'walk',
    run: async fb => { await ctx.controllers.walk(runId).lookAgain(fb); }
  });
  // The owner's moves out of each category, for the definition card's "Your moves" line.
  const rowsByFolder = computed(() => new Map((walk.checklist()?.groups ?? []).flatMap(group => group.folders).map(folder => [folder.folder, folder])));
  const confusionOf = (id: string) => computed<string | null>(() => {
    const row = rowsByFolder().get(id);
    if (row === undefined || row.movedOutTo.length === 0) return null;
    return c.yourMoves(row.movedOutTo.map(line => c.confusion(line.count, line.name)).join(', '));
  });
  const newFolders = computed(() => walk.checklist()?.groups.find(group => group.id === 'newFolders')?.folders ?? []);
  const newFolderKeys = computed(() => newFolders().map(folder => folder.folder));
  const newFolderOf = (key: string) => {
    let last: ChecklistFolder | undefined;
    return computed(() => (last = newFolders().find(folder => folder.folder === key) ?? last) as ChecklistFolder);
  };

  /** The folders a card can be moved to: every category but the one it is in; a filed document may also go to Needs review. */
  const folderOptions = (card: ReviewCard): string[] => {
    const ids = typeIds().filter(id => id !== card.now);
    return card.queue === 'spot' && card.now !== REVIEW_FOLDER ? [...ids, REVIEW_FOLDER] : ids;
  };
  /** "Either folder is right" applies to a copy the person moved between two categories. */
  const eitherApplies = (card: ReviewCard) => card.state === 'moved' && card.now !== null && typeIds().includes(card.destination) && typeIds().includes(card.now);
  const toggleEither = (card: ReviewCard) => {
    const on = marks.peek()[card.fingerprint]?.status === 'ambiguous';
    setMark(card, on ? null : { status: 'ambiguous', labels: [card.destination, card.now!] }, on ? k.toast.eitherOff : c.fitsBoth, null);
  };
  const toggleLeaveOut = (card: ReviewCard) => {
    const on = marks.peek()[card.fingerprint]?.status === 'excluded';
    setMark(card, on ? null : { status: 'excluded' }, on ? k.toast.backIn : k.toast.leftOut, on ? null : 'left');
  };

  // --- Keys: 1–9, R, W, E, L, U, ←, → inside the deck (never inside a text field) -----------------------------------
  let deck: HTMLElement | null = null;
  const focusDeck = () => { queueMicrotask(() => deck?.focus({ preventScroll: true })); };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text' || target.tagName === 'TEXTAREA')) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const card = current.peek();
    const key = event.key, lower = key.toLowerCase();
    const done = () => { event.preventDefault(); };
    if (lower === 'u' && undos.peek().length > 0) { undoLast(); done(); return; }
    // From the queue's summary, left goes back to the last card.
    if (atSummary.peek() && (key === 'ArrowLeft' || key === 'Backspace')) { goTo(cards.peek().length - 1); done(); focusDeck(); return; }
    if (atSummary.peek() || card === null) return;
    if (key === 'ArrowLeft' || key === 'Backspace') { goTo(position.peek() - 1); done(); focusDeck(); return; }
    if (key === 'ArrowRight') { forward(); done(); focusDeck(); return; }
    if (key === 'Escape' && choosing.peek()) { choosing.set(false); done(); return; }
    if (lower === 'e' && eitherApplies(card)) { toggleEither(card); done(); return; }
    if (lower === 'l' && card.state !== 'carried') { toggleLeaveOut(card); done(); return; }
    if (card.state !== 'open' && card.state !== 'pending-move') return;
    const open = card.state === 'open';
    if (card.queue === 'spot' && open && lower === 'r') { answer(card, { kind: 'right' }, k.toast.right, 'up'); done(); return; }
    if (card.queue === 'spot' && open && lower === 'w') { choosing.set(true); done(); focusDeck(); return; }
    // After an answer the card is drawn afresh, so the deck itself takes the focus back and the next key still lands here.
    if (/^[1-9]$/.test(key) && (card.queue === 'needs' || choosing.peek())) {
      const chosen = folderOptions(card)[Number(key) - 1];
      if (chosen !== undefined) { answer(card, { kind: 'move', to: chosen }, placeLabel(chosen), 'right'); done(); }
    }
  };

  const keyHint = (queueNow: CardQueue) => {
    const kb = (label: string) => h('kbd', null, label);
    const max = Math.min(9, typeIds().length + (queueNow === 'spot' ? 1 : 0));
    const parts: (Node | string)[] = [h('span', null, k.keys.label, ' '), kb('1'), '–', kb(String(Math.max(1, max))), ` ${k.keys.folder}`];
    if (queueNow === 'spot') parts.push(' · ', kb('R'), ` ${k.keys.right}`, ' · ', kb('W'), ` ${k.keys.wrong}`);
    parts.push(' · ', kb('E'), ` ${k.keys.either}`, ' · ', kb('L'), ` ${k.keys.leave}`, ' · ', kb('U'), ` ${k.keys.undo}`, ' · ', kb('←'), kb('→'), ` ${k.keys.move}`);
    return h('span', { class: 'hint keys review-keys', testid: 'review-keys' }, ...parts);
  };

  return h('section', { class: 'review-step', testid: 'review', attrs: { 'data-phase': computed(() => (saved() ? 'saved' : read() ? 'cards' : 'folder')) } },
    h('div', { class: 'step-eyebrow', attrs: { 'data-build': '' } }, stepLabel),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.title)),
    h('p', { class: 'lede', attrs: { 'data-build': '' } }, c.lead),
    h('div', { class: 'review__layout' },
      h('div', { class: 'stack-v review__main' },
        // Below the wide layout the definitions follow the deck: this link reaches them without changing the address (a
        // hash is a route here). Hidden where they sit beside the deck.
        h('a', {
          class: 'link review__jump', testid: 'review-jump',
          attrs: { href: formatRoute(ctx.route.peek()), 'aria-controls': DEFINITIONS_ID },
          on: { click: event => { event.preventDefault(); document.getElementById(DEFINITIONS_ID)?.scrollIntoView({ block: 'start' }); } }
        }, c.jumpToDefinitions, ' ', glyph('arrow-right', { size: 14 })),
        // The sorted folder: chosen and read first; afterwards a quiet line with Look again.
        h('section', { class: 'panel review__folder', classes: { 'is-read': read }, attrs: { 'aria-labelledby': 'review-folder-h', 'data-build': '' } },
          h('div', { class: 'review__folder-head' },
            h('h3', { attrs: { id: 'review-folder-h' } }, k.folderTitle),
            show(read, () => lookAgain(`review:look-again:${runId}`))),
          show(computed(() => !read()), () => h('p', { class: 'hint' }, k.folderLead)),
          h('div', { class: 'review__pick' },
            folderPick({
              id: `review:folder:${runId}`, purpose: 'reviewed', explanation: c.folderExplain, testid: 'review-folder',
              state: walk.folder, remembered: computed(() => walk.remembered()), busy: walk.folderBusy, errorContext: 'walk',
              useLabel: c.useAgain, chooseLabel: c.chooseFolder,
              onUseRemembered: async fb => { const key = walk.remembered.peek()?.key; if (key) await walk.useReviewed(key, fb); },
              onChoose: async fb => { await walk.chooseReviewed(fb); }
            }))),
        // The card answers kept on this computer could not be read: said once, plainly. The cards start afresh, as
        // before, and the next answer replaces the stored value (the walk controller); the problem goes to Details.
        show(computed(() => walk.cardsProblem() !== null), () => notice({ kind: 'problem', failure: true, testid: 'review-cards-unread',
          headline: k.answersUnread, technical: computed(() => ({ problem: walk.cardsProblem() })) })),
        // The trial's checks could not be read: said plainly, beside the way to read them again.
        show(computed(() => read() && trialChecks() === 'failed'), () => h('div', { class: 'stack-v', testid: 'review-trial-unread' },
          notice({ kind: 'problem', failure: true, headline: k.trialUnread,
            technical: computed(() => { const id = pilotRunId(); return { trialRunId: id, problem: id === null ? null : ctx.controllers.trial(id).error() }; }) }),
          h('div', { class: 'quiet-actions' }, action({
            id: `review:trial-read:${runId}`, label: k.trialReadAgain, kind: 'secondary', errorContext: 'read',
            run: async () => {
              if (ctx.store.runList.peek().state === 'error') await ctx.store.loadRunList();
              const id = pilotRunId.peek();
              if (id !== null) await ctx.controllers.trial(id).load();
            }
          })))),
        // The deck: the two queues, one card at a time.
        show(computed(() => read() && queues() !== null), () => {
          const q = queues;
          const deckEl = h('section', {
            class: 'review__deck', attrs: { id: DECK_ID, tabindex: -1, 'aria-label': c.title, 'data-queue': queue }, testid: 'review-cards',
            on: { keydown: onKey }
          },
          h('div', { class: 'review__bar' },
            h('div', { class: 'rtabs', attrs: { role: 'tablist', 'aria-label': c.title } },
              (['needs', 'spot'] as const).map(which => {
                const list = computed(() => (q()!)[which]);
                const counts = computed(() => queueCounts(list()));
                // ui-rules: non-operational button: switches the queue shown (local view state only)
                return h('button', {
                  class: 'rtab', attrs: { type: 'button', role: 'tab', 'aria-selected': computed(() => (queue() === which ? 'true' : 'false')), 'data-queue': which },
                  testid: `review-queue-${which}`, on: { click: () => { arriving = true; showQueue(which); } }
                },
                h('span', null, k.queues[which]),
                which === 'spot' ? h('span', { class: 'rtab__opt' }, k.optional) : null,
                h('b', null, computed(() => copy.common.ofTotal(counts().answered, counts().total))),
                show(computed(() => which === 'needs' && counts().total > 0 && counts().answered === counts().total),
                  () => h('span', { class: 'rtab__done', attrs: { 'aria-hidden': 'true' } }, glyph('check', { size: 14 }))));
              })),
            match(queue, { needs: () => keyHint('needs'), spot: () => keyHint('spot') })),
          // The queue's intro: why it is here and, for the spot-check, the progress toward the run's minimum sample.
          match(queue, {
            needs: () => h('p', { class: 'hint review__intro', testid: 'review-needs-intro' },
              computed(() => { const count = q()!.needs.length; return count === 0 ? needsEmpty() : k.needsIntro(count); })),
            spot: () => h('div', { class: 'review__intro', testid: 'review-spot-intro' },
              h('p', { class: 'hint' }, computed(() => { const p = plan(); return k.spotIntro(p === null ? '' : percent(p.threshold)); })),
              h('p', { class: 'spot-progress' },
                h('b', { testid: 'review-spot-progress' }, spotProgress),
                h('span', { class: 'hint' }, k.spotHow)))
          }),
          // The card, or the queue's summary once every card is answered.
          match(computed(() => (cards().length === 0 ? 'empty' : atSummary() ? 'summary' : 'card')), {
            empty: () => h('p', { class: 'hint', testid: 'review-queue-empty' }, computed(() => (queue() === 'needs' ? needsEmpty() : ''))),
            summary: () => queueSummary(),
            card: () => cardView()
          }));
          deck = deckEl;
          return deckEl;
        }),
        // Moves chosen on cards and still to make in File Explorer.
        show(computed(() => (queues()?.pendingMoves.length ?? 0) > 0 && !saved()), () => h('section', { class: 'panel review__pending', attrs: { 'aria-labelledby': 'review-pending-h' }, testid: 'review-pending' },
          h('div', { class: 'review__panel-head' },
            h('h3', { attrs: { id: 'review-pending-h' } }, k.pendingTitle),
            lookAgain(`review:look-again-pending:${runId}`)),
          h('p', { class: 'hint' }, k.pendingLead),
          h('ul', { class: 'pending-list' }, each(computed(() => queues()!.pendingMoves.map(card => card.tag)),
            tag => { let last: ReviewCard | undefined; return computed(() => (last = queues()!.pendingMoves.find(card => card.tag === tag) ?? last) as ReviewCard); },
            card => h('li', { class: 'copyrow' }, h('span', null, computed(() => k.pendingLine(card().filename, card().pendingToName ?? '')))))))),
        // Checked in the trial: collapsed, with the choice to check them again.
        show(computed(() => carriedChecks().length > 0), () => {
          const carriedList = carriedChecks;
          const open = signal(false);
          return h('section', { class: 'panel review__carried', attrs: { 'aria-labelledby': 'review-carried-h' }, testid: 'review-carried' },
            h('div', { class: 'review__panel-head' },
              h('h3', { attrs: { id: 'review-carried-h' } }, computed(() => k.carriedTitle(carriedList().length))),
              action({
                id: `review:recheck:${runId}`, label: computed(() => (recheck().size > 0 ? k.carriedKeep : k.carriedAgain)), kind: 'quiet',
                run: async () => {
                  const all = recheck.peek().size > 0 ? [] : carriedList.peek().map(card => card.fingerprint);
                  walk.recheck(all);
                  if (all.length > 0) showQueue('spot');
                }
              })),
            h('p', { class: 'hint' }, k.carriedLead),
            // ui-rules: non-operational button: shows or hides the list of carried documents (local view state only)
            h('button', { class: 'link review__carried-toggle', attrs: { type: 'button', 'aria-expanded': computed(() => (open() ? 'true' : 'false')) }, on: { click: () => open.set(!open.peek()) } },
              computed(() => (open() ? copy.common.close : copy.common.open))),
            show(open, () => h('ul', { class: 'carried-list' }, each(computed(() => carriedList().map(card => card.tag)),
              tag => { let last: ReviewCard | undefined; return computed(() => (last = carriedList().find(card => card.tag === tag) ?? last) as ReviewCard); },
              card => h('li', { class: 'copyrow' }, h('span', { class: 'carried__file' }, computed(() => card().filename)), h('span', { class: 'hint' }, computed(() => card().destinationName)))))));
        }),
        // New folders the person made: answered as before (a new category, or ignore these files).
        show(computed(() => newFolders().length > 0), () => h('section', { class: 'panel review__new', attrs: { 'aria-labelledby': 'review-new-h' }, testid: 'review-new-folders' },
          h('h3', { attrs: { id: 'review-new-h' } }, k.newFoldersTitle),
          h('div', { class: 'checklist', testid: 'review-checklist' },
            each(newFolderKeys, newFolderOf, folder => newFolderRow(ctx, folder))))),
        // The save bar: the summary and the one action (Read my changes, then Save my review).
        h('section', {
          class: 'panel savebar review__save', attrs: { 'aria-label': k.summaryTitle, 'data-build': '' },
          classes: { hot: computed(() => { const q = queues(); return read() && !saved() && q !== null && q.needs.length > 0 && queueCounts(q.needs).answered === q.needs.length; }) }
        },
        show(read, () => h('div', { class: 'review__totals', testid: 'review-summary' },
          h('p', null, computed(() => { const q = queues(); return q === null ? '' : k.needsSummary(queueCounts(q.needs).answered, q.needs.length); })),
          h('p', null, computed(() => k.spotSummary(checked()))),
          show(computed(() => (queues()?.missing ?? 0) > 0), () => h('p', { class: 'hint' }, computed(() => k.missing(queues()!.missing)))))),
        actionSlot(primary, { testid: 'review-primary' }))),
      h('aside', { class: 'panel review__defs', attrs: { id: DEFINITIONS_ID, 'aria-label': definitionsTitle, tabindex: -1, 'data-build': '' }, testid: 'review-definitions' },
        h('div', { class: 'defs-head' },
          h('p', { class: 'eyebrow' }, c.frozen),
          h('h3', null, definitionsTitle)),
        show(computed(() => plan() !== null), () => h('div', { class: 'defs-list' },
          plan.peek()!.typeFile.types.map(type => definitionCard({
            type, displayName: categoryName(type.id, names.peek()!), heading: 'h3', examplesOpen: true,
            confusion: confusionOf(type.id), testid: `review-definition-${type.id}`
          })))),
        // The two folders every run has, with their names on disk, so they can be found in File Explorer.
        h('div', { class: 'reserved' },
          h('p', null, h('b', null, copy.reasons.placeReview), ' ', h('span', { class: 'mono' }, copy.common.definition.folder(REVIEW_FOLDER)), ': ', c.reserved.review),
          h('p', null, h('b', null, copy.reasons.placeFailed), ' ', h('span', { class: 'mono' }, copy.common.definition.folder(FAILED_FOLDER)), ': ', c.reserved.failed)))));

  // --- One card -------------------------------------------------------------------------------------------------------
  function cardView(): HTMLElement {
    // Redrawn only when what the card shows changes (the key), not on every recomputation of the queues.
    const key = computed(() => { const card = current()!; return `${card.tag}|${card.state}|${card.now ?? ''}|${card.pendingTo ?? ''}|${card.trialConfirmed}|${card.trialFolder ?? ''}`; });
    return h('div', { class: 'card-host' }, match(key, {}, () => oneCard(current.peek()!)));
  }

  function oneCard(card: ReviewCard): HTMLElement {
    const names0 = n(), p = plan.peek()!;
    const entry = results.peek()?.entries.find(item => item.fingerprint === card.fingerprint) ?? null;
    const note = notesOf.peek().get(card.fingerprint) ?? null;
    const doc = entry === null ? null : docFromEntry({ ...entry, failure: note?.failure ?? null, notes: note?.notes ?? [] });
    const row = doc === null ? null : presentRow(doc, names0);
    const decision: DecisionFacts | null = doc === null || doc.ruleId === null ? null
      : { ruleId: doc.ruleId, typeId: doc.typeId, destinationFolder: doc.destinationFolder, notes: doc.notes };
    const index = position.peek(), total = cards.peek().length;
    const inFolder = card.queue === 'spot' ? cards.peek().filter(item => item.destination === card.destination) : [];
    const options = folderOptions(card);
    const extension = fileExtension(card.filename);
    const load = evidenceLoad(card.fingerprint);
    const evidence = computed<EvidenceAnswers | null>(() => { const l = load(); return l.state === 'ready' ? l.answers : null; });
    const nameOf = (id: string) => (id === NONE_OF_THESE ? p.typeFile.none_of_these.name : categoryName(id, names0));
    const confidenceChoice = computed(() => evidence()?.confidence?.choice ?? null);
    const readerYes = computed(() => (evidence()?.reader?.verdicts ?? []).filter(verdict => verdict.is_type).map(verdict => verdict.type_id));
    const quotes = computed(() => (evidence()?.reader?.verdicts ?? []).filter(verdict => verdict.is_type).flatMap(verdict => verdict.evidence).slice(0, MAX_QUOTES));
    const differs = computed(() => { const choice = confidenceChoice(), yes = readerYes(); return choice !== null && evidence()?.reader != null && !(yes.length === 1 && yes[0] === choice); });
    const entering = arriving;
    arriving = false;

    const paper = h('article', {
      class: 'card sheet-doc', classes: { in: entering },
      attrs: { 'data-fingerprint': card.fingerprint, 'data-queue': card.queue, 'data-state': card.state, 'aria-labelledby': 'review-card-name' },
      testid: 'review-card'
    },
    h('span', { class: `stamp ${card.queue === 'needs' ? 'p' : 'f'}` }, card.queue === 'needs' ? k.stamp.needs : k.stamp.filed),
    h('h4', { attrs: { id: 'review-card-name' } }, card.filename, extension === null ? null : h('span', { class: 'sr' }, ` (${extension})`)),
    h('div', { class: 'fn card__facts' },
      h('span', null, card.rule === 'R1' ? k.filedIn(card.destinationName) : k.cameToYou),
      card.now !== card.destination ? h('span', { class: 'card__now' }, ` · ${k.nowIn(card.nowName ?? '')}`) : null),
    row?.reason ? h('p', { class: 'm card__reason' }, row.reason) : null,
    // The reader's own quotes, highlighted as the lines of the page it relied on (exactly as recorded).
    match(computed(() => load().state), {
      loading: () => h('p', { class: 'm' }, copy.evidence.loading),
      ready: () => h('div', { class: 'card__quotes' },
        quotes.peek().map(quote => h('p', null, h('span', { class: card.queue === 'needs' ? 'mark p' : 'mark' }, quote))))
    }),
    show(computed(() => evidence() !== null), () => h('div', { class: 'card__systems' },
      show(computed(() => confidenceChoice() !== null), () => h('div', { class: 'vrow' },
        h('span', null, k.systems.confidence),
        h('b', null, computed(() => `${nameOf(confidenceChoice()!)} · ${percent(evidence()!.confidence!.confidence)}`)))),
      show(computed(() => evidence()?.reader != null), () => h('div', { class: 'vrow' },
        h('span', null, k.systems.reader),
        h('b', null, computed(() => (readerYes().length === 0 ? k.systems.readerNone : readerYes().map(nameOf).join(', '))),
          show(differs, () => h('span', { class: 'vrow__differs' }, ` · ${k.systems.differs}`))))))),
    card.trialFolderName !== null
      ? h('p', { class: 'm card__trial', testid: 'review-card-trial' }, k.trialNote(card.trialFolderName))
      : card.trialConfirmed && card.now === card.destination
        ? h('p', { class: 'm card__trial', testid: 'review-card-trial' }, k.trialStillCounts) : null);

    const leftOut = computed(() => marks()[card.fingerprint]?.status === 'excluded');
    const side = h('div', { class: 'deck-side' },
      h('div', { class: 'deck-side__head' },
        h('h3', null, card.queue === 'needs' ? k.whereBelongs : computed(() => (choosing() ? k.wrongWhere : k.isItRight))),
        h('span', { class: 'mono deck-side__pos', testid: 'review-card-position' },
          card.queue === 'needs' ? `${k.queues.needs} · ${k.position(index + 1, total)}`
            : `${k.queues.spot} · ${k.position(index + 1, total)} · ${k.inFolder(card.destinationName, inFolder.indexOf(card) + 1, inFolder.length)}`)),
      h('div', { class: 'card__answer', testid: 'review-card-answer' }, answerPart(card, options, confidenceChoice, readerYes)),
      card.state === 'carried' ? null : h('div', { class: 'choices choices--aside' },
        // ui-rules: non-operational button: marks the document "leave out" in this browser's answers (sent only with the saved answers)
        h('button', {
          class: 'choice', classes: { picked: leftOut }, attrs: { type: 'button', 'aria-pressed': computed(() => (leftOut() ? 'true' : 'false')) },
          testid: 'review-card-leave', on: { click: () => toggleLeaveOut(card) }
        },
        h('kbd', null, 'L'),
        h('span', null, h('b', null, computed(() => (leftOut() ? k.leaveOut.on : k.leaveOut.title))), h('span', null, k.leaveOut.sub)))),
      h('div', { class: 'card__nav' },
        index === 0 ? null : action({ id: `review:card-back:${runId}`, label: k.back, kind: 'quiet', run: async () => { goTo(index - 1); focusDeck(); } }),
        action({ id: `review:card-skip:${runId}`, label: k.skip, kind: 'quiet', run: async () => { forward(); focusDeck(); } }),
        show(computed(() => undos().length > 0), () =>
          // ui-rules: non-operational button: undoes this visit's last answer, kept on this computer until the review is saved
          h('button', { class: 'link', attrs: { type: 'button' }, testid: 'review-undo', on: { click: () => undoLast() } }, k.undo))),
      h('div', { class: 'dots', attrs: { 'aria-hidden': 'true' } },
        cards.peek().map((item, i) => h('i', { classes: { d: item.state !== 'open', c: i === index } }))));

    const under = pile.peek() - (card.state === 'open' ? 1 : 0);
    return h('div', { class: 'card-deck' },
      h('div', { class: 'deck' },
        h('div', { class: 'deck-cards' },
          under > 1 ? h('div', { class: 'under u2', attrs: { 'aria-hidden': 'true' } }) : null,
          under > 0 ? h('div', { class: 'under', attrs: { 'aria-hidden': 'true' } }) : null,
          paper),
        side),
      // Everything both systems recorded, as the Results drawer shows it.
      h('details', { class: 'review-evidence' },
        h('summary', null, k.evidenceSummary),
        evidencePanel({ filename: card.filename, names: names0, types: p.typeFile.types, threshold: p.threshold, decision, load, testid: 'review-card-evidence' })));
  }

  function choiceButton(spec: { key: string; title: string; sub: Read<string> | string; suggested?: Read<boolean>; testid?: string; run: () => void }): HTMLElement {
    // ui-rules: non-operational button: a card answer, kept on this computer until the review is saved
    return h('button', {
      class: 'choice', classes: spec.suggested === undefined ? {} : { sug: spec.suggested }, attrs: { type: 'button' },
      ...(spec.testid ? { testid: spec.testid } : {}), on: { click: spec.run }
    },
    h('kbd', null, spec.key),
    h('span', null, h('b', null, spec.title), h('span', null, spec.sub)));
  }

  function folderChoices(card: ReviewCard, options: string[], confidenceChoice: Read<string | null>, readerYes: Read<readonly string[]>): HTMLElement {
    const types = new Map((plan.peek()?.typeFile.types ?? []).map(type => [type.id, type]));
    return h('div', { class: 'choices', attrs: { role: 'group', 'aria-label': card.queue === 'needs' ? k.whereBelongs : k.wrongWhere } },
      options.map((folder, i) => {
        const sub = computed(() => {
          if (folder === REVIEW_FOLDER) return k.choiceSub.review;
          if (confidenceChoice() === folder) return k.choiceSub.confidence;
          if (readerYes().includes(folder)) return k.choiceSub.reader;
          return types.get(folder)?.what ?? '';
        });
        return choiceButton({
          key: String(i + 1), title: placeLabel(folder), sub,
          suggested: computed(() => card.queue === 'needs' && confidenceChoice() === folder),
          run: () => answer(card, { kind: 'move', to: folder }, placeLabel(folder), 'right')
        });
      }));
  }

  function answerPart(card: ReviewCard, options: string[], confidenceChoice: Read<string | null>, readerYes: Read<readonly string[]>): Node {
    switch (card.state) {
      case 'moved':
        return h('div', { class: 'stack-v' },
          h('p', { class: 'card__said' }, glyph('check', { size: 14 }), k.youMoved(card.nowName ?? '')),
          eitherMark(card));
      case 'right':
        return h('div', { class: 'card__said-row' },
          h('p', { class: 'card__said' }, glyph('check', { size: 14 }), k.saidRight),
          action({ id: `review:card-change:${runId}`, label: k.change, kind: 'quiet', run: async () => { walk.answer(card.tag, null); } }));
      case 'pending-move':
        return h('div', { class: 'stack-v' },
          notice({ kind: 'info', headline: k.moveIt(card.filename, card.pendingToName ?? ''), testid: 'review-card-move' }),
          h('div', { class: 'quiet-actions' },
            action({ id: `review:card-change:${runId}`, label: k.change, kind: 'quiet', run: async () => { walk.answer(card.tag, null); } })));
      case 'carried':
        return h('p', { class: 'card__said' }, glyph('check', { size: 14 }), k.trialStillCounts);
      default:
        break;
    }
    if (card.queue === 'needs') return folderChoices(card, options, confidenceChoice, readerYes);
    return h('div', { class: 'stack-v' },
      show(computed(() => !choosing()), () => h('div', { class: 'choices' },
        choiceButton({ key: 'R', title: k.rightChoice.title, sub: k.rightChoice.sub(card.destinationName), suggested: computed(() => true), testid: 'review-card-right',
          run: () => answer(card, { kind: 'right' }, k.toast.right, 'up') }),
        choiceButton({ key: 'W', title: k.wrongChoice.title, sub: k.wrongChoice.sub, testid: 'review-card-wrong',
          run: () => { choosing.set(true); focusDeck(); } }))),
      show(choosing, () => folderChoices(card, options, confidenceChoice, readerYes)));
  }

  /** "Either folder is right" for a copy moved between two categories: the same answer mark as before. */
  function eitherMark(card: ReviewCard): Node {
    if (!eitherApplies(card)) return document.createTextNode('');
    const marked = computed(() => marks()[card.fingerprint]?.status === 'ambiguous');
    return h('label', { class: 'choice mv__either', classes: { picked: marked }, testid: 'review-card-either' },
      h('kbd', null, 'E'),
      h('span', { class: 'mv__either-text' },
        h('input', {
          class: 'tick', attrs: { type: 'checkbox' }, props: { checked: marked },
          on: { change: event => {
            const on = (event.target as HTMLInputElement).checked;
            if (on !== marked.peek()) toggleEither(card);
          } }
        }),
        h('b', null, c.fitsBoth)));
  }

  function queueSummary(): HTMLElement {
    const q = queues.peek()!, which = queue.peek();
    const list = which === 'needs' ? q.needs : q.spot, counts = queueCounts(list);
    const skipped = list.filter(card => card.state === 'open').length;
    const title = which === 'spot' ? k.spotDone(counts.total) : skipped > 0 ? k.needsSummary(counts.answered, counts.total) : k.needsDone(counts.answered, counts.total);
    const sub = which === 'needs' && skipped > 0 ? k.needsSkipped(skipped) : which === 'spot' ? spotProgress : which === 'needs' && q.spot.length > 0 ? k.spotNext : null;
    return h('div', { class: 'review__done', testid: 'review-queue-done', attrs: { 'data-queue': which } },
      doneBanner({
        title, sub,
        action: h('div', { class: 'quiet-actions' },
          which === 'needs' && q.spot.length > 0
            ? action({ id: `review:to-spot:${runId}`, label: k.startSpot, kind: 'secondary', run: async () => { arriving = true; showQueue('spot'); } })
            : which === 'spot' && q.needs.length > 0
              ? action({ id: `review:to-needs:${runId}`, label: k.toNeeds, kind: 'secondary', run: async () => { arriving = true; showQueue('needs'); } }) : null,
          action({ id: `review:again:${runId}`, label: k.again, kind: 'quiet', run: async () => { arriving = true; goTo(0); focusDeck(); } }))
      }));
  }

  /** The recorded answers of one document, read once per card (the store caches them). */
  function evidenceLoad(fingerprint: string): Read<EvidenceLoad> {
    const load = signal<EvidenceLoad>({ state: 'loading' });
    const abort = new AbortController();
    effect(() => {
      run.loadEvidence(fingerprint, abort.signal).then(result => {
        if (result.kind === 'ok') load.set({ state: 'ready', answers: result.value });
      }, error => { if (!abort.signal.aborted) load.set({ state: 'error', error: presentError(error, 'evidence') }); });
      return () => abort.abort();
    });
    return load;
  }
}

/** A folder the person made: answered as a new category or ignored (the top folder can only be ignored). */
function newFolderRow(ctx: Ctx, folder: Read<ChecklistFolder>): HTMLElement {
  const c = ctx.copy.review;
  const walk = ctx.controllers.walk(ctx.route.peek().runId);
  const key = folder.peek().folder;
  const top = folder.peek().top;
  const options: readonly Decision[] = top ? ['ignore'] : ['new_type', 'ignore'];
  const decisions = computed(() => new Map((walk.checklist()?.folderDecisions ?? []).map(d => [d.folder, d.action])));
  const blocked = computed(() => walk.editBlocked() !== null);
  return h('div', { class: 'frow', testid: `review-folder-${key}` },
    glyph('folder', { class: 'frow__g', size: 22 }),
    h('div', { class: 'frow__body' },
      h('span', { class: 'frow__name' }, computed(() => folder().name)),
      h('span', { class: 'hint' }, computed(() => (top ? c.topFolderQuestion(folder().files) : c.newFolderQuestion(folder().files, folder().name)))),
      h('div', { class: 'radios frow__radios', attrs: { role: 'radiogroup', 'aria-label': computed(() => folder().name) } },
        options.map(value => h('label', { class: 'radio' },
          h('input', {
            attrs: { type: 'radio', name: `decide-${key}` },
            props: { checked: computed(() => decisions().get(key) === value), disabled: blocked },
            on: { change: () => { void walk.decide(key, value); } }
          }),
          h('span', null, value === 'new_type' ? c.newCategory : c.ignore))))));
}
