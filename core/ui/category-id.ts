/**
 * The folder name (category id) for a new category (SPEC §6.2 `category-id.ts`, §3a step 2).
 *
 * Pure. Lower case, ASCII only, words joined by `_`, prefixed `c_` when it would start with a digit, and suffixed
 * `_2`, `_3` … when it would clash with an id already used or with a reserved word. Every id it returns passes the id
 * rule of `validateTypes` (core/config/project.ts). Existing ids are never changed: this is only for categories that
 * do not have an id yet. The id is shown only in Details, as "Folder name in your sorted copies".
 */

import { RESERVED_TYPE_IDS } from '../config/project.ts';

/** The id rule of `validateTypes`. */
export const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * The reserved ids of `validateTypes`, from its single source in core/config/project.ts: the builder's own folders,
 * the certainty check's "none of these", Windows device names, and object-prototype names.
 */
export const RESERVED_CATEGORY_IDS: ReadonlySet<string> = RESERVED_TYPE_IDS;

/** Used when a name has no letters or digits that fold to ASCII (for example, only symbols). */
const EMPTY_BASE = 'category';
/** Keeps folder names well inside Windows path limits; the cut falls on a word boundary where possible. */
export const CATEGORY_ID_MAX = 48;

/** Letters that do not decompose into an ASCII base letter under NFKD. */
const FOLD: Readonly<Record<string, string>> = {
  ß: 'ss', ẞ: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', ø: 'o', Ø: 'o', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th', ł: 'l', Ł: 'l', ı: 'i', ħ: 'h', Ħ: 'h', ŧ: 't', Ŧ: 't', ŋ: 'n', Ŋ: 'n', ĸ: 'k'
};

/** The id a name folds to before clash handling: may be reserved or taken. */
export function baseIdFromName(name: string): string {
  const folded = name.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\u0000-\u007f]/g, ch => FOLD[ch] ?? ' ');
  let id = folded.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id) id = EMPTY_BASE;
  if (/^[0-9]/.test(id)) id = `c_${id}`;
  if (id.length > CATEGORY_ID_MAX) {
    const cut = id.slice(0, CATEGORY_ID_MAX), boundary = cut.lastIndexOf('_');
    id = (boundary >= CATEGORY_ID_MAX / 2 ? cut.slice(0, boundary) : cut).replace(/_+$/, '');
  }
  return id;
}

/** A new, unused, valid id for `name`. `existingIds` are the ids already in the draft (and any others to avoid). */
export function idFromName(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const base = baseIdFromName(name);
  const free = (id: string) => CATEGORY_ID_PATTERN.test(id) && !RESERVED_CATEGORY_IDS.has(id) && !taken.has(id);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (free(id)) return id;
  }
}

/**
 * Ids for a list of category cards in the editor: a card that already has an id keeps it, unchanged; each card
 * without one gets `idFromName` against every other id in the list (and `avoid`), in order.
 */
export function assignCategoryIds(cards: readonly { id: string | null; name: string }[], avoid: Iterable<string> = []): string[] {
  const taken = new Set(avoid);
  for (const card of cards) if (card.id) taken.add(card.id);
  return cards.map(card => {
    if (card.id) return card.id;
    const id = idFromName(card.name, taken);
    taken.add(id);
    return id;
  });
}
