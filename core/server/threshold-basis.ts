/**
 * Where the filing certainty in force came from (SPEC §9 S5), resolved from its recorded justification so that
 * System, Categories and the filing chip can say "Set from your review of Run 5 (25 Sep)" rather than show an id.
 *
 * Read-only. The justification is the value `definition_active.justification` (website categories) or
 * `controls.threshold_justification` (git mode) holds: the design default, the correction whose suggestion was
 * applied, or the activation that set the threshold. Anything else is reported as unknown; only Details shows it.
 */

export type ThresholdBasis =
  | { kind: 'initial' }
  | { kind: 'correction'; runId: string; at: string }
  | { kind: 'activation'; at: string }
  | { kind: 'unknown' };

export interface ThresholdBasisLookups {
  /** The run a saved review (correction) belongs to, and when it was saved; null when there is no such review. */
  correction(id: string): Promise<{ runId: string; at: string } | null>;
  /** When a category version was activated; null when there is no such activation. */
  activation(id: string): Promise<{ at: string } | null>;
}

/** The justification recorded before any review or activation changed the threshold. */
export const INITIAL_JUSTIFICATION = 'initial_design_threshold';

export async function resolveThresholdBasis(
  justification: string | null,
  lookups: ThresholdBasisLookups
): Promise<ThresholdBasis> {
  if (justification === null || justification === '') return { kind: 'unknown' };
  if (justification === INITIAL_JUSTIFICATION) return { kind: 'initial' };
  const correction = await lookups.correction(justification);
  if (correction) return { kind: 'correction', runId: correction.runId, at: correction.at };
  const activation = await lookups.activation(justification);
  if (activation) return { kind: 'activation', at: activation.at };
  return { kind: 'unknown' };
}

/** The two D1 reads behind the lookups (tables `corrections` and `definition_activations`). */
export function thresholdBasisLookups(db: D1Database): ThresholdBasisLookups {
  return {
    async correction(id) {
      const row = await db
        .prepare('SELECT run_id, created_at FROM corrections WHERE id=?')
        .bind(id)
        .first<{ run_id: string; created_at: string }>();
      return row ? { runId: row.run_id, at: row.created_at } : null;
    },
    async activation(id) {
      const row = await db
        .prepare('SELECT created_at FROM definition_activations WHERE id=?')
        .bind(id)
        .first<{ created_at: string }>();
      return row ? { at: row.created_at } : null;
    }
  };
}
