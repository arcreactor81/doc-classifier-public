/**
 * Make folders (SPEC §2.3, walkthrough 3a step 12; journey step 7), in The Sorting Room's layout: the step's eyebrow,
 * heading and lede, then two panels side by side. On the left, the folders (the originals, read only; an empty folder
 * for the copies), each explained before the browser asks, the journey's one action with "Stop after this file", the
 * live copying line and, once every copy is in place, the done banner. On the right, the folder tree that fills as the
 * real build controller copies files: one row per destination folder with its count rising from the builder's own
 * per-document results (core/ui/build-placements.ts; never estimated), the folder being filled lit, and the files that
 * just landed beneath it. Before the copying starts the tree shows what the results plan for each folder.
 * Nothing is sent and nothing is overwritten.
 */
import './build.css';
import { arrayShallowEqual, computed, effect, root, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import type { PlacedFile } from '../../../core/ui/build-placements.ts';
import { buildProblemRows, buildReportCounts, BuildIncompleteError } from '../../../core/ui/build-problems.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText } from '../../../core/ui/journey.ts';
import { FAILED_FOLDER, REVIEW_FOLDER, categoryNames, placeName } from '../../../core/ui/result-presenter.ts';
import { each, h, show } from '../view/dom.ts';
import { action } from '../view/action.ts';
import { reveal } from '../view/motion.ts';
import { actionSlot } from '../components/action-slot.ts';
import { folderPick } from '../components/folder-pick.ts';
import { notice } from '../components/notice.ts';
import { disclosure } from '../components/disclosure.ts';
import { words } from '../components/words.ts';
import { journeyPrimary, type PrimaryHandlers } from '../shell/primary.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import { doneBanner, whenComplete } from './review-parts.ts';

/** One row of the folder tree: a destination folder on disk, its planned copies and those in place so far. */
interface TreeRow { folder: string; name: string; planned: number; placed: number }

export function buildScreen(ctx: ViewContext<RouteOf<'build'>>): Node {
  const copy = ctx.copy, c = copy.screenBuild;
  const runId = ctx.route.peek().runId;
  const run = ctx.store.runStore(runId);
  const build = ctx.controllers.build(runId);
  whenComplete(run, () => { void build.prepare(); });
  void build.loadRemembered();
  if (run.plan.peek().state === 'idle') void run.loadPlan();

  const handlers: PrimaryHandlers = {
    [`build:make:${runId}`]: async (fb, signal) => {
      // The copying progress is shown beneath this button, in its own slot (owner rule 5; sweep EV-02).
      fb.working(c.copyTrack);
      const stopMirror = root(dispose => {
        effect(() => {
          const s = run.build();
          if (s.kind === 'copying') untrack(() => fb.working(c.copyTrack, { done: s.done, total: s.total }));
        });
        return dispose;
      });
      try {
        const outcome = await ctx.controllers.build(runId).make({ signal });
        stopMirror();
        if (outcome.kind === 'stopped') fb.done(c.stopped(outcome.done, outcome.total));
        else if (outcome.kind === 'finished') {
          if (!outcome.summary.complete) {
            const counts = buildReportCounts(outcome.summary.counts);
            fb.problem(new BuildIncompleteError(counts.ready, counts.total), 'build');
          } else {
            const placed = ctx.controllers.build(runId).report.peek()?.placed;
            fb.done(placed ? c.finished(placed.placed, placed.categories, placed.review, placed.failed) : c.madeFolders);
          }
        } else fb.clear();
      } finally {
        stopMirror();
      }
    }
  };
  const primary = journeyPrimary(ctx.journey, handlers,
    id => (id === `build:make:${runId}` ? { blockedBy: build.blockers, errorContext: 'build', note: c.makeExplain } : {}));

  const state = run.build;
  const copyingNow = computed(() => state().kind === 'copying');
  const warnings = computed(() => { const s = state(); return s.kind === 'warnings' ? s.warnings : []; });
  // A reload retains the counts, not the per-file report. Never invent file names for that saved summary.
  const lastBuild = computed(() => {
    const report = build.report(), local = run.local();
    const kept = local.state === 'ready' ? local.value.build : null;
    if (report !== null && (kept === null || report.summary.at >= kept.at))
      return { summary: report.summary, entries: report.entries };
    return kept === null ? null : { summary: kept, entries: null };
  });
  const incomplete = computed(() => !build.working() && lastBuild()?.summary.complete === false);
  const complete = computed(() => !build.working() && lastBuild()?.summary.complete === true);
  const shownProblems = signal(100);
  // The same words as the rail and the run strip: "Step 7 of 8 · Make folders".
  const stepLabel = copy.journey.stepOf(STEPS.indexOf('build') + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS.build }, copy));

  // --- The folder tree (measured: one builder result per document; planned from the results before that) -----------
  const placements = build.placements;
  const plan = computed(() => { const p = run.plan(); return p.state === 'ready' ? p.value : null; });
  const planned = computed<readonly TreeRow[] | null>(() => {
    const r = run.results(), p = plan();
    if (r.state !== 'ready' || p === null) return null;
    const names = categoryNames(p.typeFile, p.displayNames), typeIds = p.typeFile.types.map(type => type.id);
    const counts = new Map<string, number>();
    for (const entry of r.value.entries) counts.set(entry.destinationFolder, (counts.get(entry.destinationFolder) ?? 0) + 1);
    const rank = (folder: string) => { const i = typeIds.indexOf(folder); return i >= 0 ? i : folder === REVIEW_FOLDER ? typeIds.length : typeIds.length + 1; };
    return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([folder, n]) => ({ folder, name: placeName(folder, names, typeIds), planned: n, placed: 0 }));
  });
  const rows = computed<readonly TreeRow[]>(() => placements()?.folders ?? planned() ?? []);
  const started = computed(() => placements() !== null);
  const rowKeys = computed(() => rows().map(row => row.folder), { equals: arrayShallowEqual });
  const rowOf = (key: string): Read<TreeRow> => {
    let last: TreeRow | undefined;
    return computed(() => (last = rows().find(row => row.folder === key) ?? last) as TreeRow,
      { equals: (a, b) => a.placed === b.placed && a.planned === b.planned && a.name === b.name });
  };
  const latest = computed<PlacedFile | null>(() => placements()?.recent[0] ?? null);
  /** The folder the last copy landed in, while copying: the tree's lit row. */
  const hot = computed(() => (copyingNow() ? latest()?.folder ?? null : null));
  const outputName = computed(() => { const s = build.output(); return s.kind === 'chosen' ? s.name : c.tree.yourFolder; });
  const placedLine = computed(() => {
    const p = placements(), s = state();
    if (p === null) { const r = planned(); return r === null ? '' : c.folders.planned(r.reduce((n, row) => n + row.planned, 0), r.length); }
    if (s.kind === 'copying') return c.folders.inPlace(p.placed, p.total);
    if (p.placed === p.total) return c.folders.done(p.placed, p.folders.filter(row => row.placed > 0).length);
    return c.folders.short(p.placed, p.total);
  });
  const lastRowKey = computed(() => rowKeys().at(-1) ?? '');
  const treeRow = (row: Read<TreeRow>, key: string): HTMLElement =>
    h('li', {
      class: 'ln', attrs: { 'data-folder': key },
      classes: { hot: computed(() => hot() === key), full: computed(() => started() && row().placed >= row().planned) }
    },
    h('span', { class: 'ln__name' },
      h('span', { attrs: { 'aria-hidden': 'true' } }, computed(() => (lastRowKey() === key ? '└─ ' : '├─ '))),
      `${key}/`, h('span', { class: 'sr' }, ' · ', computed(() => row().name))),
    h('span', { class: 'c' },
      h('b', null, computed(() => (started() ? `${row().placed} / ${row().planned}` : String(row().planned)))),
      ' ', computed(() => c.tree.copies(row().planned)),
      key === REVIEW_FOLDER ? c.tree.withNote : key === FAILED_FOLDER ? c.tree.withReason : ''));
  const recentKeys = computed(() => placements()?.recent.map(file => `${file.folder}/${file.filename}`) ?? [], { equals: arrayShallowEqual });
  const recentOf = (key: string): Read<PlacedFile> => {
    let last: PlacedFile | undefined;
    return computed(() => (last = placements()?.recent.find(file => `${file.folder}/${file.filename}` === key) ?? last) as PlacedFile);
  };
  const recentRow = (file: Read<PlacedFile>): HTMLElement => {
    const li = h('li', { class: 'copyrow' },
      h('span', { class: 'copyrow__file' }, computed(() => file().filename)),
      h('span', { class: 'copyrow__to mono' }, computed(() => `→ ${file().folder}/`)));
    // A file that just landed rises into the list; the list is built before it is appended.
    queueMicrotask(() => reveal(li, 0, 'change'));
    return li;
  };
  const fraction = computed(() => { const s = state(); return s.kind === 'copying' && s.total > 0 ? s.done / s.total : 0; });

  return h('section', { class: 'build-step', testid: 'build' },
    h('div', { class: 'step-eyebrow', attrs: { 'data-build': '' } }, stepLabel),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.title)),
    h('p', { class: 'lede', attrs: { 'data-build': '' } }, c.lead),
    h('div', { class: 'grid-2 build-grid' },
      h('div', { class: 'panel build-where', attrs: { 'data-build': '' } },
        h('h3', { attrs: { id: 'build-originals-h' } }, c.originalsTitle),
        h('div', { class: 'build-pick', attrs: { 'aria-labelledby': 'build-originals-h', role: 'group' } },
          folderPick({
            id: `build:originals:${runId}`, purpose: 'originals', explanation: c.originalsExplain, testid: 'build-originals',
            state: build.originals, remembered: computed(() => build.remembered().originals), busy: build.folderBusy,
            useLabel: c.useAgain, chooseLabel: c.chooseOriginals,
            onUseRemembered: async () => { const key = build.remembered.peek().originals?.key; if (key) await build.useOriginals(key); },
            onChoose: async () => { await build.chooseOriginals(); }
          })),
        h('h3', { class: 'build-where__next', attrs: { id: 'build-output-h' } }, c.outputTitle),
        h('div', { class: 'build-pick', attrs: { 'aria-labelledby': 'build-output-h', role: 'group' } },
          folderPick({
            id: `build:output:${runId}`, purpose: 'copies', explanation: c.outputExplain, testid: 'build-output',
            state: build.output, remembered: computed(() => build.remembered().output), busy: build.folderBusy,
            useLabel: c.useAgain, chooseLabel: c.chooseOutput,
            onUseRemembered: async () => { const key = build.remembered.peek().output?.key; if (key) await build.useOutput(key); },
            onChoose: async () => { await build.chooseOutput(); }
          })),
        h('div', { class: 'build-make', attrs: { 'aria-label': c.nextStep, role: 'group' } },
          actionSlot(primary, { testid: 'build-primary' }),
          show(computed(() => warnings().length > 0), () => notice({
            kind: 'problem', testid: 'build-warnings', headline: c.pathWarnings,
            action: computed(() => c.warnings.tooLong(warnings().length))
          })),
          show(copyingNow, () => action({
            id: `build:stop:${runId}`, label: c.stop, kind: 'quiet',
            run: async () => { build.stopAfterThisFile(); }
          }))),
        // While copying: the bar and the file that just landed, from the builder's own results.
        show(copyingNow, () => h('div', { class: 'build-live', testid: 'build-live' },
          h('div', { class: 'bar live', attrs: { 'aria-hidden': 'true' } },
            h('i', { vars: { '--w': computed(() => `${Math.round(fraction() * 1000) / 10}%`) } })),
          h('p', { class: 'hint' }, computed(() => {
            const s = state(), f = latest();
            const n = s.kind === 'copying' ? s.done : 0, total = s.kind === 'copying' ? s.total : 0;
            return f === null ? c.copying(n, total) : c.live(n, total, f.filename, f.folder);
          })))),
        // Every copy in place: said once, with the facts that hold.
        show(complete, () => {
          const { total } = buildReportCounts(lastBuild.peek()!.summary.counts);
          return doneBanner({ title: c.done.title(total), sub: c.done.sub(total), testid: 'build-done' });
        }),
        show(incomplete, () => {
          const last = lastBuild.peek()!, counts = buildReportCounts(last.summary.counts);
          const problems = last.entries === null ? null : buildProblemRows(last.entries);
          const byTag = new Map(problems?.map(problem => [problem.tag, problem]) ?? []);
          return h('section', { class: 'build-report', testid: 'build-incomplete' },
            h('h3', null, c.problemsTitle),
            h('p', { class: 'build-report__summary' }, c.incomplete(counts.ready, counts.total)),
            h('p', { class: 'hint' }, c.lastAttempt(last.summary.destinationName)),
            problems === null
              ? h('p', { class: 'hint', testid: 'build-details-unavailable' }, c.detailsUnavailable(last.summary.destinationName))
              : h('div', { class: 'stack-v' },
                h('p', { class: 'hint' }, computed(() => c.problemsShown(Math.min(shownProblems(), problems.length), problems.length))),
                h('ul', { class: 'build-problems' },
                  each(computed(() => problems.slice(0, shownProblems()).map(problem => problem.tag), { equals: arrayShallowEqual }),
                    tag => computed(() => byTag.get(tag)!), item => {
                      const problem = item.peek();
                      return h('li', { attrs: { 'data-build-problem': problem.status } },
                        h('h4', null, problem.originalFilename),
                        h('p', { class: 'build-problems__path mono' }, c.copiesPath, ': ', problem.path),
                        h('p', null, phraseText(problem.reason, copy)),
                        h('p', { class: 'hint' }, phraseText(problem.action, copy)),
                        problem.details === null ? null : disclosure({ summary: copy.details, technical: true,
                          content: () => h('pre', null, problem.details) }));
                    })),
                show(computed(() => shownProblems() < problems.length), () => action({
                  id: 'build:more-problems:' + runId, label: copy.common.showMore(100), kind: 'quiet',
                  run: async () => { shownProblems.update(n => n + 100); }
                }))),
            h('p', { class: 'hint' }, c.resolveProblems));
        })),
      h('section', { class: 'panel build-tree', attrs: { 'data-build': '', 'aria-labelledby': 'build-tree-h' }, testid: 'build-landing' },
        h('div', { class: 'build-tree__head' },
          h('h3', { attrs: { id: 'build-tree-h' } }, c.folders.title),
          h('span', { class: 'hint', testid: 'build-landing-line' }, placedLine)),
        h('div', { class: 'tree', attrs: { 'aria-live': 'off' } },
          h('div', { class: 'ln root' }, computed(() => `${outputName()}/`)),
          h('ul', { class: 'tree__rows', testid: 'build-landing-folders' }, each(rowKeys, rowOf, treeRow))),
        show(computed(() => recentKeys().length > 0), () => h('div', { class: 'build-recent' },
          h('p', { class: 'eyebrow' }, c.folders.recent),
          h('ul', { class: 'build-recent__rows', testid: 'build-landing-recent' }, each(recentKeys, recentOf, recentRow)))))));
}
