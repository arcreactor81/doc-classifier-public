/**
 * What the category review shows of a draft (SPEC §7.2 ChangeReview, walkthrough 3c step 8): the categories it adds,
 * removes and changes compared with the active categories, each changed field with its word-level differences from
 * `diffDefinitions` (definition-diff.ts), and whether activating it starts automatic filing again at 90%.
 *
 * Pure. Before any categories are active there is nothing to compare with: `null`, and the review shows the draft's
 * categories alone. Filing starts again at 90% only for a change of meaning, exactly as the server decides it
 * (`definitionChange`, core/config/definitions.ts); a change to website names only keeps the current filing
 * certainty. The editor saves each category's website name as its name, so a renamed category differs in both: its
 * website name is listed only when it says something the name does not.
 */
import { diffDefinitions, diffText, type DefinitionSide, type FieldDiff, type FieldName, type Segment } from './definition-diff.ts';
import type { Phrase } from './journey.ts';

export interface FieldChange {
  field: FieldName;
  label: Phrase;
  /** Examples: one segment per example. Every other field: the word-level segments of one text. */
  lines: boolean;
  segments: readonly Segment[];
}

export interface CategoryChange {
  id: string;
  /** The draft's name for added and changed categories, the active one's for removed. */
  name: string;
  status: 'added' | 'removed' | 'changed';
  /** Changed categories: the fields that differ. Added and removed ones are named only. */
  fields: readonly FieldChange[];
}

export interface CategoryChanges {
  /** Added and changed categories in the draft's order, then removed ones in the active order. */
  categories: readonly CategoryChange[];
  /** The name and meaning for documents that fit no category, where they changed. */
  noneOfThese: readonly FieldChange[];
  /** The categories are in a different order: a change of meaning even with no text changed. */
  reordered: boolean;
  /** A change of meaning: automatic filing starts again at 90% unless the person keeps the current certainty. */
  resetsCertainty: boolean;
  /** Nothing a person would see differs from the active categories. */
  same: boolean;
}

const LABELS: Readonly<Record<FieldName, string>> = {
  name: 'categories.name',
  displayName: 'categories.shownName',
  what: 'common.definition.what',
  not_for: 'common.definition.notFor',
  examples: 'common.definition.examples'
};
const NONE_LABELS: Readonly<Partial<Record<FieldName, string>>> = { name: 'categories.noneName', what: 'categories.noneWhat' };

const fieldChange = (diff: FieldDiff, key: string): FieldChange =>
  ({ field: diff.field, label: { key }, lines: diff.field === 'examples', segments: diff.segments });

/** The name a category is shown with: its website name, or its own name when it has none. */
function shownName(side: DefinitionSide, id: string, name: string): string {
  const names = side.displayNames;
  return (names && Object.hasOwn(names, id) ? names[id] : '') || name;
}

export function categoryChanges(active: DefinitionSide | null, draft: DefinitionSide): CategoryChanges | null {
  if (active === null) return null;
  const diff = diffDefinitions(active, draft);
  const before = new Map(active.typeFile.types.map(type => [type.id, type]));
  const after = new Map(draft.typeFile.types.map(type => [type.id, type]));
  const categories: CategoryChange[] = [];
  for (const category of diff.categories) {
    const { id, name, status } = category;
    if (status === 'unchanged') continue;
    if (status !== 'changed') { categories.push({ id, name, status, fields: [] }); continue; }
    const old = before.get(id)!, next = after.get(id)!;
    const fields = category.fields.filter(field => field.field !== 'displayName').map(field => fieldChange(field, LABELS[field.field]));
    const shownBefore = shownName(active, id, old.name), shownAfter = shownName(draft, id, next.name);
    if (shownBefore !== shownAfter && (shownBefore !== old.name || shownAfter !== next.name)) {
      const shown: FieldChange = { field: 'displayName', label: { key: LABELS.displayName }, lines: false, segments: diffText(shownBefore, shownAfter) };
      fields.splice(fields[0]?.field === 'name' ? 1 : 0, 0, shown);
    }
    if (fields.length) categories.push({ id, name, status, fields });
  }
  const noneOfThese = diff.noneOfThese.map(field => fieldChange(field, NONE_LABELS[field.field]!));
  return {
    categories, noneOfThese, reordered: diff.reordered,
    resetsCertainty: diff.change === 'semantic',
    same: categories.length === 0 && noneOfThese.length === 0 && !diff.reordered
  };
}
