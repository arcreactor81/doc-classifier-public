import type { CorrectionDiff, CorrectionManifestEntry } from '../correction/diff.ts';
import {
  buildReference,
  type LabelDecision,
  type ReferenceEntry
} from '../correction/reference.ts';
import { compareReference } from '../correction/comparison.ts';
import type { CorrectionProposals } from '../correction/proposals.ts';
import { Store, now, type RunRow } from './store.ts';
import { ServerFailure } from './errors.ts';
import type { ProjectPack } from '../config/project.ts';
import { capsExempt } from '../config/definitions.ts';
import { dailyRecordPredicate, requireDailyRecordAdmission, type DailyRecordAdmission } from './daily-allowance.ts';

/** A reference without its labels: what a quote or a new run needs to check lineage. */
export interface ReferenceHead {
  id: string;
  sourceRunId: string;
  correctionId: string;
  definitionRevisionId: string;
  /** The reference these labels were carried from unchanged, or null for labels confirmed directly. */
  carriedFrom: string | null
}

export interface ReferenceRecord extends ReferenceHead {
  entries: ReferenceEntry[]
}

interface ReferenceRow {
  id: string;
  source_run_id: string;
  correction_id: string;
  definition_revision_id: string;
  confirmed_by: string;
  carried_from: string | null
}

/** Entries per `INSERT … SELECT FROM json_each(?)` statement; each bound value stays far below D1's 2,000,000 bytes. */
const LABEL_CHUNK = 2_000;

/**
 * F3 (independent review, 7 October 2026): saved and carried labels share one allowance per person per UTC day, under
 * the usage limits frozen on the labels' source run (a run frozen without them has none); editors and trusted users are
 * exempt (DECISIONS 150). Counted inside the reference insert; the label rows are written only beside an inserted reference.
 */
function referenceAllowance(env: Env, sourceRun: Pick<RunRow, 'pack_json'>, actor: string) {
  const who: DailyRecordAdmission = { actor, capsExempt: capsExempt(env.DEFINITION_EDITORS, env.TRUSTED_USERS, actor), at: now() };
  const limits = (JSON.parse(sourceRun.pack_json) as Partial<ProjectPack>).settings?.usageLimits;
  return { who, limits, predicate: dailyRecordPredicate('reference', limits, who) };
}
/** After a reference insert that changed nothing: the person's allowance, or else a loud failure. */
async function referenceNotSaved(env: Env, allowance: ReturnType<typeof referenceAllowance>): Promise<never> {
  await requireDailyRecordAdmission(env.DB, 'reference', allowance.limits, allowance.who);
  throw new ServerFailure('E_FEEDBACK_REFERENCE_STORAGE', 'blocker', 'The confirmed labels could not be saved. Nothing was changed; save them again.');
}

function reject(message: string): never {
  throw new ServerFailure('E_FEEDBACK_REFERENCE', 'request', message);
}

export function validateReferenceLineage(expected: string, actual: unknown): void {
  if (!expected || expected !== actual)
    reject('This run must use the category version confirmed with its feedback.');
}

export function referenceEntriesFromStored(
  source: CorrectionManifestEntry[],
  diff: CorrectionDiff,
  types: string[],
  labels: LabelDecision[],
  folderLabels: Record<string, string>,
  ignored: string[]
): ReferenceEntry[] {
  try {
    return buildReference(source, [...diff.confirmations, ...diff.moves], types, labels,
      folderLabels, ignored);
  } catch (error) {
    reject(error instanceof Error ? error.message : 'Invalid feedback labels.');
  }
}

async function sourceEntries(store: Store, run: RunRow): Promise<CorrectionManifestEntry[]> {
  const docs = await store.documents(run.id);
  if (
    !['complete', 'closed'].includes(run.status) ||
    docs.length !== run.expected_count ||
    docs.some(doc => !doc.decision_json)
  )
    reject('Feedback requires completed source results.');
  return docs.map(doc => {
    const decision = JSON.parse(doc.decision_json!);
    return {
      fingerprint: doc.fingerprint,
      tag: doc.tag,
      originalFilename: doc.original_filename,
      destinationFolder: decision.destinationFolder,
      rule: decision.ruleId
    };
  });
}

export async function readStoredCorrection(store: Store, run: RunRow, correctionId: string) {
  const row = await store.env.DB
    .prepare('SELECT result_key,raw_key FROM corrections WHERE id=? AND run_id=?')
    .bind(correctionId, run.id)
    .first<{ result_key: string; raw_key: string }>();
  if (!row) reject('The saved correction does not belong to this run.');
  const saved = await store.json<{
    diff: CorrectionDiff;
    proposals: CorrectionProposals;
    proposalContext: unknown
  }>(row.result_key);
  const types = JSON.parse(run.pack_json).typeFile.types
    .map((type: { id: string }) => type.id) as string[];
  const referenceCandidates = referenceEntriesFromStored(
    await sourceEntries(store, run),
    saved.diff,
    types,
    [],
    {},
    saved.proposals.ignoredFolders
  );
  return { correctionId, ...saved, referenceCandidates };
}

/**
 * The label rows of one reference (migration 0018), one statement per 2,000 entries. The ordinal is the entry's
 * position in the source results, as the migration's backfill numbered older references. `labels_json` on the
 * reference row is written as `[]`: the rows are the store.
 */
function labelInserts(env: Env, referenceId: string, entries: readonly ReferenceEntry[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < entries.length; offset += LABEL_CHUNK)
    statements.push(env.DB.prepare(
      "INSERT INTO feedback_labels(reference_id,fingerprint,ordinal,entry_json) SELECT ?,json_extract(value,'$.fingerprint'),?+key,json(value) FROM json_each(?) WHERE EXISTS(SELECT 1 FROM feedback_references WHERE id=?)"
    ).bind(referenceId, offset, JSON.stringify(entries.slice(offset, offset + LABEL_CHUNK)), referenceId));
  return statements;
}

export async function saveReference(
  store: Store,
  run: RunRow,
  correctionId: string,
  actor: string,
  input: {
    definitionRevisionId: string;
    labels: LabelDecision[];
    folderLabels?: Record<string, string>
  }
): Promise<ReferenceRecord> {
  if (run.actor !== actor) reject('Only the source run owner can confirm its labels.');
  if (
    !input ||
    typeof input.definitionRevisionId !== 'string' ||
    !Array.isArray(input.labels) ||
    input.folderLabels !== undefined && (
      typeof input.folderLabels !== 'object' ||
      input.folderLabels === null ||
      Array.isArray(input.folderLabels)
    )
  )
    reject('Choose a category version and confirm document labels.');
  const revision = await store.env.DB
    .prepare('SELECT type_file_json FROM definition_revisions WHERE id=?')
    .bind(input.definitionRevisionId)
    .first<{ type_file_json: string }>();
  if (!revision) reject('The selected category version does not exist.');
  const saved = await readStoredCorrection(store, run, correctionId);
  const entries = referenceEntriesFromStored(
    await sourceEntries(store, run),
    saved.diff,
    JSON.parse(revision.type_file_json).types.map((type: { id: string }) => type.id),
    input.labels,
    input.folderLabels ?? {},
    saved.proposals.ignoredFolders
  );
  const value: ReferenceRecord = {
    id: crypto.randomUUID(),
    sourceRunId: run.id,
    correctionId,
    definitionRevisionId: input.definitionRevisionId,
    entries,
    carriedFrom: null
  };
  // One batch: the reference row and every label row, or nothing.
  const allowance = referenceAllowance(store.env, run, actor);
  const written = await store.env.DB.batch([
    store.env.DB
      .prepare('INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) SELECT ?,?,?,?,?,?,?' +
        (allowance.predicate.sql ? ' WHERE ' + allowance.predicate.sql : ''))
      .bind(value.id, run.id, correctionId, input.definitionRevisionId, allowance.who.at, actor, '[]', ...allowance.predicate.params),
    ...labelInserts(store.env, value.id, entries)
  ]);
  if (written[0]?.meta.changes !== 1) await referenceNotSaved(store.env, allowance);
  return value;
}

/** The reference row alone (no labels): lineage checks at quote and run creation need nothing more. Owner-scoped. */
export async function readReferenceHead(env: Env, id: string, actor: string): Promise<ReferenceHead> {
  const row = await env.DB
    .prepare('SELECT id,source_run_id,correction_id,definition_revision_id,confirmed_by,carried_from FROM feedback_references WHERE id=?')
    .bind(id)
    .first<ReferenceRow>();
  if (!row || row.confirmed_by !== actor)
    reject('The confirmed feedback is unavailable to this person.');
  return {
    id: row.id,
    sourceRunId: row.source_run_id,
    correctionId: row.correction_id,
    definitionRevisionId: row.definition_revision_id,
    carriedFrom: row.carried_from ?? null
  };
}

export async function readReference(
  store: Store,
  id: string,
  actor: string
): Promise<ReferenceRecord> {
  const head = await readReferenceHead(store.env, id, actor);
  const rows = await store.env.DB
    .prepare('SELECT entry_json FROM feedback_labels WHERE reference_id=? ORDER BY ordinal')
    .bind(id)
    .all<{ entry_json: string }>();
  // A reference always labels at least one document; no rows means the label store is missing, not an empty reference.
  if (rows.results.length === 0) throw new ServerFailure('E_FEEDBACK_LABELS_MISSING', 'blocker',
    'The saved feedback has no label records.');
  return { ...head, entries: rows.results.map(row => JSON.parse(row.entry_json) as ReferenceEntry) };
}

/**
 * Owner labels carried, unchanged, to another category version. Every labelled category must exist there;
 * nothing is relabelled, remapped or dropped. Failures, exclusions and unconfirmed entries carry as they are.
 */
export function carriedReferenceEntries(
  entries: readonly ReferenceEntry[],
  typeIds: readonly string[]
): ReferenceEntry[] {
  const valid = new Set(typeIds);
  const missing = [...new Set(entries.flatMap(entry => entry.labels).filter(id => !valid.has(id)))].sort();
  if (missing.length)
    reject(`These labelled categories are not in the active category version: ${missing.join(', ')}. ` +
      'Confirm labels again against that version instead.');
  return entries.map(entry => ({ ...entry, labels: [...entry.labels] }));
}

/**
 * Explicit owner action: copy a confirmed reference's labels to the active category version so a run on
 * revised definitions can be compared with the same owner labels. The original reference stays untouched,
 * and the new one records where it came from. Runs still link only to a reference of their own version.
 */
export async function carryReference(
  store: Store,
  referenceId: string,
  actor: string,
  activeRevisionId: string | null
): Promise<ReferenceRecord> {
  const source = await readReference(store, referenceId, actor);
  if (!activeRevisionId) reject('Activate categories before carrying labels to them.');
  if (source.definitionRevisionId === activeRevisionId)
    reject('These labels already use the active category version.');
  const revision = await store.env.DB
    .prepare('SELECT type_file_json FROM definition_revisions WHERE id=?')
    .bind(activeRevisionId)
    .first<{ type_file_json: string }>();
  if (!revision) reject('The active category version does not exist.');
  const entries = carriedReferenceEntries(source.entries,
    JSON.parse(revision.type_file_json).types.map((type: { id: string }) => type.id));
  const value: ReferenceRecord = {
    id: crypto.randomUUID(),
    sourceRunId: source.sourceRunId,
    correctionId: source.correctionId,
    definitionRevisionId: activeRevisionId,
    entries,
    carriedFrom: source.id
  };
  // The label rows are copied inside D1, byte for byte: carried means unchanged.
  const allowance = referenceAllowance(store.env, await store.run(source.sourceRunId), actor);
  const saved = await store.env.DB.batch([
    store.env.DB
      .prepare('INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json,carried_from) SELECT ?,?,?,?,?,?,?,?' +
        (allowance.predicate.sql ? ' WHERE ' + allowance.predicate.sql : ''))
      .bind(value.id, value.sourceRunId, value.correctionId, activeRevisionId, allowance.who.at, actor, '[]', source.id, ...allowance.predicate.params),
    store.env.DB
      .prepare('INSERT INTO feedback_labels(reference_id,fingerprint,ordinal,entry_json) SELECT ?,fingerprint,ordinal,entry_json FROM feedback_labels WHERE reference_id=? AND EXISTS(SELECT 1 FROM feedback_references WHERE id=?)')
      .bind(value.id, source.id, value.id)
  ]);
  if (saved[0]?.meta.changes !== 1) await referenceNotSaved(store.env, allowance);
  return value;
}

export async function linkReferenceToRun(
  store: Store,
  run: RunRow,
  referenceId: string,
  actor: string,
  revisionId: unknown
): Promise<void> {
  const reference = await readReferenceHead(store.env, referenceId, actor);
  if (run.actor !== actor || run.id === reference.sourceRunId || run.status !== 'uploading')
    reject('Feedback can only be linked to your new, unstarted run.');
  validateReferenceLineage(reference.definitionRevisionId, revisionId);
  await store.env.DB
    .prepare('INSERT INTO feedback_run_links(run_id,reference_id) VALUES(?,?)')
    .bind(run.id, referenceId)
    .run();
}

export async function comparisonForRun(store: Store, run: RunRow, actor: string) {
  const link = await store.env.DB
    .prepare('SELECT reference_id FROM feedback_run_links WHERE run_id=?')
    .bind(run.id)
    .first<{ reference_id: string }>();
  if (!link) return null;
  const reference = await readReference(store, link.reference_id, actor);
  if (run.actor !== actor) reject('The run belongs to a different person.');
  const documents = (await store.documents(run.id)).map(doc => {
    const decision = doc.decision_json ? JSON.parse(doc.decision_json) : null;
    return {
      fingerprint: doc.fingerprint,
      destinationFolder: decision?.destinationFolder ?? null,
      rule: decision?.ruleId ?? null
    };
  });
  return {
    referenceId: reference.id,
    sourceRunId: reference.sourceRunId,
    correctionId: reference.correctionId,
    definitionRevisionId: reference.definitionRevisionId,
    runId: run.id,
    complete: ['complete', 'closed'].includes(run.status),
    ...compareReference(reference.entries, documents)
  };
}
