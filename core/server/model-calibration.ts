import { appliedThresholdStatus, type ThresholdStatus } from '../config/definitions.ts';
import { MODEL_PIN_POLICIES, typeVersion, type ProjectPack } from '../config/project.ts';
import { ServerFailure } from './errors.ts';
import { INITIAL_JUSTIFICATION } from './threshold-basis.ts';

export const readerCalibrationCopy = Object.freeze({
  unreadable: 'The recorded reader checks cannot be verified. Keep the saved records for review.',
  missingReader: 'The reader recorded on this run cannot be verified.',
  changed: 'The categories or this reader’s checked results changed. Refresh before applying this suggestion.',
  trialMismatch: 'Run and confirm a trial with this reader before starting the full run.'
});

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const fail = (): never => { throw new ServerFailure('E_READER_CALIBRATION', 'blocker', readerCalibrationCopy.unreadable); };
function parse(value: string): unknown { try { return JSON.parse(value); } catch { return fail(); } }

/** Missing historical identity is unknown; malformed present identity is never treated as absence. */
function readerIdentity(pack: unknown): { id: string; policy: string } | null {
  if (!object(pack)) return fail();
  if (pack.pins === undefined) return null;
  if (!object(pack.pins)) return fail();
  if (pack.pins.reader === undefined) return null;
  if (!object(pack.pins.reader)) return fail();
  const pin = pack.pins.reader;
  if (pin.id !== undefined && !text(pin.id) || pin.policy !== undefined &&
      !(MODEL_PIN_POLICIES as readonly string[]).includes(String(pin.policy))) return fail();
  if (pin.id === undefined || pin.policy === undefined) return null;
  return { id: pin.id as string, policy: pin.policy as string };
}

/** Legacy targets retain their historical carry rule. A menu target requires explicit matching reader pins. */
export function sameTrialReader(targetPack: unknown, sourcePackJson: string): boolean {
  if (!object(targetPack)) return fail();
  if (targetPack.readerModels === undefined) return true;
  const target = readerIdentity(targetPack), source = readerIdentity(parse(sourcePackJson));
  if (!target) return fail();
  return source !== null && source.id === target.id && source.policy === target.policy;
}

interface Scope { kind: 'revision' | 'type_version'; version: string }
interface Identity { id: string; policy: string }
export interface ReaderCalibration {
  threshold: number;
  status: ThresholdStatus;
  justification: string;
  /** Current category scope only; ancestor evidence is frozen by the active-category fence. */
  historyId: string | null;
  hasOwnEvidence: boolean;
}
interface HistoryRow {
  id: string; correction_id: string; threshold: number; direction: string;
  type_version: string; pack_json: string; proposals_json: string
}
interface RevisionRow {
  id: string; base_revision_id: string | null; type_version: string;
  activation_id: string | null; previous_revision_id: string | null;
  change_kind: string | null; threshold_status: string | null
}

function scopeOf(pack: Pick<ProjectPack, 'definitionRevisionId'>, version: string): Scope {
  if (pack.definitionRevisionId !== undefined) {
    if (!text(pack.definitionRevisionId)) return fail();
    return { kind: 'revision', version: pack.definitionRevisionId };
  }
  if (!text(version)) return fail();
  return { kind: 'type_version', version };
}
const scopePredicate = (scope: Scope) => scope.kind === 'revision'
  ? "json_extract(r.pack_json,'$.definitionRevisionId')=?"
  : "r.type_version=? AND json_extract(r.pack_json,'$.definitionRevisionId') IS NULL";
const historyFrom = ' FROM threshold_history h JOIN corrections c ON c.id=h.correction_id JOIN runs r ON r.id=c.run_id ';
const ownHistoryPredicate = (scope: Scope) => scopePredicate(scope) +
  " AND json_extract(r.pack_json,'$.pins.reader.id')=? AND json_extract(r.pack_json,'$.pins.reader.policy')=?";
const latestHistory = (scope: Scope) => '(SELECT h.id' + historyFrom + 'WHERE ' + ownHistoryPredicate(scope) + ' ORDER BY h.rowid DESC LIMIT 1)';
const keyFor = (scope: Scope, pin: Identity, historyId: string | null) =>
  JSON.stringify(['reader-calibration-v1', scope.kind, scope.version, pin.id, pin.policy, historyId]);

function snapshotHistory(pack: ProjectPack, scope: Scope, pin: Identity): string | null {
  if (!text(pack.readerCalibrationKey)) return fail();
  const value = parse(pack.readerCalibrationKey);
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 'reader-calibration-v1' ||
      value[1] !== scope.kind || value[2] !== scope.version || value[3] !== pin.id || value[4] !== pin.policy ||
      !(value[5] === null || text(value[5]))) return fail();
  return value[5];
}

/** Final quote/run admission fence, beside the existing active category revision check. No writes. */
export function readerCalibrationGuard(pack: ProjectPack, typeVersionHash: string): { sql: string; params: (string | null)[] } | null {
  if (pack.readerModels === undefined) return null;
  const scope = scopeOf(pack, typeVersionHash), pin = readerIdentity(pack);
  if (!pin) return fail();
  const historyId = snapshotHistory(pack, scope, pin);
  return { sql: latestHistory(scope) + ' IS ?', params: [scope.version, pin.id, pin.policy, historyId] };
}

async function histories(db: D1Database, scope: Scope): Promise<HistoryRow[]> {
  return (await db.prepare('SELECT h.id,h.correction_id,h.threshold,h.direction,r.type_version,r.pack_json,c.proposals_json' +
    historyFrom + 'WHERE ' + scopePredicate(scope) + ' ORDER BY h.rowid').bind(scope.version).all<HistoryRow>()).results;
}

async function lineage(db: D1Database, revisionId: string): Promise<RevisionRow[]> {
  const result: RevisionRow[] = [], seen = new Set<string>();
  let id: string | null = revisionId;
  while (id !== null) {
    if (!text(id) || seen.has(id)) return fail();
    seen.add(id);
    const row: RevisionRow | null = await db.prepare(
      'SELECT r.id,r.base_revision_id,r.type_version,a.id AS activation_id,a.previous_revision_id,a.change_kind,a.threshold_status FROM definition_revisions r LEFT JOIN definition_activations a ON a.revision_id=r.id WHERE r.id=?'
    ).bind(id).first<RevisionRow>();
    if (!row || row.id !== id || !text(row.type_version) || !text(row.activation_id) ||
        row.previous_revision_id !== row.base_revision_id ||
        !['initial', 'semantic', 'cosmetic'].includes(String(row.change_kind)) ||
        !['untested', 'unverified', 'provisional', 'calibrated'].includes(String(row.threshold_status)) ||
        (row.base_revision_id === null) !== (row.change_kind === 'initial') ||
        row.change_kind === 'semantic' && !['untested', 'unverified'].includes(String(row.threshold_status))) return fail();
    result.unshift(row); id = row.base_revision_id;
  }
  return result;
}

const initial = (justification = INITIAL_JUSTIFICATION): ReaderCalibration =>
  ({ threshold: .9, status: 'untested', justification, historyId: null, hasOwnEvidence: false });

/** Replay only explicit applications attributable to this pin; never copy the shared active threshold. */
export async function readReaderCalibration(db: D1Database, pack: ProjectPack, typeVersionHash?: string): Promise<ReaderCalibration> {
  const scope = scopeOf(pack, typeVersionHash ?? await typeVersion(JSON.stringify(pack.typeFile))), pin = readerIdentity(pack);
  if (!pin) throw new ServerFailure('E_READER_CALIBRATION', 'blocker', readerCalibrationCopy.missingReader);
  const revisions = scope.kind === 'revision' ? await lineage(db, scope.version) : null;
  const stages = revisions ?? [{ id: scope.version, type_version: scope.version, activation_id: INITIAL_JUSTIFICATION,
    change_kind: 'initial', threshold_status: 'untested' }];
  let value = initial();
  for (const stage of stages) {
    if (stage.change_kind === 'initial' || stage.change_kind === 'semantic' && stage.threshold_status === 'untested')
      value = initial(stage.activation_id!);
    else if (stage.change_kind === 'semantic') value = value.hasOwnEvidence
      ? { ...value, status: 'unverified', justification: stage.activation_id! } : initial(stage.activation_id!);
    value = { ...value, historyId: null };
    const stageScope: Scope = { kind: scope.kind, version: stage.id };
    for (const row of await histories(db, stageScope)) {
      if (!text(row.id) || !text(row.correction_id) || !unit(row.threshold) || !['raise', 'lower'].includes(row.direction) ||
          row.type_version !== stage.type_version) return fail();
      const recorded = parse(row.pack_json), identity = readerIdentity(recorded), proposals = parse(row.proposals_json);
      const proposal = object(proposals) ? proposals[row.direction] : null;
      if (!object(proposal) || proposal.threshold !== row.threshold) return fail();
      if (object(recorded) && (recorded.readerModels !== undefined || recorded.readerCalibrationKey !== undefined)) {
        if (!identity) return fail();
        snapshotHistory(recorded as unknown as ProjectPack, stageScope, identity);
      }
      if (!identity || identity.id !== pin.id || identity.policy !== pin.policy) continue;
      const status = appliedThresholdStatus(value, { threshold: row.threshold, correctionId: row.correction_id });
      value = { threshold: row.threshold, status, justification: row.correction_id, historyId: row.id, hasOwnEvidence: true };
    }
  }
  return value;
}

/** Selectors call this only for declared menus; frozen legacy packs keep their original reading behavior. */
export async function withReaderCalibration(db: D1Database, pack: ProjectPack): Promise<ProjectPack> {
  if (pack.readerModels === undefined) return pack;
  const version = await typeVersion(JSON.stringify(pack.typeFile)), scope = scopeOf(pack, version), pin = readerIdentity(pack);
  if (!pin) return fail();
  const calibration = await readReaderCalibration(db, pack, version);
  return { ...pack, definitionThreshold: calibration.threshold, definitionThresholdStatus: calibration.status,
    definitionThresholdJustification: calibration.justification,
    readerCalibrationKey: keyFor(scope, pin, calibration.historyId) };
}

/** A category activation must not inherit a calibration application that arrived after its review read. */
export async function categoryCalibrationSequence(db: D1Database, revisionId: string): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(MAX(h.rowid),0) AS sequence' + historyFrom + 'WHERE ' +
    scopePredicate({ kind: 'revision', version: revisionId })).bind(revisionId).first<{ sequence: number }>();
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 0) return fail();
  return row.sequence;
}
export const categoryCalibrationFence = '(SELECT COALESCE(MAX(h.rowid),0)' + historyFrom +
  "WHERE json_extract(r.pack_json,'$.definitionRevisionId')=?)=?";

/** The API already checks the exact saved proposal. This append atomically checks source, category and own-pin history. */
export async function applyReaderThreshold(db: D1Database, pack: ProjectPack, source: { runId: string; typeVersion: string },
  input: { correctionId: string; actor: string; threshold: number; direction: 'raise' | 'lower' }) {
  const scope = scopeOf(pack, source.typeVersion), pin = readerIdentity(pack);
  if (!pin) throw new ServerFailure('E_READER_CALIBRATION', 'blocker', readerCalibrationCopy.missingReader);
  if (pack.readerModels !== undefined || pack.readerCalibrationKey !== undefined) snapshotHistory(pack, scope, pin);
  if (!unit(input.threshold)) return fail();
  const current = await readReaderCalibration(db, pack, source.typeVersion);
  const status = appliedThresholdStatus(current, { threshold: input.threshold, correctionId: input.correctionId });
  const category = scope.kind === 'revision' ? ' AND EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=?)' : '';
  const result = await db.prepare('INSERT INTO threshold_history(id,correction_id,actor,created_at,threshold,direction) SELECT ?,?,?,?,?,? WHERE ' +
    latestHistory(scope) + ' IS ?' + category +
    ' AND EXISTS(SELECT 1 FROM corrections c JOIN runs r ON r.id=c.run_id WHERE c.id=? AND c.run_id=? AND r.actor=?)' +
    ' AND NOT EXISTS(SELECT 1 FROM threshold_history WHERE correction_id=? AND direction=?)')
    .bind(crypto.randomUUID(), input.correctionId, input.actor, new Date().toISOString(), input.threshold, input.direction,
      scope.version, pin.id, pin.policy, current.historyId, ...(scope.kind === 'revision' ? [scope.version] : []),
      input.correctionId, source.runId, input.actor, input.correctionId, input.direction).run();
  if (result.meta.changes !== 1) throw new ServerFailure('E_READER_CALIBRATION_STALE', 'request', readerCalibrationCopy.changed, 409);
  return { applied: true, threshold: input.threshold, thresholdStatus: status, correctionId: input.correctionId };
}
