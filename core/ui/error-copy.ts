/**
 * Errors shown beneath the action that caused them: specific, plain and recoverable (SPEC §4.12). Pure: no DOM, no
 * I/O, no timers.
 *
 * Rules:
 * - A server headline is shown verbatim (the request-error.ts rule), unless it would put a technical word in the
 *   normal path (SPEC §0.1 rule 7); then a plain headline is shown and the server's moves to `technical`.
 * - The action for a known code comes from the §4.12 map. Otherwise a specific server action is shown verbatim.
 *   The generic "Send this sentence to your technical contact…" action is never shown: a plain action replaces it
 *   and the server sentence moves to `technical`.
 * - Local problems (extraction codes, `E_LOCAL_*`, DOMException names, a network `TypeError`) get a plain headline,
 *   because `errorPresentation` would hide them behind a generic one (BL §15 B7).
 * - Nothing is retried or dismissed here; a view shows exactly one notice per feedback slot.
 */
import { uiCopy } from './copy.ts';
import { UiRequestError, errorPresentation } from './request-error.ts';
import { formatRoute, runViewRoute } from './routes.ts';
import { UiShapeError, type StopReasonWire } from './wire.ts';
import type { Phrase } from './journey.ts';

export interface UiErrorView {
  headline: string;
  action: Phrase | null;
  link: { phrase: Phrase; href: string } | null;
  /** Details only. */
  technical: Record<string, unknown>;
  code: string | null;
  kind: 'server' | 'local' | 'network';
}

export type ErrorContext = 'confirm' | 'send' | 'build' | 'walk' | 'review-save' | 'apply' | 'draft-save' | 'activate' |
  'answers-save' | 'carry' | 'close' | 'kill' | 'evidence' | 'read' | 'generic';

/** Facts the caller knows and the error does not carry. */
export interface ErrorHints {
  /** The run whose answers a new run is checked against (the "Update my answers" link). */
  sourceRunId?: string | null;
  /** The file being sent when the error happened. */
  filename?: string | null;
}

/**
 * The normal-path jargon patterns of SPEC §10.1 (and the plural forms `copy-lint.test.ts` adds). A server sentence
 * that matches one is kept for Details and replaced in the normal path.
 */
export const JARGON_PATTERNS: readonly RegExp[] = [
  /\b(manifest|json|fingerprint|sidecar|git|repository|project pack|pins?|workflow|tokens?|http|inference|aud|uuid|technical contact|kill switch|threshold|filing bar|noul|probability)\b/i,
  /\b[EN]_[A-Z_]{3,}\b/,
  /\bR[0-5]n?\b/,
  /\.json\b/,
  /\b(manifests|fingerprints|sidecars|repositories|project packs|workflows|https|uuids|thresholds|nouls|probabilities)\b/i
];

export function hasJargon(text: string): boolean {
  return JARGON_PATTERNS.some(pattern => pattern.test(text));
}

const phrase = (key: string, args?: Readonly<Record<string, string | number>>): Phrase => (args ? { key, args } : { key });
const verbatim = (text: string): Phrase => phrase('errors.verbatim', { text });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The server's generic action (core/server/errors.ts `serverCopy.action`) and anything else with technical words. */
function unusableAction(action: string): boolean {
  return !action.trim() || /^Send this sentence to your technical contact/.test(action) || hasJargon(action);
}

const LINKS = {
  system: () => ({ phrase: phrase('errors.links.system'), href: formatRoute({ view: 'system' }) }),
  editor: () => ({ phrase: phrase('errors.links.openEditor'), href: formatRoute({ view: 'category-edit', fromRunId: null, correctionId: null }) }),
  answers: (runId: string) => ({ phrase: phrase('errors.links.updateAnswers'), href: formatRoute(runViewRoute('improve', runId)) })
};

interface Mapped { action: Phrase; link?: UiErrorView['link']; headline?: string }

/** 400 `E_REQUEST` sentences the UI recognises by their opening words (core/server/api.ts). */
function requestAction(headline: string, context: ErrorContext, hints: ErrorHints): Mapped | null {
  const a = 'errors.action.';
  if (headline.startsWith('The project changed after this confirmation')) return { action: phrase(a + 'projectChanged') };
  if (headline.startsWith('Categories changed')) {
    if (context === 'confirm') return { action: phrase(a + 'projectChanged') };
    if (context === 'apply') return { action: phrase(a + 'staleSuggestion') };
    return { action: phrase(a + 'categoriesChanged'), link: LINKS.editor() };
  }
  if (headline.startsWith('Every document must be uploaded before starting')) return { action: phrase(a + 'notAllSent') };
  if (headline.startsWith('The document differs from the confirmed preflight input') ||
      headline.startsWith('The filename differs from the confirmed preflight') ||
      headline.startsWith('An upload with this fingerprint already exists with different content'))
    return {
      action: hints.filename ? phrase(a + 'documentChanged', { name: hints.filename }) : phrase(a + 'documentChangedUnnamed')
    };
  if (headline.startsWith('This run is no longer accepting uploads')) return { action: phrase(a + 'noLongerSending') };
  return null;
}

/** The SPEC §4.12 minimum map, by code. */
function codeAction(code: string, context: ErrorContext, hints: ErrorHints, headline: string): Mapped | null {
  const a = 'errors.action.', h = uiCopy.errors.headline;
  switch (code) {
    case 'E_PILOT_STALE': return { action: phrase('trial.stale') };
    case 'E_PILOT_MISFILED': return { action: phrase('trial.wrongNote') };
    case 'E_PILOT_INCOMPLETE': return { action: phrase('trial.reviewEvery') };
    case 'E_PILOT_CONFIRMED': return { action: phrase('trial.reviewClosed') };
    case 'E_PILOT_REQUIRED': return { action: phrase('trial.chooseTrial') };
    case 'E_PILOT_REVIEW': return { action: phrase('trial.notFinished') };
    case 'E_KILL_SWITCH':
      return { action: phrase(a + 'emergencyStop'), link: LINKS.system(), headline: h.emergencyStop };
    case 'E_MODEL_CALLS_DISABLED':
      return { action: phrase(a + 'sortingOff') };
    case 'E_NOT_READY':
      return { action: phrase(a + 'notReady'), link: LINKS.system(), headline: h.notReady };
    case 'E_FEEDBACK_REFERENCE':
      if (context === 'carry') return { action: phrase(a + 'carryRefused') };
      if (context === 'answers-save') return { action: phrase(a + 'answersRefused') };
      return { action: phrase(a + 'answersVersion'), link: hints.sourceRunId ? LINKS.answers(hints.sourceRunId) : null };
    case 'E_DEFINITION_STALE':
      return { action: phrase(a + 'categoriesChanged'), link: LINKS.editor() };
    case 'E_EDITOR_REQUIRED':
      return { action: phrase(a + 'editorRequired') };
    case 'E_THRESHOLD_ALREADY_APPLIED':
      return { action: phrase(a + 'alreadyApplied') };
    case 'E_CLOSE_UNFINISHED':
      return { action: phrase(a + 'closeUnfinished'), headline: h.closeUnfinished };
    case 'E_CORRECTION_ROOT_FOLDER':
      return { action: phrase(a + 'rootFolder') };
    case 'E_CORRECTION_AMBIGUOUS_IDENTITY':
      return { action: phrase(a + 'ambiguousIdentity') };
    case 'E_CORRECTION_DUPLICATE_PATH':
    case 'E_CORRECTION_PATH':
      return { action: phrase(a + 'pathUnreadable') };
    case 'E_MANIFEST_INCOMPLETE':
      return { action: phrase(a + 'resultsNotReady'), headline: h.resultsNotReady };
    case 'E_INTERNAL':
      return { action: phrase(a + 'internal') };
    // Cloudflare Access answered for the app (request-error.ts): reloading the page signs the person in again.
    case 'E_SIGNIN_EXPIRED':
      return { action: phrase(a + 'signInExpired'), headline: h.signInExpired };
    // The sign-in service's keys could not be fetched just now: the sign-in itself is fine, so this is a passing problem.
    case 'E_ACCESS_KEYS_UNAVAILABLE':
      return { action: phrase(a + 'localRetry') };
    // A person's daily allowance on this site, reached: the server says which and when it resets.
    case 'E_DAILY_RUN_LIMIT':
    case 'E_DAILY_QUOTE_LIMIT':
    case 'E_DAILY_CORRECTION_LIMIT':
    case 'E_DAILY_REFERENCE_LIMIT':
    case 'E_DAILY_BAKEOFF_LIMIT':
      return { action: phrase(a + 'dailyLimit') };
    case 'E_REQUEST':
      return requestAction(headline, context, hints);
    default:
      return null;
  }
}

function serverError(error: UiRequestError, context: ErrorContext, hints: ErrorHints): UiErrorView {
  const code = error.code ?? null;
  const mapped = code === null ? null : codeAction(code, context, hints, error.headline);
  const headline = hasJargon(error.headline) ? mapped?.headline ?? uiCopy.errors.headline.generic : error.headline;
  const action = mapped ? mapped.action
    : code !== null && !unusableAction(error.action) ? verbatim(error.action)
    : phrase('errors.action.unknown');
  const shownServerAction = action.key === 'errors.verbatim';
  return {
    headline,
    action,
    link: mapped?.link ?? null,
    technical: {
      ...errorPresentation(error).technical,
      context,
      ...(headline === error.headline ? {} : { serverHeadline: error.headline }),
      ...(shownServerAction ? {} : { serverAction: error.action })
    },
    code,
    kind: 'server'
  };
}

const EXTRACTION_HEADLINES: Readonly<Record<string, keyof typeof uiCopy.errors.local>> = {
  E_NO_TEXT_LAYER: 'noTextLayer',
  E_UNSUPPORTED_FORMAT: 'unsupportedFormat',
  E_NO_TEXT: 'noText',
  E_FONT_TEXT_UNREADABLE: 'fontTextUnreadable',
  E_EXTRACTION_WORKER: 'extractionWorker',
  E_EXTRACTION: 'unreadableFile',
  E_EXTRACTION_ARCHIVE: 'unreadableFile',
  E_EXTRACTION_XML: 'unreadableFile',
  E_PDF_OUTLINE: 'unreadableFile',
  // Read, but its upload is larger than the service accepts (core/local/preflight.ts).
  E_UPLOAD_TOO_LARGE: 'tooLargeToSend'
};
const LOCAL_CODE_HEADLINES: Readonly<Record<string, keyof typeof uiCopy.errors.local>> = {
  E_LOCAL_SCAN_CANCELLED: 'cancelled',
  E_LOCAL_GENERATED_TREE_SELECTION: 'outputsChanged'
};
const DOM_HEADLINES: Readonly<Record<string, keyof typeof uiCopy.errors.local>> = {
  NotAllowedError: 'permission',
  SecurityError: 'permission',
  QuotaExceededError: 'storageFull',
  AbortError: 'cancelled',
  NotFoundError: 'notFound'
};
/** Plain sentences core modules throw as `Error` messages; they are shown as they are. */
const PLAIN_MESSAGES: ReadonlySet<string> = new Set([
  uiCopy.invalidBudget, uiCopy.budgetRequired, uiCopy.unlimitedNeedsAcknowledgement, uiCopy.duplicateContent,
  uiCopy.extractionIncomplete, uiCopy.screenProgress.retryUnfinishedFailed,
  uiCopy.screenResults.chooseNewFile, uiCopy.screenResults.saveNeedsBrowser,
  uiCopy.trial.stale, uiCopy.trial.missingCollection
]);
/** A fetch that never reached the server rejects with a TypeError whose message names the fetch or network. */
const NETWORK_MESSAGE = /fetch|network|load failed/i;

function localView(headline: string, action: Phrase | null, code: string | null, technical: Record<string, unknown>,
                   kind: UiErrorView['kind'] = 'local'): UiErrorView {
  return { headline, action, link: null, technical, code, kind };
}

function localError(error: unknown, context: ErrorContext): UiErrorView {
  const name = record(error) && typeof error.name === 'string' ? error.name : null;
  const message = error instanceof Error ? error.message
    : record(error) && typeof error.message === 'string' ? error.message : String(error);
  const ownCode = record(error) && typeof error.code === 'string' ? error.code : null;
  const technical: Record<string, unknown> = { context, ...(name ? { name } : {}), message, ...(ownCode ? { code: ownCode } : {}) };
  const local = uiCopy.errors.local;

  if (ownCode !== null && Object.hasOwn(EXTRACTION_HEADLINES, ownCode))
    return localView(local[EXTRACTION_HEADLINES[ownCode]], null, ownCode, technical);
  const localCode = /^E_LOCAL_[A-Z_]+$/.test(message) ? message : ownCode !== null && /^E_LOCAL_[A-Z_]+$/.test(ownCode) ? ownCode : null;
  if (localCode !== null)
    return Object.hasOwn(LOCAL_CODE_HEADLINES, localCode)
      ? localView(local[LOCAL_CODE_HEADLINES[localCode]], null, localCode, technical)
      : localView(uiCopy.errors.headline.local, phrase('errors.action.localRetry'), localCode, technical);
  if (name !== null && Object.hasOwn(DOM_HEADLINES, name))
    return localView(local[DOM_HEADLINES[name]], null, name, technical);
  if (name === 'TypeError' && NETWORK_MESSAGE.test(message))
    return localView(local.network, null, null, technical, 'network');
  if (error instanceof Error && PLAIN_MESSAGES.has(message)) return localView(message, null, null, technical);
  return localView(uiCopy.errors.headline.local, phrase('errors.action.localRetry'), ownCode, technical);
}

const PREPARATION_PARTS = ['total', 'failed', 'categories'] as const;
const isPhrase = (value: unknown): value is Phrase => record(value) && typeof value.key === 'string' && value.key !== '';

/**
 * Problems the UI itself notices, by their `E_UI_*` code (added by WP-7c): a stored browser value that cannot be read
 * and an answer for another run (WP-5's `StoredValueError` and `WrongRunError`), and the run controllers' errors
 * (core/ui/run-controls.ts). Null for anything else, including an `E_UI_*` code this release does not know (it then
 * reads as the generic local problem, with its code kept).
 */
function uiError(error: unknown, context: ErrorContext): UiErrorView | null {
  if (!record(error) || typeof error.code !== 'string' || !error.code.startsWith('E_UI_')) return null;
  const code = error.code, u = uiCopy.errors.ui;
  const message = error instanceof Error ? error.message : typeof error.message === 'string' ? error.message : '';
  const view = (headline: string, action: Phrase | null, facts: Record<string, unknown> = {}): UiErrorView =>
    localView(headline, action, code, { context, message, ...facts });
  switch (code) {
    case 'E_UI_STORED_VALUE':
      return view(u.storedValue, phrase('errors.ui.storedValueAction'), { key: error.key });
    case 'E_UI_WRONG_RUN':
      return view(error.resource === 'results' ? u.wrongRunResults : u.wrongRun, phrase('errors.action.shape'),
        { resource: error.resource, expected: error.expected, got: error.got });
    case 'E_UI_ELSEWHERE': {
      const work = typeof error.work === 'string' && Object.hasOwn(u.elsewhere, error.work) ? error.work as keyof typeof u.elsewhere : null;
      return work === null ? null : view(u.elsewhere[work], null, { work });
    }
    case 'E_UI_DRAFT_FROZEN':
      return view(u.draftFrozen, null, { runId: error.runId });
    case 'E_UI_OUTPUT_ROOT':
      return view(u.outputRoot, null);
    // The two folders of Make folders overlap: say which way, in plain words (acceptance sweep F1).
    case 'E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS':
      return view(uiCopy.screenBuild.output.insideOriginals, null);
    case 'E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT':
      return view(uiCopy.screenBuild.output.originalsInside, null);
    case 'E_UI_BUILD_INCOMPLETE':
      return typeof error.ready === 'number' && typeof error.total === 'number'
        ? view(uiCopy.screenBuild.incomplete(error.ready, error.total), phrase('screenBuild.resolveProblems'),
          { ready: error.ready, total: error.total }) : null;
    case 'E_UI_CONFIRM_BLOCKED': {
      const reasons = Array.isArray(error.reasons) ? error.reasons.filter(isPhrase) : [];
      return view(u.confirmBlocked, reasons[0] ?? null, { reasons: reasons.map(reason => reason.key) });
    }
    case 'E_UI_PREPARATION_CHANGED': {
      const parts = Array.isArray(error.parts) ? PREPARATION_PARTS.filter(part => (error.parts as unknown[]).includes(part)) : [];
      if (parts.length === 0) return null;
      return view(uiCopy.screenConfirm.changed(parts.map(part => uiCopy.screenConfirm.changedParts[part])), null, { parts });
    }
    case 'E_UI_RETRY_INCOMPLETE':
      return view(u.retryIncomplete, null, { missing: error.missing });
    case 'E_UI_DOCUMENT_REJECTED': {
      // The refusal is the server's own answer: shown as the server rows are, with the document's name in the action.
      const cause = error instanceof Error ? error.cause : undefined;
      const filename = typeof error.filename === 'string' ? error.filename : null;
      if (cause === undefined || filename === null) return null;
      const shown = presentError(cause, context, { filename });
      return { ...shown, technical: { ...shown.technical, filename } };
    }
    case 'E_UI_NOT_STARTED': {
      const cause = error instanceof Error ? error.cause : undefined;
      return view(u.notStarted, null, cause === undefined ? {} : { cause: presentError(cause, context).technical });
    }
    case 'E_UI_NO_LOCAL_TEXT':
      return view(u.noLocalText, null, { remaining: error.remaining });
    case 'E_UI_HINTED': {
      // Shown exactly as its cause, with the facts the cause does not carry (run-controls.ts HintedError).
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause === undefined || !record(error.hints)) return null;
      const hints: ErrorHints = {};
      if (typeof error.hints.sourceRunId === 'string' && error.hints.sourceRunId !== '') hints.sourceRunId = error.hints.sourceRunId;
      if (typeof error.hints.filename === 'string' && error.hints.filename !== '') hints.filename = error.hints.filename;
      return presentError(cause, context, hints);
    }
    default:
      return null;
  }
}

/** The one mapping from anything thrown to what the feedback slot shows. */
export function presentError(error: unknown, context: ErrorContext, hints: ErrorHints = {}): UiErrorView {
  if (error instanceof UiRequestError) return serverError(error, context, hints);
  if (error instanceof UiShapeError)
    return {
      headline: uiCopy.errors.headline.shape,
      action: phrase('errors.action.shape'),
      link: null,
      technical: { context, resource: error.resource, path: error.path, message: error.message },
      code: error.code,
      kind: 'server'
    };
  const ui = uiError(error, context);
  if (ui !== null) return ui;
  return localError(error, context);
}

/**
 * A halted run's recorded cause for the StopCard: the headline verbatim where it is plain, a plain action, and the
 * rest in Details. A run halted by the emergency stop can never be continued (F11).
 */
export function presentStopReason(stop: StopReasonWire): UiErrorView {
  const killed = stop.code === 'E_KILL_SWITCH', copy = uiCopy.errors.stop;
  const headline = hasJargon(stop.headline) ? (killed ? copy.killedHeadline : copy.headline) : stop.headline;
  const action = killed ? phrase('errors.stop.killed')
    : unusableAction(stop.action) ? phrase('errors.stop.generic') : verbatim(stop.action);
  return {
    headline,
    action,
    link: null,
    technical: {
      code: stop.code, kind: stop.kind, details: stop.details,
      ...(headline === stop.headline ? {} : { serverHeadline: stop.headline }),
      ...(action.key === 'errors.verbatim' ? {} : { serverAction: stop.action })
    },
    code: stop.code,
    kind: 'server'
  };
}

export type BlockerClass = 'emergency-stop' | 'sorting-off' | 'categories' | 'sign-in' | 'configuration';
type BlockerKey = keyof typeof uiCopy.errors.blockers;

function blockerKey(code: string, details: unknown): BlockerKey {
  switch (code) {
    case 'E_KILL_SWITCH': return 'emergencyStop';
    case 'E_MODEL_CALLS_DISABLED': return 'sortingOff';
    case 'E_DEFINITIONS_EMPTY': return 'noCategories';
    case 'E_TYPE_FILE': {
      const path = record(details) && typeof details.path === 'string' ? details.path : null;
      return path === 'typeFile.' || path === 'typeFile.types' ? 'noCategories' : 'categoriesInvalid';
    }
    case 'E_VOCABULARY_COLLISION': return 'categoriesInvalid';
    case 'E_DEFINITIONS_STORAGE': return 'categoriesUnreadable';
    case 'E_ACCESS_CONFIGURATION':
    case 'E_ACCESS_REQUIRED': return 'signIn';
    case 'E_PRICING_UNVERIFIED': return 'prices';
    case 'E_VENDOR_KEY': return 'serviceKey';
    case 'E_STORAGE_D1':
    case 'E_STORAGE_R2': return 'storage';
    case 'E_PROJECT_BINDING':
    case 'E_PROJECT_CONFIG':
    case 'E_PROJECT_COPY':
    case 'E_MODEL_POLICY': return 'settings';
    case 'E_WORKFLOW_BINDING': return 'service';
    case 'E_EDITORS_MISSING': return 'editorsMissing';
    case 'E_EDITORS_EMAIL': return 'editorsEmail';
    case 'E_TRUSTED_USERS_INVALID': return 'trustedUsersInvalid';
    default: return 'other';
  }
}

const CLASS_OF: Readonly<Record<BlockerKey, BlockerClass>> = {
  emergencyStop: 'emergency-stop', sortingOff: 'sorting-off', noCategories: 'categories',
  categoriesInvalid: 'categories', categoriesUnreadable: 'categories', signIn: 'sign-in', prices: 'configuration',
  serviceKey: 'configuration', storage: 'configuration', settings: 'configuration', service: 'configuration',
  editorsMissing: 'configuration', editorsEmail: 'configuration', trustedUsersInvalid: 'configuration', other: 'configuration'
};

/** A health blocker meaning no usable categories are active: none yet, an empty category file, or unreadable. */
export function meansNoCategories(code: string, details?: unknown): boolean {
  const key = blockerKey(code, details);
  return key === 'noCategories' || key === 'categoriesUnreadable';
}

/** Which kind of setup problem a health blocker is (the journey's "setup blocked" narration, System grouping). */
export function blockerClass(code: string, details?: unknown): BlockerClass {
  return CLASS_OF[blockerKey(code, details)];
}

export interface BlockerLine {
  code: string;
  class: BlockerClass;
  /** The plain line (resolved default copy). */
  headline: string;
  /** Who can act. */
  action: Phrase;
  link: UiErrorView['link'];
}

/** One plain line per health blocker, naming who can act (SPEC §3a step 1). Codes and paths stay in Details. */
export function blockerLine(code: string, details?: unknown): BlockerLine {
  const key = blockerKey(code, details);
  return {
    code,
    class: CLASS_OF[key],
    headline: uiCopy.errors.blockers[key].headline,
    action: phrase(`errors.blockers.${key}.action`),
    link: key === 'emergencyStop' ? LINKS.system() : null
  };
}
