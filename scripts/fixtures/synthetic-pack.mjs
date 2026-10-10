// Synthetic project packs for tests and acceptance scripts (Scale §4 P0-2, §6 WP 0.1).
//
// A pack has n categories with neutral ids type_001 … type_254 and placeholder wording only. It carries no corpus
// content, no category of any real deployment and no evaluation finding. Settings, prices and limits are copied from
// the shipped generic pack (projects/generic/project.json) so that acceptance scripts exercise the shipped
// configuration; model pins keep the generic pack's id, date and policy but carry a neutral reason.
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {COMPACT_READER_CONTRACT, EXACT_READER_CONTRACT, GROUPED_CONFIDENCE_POLICY, readerCapacity} from '../../core/config/capacity.ts';

/** The type-file cap enforced by core/config/project.ts (Jev's 255 options include none_of_these). */
export const MAX_CATEGORIES = 254;
/** Category counts the fixtures are built for (Scale §4 P0-2). */
export const FIXTURE_CATEGORY_COUNTS = Object.freeze([1, 2, 4, 50, 254]);
/** Category counts every gate acceptance script runs at (Scale §6 WP 0.1). */
export const GATE_CATEGORY_COUNTS = Object.freeze([1, 4, 254]);
export const SYNTHETIC_PROJECT_ID = 'synthetic';
export const SYNTHETIC_PRODUCT_NAME = 'Synthetic classifier';
/** Document-part terms that share no word with any synthetic category's name, description or examples. */
export const SYNTHETIC_STRUCTURAL_VOCABULARY = Object.freeze(['appendix', 'references', 'glossary']);

const GENERIC_PACK = new URL('../../projects/generic/project.json', import.meta.url);

const ordinalText = ordinal => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 999)
    throw new RangeError('A synthetic category ordinal is an integer from 1 to 999.');
  return String(ordinal).padStart(3, '0');
};

/** `type_001` for ordinal 1. */
export function syntheticTypeId(ordinal) {
  return 'type_' + ordinalText(ordinal);
}

/** One placeholder category definition. */
export function syntheticType(ordinal) {
  const text = ordinalText(ordinal);
  return {
    id: 'type_' + text,
    name: 'Category ' + text,
    what: `Synthetic material of kind ${text}.`,
    not_for: 'Synthetic material of any other kind.',
    examples: [`A synthetic sample of kind ${text}.`]
  };
}

/** A type file with `count` categories. Counts above MAX_CATEGORIES are allowed so that refusals can be tested. */
export function syntheticTypeFile(count) {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new RangeError('A synthetic category count is a nonnegative integer.');
  return {
    types: Array.from({length: count}, (_, index) => syntheticType(index + 1)),
    none_of_these: {name: 'None of these', what: 'The document does not fit any defined type.'}
  };
}

/** The shipped generic pack, read fresh on every call so no caller can mutate another's copy. */
export function shippedGenericPack() {
  return JSON.parse(readFileSync(GENERIC_PACK, 'utf8').replace(/^﻿/, ''));
}

/**
 * The large-set settings of a synthetic pack with more categories than the exact reader answer format carries under the
 * shipped settings: the compact reader answer, the grouped confidence questions and four bytes per token.
 */
// synthetic gate pack: exercises the large-set code paths; not a capacity claim
export const LARGE_SET_SETTINGS = Object.freeze({
  readerContract: COMPACT_READER_CONTRACT,
  confidenceQuestionPolicy: GROUPED_CONFIDENCE_POLICY,
  tokenBytesRatio: 4
});

/**
 * A complete, valid project pack with `count` synthetic categories.
 * Above the exact reader capacity of the shipped settings (89) the pack declares LARGE_SET_SETTINGS.
 * `settings` entries then replace settings one by one; a value of `undefined` removes that setting, which is how a
 * frozen historical pack (from before a setting existed) is modelled.
 */
export function syntheticPack(count, options = {}) {
  const {
    id = SYNTHETIC_PROJECT_ID,
    productName = SYNTHETIC_PRODUCT_NAME,
    settings = {},
    structuralVocabulary = SYNTHETIC_STRUCTURAL_VOCABULARY
  } = options;
  const generic = shippedGenericPack();
  const mergedSettings = {...generic.settings};
  if (count > readerCapacity({settings: {...generic.settings, readerContract: EXACT_READER_CONTRACT}}).limit)
    Object.assign(mergedSettings, LARGE_SET_SETTINGS);
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete mergedSettings[key];
    else mergedSettings[key] = value;
  }
  const pin = role => ({
    id: generic.pins[role].id,
    date: generic.pins[role].date,
    reason: 'Synthetic fixture: the shipped generic pack pin.',
    policy: generic.pins[role].policy
  });
  return {
    schemaVersion: 2,
    id,
    productName,
    typeFile: syntheticTypeFile(count),
    structuralVocabulary: [...structuralVocabulary],
    settings: mergedSettings,
    pins: {confidence: pin('confidence'), reader: pin('reader'), recovery: pin('recovery')},
    budget: {limitNano: null, approvedBy: null, approvedAt: null, reason: null},
    limits: structuredClone(generic.limits),
    prices: structuredClone(generic.prices)
  };
}

/**
 * An esbuild plugin that resolves the Worker's `project-pack` import to `pack`, so a bundle can be built for any
 * synthetic pack without writing it to disk. Use it instead of an `alias` entry for `project-pack`.
 */
export function projectPackPlugin(pack) {
  const contents = JSON.stringify(pack);
  return {
    name: 'synthetic-project-pack',
    setup(build) {
      build.onResolve({filter: /^project-pack$/}, () => ({path: 'project-pack', namespace: 'synthetic-project-pack'}));
      build.onLoad({filter: /.*/, namespace: 'synthetic-project-pack'}, () => ({contents, loader: 'json'}));
    }
  };
}

/**
 * The category counts a script runs at: `--categories=1,4,254` on the command line, otherwise `defaults`.
 * An invalid value fails loudly instead of being dropped.
 */
export function categoryCounts(argv = process.argv.slice(2), defaults = GATE_CATEGORY_COUNTS) {
  const flag = argv.find(value => value.startsWith('--categories='));
  if (!flag) return [...defaults];
  const counts = flag.slice('--categories='.length).split(',').map(value => Number(value.trim()));
  if (!counts.length || counts.some(value => !Number.isSafeInteger(value) || value < 1 || value > MAX_CATEGORIES) ||
      new Set(counts).size !== counts.length)
    throw new Error('--categories takes distinct integers from 1 to ' + MAX_CATEGORIES + ', for example --categories=1,4,254.');
  return counts;
}

const failedAt = (categories, error) =>
  new Error(`Failed with ${categories} synthetic ${categories === 1 ? 'category' : 'categories'}.`, {cause: error});

const CHILD_ENV = 'SYNTHETIC_CATEGORY_CHILD';
const RESULT_MARKER = '@@synthetic-category-result ';

// One child process per category count: the script itself, re-run with --categories=<n>.
function runChild(script, categories) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [script, `--categories=${categories}`], {
      env: {...process.env, [CHILD_ENV]: String(categories)},
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolvePromise({categories, error, stdout, stderr}));
    child.on('close', code => resolvePromise({categories, code, stdout, stderr}));
  });
}

/**
 * Runs `scenario(count)` once per category count and returns `[{categories, result}]` in the order of `counts`.
 * A failure names the category count it happened at and fails the script.
 *
 * `{isolate: import.meta.url}` runs each count in its own child process (the calling script re-run with
 * `--categories=<n>`), all at the same time, for scripts whose runtime is dominated by synchronous local proxy
 * calls. Each child owns its whole runtime; the result must be JSON. Every child is awaited before the first failure
 * is reported, its output is replayed with an `[n=<count>]` prefix, and a child that exits without a result fails.
 */
export async function eachCategoryCount(counts, scenario, {isolate} = {}) {
  const childCount = process.env[CHILD_ENV];
  if (isolate && childCount !== undefined) {
    // In a child: run the one count, report it, and end before the parent's summary code runs.
    if (counts.length !== 1 || String(counts[0]) !== childCount)
      throw new Error('A category child process runs exactly the count it was started for.');
    const result = await scenario(counts[0]);
    process.stdout.write(RESULT_MARKER + JSON.stringify({categories: counts[0], result}) + '\n', () => process.exit(0));
    return new Promise(() => {});
  }
  if (isolate) {
    const script = fileURLToPath(isolate);
    const outcomes = await Promise.all(counts.map(categories => runChild(script, categories)));
    const results = [];
    let failure = null;
    for (const outcome of outcomes) {
      const lines = outcome.stdout.split(/\r?\n/);
      const marker = lines.find(line => line.startsWith(RESULT_MARKER));
      for (const line of lines) if (line && !line.startsWith(RESULT_MARKER)) process.stdout.write(`[n=${outcome.categories}] ${line}\n`);
      for (const line of outcome.stderr.split(/\r?\n/)) if (line) process.stderr.write(`[n=${outcome.categories}] ${line}\n`);
      if (outcome.error || outcome.code !== 0 || !marker) {
        failure ??= failedAt(outcome.categories, outcome.error ?? new Error(
          `The child process exited with code ${outcome.code}${marker ? '' : ' and no result'}.`));
        continue;
      }
      results.push(JSON.parse(marker.slice(RESULT_MARKER.length)));
    }
    if (failure) throw failure;
    return results;
  }
  const results = [];
  for (const categories of counts) {
    let result;
    try {
      result = await scenario(categories);
    } catch (error) {
      throw failedAt(categories, error);
    }
    results.push({categories, result});
  }
  return results;
}

/** The sum of `result.checks` over `[{categories, result: {checks}}]`. */
export function totalChecks(results) {
  return results.reduce((sum, {result}) => sum + result.checks, 0);
}

/** "synthetic categories n=1: 41, n=4: 41, n=254: 41" for `[{categories, result: {checks}}]`. */
export function countBreakdown(results) {
  return 'synthetic categories ' + results.map(({categories, result}) => `n=${categories}: ${result.checks}`).join(', ');
}

/** "123 checks passed (synthetic categories n=1: 41, n=4: 41, n=254: 41)" for `[{categories, result: {checks}}]`. */
export function checkSummary(results, noun = 'checks') {
  return `${totalChecks(results)} ${noun} passed (${countBreakdown(results)})`;
}
