/**
 * What a draft changes compared with the active categories (SPEC §6.2 `definition-diff.ts`, §3c step 8, §7.2
 * ChangeReview).
 *
 * Pure. Per category: added, removed, changed or unchanged, and for each changed field the text as segments — kept,
 * added (marked) and removed (struck through and labelled). Examples are compared line by line. The kind of change
 * comes from `definitionChange` (core/config/definitions.ts), exactly as the server decides it: any change to the
 * category file, including the order of the categories, is a change of meaning; a change to website names only is
 * cosmetic.
 */
import { definitionChange, type DefinitionChange } from '../config/definitions.ts';
import type { DocumentType, TypeFile } from '../config/project.ts';

export type SegmentKind = 'same' | 'added' | 'removed';
export interface Segment { kind: SegmentKind; text: string }

export type FieldName = 'name' | 'what' | 'not_for' | 'examples' | 'displayName';
export interface FieldDiff {
  field: FieldName;
  status: 'added' | 'removed' | 'changed';
  /** Text fields: word-level segments. Examples: one segment per example line. */
  segments: readonly Segment[];
}

export interface CategoryDiff {
  id: string;
  /** The name to head the entry with: the draft's for added and kept categories, the active one's for removed. */
  name: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  fields: readonly FieldDiff[];
}

export interface DefinitionDiff {
  change: DefinitionChange;
  categories: readonly CategoryDiff[];
  /** "When nothing fits": its changed fields (name and what). */
  noneOfThese: readonly FieldDiff[];
  /** The categories are in a different order (a change of meaning, even with no text changed). */
  reordered: boolean;
  displayNamesChanged: boolean;
}

export interface DefinitionSide { typeFile: TypeFile; displayNames?: Readonly<Record<string, string>> | null }

/** Words, spaces and punctuation, so a diff can be joined back into the exact text. */
function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Longest-common-subsequence diff of two token lists; above `limit` cells it falls back to remove-all, add-all. */
function diffTokens(a: readonly string[], b: readonly string[], limit = 4_000_000): Segment[] {
  const out: Segment[] = [];
  const push = (kind: SegmentKind, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) push('same', a[lo++]);
  let ha = a.length, hb = b.length;
  const tail: string[] = [];
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) tail.unshift(a[--ha]), hb--;
  const x = a.slice(lo, ha), y = b.slice(lo, hb);
  if (x.length * y.length > limit) {
    for (const t of x) push('removed', t);
    for (const t of y) push('added', t);
  } else {
    const n = x.length, m = y.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) push('removed', x[i++]);
      else push('added', y[j++]);
    }
    while (i < n) push('removed', x[i++]);
    while (j < m) push('added', y[j++]);
  }
  for (const t of tail) push('same', t);
  return out;
}

/** Word-level segments from `before` to `after`. */
export function diffText(before: string, after: string): Segment[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  return diffTokens(tokens(before), tokens(after));
}

/** One segment per example: kept, removed or added, in the draft's order with removed ones where they were. */
export function diffLines(before: readonly string[], after: readonly string[]): Segment[] {
  const segments: Segment[] = [];
  const n = before.length, m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { segments.push({ kind: 'same', text: before[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) segments.push({ kind: 'removed', text: before[i++] });
    else segments.push({ kind: 'added', text: after[j++] });
  }
  while (i < n) segments.push({ kind: 'removed', text: before[i++] });
  while (j < m) segments.push({ kind: 'added', text: after[j++] });
  return segments;
}

const TEXT_FIELDS = ['name', 'what', 'not_for'] as const;

function whole(field: FieldName, status: 'added' | 'removed', value: string | readonly string[]): FieldDiff {
  const kind: SegmentKind = status;
  const segments = typeof value === 'string' ? (value ? [{ kind, text: value }] : [])
    : value.map(text => ({ kind, text }));
  return { field, status, segments };
}

function displayName(side: DefinitionSide | null, id: string): string {
  const names = side?.displayNames;
  return names && Object.hasOwn(names, id) ? names[id] : '';
}

function typeFields(before: DocumentType, after: DocumentType, beforeShown: string, afterShown: string): FieldDiff[] {
  const fields: FieldDiff[] = [];
  for (const field of TEXT_FIELDS)
    if (before[field] !== after[field]) fields.push({ field, status: 'changed', segments: diffText(before[field], after[field]) });
  if (before.examples.length !== after.examples.length || before.examples.some((example, i) => example !== after.examples[i]))
    fields.push({ field: 'examples', status: 'changed', segments: diffLines(before.examples, after.examples) });
  if (beforeShown !== afterShown) {
    const status = !beforeShown ? 'added' : !afterShown ? 'removed' : 'changed';
    fields.push(status === 'changed'
      ? { field: 'displayName', status, segments: diffText(beforeShown, afterShown) }
      : whole('displayName', status, status === 'added' ? afterShown : beforeShown));
  }
  return fields;
}

/**
 * The changes from `active` (null before any categories were activated) to `draft`. Categories are matched by id.
 * Added categories come in the draft's order, then removed ones in the active order.
 */
export function diffDefinitions(active: DefinitionSide | null, draft: DefinitionSide): DefinitionDiff {
  const change = definitionChange(active?.typeFile ?? null, draft.typeFile);
  const before = new Map((active?.typeFile.types ?? []).map(type => [type.id, type]));
  const after = new Map(draft.typeFile.types.map(type => [type.id, type]));
  const categories: CategoryDiff[] = [];
  for (const type of draft.typeFile.types) {
    const old = before.get(type.id);
    const shown = displayName(draft, type.id);
    if (!old) {
      categories.push({
        id: type.id, name: shown || type.name, status: 'added',
        fields: [whole('name', 'added', type.name), whole('what', 'added', type.what), whole('not_for', 'added', type.not_for),
          whole('examples', 'added', type.examples), ...(shown ? [whole('displayName', 'added', shown)] : [])]
      });
      continue;
    }
    const fields = typeFields(old, type, displayName(active, type.id), shown);
    categories.push({ id: type.id, name: shown || type.name, status: fields.length ? 'changed' : 'unchanged', fields });
  }
  for (const type of active?.typeFile.types ?? []) {
    if (after.has(type.id)) continue;
    const shown = displayName(active, type.id);
    categories.push({
      id: type.id, name: shown || type.name, status: 'removed',
      fields: [whole('name', 'removed', type.name), whole('what', 'removed', type.what), whole('not_for', 'removed', type.not_for),
        whole('examples', 'removed', type.examples)]
    });
  }
  const noneOfThese: FieldDiff[] = [];
  if (active) {
    for (const field of ['name', 'what'] as const) {
      const a = active.typeFile.none_of_these[field], b = draft.typeFile.none_of_these[field];
      if (a !== b) noneOfThese.push({ field, status: 'changed', segments: diffText(a, b) });
    }
  }
  const kept = draft.typeFile.types.map(type => type.id).filter(id => before.has(id));
  const keptBefore = (active?.typeFile.types ?? []).map(type => type.id).filter(id => after.has(id));
  const reordered = kept.some((id, i) => id !== keptBefore[i]);
  // Website names of categories kept in both (added and removed categories are reported as such).
  const displayNamesChanged = kept.some(id => displayName(active, id) !== displayName(draft, id));
  return { change, categories, noneOfThese, reordered, displayNamesChanged };
}
