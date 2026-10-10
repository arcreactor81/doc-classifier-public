import { selectReaderModel, readerModelIdentity } from '../../core/config/model-choice.ts';
import { utcUsageDay } from '../../core/config/usage-limits.ts';
import { usageCopy } from '../../core/ui/copy-usage.ts';
import { readPilot, readPilotVerdict, readPilotConfirmation } from '../../core/ui/trial-wire.ts';
/**
 * A stateful fake backend for the UI flow scripts (SPEC §10.2 Harness, WP-11a).
 *
 * It answers R1–R26, S1, S3, S4, S6, `/plan` and carry the way `core/server/api.ts` does, with the S-route
 * contracts of SPEC §9, and it records every request as `{method, path, query, body, status, …}` for assertions.
 *
 * Fidelity comes from reuse, not imitation: outcomes come from the real `decide()` (core/domain/decision.ts);
 * the S1 status projection, its version and the `unchanged` answer from `core/domain/run-status.ts`;
 * corrections, proposals, answers and comparisons from the real `core/correction/*` modules; request shapes from
 * `core/server/contracts.ts`; error envelopes from `core/server/errors.ts`; budgets from `core/cost/run-budget.ts`;
 * category and threshold rules from `core/config/*`. With `strictWire` (the default) every 2xx body is also read
 * through the matching `core/ui/wire.ts` guard before it is sent, and every error body through
 * `parseRequestFailure`, so the fake cannot drift from the types the UI codes against: a drift is answered as a
 * 500 `E_FAKE_SHAPE` and listed in `fake.problems`. Injected responses (`respondNext`) are never checked, so a
 * script can send deliberately malformed bodies.
 *
 * Nothing here calls a vendor or Cloudflare. Vendor outputs are synthetic (placeholder rationales, quotes taken
 * from the document's own text) and chosen so that `decide()` gives the planned rule. Content is placeholder only
 * (AGENTS §4).
 *
 * Deliberate simplifications (fake-only):
 * - One process-wide actor per fake (`state.actor`); other actors exist only as owners of runs made by builders.
 * - Closure completes at once (no `closing` wait). Every new run is Interactive; a halted run stays halted.
 * - Documents a builder seeds (not uploaded by the page) have no stored body: re-uploading one is refused as
 *   "already exists with different content", exactly as a changed body would be. A UI that re-sends a document
 *   the server already holds is a bug (SPEC §4.7), so this is strict on purpose.
 * - Document progress moves only when a script calls `advance()` / `finish()`, or when `autoAdvance` is set.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pageBudget, legacyBudget } from '../../core/server/results.ts';
import { decide } from '../../core/domain/decision.ts';
import { diffCorrection } from '../../core/correction/diff.ts';
import { proposeCorrections } from '../../core/correction/proposals.ts';
import { carryTrialChecks } from '../../core/correction/carry.ts';
import { buildReference } from '../../core/correction/reference.ts';
import { compareReference } from '../../core/correction/comparison.ts';
import { modelFamily, requireProject, validateProject } from '../../core/config/project.ts';
import { listedVersion } from '../../core/vendors/model-list.ts';
import { FAKE_DEEPSEEK_MODEL_LIST } from '../../core/vendors/fake-vendors.ts';
import { readerCapacity, confidenceCapacity, capacityRefusal } from '../../core/config/capacity.ts';
import { readerPromptVersion } from '../../core/vendors/requests.ts';
import { frozenRunPolicies, PILOT_SKIPPED_NOTE } from '../../core/server/run-status-read.ts';
import {
  appliedThresholdStatus, definitionChange, definitionThreshold, validateDisplayNames
} from '../../core/config/definitions.ts';
import { authorizeRunBudget, readRunBudget, checkRunBudget } from '../../core/cost/run-budget.ts';
import { buildConfidenceState } from '../../core/digest/confidence-state.ts';
import {
  canonicalJson, projectRunStatus, publicBudget, requestedVersion, runStatusResponse, statusVersion
} from '../../core/domain/run-status.ts';
import { activeProviderWaits } from '../../core/ui/provider-wait.ts';
import { uiCopy } from '../../core/ui/copy.ts';
import { parseRequestFailure } from '../../core/ui/request-error.ts';
import { ServerFailure, failure, failureResponse, serverCopy } from '../../core/server/errors.ts';
import { dailyRecordAllowance } from '../../core/server/daily-allowance.ts';
import {
  exact, exactWithOptional, identity, object, parseUpload, requireValue, validateManifestReady
} from '../../core/server/contracts.ts';
import { UPLOAD_BODY_LIMIT_BYTES } from '../../core/domain/upload-limit.ts';
import { extractorMixPlan } from '../../core/server/extractor-mix.ts';
import { dispatchRunDocuments } from '../../core/server/start-dispatch.ts';
import { EXTRACTOR_VERSION } from '../../core/extraction/extract.ts';
import * as wire from '../../core/ui/wire.ts';
import { corpus, syntheticFile } from './opfs.mjs';

/**
 * @typedef {import('../../core/domain/run-status-types.ts').RunStatusInput} RunStatusInput
 * @typedef {import('../../core/domain/run-status-types.ts').RunStatusProjection} RunStatusProjection
 * @typedef {import('../../core/domain/run-status-types.ts').RunStatusResponse} RunStatusResponse
 * @typedef {import('../../core/ui/wire.ts').RunSummaryView} RunSummaryView
 * @typedef {import('../../core/ui/wire.ts').PlanWire} PlanWire
 * @typedef {import('../../core/ui/wire.ts').ResultsFileView} ResultsFileView
 * @typedef {import('../../core/ui/wire.ts').EvidenceView} EvidenceView
 * @typedef {import('../../core/ui/wire.ts').HealthWire} HealthWire
 * @typedef {import('../../core/ui/wire.ts').DefinitionsView} DefinitionsView
 * @typedef {import('../../core/ui/wire.ts').ComparisonView} ComparisonView
 * @typedef {import('../../core/ui/wire.ts').ReferenceRecordWire} ReferenceRecordWire
 * @typedef {import('../../core/config/project.ts').ProjectPack} ProjectPack
 * @typedef {import('../../core/config/project.ts').TypeFile} TypeFile
 * @typedef {{ method: string, url: string, headers?: Record<string, string | string[] | undefined>,
 *   body?: Uint8Array | string, origin?: string, isConnected?: () => boolean }} FakeRequest
 * @typedef {{ status: number, headers: Record<string, string>, body: string, value?: unknown,
 *   network?: 'reset', dropped?: boolean }} FakeResponse
 */

const REPO = new URL('../../', import.meta.url);

/** Placeholder identities (AGENTS §4). Details-only strings in the UI. */
export const PLACEHOLDER_ACTOR = 'cloudflare:placeholder-account:placeholder-person';
export const OTHER_ACTOR = 'cloudflare:placeholder-account:another-person';
export const PLACEHOLDER_BUILD = 'harness0000000000000000000000000000000001';

/** The spec's neutral category names (SPEC header: Procedures, Explainers, Reports, Forms, Training). */
export const PLACEHOLDER_CATEGORIES = Object.freeze({
  procedures: {
    id: 'procedures', name: 'Procedures',
    what: 'Step-by-step instructions that tell a reader how to carry out a task.',
    not_for: 'Material that mainly explains a topic without steps to follow; that belongs in Explainers.',
    examples: ['A checklist for booking a meeting room', 'Instructions for returning equipment']
  },
  explainers: {
    id: 'explainers', name: 'Explainers',
    what: 'Material that explains a topic so a reader understands it, such as teaching slides.',
    not_for: 'Instructions a reader follows step by step; those belong in Procedures.',
    examples: ['Slides that explain how requests are handled', 'A short guide to the reasons behind a rule']
  },
  reports: {
    id: 'reports', name: 'Reports',
    what: 'Accounts of what happened or what was found over a period.',
    not_for: 'Forward-looking instructions; those belong in Procedures.',
    examples: ['A quarterly look back at requests', 'Findings from a review']
  },
  forms: {
    id: 'forms', name: 'Forms',
    what: 'Blank or filled forms that collect information from a person.',
    not_for: 'Reports that describe results; those belong in Reports.',
    examples: ['A request form', 'A signed approval sheet']
  },
  training: {
    id: 'training', name: 'Training',
    what: 'Course material prepared for a training session.',
    not_for: 'General explanations not tied to a session; those belong in Explainers.',
    examples: ['Handouts for a workshop', 'Exercises for new colleagues']
  }
});

/** Structural words the seed pack reserves, so the editor's vocabulary rule has something to catch. */
export const PLACEHOLDER_VOCABULARY = Object.freeze(['Introduction', 'Contents', 'Appendix']);

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const iso = ms => new Date(ms).toISOString();
const sha = text => createHash('sha256').update(text).digest('hex');
const typeVersionOf = typeFile => sha(JSON.stringify(typeFile));
const NULL_COUNTS = Object.freeze({ readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null });
const ZERO_COUNTS = Object.freeze({ readerInputTokens: 0, confidenceInputTokens: 0, recoveryInputTokens: 0 });
/** The parser versions the page records (the dependency pins in package.json). */
const PARSER_VERSIONS = Object.freeze({ zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' });
const PIPELINE = ['waiting_to_start', 'starting', 'finding_headings', 'preparing_text', 'confidence_check', 'reader',
  'deciding', 'done'];
const RUNTIME_RESET_MESSAGES = new Set(['Durable Object reset because its code was updated.',
  'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.']);

/** The generic Git pack with the placeholder vocabulary: the seed every fake starts from. */
export function seedProject(overrides = {}) {
  const pack = JSON.parse(readFileSync(new URL('projects/generic/project.json', REPO), 'utf8'));
  pack.structuralVocabulary = [...PLACEHOLDER_VOCABULARY];
  return { ...pack, ...clone(overrides), settings: { ...pack.settings, ...clone(overrides.settings ?? {}) } };
}

/** A type file made of placeholder categories (default Procedures and Explainers). */
export function placeholderTypeFile(ids = ['procedures', 'explainers'], noneOfThese) {
  return {
    types: ids.map(id => {
      const type = PLACEHOLDER_CATEGORIES[id];
      if (!type) throw new Error(`No placeholder category "${id}". Use one of ${Object.keys(PLACEHOLDER_CATEGORIES).join(', ')}.`);
      return clone(type);
    }),
    none_of_these: noneOfThese ?? { name: 'None of these', what: 'The document does not fit any defined type.' }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// S1 projection (SPEC §9): the server's own pure module, reused so the fake cannot drift from it. The fake only
// assembles the input (`statusInput`, the counterpart of core/server/run-status-read.ts). Re-exported for scripts.
// ---------------------------------------------------------------------------------------------------------------

export { canonicalJson, projectRunStatus, statusVersion };

// ---------------------------------------------------------------------------------------------------------------
// Clock, matching and transport helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * Real time by default. `set(ms)` freezes it at an instant; `start(ms)` lets it run on from an instant (as
 * Playwright's `page.clock.install({time})` does); `advance(ms)` jumps forward either way; `useRealTime` resumes.
 */
export function createClock(now) {
  let fixed = null, offset = 0;
  const base = now ?? (() => Date.now());
  return {
    now: () => (fixed ?? base()) + offset,
    set(ms) { fixed = ms; offset = 0; },
    start(ms) { fixed = null; offset = ms - base(); },
    advance(ms) { offset += ms; },
    useRealTime() { fixed = null; offset = 0; }
  };
}

/**
 * A request matcher: a function `(record) => boolean`, or `{method?, path?}` where `path` is an exact string, a
 * RegExp, or a pattern with `*` for one path segment (e.g. '/api/runs/*\/documents').
 */
function matcher(match) {
  if (typeof match === 'function') return match;
  const method = match.method?.toUpperCase();
  let test = () => true;
  if (typeof match.path === 'string') {
    if (match.path.includes('*')) {
      const re = new RegExp(`^${match.path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
      test = path => re.test(path);
    } else test = path => path === match.path;
  } else if (match.path instanceof RegExp) test = path => match.path.test(path);
  return record => (!method || record.method === method) && test(record.path);
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const ok = (value, status = 200) => ({ status, headers: { ...JSON_HEADERS }, value });

function envelope(issue) {
  return { status: issue.status, headers: { ...JSON_HEADERS }, value: failureResponse(issue) };
}

/** An error response built from the server's own envelope, for `respondNext` / `failNext`. */
export function errorResponse(code, headline, { kind, status, details } = {}) {
  const resolvedKind = kind ?? (status && status < 409 ? 'request' : 'blocker');
  const issue = new ServerFailure(code, resolvedKind, headline, status ?? (resolvedKind === 'request' ? 400 : 409));
  const value = failureResponse(issue);
  if (details) Object.assign(value.error.details, details);
  return { status: issue.status, value };
}

// ---------------------------------------------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------------------------------------------

/**
 * Default outcome planner for runs the page creates: readable documents cycle through filed (first category),
 * systems disagree, filed (second category), low certainty. Unreadable documents are failures at upload anyway.
 * A planner returns a plan token: 'R1', 'R1:<typeId>', 'R2', 'R2:<typeId>', 'R3', 'R4', 'R5', 'R0' or 'R0n',
 * optionally with '@<certainty>' (e.g. 'R1:explainers@0.91') to set the certainty check's number; the token is
 * refused at planning time if the real rules would give a different outcome.
 */
export const defaultPlanner = (_doc, index, typeIds) =>
  ['R1:' + typeIds[0], 'R5', 'R1:' + (typeIds[1] ?? typeIds[0]), 'R2'][index % 4];

export function createFakeApi(options = {}) {
  return new FakeApi(options);
}

export class FakeApi {
  /**
   * @param {{ now?: () => number, strictWire?: boolean, seed?: object, actor?: string, build?: string }} [options]
   */
  constructor(options = {}) {
    this.options = options;
    this.clock = createClock(options.now);
    this.strictWire = options.strictWire ?? true;
    /** Every request, in arrival order. */
    this.requests = [];
    /** Shape drifts the strict check caught (should stay empty). */
    this.problems = [];
    /** Causes of 500 E_INTERNAL answers (the envelope hides them, as the server does): for debugging scripts. */
    this.internalErrors = [];
    this.injections = [];
    this.holds = [];
    this.autoAdvance = null;
    this.seq = 0;
    this.reset();
  }

  // -------------------------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------------------------

  /** An empty website-managed workspace: no categories, no runs, the viewer is a category editor. */
  reset() {
    const seed = this.options.seed ? clone(this.options.seed) : seedProject();
    this.state = {
      actor: this.options.actor ?? PLACEHOLDER_ACTOR,
      build: this.options.build ?? PLACEHOLDER_BUILD,
      /** 'runtime' = categories managed on the website; 'git' = categories from the pack. */
      definitionMode: 'runtime',
      editor: true,
      modelCallsEnabled: true,
      /** Extra Health blockers: `{code, headline, details?}`. */
      extraBlockers: [],
      /** Readers this fake site cannot use, by option id, with the blocker code Health reports (DECISIONS 136). */
      unavailableReaders: {},
      /**
       * DeepSeek's model list as this fake reads it at a DeepSeek run's first /start (core/server/reader-version.ts):
       * 'listed' answers with the documented list, 'unavailable' as a 503 does. `modelListReads` counts the reads.
       */
      deepseekModelList: 'listed',
      modelListReads: 0,
      seed,
      revisions: new Map(),
      activations: [],
      active: { revisionId: null, threshold: 0.9, status: 'untested', justification: 'initial_design_threshold' },
      controls: { kill: false, threshold: 0.9, justification: 'initial_design_threshold' },
      thresholdHistory: [],
      quotes: new Map(),
      runs: new Map(),
      corrections: new Map(),
      references: new Map(),
      links: new Map(),
      globalEvents: [],
      lastVendorCall: null,
      planner: defaultPlanner,
      /** Per-document charges, nanodollars. */
      costs: { typesafe: 500_000n, openai: 3_500_000n },
      /** `(run, fingerprint) => boolean`: make /start fail for that document (see `failStart`). */
      failStartFor: null,
      /**
       * S5 Health `threshold.basis`: on, as core/server/health.ts always sends it. A script may turn it off to check
       * that the UI still works without it (the wire guard reads it as null).
       */
      thresholdBasis: true,
      concurrency: 10
    };
    return this;
  }

  get actor() { return this.state.actor; }
  now() { return this.clock.now(); }

  /** Replaces the outcome planner for runs the page creates (see `defaultPlanner`). An array cycles. */
  setOutcomes(planner) {
    this.state.planner = Array.isArray(planner) ? (_doc, index) => planner[index % planner.length] : planner;
    return this;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Answers one request. The transport (Vite middleware, `app.mjs`) supplies the raw body and the app origin.
   * @param {FakeRequest} request
   * @returns {Promise<FakeResponse>}
   */
  async handle(request) {
    const url = new URL(request.url, 'http://fake.invalid');
    const headers = Object.fromEntries(Object.entries(request.headers ?? {})
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]));
    const bytes = typeof request.body === 'string' ? new TextEncoder().encode(request.body) : request.body ?? new Uint8Array();
    const record = {
      seq: ++this.seq, at: this.now(), method: (request.method ?? 'GET').toUpperCase(), path: url.pathname,
      query: Object.fromEntries(url.searchParams), body: recordBody(bytes, headers), status: null
    };
    this.requests.push(record);

    const hold = this.holds.find(item => item.active && item.test(record) && item.skip-- <= 0);
    if (hold) {
      record.held = true;
      hold.waiting.push(record);
      await hold.promise;
      if (request.isConnected && !request.isConnected()) {
        record.dropped = true;
        return { status: 499, headers: {}, body: '', dropped: true };
      }
    }

    const injection = this.injections.find(item => item.test(record) && item.times > 0 && item.skip-- <= 0);
    if (injection) {
      injection.times--;
      record.injected = true;
      if (injection.network) {
        record.status = 0;
        record.network = injection.network;
        return { status: 0, headers: {}, body: '', network: injection.network };
      }
      const value = injection.response.value;
      record.status = injection.response.status;
      record.response = value;
      return { status: injection.response.status, headers: { ...JSON_HEADERS, ...(injection.response.headers ?? {}) },
        body: typeof value === 'string' ? value : JSON.stringify(value), value };
    }

    let result;
    try {
      result = await this.#route(record, url, headers, bytes, request.origin);
    } catch (error) {
      const issue = failure(error);
      if (issue.code === 'E_INTERNAL')
        this.internalErrors.push({ seq: record.seq, path: record.path, message: issue.message, stack: error?.stack ?? null });
      result = envelope(issue);
    }
    if (this.strictWire) result = this.#checkShape(record, result);
    record.status = result.status;
    record.response = result.value;
    const body = result.text ?? JSON.stringify(result.value);
    return { status: result.status, headers: result.headers, body, value: result.value };
  }

  /**
   * Holds matching requests (they wait, unanswered and unprocessed) until `release()`. If the page has gone by
   * then (reload, closed tab), the held request is dropped unprocessed, as if it never reached the server.
   * `{skip: n}` lets the first n matching requests through.
   */
  hold(match, { skip = 0 } = {}) {
    let release;
    const item = { test: matcher(match), active: true, skip, waiting: [], promise: new Promise(resolve => (release = resolve)) };
    item.release = () => { item.active = false; release(); };
    this.holds.push(item);
    return { release: item.release, get waiting() { return item.waiting.length; }, requests: item.waiting };
  }

  /** Holds uploads after the first `n` accepted ones: the way to stall a send at "13 of 114" from the page. */
  holdUploadsAfter(n) {
    return this.hold({ method: 'POST', path: '/api/runs/*/documents' }, { skip: n });
  }

  /** The next matching request (after `skip` matches) gets this response instead of the real one. Never checked. */
  respondNext(match, response, { times = 1, skip = 0 } = {}) {
    this.injections.push({ test: matcher(match), response, times, skip });
    return this;
  }

  /** The next matching request fails with the server's error envelope, e.g. `failNext(m, 'E_INTERNAL', '…', {status: 500})`. */
  failNext(match, code, headline, options = {}) {
    return this.respondNext(match, errorResponse(code, headline, options), options);
  }

  /**
   * The next matching request loses its connection (the Vite transport destroys the socket). Prefer
   * `app.failNetworkOnce()` for POSTs: Chromium may resend a request whose reused connection resets.
   */
  dropNext(match, { times = 1, skip = 0 } = {}) {
    this.injections.push({ test: matcher(match), network: 'reset', times, skip });
    return this;
  }

  /** Recorded requests matching `match` (see `matcher`). */
  requestsTo(match) {
    const test = matcher(match);
    return this.requests.filter(test);
  }

  clearRequests() {
    this.requests.length = 0;
    return this;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Routing (mirrors core/server/api.ts handleRequest)
  // -------------------------------------------------------------------------------------------------------------

  async #route(record, url, headers, bytes, origin) {
    const { method, path } = record;
    const body = () => jsonBody(headers, bytes);
    record.route = routeName(method, path);
    if (!path.startsWith('/api/')) throw new ServerFailure('E_ROUTE', 'request', 'This API route does not exist.', 404);
    if (method !== 'GET' && method !== 'HEAD' && headers.origin && origin && headers.origin !== origin)
      throw new ServerFailure('E_ORIGIN', 'request', 'The request must come from this application.', 403);

    if (path === '/api/health' && method === 'GET') return ok(this.#health());
    if (path === '/api/project' && method === 'GET') return ok(this.#effectivePack(url.searchParams.get('selectedReaderModel') ?? undefined));
    if (path === '/api/usage' && method === 'GET') return ok(this.#usage());
    if (path === '/api/definitions' && method === 'GET') return ok(this.#definitionState());
    if (path === '/api/definitions/drafts' && method === 'POST') return ok(this.#createDraft(body()), 201);
    const activation = /^\/api\/definitions\/([^/]+)\/activate$/.exec(path);
    if (activation && method === 'POST') return ok(this.#activate(decodeURIComponent(activation[1]), body()));
    const feedbackRead = /^\/api\/feedback\/([^/]+)$/.exec(path);
    if (feedbackRead && method === 'GET') return ok(this.#readReference(decodeURIComponent(feedbackRead[1])));
    const feedbackCarry = /^\/api\/feedback\/([^/]+)\/carry$/.exec(path);
    if (feedbackCarry && method === 'POST') {
      const raw = body();
      requireValue(object(raw), 'Confirm carrying these labels.');
      exact(raw, []);
      requireValue(this.state.definitionMode === 'runtime', 'Carrying labels needs website category editing.');
      return ok(this.#carry(decodeURIComponent(feedbackCarry[1])), 201);
    }
    if (path === '/api/quote' && method === 'POST') return ok(this.#quote(body()));
    if (path === '/api/runs' && method === 'POST') return this.#createRun(body());
    if (path === '/api/runs' && method === 'GET') return ok({ runs: this.#runList() });
    if (path === '/api/kill' && method === 'POST') {
      const raw = body();
      requireValue(object(raw), 'An explicit switch state is required.');
      exact(raw, ['enabled']);
      requireValue(typeof raw.enabled === 'boolean', 'An explicit switch state is required.');
      // DECISIONS 140: only a listed category editor may stop all runs or allow them again (core/server/emergency-stop.ts).
      this.#requireEditor();
      this.#setKill(raw.enabled);
      return ok({ enabled: raw.enabled });
    }
    const match = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) throw new ServerFailure('E_ROUTE', 'request', 'This API route does not exist.', 404);
    const run = this.#authorizeRun(decodeURIComponent(match[1]));
    const action = match[2];
    if (!action && method === 'GET') {
      this.#autoAdvance(run);
      return ok(this.#snapshot(run, url.searchParams.get('events') !== '0'));
    }
    if (action === 'status' && method === 'GET') {
      this.#autoAdvance(run);
      return ok(this.#status(run, url.searchParams.get('version')));
    }
    if (action === 'observe-runtime' && method === 'POST') {
      const raw = body(); requireValue(object(raw), 'An empty observation request is required.'); exact(raw, []);
      const pending = run.status === 'running' ? run.runtimeWait : null;
      if (!pending || Date.parse(pending.nextCheckAt) > this.now()) return ok({ checked: 0, failed: 0 });
      // UI fixture only: model an observation of recorded facts, never dispatch or advance a document.
      const checked = Math.min(10, pending.pendingCount), failed = run.runtimeObservationOutcome === 'failed' ? checked : 0;
      if (run.runtimeObservationOutcome === 'reentered') run.runtimeWait = null;
      else run.runtimeWait = { ...pending,
        nextCheckAt: iso(Math.min(this.now() + 30_000, Date.parse(pending.deadlineAt))),
        observationError: failed ? { code: 'E_RUNTIME_OBSERVATION', message: 'The recorded work could not be checked.', at: iso(this.now()) } : null };
      return ok({ checked, failed });
    }
    const evidence = /^documents\/([^/]+)\/evidence$/.exec(action ?? '');
    if (evidence && method === 'GET') return ok(this.#evidence(run, decodeURIComponent(evidence[1])));
    if (action === 'pilot' && method === 'GET') return ok(this.#pilotView(run));
    if (action === 'pilot-review' && method === 'POST') {
      const raw=body();requireValue(object(raw),'A verdict on one filed document is required.');exact(raw,['fingerprint','verdict']);
      requireValue(typeof raw.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(raw.fingerprint),'Name the document the verdict is for.');
      requireValue(raw.verdict==='right'||raw.verdict==='wrong','Mark the document right or wrong.');
      const view=this.#pilotView(run);
      if(view.confirmation)throw new ServerFailure('E_PILOT_CONFIRMED','request','This pilot has already been confirmed; its review is closed.',409);
      const document=view.filed.find(d=>d.fingerprint===raw.fingerprint);
      if(!document)throw new ServerFailure('E_PILOT_REVIEW','request','This document was not filed by the pilot, so it needs no verdict.',409);
      const saved={id:randomUUID(),fingerprint:raw.fingerprint,tag:document.tag,verdict:raw.verdict,createdAt:iso(this.now())};
      run.pilotReviews.push(saved);this.#event(run,raw.fingerprint,'pilot','reviewed',{verdict:raw.verdict});return ok(saved,201);
    }
    if (action === 'pilot-confirmation' && method === 'POST') {
      const raw=body();requireValue(object(raw),'Confirm the pilot with an empty request.');exact(raw,[]);
      const view=this.#pilotView(run);
      if(view.counts.wrong)throw new ServerFailure('E_PILOT_MISFILED','request','One or more filed documents were marked wrong. Change the categories in the editor, activate them, and run a new pilot.',409);
      if(view.counts.reviewed!==view.counts.filed)throw new ServerFailure('E_PILOT_INCOMPLETE','request','Every filed document must be reviewed before you confirm.',409);
      if(!view.categoryVersion.matches)throw new ServerFailure('E_PILOT_STALE','request',serverCopy.pilotStale,409);
      if(!run.pilotConfirmation){run.pilotConfirmation={id:randomUUID(),createdAt:iso(this.now()),confirmedBy:this.state.actor,filedCount:view.counts.filed};
        run.pilotConfirmedVersion=view.categoryVersion.frozen;this.#event(run,null,'pilot','confirmed',{});}
      return ok(run.pilotConfirmation);
    }
    if (action === 'documents' && method === 'POST') return this.#upload(run, bytes, body());
    // Run continuation (R14 recovery-status, R15 recovery, R16 recover) was removed: those paths are unknown routes.
    if (action === 'start' && method === 'POST') return ok(await this.#start(run));
    if (action === 'close' && method === 'POST') {
      if (['uploading', 'running', 'halted'].includes(run.status)) {
        const raw = readOptionalJson(bytes);
        if (!(object(raw) && Object.keys(raw).length === 1 && raw.discardUnfinished === true))
          throw new ServerFailure('E_CLOSE_UNFINISHED', 'blocker',
            'This run hasn’t finished. Closing it now discards it: it will never have a results file.');
      }
      if (run.closeRemaining > 0) {
        run.status = 'closing';
        run.textHeld = true;
        run.closeRemaining = Math.max(0, run.closeRemaining - (run.closePageSize ?? 300));
        if (run.closeRemaining > 0) return ok({ closed: false, remaining: run.closeRemaining });
      }
      this.#close(run);
      return ok({ closed: true });
    }
    if (action === 'results/compact' && method === 'GET') {
      const full = this.#manifest(run);
      return ok({ ...full, resultsVersion: 2, entries: full.entries.map((entry, index) => {
        const { reader, vendorOutputs, ...rest } = entry;
        const failed = entry.rule === 'R0';
        return { ...rest, ordinal: index + 1, confidenceCheck: failed ? null : entry.confidenceCheck,
          readerYes: failed || reader === null ? null : reader.filter(v => v.isType).map(v => v.typeId) };
      }) });
    }
    if (action === 'results/pages' && method === 'GET') {
      const afterRaw = url.searchParams.get('after') ?? '0', limitRaw = url.searchParams.get('limit');
      requireValue(/^(0|[1-9][0-9]*)$/.test(afterRaw) && Number.isSafeInteger(Number(afterRaw)), 'Invalid results cursor.');
      requireValue(limitRaw === null || /^[1-9][0-9]*$/.test(limitRaw) && Number.isSafeInteger(Number(limitRaw)), 'Invalid page size.');
      const cap = pageBudget(run.pack.typeFile.types.length);
      const limit = Math.min(cap, Number(limitRaw ?? run.resultsPageLimit ?? cap));
      const all = this.#manifest(run).entries;
      const entries = all.map((entry, index) => ({ ...entry, ordinal: index + 1 })).filter(entry => entry.ordinal > Number(afterRaw)).slice(0, limit);
      const last = entries.at(-1)?.ordinal ?? 0;
      return ok({ runId: run.id, resultsVersion: 2, entries,...(run.notes.includes('N_FAKE_VENDORS')?{vendors:'fake'}:{}),
        ...pilotChoiceOf(run), ...variantHeadersOf(run), next: last > 0 && last < all.length ? last : null });
    }
    if (action === 'results' && method === 'GET') {
      if (run.expectedCount > legacyBudget(run.pack.typeFile.types.length))
        throw new ServerFailure('E_RESULTS_TOO_LARGE', 'request', 'This run needs paged results.', 413);
      return ok(this.#manifest(run));
    }
    if (action === 'plan' && method === 'GET') return ok(this.#plan(run));
    if (action === 'manifest' && method === 'GET') {
      const value = this.#manifest(run);
      return { status: 200, value, text: JSON.stringify(value, null, 2), headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${run.id}-manifest.json"`
      } };
    }
    if (action === 'corrections' && method === 'GET') return ok({
      corrections: [...this.state.corrections.values()].filter(c => c.runId === run.id)
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .map(c => ({ id: c.id, createdAt: iso(c.createdAt) }))
    });
    if (action === 'corrections' && method === 'POST') return ok(this.#saveCorrection(run, body()));
    const savedCorrection = /^corrections\/([^/]+)$/.exec(action ?? '');
    if (savedCorrection && method === 'GET') return ok(this.#readCorrection(run, decodeURIComponent(savedCorrection[1])));
    const referenceSave = /^corrections\/([^/]+)\/reference$/.exec(action ?? '');
    if (referenceSave && method === 'POST')
      return ok(this.#saveReference(run, decodeURIComponent(referenceSave[1]), body()), 201);
    if (action === 'comparison' && method === 'GET') return ok(this.#comparison(run));
    const apply = /^corrections\/([^/]+)\/apply$/.exec(action ?? '');
    if (apply && method === 'POST') return ok(this.#apply(run, decodeURIComponent(apply[1]), body));
    throw new ServerFailure('E_ROUTE', 'request', 'This API route does not exist.', 404);
  }

  #checkShape(record, result) {
    const status = result.status;
    try {
      if (status >= 200 && status < 300) {
        const guard = GUARDS[record.route];
        if (guard) guard(result.value);
      } else {
        const parsed = parseRequestFailure(status, JSON.stringify(result.value));
        if (!parsed.code) throw new Error('The error body is not the server envelope.');
      }
      return result;
    } catch (error) {
      const problem = { seq: record.seq, method: record.method, path: record.path, route: record.route, status,
        message: error instanceof Error ? error.message : String(error) };
      this.problems.push(problem);
      return envelope(new ServerFailure('E_FAKE_SHAPE', 'blocker',
        `The fake API built a response that core/ui/wire.ts rejects: ${problem.message}`, 500));
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Health, project and categories (R1–R5)
  // -------------------------------------------------------------------------------------------------------------

  #effectivePack(selectedReaderModel) {
    const s = this.state;
    const choose = pack => {
      try { return selectReaderModel(pack, selectedReaderModel ?? pack.readerModels?.defaultId); }
      catch (error) { if (error.code === 'E_READER_MODEL') throw new ServerFailure(error.code, 'request', error.message); throw error; }
    };
    if (s.definitionMode !== 'runtime') return choose(requireProject(clone(s.seed)));
    const revision = s.active.revisionId ? s.revisions.get(s.active.revisionId) : null;
    if (!revision) throw new ServerFailure('E_DEFINITIONS_EMPTY', 'blocker',
      'Create and activate your categories before starting a run.');
    return choose(requireProject({
      ...clone(s.seed),
      typeFile: clone(revision.typeFile),
      definitionRevisionId: revision.id,
      displayNames: clone(revision.displayNames),
      definitionThreshold: s.active.threshold,
      definitionThresholdStatus: s.active.status,
      definitionThresholdJustification: s.active.justification
    }));
  }

  /** Explicitly unmeasured fixture data; this fake has no real provider allowance or usage ledger. */
  #usage() {
    const limits = this.state.seed.settings.usageLimits;
    if (!limits) return { enabled: false };
    const date = utcUsageDay(this.now()), today = at => iso(at).slice(0, 10) === date.day;
    return { enabled: true, resetsAt: date.resetsAt, maxDocumentsPerRun: limits.maxDocumentsPerRun,
      maxRunsPerActorPerDay: limits.maxRunsPerActorPerDay,
      actorRunsToday: [...this.state.runs.values()].filter(run => run.actor === this.state.actor && iso(run.createdAt).slice(0,10) === date.day).length,
      actorExempt: this.state.editor,
      // The three daily allowances, counted for this person today as the service counts them (core/server/daily-allowance.ts).
      actorQuotesToday: [...this.state.quotes.values()].filter(quote => quote.actor === this.state.actor && today(quote.createdAt)).length,
      maxQuotesPerActorPerDay: dailyRecordAllowance(limits),
      actorCorrectionsToday: [...this.state.corrections.values()].filter(saved => saved.actor === this.state.actor && today(saved.createdAt)).length,
      maxCorrectionsPerActorPerDay: dailyRecordAllowance(limits),
      actorReferencesToday: [...this.state.references.values()].filter(saved => saved.confirmedBy === this.state.actor && today(saved.createdAt)).length,
      maxReferencesPerActorPerDay: dailyRecordAllowance(limits),
      pools: [...limits.openaiTokenPools.map(pool => ({ id: pool.id, unit: 'tokens', limitUnits: pool.limitTokens, usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false })),
        { id: 'typesafe', unit: 'nanodollars', limitUnits: Number(limits.typesafeDailyNano), usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false },
        // DECISIONS 136: the Workers AI pool in Neurons and the DeepSeek pool in nanodollars, as the service reports them.
        ...(limits.policy === 'daily-usage-v2' ? [
          { id: 'workers-ai', unit: 'neurons', limitUnits: limits.workersAiDailyNeurons, usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false },
          { id: 'deepseek', unit: 'nanodollars', limitUnits: Number(limits.deepseekDailyNano), usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false }] : [])],
      readerModels: (this.state.seed.readerModels?.options ?? []).map(option => ({ id: option.id, model: option.pin.id, sampleDocuments: 0,
        averageCostNanoPerDocument: null, estimatedDocumentsPerDay: null, estimatedDocumentsRemaining: null }))
    };
  }

  #health() {
    const s = this.state, blockers = [];
    const add = (code, headline, details) => blockers.push({ code, headline, action: serverCopy.action, ...(details ? { details } : {}) });
    let source = clone(s.seed);
    if (s.definitionMode === 'runtime') {
      try { source = this.#effectivePack(); } catch (error) {
        add(error instanceof ServerFailure ? error.code : 'E_DEFINITIONS_STORAGE',
          error instanceof Error ? error.message : 'Category definitions are unavailable.');
      }
    }
    const issues = validateProject(source);
    for (const issue of issues) add(issue.code, issue.detail, { path: issue.path });
    let capacity = null;
    if (!issues.length) try {
      capacity = { reader: readerCapacity(source).limit,
        confidence: confidenceCapacity(source, source.typeFile).limit, categories: source.typeFile.types.length };
    } catch (error) {
      if (Array.isArray(error.issues)) for (const issue of error.issues) add(issue.code, issue.detail, { path: issue.path });
      else add('E_CATEGORY_CAPACITY', 'The category capacity could not be computed.', { detail: String(error) });
    }
    if (!s.modelCallsEnabled) add('E_MODEL_CALLS_DISABLED', 'Model calls are disabled by the deployment.');
    if (s.controls.kill) add('E_KILL_SWITCH', 'The kill switch is set.');
    for (const extra of s.extraBlockers) add(extra.code, extra.headline, extra.details);
    const threshold = source.definitionRevisionId
      ? { value: source.definitionThreshold, justification: source.definitionThresholdJustification, status: source.definitionThresholdStatus }
      : { value: s.controls.threshold, justification: s.controls.justification, status: this.#gitThresholdStatus() };
    if (s.thresholdBasis) threshold.basis = this.#thresholdBasis(threshold.justification);
    const unknown = [...s.runs.values()].reduce((total, run) => total + run.unaccountedCalls, 0);
    const vendorHistory = s.lastVendorCall
      ? { status: s.lastVendorCall.httpStatus >= 200 && s.lastVendorCall.httpStatus < 300 ? 'response_received' : 'response_failed',
          latest: { role: s.lastVendorCall.role, httpStatus: s.lastVendorCall.httpStatus, at: iso(s.lastVendorCall.at) },
          unknownSpendCount: unknown }
      : { status: 'not_contacted', latest: null, unknownSpendCount: unknown };
    const value = {
      status: blockers.length ? 'NOT READY' : 'READY',
      blockers,
      versions: { build: s.build, pins: source.pins ?? null, vendors:s.vendors??'live' },
      project: {
        definitionRevisionId: source.definitionRevisionId,
        displayNames: source.displayNames,
        definitionThresholdStatus: source.definitionThresholdStatus,
        id: typeof source.id === 'string' ? source.id : null,
        productName: typeof source.productName === 'string' ? source.productName : null,
        typeVersion: source.typeFile ? typeVersionOf(source.typeFile) : null,
        types: Array.isArray(source.typeFile?.types) ? source.typeFile.types : null,
        copyOverrides: source.copyOverrides
      },
      modelCallsEnabled: s.modelCallsEnabled,
      textHeldRuns: [...s.runs.values()].filter(run => run.textHeld).length,
      threshold,
      capacity,
      // As the service reports each menu reader: usable here or not, and whether its model name is locked.
      ...(source.readerModels ? { readerOptions: source.readerModels.options.map(option => {
        const code = s.unavailableReaders[option.id];
        return { id: option.id, label: option.label, ready: code === undefined,
          modelLocked: option.pin.policy !== 'owner_approved_undated' || option.expectedModel !== undefined,
          blockers: code === undefined ? [] : [{ code, headline: 'This reader cannot be used on this site.' }] };
      }) } : {}),
      vendorStatus: vendorHistory.status,
      vendorHistory
    };
    return clone(value);
  }

  #requireReady() {
    if (this.#health().status !== 'READY') throw new ServerFailure('E_NOT_READY', 'blocker', serverCopy.notReady);
  }

  #gitThresholdStatus() {
    const rows = [...this.state.thresholdHistory].sort((a, b) => b.at - a.at);
    if (!rows.length) return 'untested';
    if (rows[0].threshold !== this.state.controls.threshold) return 'unverified';
    let status = 'untested', justification = '', threshold = Number.NaN;
    for (const row of [...rows].reverse()) {
      status = appliedThresholdStatus({ threshold, status, justification }, { threshold: row.threshold, correctionId: row.correctionId });
      threshold = row.threshold;
      justification = row.correctionId;
    }
    return status;
  }

  #thresholdBasis(justification) {
    if (justification === 'initial_design_threshold') return { kind: 'initial' };
    const correction = this.state.corrections.get(justification);
    if (correction) return { kind: 'correction', runId: correction.runId, at: iso(correction.createdAt) };
    const activation = this.state.activations.find(item => item.id === justification);
    if (activation) return { kind: 'activation', at: iso(activation.createdAt) };
    return { kind: 'unknown' };
  }

  #requireEditor() {
    if (!this.state.editor) throw new ServerFailure('E_EDITOR_REQUIRED', 'request',
      'Only a configured category editor can make this change.', 403);
  }

  #revisionView(revision, calibration, changeKind) {
    return {
      id: revision.id, baseRevisionId: revision.baseRevisionId, typeVersion: revision.typeVersion,
      typeFile: clone(revision.typeFile), displayNames: clone(revision.displayNames),
      createdAt: iso(revision.createdAt), createdBy: revision.createdBy,
      threshold: calibration.threshold, thresholdStatus: calibration.status,
      thresholdJustification: calibration.justification, changeKind
    };
  }

  #activeRevisionView() {
    const s = this.state;
    if (!s.active.revisionId) return null;
    const revision = s.revisions.get(s.active.revisionId);
    const activation = s.activations.find(item => item.revisionId === revision.id);
    return this.#revisionView(revision, s.active, activation?.changeKind ?? 'initial');
  }

  #definitionState() {
    const s = this.state, active = this.#activeRevisionView();
    const activated = new Set(s.activations.map(item => item.revisionId));
    return {
      mode: s.definitionMode,
      canEdit: s.editor,
      actor: s.actor,
      active,
      drafts: [...s.revisions.values()].filter(rev => !activated.has(rev.id)).sort((a, b) => b.createdAt - a.createdAt)
        .map(rev => this.#revisionView(rev, { threshold: 0.9, status: 'untested', justification: 'draft' },
          definitionChange(active?.typeFile ?? null, rev.typeFile))),
      history: [...s.activations].sort((a, b) => b.createdAt - a.createdAt).map(item => this.#revisionView(
        s.revisions.get(item.revisionId),
        { threshold: item.threshold, status: item.thresholdStatus, justification: item.justification },
        item.changeKind)),
      seedTypeFile: clone(s.seed.typeFile)
    };
  }

  #createDraft(raw) {
    this.#requireEditor();
    requireValue(object(raw), 'Category definitions are required.');
    exact(raw, ['baseRevisionId', 'typeFile', 'displayNames']);
    requireValue(raw.baseRevisionId === null || typeof raw.baseRevisionId === 'string', 'The starting category version is required.');
    requireValue(this.state.active.revisionId === raw.baseRevisionId, 'Categories changed. Refresh before saving your draft.');
    const pack = requireProject({ ...clone(this.state.seed), typeFile: raw.typeFile });
    requireCapacity(pack);
    try {
      validateDisplayNames(raw.displayNames, pack.typeFile);
    } catch (error) {
      throw new ServerFailure('E_DEFINITION_DISPLAY', 'request', String(error));
    }
    const revision = this.#addRevision(pack.typeFile, raw.displayNames, raw.baseRevisionId);
    const base = this.state.active.revisionId ? this.state.revisions.get(this.state.active.revisionId).typeFile : null;
    return this.#revisionView(revision, { ...this.state.active, threshold: 0.9, status: 'untested' },
      definitionChange(base, revision.typeFile));
  }

  #addRevision(typeFile, displayNames, baseRevisionId, at = this.now()) {
    const revision = {
      id: randomUUID(), baseRevisionId, typeVersion: typeVersionOf(typeFile), typeFile: clone(typeFile),
      displayNames: clone(displayNames), createdAt: at, createdBy: this.state.actor
    };
    this.state.revisions.set(revision.id, revision);
    return revision;
  }

  #activate(id, raw) {
    this.#requireEditor();
    requireValue(this.state.definitionMode === 'runtime', 'Enable website-managed categories before activation.');
    requireValue(object(raw), 'An explicit activation choice is required.');
    exact(raw, ['inheritThreshold']);
    requireValue(typeof raw.inheritThreshold === 'boolean', 'Choose whether to inherit the threshold.');
    return { active: this.#activateRevision(id, raw.inheritThreshold) };
  }

  #activateRevision(id, inheritThreshold, at = this.now()) {
    const s = this.state, revision = s.revisions.get(id);
    if (!revision) throw new ServerFailure('E_DEFINITION_NOT_FOUND', 'request', 'This category version is unavailable.', 404);
    if (s.active.revisionId !== revision.baseRevisionId) throw new ServerFailure('E_DEFINITION_STALE', 'request',
      'Categories changed. Create a fresh draft before activating.', 409);
    if (s.activations.some(item => item.revisionId === id)) throw new ServerFailure('E_DEFINITION_STALE', 'request',
      'Categories changed. Refresh before activating.', 409);
    requireCapacity(requireProject({ ...clone(s.seed), typeFile: revision.typeFile }));
    const base = s.active.revisionId ? s.revisions.get(s.active.revisionId) : null;
    const kind = definitionChange(base?.typeFile ?? null, revision.typeFile);
    const calibration = definitionThreshold(kind, base ? { threshold: s.active.threshold, status: s.active.status } : null, inheritThreshold);
    const eventId = randomUUID();
    const justification = kind === 'cosmetic' ? s.active.justification : eventId;
    s.activations.push({ id: eventId, revisionId: id, previousRevisionId: revision.baseRevisionId, actor: s.actor, createdAt: at,
      threshold: calibration.threshold, thresholdStatus: calibration.status, changeKind: kind, justification });
    s.active = { revisionId: id, threshold: calibration.threshold, status: calibration.status, justification };
    return this.#revisionView(revision, s.active, kind);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Quote, create, list, kill (R7–R10)
  // -------------------------------------------------------------------------------------------------------------

  #pilotRule(pack,count,campaign,skipPilot=false) {
    if(campaign?.role==='pilot'&&count>(pack.settings.pilotSize??25))throw new ServerFailure('E_PILOT_SIZE','request',serverCopy.pilotTooLarge(pack.settings.pilotSize??25),409);
    if(skipPilot||count<=(pack.settings.pilotSize??25))return;
    const matches=[...this.state.runs.values()].filter(r=>r.actor===this.state.actor&&r.campaign?.id===campaign?.id&&r.pilotConfirmation);
    const active=pack.definitionRevisionId??typeVersionOf(pack.typeFile);
    if(matches.some(r=>r.pilotConfirmedVersion===active))return;
    if(matches.length)throw new ServerFailure('E_PILOT_STALE','request',serverCopy.pilotStale,409);
    throw new ServerFailure('E_PILOT_REQUIRED','request','Run a pilot first: classify up to '+(pack.settings.pilotSize??25)+' documents and confirm every filed one before the rest.',409);
  }
  #pilotView(run) {
    if(run.pilotSkipped===true)throw new ServerFailure('E_PILOT_REVIEW','request','This run was started without a pilot; there is nothing to confirm.',409);
    if(run.campaign?.role!=='pilot')throw new ServerFailure('E_PILOT_REVIEW','request','This run is not a pilot, so it has no pilot review.',409);
    const docs=[...run.docs.values()].sort(byTag);
    if(!['complete','closed'].includes(run.status)||run.expectedCount<1||docs.length!==run.expectedCount||docs.some(d=>d.status!=='complete'||!d.decision))
      throw new ServerFailure('E_PILOT_REVIEW','request','The pilot has not finished yet. Wait until every document has an outcome.',409);
    const latest=new Map(run.pilotReviews.map(v=>[v.fingerprint,v.verdict]));
    const filed=docs.map((doc,index)=>({...doc,ordinal:index+1})).filter(d=>d.decision.ruleId==='R1').map(d=>({
      fingerprint:d.fingerprint,ordinal:d.ordinal,tag:d.tag,originalFilename:d.originalFilename,destinationFolder:d.decision.destinationFolder,verdict:latest.get(d.fingerprint)??null}));
    const pack=this.#effectivePack(),frozen=run.pack.definitionRevisionId??run.typeVersion,active=pack.definitionRevisionId??typeVersionOf(pack.typeFile);
    return {campaignId:run.campaign.id,role:'pilot',pilotSize:run.pack.settings.pilotSize??25,filed,
      counts:{filed:filed.length,reviewed:filed.filter(d=>d.verdict!==null).length,right:filed.filter(d=>d.verdict==='right').length,wrong:filed.filter(d=>d.verdict==='wrong').length},
      confirmation:run.pilotConfirmation,categoryVersion:{frozen,active,matches:frozen===active}};
  }

  #packHash(pack) {
    return sha(JSON.stringify({ pack, build: this.state.build }));
  }

  #quote(raw) {
    this.#requireReady();
    requireValue(object(raw), 'A quote request is required.');
    exactWithOptional(raw, ['documents', 'mode'], ['referenceId','campaign','skipPilot','selectedReaderModel']);
    if (this.state.seed.readerModels) requireValue(typeof raw.selectedReaderModel === 'string', 'Choose a reader model before confirming this run.');
    const pack = this.#effectivePack(raw.selectedReaderModel);
    // The service's backstop for a reader this site cannot use (core/server/reader-readiness.ts).
    const chosenReader = pack.readerModels?.options.find(option => option.id === (pack.selectedReaderModel ?? pack.readerModels?.defaultId));
    if (chosenReader && this.state.unavailableReaders[chosenReader.id] !== undefined)
      throw new ServerFailure('E_READER_UNAVAILABLE', 'request', usageCopy.readerUnavailable(chosenReader.label), 409);
    requireCapacity(pack);
    if (raw.skipPilot !== undefined && raw.skipPilot !== true)
      throw new ServerFailure('E_REQUEST', 'request', 'Choose the pilot, or say explicitly that this run skips it.');
    const skipPilot = raw.skipPilot === true;
    if (skipPilot && raw.campaign !== undefined)
      throw new ServerFailure('E_REQUEST', 'request', 'Choose either the pilot or skipping it, not both.');
    // Every run is Interactive: the page sends the constant, and anything else is refused as the server does.
    requireValue(raw.mode === 'interactive', 'Only Interactive runs can be started.');
    requireValue(Array.isArray(raw.documents) && raw.documents.length > 0, 'Choose at least one document.');
    const ids = new Set(), docs = [];
    for (const value of raw.documents) {
      requireValue(object(value), 'Invalid preflight document.');
      exact(value, ['fingerprint', 'originalFilename', 'tokenCounts', 'needsOutlineRecovery', 'failed']);
      identity(value);
      requireValue(!ids.has(String(value.fingerprint)), 'Duplicate document fingerprints are not allowed in a run.');
      ids.add(String(value.fingerprint));
      requireValue(typeof value.needsOutlineRecovery === 'boolean' && typeof value.failed === 'boolean' && object(value.tokenCounts),
        'Explicit recovery state and token-count availability are required.');
      exact(value.tokenCounts, ['readerInputTokens', 'confidenceInputTokens', 'recoveryInputTokens']);
      requireValue(Object.values(value.tokenCounts).every(v => v === null || (Number.isSafeInteger(v) && Number(v) >= 0)),
        'Invalid token counts.');
      docs.push(clone(value));
    }
    if (raw.referenceId !== undefined) {
      requireValue(typeof raw.referenceId === 'string', 'Select valid saved feedback.');
      const reference = this.#readReference(raw.referenceId);
      validateLineage(reference.definitionRevisionId, pack.definitionRevisionId);
    }
    let campaign=null;
    if(raw.campaign!==undefined){
      requireValue(object(raw.campaign),'Choose whether this is a pilot or the full run.');
      if(raw.campaign.role==='pilot'){exact(raw.campaign,['role']);campaign={id:randomUUID(),role:'pilot'};}
      else{exact(raw.campaign,['role','id']);requireValue(raw.campaign.role==='full'&&typeof raw.campaign.id==='string'&&raw.campaign.id,'The full run must name the pilot it follows.');campaign={id:raw.campaign.id,role:'full'};}
    }
    this.#pilotRule(pack,docs.length,campaign,skipPilot);
    const quote = {
      campaign, pilotSkipped: skipPilot, readerPromptVersion: readerPromptVersion(pack.settings.readerContract),
      id: randomUUID(), actor: this.state.actor, createdAt: this.now(), mode: raw.mode,
      typeVersion: typeVersionOf(pack.typeFile), packHash: this.#packHash(pack), documents: docs,
      referenceId: raw.referenceId ?? null, ...(pack.selectedReaderModel === undefined ? {} : { selectedReaderModel: pack.selectedReaderModel })
    };
    this.state.quotes.set(quote.id, quote);
    return { quoteId: quote.id, typeVersion: quote.typeVersion, mode: quote.mode, campaign:quote.campaign,
      readerModel: readerModelIdentity(pack), ...(pack.selectedReaderModel === undefined ? {} : { selectedReaderModel: pack.selectedReaderModel }),
      ...pilotChoiceOf(quote) };
  }

  #createRun(raw) {
    requireValue(object(raw), 'A run request is required.');
    exact(raw, ['quoteId', 'budget']);
    requireValue(typeof raw.quoteId === 'string', 'A preflight confirmation and explicit budget decision are required.');
    const quote = this.state.quotes.get(raw.quoteId);
    requireValue(quote && quote.actor === this.state.actor, 'The preflight confirmation is not available to this person.');
    let budget;
    try {
      budget = authorizeRunBudget(raw.budget, this.state.actor, iso(this.now()));
    } catch (error) {
      throw new ServerFailure('E_RUN_BUDGET', 'request', error instanceof Error ? error.message : 'Invalid run budget.');
    }
    const prior = [...this.state.runs.values()].find(run => run.quoteId === quote.id);
    if (prior) {
      requireValue(prior.actor === this.state.actor, 'The confirmed run is not available to this person.');
      const existing = readRunBudget(prior.budget);
      requireValue(existing.mode === budget.mode && existing.unlimitedAcknowledged === budget.unlimitedAcknowledged &&
        JSON.stringify(existing.limits) === JSON.stringify(budget.limits),
        'This confirmation already created a run with a different spending decision. Confirm a new run to change limits.');
      return ok({ runId: prior.id });
    }
    this.#requireReady();
    const pack = this.#effectivePack(quote.selectedReaderModel);
    requireValue(quote.packHash === this.#packHash(pack) && quote.typeVersion === typeVersionOf(pack.typeFile),
      'The project changed after this confirmation. Confirm the run again.');
    requireCapacity(pack);
    if (quote.referenceId) {
      const reference = this.#readReference(quote.referenceId);
      validateLineage(reference.definitionRevisionId, pack.definitionRevisionId);
    }
    if (quote.pilotSkipped !== undefined && quote.pilotSkipped !== false && quote.pilotSkipped !== true)
      throw new ServerFailure('E_STORAGE_D1', 'blocker', 'The pilot choice recorded on this confirmation is unreadable.');
    this.#pilotRule(pack,quote.documents.length,quote.campaign??null,quote.pilotSkipped===true);
    const run = this.#newRun({ quote, pack, budget, at: this.now() });
    return ok({ runId: run.id }, 201);
  }

  #newRun({ quote, pack, budget, at, actor = this.state.actor, files }) {
    const s = this.state;
    const threshold = pack.definitionRevisionId ? pack.definitionThreshold : s.controls.threshold;
    const justification = pack.definitionRevisionId ? pack.definitionThresholdJustification : s.controls.justification;
    const run = {
      campaign:quote.campaign??null,pilotSkipped:quote.pilotSkipped===true,pilotReviews:[],pilotConfirmation:null,pilotConfirmedVersion:null,
      id: randomUUID(), actor, status: 'uploading', createdAt: at, mode: quote.mode,
      expectedCount: quote.documents.length, threshold, thresholdJustification: justification,
      typeVersion: quote.typeVersion, pack: clone(pack), budget, quoteId: quote.id,
      notes: [...(s.vendors==='fake'?['N_FAKE_VENDORS']:[]), ...(quote.pilotSkipped===true?[PILOT_SKIPPED_NOTE]:[])], textHeld: true,
      halt: null, closedAt: null, manifest: null, docs: new Map(), events: [], spend: { openai: 0n, typesafe: 0n },
      unaccountedCalls: 0, pendingAccounting: 0, plans: new Map(), providerWaits: [],
      files: new Map((files ?? []).map(file => [file.fingerprint, file]))
    };
    s.runs.set(run.id, run);
    if (quote.referenceId) s.links.set(run.id, quote.referenceId);
    const typeIds = pack.typeFile.types.map(type => type.id);
    let readable = 0;
    for (const doc of quote.documents) {
      if (doc.failed) continue;
      const token = s.planner(doc, readable++, typeIds, run);
      run.plans.set(doc.fingerprint, this.#makePlan(token, typeIds, run.threshold));
    }
    this.#event(run, null, 'run', 'created', { budget, mode: quote.mode, campaign: run.campaign, ...pilotChoiceOf(run) }, at);
    return run;
  }

  /** Validates a plan token against the real decide(), so a builder never plans an impossible outcome. */
  #makePlan(token, typeIds, threshold) {
    const [body, certaintyText] = String(token).split('@');
    const [rule, typeId, otherTypeId] = body.split(':');
    const plan = { rule, typeId: typeId || typeIds[0], otherTypeId: otherTypeId || typeIds.find(id => id !== (typeId || typeIds[0])) || null,
      certainty: certaintyText === undefined ? null : Number(certaintyText) };
    if (plan.certainty !== null && !(plan.certainty >= 0 && plan.certainty <= 1)) throw new Error(`Outcome plan "${token}" has an invalid certainty.`);
    if (!['R0', 'R0n', 'R1', 'R2', 'R3', 'R4', 'R5'].includes(rule)) throw new Error(`Unknown outcome plan "${token}".`);
    if (!typeIds.includes(plan.typeId)) throw new Error(`Outcome plan "${token}" names a category the run does not have.`);
    if (rule === 'R3' && !plan.otherTypeId) throw new Error('An R3 plan needs at least two categories.');
    if (!['R0', 'R0n'].includes(rule)) {
      const outputs = synthesizeOutputs(plan, typeIds, threshold, []);
      const check = decide({ notePolicy: 'full-state-structural-info-v3', confidenceStatePolicy: 'full-text-outline-v3',
        typeIds, threshold, failures: [], notes: [], confidence: outputs.decisionConfidence, readerYes: outputs.readerYes });
      if (check.ruleId !== rule) throw new Error(`Outcome plan "${token}" gives ${check.ruleId} under the real rules.`);
    }
    return plan;
  }

  #runList() {
    return [...this.state.runs.values()].filter(run => run.actor === this.state.actor)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .map(run => {
        const docs = [...run.docs.values()], spend = spendOf(run);
        return {
          campaign:run.campaign??null,...(run.notes.includes('N_FAKE_VENDORS')?{vendors:'fake'}:{}),
          ...pilotChoiceOf(run),
          id: run.id, status: run.status, createdAt: iso(run.createdAt), total: run.expectedCount,
          completed: docs.filter(doc => doc.status === 'complete').length, spendNano: spend.blended, spend,
          budget: readRunBudget(run.budget), unaccountedCalls: run.unaccountedCalls,
          pendingAccounting: run.pendingAccounting, textHeld: run.textHeld, mode: run.mode,
          runtimeWait: run.status === 'running' ? clone(run.runtimeWait ?? null) : null,
          // S4
          uploaded: docs.length, lastUploadAt: this.#lastUploadAt(run),
          definitionRevisionId: run.pack.definitionRevisionId ?? null, comparedWith: this.#comparedWith(run)
        };
      });
  }

  #setKill(enabled, at = this.now()) {
    this.state.controls.kill = enabled;
    if (enabled) for (const run of this.state.runs.values())
      if (run.status === 'running' || run.status === 'uploading') {
        run.status = 'halted';
        run.halt = { code: 'E_KILL_SWITCH', actor: this.state.actor };
      }
    this.state.globalEvents.push({ id: randomUUID(), createdAt: at, stage: 'kill_switch', kind: 'changed', details: { enabled } });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Run-scoped reads (R11, S1, /plan, R12)
  // -------------------------------------------------------------------------------------------------------------

  #authorizeRun(id) {
    const run = this.state.runs.get(id);
    if (!run) throw new ServerFailure('E_RUN_NOT_FOUND', 'request', 'The run does not exist.', 404);
    if (run.actor !== this.state.actor) throw new ServerFailure('E_RUN_FORBIDDEN', 'request',
      'This run belongs to a different signed-in person.', 403);
    return run;
  }

  #lastUploadAt(run) {
    const times = run.events.filter(e => e.stage === 'upload' && e.kind === 'completed').map(e => e.createdAt);
    return times.length ? iso(Math.max(...times)) : null;
  }

  #lastEventAt(run) {
    return run.events.length ? iso(Math.max(...run.events.map(e => e.createdAt))) : null;
  }

  #comparedWith(run) {
    const referenceId = this.state.links.get(run.id);
    if (!referenceId) return null;
    return { referenceId, sourceRunId: this.state.references.get(referenceId).sourceRunId };
  }

  #stopReason(run) {
    if (run.status !== 'halted') return null;
    const first = run.events.find(e => e.stage === 'run' && e.kind === 'halted');
    const raw = first?.details ?? run.halt ?? {};
    const code = typeof raw.code === 'string' ? raw.code : 'E_RUN_HALTED';
    const message = typeof raw.message === 'string' ? raw.message : code === 'E_KILL_SWITCH' ? serverCopy.runKilled : serverCopy.runHalted;
    const error = failureResponse(new ServerFailure(code, 'blocker', message)).error;
    const details = { ...error.details, ...(first ? { firstObservedAt: iso(first.createdAt) } : {}) };
    let headline = error.headline, action = serverCopy.runHaltAction;
    if (code === 'E_INTERNAL' && RUNTIME_RESET_MESSAGES.has(message)) {
      headline = serverCopy.runtimeResetHeadline;
      action = serverCopy.runtimeResetAction;
      details.runtimeReset = message;
    }
    return { ...error, headline, action, details };
  }

  /** @returns {RunStatusInput} */
  statusInput(run, now = this.now()) {
    const waits = run.events.filter(e => e.stage === 'provider_cooldown' && e.kind === 'waiting').slice(-20).reverse()
      .map(e => ({ stage: e.stage, kind: e.kind, details_json: JSON.stringify(e.details) }));
    return {
      now,
      run: {
        campaign:run.campaign??null,...(run.notes.includes('N_FAKE_VENDORS')?{vendors:'fake'}:{}),
        ...pilotChoiceOf(run), ...variantHeadersOf(run),
        id: run.id, status: run.status, mode: run.mode, createdAt: iso(run.createdAt), expectedCount: run.expectedCount,
        threshold: run.threshold, textHeld: run.textHeld, notes: [...run.notes], spend: spendOf(run),
        // The signer (actor, timestamp) is not projected (build notes: WP-0 request to WP-2; S1 test 9).
        budget: publicBudget(readRunBudget(run.budget)),
        unaccountedCalls: run.unaccountedCalls, pendingAccounting: run.pendingAccounting,
        stopReason: this.#stopReason(run),
        runtimeWait: run.status === 'running' ? clone(run.runtimeWait ?? null) : null,
        definitionRevisionId: run.pack.definitionRevisionId ?? null,
        ...(run.readerVersion === undefined ? {} : { readerVersion: clone(run.readerVersion) })
      },
      documents: [...run.docs.values()].map(doc => ({
        fingerprint: doc.fingerprint, tag: doc.tag, originalFilename: doc.originalFilename, status: doc.status,
        workflowId: doc.workflowId, phase: doc.status === 'complete' ? 'done' : doc.phase,
        decision: doc.decision ? clone(doc.decision) : null, failure: doc.failure ? clone(doc.failure) : null
      })),
      lastUploadAt: this.#lastUploadAt(run),
      lastEventAt: this.#lastEventAt(run),
      providerWaits: activeProviderWaits(run.status, waits, now),
      recent: run.events.slice(-5).reverse().map(e => ({
        id: e.id, createdAt: iso(e.createdAt), fingerprint: e.fingerprint, stage: e.stage, kind: e.kind
      })),
      comparedWith: this.#comparedWith(run)
    };
  }

  /** S1 exactly as core/server/api.ts answers it: `runStatusResponse(input, requestedVersion(?version))`. */
  #status(run, requested) {
    return runStatusResponse(this.statusInput(run, this.now()), requestedVersion(requested));
  }

  #snapshot(run, withEvents) {
    const spend = spendOf(run), docs = [...run.docs.values()].sort(byTag);
    return {
      run: {
        id: run.id, status: run.status, createdAt: iso(run.createdAt), total: run.expectedCount,
        ...pilotChoiceOf(run),
        completed: docs.filter(doc => doc.status === 'complete').length, mode: run.mode, textHeld: run.textHeld,
        spendNano: spend.blended, spend, budget: readRunBudget(run.budget), unaccountedCalls: run.unaccountedCalls,
        pendingAccounting: run.pendingAccounting, threshold: run.threshold, notes: [...run.notes],
        stopReason: this.#stopReason(run)
      },
      documents: docs.map(doc => ({
        run_id: run.id, fingerprint: doc.fingerprint, tag: doc.tag, original_filename: doc.originalFilename,
        status: doc.status, input_key: doc.body ? `${run.id}/${doc.fingerprint}/input` : null, input_hash: doc.inputHash,
        extractor_version: doc.extractorVersion, workflow_id: doc.workflowId,
        digest_key: PIPELINE.indexOf(doc.phase) >= PIPELINE.indexOf('confidence_check') ? `${run.id}/${doc.fingerprint}/digest` : null,
        confidence_key: doc.confidence ? `${run.id}/${doc.fingerprint}/confidence` : null,
        reader_key: doc.reader ? `${run.id}/${doc.fingerprint}/reader` : null,
        notes_json: JSON.stringify(doc.notes), decision_json: doc.decision ? JSON.stringify(doc.decision) : null,
        failure_json: doc.failure ? JSON.stringify(doc.failure) : null,
        extraction_json: doc.extraction ? JSON.stringify(doc.extraction) : null,
        decision: doc.decision ? clone(doc.decision) : null,
        phase: doc.status === 'complete' ? 'done' : doc.phase
      })),
      events: withEvents ? [...run.events].sort((a, b) => a.createdAt - b.createdAt).map(e => ({
        id: e.id, run_id: run.id, fingerprint: e.fingerprint, created_at: iso(e.createdAt), stage: e.stage, kind: e.kind,
        elapsed_ms: null, details_json: JSON.stringify(e.details ?? {})
      })) : []
    };
  }

  #plan(run) {
    const quote = this.state.quotes.get(run.quoteId);
    if (!quote) throw new ServerFailure('E_RUN_PLAN', 'blocker', 'The confirmation behind this run is missing.');
    return {
      runId: run.id, mode: run.mode, threshold: run.threshold,
      readerModel: readerModelIdentity(run.pack), ...(run.pack.selectedReaderModel === undefined ? {} : { selectedReaderModel: run.pack.selectedReaderModel }),
      definitionRevisionId: run.pack.definitionRevisionId ?? null,
      definitionThresholdStatus: run.pack.definitionThresholdStatus ?? null,
      typeFile: clone(run.pack.typeFile), displayNames: clone(run.pack.displayNames ?? {}),
      minimumFiledCount: run.pack.settings.minimumFiledCount,
      ...variantHeadersOf(run),
      expected: quote.documents.map(doc => ({
        fingerprint: doc.fingerprint, originalFilename: doc.originalFilename, extractionFailed: doc.failed,
        uploaded: run.docs.has(doc.fingerprint)
      }))
    };
  }

  #evidence(run, fingerprint) {
    const doc = run.docs.get(fingerprint);
    if (!doc) throw new ServerFailure('E_DOCUMENT_NOT_FOUND', 'request', 'The document does not exist in this run.', 404);
    return {
      runId: run.id, fingerprint: doc.fingerprint, decision: doc.decision ? clone(doc.decision) : null,
      failure: doc.failure ? clone(doc.failure) : null, notes: [...doc.notes],
      confidence: doc.confidence ? clone(doc.confidence) : null, reader: doc.reader ? clone(doc.reader) : null
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Upload, start, close (R13, R17, R18 + S3)
  // -------------------------------------------------------------------------------------------------------------

  #upload(run, bytes, raw) {
    requireValue(run.status === 'uploading', 'This run is no longer accepting uploads.');
    requireValue(object(raw), 'A document object is required.');
    identity(raw);
    const hash = sha(JSON.stringify(raw));
    const previous = run.docs.get(raw.fingerprint);
    if (previous) {
      requireValue(previous.inputHash === hash, 'An upload with this fingerprint already exists with different content.');
      return ok({ uploaded: true, idempotent: true });
    }
    const quote = this.state.quotes.get(run.quoteId);
    const index = quote.documents.findIndex(doc => doc.fingerprint === raw.fingerprint);
    requireValue(index >= 0, 'The document was not included in the confirmed preflight.');
    const expected = quote.documents[index];
    requireValue(raw.originalFilename === expected.originalFilename, 'The filename differs from the confirmed preflight.');
    const pack = run.pack;
    let failureValue = null, decision = null, body = null, extraction = null, extractor = null;
    if (Object.hasOwn(raw, 'failure')) {
      exact(raw, ['fingerprint', 'originalFilename', 'failure']);
      requireValue(expected.failed && object(raw.failure), 'The quote must record the local extraction failure.');
      exact(raw.failure, ['code', 'message']);
      requireValue(typeof raw.failure.code === 'string' && typeof raw.failure.message === 'string', 'Invalid extraction failure.');
      failureValue = clone(raw.failure);
      decision = decide({ notePolicy: pack.settings.decisionNotePolicy, confidenceStatePolicy: pack.settings.confidenceStatePolicy,
        typeIds: pack.typeFile.types.map(type => type.id), threshold: run.threshold, failures: [raw.failure.code], notes: [] });
    } else {
      const document = parseUpload(raw);
      requireValue(!expected.failed && JSON.stringify(document.tokenCounts) === JSON.stringify(expected.tokenCounts) &&
        document.needsOutlineRecovery === expected.needsOutlineRecovery, 'The document differs from the confirmed preflight input.');
      requireValue(document.tokenizerIds.confidence === null && document.tokenizerIds.reader === null,
        'This state policy does not use local token counters.');
      // Plain errors here become 500 E_INTERNAL with the reason hidden, exactly as on the server (API §R13).
      buildConfidenceState(pack.settings.confidenceStatePolicy, document.fullText, document.outline, pack.structuralVocabulary);
      body = clone(raw);
      extractor = document.extractorVersion;
      extraction = { extractorVersion: document.extractorVersion, parserVersions: clone(document.parserVersions),
        needsOutlineRecovery: document.needsOutlineRecovery };
    }
    this.#addDocument(run, { fingerprint: raw.fingerprint, originalFilename: raw.originalFilename, index, hash, body,
      extractor, extraction, decision, failure: failureValue, needsOutlineRecovery: expected.needsOutlineRecovery,
      quotes: body ? quotesFrom(body.fullText) : [] }, this.now());
    return ok({ uploaded: true, idempotent: false }, 201);
  }

  #addDocument(run, doc, at) {
    run.docs.set(doc.fingerprint, {
      fingerprint: doc.fingerprint, tag: `r${run.id.slice(0, 8)}-${String(doc.index + 1).padStart(Math.max(4, String(run.expectedCount).length), '0')}`,
      originalFilename: doc.originalFilename, status: doc.decision ? 'complete' : 'uploaded', workflowId: null,
      phase: 'waiting_to_start', inputHash: doc.hash, body: doc.body, extractorVersion: doc.extractor,
      extraction: doc.extraction, notes: [], decision: doc.decision, failure: doc.failure, confidence: null, reader: null,
      needsOutlineRecovery: doc.needsOutlineRecovery, quotes: doc.quotes, uploadedAt: at
    });
    run.manifest = null;
    this.#event(run, doc.fingerprint, 'upload', 'completed', { failed: doc.decision !== null }, at);
  }

  async #start(run, at = this.now()) {
    if (!['uploading', 'running'].includes(run.status)) return { started: 0, pending: 0, status: run.status };
    this.#requireReady();
    const docs = [...run.docs.values()];
    requireValue(docs.length === run.expectedCount, 'Every document must be uploaded before starting.');
    if (run.status === 'uploading') {
      const mix = extractorMixPlan(docs.map(doc => doc.extractorVersion), run.pack.settings.decisionNotePolicy);
      if (mix.runNotes.length) {
        run.notes = [...new Set([...run.notes, ...mix.runNotes])];
        this.#event(run, null, 'start', 'extractor_versions_mixed', { versions: mix.versions }, at);
      }
      if (mix.documentNotes.length) for (const doc of docs) doc.notes = [...mix.documentNotes];
      // A DeepSeek run records the version its model list gives, once, at its first /start; never a refusal.
      const pin = run.pack.pins.reader;
      if (modelFamily('reader', pin)?.vendor === 'deepseek' && run.readerVersion === undefined) {
        this.state.modelListReads++;
        const listed = this.state.deepseekModelList === 'listed' ? listedVersion(200, FAKE_DEEPSEEK_MODEL_LIST, pin.id) : listedVersion(503, null, pin.id);
        run.readerVersion = { model: pin.id, ...listed, recordedAt: iso(at) };
        this.#event(run, null, 'start', 'reader_version', { model: pin.id, ...listed }, at);
      }
      run.status = 'running';
    }
    return dispatchRunDocuments({
      readStatus: async () => run.status,
      readDocuments: async () => [...run.docs.values()].sort(byTag)
        .map(doc => ({ fingerprint: doc.fingerprint, status: doc.status, workflow_id: doc.workflowId })),
      create: async fingerprint => {
        if (this.state.failStartFor?.(run, fingerprint)) {
          // store.halt records {code, detail}; with no message the stop reason reads "This run has stopped…".
          this.#halt(run, { code: 'E_WORKFLOW_START', detail: 'A document workflow could not be created.' }, at);
          throw new ServerFailure('E_WORKFLOW_START', 'blocker', 'A document workflow could not be started. The run has halted.');
        }
        return this.#dispatch(run, run.docs.get(fingerprint));
      },
      markComplete: async () => {
        if (run.status === 'running' && [...run.docs.values()].every(doc => doc.status === 'complete')) run.status = 'complete';
      }
    });
  }

  /** Hands one document over (the server's `workflow_id` write). The real page size, 50 per /start, is kept. */
  #dispatch(run, doc) {
    if (!doc || doc.workflowId !== null || doc.status === 'complete') return false;
    doc.workflowId = `wf-${run.id.slice(0, 8)}-${doc.tag}`;
    doc.phase = 'waiting_to_start';
    return true;
  }

  #close(run, at = this.now()) {
    if (run.status === 'closed') return;
    this.#event(run, null, 'closure', 'requested', {}, at);
    run.status = 'closed';
    run.closedAt = at;
    run.textHeld = false;
    for (const doc of run.docs.values()) doc.body = null;
    this.#event(run, null, 'closure', 'completed', {}, at);
  }

  #halt(run, halt, at = this.now()) {
    if (!['uploading', 'running'].includes(run.status)) return;
    run.status = 'halted';
    run.halt = { ...halt };
    this.#event(run, null, 'run', 'halted', { ...halt }, at);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Results, corrections, answers, comparison, threshold (R19–R26 + S6)
  // -------------------------------------------------------------------------------------------------------------

  #manifest(run) {
    const docs = [...run.docs.values()].sort(byTag);
    validateManifestReady(run.status, run.expectedCount, docs.filter(doc => doc.decision !== null).length);
    if (run.manifest) return clone(run.manifest);
    const pack = run.pack;
    const entries = docs.map(doc => ({
      vendorOutputs: { confidence: clone(doc.confidence), reader: clone(doc.reader) },
      extraction: doc.extraction ? clone(doc.extraction) : null,
      notes: [...doc.notes],
      outlineRecovered: doc.notes.includes('N_OUTLINE_RECOVERED'),
      fingerprint: doc.fingerprint, originalFilename: doc.originalFilename, tag: doc.tag,
      destinationFolder: doc.decision.destinationFolder, rule: doc.decision.ruleId,
      reasoningNote: serverCopy.reasons[doc.decision.reasonCode],
      confidenceCheck: doc.confidence ? { choice: doc.confidence.choice, certainty: doc.confidence.confidence, noul: { ...doc.confidence.nouls } } : null,
      reader: doc.reader ? doc.reader.verdicts.map(v => ({ typeId: v.type_id, isType: v.is_type, rationale: v.rationale,
        evidence: [...v.evidence], closestAlternative: v.closest_alternative })) : null
    }));
    const value = clone({
      runId: run.id, entries,...(run.notes.includes('N_FAKE_VENDORS')?{vendors:'fake'}:{}),
      ...pilotChoiceOf(run), ...variantHeadersOf(run),
      unknownSpendPolicy: pack.settings.unknownSpendPolicy ?? 'halt-on-unknown-v1',
      spending: { knownSubtotal: spendOf(run), unresolvedCalls: run.unaccountedCalls, pendingAccounting: run.pendingAccounting },
      readerEvidencePolicy: pack.settings.readerEvidencePolicy ?? 'exact-substring-v1',
      definitionRevisionId: pack.definitionRevisionId, displayNames: pack.displayNames,
      definitionThresholdStatus: pack.definitionThresholdStatus, thresholdJustification: run.thresholdJustification,
      decisionNotePolicy: pack.settings.decisionNotePolicy ?? 'all-notes-review-v1',
      confidenceStatePolicy: pack.settings.confidenceStatePolicy, pins: pack.pins, typeVersion: run.typeVersion,
      threshold: run.threshold, mode: run.mode, runNotes: [...run.notes],
      notes: docs.map(doc => ({ fingerprint: doc.fingerprint, notes: [...doc.notes], failure: doc.failure ? clone(doc.failure) : null }))
    });
    run.manifest = value;
    return clone(value);
  }

  #saveCorrection(run, raw, at = this.now()) {
    requireValue(object(raw), 'A correction listing is required.');
    requireValue(Object.keys(raw).every(key => ['files', 'checkedFolders', 'sidecarPaths', 'folderDecisions'].includes(key)),
      'Only a local file listing may be submitted.');
    requireValue(Array.isArray(raw.files) && Array.isArray(raw.checkedFolders) && raw.checkedFolders.every(v => typeof v === 'string') &&
      Array.isArray(raw.sidecarPaths) && raw.sidecarPaths.every(v => typeof v === 'string'), 'Invalid correction listing.');
    for (const file of raw.files) requireValue(object(file) &&
      Object.keys(file).every(key => ['folder', 'filename', 'tag', 'fingerprint'].includes(key)) &&
      typeof file.folder === 'string' && typeof file.filename === 'string', 'A correction may contain paths and identities only.');
    const manifest = this.#manifest(run), pack = run.pack;
    const compared = diffCorrection({ manifest: manifest.entries, files: raw.files, checkedFolders: raw.checkedFolders,
      sidecarPaths: raw.sidecarPaths, typeFolders: pack.typeFile.types.map(type => type.id) });
    // The full run of a campaign carries the trial's checks (core/correction/carry.ts), as the service does.
    const { diff, carried: carriedFromTrial } = carryTrialChecks(compared, manifest.entries, this.#trialChecksFor(run));
    const unavailableTags = [], evidence = {};
    for (const doc of [...run.docs.values()].sort(byTag)) {
      // Full-text input policies retain no digest, so the title is the filename and the context is unavailable.
      unavailableTags.push(doc.tag);
      evidence[doc.tag] = {
        certainty: doc.confidence?.confidence ?? null,
        agreedType: doc.confidence && doc.decision?.ruleId === 'R2' ? doc.confidence.choice : null,
        title: doc.originalFilename, digestLines: [],
        readerEvidence: doc.reader ? doc.reader.verdicts.flatMap((verdict, verdictIndex) => verdict.evidence.map((quote, quoteIndex) =>
          ({ typeId: verdict.type_id, isType: verdict.is_type, quote, verdictIndex, quoteIndex, artifactKey: `${run.id}/${doc.fingerprint}/reader` }))) : [],
        fullContextUnavailable: true
      };
    }
    const id = randomUUID();
    const proposals = proposeCorrections({
      correctionId: id, typeVersion: run.typeVersion, currentThreshold: run.threshold,
      minimumFiledCount: pack.settings.minimumFiledCount, diff, evidence, types: pack.typeFile.types,
      folderDecisions: raw.folderDecisions ?? [],
      renderNotFor: (from, to) => uiCopy.conditionalNotFor(from.name, to.name, to.what)
    });
    const proposalContext = { unavailableTags, reason: 'source_text_not_retained', carriedFromTrial };
    this.state.corrections.set(id, { id, runId: run.id, actor: this.state.actor, createdAt: at, raw: clone(raw), diff: clone(diff),
      proposals: clone(proposals), proposalContext });
    return { correctionId: id, diff, proposals, proposalContext };
  }

  /** The pilot's filed documents with their effective verdicts, for the full run of its campaign; nothing otherwise. */
  #trialChecksFor(run) {
    if (run.campaign?.role !== 'full') return [];
    const pilot = [...this.state.runs.values()].find(r => r.campaign?.id === run.campaign.id && r.campaign.role === 'pilot' && r.actor === run.actor);
    if (!pilot) return [];
    const latest = new Map(pilot.pilotReviews.map(v => [v.fingerprint, v.verdict]));
    return [...pilot.docs.values()].filter(doc => doc.decision?.ruleId === 'R1')
      .map(doc => ({ fingerprint: doc.fingerprint, destinationFolder: doc.decision.destinationFolder, verdict: latest.get(doc.fingerprint) ?? null }));
  }

  #sourceEntries(run) {
    const docs = [...run.docs.values()].sort(byTag);
    if (!['complete', 'closed'].includes(run.status) || docs.length !== run.expectedCount || docs.some(doc => !doc.decision))
      rejectFeedback('Feedback requires completed source results.');
    return docs.map(doc => ({ fingerprint: doc.fingerprint, tag: doc.tag, originalFilename: doc.originalFilename,
      destinationFolder: doc.decision.destinationFolder, rule: doc.decision.ruleId }));
  }

  #storedCorrection(run, correctionId) {
    const saved = this.state.corrections.get(correctionId);
    if (!saved || saved.runId !== run.id) rejectFeedback('The saved correction does not belong to this run.');
    return saved;
  }

  #referenceEntries(run, saved, typeIds, labels, folderLabels) {
    try {
      return buildReference(this.#sourceEntries(run), [...saved.diff.confirmations, ...saved.diff.moves], typeIds, labels,
        folderLabels, saved.proposals.ignoredFolders);
    } catch (error) {
      if (error instanceof ServerFailure) throw error;
      rejectFeedback(error instanceof Error ? error.message : 'Invalid feedback labels.');
    }
  }

  #readCorrection(run, correctionId) {
    const saved = this.#storedCorrection(run, correctionId);
    const types = run.pack.typeFile.types.map(type => type.id);
    return { correctionId, diff: clone(saved.diff), proposals: clone(saved.proposals), proposalContext: clone(saved.proposalContext),
      referenceCandidates: this.#referenceEntries(run, saved, types, [], {}) };
  }

  #saveReference(run, correctionId, input, at = this.now()) {
    if (run.actor !== this.state.actor) rejectFeedback('Only the source run owner can confirm its labels.');
    if (!input || typeof input.definitionRevisionId !== 'string' || !Array.isArray(input.labels) ||
      (input.folderLabels !== undefined && (typeof input.folderLabels !== 'object' || input.folderLabels === null || Array.isArray(input.folderLabels))))
      rejectFeedback('Choose a category version and confirm document labels.');
    const revision = this.state.revisions.get(input.definitionRevisionId);
    if (!revision) rejectFeedback('The selected category version does not exist.');
    const saved = this.#storedCorrection(run, correctionId);
    const entries = this.#referenceEntries(run, saved, revision.typeFile.types.map(type => type.id), input.labels, input.folderLabels ?? {});
    const value = { id: randomUUID(), sourceRunId: run.id, correctionId, definitionRevisionId: input.definitionRevisionId,
      entries, carriedFrom: null };
    this.state.references.set(value.id, { ...clone(value), confirmedBy: this.state.actor, createdAt: at });
    return value;
  }

  #readReference(id) {
    const row = this.state.references.get(id);
    if (!row || row.confirmedBy !== this.state.actor) rejectFeedback('The confirmed feedback is unavailable to this person.');
    return { id: row.id, sourceRunId: row.sourceRunId, correctionId: row.correctionId,
      definitionRevisionId: row.definitionRevisionId, entries: clone(row.entries), carriedFrom: row.carriedFrom ?? null };
  }

  #carry(referenceId, at = this.now()) {
    const source = this.#readReference(referenceId), activeId = this.state.active.revisionId;
    if (!activeId) rejectFeedback('Activate categories before carrying labels to them.');
    if (source.definitionRevisionId === activeId) rejectFeedback('These labels already use the active category version.');
    const revision = this.state.revisions.get(activeId);
    if (!revision) rejectFeedback('The active category version does not exist.');
    const valid = new Set(revision.typeFile.types.map(type => type.id));
    const missing = [...new Set(source.entries.flatMap(entry => entry.labels).filter(id => !valid.has(id)))].sort();
    if (missing.length) rejectFeedback(`These labelled categories are not in the active category version: ${missing.join(', ')}. ` +
      'Confirm labels again against that version instead.');
    const value = { id: randomUUID(), sourceRunId: source.sourceRunId, correctionId: source.correctionId,
      definitionRevisionId: activeId, entries: source.entries.map(entry => ({ ...entry, labels: [...entry.labels] })), carriedFrom: source.id };
    this.state.references.set(value.id, { ...clone(value), confirmedBy: this.state.actor, createdAt: at });
    return value;
  }

  #comparison(run) {
    const referenceId = this.state.links.get(run.id);
    if (!referenceId) return null;
    const reference = this.#readReference(referenceId);
    const documents = [...run.docs.values()].sort(byTag).map(doc => ({
      fingerprint: doc.fingerprint, destinationFolder: doc.decision?.destinationFolder ?? null, rule: doc.decision?.ruleId ?? null
    }));
    return {
      referenceId: reference.id, sourceRunId: reference.sourceRunId, correctionId: reference.correctionId,
      definitionRevisionId: reference.definitionRevisionId, runId: run.id,
      complete: ['complete', 'closed'].includes(run.status), ...compareReference(reference.entries, documents)
    };
  }

  #apply(run, correctionId, readBody, at = this.now()) {
    this.#requireEditor();
    const s = this.state, runtime = s.definitionMode === 'runtime';
    const active = runtime && s.active.revisionId ? s.active : null;
    requireValue(!runtime || active !== null, 'Activate categories before applying a threshold.');
    requireValue(active ? active.revisionId === run.pack.definitionRevisionId : run.typeVersion === typeVersionOf(s.seed.typeFile),
      'These corrections belong to a different category version.');
    const raw = readBody();
    requireValue(object(raw), 'A threshold decision is required.');
    exact(raw, ['direction', 'threshold']);
    requireValue(raw.direction === 'raise' || raw.direction === 'lower', 'Select a stored proposal.');
    const correction = s.corrections.get(correctionId);
    requireValue(correction && correction.runId === run.id, 'The correction does not exist.');
    const proposal = correction.proposals[raw.direction];
    requireValue(proposal && proposal.threshold === raw.threshold, 'Only the exact stored threshold proposal may be applied.');
    // S6: a repeated Apply is a specific, recoverable refusal, not a 500.
    if (s.thresholdHistory.some(row => row.correctionId === correctionId && row.direction === raw.direction))
      throw new ServerFailure('E_THRESHOLD_ALREADY_APPLIED', 'blocker', 'This suggestion has already been applied.');
    s.thresholdHistory.push({ id: randomUUID(), correctionId, direction: raw.direction, threshold: raw.threshold, at });
    if (active) {
      const thresholdStatus = appliedThresholdStatus({ threshold: active.threshold, status: active.status, justification: active.justification },
        { threshold: raw.threshold, correctionId });
      s.active = { ...active, threshold: raw.threshold, status: thresholdStatus, justification: correctionId };
      return { applied: true, threshold: raw.threshold, thresholdStatus, correctionId };
    }
    s.controls.threshold = raw.threshold;
    s.controls.justification = correctionId;
    return { applied: true, threshold: raw.threshold, correctionId };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Document progress (the Workflow's work, simulated)
  // -------------------------------------------------------------------------------------------------------------

  #event(run, fingerprint, stage, kind, details, at = this.now()) {
    run.events.push({ id: randomUUID(), createdAt: at, fingerprint, stage, kind, details: details ?? {} });
  }

  #autoAdvance(run) {
    const rule = this.autoAdvance;
    if (!rule) return;
    if (rule.runId && rule.runId !== run.id) return;
    this.advance(run.id, { steps: rule.steps ?? 1, concurrency: rule.concurrency });
  }

  /**
   * Moves the run's handed-over documents forward `steps` stages (a document enters one stage per step), at most
   * `concurrency` documents in flight at once. Vendor outputs, charges and events are recorded as each stage is
   * reached; the decision comes from the real `decide()`. A limited budget that is reached halts the run with
   * E_LIVE_BUDGET before the next vendor call, as the server does. Returns the run's status afterwards.
   */
  advance(runId, { steps = 1, concurrency = this.state.concurrency, at } = {}) {
    const run = this.state.runs.get(runId);
    if (!run) throw new Error(`advance(): no run ${runId}`);
    for (let step = 0; step < steps; step++) {
      if (run.status !== 'running') break;
      const time = at ?? this.now();
      const docs = [...run.docs.values()].sort(byTag).filter(doc => doc.status !== 'complete' && doc.workflowId !== null);
      let inFlight = docs.filter(doc => doc.phase !== 'waiting_to_start').length;
      for (const doc of docs) {
        if (run.status !== 'running') break;
        if (doc.phase === 'waiting_to_start') {
          if (inFlight >= (concurrency ?? Infinity)) continue;
          inFlight++;
        }
        this.#enterNext(run, doc, time);
      }
      if (run.status === 'running' && [...run.docs.values()].every(doc => doc.status === 'complete')) run.status = 'complete';
    }
    return run.status;
  }

  /** Advances until every handed-over document is decided (or the run stops). */
  finish(runId, options = {}) {
    for (let guard = 0; guard < 10_000; guard++) {
      const run = this.state.runs.get(runId);
      if (run.status !== 'running') return run.status;
      if (![...run.docs.values()].some(doc => doc.status !== 'complete' && doc.workflowId !== null)) return run.status;
      this.advance(runId, { ...options, steps: 1, concurrency: options.concurrency ?? Infinity });
    }
    throw new Error('finish(): the run did not settle.');
  }

  #admit(run, time) {
    const budget = readRunBudget(run.budget);
    const { halt, reached } = checkRunBudget(budget, spendOf(run));
    if (!halt) return true;
    this.#halt(run, { code: 'E_LIVE_BUDGET',
      message: `Recorded spending reached the run limit: ${reached.join(', ')}. Already submitted calls may still add charges.` }, time);
    return false;
  }

  /** Steps one document through its stages until it is decided (or the run stops). */
  #driveToDone(run, doc, time) {
    for (let guard = 0; guard < PIPELINE.length + 1 && doc.status !== 'complete' && run.status === 'running'; guard++)
      this.#enterNext(run, doc, time);
  }

  #enterNext(run, doc, time) {
    const plan = run.plans.get(doc.fingerprint) ?? this.#makePlan('R5', run.pack.typeFile.types.map(t => t.id), run.threshold);
    let next = PIPELINE[PIPELINE.indexOf(doc.phase) + 1];
    if (next === 'finding_headings' && !doc.needsOutlineRecovery) next = 'preparing_text';
    const typeIds = run.pack.typeFile.types.map(type => type.id);
    const outputs = () => synthesizeOutputs(plan, typeIds, run.threshold, doc.quotes, run.pack.pins, run.pack.typeFile);
    switch (next) {
      case 'starting':
        doc.status = 'running';
        this.#event(run, doc.fingerprint, 'started', 'started', {}, time);
        break;
      case 'finding_headings':
        this.#event(run, doc.fingerprint, 'recovery', 'vendor_call', { role: 'recovery' }, time);
        doc.notes = [...new Set([...doc.notes, 'N_OUTLINE_RECOVERED'])];
        break;
      case 'preparing_text':
        this.#event(run, doc.fingerprint, 'digest', 'completed', {}, time);
        break;
      case 'confidence_check':
        if (!this.#admit(run, time)) return;
        doc.confidence = outputs().confidence;
        run.spend.typesafe += this.state.costs.typesafe;
        this.state.lastVendorCall = { role: 'confidence', httpStatus: 200, at: time };
        this.#event(run, doc.fingerprint, 'confidence', 'vendor_call', { role: 'confidence', status: 200 }, time);
        break;
      case 'reader':
        if (!this.#admit(run, time)) return;
        run.spend.openai += this.state.costs.openai;
        this.state.lastVendorCall = { role: 'reader', httpStatus: 200, at: time };
        this.#event(run, doc.fingerprint, 'reader', 'vendor_call', { role: 'reader', status: 200 }, time);
        if (plan.rule === 'R0') {
          const failed = { code: 'E_READER_SCHEMA', message: 'Structured output is not valid JSON.' };
          doc.failure = failed;
          doc.decision = decide({ notePolicy: run.pack.settings.decisionNotePolicy, confidenceStatePolicy: run.pack.settings.confidenceStatePolicy,
            typeIds, threshold: run.threshold, failures: [failed.code], notes: doc.notes });
          doc.status = 'complete';
          doc.phase = 'done';
          this.#event(run, doc.fingerprint, 'document', 'failed', failed, time);
          run.manifest = null;
          return;
        }
        doc.reader = outputs().reader;
        break;
      case 'deciding':
        this.#event(run, doc.fingerprint, 'decide', 'completed', {}, time);
        break;
      case 'done': {
        const out = outputs();
        const notePolicy = plan.rule === 'R0n' ? 'all-notes-review-v1' : run.pack.settings.decisionNotePolicy;
        if (plan.rule === 'R0n') doc.notes = [...new Set([...doc.notes, 'N_NO_OUTLINE'])];
        doc.decision = decide({ notePolicy, confidenceStatePolicy: run.pack.settings.confidenceStatePolicy, typeIds,
          threshold: run.threshold, failures: [], notes: doc.notes, confidence: out.decisionConfidence, readerYes: out.readerYes });
        doc.status = 'complete';
        this.#event(run, doc.fingerprint, 'record-decision', 'completed', { ruleId: doc.decision.ruleId }, time);
        run.manifest = null;
        break;
      }
      default:
        return;
    }
    doc.phase = next;
  }

  /** Records an active provider pause (`provider_cooldown/waiting`) that S1 reports until `untilMs`. */
  providerWait(runId, scope, untilMs, at = this.now()) {
    const run = this.state.runs.get(runId);
    this.#event(run, null, 'provider_cooldown', 'waiting', { scope, until: untilMs }, at);
    return this;
  }

  /** Makes `/start` fail (and halt the run with E_WORKFLOW_START) for the given fingerprints, or all when omitted. */
  failStart(fingerprints) {
    const set = fingerprints ? new Set(fingerprints) : null;
    this.state.failStartFor = (_run, fingerprint) => !set || set.has(fingerprint);
    return this;
  }

  /** Halts a run with a recorded cause (e.g. E_WORKFLOW_INTERRUPTED). A halted run stays halted: nothing continues it. */
  haltRun(runId, code, message, at = this.now()) {
    this.#halt(this.state.runs.get(runId), { code, message }, at);
    return this;
  }

  /** Direct state access for assertions. */
  getRun(runId) { return this.state.runs.get(runId); }
  runIds() { return [...this.state.runs.keys()]; }

  // -------------------------------------------------------------------------------------------------------------
  // Scenario builders (SPEC §10.2): firstRun, run, stalledAt, handoverStalled, completed, linkedRun, killOn
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Walkthrough 3a's starting point: a brand-new website-managed workspace, the viewer an editor, no categories,
   * no runs (Health NOT READY with E_DEFINITIONS_EMPTY and E_TYPE_FILE). Returns the five originals of 3a: four
   * readable files and one scanned PDF ("Read 5 files: 4 ready, 1 could not be read"). Runs the page creates get
   * 2 filed and 2 for review from the default planner.
   */
  firstRun() {
    this.reset();
    return { files: corpus(5, { scanned: 1 }) };
  }

  /**
   * Makes sure categories are active, so Health is READY. With no `ids`, whatever is active stays (for example
   * categories the page created) and only an empty workspace gets Procedures, Explainers, Reports and Forms. With
   * `ids`, exactly those placeholder categories become active (a new revision if they differ). Idempotent.
   */
  categories(ids, { threshold, status } = {}) {
    const s = this.state;
    const current = s.active.revisionId ? s.revisions.get(s.active.revisionId) : null;
    if (s.definitionMode === 'git') {
      if (ids || !s.seed.typeFile.types.length) s.seed.typeFile = placeholderTypeFile(ids ?? ['procedures', 'explainers', 'reports', 'forms']);
      return this;
    }
    const wanted = !ids && current ? null : placeholderTypeFile(ids ?? ['procedures', 'explainers', 'reports', 'forms']);
    if (wanted && (!current || JSON.stringify(current.typeFile) !== JSON.stringify(wanted))) {
      const revision = this.#addRevision(wanted, Object.fromEntries(wanted.types.map(type => [type.id, type.name])),
        s.active.revisionId, this.now() - 7 * 86_400_000);
      this.#activateRevision(revision.id, false, this.now() - 7 * 86_400_000);
    }
    if (threshold !== undefined) s.active.threshold = threshold;
    if (status !== undefined) s.active.status = status;
    return this;
  }

  /**
   * A ready workspace (four placeholder categories) and `n` originals for the page to read (script 3: `run(114)`).
   * No server run is created: the page creates it.
   */
  run(n, { scanned = 0, categories } = {}) {
    this.categories(categories);
    return { files: corpus(n, { scanned }) };
  }

  /**
   * A run made directly in state, as if the page had quoted, created and uploaded it at `createdAt` and after.
   * `plans` are the outcome tokens of the readable files, in order. `uploaded` files are sent (1 per `step` ms);
   * then `dispatch` of them are handed over and `decided` of those are driven to a decision ('all' or a count).
   */
  #seedRun({ files, plans, mode = 'interactive', budget, createdAt, uploaded = files.length, dispatch = 'all',
    decided = 'all', referenceId = null, actor = this.state.actor, step = 1000 }) {
    const pack = this.#effectivePack();
    const quote = {
      id: randomUUID(), actor, createdAt, mode, typeVersion: typeVersionOf(pack.typeFile), packHash: this.#packHash(pack),
      documents: files.map(file => ({ fingerprint: file.fingerprint, originalFilename: file.name,
        tokenCounts: file.readable ? { ...NULL_COUNTS } : { ...ZERO_COUNTS }, needsOutlineRecovery: false, failed: !file.readable })),
      referenceId
    };
    this.state.quotes.set(quote.id, quote);
    const saved = this.state.planner;
    let planned = 0;
    const tokens = plans ?? null;
    this.state.planner = (doc, index, typeIds, runRecord) => (tokens ? tokens[planned++] : saved(doc, index, typeIds, runRecord));
    let run;
    try {
      run = this.#newRun({ quote, pack, at: createdAt, actor, files,
        budget: authorizeRunBudget(budget ?? { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false },
          actor, iso(createdAt)) });
    } finally {
      this.state.planner = saved;
    }
    let t = createdAt + step;
    files.slice(0, uploaded).forEach((file, index) => {
      const decision = file.readable ? null : decide({ notePolicy: pack.settings.decisionNotePolicy, confidenceStatePolicy: pack.settings.confidenceStatePolicy,
        typeIds: pack.typeFile.types.map(type => type.id), threshold: run.threshold, failures: ['E_NO_TEXT_LAYER'], notes: [] });
      this.#addDocument(run, {
        fingerprint: file.fingerprint, originalFilename: file.name, index, hash: `seeded:${file.fingerprint}`, body: null,
        extractor: file.readable ? EXTRACTOR_VERSION : null,
        extraction: file.readable ? { extractorVersion: EXTRACTOR_VERSION, parserVersions: { ...PARSER_VERSIONS }, needsOutlineRecovery: false } : null,
        decision, failure: file.readable ? null : { code: 'E_NO_TEXT_LAYER', message: 'Scanned document, no text layer.' },
        needsOutlineRecovery: false, quotes: file.quotes ?? []
      }, t);
      t += step;
    });
    run.seededUntil = t;
    // `dispatch`: false (still uploading), 'all', or how many documents were handed over.
    if (uploaded === files.length && dispatch !== false) {
      run.status = 'running';
      const open = [...run.docs.values()].sort(byTag).filter(doc => doc.status !== 'complete');
      for (const doc of open.slice(0, dispatch === 'all' ? open.length : dispatch)) this.#dispatch(run, doc);
      if (decided === 'all') {
        for (const doc of open) if (doc.workflowId !== null) this.#driveToDone(run, doc, (t += step));
      } else if (typeof decided === 'number') {
        for (const doc of open) {
          if ([...run.docs.values()].filter(item => item.status === 'complete').length >= decided) break;
          if (doc.workflowId !== null) this.#driveToDone(run, doc, (t += step));
        }
      }
      if (run.status === 'running' && [...run.docs.values()].every(doc => doc.status === 'complete')) run.status = 'complete';
    }
    run.seededUntil = t;
    return run;
  }

  #planTokens(files, outcomes, typeIds) {
    if (Array.isArray(outcomes)) return outcomes.filter((_, i) => files[i].readable);
    const readable = files.filter(file => file.readable).length;
    const counts = outcomes ?? { filed: Math.ceil(readable / 2), review: Math.floor(readable / 2) };
    const tokens = [];
    for (let i = 0; i < (counts.filed ?? 0); i++) tokens.push(`R1:${typeIds[i % typeIds.length]}`);
    const reviews = ['R5', 'R2', 'R4', 'R3'].filter(rule => rule !== 'R3' || typeIds.length > 1);
    for (let i = 0; i < (counts.review ?? 0); i++) tokens.push(reviews[i % reviews.length]);
    for (let i = 0; i < (counts.stageFailed ?? 0); i++) tokens.push('R0');
    if (tokens.length !== readable) throw new Error(`Outcome counts cover ${tokens.length} readable documents, but there are ${readable}.`);
    return tokens;
  }

  #filesFor(total, outcomes) {
    if (Array.isArray(outcomes))
      return corpus(outcomes.length).map((file, i) => (outcomes[i] === 'unreadable' ? syntheticFile('scanned-pdf', i + 1) : file));
    return corpus(total, { scanned: outcomes?.failed ?? 0 });
  }

  /**
   * A finished run (default 5 documents: 2 filed, 2 for review, 1 could not be read), with vendor outputs,
   * a results file and evidence. `outcomes` is `{filed, review, failed, stageFailed}` or an array of plan tokens
   * per document ('R1', 'R1:<id>', 'R2', 'R3', 'R4', 'R5', 'R0', 'R0n' or 'unreadable').
   * `status: 'closed'` closes it afterwards. Returns `{runId, files}`; the files match the fingerprints, so a
   * script can put the originals in OPFS for Build.
   */
  completed({ total, outcomes, files, mode = 'interactive', status = 'complete', budget, agoMs = 3_600_000,
    categories, pilot = false, unaccountedCalls = 0, pendingAccounting = 0 } = {}) {
    this.categories(categories);
    const typeIds = this.#effectivePack().typeFile.types.map(type => type.id);
    const counts = Array.isArray(outcomes) ? null : outcomes ?? (files || total ? null : { filed: 2, review: 2, failed: 1 });
    const count = total ?? (counts ? (counts.filed ?? 0) + (counts.review ?? 0) + (counts.failed ?? 0) + (counts.stageFailed ?? 0) : 5);
    const docs = files ?? this.#filesFor(count, Array.isArray(outcomes) ? outcomes : counts);
    const run = this.#seedRun({ files: docs, plans: this.#planTokens(docs, Array.isArray(outcomes) ? outcomes : counts ?? undefined, typeIds),
      mode, budget, createdAt: this.now() - agoMs });
    if(pilot)run.campaign={id:randomUUID(),role:'pilot'};
    run.unaccountedCalls = unaccountedCalls;
    run.pendingAccounting = pendingAccounting;
    if (status === 'closed') this.#close(run, run.seededUntil + 1000);
    return { runId: run.id, files: docs };
  }

  /**
   * Walkthrough 3b: an Interactive run of `total` documents whose sending stopped after `uploaded`, with the last
   * upload `lastUploadAgoMs` ago (default 41 minutes). Returns `{runId, files, uploaded: fingerprints}`.
   */
  stalledAt(uploaded = 13, total = 114, { lastUploadAgoMs = 41 * 60_000, mode = 'interactive', categories } = {}) {
    this.categories(categories);
    const files = corpus(total);
    const run = this.#seedRun({ files, mode, createdAt: this.now() - lastUploadAgoMs - uploaded * 1000, uploaded, dispatch: false });
    return { runId: run.id, files, uploaded: files.slice(0, uploaded).map(file => file.fingerprint) };
  }

  /**
   * Walkthrough 3b's hand-over variant: every document uploaded and the run `running`, but `undispatched` still
   * not handed over, with no change for well over 10 s. Returns `{runId, files}`.
   */
  handoverStalled(undispatched = 64, { total = 114, agoMs = 5 * 60_000, categories } = {}) {
    if (undispatched < 1 || undispatched > total) throw new Error('handoverStalled(n): 1 ≤ n ≤ total.');
    this.categories(categories);
    const files = corpus(total);
    const run = this.#seedRun({ files, createdAt: this.now() - agoMs, dispatch: total - undispatched, decided: 0, step: 100 });
    return { runId: run.id, files };
  }

  /** A run still sorting: `decided` of `total` have outcomes and the rest are spread over the stages. */
  sorting({ total = 114, decided = 73, categories, agoMs = 20 * 60_000 } = {}) {
    this.categories(categories);
    const files = corpus(total);
    const run = this.#seedRun({ files, createdAt: this.now() - agoMs, decided, step: 100 });
    // Spread the rest: a few documents at each stage, the others waiting their turn.
    const open = [...run.docs.values()].sort(byTag).filter(doc => doc.status !== 'complete');
    const at = run.seededUntil;
    open.forEach((doc, index) => {
      const target = ['reader', 'confidence_check', 'preparing_text', 'starting'][Math.floor(index / 3)];
      for (let guard = 0; target && doc.phase !== target && guard < PIPELINE.length && run.status === 'running'; guard++)
        this.#enterNext(run, doc, at + index);
    });
    return { runId: run.id, files };
  }

  /**
   * Walkthrough 3c: a run linked to saved answers from `source` (a runId or a builder result). If the source has
   * no saved review, one is made: every file left where it was filed and every folder ticked, apart from
   * `moves` ([{index, to}] into another category folder). Answers are saved against the active category version,
   * with `either` ([{index, labels: [a, b]}]) and `leaveOut` ([index]) as marked by the owner. The new run has the
   * same documents; `differ` of the answered automatic filings go elsewhere. `status` 'complete' (default) or
   * 'running' (with `decided`). Returns `{runId, sourceRunId, correctionId, referenceId}`.
   */
  linkedRun(source, { moves = [], either = [], leaveOut = [], differ = 0, status = 'complete', decided, agoMs = 10 * 60_000 } = {}) {
    const sourceRunId = typeof source === 'string' ? source : source.runId;
    const src = this.state.runs.get(sourceRunId);
    if (!src || !['complete', 'closed'].includes(src.status)) throw new Error('linkedRun(): the source run must be complete.');
    const entries = [...src.docs.values()].sort(byTag);
    const typeIds = src.pack.typeFile.types.map(type => type.id);
    let correction = [...this.state.corrections.values()].filter(c => c.runId === sourceRunId).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!correction) {
      const moved = new Map(moves.map(move => [entries[move.index].fingerprint, move.to]));
      const files = entries.map(doc => ({ folder: moved.get(doc.fingerprint) ?? doc.decision.destinationFolder,
        filename: `${doc.tag}--${doc.originalFilename}`, tag: doc.tag }));
      const checkedFolders = [...new Set(files.map(file => file.folder))].sort();
      const saved = this.#saveCorrection(src, { files, checkedFolders, sidecarPaths: [], folderDecisions: [] }, this.now() - agoMs - 60_000);
      correction = this.state.corrections.get(saved.correctionId);
    }
    const labels = [
      ...either.map(item => ({ fingerprint: entries[item.index].fingerprint, status: 'ambiguous', labels: item.labels })),
      ...leaveOut.map(index => ({ fingerprint: entries[index].fingerprint, status: 'excluded', labels: [] }))
    ];
    const reference = this.#saveReference(src, correction.id, { definitionRevisionId: this.state.active.revisionId, labels },
      this.now() - agoMs - 30_000);
    const quoted = new Map(this.state.quotes.get(src.quoteId).documents.map(doc => [doc.fingerprint, doc]));
    const files = entries.map(doc => src.files.get(doc.fingerprint) ??
      { name: doc.originalFilename, fingerprint: doc.fingerprint, readable: !quoted.get(doc.fingerprint).failed, quotes: doc.quotes });
    let differing = differ;
    const plans = [];
    reference.entries.forEach((entry, index) => {
      if (!files[index].readable) return;
      if (entry.status === 'label' && entry.previousRule === 'R1' && differing > 0 && typeIds.length > 1) {
        differing--;
        plans.push(`R1:${typeIds.find(id => id !== entry.labels[0])}`);
      } else if (entry.status === 'label') plans.push(`R1:${entry.labels[0]}`);
      else if (entry.status === 'ambiguous') plans.push(`R1:${entry.labels[0]}`);
      else plans.push(entry.previousRule === 'R1' ? `R1:${entries[index].decision.destinationFolder}` : 'R5');
    });
    const run = this.#seedRun({ files, plans, createdAt: this.now() - agoMs, referenceId: reference.id,
      decided: status === 'complete' ? 'all' : (decided ?? Math.floor(files.length / 2)) });
    return { runId: run.id, sourceRunId, correctionId: correction.id, referenceId: reference.id };
  }

  /** The emergency stop is on: every uploading or running run (anyone's) is halted with E_KILL_SWITCH. */
  killOn() {
    this.#setKill(true);
    return this;
  }

  /** The workspace variants a script may want (all fake-only switches). */
  nonEditor() { this.state.editor = false; return this; }
  gitMode(ids = ['procedures', 'explainers']) {
    this.state.definitionMode = 'git';
    this.state.seed.typeFile = placeholderTypeFile(ids);
    return this;
  }
  addBlocker(code, headline, details) { this.state.extraBlockers.push({ code, headline, details }); return this; }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const byTag = (a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

const pilotChoiceOf = run => run.pilotSkipped === true ? { pilotSkipped: true } : {};
const variantHeadersOf = run => frozenRunPolicies({ pack_json: JSON.stringify(run.pack) });

/** Same computed refusal as server admission and the editor; the fake never invents a capacity. */
function requireCapacity(pack) {
  const refusal = capacityRefusal(pack, pack.typeFile);
  if (refusal) throw new ServerFailure('E_CATEGORY_CAPACITY', 'request', refusal.sentence, 409);
}

function spendOf(run) {
  return { blended: (run.spend.openai + run.spend.typesafe).toString(), openai: run.spend.openai.toString(),
    typesafe: run.spend.typesafe.toString() };
}

function rejectFeedback(message) {
  throw new ServerFailure('E_FEEDBACK_REFERENCE', 'request', message);
}

function validateLineage(expected, actual) {
  if (!expected || expected !== actual) rejectFeedback('This run must use the category version confirmed with its feedback.');
}

/** `core/server/contracts.ts` jsonBody, over bytes. */
function jsonBody(headers, bytes) {
  requireValue(String(headers['content-type'] ?? '').split(';')[0].trim() === 'application/json',
    'Only JSON text and outline requests are accepted.');
  requireValue(bytes.length > 0, 'A request body is required.');
  if (bytes.length > UPLOAD_BODY_LIMIT_BYTES)
    throw new ServerFailure('E_REQUEST_MEMORY', 'request', 'The JSON request exceeds the Worker memory-safe upload envelope.', 413);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ServerFailure('E_REQUEST_JSON', 'request', 'The request is not valid JSON.');
  }
}

/** SPEC §9 S3 `readOptionalJson`: undefined for an empty body, null for unparsable input; never throws. */
function readOptionalJson(bytes) {
  if (!bytes.length) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function recordBody(bytes, headers) {
  if (!bytes.length) return undefined;
  const text = new TextDecoder().decode(bytes);
  if (String(headers['content-type'] ?? '').includes('json')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

/** Whole lines of the extracted text that make good verbatim quotes. */
function quotesFrom(fullText) {
  return String(fullText).split('\n').map(line => line.trim())
    .filter(line => !/^\[(?:Page|Slide) \d+\]$/.test(line) && line.split(/\s+/).length >= 5).slice(0, 3);
}

const round = (value, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Synthetic vendor outputs that make the real rules give `plan.rule`. Separate outputs; never blended.
 * `readerYes` and `decisionConfidence` are the decide() inputs derived from them.
 */
function synthesizeOutputs(plan, typeIds, threshold, quotes, pins, typeFile) {
  const t = plan.typeId, u = plan.otherTypeId;
  const nouls = Object.fromEntries(typeIds.map(id => [id, 0.08]));
  let choice = t, certainty, yes;
  const given = plan.certainty ?? null;
  switch (plan.rule) {
    case 'R1': certainty = given ?? round(Math.min(0.99, threshold + 0.06), 2); nouls[t] = 0.93; yes = [t]; break;
    case 'R2': certainty = given ?? round(Math.max(0.3, threshold - 0.18), 2); nouls[t] = 0.81; yes = [t]; break;
    case 'R3': certainty = given ?? 0.62; nouls[t] = 0.7; nouls[u] = 0.66; yes = [t, u]; break;
    case 'R4': choice = 'none_of_these'; certainty = given ?? 0.55; yes = []; break;
    case 'R0n': certainty = given ?? round(Math.min(0.99, threshold + 0.06), 2); nouls[t] = 0.93; yes = [t]; break;
    default: certainty = given ?? 0.77; nouls[t] = 0.72; yes = u ? [u] : []; break; // R5 (and R0 up to its failure)
  }
  const options = [...typeIds, 'none_of_these'];
  const rest = round((1 - certainty) / (options.length - 1));
  const probabilities = Object.fromEntries(options.map(id => [id, id === choice ? certainty : rest]));
  const name = id => typeFile?.types.find(type => type.id === id)?.name ?? id;
  const quote = quotes?.[0];
  // The model ids come from the run's pins only: a missing pin is not replaced by a name (AGENTS §4), so the
  // strict wire check reports it. `#makePlan` passes no pins; it reads only the decide() inputs.
  const reader = {
    model: pins?.reader?.id ?? null,
    verdicts: typeIds.map(id => ({
      type_id: id,
      is_type: yes.includes(id),
      rationale: yes.includes(id)
        ? `The text reads like ${name(id)}: it matches what belongs there.`
        : `The text does not match what belongs in ${name(id)}.`,
      evidence: yes.includes(id) && quote ? [quote] : [],
      closest_alternative: typeIds.find(other => other !== id && (yes.includes(other) || other === t)) ?? null
    }))
  };
  const confidence = { model: pins?.confidence?.id ?? null, choice, probabilities, confidence: certainty, nouls };
  return { confidence, reader, readerYes: yes, decisionConfidence: { choice, certainty, noul: nouls } };
}

function routeName(method, path) {
  const p = path.replace(/^\/api\//, '');
  if (method === 'GET' && p === 'health') return 'health';
  if (method === 'GET' && p === 'project') return 'project';
  if (method === 'GET' && p === 'usage') return 'usage';
  if (method === 'GET' && p === 'definitions') return 'definitions';
  if (method === 'POST' && p === 'definitions/drafts') return 'draft';
  if (method === 'POST' && /^definitions\/[^/]+\/activate$/.test(p)) return 'activate';
  if (method === 'GET' && /^feedback\/[^/]+$/.test(p)) return 'reference';
  if (method === 'POST' && /^feedback\/[^/]+\/carry$/.test(p)) return 'reference';
  if (method === 'POST' && p === 'quote') return 'quote';
  if (method === 'POST' && p === 'runs') return 'runCreated';
  if (method === 'GET' && p === 'runs') return 'runList';
  if (method === 'POST' && p === 'kill') return 'kill';
  const run = /^runs\/[^/]+(?:\/(.*))?$/.exec(p);
  if (!run) return 'unknown';
  const action = run[1] ?? '';
  if (method === 'GET' && action === '') return 'snapshot';
  if (method === 'GET' && action === 'status') return 'status';
  if (method === 'GET' && action === 'plan') return 'plan';
  if (method === 'GET' && /^documents\/[^/]+\/evidence$/.test(action)) return 'evidence';
  if (method === 'POST' && action === 'documents') return 'upload';
  if (method === 'POST' && action === 'start') return 'start';
  if (method === 'POST' && action === 'observe-runtime') return 'runtimeObserved';
  if (method === 'POST' && action === 'close') return 'close';
  if (method === 'GET' && action === 'pilot') return 'pilot';
  if (method === 'POST' && action === 'pilot-review') return 'pilotVerdict';
  if (method === 'POST' && action === 'pilot-confirmation') return 'pilotConfirmation';
  if (method === 'GET' && action === 'results/compact') return 'compactResults';
  if (method === 'GET' && action === 'results/pages') return 'resultsPage';
  if (method === 'GET' && action === 'results') return 'results';
  if (method === 'GET' && action === 'manifest') return 'results';
  if (method === 'GET' && action === 'corrections') return 'correctionList';
  if (method === 'POST' && action === 'corrections') return 'correctionSaved';
  if (method === 'GET' && /^corrections\/[^/]+$/.test(action)) return 'correction';
  if (method === 'POST' && /^corrections\/[^/]+\/reference$/.test(action)) return 'reference';
  if (method === 'GET' && action === 'comparison') return 'comparison';
  if (method === 'POST' && /^corrections\/[^/]+\/apply$/.test(action)) return 'apply';
  return 'unknown';
}

/** The wire.ts guard each 2xx body must pass (R11 and R15 have none: the new UI does not read them). */
const GUARDS = {
  pilot:readPilot,pilotVerdict:readPilotVerdict,pilotConfirmation:readPilotConfirmation,
  health: wire.readHealth, usage: wire.readUsage, project: wire.readProject, definitions: wire.readDefinitions, draft: wire.readRevision,
  activate: wire.readActivation, reference: wire.readReferenceRecord, quote: wire.readQuote,
  runCreated: wire.readRunCreated, runList: wire.readRunList, kill: wire.readEmergencyStop,
  status: wire.readRunStatus, plan: wire.readPlan, evidence: wire.readEvidence, upload: wire.readUploaded,
  start: wire.readStarted, runtimeObserved: wire.readRuntimeObserved, close: wire.readClosed, results: wire.readResults,
  compactResults: wire.readCompactResults, resultsPage: wire.readResultsPage,
  correctionList: wire.readCorrectionList, correctionSaved: wire.readCorrectionSaved, correction: wire.readCorrection,
  comparison: wire.readComparison, apply: wire.readThresholdApplied
};

// ---------------------------------------------------------------------------------------------------------------
// Transport: Node/Connect middleware (used by app.mjs as a Vite plugin)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Serves `/api/*` from the current fake. `getFake()` is read per request, so a script may swap fakes between
 * scenarios without restarting Vite. Anything else goes to `next()` (Vite), and so does every request for which
 * `passThrough(url)` is true: app.mjs passes the files Vite serves from the app root, because with root `ui/app`
 * the app's own modules `ui/app/api/*.ts` are requested as `/api/<file>.ts` and must never reach the fake.
 * @param {() => FakeApi | null} getFake
 * @param {{ passThrough?: (url: string) => boolean }} [options]
 */
export function fakeApiMiddleware(getFake, { passThrough = () => false } = {}) {
  return async (req, res, next) => {
    const url = req.url ?? '/';
    if (!url.startsWith('/api/') && url !== '/api') return next();
    if (passThrough(url)) return next();
    const fake = getFake();
    if (!fake) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'E_FAKE_UNSET', kind: 'blocker', headline: 'No fake API is installed.', action: 'Install one with app.setFake().', details: { message: '' } } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let result;
    try {
      result = await fake.handle({
        method: req.method, url, headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)),
        origin: `http://${req.headers.host}`, isConnected: () => !req.socket.destroyed && !res.writableEnded
      });
    } catch (error) {
      // A bug in the fake itself: answer loudly rather than hang the page.
      fake.internalErrors.push({ path: url, message: String(error?.message ?? error), stack: error?.stack ?? null });
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
      res.end(`ui-harness fake API failed: ${error?.stack ?? error}`);
      return;
    }
    if (result.network) { req.socket.destroy(); return; }
    if (result.dropped || req.socket.destroyed) return;
    res.statusCode = result.status;
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    res.end(result.body);
  };
}
