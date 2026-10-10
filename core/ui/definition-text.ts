/**
 * Sentences of a category definition and which neighbouring categories they name (SPEC §6.2 `definition-text.ts`,
 * §7.1 DefinitionCard, §7.2 JudgedAgainst and DefinitionsPanel "Compare two categories").
 *
 * Pure. Used to mark, in one category's definition, the sentences that name the category it is being compared with,
 * with the text "names ‹category›" beside the mark. The text itself is never changed.
 */
import { words } from '../config/project.ts';

/** A sentence of `text`: the trimmed slice `text.slice(start, end)`. */
export interface SentenceSpan { text: string; start: number; end: number }

/** Words after which a full stop does not end a sentence. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'incl', 'no', 'nos', 'fig', 'figs', 'dr', 'mr', 'mrs',
  'ms', 'st', 'eg', 'ie', 'ca', 'resp', 'p', 'pp', 'vol', 'ch', 'sec']);

/**
 * The sentences of `text`, with their positions. A sentence ends at `.`, `!`, `?` or `…` (plus closing quotes or
 * brackets) followed by white space, or at a line break; a full stop after a common abbreviation ("e.g.") does not
 * end one.
 */
export function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length, body = raw.trim();
    if (body) spans.push({ text: body, start: start + lead, end: start + lead + body.length });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      push(i);
      continue;
    }
    if (!'.!?…'.includes(ch)) continue;
    let end = i + 1;
    while (end < text.length && '"\'”’)]»'.includes(text[end])) end++;
    if (end < text.length && !/\s/.test(text[end])) continue;
    if (ch === '.') {
      const before = /([\p{L}.]+)$/u.exec(text.slice(start, i))?.[1]?.toLowerCase() ?? '';
      if (ABBREVIATIONS.has(before.replace(/\.$/, ''))) continue;
    }
    push(end);
    i = end - 1;
  }
  push(text.length);
  return spans;
}

export function sentences(text: string): string[] {
  return sentenceSpans(text).map(span => span.text);
}

/** A category name as words, for matching: "Course plan" → ['course', 'plan']. */
function nameWords(name: string): string[] {
  return words(name);
}

/** True when `tokens` contains `target` as a run of words; the last word may carry a plural "s" or "es". */
function containsRun(tokens: readonly string[], target: readonly string[]): boolean {
  if (!target.length) return false;
  const last = target[target.length - 1];
  for (let i = 0; i + target.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length - 1 && ok; j++) ok = tokens[i + j] === target[j];
    const tail = tokens[i + target.length - 1];
    if (ok && (tail === last || tail === `${last}s` || tail === `${last}es`
      || (last.endsWith('s') && tail === last.slice(0, -1)))) return true;
  }
  return false;
}

/** The names from `names` that `sentence` mentions (case- and punctuation-insensitive, whole words), in `names` order. */
export function mentions(sentence: string, names: readonly string[]): string[] {
  const tokens = words(sentence);
  const found: string[] = [];
  for (const name of names) if (!found.includes(name) && containsRun(tokens, nameWords(name))) found.push(name);
  return found;
}

export interface MarkedSentence extends SentenceSpan { mentions: readonly string[] }

/** Each sentence of `text`, with the neighbour names it mentions (empty when none). */
export function markSentences(text: string, names: readonly string[]): MarkedSentence[] {
  return sentenceSpans(text).map(span => ({ ...span, mentions: mentions(span.text, names) }));
}

export interface MarkedDefinition {
  what: readonly MarkedSentence[];
  notFor: readonly MarkedSentence[];
  examples: readonly (readonly MarkedSentence[])[];
}

/** A category's definition with the sentences that name any of `neighbourNames` marked. */
export function markDefinition(type: { what: string; not_for: string; examples: readonly string[] },
  neighbourNames: readonly string[]): MarkedDefinition {
  return {
    what: markSentences(type.what, neighbourNames),
    notFor: markSentences(type.not_for, neighbourNames),
    examples: type.examples.map(example => markSentences(example, neighbourNames))
  };
}
