/**
 * The decisions behind Make folders, as facts → value (SPEC §4.1 L3; §6.1 BuildController, §7.2 BuildView parts,
 * §9 S8; walkthrough 3a step 12). The build controller (ui/app/controllers/build.ts) does the folder and file work;
 * everything it decides lives here, so the gate tests it. Pure: no DOM, no I/O, no timers.
 *
 * - `summaryCategories`: the run's frozen categories (GET /plan) as the "Categories used" section that ends the build
 *   summary (S8). Names come from `categoryNames`, the same map Results uses; the order is the recorded order.
 * - `pathOptions`, `buildPreview`: the Details path options (an optional full path, the longest path and name Windows
 *   allows, the naming style) checked, and the plan they give. Long paths block Make folders.
 * - `nestingOf`, `nestingError`: the copies never go inside the originals, and the originals never inside the copies.
 * - `buildBlockers`: why Make folders is unavailable, as phrases for its slot.
 * - `buildEnding`, `placedCounts`: what a finished or stopped build means, and the counts of the done sentence.
 */
import {
  planTree, type BuildOptions, type BuildPlan, type BuildResult, type BuilderManifest, type SummaryCategories
} from '../builder/builder.ts';
import type { TypeFile } from '../config/project.ts';
import type { Phrase } from './journey.ts';
import { FAILED_FOLDER, REVIEW_FOLDER, categoryNames } from './result-presenter.ts';

// ---------------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------------

export type FolderPermission = 'granted' | 'prompt' | 'denied';

/** One folder the build needs, as FolderPick shows it (structurally components/folder-pick.ts `FolderPickState`). */
export type BuildFolderState =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'waiting' }
  | { kind: 'chosen'; name: string; permission: FolderPermission };

/** How two chosen folders relate. `same` counts as the copies going inside the originals. */
export type FolderNesting = 'separate' | 'same' | 'output-inside-originals' | 'originals-inside-output';

/**
 * From the browser's own answers: `originals.resolve(output)` and `output.resolve(originals)`. Each is the path from
 * the first folder down to the second, `[]` when they are the same folder, or null when the second is not inside.
 */
export function nestingOf(outputInOriginals: readonly string[] | null, originalsInOutput: readonly string[] | null): FolderNesting {
  if ((outputInOriginals !== null && outputInOriginals.length === 0) || (originalsInOutput !== null && originalsInOutput.length === 0))
    return 'same';
  if (outputInOriginals !== null && originalsInOutput !== null)
    throw new Error('nestingOf(): two different folders cannot each be inside the other.');
  if (outputInOriginals !== null) return 'output-inside-originals';
  if (originalsInOutput !== null) return 'originals-inside-output';
  return 'separate';
}

export const BUILD_FOLDER_CODES = {
  outputInsideOriginals: 'E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS',
  originalsInsideOutput: 'E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT'
} as const;
export type BuildFolderCode = typeof BUILD_FOLDER_CODES[keyof typeof BUILD_FOLDER_CODES];
/** Every overlap code, for error-copy's tests (the `E_UI_*` convention of core/ui/run-controls.ts). */
export const BUILD_FOLDER_ERROR_CODES: readonly BuildFolderCode[] = [BUILD_FOLDER_CODES.outputInsideOriginals, BUILD_FOLDER_CODES.originalsInsideOutput];

/** The copy key of the plain sentence for each refusal (for error-copy.ts; the words are in copy-build.ts). */
export const BUILD_FOLDER_SENTENCE_KEYS: Readonly<Record<BuildFolderCode, string>> = {
  E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS: 'screenBuild.output.insideOriginals',
  E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT: 'screenBuild.output.originalsInside'
};

/** A folder choice refused because the copies and the originals would overlap. Nothing was kept or written. */
export class BuildFolderError extends Error {
  readonly code: BuildFolderCode;
  readonly nesting: Exclude<FolderNesting, 'separate'>;
  constructor(nesting: Exclude<FolderNesting, 'separate'>) {
    const inside = nesting === 'originals-inside-output';
    super(inside
      ? 'The chosen folder for the copies contains the originals folder.'
      : nesting === 'same'
        ? 'The folder for the copies is the originals folder itself.'
        : 'The chosen folder for the copies is inside the originals folder.');
    this.name = 'BuildFolderError';
    this.code = inside ? BUILD_FOLDER_CODES.originalsInsideOutput : BUILD_FOLDER_CODES.outputInsideOriginals;
    this.nesting = nesting;
  }
}

/** The refusal for two overlapping folders, or null when they are separate. */
export function nestingError(nesting: FolderNesting): BuildFolderError | null {
  return nesting === 'separate' ? null : new BuildFolderError(nesting);
}

// ---------------------------------------------------------------------------------------------------------------
// The "Categories used" section (S8)
// ---------------------------------------------------------------------------------------------------------------

/** The section's words, from copy-build.ts `categoriesUsed` (builder.ts takes its words from the caller). */
export interface SummaryWords { heading: string; folder: string; what: string; notFor: string; examples: string }

/** The frozen parts of GET /plan the section needs. */
export interface FrozenCategories { typeFile: TypeFile; displayNames: Readonly<Record<string, string>> }

/** The run's categories in their recorded order, each with its folder name and the name the person sees. */
export function summaryCategories(frozen: FrozenCategories, words: SummaryWords): SummaryCategories {
  const names = categoryNames(frozen.typeFile, frozen.displayNames);
  return {
    heading: words.heading,
    labels: { folder: words.folder, what: words.what, notFor: words.notFor, examples: words.examples },
    categories: frozen.typeFile.types.map(type => ({
      folder: type.id,
      name: names[type.id],
      what: type.what,
      notFor: type.not_for,
      examples: [...type.examples]
    }))
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Path options and the plan they give
// ---------------------------------------------------------------------------------------------------------------

export type NamingStyle = BuildOptions['naming'];

/** The Details path options as the person typed them. */
export interface BuildPathInput {
  /** The full path of the folder for the copies, when the person gives it; the browser never reveals it. */
  fullPath: string;
  /** The longest path Windows allows, as typed. */
  maxPath: string;
  /** The longest file or folder name, as typed. */
  maxName: string;
  naming: NamingStyle;
}

/** Windows' limits, shown and editable in Details (not a hidden default). */
export const DEFAULT_PATH_INPUT: Readonly<BuildPathInput> = Object.freeze({ fullPath: '', maxPath: '260', maxName: '255', naming: 'original' });

export type PathOptionsCheck = { ok: true; options: BuildOptions } | { ok: false; problems: readonly Phrase[] };

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * The builder's options from the typed path options. Without a full path, the length check measures from the
 * output folder's name (all the browser reveals), which the Details text says.
 */
export function pathOptions(input: BuildPathInput, destinationName: string): PathOptionsCheck {
  if (input.naming !== 'original' && input.naming !== 'short')
    throw new Error(`pathOptions(): unknown naming style "${String(input.naming)}".`);
  if (typeof destinationName !== 'string' || destinationName.trim() === '')
    throw new Error('pathOptions(): the folder for the copies has no name.');
  const maxPathLength = wholeNumber(input.maxPath), maxComponentLength = wholeNumber(input.maxName);
  if (maxPathLength === null || maxComponentLength === null) {
    const problems: Phrase[] = [];
    if (maxPathLength === null) problems.push({ key: 'screenBuild.blockers.maxPath' });
    if (maxComponentLength === null) problems.push({ key: 'screenBuild.blockers.maxName' });
    return { ok: false, problems };
  }
  const fullPath = input.fullPath.trim().replace(/[\\/]+$/, '');
  return {
    ok: true,
    options: { naming: input.naming, destinationPrefix: fullPath || destinationName.trim(), maxPathLength, maxComponentLength }
  };
}

export type BuildPreview =
  /** The results file or the folder for the copies is not there yet. */
  | { kind: 'waiting' }
  | { kind: 'invalid'; problems: readonly Phrase[] }
  /** planTree refused the results (an unsafe name, a repeated tag); its sentence is kept for Details. */
  | { kind: 'unplannable'; message: string }
  | { kind: 'warnings'; warnings: BuildPlan['warnings'] }
  | { kind: 'ready'; plan: BuildPlan };

/** What Make folders would do now, recomputed as the results, the output folder or the options change. */
export function buildPreview(results: BuilderManifest | null, destinationName: string | null, input: BuildPathInput): BuildPreview {
  if (results === null || destinationName === null) return { kind: 'waiting' };
  const checked = pathOptions(input, destinationName);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };
  let plan: BuildPlan;
  try {
    plan = planTree(results, checked.options);
  } catch (error) {
    return { kind: 'unplannable', message: error instanceof Error ? error.message : String(error) };
  }
  return plan.warnings.length > 0 ? { kind: 'warnings', warnings: plan.warnings } : { kind: 'ready', plan };
}

// ---------------------------------------------------------------------------------------------------------------
// Why Make folders is unavailable
// ---------------------------------------------------------------------------------------------------------------

/** A loader's state as the blockers need it: a failure keeps its presented headline. */
export type LoadFacts = { state: 'idle' | 'loading' | 'ready' } | { state: 'error'; headline: string };

export interface BuildFacts {
  /** The run's results file (R19, the run store's cache). */
  results: LoadFacts;
  /** The run's frozen plan (the categories for the summary). */
  plan: LoadFacts;
  originals: BuildFolderState;
  output: BuildFolderState;
  preview: BuildPreview;
}

const verbatim = (text: string): Phrase => ({ key: 'errors.verbatim', args: { text } });

/**
 * The reasons, in the order the person meets them. A results file or plan still loading is not a reason: Make folders
 * waits for it. A recorded failure is, with the sentence the store recorded (for example "These results belong to a
 * different run.", REG 9). Working is not a reason either: the action disables itself while it runs.
 */
export function buildBlockers(facts: BuildFacts): Phrase[] {
  const reasons: Phrase[] = [];
  if (facts.results.state === 'error') reasons.push(verbatim(facts.results.headline));
  if (facts.plan.state === 'error') reasons.push(verbatim(facts.plan.headline));
  if (facts.originals.kind !== 'chosen') reasons.push({ key: 'screenBuild.blockers.chooseOriginals' });
  if (facts.output.kind !== 'chosen') reasons.push({ key: 'screenBuild.blockers.chooseOutput' });
  const preview = facts.preview;
  if (preview.kind === 'invalid') reasons.push(...preview.problems);
  else if (preview.kind === 'warnings') reasons.push({ key: 'screenBuild.warnings.tooLong', args: { n: preview.warnings.length } });
  else if (preview.kind === 'unplannable') reasons.push({ key: 'screenBuild.blockers.unplannable' });
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// After a build
// ---------------------------------------------------------------------------------------------------------------

export type BuildEnding = { kind: 'finished' } | { kind: 'stopped'; done: number; total: number };

/** Stopped when Stop after this file left documents not attempted; finished otherwise (complete or not). */
export function buildEnding(result: BuildResult): BuildEnding {
  const cancelled = result.entries.filter(entry => entry.status === 'cancelled').length;
  return cancelled === 0 ? { kind: 'finished' } : { kind: 'stopped', done: result.entries.length - cancelled, total: result.entries.length };
}

/** The counts of the done sentence (REG 18): copies now in the folder, by where they went. */
export interface PlacedCounts {
  /** Documents in the plan. */
  total: number;
  /** Copied now or already there with the same content. */
  placed: number;
  categories: number;
  review: number;
  failed: number;
}

export function placedCounts(plan: BuildPlan, result: BuildResult): PlacedCounts {
  const folderOf = new Map(plan.entries.map(planned => [planned.entry.tag, planned.entry.destinationFolder]));
  const counts: PlacedCounts = { total: plan.entries.length, placed: 0, categories: 0, review: 0, failed: 0 };
  for (const entry of result.entries) {
    if (entry.status !== 'copied' && entry.status !== 'already_present') continue;
    const folder = folderOf.get(entry.tag);
    if (folder === undefined) throw new Error(`placedCounts(): "${entry.tag}" is not in the plan.`);
    counts.placed++;
    if (folder === REVIEW_FOLDER) counts.review++;
    else if (folder === FAILED_FOLDER) counts.failed++;
    else counts.categories++;
  }
  return counts;
}
