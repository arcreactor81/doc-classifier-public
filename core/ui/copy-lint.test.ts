import { trialCopy } from './copy-trial.ts';
import { bakeoffCopy } from './copy-bakeoff.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uiCopy } from './copy.ts';
import { JARGON_PATTERNS, hasJargon } from './error-copy.ts';
import { serverCopy, accessCopy, dailyAllowanceCopy } from '../server/errors.ts';
import { journeyCopy } from './copy-journey.ts';
import { commonCopy } from './copy-common.ts';
import { shellCopy } from './copy-shell.ts';
import { filesCopy } from './copy-files.ts';
import { confirmCopy } from './copy-confirm.ts';
import { progressCopy } from './copy-progress.ts';
import { phasesCopy } from './copy-phases.ts';
import { reasonsCopy } from './copy-reasons.ts';
import { resultsCopy } from './copy-results.ts';
import { evidenceCopy } from './copy-evidence.ts';
import { buildCopy } from './copy-build.ts';
import { reviewCopy } from './copy-review.ts';
import { improveCopy } from './copy-improve.ts';
import { compareCopy } from './copy-compare.ts';
import { categoriesCopy } from './copy-categories.ts';
import { homeCopy } from './copy-home.ts';
import { systemCopy } from './copy-system.ts';
import { helpCopy } from './copy-help.ts';
import { errorsCopy } from './copy-errors.ts';
import { lightCopy } from './copy-light.ts';
import { usageCopy } from './copy-usage.ts';

/**
 * The normal-path copy groups of SPEC §6.5: group → [property on uiCopy, the group file's export].
 * copy.ts's own (legacy) strings and the server's person-facing `serverCopy` are scanned by the tests at the end.
 */
const GROUPS: Readonly<Record<string, readonly [string, unknown]>> = {
  bakeoff: ['bakeoff', bakeoffCopy],
  trial: ['trial', trialCopy],
  journey: ['journey', journeyCopy],
  common: ['common', commonCopy],
  shell: ['shell', shellCopy],
  files: ['screenFiles', filesCopy],
  confirm: ['screenConfirm', confirmCopy],
  progress: ['screenProgress', progressCopy],
  phases: ['phases', phasesCopy],
  reasons: ['reasons', reasonsCopy],
  results: ['screenResults', resultsCopy],
  evidence: ['evidence', evidenceCopy],
  build: ['screenBuild', buildCopy],
  review: ['review', reviewCopy],
  improve: ['improve', improveCopy],
  compare: ['compare', compareCopy],
  categories: ['categories', categoriesCopy],
  home: ['home', homeCopy],
  system: ['system', systemCopy],
  help: ['help', helpCopy],
  errors: ['errors', errorsCopy],
  light: ['light', lightCopy],
  usage: ['usage', usageCopy]
};

/** SPEC §10.1, verbatim. */
const SPEC_PATTERNS: readonly RegExp[] = [
  /\b(manifest|json|fingerprint|sidecar|git|repository|project pack|pins?|workflow|tokens?|http|inference|aud|uuid|technical contact|kill switch|threshold|filing bar|noul|probability)\b/i,
  /\b[EN]_[A-Z_]{3,}\b/,
  /\bR[0-5]n?\b/,
  /\.json\b/
];
/** Plural and variant forms of the same jargon, which the word boundaries above would let through. */
const VARIANT_PATTERNS: readonly RegExp[] = [
  /\b(manifests|fingerprints|sidecars|repositories|project packs|workflows|https|uuids|thresholds|nouls|probabilities)\b/i
];
const BANNED = [...SPEC_PATTERNS, ...VARIANT_PATTERNS];

/**
 * Keys whose default SPEC §6.5 makes binding; `()` marks a function-valued key. Wording may improve through
 * the group file (SPEC §0), so only existence and kind are checked.
 */
const BINDING: Readonly<Record<string, readonly string[]>> = {
  bakeoff: ['title', 'prepare', 'confirmArm()', 'missing', 'stale'],
  trial: ['selectionTitle','confirm','prepareFull','right','wrong','vendors.fake','vendors.live'],
  journey: ['chapters.files', 'chapters.start', 'chapters.sorting', 'chapters.folders', 'chapters.improve',
    'stepOf()', 'newRun()',
    // Keys other packages use as labels and narration (WP-3 request): they must keep existing.
    'go.confirm', 'go.results', 'go.build', 'go.review', 'go.improve', 'go.compare',
    'action.chooseFolder', 'action.goHome', 'runName()', 'now.uploadStalled()', 'now.sending()'],
  common: ['showMore()', 'unknown', 'checkedAt()', 'lastChange()', 'whyUnavailable'],
  shell: ['setupComplete', 'setupAttention'],
  files: ['permissionTip'],
  // `batchParked` left the binding list with the run-mode choice: every run is Interactive, so nothing is parked.
  confirm: ['carried()', 'limitField', 'noEstimate', 'start', 'finishStarting'],
  progress: ['continueSending', 'continuesNote()', 'discard', 'activityTitle', 'killStopped', 'seeResults'],
  phases: [],
  reasons: ['placeReview', 'placeFailed'],
  results: ['makeFolders', 'saveCopy', 'downloading()', 'deleteText'],
  evidence: ['certaintyCheck', 'independentCheck', 'reader', 'quotes', 'judgedAgainst', 'systemPlaced',
    'youPlaced', 'whatRead', 'onlyHere', 'speakerNotes'],
  build: ['make', 'stop', 'reviewNext'],
  // Nine folder-checklist texts left the binding list with the checklist (owner, 7 October 2026; DECISIONS 138):
  // the review is cards, and no screen showed them.
  review: ['readChanges', 'newCategory', 'ignore', 'lookAgain', 'save', 'nextImprove', 'confusion()'],
  improve: ['apply()', 'update', 'keep'],
  compare: ['save', 'runAgain', 'carry()'],
  categories: ['review', 'startUsing', 'activate', 'keepCertainty', 'nextAnswers'],
  home: ['setUp', 'newRun', 'pickUp', 'open()', 'forgetDraft'],
  system: ['readyMeaning'],
  help: [],
  errors: [],
  light: [],
  usage: []
};

/**
 * Sample arguments for function-valued keys. Every set is tried; at least one must return a string, and every
 * string returned is scanned. A key that needs other arguments is listed in SAMPLE_OVERRIDES by its path.
 */
const SAMPLE_SETS: readonly unknown[][] = [[2], [1], ['Sample name'], [['Sample one', 'Sample two']], [{}]];
const SAMPLE_OVERRIDES: Readonly<Record<string, readonly unknown[][]>> = {};

interface Scan { strings: { path: string; text: string }[]; problems: string[] }

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function scanValue(value: unknown, path: string, depth: number, out: Scan, keepDetails = false): void {
  if (typeof value === 'string') {
    out.strings.push({ path, text: value });
    return;
  }
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    const sets = SAMPLE_OVERRIDES[path] ??
      SAMPLE_SETS.map(set => Array.from({ length: Math.max(fn.length, 1) }, () => set[0]));
    let called = 0;
    for (const args of sets) {
      let result: unknown;
      try {
        result = fn(...args);
      } catch {
        continue;
      }
      if (typeof result !== 'string') {
        out.problems.push(`${path}() returned ${typeof result}; function-valued copy returns a string`);
        return;
      }
      called++;
      out.strings.push({ path: `${path}(${args.map(arg => JSON.stringify(arg)).join(', ')})`, text: result });
    }
    if (!called) out.problems.push(`${path}() could not be called with any sample arguments (add SAMPLE_OVERRIDES)`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, `${path}[${index}]`, depth + 1, out, keepDetails));
    return;
  }
  if (plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      // `<group>.details` is the Details layer: exempt from the jargon scan, never from the words no copy may use.
      if (depth === 0 && key === 'details' && plainObject(item) && !keepDetails) continue;
      scanValue(item, `${path}.${key}`, depth + 1, out, keepDetails);
    }
    return;
  }
  out.problems.push(`${path} is a ${value === null ? 'null' : typeof value}; copy values are strings, functions, arrays or objects`);
}

function scanGroup(name: string, value: unknown, keepDetails = false): Scan {
  const out: Scan = { strings: [], problems: [] };
  if (!plainObject(value)) out.problems.push(`${name} is not a plain object`);
  else scanValue(value, name, 0, out, keepDetails);
  return out;
}

function jargon(scan: Scan): string[] {
  const found: string[] = [];
  for (const { path, text } of scan.strings)
    for (const pattern of BANNED) {
      const match = pattern.exec(text);
      if (match) found.push(`${path}: "${match[0]}" in ${JSON.stringify(text)}`);
    }
  return found;
}

function lookup(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (!plainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

test('every §6.5 copy group is registered once on uiCopy and exports <group>Copy', () => {
  const registered = uiCopy as unknown as Record<string, unknown>;
  for (const [group, [property, value]] of Object.entries(GROUPS))
    assert.equal(registered[property], value, `uiCopy.${property} is the ${group} group`);
  assert.equal(new Set(Object.values(GROUPS).map(([property]) => property)).size, Object.keys(GROUPS).length);
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(directory).filter(name => /^copy-[a-z-]+\.ts$/.test(name) && !name.endsWith('.test.ts'));
  assert.deepEqual(files.map(name => name.slice(5, -3)).sort(), Object.keys(GROUPS).sort(),
    'every core/ui/copy-<group>.ts file is a registered group, and every group has a file');
  for (const group of Object.keys(GROUPS)) {
    const source = readFileSync(`${directory}copy-${group}.ts`, 'utf8');
    assert.match(source, new RegExp(`export const ${group}Copy = \\{`), `copy-${group}.ts exports ${group}Copy`);
    assert.doesNotMatch(source, /from\s+['"]\.\/(?:copy|project-copy)\.ts['"]/,
      `copy-${group}.ts must not import copy.ts or project-copy.ts (copy.ts imports it)`);
  }
});

test('the keys §6.5 makes binding exist with the right kind', () => {
  const missing: string[] = [];
  for (const [group, paths] of Object.entries(BINDING)) {
    const value = GROUPS[group][1];
    for (const entry of paths) {
      const fn = entry.endsWith('()'), path = fn ? entry.slice(0, -2) : entry;
      const found = lookup(value, path);
      if (fn ? typeof found !== 'function' : typeof found !== 'string')
        missing.push(`${group}.${path} should be a ${fn ? 'function' : 'string'}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(BINDING).sort(), Object.keys(GROUPS).sort());
});

test('normal-path copy has no jargon, codes, rule ids or file formats (Details sub-objects exempt)', () => {
  const findings: string[] = [], problems: string[] = [];
  let strings = 0;
  for (const [group, [, value]] of Object.entries(GROUPS)) {
    const scan = scanGroup(group, value);
    strings += scan.strings.length;
    problems.push(...scan.problems);
    findings.push(...jargon(scan));
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(findings, []);
  assert.ok(strings > 0, 'the scan saw copy');
});

test('the lint catches jargon in strings, arrays and function results, and exempts only <group>.details', () => {
  const sample = {
    plain: 'Everything is fine here.',
    word: 'Download the manifest now.',
    plural: 'Thresholds were checked.',
    code: 'Failed with E_KILL_SWITCH.',
    rule: 'Filed by R1 today.',
    format: 'Save results.json somewhere.',
    list: ['Fine', 'Compare the fingerprint'],
    fn: (name: string) => `Open the ${name} workflow`,
    throws: (list: string[]) => list.join(', ') + ' via http',
    nested: { details: { raw: 'The raw uuid is shown here.' } },
    details: { id: 'Technical: the sidecar and the JSON file.' }
  };
  const scan = scanGroup('sample', sample);
  assert.deepEqual(scan.problems, []);
  const paths = jargon(scan).map(line => line.slice(0, line.indexOf(':')));
  for (const expected of ['sample.word', 'sample.plural', 'sample.code', 'sample.rule', 'sample.format',
    'sample.list[1]', 'sample.nested.details.raw'])
    assert.ok(paths.includes(expected), `${expected} is flagged`);
  assert.ok(paths.some(path => path.startsWith('sample.fn(')), 'function results are scanned');
  assert.ok(paths.some(path => path.startsWith('sample.throws(')), 'an array argument is tried');
  assert.ok(!paths.some(path => path.startsWith('sample.details')), '<group>.details is exempt');
  assert.ok(!paths.includes('sample.plain'));
  const broken = scanGroup('broken', { count: 3, odd: () => 7, never: (value: { deep: { x: string } }) => value.deep.x.trim() });
  assert.equal(broken.problems.length, 3, broken.problems.join('\n'));
});

// --- copy.ts's own strings, the server's person-facing sentences, and the two words AGENTS restricts ------------------
// (Test audit of 7 October 2026: copy.ts and serverCopy were never scanned, and nothing checked "fast" or "filed".)

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const GROUP_PROPERTIES = new Set(Object.values(GROUPS).map(([property]) => property));
/** copy.ts's own strings: everything on uiCopy that is not a §6.5 group (resultFiled, nav, details, loading, …). */
const FLAT: Record<string, unknown> = Object.fromEntries(Object.entries(uiCopy).filter(([key]) => !GROUP_PROPERTIES.has(key)));

/**
 * copy.ts strings that still carry jargon, kept from the legacy UI. No screen renders them: no product source reads
 * them (checked below), so they are not normal-path copy. The list is exact: a new string with jargon fails, so does one
 * of these coming back into use (reword it first), and one deleted or reworded must leave the list. This is a reference
 * check, not a reading of meaning: a key read through a computed name would escape it.
 *
 * Only `setupDetail` is left. A project pack may override it (COPY_OVERRIDE_PATHS in project-copy.ts), so deleting it
 * would change what a pack may say. The other 25 legacy strings were deleted on 8 October 2026: nothing in ui/, core/
 * or scripts/ read them.
 */
const LEGACY_UNRENDERED: readonly string[] = ['setupDetail'];
/**
 * Read by code, but only into Details: the refused project copy's message becomes a client note and the server issue's
 * detail; the normal path shows error-copy's plain "settings" line for E_PROJECT_COPY.
 */
const DETAILS_ONLY: readonly string[] = ['invalidProjectCopy'];

/**
 * Server sentences with jargon that the browser never shows as they are: error-copy.ts replaces a headline or an action
 * that matches its patterns (the same patterns as this lint, checked below) with a plain one and keeps the server's in
 * Details; `reasons` are the results file's notes, and the screens use their own (copy-reasons.ts). Exact, as above.
 */
const SERVER_GUARDED: readonly string[] = [
  'serverCopy.action', 'serverCopy.cachedResultsMismatch', 'serverCopy.corrections.E_CORRECTION_MANIFEST_IDENTITY.action',
  'serverCopy.reasons.agreement_at_threshold', 'serverCopy.reasons.low_certainty', 'serverCopy.runKilled',
  'serverCopy.runSizeUnknownUsage', 'serverCopy.workflowAssociationUnconfirmed'
];

/**
 * AGENTS UI rule: "filed" is used only for R1, the automatic filing outcome. A lint cannot read meaning, so every copy
 * string that uses the word is listed here after a person checked that it names R1: a document both systems agreed on
 * at or above the filing certainty, its folder, its count, or that rule (checked 7 October 2026). A new use fails until it
 * is checked and added; one that stops using the word must leave the list. ("misfiled" and "filing" are other words.)
 */
const FILED_MEANS_R1: readonly string[] = [
  // The outcome itself: its pill, tally, legend and filter, its count, its reasons and evidence.
  'uiCopy.resultFiled', 'progress.legend.filed', 'progress.tally.filed', 'progress.pipeValue()', 'results.filters.filed',
  'results.tally.filedNote', 'journey.now.complete()', 'reasons.rule.filed()', 'reasons.rule.filedNoFigures()',
  'evidence.whyFiled', 'evidence.stamp.filed', 'progress.sortedSummary()', 'home.scene.filed', 'home.workspace.filedAuto', 'home.workspace.filedIn()', 'bakeoff.filed', 'bakeoff.wrong',
  // The rule that files a document: both systems agree, sure enough.
  'uiCopy.lede', 'home.lede', 'home.promises.agree', 'home.how.outcome.title', 'home.how.outcome.body[1].b', 'help.lead', 'help.facts.sure', 'help.rules.table[2][1]', 'help.rules.outcomes[2][0]', 'help.safety.decideMinimum()', 'journey.steps.sort.lead',
  // The documents filed automatically, as the trial, the review, the folders and the comparison check them.
  'trial.confirmNote', 'trial.reviewEvery', 'trial.reviewLead', 'trial.zero', 'review.lead', 'journey.steps.review.lead',
  'journey.now.reviewChecked', 'review.cards.filedIn()', 'review.cards.needsNone', 'review.cards.spotDone()', 'review.cards.spotHow',
  'review.cards.spotIntro()', 'review.cards.spotSummary()', 'review.cards.spotNext', 'review.cards.stamp.filed', 'improve.comparison.sameNote',
  'improve.comparison.sameTitle', 'improve.filedSentence()', 'improve.lower()', 'improve.smallSample()', 'uiCopy.filedCount()',
  // copy.ts legacy strings no screen reads, about the same documents.
  'uiCopy.comparisonFiled', 'uiCopy.correctionNothingFiled'
];

/** A scanned path without its sample arguments: `review.cards.filedIn("Sample name")` → `review.cards.filedIn()`. */
const pathOf = (path: string) => path.replace(/\(.*$/, '()');
const keyOf = (path: string) => path.slice(path.indexOf('.') + 1).split(/[.[(]/)[0];
const jargonPaths = (scan: Scan) => [...new Set(jargon(scan).map(line => pathOf(line.slice(0, line.indexOf(': ')))))].sort();

/** ui/app and core source that ships, without tests and without copy.ts itself. */
function productSources(): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = [];
  for (const dir of ['ui/app', 'core'])
    for (const name of readdirSync(`${REPO}${dir}`, { recursive: true }) as string[]) {
      const file = `${dir}/${name.split('\\').join('/')}`;
      if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file) || file === 'core/ui/copy.ts') continue;
      files.push({ file, text: readFileSync(`${REPO}${file}`, 'utf8') });
    }
  return files;
}

/** Every copy string: the groups (Details included), copy.ts's own, the server's, and each project pack's words. */
function everyString(): { path: string; text: string }[] {
  const all = Object.entries(GROUPS).flatMap(([group, [, value]]) => scanGroup(group, value, true).strings);
  all.push(...scanGroup('uiCopy', FLAT, true).strings, ...scanGroup('serverCopy', serverCopy, true).strings,
    ...scanGroup('accessCopy', accessCopy, true).strings, ...scanGroup('dailyAllowanceCopy', dailyAllowanceCopy, true).strings);
  for (const name of readdirSync(`${REPO}projects`)) {
    let pack: { productName?: unknown; copyOverrides?: Record<string, unknown> };
    try { pack = JSON.parse(readFileSync(`${REPO}projects/${name}/project.json`, 'utf8')); } catch { continue; }
    if (typeof pack.productName === 'string') all.push({ path: `projects/${name}.productName`, text: pack.productName });
    for (const [key, text] of Object.entries(pack.copyOverrides ?? {}))
      if (typeof text === 'string') all.push({ path: `projects/${name}.copyOverrides.${key}`, text });
  }
  return all;
}

test('copy.ts: every string is scanned; jargon only in legacy strings no screen reads, or in Details-only text', () => {
  const scan = scanGroup('uiCopy', FLAT);
  assert.deepEqual(scan.problems, []);
  const paths = scan.strings.map(item => item.path);
  for (const rendered of ['uiCopy.resultFiled', 'uiCopy.nav.home', 'uiCopy.details', 'uiCopy.loading'])
    assert.ok(paths.includes(rendered), `${rendered} is scanned`);
  const keys = [...new Set(jargonPaths(scan).map(keyOf))].sort();
  assert.deepEqual(keys, [...LEGACY_UNRENDERED, ...DETAILS_ONLY].sort(), 'the copy.ts strings with jargon are exactly the listed ones: ' +
    'reword a new one in plain words (a new string belongs in a copy-<group>.ts file); a listed one deleted or reworded leaves the list');
  const sources = productSources();
  assert.ok(sources.some(source => source.file === 'ui/app/screens/results.ts'), 'the product source is read');
  const readBy = (key: string) => {
    const pattern = new RegExp(`(?:\\buiCopy|\\bactiveUiCopy|\\bcopy)\\??\\.${key}\\b|\\bkey:\\s*['"]${key}['"]`);
    return sources.filter(source => pattern.test(source.text)).map(source => source.file);
  };
  assert.deepEqual(LEGACY_UNRENDERED.flatMap(key => readBy(key).map(file => `${key} in ${file}`)), [],
    'a copy.ts string with jargon is read by product code: reword it before using it');
  assert.ok(readBy('resultFiled').length > 0 && readBy('invalidProjectCopy').length > 0, 'the reference check finds real reads');
});

test('serverCopy: every person-facing sentence is scanned; one with jargon is one the browser replaces with plain words', () => {
  assert.deepEqual(JARGON_PATTERNS.map(String), BANNED.map(String), 'error-copy.ts guards the normal path with exactly the patterns this lint bans');
  const scan = scanGroup('serverCopy', serverCopy);
  assert.deepEqual(scan.problems, []);
  assert.ok(scan.strings.length > 30, 'the scan saw serverCopy');
  assert.deepEqual(jargonPaths(scan), [...SERVER_GUARDED].sort(), 'the server sentences with jargon are exactly the listed ones: ' +
    'write a new person-facing server sentence in plain words; a listed one reworded leaves the list');
  for (const { path, text } of scan.strings)
    if (SERVER_GUARDED.includes(pathOf(path))) assert.equal(hasJargon(text), true, `${path} is replaced in the normal path`);
});

test('the other person-facing server sentences (sign-in keys, daily allowances) are plain words', () => {
  for (const [name, value] of [['accessCopy', accessCopy], ['dailyAllowanceCopy', dailyAllowanceCopy]] as const) {
    const scan = scanGroup(name, value);
    assert.deepEqual(scan.problems, [], name);
    assert.ok(scan.strings.length > 0, `the scan saw ${name}`);
    assert.deepEqual(jargonPaths(scan), [], `${name} has no jargon`);
  }
});

test('never the word "fast" in any copy: the groups, copy.ts, serverCopy, the project packs', () => {
  const FAST = /\bfast/i;
  for (const [text, expected] of [['Fast', true], ['faster', true], ['the fastest', true], ['breakfast', false], ['steadfast', false]] as const)
    assert.equal(FAST.test(text), expected, text);
  const strings = everyString();
  assert.ok(strings.some(item => item.path.startsWith('serverCopy.')) && strings.some(item => item.path.startsWith('uiCopy.')) &&
    strings.some(item => item.path.startsWith('projects/owner.')), 'every source is scanned');
  assert.deepEqual(strings.filter(item => FAST.test(item.text)).map(item => `${item.path}: ${item.text}`), [],
    'AGENTS UI rule: never the word "fast" (say what was measured instead)');
});

test('"filed" only where it names R1: every use is one a person checked', () => {
  const found = [...new Set(everyString().filter(item => /\bfiled\b/i.test(item.text)).map(item => pathOf(item.path)))].sort();
  assert.deepEqual(found, [...FILED_MEANS_R1].sort(), 'a new use of "filed": check that it names R1 (the automatic filing outcome), ' +
    'then add its path to FILED_MEANS_R1; otherwise say "sorted" or name the folder. A listed path that no longer uses the word leaves the list');
  assert.equal(/\bfiled\b/i.test('Misfiled documents'), false, '"misfiled" is another word');
});
