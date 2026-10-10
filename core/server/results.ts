import { runDecisionNotePolicy, type ProjectPack } from '../config/project.ts';
import type { ConfidenceOutput, ReaderOutput } from '../vendors/validate.ts';
import type { Decision } from '../domain/decision.ts';
import type { BuilderManifest, BuilderEntry, BuilderFailure } from '../builder/builder.ts';
import { Store, type RunRow } from './store.ts';
import { validateManifestReady, requireValue } from './contracts.ts';
import { serverCopy, ServerFailure } from './errors.ts';
import { runVendors } from '../vendors/outbound.ts';
import { pilotSkippedOf, frozenRunPolicies } from './run-status-read.ts';
import { bakeoffOf } from './bakeoff.ts';
import { readReaderVersion } from './reader-version.ts';

/** Written at decision time (migration 0017): the decision's model inputs, so results need no model-output reads. */
export interface DocumentSummary {
  choice: string;
  certainty: number;
  noul: Record<string, number>;
  readerYes: string[]
}

/** One document in the compact results (`GET /results/compact`): identity, outcome and the decision's inputs only. */
export interface CompactEntry {
  fingerprint: string;
  originalFilename: string;
  tag: string;
  ordinal: number | null;
  destinationFolder: string;
  rule: string;
  reasoningNote: string;
  confidenceCheck: { choice: string; certainty: number; noul: Record<string, number> } | null;
  readerYes: string[] | null;
  extraction: unknown;
  notes: string[];
  outlineRecovered: boolean
}

/** Today's full entry: what `GET /results`, `GET /manifest` and the builder read. */
export interface FullEntry extends BuilderEntry {
  vendorOutputs: { confidence: ConfidenceOutput | null; reader: ReaderOutput | null };
  extraction: unknown;
  notes: string[];
  outlineRecovered: boolean
}

export interface PageEntry extends FullEntry { ordinal: number }

/** The columns results and corrections read; `store.documents()` is not used so this query stays bounded to them. */
export interface ResultRow {
  fingerprint: string;
  tag: string;
  original_filename: string;
  ordinal: number | null;
  decision_json: string | null;
  failure_json: string | null;
  notes_json: string;
  extraction_json: string | null;
  summary_json: string | null;
  confidence_key: string | null;
  reader_key: string | null;
  digest_key: string | null
}

const RESULT_COLUMNS =
  'fingerprint,tag,original_filename,ordinal,decision_json,failure_json,notes_json,extraction_json,summary_json,confidence_key,reader_key,digest_key';

interface RunCounts {
  total: number;
  decided: number;
  unordered: number;
  maxOrdinal: number | null;
  /** Decided documents without a summary whose model outputs must be read back: old runs only (see `summaryOf`). */
  fallback: number
}

export const RESULTS_VERSION = 2;
/** The most full entries one page carries, whatever the category count. */
export const PAGE_LIMIT_MAX = 300;
/** A page of full entries stays under about this many bytes of JSON. */
export const PAGE_BYTES_BUDGET = 8_000_000;
/**
 * Old runs (no summary) read two model outputs per decided document. The bound keeps one request far inside the
 * 1,000-subrequest cap; every run decided before summaries existed has at most 114 documents.
 */
export const SUMMARY_FALLBACK_MAX = 450;

/**
 * Bytes of results JSON per full entry, from the 25 September 2026 measurement of the results file (`.local/qa/scale/
 * walls.json`, item 7): 2,900 bytes per document at 4 categories and 24,750 at 50, i.e. about 1,000 bytes fixed
 * (identity, outcome, reasoning note, extraction metadata, notes) plus about 475 per category (a Noul and a probability,
 * and the reader's verdict with rationale and quotes, which appears twice: in `vendorOutputs.reader` and in `reader[]`).
 */
export const entryBytes = (categories: number): number => 1_000 + 475 * categories;

/** Full entries per page for a run with `categories` categories. 4 categories: 300 per page; 50: 300; 254: 65. */
export function pageBudget(categories: number): number {
  return Math.max(1, Math.min(PAGE_LIMIT_MAX, Math.floor(PAGE_BYTES_BUDGET / entryBytes(categories))));
}

/**
 * The single results file (`GET /results`, `GET /manifest`) stays within one request's subrequests (two model-output
 * reads per document) and within the isolate's memory: the JSON text stays under about 40 MB, the object graph built
 * from it being a few times larger inside the 128 MB isolate. 4 categories: 450; 50: 450; 254: 328.
 */
export const LEGACY_BYTES_BUDGET = 40_000_000;
export function legacyBudget(categories: number): number {
  return Math.max(1, Math.min(SUMMARY_FALLBACK_MAX, Math.floor(LEGACY_BYTES_BUDGET / entryBytes(categories))));
}

const packOf = (run: RunRow) => JSON.parse(run.pack_json) as ProjectPack;
const categoriesOf = (run: RunRow) => packOf(run).typeFile.types.length;

async function countsFor(store: Store, runId: string): Promise<RunCounts> {
  const row = await store.env.DB.prepare(
    'SELECT COUNT(*) AS total,COALESCE(SUM(decision_json IS NOT NULL),0) AS decided,COALESCE(SUM(ordinal IS NULL),0) AS unordered,MAX(ordinal) AS maxOrdinal,' +
    'COALESCE(SUM(decision_json IS NOT NULL AND summary_json IS NULL AND failure_json IS NULL AND (confidence_key IS NOT NULL OR reader_key IS NOT NULL)),0) AS fallback ' +
    'FROM documents WHERE run_id=?'
  ).bind(runId).first<RunCounts>();
  if (!row) throw new ServerFailure('E_STORAGE_D1', 'blocker', 'The document counts could not be read.');
  return row;
}

/** 409 until every expected document has an outcome; the same rule for every results endpoint. */
async function readyCounts(store: Store, run: RunRow): Promise<RunCounts> {
  const counts = await countsFor(store, run.id);
  validateManifestReady(run.status, run.expected_count, counts.decided);
  return counts;
}

async function resultRows(store: Store, runId: string): Promise<ResultRow[]> {
  return (await store.env.DB
    .prepare(`SELECT ${RESULT_COLUMNS} FROM documents WHERE run_id=? ORDER BY ordinal,tag`)
    .bind(runId)
    .all<ResultRow>()).results;
}

function outcome(row: ResultRow) {
  const decision = JSON.parse(row.decision_json!) as Decision, notes = JSON.parse(row.notes_json) as string[];
  return {
    decision,
    notes,
    extraction: row.extraction_json ? JSON.parse(row.extraction_json) as unknown : null,
    outlineRecovered: notes.includes('N_OUTLINE_RECOVERED')
  };
}

const confidenceCheckOf = (confidence: ConfidenceOutput) => ({
  choice: confidence.choice, certainty: confidence.confidence, noul: { ...confidence.nouls }
});
const readerYesOf = (reader: ReaderOutput) => reader.verdicts.filter(v => v.is_type).map(v => v.type_id);

/** The stored model outputs of one document, as today's full entry reads them (two R2 reads). */
async function vendorOutputs(store: Store, row: ResultRow) {
  return {
    confidence: row.confidence_key
      ? (await store.json<{ value: ConfidenceOutput }>(row.confidence_key)).value
      : null,
    reader: row.reader_key ? (await store.json<{ value: ReaderOutput }>(row.reader_key)).value : null
  };
}

/**
 * The decision's inputs. New runs carry them in `summary_json`. A document decided before summaries existed reads its
 * stored outputs back. A failure-path document records no summary (its decision took no model input, 3a), so the
 * compact entry carries none even when an earlier call succeeded; the evidence endpoint serves that output on demand.
 */
async function summaryOf(store: Store, row: ResultRow): Promise<Pick<CompactEntry, 'confidenceCheck' | 'readerYes'>> {
  if (row.summary_json) {
    const summary = JSON.parse(row.summary_json) as DocumentSummary;
    return {
      confidenceCheck: { choice: summary.choice, certainty: summary.certainty, noul: summary.noul },
      readerYes: summary.readerYes
    };
  }
  if (row.failure_json !== null) return { confidenceCheck: null, readerYes: null };
  const outputs = await vendorOutputs(store, row);
  return {
    confidenceCheck: outputs.confidence ? confidenceCheckOf(outputs.confidence) : null,
    readerYes: outputs.reader ? readerYesOf(outputs.reader) : null
  };
}

async function compactEntry(store: Store, row: ResultRow): Promise<CompactEntry> {
  const { decision, notes, extraction, outlineRecovered } = outcome(row);
  const summary = await summaryOf(store, row);
  return {
    fingerprint: row.fingerprint,
    originalFilename: row.original_filename,
    tag: row.tag,
    ordinal: row.ordinal,
    destinationFolder: decision.destinationFolder,
    rule: decision.ruleId,
    reasoningNote: serverCopy.reasons[decision.reasonCode],
    confidenceCheck: summary.confidenceCheck,
    readerYes: summary.readerYes,
    extraction,
    notes,
    outlineRecovered
  };
}

/** Key order is the results file's byte order and is kept as it was. */
async function fullEntry(store: Store, row: ResultRow): Promise<FullEntry> {
  const { decision, notes, extraction, outlineRecovered } = outcome(row);
  const { confidence, reader } = await vendorOutputs(store, row);
  return {
    vendorOutputs: { confidence, reader },
    extraction,
    notes,
    outlineRecovered,
    fingerprint: row.fingerprint,
    originalFilename: row.original_filename,
    tag: row.tag,
    destinationFolder: decision.destinationFolder,
    rule: decision.ruleId,
    reasoningNote: serverCopy.reasons[decision.reasonCode],
    confidenceCheck: confidence ? confidenceCheckOf(confidence) : null,
    reader: reader ? reader.verdicts.map(v => ({
      typeId: v.type_id,
      isType: v.is_type,
      rationale: v.rationale,
      evidence: [...v.evidence],
      closestAlternative: v.closest_alternative
    })) : null
  };
}

/** The run-level fields every results shape carries after `entries`, in today's order. */
async function runHeader(store: Store, run: RunRow) {
  const pack = packOf(run);
  return {
    unknownSpendPolicy: pack.settings.unknownSpendPolicy ?? 'halt-on-unknown-v1',
    spending: {
      knownSubtotal: await store.spendForResults(run.id),
      unresolvedCalls: await store.unaccountedForResults(run.id),
      pendingAccounting: await store.pendingAccounting(run.id)
    },
    readerEvidencePolicy: pack.settings.readerEvidencePolicy ?? 'exact-substring-v1',
    definitionRevisionId: pack.definitionRevisionId,
    displayNames: pack.displayNames,
    definitionThresholdStatus: pack.definitionThresholdStatus,
    thresholdJustification: run.threshold_justification,
    decisionNotePolicy: runDecisionNotePolicy(pack.settings),
    confidenceStatePolicy: pack.settings.confidenceStatePolicy,
    ...frozenRunPolicies(run),
    pins: pack.pins,
    // A DeepSeek run's version as recorded at its first start (owner, 7 October 2026); absent for every other run.
    ...await readReaderVersion(store.env.DB, run),
    typeVersion: run.type_version,
    threshold: run.threshold,
    mode: run.mode,
    runNotes: JSON.parse(run.notes_json) as string[],
    // Present only for a run made under a pretend-vendor build: its results say so in every shape.
    ...runVendors(JSON.parse(run.notes_json) as string[]),
    // Present only for a run the person started without a pilot (DECISIONS 88): likewise in every shape.
    ...pilotSkippedOf(run),
    ...bakeoffOf(run)
  };
}

const documentNotes = (rows: ResultRow[]) => rows.map(row => ({
  fingerprint: row.fingerprint,
  notes: JSON.parse(row.notes_json) as string[],
  failure: row.failure_json ? JSON.parse(row.failure_json) as BuilderFailure : null
}));

/**
 * The compact entries of a complete run and the rows they came from (same order), for the compact results and for
 * corrections. One D1 statement for the rows; model outputs are read back only for documents without a summary.
 */
export async function compactRun(store: Store, run: RunRow): Promise<{ counts: RunCounts; rows: ResultRow[]; entries: CompactEntry[] }> {
  const counts = await readyCounts(store, run);
  if (counts.fallback > SUMMARY_FALLBACK_MAX) throw new ServerFailure('E_RESULTS_FALLBACK_LIMIT', 'blocker',
    `${counts.fallback} documents of this run were decided without a stored summary; reading their model outputs back would exceed one request.`);
  const rows = await resultRows(store, run.id);
  const entries: CompactEntry[] = [];
  for (const row of rows) entries.push(await compactEntry(store, row));
  return { counts, rows, entries };
}

/** GET /api/runs/:id/results/compact */
export async function compactResults(store: Store, run: RunRow) {
  const { rows, entries } = await compactRun(store, run);
  return {
    runId: run.id,
    resultsVersion: RESULTS_VERSION,
    entries,
    ...await runHeader(store, run),
    notes: documentNotes(rows)
  };
}

/** A whole number from a query parameter, or a plain refusal; never a silent default for a malformed value. */
function wholeNumber(value: string | null, name: string, fallback: number, minimum: number): number {
  if (value === null) return fallback;
  requireValue(/^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum,
    `The ${name} parameter must be a whole number${minimum > 0 ? ` of at least ${minimum}` : ''}.`);
  return Number(value);
}

/** GET /api/runs/:id/results/pages?after=<ordinal>&limit=<n>: full entries in ordinal order, keyset by ordinal. */
export async function resultPages(store: Store, run: RunRow, query: { after: string | null; limit: string | null }) {
  const counts = await readyCounts(store, run);
  if (counts.unordered > 0) throw new ServerFailure('E_RESULTS_UNORDERED', 'blocker',
    'Some documents of this run have no recorded order, so its results cannot be paged.');
  const cap = pageBudget(categoriesOf(run));
  const after = wholeNumber(query.after, 'after', 0, 0);
  const limit = Math.min(cap, wholeNumber(query.limit, 'limit', cap, 1));
  const rows = (await store.env.DB
    .prepare(`SELECT ${RESULT_COLUMNS} FROM documents WHERE run_id=? AND ordinal>? ORDER BY ordinal LIMIT ?`)
    .bind(run.id, after, limit)
    .all<ResultRow>()).results;
  const entries: PageEntry[] = [];
  for (const row of rows) entries.push({ ...await fullEntry(store, row), ordinal: row.ordinal! });
  const last = entries.at(-1);
  const next = !last || entries.length < limit || last.ordinal >= (counts.maxOrdinal ?? 0) ? null : last.ordinal;
  return {
    runId: run.id, resultsVersion: RESULTS_VERSION, entries, next,
    ...frozenRunPolicies(run),
    ...runVendors(JSON.parse(run.notes_json) as string[]), ...pilotSkippedOf(run), ...bakeoffOf(run)
  };
}

/** Validate a recorded file against immutable D1 identities/outcomes; never repair or replace the saved bytes. */
async function readRecordedManifest(store: Store, run: RunRow, counts: RunCounts): Promise<BuilderManifest> {
  const refuse = (): never => { throw new ServerFailure('E_RESULTS_CACHE_INCONSISTENT', 'blocker', serverCopy.cachedResultsMismatch); };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  let saved: unknown;
  try { saved = await store.json<unknown>(run.manifest_key!); }
  catch (error) { if (error instanceof SyntaxError) return refuse(); throw error; }
  if (!record(saved) || saved.runId !== run.id || !Array.isArray(saved.entries) ||
      saved.entries.length !== counts.total || counts.total !== run.expected_count) return refuse();
  // Ordinary historical absence remains absent; an experiment's saved copy must preserve its exact provenance.
  if (JSON.stringify(saved.bakeoff) !== JSON.stringify(bakeoffOf(run).bakeoff)) return refuse();
  // These fields predate the optional policy headers, but older files may omit them. Do not invent them.
  for (const [name, expected] of Object.entries({typeVersion: run.type_version, threshold: run.threshold, mode: run.mode}))
    if (Object.hasOwn(saved, name) && saved[name] !== expected) return refuse();
  type Identity = Pick<ResultRow, 'fingerprint' | 'tag' | 'original_filename' | 'decision_json'>;
  const rows = (await store.env.DB.prepare('SELECT fingerprint,tag,original_filename,decision_json FROM documents WHERE run_id=?')
    .bind(run.id).all<Identity>()).results;
  if (rows.length !== counts.total) return refuse();
  const remaining = new Map(rows.map(row => [row.fingerprint, row]));
  for (const entry of saved.entries) {
    if (!record(entry) || typeof entry.fingerprint !== 'string') return refuse();
    const row = remaining.get(entry.fingerprint);
    if (!row || entry.tag !== row.tag || entry.originalFilename !== row.original_filename || row.decision_json === null) return refuse();
    const decision = JSON.parse(row.decision_json) as Decision;
    if (entry.rule !== decision.ruleId || entry.destinationFolder !== decision.destinationFolder) return refuse();
    remaining.delete(entry.fingerprint);
  }
  if (remaining.size) return refuse();
  return saved as unknown as BuilderManifest;
}

/**
 * Today's full results file (`GET /results`, `GET /manifest`), unchanged for a run within `legacyBudget`; a file already
 * built and recorded on the run is served at its recorded size after one object read and a D1 identity check. A larger run is refused whole: the file is never
 * partial, and the pages endpoint serves it in parts.
 */
export async function manifestFor(store: Store, run: RunRow): Promise<BuilderManifest> {
  const counts = await readyCounts(store, run);
  if (run.manifest_key) return readRecordedManifest(store, run, counts);
  if (counts.total > legacyBudget(categoriesOf(run))) throw new ServerFailure('E_RESULTS_TOO_LARGE', 'request',
    'This run has too many documents for a single results file; use "Save a copy" in the app instead.', 413);
  const rows = await resultRows(store, run.id);
  const entries: FullEntry[] = [];
  for (const row of rows) entries.push(await fullEntry(store, row));
  const value = {
    runId: run.id,
    entries,
    ...await runHeader(store, run),
    notes: documentNotes(rows)
  };
  const key = await store.put(run.id, null, 'manifest', value);
  await store.env.DB.prepare('UPDATE runs SET manifest_key=? WHERE id=? AND manifest_key IS NULL')
    .bind(key, run.id).run();
  return value;
}
