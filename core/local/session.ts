interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void
}

export function currentLocalExtraction(shared: StorageLike, tab: StorageLike): string | null {
  return tab.getItem('local-extraction-run') ?? shared.getItem('local-extraction-run');
}

export function referenceForExtraction(shared: StorageLike, id: string): string | null {
  return shared.getItem('local-reference:' + id) || null;
}

/** Select a new local identity only; preserve every previous record and server association. */
export function beginLocalExtraction(
  shared: StorageLike,
  tab: StorageLike,
  referenceId: string | null,
  id: string
): string {
  tab.setItem('local-extraction-run', id);
  tab.setItem('workspace-reference', referenceId ?? '');
  shared.setItem('local-extraction-run', id);
  shared.setItem('local-reference:' + id, referenceId ?? '');
  return id;
}

/** One-time legacy migration: a newly confirmed reference must not reuse unrelated local state. */
export function ensureLocalExtraction(
  shared: StorageLike,
  tab: StorageLike,
  newId: () => string
): string {
  const reference =
    tab.getItem('workspace-reference') ?? shared.getItem('workspace-reference') ?? '';
  tab.setItem('workspace-reference', reference);
  const current = currentLocalExtraction(shared, tab);
  if (!current || referenceForExtraction(shared, current) !== (reference || null))
    return beginLocalExtraction(shared, tab, reference || null, newId());
  tab.setItem('local-extraction-run', current);
  if (shared.getItem('local-reference:' + current) === null)
    shared.setItem('local-reference:' + current, reference);
  return current;
}
