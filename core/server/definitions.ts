import { requireProject, typeVersion, type ProjectPack, type TypeFile } from '../config/project.ts';
import {
  definitionChange,
  definitionThreshold,
  editorAllowed,
  validateDisplayNames,
  type ThresholdStatus,
  type DefinitionChange
} from '../config/definitions.ts';
import { capacityRefusal } from '../config/capacity.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { ServerFailure } from './errors.ts';
import { object, exact, requireValue } from './contracts.ts';
import { categoryCalibrationFence, categoryCalibrationSequence, withReaderCalibration } from './model-calibration.ts';

export interface DefinitionBindings {
  DEFINITION_MODE?: string;
  DEFINITION_EDITORS?: string;
  DB: D1Database
}

export interface Revision {
  id: string;
  baseRevisionId: string | null;
  typeVersion: string;
  typeFile: TypeFile;
  displayNames: Record<string, string>;
  createdAt: string;
  createdBy: string;
  threshold: number;
  thresholdStatus: ThresholdStatus;
  thresholdJustification: string;
  changeKind: DefinitionChange
}

interface RevisionRow {
  id: string;
  base_revision_id: string | null;
  type_version: string;
  type_file_json: string;
  display_names_json: string;
  created_at: string;
  created_by: string
}

interface Active {
  revision_id: string | null;
  threshold: number;
  threshold_status: ThresholdStatus;
  justification: string
}

export function runtimeDefinitions(env: DefinitionBindings): boolean {
  if (env.DEFINITION_MODE !== undefined && !['git', 'runtime'].includes(env.DEFINITION_MODE))
    throw new ServerFailure('E_DEFINITION_MODE', 'blocker',
      'Select a valid category configuration mode.');
  return env.DEFINITION_MODE === 'runtime';
}

export function requireEditor(env: DefinitionBindings, actor: string,
  refusal = 'Only a configured category editor can make this change.'): void {
  if (!editorAllowed(env.DEFINITION_EDITORS, actor))
    throw new ServerFailure('E_EDITOR_REQUIRED', 'request', refusal, 403);
}

async function pointer(env: DefinitionBindings): Promise<Active> {
  const row = await env.DB.prepare('SELECT * FROM definition_active WHERE id=1').first<Active>();
  if (!row)
    throw new ServerFailure('E_DEFINITIONS_STORAGE', 'blocker',
      'Category storage has not been initialized.');
  return row;
}

async function rowFor(env: DefinitionBindings, id: string): Promise<RevisionRow> {
  const row = await env.DB.prepare('SELECT * FROM definition_revisions WHERE id=?')
    .bind(id)
    .first<RevisionRow>();
  if (!row)
    throw new ServerFailure('E_DEFINITION_NOT_FOUND', 'request',
      'This category version is unavailable.', 404);
  return row;
}

function view(row: RevisionRow, calibration: Active, kind: DefinitionChange): Revision {
  return {
    id: row.id,
    baseRevisionId: row.base_revision_id,
    typeVersion: row.type_version,
    typeFile: JSON.parse(row.type_file_json),
    displayNames: JSON.parse(row.display_names_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
    threshold: calibration.threshold,
    thresholdStatus: calibration.threshold_status,
    thresholdJustification: calibration.justification,
    changeKind: kind
  };
}

/**
 * A set above what one reader call or one confidence request can carry under the current settings is refused before
 * it is saved, put in force or admitted to a new run, so it cannot fail late inside a run (DECISIONS 95).
 * Runs already frozen are not checked.
 */
export function requireCapacity(pack: ProjectPack): void {
  const refusal = capacityRefusal(pack, pack.typeFile);
  if (refusal) throw new ServerFailure('E_CATEGORY_CAPACITY', 'request', refusal.sentence, 409);
}

export async function activeDefinition(env: DefinitionBindings): Promise<Revision | null> {
  const active = await pointer(env);
  if (!active.revision_id) return null;
  const row = await rowFor(env, active.revision_id);
  const activation = await env.DB
    .prepare('SELECT change_kind FROM definition_activations WHERE revision_id=?')
    .bind(row.id)
    .first<{ change_kind: DefinitionChange }>();
  return view(row, active, activation?.change_kind ?? 'initial');
}

function revisionProject(seed: unknown, revision: Revision): ProjectPack {
  return requireProject({
    ...seed as ProjectPack,
    typeFile: revision.typeFile,
    definitionRevisionId: revision.id,
    displayNames: revision.displayNames,
    definitionThreshold: revision.threshold,
    definitionThresholdStatus: revision.thresholdStatus,
    definitionThresholdJustification: revision.thresholdJustification
  });
}

export async function effectiveProject(
  env: DefinitionBindings,
  seed: unknown,
  options?: { selectedReaderModel?: string }
): Promise<ProjectPack> {
  let pack: ProjectPack;
  if (runtimeDefinitions(env)) {
    const revision = await activeDefinition(env);
    if (!revision) throw new ServerFailure('E_DEFINITIONS_EMPTY', 'blocker',
      'Create and activate your categories before starting a run.');
    pack = revisionProject(seed, revision);
  } else pack = requireProject(seed);
  const selected = options === undefined ? pack.readerModels?.defaultId : options.selectedReaderModel;
  let selectedPack: ProjectPack;
  try { selectedPack = selectReaderModel(pack, selected); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'E_READER_MODEL')
      throw new ServerFailure('E_READER_MODEL', 'request', error.message, 400);
    throw error;
  }
  return withReaderCalibration(env.DB, selectedPack);
}

export async function definitionState(env: DefinitionBindings, seed: ProjectPack, actor: string) {
  let active = await activeDefinition(env);
  if (active && seed.readerModels) {
    const pack = await withReaderCalibration(env.DB, selectReaderModel(revisionProject(seed, active), seed.readerModels.defaultId));
    active = { ...active, threshold: pack.definitionThreshold!, thresholdStatus: pack.definitionThresholdStatus!,
      thresholdJustification: pack.definitionThresholdJustification! };
  }
  const historical = (await env.DB
    .prepare('SELECT r.*,a.threshold,a.threshold_status,a.change_kind,a.justification FROM definition_revisions r JOIN definition_activations a ON a.revision_id=r.id ORDER BY a.created_at DESC')
    .all<RevisionRow & {
      threshold: number;
      threshold_status: ThresholdStatus;
      change_kind: DefinitionChange;
      justification: string
    }>()).results;
  const history = historical.map(row => view(
    row,
    {
      revision_id: row.id,
      threshold: row.threshold,
      threshold_status: row.threshold_status,
      justification: row.justification
    },
    row.change_kind
  ));
  const rows = (await env.DB
    .prepare('SELECT r.* FROM definition_revisions r WHERE NOT EXISTS(SELECT 1 FROM definition_activations a WHERE a.revision_id=r.id) ORDER BY created_at DESC')
    .all<RevisionRow>()).results;
  const drafts = rows.map(row => view(
    row,
    { revision_id: row.id, threshold: .9, threshold_status: 'untested', justification: 'draft' },
    definitionChange(active?.typeFile ?? null, JSON.parse(row.type_file_json))
  ));
  return {
    mode: runtimeDefinitions(env) ? 'runtime' : 'git',
    canEdit: editorAllowed(env.DEFINITION_EDITORS, actor),
    actor,
    active,
    drafts,
    history,
    seedTypeFile: seed.typeFile
  };
}

export async function createDefinitionDraft(
  env: DefinitionBindings,
  seed: ProjectPack,
  actor: string,
  raw: unknown
): Promise<Revision> {
  requireEditor(env, actor);
  requireValue(object(raw), 'Category definitions are required.');
  exact(raw, ['baseRevisionId', 'typeFile', 'displayNames']);
  requireValue(raw.baseRevisionId === null || typeof raw.baseRevisionId === 'string',
    'The starting category version is required.');
  const active = await pointer(env);
  requireValue(active.revision_id === raw.baseRevisionId,
    'Categories changed. Refresh before saving your draft.');
  const pack = requireProject({ ...seed, typeFile: raw.typeFile });
  requireCapacity(pack);
  try {
    validateDisplayNames(raw.displayNames, pack.typeFile);
  } catch (error) {
    throw new ServerFailure('E_DEFINITION_DISPLAY', 'request', String(error));
  }
  const id = crypto.randomUUID(),
    createdAt = new Date().toISOString(),
    version = await typeVersion(JSON.stringify(pack.typeFile));
  await env.DB
    .prepare('INSERT INTO definition_revisions(id,base_revision_id,type_version,type_file_json,display_names_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)')
    .bind(id, raw.baseRevisionId, version, JSON.stringify(pack.typeFile),
      JSON.stringify(raw.displayNames), createdAt, actor)
    .run();
  return view(
    await rowFor(env, id),
    { ...active, threshold: .9, threshold_status: 'untested' },
    definitionChange(
      active.revision_id
        ? JSON.parse((await rowFor(env, active.revision_id)).type_file_json)
        : null,
      pack.typeFile
    )
  );
}

export async function activateDefinition(
  env: DefinitionBindings,
  seed: ProjectPack,
  actor: string,
  id: string,
  raw: unknown
): Promise<{ active: Revision }> {
  requireEditor(env, actor);
  requireValue(runtimeDefinitions(env), 'Enable website-managed categories before activation.');
  requireValue(object(raw), 'An explicit activation choice is required.');
  exact(raw, ['inheritThreshold']);
  requireValue(typeof raw.inheritThreshold === 'boolean',
    'Choose whether to inherit the threshold.');
  const row = await rowFor(env, id),
    base = await pointer(env);
  if (base.revision_id !== row.base_revision_id)
    throw new ServerFailure('E_DEFINITION_STALE', 'request',
      'Categories changed. Create a fresh draft before activating.', 409);
  requireCapacity(requireProject({ ...seed, typeFile: JSON.parse(row.type_file_json) }));
  const kind = definitionChange(
    base.revision_id ? JSON.parse((await rowFor(env, base.revision_id)).type_file_json) : null,
    JSON.parse(row.type_file_json)
  );
  const sequence = seed.readerModels && base.revision_id ? await categoryCalibrationSequence(env.DB, base.revision_id) : null;
  const readerBase = seed.readerModels && base.revision_id ? await withReaderCalibration(env.DB,
    selectReaderModel(requireProject({ ...seed, definitionRevisionId: base.revision_id,
      typeFile: JSON.parse((await rowFor(env, base.revision_id)).type_file_json) }), seed.readerModels.defaultId)) : null;
  const calibration = definitionThreshold(
    kind,
    readerBase ? { threshold: readerBase.definitionThreshold!, status: readerBase.definitionThresholdStatus! }
      : base.revision_id ? { threshold: base.threshold, status: base.threshold_status } : null,
    raw.inheritThreshold
  );
  const eventId = crypto.randomUUID();
  const justification = kind === 'cosmetic' ? readerBase?.definitionThresholdJustification ?? base.justification : eventId;
  const result = await env.DB.batch([
    env.DB
      .prepare('UPDATE definition_active SET revision_id=?,threshold=?,threshold_status=?,justification=? WHERE id=1 AND revision_id IS ? AND threshold=? AND threshold_status=? AND justification=? AND NOT EXISTS(SELECT 1 FROM definition_activations WHERE revision_id=?)' +
        (sequence === null ? '' : ' AND ' + categoryCalibrationFence))
      .bind(
        id,
        calibration.threshold,
        calibration.status,
        justification,
        row.base_revision_id,
        base.threshold,
        base.threshold_status,
        base.justification,
        id,
        ...(sequence === null ? [] : [base.revision_id, sequence])
      ),
    env.DB
      .prepare('INSERT INTO definition_activations(id,revision_id,previous_revision_id,actor,created_at,threshold,threshold_status,change_kind,justification) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1')
      .bind(
        eventId,
        id,
        row.base_revision_id,
        actor,
        new Date().toISOString(),
        calibration.threshold,
        calibration.status,
        kind,
        justification
      )
  ]);
  if (result[0].meta.changes !== 1)
    throw new ServerFailure('E_DEFINITION_STALE', 'request',
      'Categories changed. Refresh before activating.', 409);
  return {
    active: view(row, {
      revision_id: id,
      threshold: calibration.threshold,
      threshold_status: calibration.status,
      justification
    }, kind)
  };
}
