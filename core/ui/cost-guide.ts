/**
 * How it decides, "What each reader costs" (go/no-go review, 10 October 2026): measured figures only. A reader's cost per
 * document is the average this site measured for it under the current categories and settings (GET /api/usage,
 * core/server/usage-summary.ts: the providers' own charges per finished document, the confidence check and any heading
 * search included); a run of N documents is that average times N. A reader with no measurement has no figure: nothing
 * is estimated from word counts, category counts or an assumed reply length. Pure: no DOM.
 */
export interface CostGuideOption { id: string; label: string; experimental: boolean; isDefault: boolean }
export interface MeasuredReaderCost { id: string; sampleDocuments: number; averageCostNanoPerDocument: string | null }
export interface CostGuideRow {
  id: string; name: string; experimental: boolean; isDefault: boolean;
  /** Null when this site has measured nothing for the reader. `width` is the bar, against the dearest measured run. */
  measured: { perDocumentNano: number; documents: number; runNano: number; width: string } | null;
}

export function costGuideRows(options: readonly CostGuideOption[], measured: readonly MeasuredReaderCost[], documents: number): CostGuideRow[] {
  const rows = options.map(option => {
    const seen = measured.find(m => m.id === option.id && m.sampleDocuments > 0 && m.averageCostNanoPerDocument !== null);
    const perDocumentNano = seen ? Number(seen.averageCostNanoPerDocument) : null;
    return { option, seen, perDocumentNano, runNano: perDocumentNano === null ? null : perDocumentNano * documents };
  });
  const dearest = Math.max(0, ...rows.map(row => row.runNano ?? 0));
  return rows.map(({ option, seen, perDocumentNano, runNano }) => ({
    id: option.id, name: option.label, experimental: option.experimental, isDefault: option.isDefault,
    measured: seen === undefined || perDocumentNano === null || runNano === null ? null : {
      perDocumentNano, documents: seen.sampleDocuments, runNano,
      width: `${(dearest > 0 ? runNano / dearest * 100 : 0).toFixed(1)}%`
    }
  }));
}
