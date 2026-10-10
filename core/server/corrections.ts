import { response } from './api.ts';
import { compactRun, type ResultRow } from './results.ts';
import { uiCopy } from '../ui/copy.ts';
import { correctionContext } from './correction-context.ts';
import { requireProject } from '../config/project.ts';
import type { ReaderOutput } from '../vendors/validate.ts';
import { diffCorrection, type CorrectionTreeFile } from '../correction/diff.ts';
import { carryTrialChecks } from '../correction/carry.ts';
import { trialChecksForFullRun } from './pilot.ts';
import {
  proposeCorrections, storedProposals, type FolderDecision, type ProposalEvidence
} from '../correction/proposals.ts';
import { selectEvidenceSample, EVIDENCE_CAPS } from '../correction/evidence-sample.ts';
import { Store, now, type RunRow } from './store.ts';
import { object, requireValue, jsonBody } from './contracts.ts';
import { ServerFailure } from './errors.ts';
import { capsExempt } from '../config/definitions.ts';
import { dailyRecordPredicate, requireDailyRecordAdmission } from './daily-allowance.ts';

/** A listing above this is refused whole; a 10,000-document run lists a few thousand files. */
export const CORRECTION_FILES_MAX = 100_000;
/**
 * A review's listing is bounded by its own run (independent review F3, 7 October 2026), for every pack: its files,
 * builder notes, ticked folders and folder decisions together at most four per document plus 100 (a built tree holds a
 * copy and at most one note per document, its summaries and folders), and every path or identity at most 1,024
 * characters. Refused whole, before anything is read or written.
 */
export const correctionListingLimit = (expectedCount: number) => 4 * expectedCount + 100;
export const CORRECTION_PATH_MAX = 1_024;
export const correctionsCopy = Object.freeze({
  tooManyEntries: (limit: number) => `A review of this run can list at most ${limit.toLocaleString('en-US')} files and folders. Choose the folder that was built for this run, then read your changes again.`,
  pathTooLong: `A file or folder path in a review can have at most ${CORRECTION_PATH_MAX.toLocaleString('en-US')} characters. Shorten the long folder or file name, then read your changes again.`,
  notSaved: 'The review could not be saved. Nothing was changed; save it again.'
});
const bounded = (value: unknown) => typeof value === 'string' && value.length <= CORRECTION_PATH_MAX;

/** Artifact ledger states for many keys in one statement per 2,000 keys, instead of one statement per key. */
async function artifactStates(env: Env, runId: string, keys: readonly string[]) {
  const states = new Map<string, { deleted: boolean; containsText: boolean }>();
  const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 2_000) {
    const rows = await env.DB.prepare(
      'SELECT key,deleted_at,contains_text FROM artifacts WHERE run_id=? AND key IN (SELECT value FROM json_each(?))'
    ).bind(runId, JSON.stringify(unique.slice(offset, offset + 2_000)))
      .all<{ key: string; deleted_at: string | null; contains_text: number }>();
    for (const row of rows.results)
      states.set(row.key, { deleted: row.deleted_at !== null, containsText: row.contains_text === 1 });
  }
  return states;
}

export async function corrections(
  request: Request,
  env: Env,
  store: Store,
  run: RunRow,
  actor: string
): Promise<Response> {
  const raw = await jsonBody(request);
  requireValue(object(raw), 'A correction listing is required.');
  requireValue(
    Object.keys(raw).every(key =>
      ['files', 'checkedFolders', 'sidecarPaths', 'folderDecisions'].includes(key)),
    'Only a local file listing may be submitted.'
  );
  requireValue(
    Array.isArray(raw.files) &&
      Array.isArray(raw.checkedFolders) &&
      raw.checkedFolders.every(v => typeof v === 'string') &&
      Array.isArray(raw.sidecarPaths) &&
      raw.sidecarPaths.every(v => typeof v === 'string'),
    'Invalid correction listing.'
  );
  requireValue(raw.files.length <= CORRECTION_FILES_MAX,
    `A correction listing may contain at most ${CORRECTION_FILES_MAX.toLocaleString('en-US')} files.`);
  requireValue(raw.folderDecisions === undefined || Array.isArray(raw.folderDecisions), 'Invalid correction listing.');
  const decisions: unknown[] = Array.isArray(raw.folderDecisions) ? raw.folderDecisions : [];
  const limit = correctionListingLimit(run.expected_count);
  requireValue(raw.files.length + raw.sidecarPaths.length + raw.checkedFolders.length + decisions.length <= limit,
    correctionsCopy.tooManyEntries(limit));
  for (const file of raw.files) {
    requireValue(
      object(file) &&
        Object.keys(file).every(key =>
          ['folder', 'filename', 'tag', 'fingerprint'].includes(key)) &&
        typeof file.folder === 'string' &&
        typeof file.filename === 'string' &&
        (file.tag === undefined || typeof file.tag === 'string') &&
        (file.fingerprint === undefined || typeof file.fingerprint === 'string'),
      'A correction may contain paths and identities only.'
    );
    requireValue(bounded((file.folder ? file.folder + '/' : '') + file.filename) && (file.tag === undefined || bounded(file.tag)) &&
      (file.fingerprint === undefined || bounded(file.fingerprint)), correctionsCopy.pathTooLong);
  }
  for (const decision of decisions)
    requireValue(object(decision) && Object.keys(decision).length === 2 && typeof decision.folder === 'string' &&
      typeof decision.action === 'string', 'A correction may contain paths and identities only.');
  requireValue([...raw.sidecarPaths, ...raw.checkedFolders, ...decisions.map(decision => (decision as { folder: string }).folder)]
    .every(bounded), correctionsCopy.pathTooLong);
  // F3: saved reviews per person per UTC day under the run's frozen usage limits. Checked before anything is read or
  // stored, and again inside the insert below so a simultaneous review cannot pass it too.
  const allowance = { actor, capsExempt: capsExempt(env.DEFINITION_EDITORS, env.TRUSTED_USERS, actor), at: now() };
  const pack = requireProject(JSON.parse(run.pack_json)), usageLimits = pack.settings.usageLimits;
  await requireDailyRecordAdmission(env.DB, 'correction', usageLimits, allowance);
  // The diff runs over the compact entries (summaries in D1); no model output is read for it.
  const { entries, rows } = await compactRun(store, run),
    typeIds = pack.typeFile.types.map(type => type.id);
  const compared = diffCorrection({
    manifest: entries,
    files: raw.files as CorrectionTreeFile[],
    checkedFolders: raw.checkedFolders as string[],
    sidecarPaths: raw.sidecarPaths as string[],
    typeFolders: typeIds
  });
  // The full run of a campaign: a document the person checked in the trial that landed in the same place again counts
  // as checked here, once (owner, 6 October 2026). Nothing is applied from it; it is a confirmation like a ticked folder's.
  const { diff, carried: carriedFromTrial } = carryTrialChecks(compared, entries, await trialChecksForFullRun(env, store, run));
  // Every document's certainty and agreed type come from its stored summary, so the filed check and both threshold
  // proposals see every confirmation exactly as before. Retained context is gathered for a bounded sample only
  // (see evidence-sample.ts); the rest is marked on demand. This changes what the definitions editor receives:
  // sampled examples instead of every confirmation (step 3; the owner's decision is recorded separately).
  const evidence: Record<string, ProposalEvidence> = {};
  const rowByTag = new Map<string, ResultRow>();
  entries.forEach((entry, index) => {
    rowByTag.set(entry.tag, rows[index]);
    evidence[entry.tag] = {
      certainty: entry.confidenceCheck?.certainty ?? null,
      agreedType: entry.confidenceCheck && entry.rule === 'R2' ? entry.confidenceCheck.choice : null,
      title: entry.originalFilename,
      digestLines: [],
      evidenceNote: 'on_demand'
    };
  });
  const sample = selectEvidenceSample(diff, tag => evidence[tag]?.certainty ?? null, typeIds);
  const gathered = [...sample.moves, ...sample.confirmations];
  const states = await artifactStates(env, run.id, gathered.flatMap(tag => {
    const row = rowByTag.get(tag)!;
    return [row.digest_key, row.reader_key].filter((key): key is string => key !== null);
  }));
  const unavailableTags: string[] = [];
  for (const tag of gathered) {
    const row = rowByTag.get(tag)!;
    const context = await correctionContext(row.original_filename, row.digest_key, {
      metadata: async key => {
        const state = states.get(key);
        if (!state) throw new ServerFailure('E_ARTIFACT_MISSING', 'blocker',
          'The document state ledger is missing.');
        return state;
      },
      read: key => store.json(key),
      readReader: async key => (await store.json<{ value: ReaderOutput }>(key)).value
    }, row.reader_key);
    if (context.unavailable) unavailableTags.push(tag);
    evidence[tag] = {
      certainty: evidence[tag].certainty,
      agreedType: evidence[tag].agreedType,
      title: context.title,
      digestLines: context.digestLines,
      readerEvidence: context.readerEvidence,
      fullContextUnavailable: context.fullContextUnavailable
    };
  }
  const id = crypto.randomUUID();
  const proposals = proposeCorrections({
    correctionId: id,
    typeVersion: run.type_version,
    currentThreshold: run.threshold,
    minimumFiledCount: pack.settings.minimumFiledCount,
    diff,
    evidence,
    types: pack.typeFile.types,
    folderDecisions: decisions as FolderDecision[],
    renderNotFor: (from, to) => uiCopy.conditionalNotFor(from.name, to.name, to.what!)
  });
  // `unavailableTags` names the gathered documents whose digest was not retained (was: every document).
  const proposalContext = {
    unavailableTags,
    reason: 'source_text_not_retained',
    evidenceSample: { moves: sample.moves.length, confirmations: sample.confirmations.length, caps: EVIDENCE_CAPS },
    carriedFromTrial
  };
  const rawKey = await store.put(run.id, null, 'correction_input', raw),
    resultKey = await store.put(run.id, null, 'correction_analysis', {
      diff, proposals, proposalContext
    });
  // The row keeps the threshold findings and counts (well under D1's value limit at any size); the full proposals
  // are in the R2 analysis object, which `readStoredCorrection` reads. Apply reads only `[direction].threshold`.
  const counted = dailyRecordPredicate('correction', usageLimits, allowance);
  const saved = await env.DB.prepare(
    'INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) SELECT ?,?,?,?,?,?,?' + (counted.sql ? ' WHERE ' + counted.sql : '')
  ).bind(id, run.id, actor, allowance.at, rawKey, resultKey, JSON.stringify(storedProposals(proposals, diff)), ...counted.params).run();
  if (saved.meta.changes !== 1) {
    // A review saved meanwhile used the person's last one of the day. Its listing and analysis objects stay registered
    // under the run and are kept with it; nothing refers to them.
    await requireDailyRecordAdmission(env.DB, 'correction', usageLimits, allowance);
    throw new ServerFailure('E_CORRECTION_STORAGE', 'blocker', correctionsCopy.notSaved);
  }
  return response({ correctionId: id, diff, proposals, proposalContext });
}
