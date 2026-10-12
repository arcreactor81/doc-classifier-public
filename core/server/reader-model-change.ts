/**
 * Owner decision of 10 October 2026 (DECISIONS 155): the person is told when the model a run's reader reported differs
 * from the one the previous run on the same reader reported. Each run freezes the first string its reader replies
 * report (core/server/model-identity.ts, `run_model_identities`); this compares that frozen string with the latest other
 * run's frozen string for the same requested model, frozen before it. Frozen rows never change and later rows are frozen
 * later, so once a run has its own string the answer does not move.
 *
 * Nothing is said when either string is unknown: the run has no reader reply yet, or no earlier run on that reader
 * recorded one (every run before DECISIONS 155 on a dated snapshot, for example). Read only; nothing is decided from it.
 */
import type { ReaderModelChange } from '../domain/run-status-types.ts';
import type { RunRow } from './store.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether this run can have a frozen reported reader model at all: only a run whose frozen pack's reader pin is undated
 * (`owner_approved_undated`) freezes one (execution.ts; DECISIONS 136 and 155). Every other run's status read skips
 * readReaderModelChange and its two reads.
 */
export function readerPinUndated(run: Pick<RunRow, 'pack_json'>): boolean {
  const pack: unknown = JSON.parse(run.pack_json);
  const pins = record(pack) ? pack.pins : null;
  const reader = record(pins) ? pins.reader : null;
  return record(reader) && reader.policy === 'owner_approved_undated';
}

export async function readReaderModelChange(db: D1Database, runId: string): Promise<{ readerModelChange: ReaderModelChange } | Record<string, never>> {
  const current = await db.prepare(`SELECT model_requested,model_reported,created_at FROM run_model_identities
    WHERE run_id=? AND role='reader' ORDER BY created_at,model_requested LIMIT 1`)
    .bind(runId).first<{ model_requested: string; model_reported: string; created_at: string }>();
  if (current === null) return {};
  const previous = await db.prepare(`SELECT model_reported FROM run_model_identities
    WHERE role='reader' AND model_requested=? AND run_id<>? AND created_at<?
    ORDER BY created_at DESC,run_id DESC LIMIT 1`)
    .bind(current.model_requested, runId, current.created_at).first<{ model_reported: string }>();
  if (previous === null || previous.model_reported === current.model_reported) return {};
  return { readerModelChange: { model: current.model_requested, previous: previous.model_reported, current: current.model_reported } };
}
