/**
 * Files (SPEC §2.3, walkthrough 3a steps 5–6; journey steps 1–2), on the Sorting Room's run steps "Choose folder" and
 * "Read files" (design artifact RUN.choose, RUN.read). One screen, two bodies:
 *
 * - choose: the step eyebrow, the heading, the dropzone (the folder with three sheets that fan out on hover and fly
 *   out when the folder opens) and the three promises. The journey's primary ("Choose folder") sits inside the
 *   dropzone; a click anywhere on the dropzone presses it. The folder opens when the real folder picker has resolved
 *   (the draft starts scanning), and only then does the screen move on to reading.
 * - read: the loader panel (status, folder, the big count, the live bar, the notices that need the person, the done
 *   banner) beside "What happens to your files", and the Just read list: newest on top, a shimmering row while files
 *   are still being read, each file sliding in as its record is written, could-not-read rows in stone.
 *
 * The primary comes from journey() ("Choose folder", "Read only the original files", "Look again", "Review and start"…)
 * and its action runs the draft's ExtractionController. Its slot (`files-primary`) is one node for the whole screen: it
 * moves from the dropzone to the loader and into the done banner, so the held action and its outcome stay with it
 * (owner rule 5, components/action-slot.ts). Every number shown is the draft's own; nothing moves unless a record did.
 */
import './files.css';
import { arrayShallowEqual, computed, effect, onCleanup, shallowEqual, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText } from '../../../core/ui/journey.ts';
import type { LocalFileView } from '../../../core/ui/wire.ts';
import { duplicateCopies } from '../../../core/ui/extraction-plan.ts';
import { each, h, match, show } from '../view/dom.ts';
import { glyph, type GlyphName } from '../view/glyphs.ts';
import { actionSlot } from '../components/action-slot.ts';
import { count } from '../components/count.ts';
import { disclosure } from '../components/disclosure.ts';
import { errorNotice, notice } from '../components/notice.ts';
import { journeyPrimary, type PrimaryHandlers } from '../shell/primary.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import type { DraftStore } from '../state/types.ts';

/** The Just read list keeps this many rows, newest on top. */
const LIST_MAX = 200;
/** How long the folder takes to open before the reading step is shown (files.css `.dropzone.opening`). */
const OPEN_MS = 700;

/** The status row: whether it is live (pulses), and its words. */
interface LightRow { kind: 'idle' | 'live' | 'waiting' | 'paused' | 'failed' | 'done'; word: string; why: string }

export function filesScreen(ctx: ViewContext<RouteOf<'files'>>): Node {
  const copy = ctx.copy, c = copy.screenFiles, L = c.light;
  const localId = ctx.route.peek().localId;
  const draft = ctx.store.draftStore(localId);
  const extraction = () => ctx.controllers.extraction(localId);

  const handlers: PrimaryHandlers = {
    [`files:choose-folder:${localId}`]: async fb => { await extraction().chooseFolder(fb); },
    [`files:exclude-outputs:${localId}`]: async fb => { await extraction().excludeOutputs(fb); },
    [`files:start-over:${localId}`]: async fb => { await extraction().startOver(fb); },
    [`files:look-again:${localId}`]: async fb => { await extraction().lookAgain(fb); }
  };
  const primary = journeyPrimary(ctx.journey, handlers,
    id => (id === `files:choose-folder:${localId}` ? { note: c.permissionTip } : {}));
  // One slot for the whole screen; the bodies below place it (see the header).
  const slot = actionSlot(primary, { testid: 'files-primary' });

  const scan = draft.scan;
  const counts = draft.counts;
  const total = computed(() => counts().total);
  const settled = computed(() => counts().read + counts().failed);
  const waiting = computed(() => Math.max(0, total() - settled()));
  const skipped = computed(() => { const s = scan(); return s.kind === 'reading' || s.kind === 'done' ? s.skipped : []; }, { equals: arrayShallowEqual });
  const fileOf = (key: string) => draft.files.get(key);
  const reading = computed(() => scan().kind === 'reading');

  const status = computed(() => {
    const kind = scan().kind;
    if (kind === 'scanning' || kind === 'reading' || kind === 'needs-choice' || kind === 'changed-source' || kind === 'failed') return kind;
    if (counts().total === 0) return scan().kind === 'done' ? 'empty' : 'none';
    return settled() === counts().total ? 'read' : 'none';
  });
  const light = computed<LightRow>(() => {
    const s = scan();
    switch (s.kind) {
      case 'scanning': return { kind: 'live', word: L.looking, why: c.lookedAt(s.looked) };
      case 'reading': return { kind: 'live', word: L.reading, why: L.here };
      case 'failed': return { kind: 'failed', word: L.stopped, why: '' };
      case 'needs-choice':
      case 'changed-source': return { kind: 'waiting', word: L.waiting, why: '' };
      default: break;
    }
    if (total() === 0) return { kind: 'idle', word: s.kind === 'done' ? L.empty : L.idle, why: '' };
    return settled() === total() ? { kind: 'done', word: L.read, why: '' } : { kind: 'paused', word: L.unfinished, why: '' };
  }, { equals: shallowEqual });

  // Choose until there is something to read: a fresh draft, or one whose folder could not be opened. A folder that
  // needs a decision, an empty folder and every later state are shown on the reading step, with their notices.
  const wantsRead = computed(() => total() > 0 || (scan().kind !== 'none' && scan().kind !== 'failed'));
  const phase = signal<'choose' | 'read'>(wantsRead.peek() ? 'read' : 'choose');
  let dropzone: HTMLElement | null = null;
  effect(() => {
    const next = wantsRead() ? 'read' : 'choose';
    untrack(() => {
      dropzone?.classList.remove('opening');
      if (next === phase.peek()) return;
      // The folder opens once the picker has resolved and the scan has begun; then the reading step is shown.
      if (next === 'read' && dropzone !== null && dropzone.isConnected) {
        dropzone.classList.add('opening');
        // The wait is an animation of nothing on the dropzone (screens keep no timers): it ends as the folder has opened.
        // Cancelled by anything but this screen's own cleanup, it still ends the wait, so the reading step is never held.
        const wait = dropzone.animate([{}, {}], { duration: OPEN_MS });
        let mine = true;
        const opened = () => { if (mine && wantsRead.peek()) phase.set('read'); };
        wait.finished.then(opened, opened);
        onCleanup(() => { mine = false; wait.cancel(); });
        return;
      }
      phase.set(next);
    });
  });

  const stepLine = (step: 'folder' | 'read') =>
    copy.journey.stepOf(STEPS.indexOf(step) + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS[step] }, copy));
  const head = (step: 'folder' | 'read', title: string, lede: string) => [
    h('div', { class: 'step-eyebrow' }, stepLine(step)),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, title),
    h('p', { class: 'lede' }, lede),
    // A comparison run says so before anything is chosen (SPEC §3c.10); the read step repeats it in its panel.
    step === 'folder'
      ? show(computed(() => draft.referenceId() !== null), () => notice({ kind: 'info', headline: c.comparisonRun, testid: 'files-lineage' }))
      : null];

  // --- Step 1: choose ------------------------------------------------------------------------------------------------
  const chooseBody = () => {
    const zone = h('div', {
      class: 'panel dropzone', testid: 'files-dropzone',
      on: { click: event => {
        // The whole dropzone presses the folder button; its own controls work as they are.
        if ((event.target as Element).closest('button, a, summary, details')) return;
        const button = slot.querySelector<HTMLButtonElement>('button[data-op]');
        if (button !== null && !button.disabled) button.click();
      } }
    },
    h('span', { class: 'fold', attrs: { 'aria-hidden': 'true' } },
      h('i', { class: 'ms ms1' }), h('i', { class: 'ms ms2' }), h('i', { class: 'ms ms3' }),
      h('i', { class: 'fold-back' }), h('i', { class: 'fold-front' })),
    slot,
    h('span', { class: 'dz-formats' }, c.formats));
    dropzone = zone;
    const tile = (name: GlyphName, [lead, rest]: readonly [string, string]) =>
      h('div', { class: 'panel tiny' }, glyph(name, { size: 18 }), h('span', null, h('b', null, lead), ' ', rest));
    return h('div', { class: 'files__body' },
      ...head('folder', c.chooseTitle, c.chooseLead),
      zone,
      h('div', { class: 'grid-3 files__tiles' }, tile('lock', c.tiles.here), tile('shield', c.tiles.resumes), tile('slash', c.tiles.honest)));
  };

  // --- Step 2: read ---------------------------------------------------------------------------------------------------
  const readBody = () => {
    dropzone = null;
    const recent = recentlyRead(draft);
    const percent = computed(() => (total() === 0 ? '0%' : `${(settled() / total()) * 100}%`));
    const lightClass = computed(() => {
      const kind = light().kind;
      return kind === 'live' ? 'status w' : kind === 'waiting' || kind === 'failed' ? 'status p' : kind === 'done' ? 'status' : 'status is-still';
    });
    const loader = h('section', { class: 'panel files__loader', attrs: { 'aria-label': c.paneLabel }, testid: 'files-pane' },
      h('div', { class: 'files__top' },
        h('p', { class: lightClass, attrs: { 'data-state': computed(() => light().kind) }, testid: 'files-light' },
          h('span', null, computed(() => light().word)),
          h('span', { class: 'files__why', attrs: { hidden: computed(() => light().why === '') } }, computed(() => light().why))),
        show(computed(() => draft.sourceName() !== null), () => h('p', { class: 'files__src', testid: 'files-folder' },
          glyph('folder'), h('span', null, computed(() => c.folder(draft.sourceName() ?? '')))))),
      show(computed(() => draft.referenceId() !== null), () => notice({ kind: 'info', headline: c.comparisonRun, testid: 'files-lineage' })),
      // Only what needs the person is shown here; the reading's own progress is beneath the action that started it.
      match(status, {
        'needs-choice': () => notice({
          kind: 'problem', testid: 'files-needs-choice',
          headline: computed(() => { const s = scan(); return s.kind === 'needs-choice' && s.rootIsOutput ? c.rootIsOutput : c.needsChoice; }),
          action: computed(() => { const s = scan(); return s.kind === 'needs-choice' && s.rootIsOutput ? null : c.needsChoiceAction; })
        }),
        'changed-source': () => notice({
          kind: 'problem', testid: 'files-changed',
          headline: computed(() => { const s = scan(); return c.changedSource(s.kind === 'changed-source' ? s.missing : 0); }),
          action: c.changedSourceAction
        }),
        failed: () => {
          const s = scan.peek();
          return s.kind === 'failed' ? errorNotice(s.error, 'problem', 'files-scan-failed') : document.createTextNode('');
        },
        empty: () => notice({ kind: 'problem', headline: c.noFiles, testid: 'files-empty' })
      }),
      // The space between the number and its words stays a text node: a screen reader reads "38 of 114 read".
      show(computed(() => total() > 0), () => h('div', { class: 'bigcount', testid: 'files-count' },
        h('b', null, count(settled)), ' ',
        h('span', null, computed(() => c.ofRead(total()))))),
      show(computed(() => total() > 0), () => h('div', {
        class: 'bar files__bar', classes: { live: reading }, testid: 'files-read-bar',
        attrs: { role: 'progressbar', 'aria-label': c.readTrack, 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': settled,
          'aria-valuetext': computed(() => c.read(settled(), total())) }
      }, h('i', { vars: { '--w': percent } }))),
      show(computed(() => counts().duplicates > 0 && status() === 'read'), () => h('div', { class: 'stack-v files__notes' },
        notice({
          kind: 'problem', testid: 'files-duplicates',
          headline: computed(() => c.duplicates(counts().duplicates)), action: c.duplicatesAction
        }),
        // Which files are the copies, and of what (DECISIONS 129c): the person removes them, the app never chooses.
        disclosure({
          id: 'files-duplicate-list', testid: 'files-duplicate-list',
          summary: computed(() => c.duplicatesList(counts().duplicates)),
          // Read once when opened: the list changes only with a new reading, which replaces this notice.
          content: () => h('ul', { class: 'files files--plain' },
            ...untrack(() => duplicateCopies(draft.files.keys().flatMap(key => { const file = fileOf(key)?.(); return file ? [file] : []; })))
              .map(pair => h('li', null, h('span', null, pair.copy), h('span', { class: 'st' }, c.duplicateOf(pair.original)))))
        }))),
      // System and lock files the scan left out (core/local/source-scan.ts NOT_DOCUMENTS): listed, never read or counted.
      show(computed(() => skipped().length > 0), () => h('div', { class: 'stack-v files__notes' },
        notice({ kind: 'info', testid: 'files-not-documents', headline: computed(() => c.notDocuments(skipped().length)) }),
        disclosure({
          id: 'files-not-documents-list', testid: 'files-not-documents-list',
          summary: computed(() => c.notDocumentsList(skipped().length)),
          content: () => h('ul', { class: 'files files--plain' }, ...untrack(skipped).map(path => h('li', null, h('span', null, path))))
        }))),
      // The foot: the done banner with the next step once every file is read; otherwise the action and a hint.
      match(computed(() => (status() === 'read' ? 'done' : 'foot')), {
        done: () => h('div', { class: 'done-banner files__done', attrs: { role: 'status' }, testid: 'files-done' },
          h('span', { class: 'check-stamp', attrs: { 'aria-hidden': 'true' } }, glyph('check', { size: 18 })),
          h('div', { class: 'files__done-text' },
            h('b', null, computed(() => c.doneTitle(total()))),
            h('span', null, computed(() => c.doneSub(counts().read, counts().failed)))),
          h('div', { class: 'files__done-action' }, slot)),
        foot: () => h('div', { class: 'files__foot' },
          slot,
          show(reading, () => h('p', { class: 'hint' }, c.readingHint)))
      }));

    const promise = (name: GlyphName, [lead, rest]: readonly [string, string]) =>
      h('li', null, glyph(name, { size: 18 }), h('span', null, h('b', null, lead), ' ', rest));
    const promises = h('section', { class: 'panel', attrs: { 'aria-labelledby': 'files-promises' } },
      h('h3', { attrs: { id: 'files-promises' } }, c.promisesTitle),
      h('ul', { class: 'promises files__promises' },
        promise('lock', c.promises.here), promise('shield', c.promises.notYet), promise('slash', c.promises.scanned)));

    const list = h('ul', { class: 'files files__rows' },
      // While files are still being read: one shimmering row. Which file a worker holds is not recorded, so it names none.
      show(computed(() => reading() && waiting() > 0), () => h('li', { class: 'reading-row', attrs: { 'aria-hidden': 'true' } },
        h('span', null, c.readingRow), h('span', { class: 'st' }, c.readingState))),
      each(recent.keys, fileOf, (file, key) => {
        const fresh = recent.fresh.delete(key);
        const failed = computed(() => file().state === 'failed');
        const ext = computed(() => extensionOf(file().name));
        return h('li', { class: fresh ? 'row-in' : '', attrs: { 'data-state': computed(() => (failed() ? 'failed' : 'read')) } },
          h('span', { class: 'files__name' },
            // The name without its extension, which the label beside it shows (the artifact's title and .ext).
            h('span', null, computed(() => baseName(file().name))), ' ',
            h('span', { class: 'ext', attrs: { hidden: computed(() => ext() === '') } }, ext),
            show(failed, () => h('small', null, computed(() => failureText(file()))))),
          show(failed,
            () => h('span', { class: 'st bad' }, c.rowFailed),
            () => h('span', { class: 'st ok' }, glyph('check', { size: 14 }), ' ', c.rowRead)));
      }));
    const justRead = h('section', { class: 'panel files__list', attrs: { 'aria-labelledby': 'files-just-read' }, testid: 'files-just-read' },
      h('div', { class: 'files__list-head' },
        h('h3', { attrs: { id: 'files-just-read' } }, c.justRead),
        h('span', { class: 'hint' }, computed(() => (waiting() > 0 ? c.waiting(waiting()) : '')))),
      show(computed(() => recent.keys().length === 0 && !reading()), () => h('p', { class: 'hint' }, c.noneYet)),
      list);

    return h('div', { class: 'files__body' },
      ...head('read', c.title, c.lead),
      h('div', { class: 'files__grid' }, loader, promises),
      show(computed(() => total() > 0), () => justRead));
  };

  return h('section', { class: 'files-screen', testid: 'files', attrs: { 'data-phase': phase } },
    match(phase, { choose: chooseBody, read: readBody }));
}

/**
 * The files read, newest first. No record says when a file was read, so the order is kept here: a file seen waiting
 * and then read is `fresh` (an event: its row slides in once); files that are already read when they appear (the
 * screen opening on a read folder, records loaded from another tab) are the record and do not move.
 */
function recentlyRead(draft: DraftStore): { keys: Read<readonly string[]>; fresh: Set<string> } {
  const recent = signal<readonly string[]>([], { equals: arrayShallowEqual });
  const fresh = new Set<string>();
  const known = new Set<string>();
  const pending = new Set<string>();
  let lastKeys: readonly string[] | null = null;
  const settledFile = (file: LocalFileView) => file.state !== 'waiting';
  effect(() => {
    const keys = draft.files.keys();
    draft.counts(); // changes whenever a file's state does
    untrack(() => {
      const read: string[] = [], arrived: string[] = [];
      if (keys !== lastKeys) {
        lastKeys = keys;
        const present = new Set(keys);
        for (const key of known) if (!present.has(key)) { known.delete(key); pending.delete(key); }
        for (const key of keys) {
          if (known.has(key)) continue;
          known.add(key);
          const file = draft.files.get(key)?.peek();
          if (file === undefined) continue;
          if (settledFile(file)) arrived.push(key);
          else pending.add(key);
        }
        const kept = recent.peek().filter(key => present.has(key));
        if (kept.length !== recent.peek().length) recent.set(kept);
      }
      for (const key of pending) {
        const file = draft.files.get(key)?.peek();
        if (file === undefined) pending.delete(key);
        else if (settledFile(file)) { pending.delete(key); read.push(key); }
      }
      if (read.length === 0 && arrived.length === 0) return;
      for (const key of read) fresh.add(key);
      recent.set([...read.reverse(), ...arrived.reverse(), ...recent.peek()].slice(0, LIST_MAX));
    });
  });
  return { keys: recent, fresh };
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toUpperCase();
}

function baseName(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? name : name.slice(0, at);
}

function failureText(file: LocalFileView): string {
  return file.failure?.message ?? '';
}
