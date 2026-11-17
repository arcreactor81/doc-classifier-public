/** Offline paired statistics for one explicitly selected group. No model calls, network, or threshold selection. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson, clopperPearson, upperBound, mcnemarExact } from './live-accuracy/stats.mjs';

const VERSION = 'decision-paired-statistics-v1';
const ALPHA = .05, CONFIDENCE = .95, FAMILY_SIZE = 5;
const STATES = ['valid', 'refused', 'invalid', 'missing'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function requireThat(ok, code, message) { if (!ok) fail(code, message); }

/** A fixed five-test family, including any declared endpoint with no eligible cases. */
export function bonferroniFive(pValue) {
  if (pValue === null) return null;
  requireThat(typeof pValue === 'number' && Number.isFinite(pValue) && pValue >= 0 && pValue <= 1,
    'E_P_VALUE', 'A p-value must be a number between zero and one, or explicit null.');
  return Math.min(1, FAMILY_SIZE * pValue);
}

function validateFacts(row) {
  const valid = row.state === 'valid';
  requireThat(STATES.includes(row.state) && Object.hasOwn(row, 'expectedLabel') &&
    (row.expectedLabel === null || text(row.expectedLabel)) &&
    ['choice', 'correct', 'candidate'].every(key => Object.hasOwn(row, key)) &&
    (!Object.hasOwn(row, 'scheduled') || row.scheduled === true),
  'E_ROW_FACTS', 'Each selected row must have an explicit reference, known state and complete outcome facts.');
  if (!valid) {
    requireThat(row.choice === null && row.correct === null && row.candidate === null,
      'E_ROW_FACTS', 'A missing, refused or invalid answer cannot carry a choice, correctness or candidate judgment.');
    return;
  }
  requireThat(text(row.choice) && typeof row.candidate === 'boolean' &&
    (row.expectedLabel === null ? row.correct === null : typeof row.correct === 'boolean' && row.correct === (row.choice === row.expectedLabel)) &&
    (row.choice !== 'none_of_these' || row.candidate === false),
  'E_ROW_FACTS', 'A valid answer must have consistent choice, reference correctness and candidate facts; unlabelled correctness stays null.');
}

function pairedInput(input, selection) {
  requireThat(object(selection) && identifier(selection.armA) && identifier(selection.armB) && identifier(selection.group) &&
    selection.armA !== selection.armB, 'E_SELECTION', 'Select two different arms and exactly one group.');
  requireThat(object(input) && input.version === 1 && Array.isArray(input.rows),
    'E_INPUT', 'Expected version 1 with a rows array.');
  const selected = new Map([[selection.armA, new Map()], [selection.armB, new Map()]]);
  let ignoredRows = 0;
  for (const row of input.rows) {
    requireThat(object(row) && identifier(row.armId) && identifier(row.group) && identifier(row.opaqueId),
      'E_ROW_IDENTITY', 'Every row must identify its arm, group and document.');
    if (row.group !== selection.group || !selected.has(row.armId)) { ignoredRows++; continue; }
    validateFacts(row);
    const arm = selected.get(row.armId);
    requireThat(!arm.has(row.opaqueId), 'E_DUPLICATE_PAIR', 'A selected arm has more than one row for the same document.');
    arm.set(row.opaqueId, row);
  }
  const a = selected.get(selection.armA), b = selected.get(selection.armB);
  requireThat(a.size + b.size > 0, 'E_EMPTY_GROUP', 'No rows match the selected group and arms.');
  requireThat(a.size === b.size && [...a.keys()].every(id => b.has(id)),
    'E_PAIR_MISSING', 'Every selected document needs one row for each arm; represent an absent reply with an explicit missing state.');
  const pairs = [...a.keys()].sort().map(id => {
    const first = a.get(id), second = b.get(id);
    requireThat(first.expectedLabel === second.expectedLabel,
      'E_REFERENCE_CONFLICT', 'The paired rows disagree about the document reference label.');
    return { a: first, b: second };
  });
  return { pairs, ignoredRows };
}

const labelled = pair => pair.a.expectedLabel !== null;
const valid = row => row.state === 'valid';
const candidate = row => valid(row) && row.candidate;
const correctCandidate = row => candidate(row) && row.correct === true;
const wrongCandidate = row => candidate(row) && row.correct === false;
const rate = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const wilsonRate = (numerator, denominator) => ({ numerator, denominator, rate: rate(numerator, denominator),
  wilson95: wilson(numerator, denominator, CONFIDENCE) });
const errorRate = (numerator, denominator) => ({ numerator, denominator, rate: rate(numerator, denominator),
  clopperPearson95: clopperPearson(numerator, denominator, CONFIDENCE),
  oneSidedUpper95: upperBound(numerator, denominator, CONFIDENCE) });

function pairedTest(id, label, denominatorMeaning, pairs, event) {
  let both = 0, onlyA = 0, onlyB = 0, neither = 0;
  for (const pair of pairs) {
    const a = event(pair.a), b = event(pair.b);
    if (a && b) both++;
    else if (a) onlyA++;
    else if (b) onlyB++;
    else neither++;
  }
  const denominator = pairs.length;
  const pValue = denominator ? mcnemarExact(onlyA, onlyB).pValue : null;
  const adjusted = bonferroniFive(pValue);
  return { id, label, denominatorMeaning, denominator, both, onlyA, onlyB, neither,
    eventsA: both + onlyA, eventsB: both + onlyB, discordant: onlyA + onlyB,
    rateA: rate(both + onlyA, denominator), rateB: rate(both + onlyB, denominator),
    differenceRateAminusB: denominator ? (onlyA - onlyB) / denominator : null,
    pValue, bonferroniPValue: adjusted,
    differenceDetectedAfterCorrection: adjusted === null ? null : adjusted <= ALPHA };
}

/** Input rows describe scheduled outcomes; no absent arm-row is silently converted into a failure. */
export function analyzePairedDecisions(input, selection) {
  const { pairs, ignoredRows } = pairedInput(input, selection);
  const labelledPairs = pairs.filter(labelled);
  const common = labelledPairs.filter(pair => valid(pair.a) && valid(pair.b));
  const tests = [
    pairedTest('valid_answer_coverage', 'Valid answer produced', 'All scheduled paired documents, including unlabelled cases.', pairs, valid),
    pairedTest('choice_correctness_common_valid', 'Choice matches the reference', 'Labelled documents with valid answers from both arms only.', common, row => row.correct),
    pairedTest('candidate_admission', 'Candidate admitted', 'All labelled scheduled paired documents.', labelledPairs, candidate),
    pairedTest('correct_candidate_yield', 'Correct candidate produced', 'All labelled scheduled paired documents.', labelledPairs, correctCandidate),
    pairedTest('wrong_candidate_incidence', 'Wrong candidate produced', 'All labelled scheduled paired documents.', labelledPairs, wrongCandidate)
  ];
  const arms = [['a', selection.armA], ['b', selection.armB]].map(([side, armId]) => {
    const rows = pairs.map(pair => pair[side]);
    const withLabels = labelledPairs.map(pair => pair[side]), validLabelled = withLabels.filter(valid);
    const commonRows = common.map(pair => pair[side]), candidates = withLabels.filter(candidate);
    const wrong = candidates.filter(row => row.correct === false).length;
    return { armId, scheduledPaired: rows.length, labelledPaired: withLabels.length,
      stateCounts: Object.fromEntries(STATES.map(state => [state, rows.filter(row => row.state === state).length])),
      validAnswerCoverage: wilsonRate(rows.filter(valid).length, rows.length),
      choiceAccuracyOwnValid: wilsonRate(validLabelled.filter(row => row.correct).length, validLabelled.length),
      choiceAccuracyCommonValid: wilsonRate(commonRows.filter(row => row.correct).length, commonRows.length),
      candidateAdmission: wilsonRate(candidates.length, withLabels.length),
      correctCandidateYield: wilsonRate(candidates.filter(row => row.correct).length, withLabels.length),
      wrongCandidateIncidence: errorRate(wrong, withLabels.length),
      conditionalCandidateErrorRate: errorRate(wrong, candidates.length) };
  });
  return { version: 1, generator: VERSION, kind: 'exploratory-paired-decision-statistics',
    group: selection.group, armA: selection.armA, armB: selection.armB, pairedDocuments: pairs.length,
    labelledPairedDocuments: labelledPairs.length, commonValidLabelledDocuments: common.length,
    ignoredRows, family: { size: FAMILY_SIZE, alpha: ALPHA, adjustment: 'Bonferroni',
      adjustedPValue: 'min(1, raw paired p-value * 5)', test: 'Exact two-sided McNemar',
      exploratory: true, postHoc: true, confidenceLevel: CONFIDENCE },
    assumptions: [
      'Each selected row is one scheduled outcome; paired documents have the same frozen reference label.',
      'Document pairs are assumed independent. Related or near-duplicate documents can invalidate that assumption.',
      'The five tests are an exploratory post-hoc family; no extra per-class tests or pooled groups are included.',
      'A missing, refused or invalid reply is a non-event for operational coverage, admission, yield and incidence, never an incorrect classification label.',
      'Choice-correctness inference uses common-valid labelled pairs. Own-valid rates have potentially different denominators and are descriptive.',
      'Candidate flags come from the input; this tool does not choose, tune or equate native confidence thresholds.',
      'Conditional candidate-error rates use different selected, possibly overlapping sets. Their exact intervals are descriptive; no unpaired difference test is performed.',
      'Binomial intervals depend on their sampling assumptions and do not establish population accuracy for a selected corpus.',
      'No significant difference is not evidence of equivalence. These are not reader-agreement or production filing outcomes.'
    ], tests, arms };
}

const percent = value => value === null ? 'not measurable' : (value * 100).toFixed(2) + '%';
const pText = value => value === null ? 'not measurable' : value === 0 ? 'below numeric precision'
  : value < .0001 ? value.toExponential(3) : value.toFixed(4);
const fraction = value => `${value.numerator}/${value.denominator} (${percent(value.rate)})`;
const interval = value => value === null ? 'not measurable' : `${percent(value.lower)}–${percent(value.upper)}`;

export function renderDecisionStatistics(result) {
  const [a, b] = result.arms;
  const lines = ['# Paired decision-model statistics', '',
    `Group: **${result.group}**. Arm A: **${result.armA}**. Arm B: **${result.armB}**.`, '',
    `The comparison matches the same documents: ${result.pairedDocuments} pairs, including ${result.labelledPairedDocuments} with a reference label. ` +
      `Choice correctness is tested only on the ${result.commonValidLabelledDocuments} labelled pairs both arms answered validly.`, '',
    'These are five exploratory post-hoc checks. Each exact paired test uses the cases where the two arms differ. ' +
      'A p-value describes how unusual that split would be under equal event probabilities; it is not the probability that a model is better. ' +
      'The Bonferroni adjustment multiplies each p-value by five, capped at one, to account for this family of checks.', '',
    '| Check | Eligible pairs | A events | B events | A only | B only | Raw paired p | Bonferroni p | Difference detected after correction |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const value of result.tests) lines.push(`| ${value.label} | ${value.denominator} | ${value.eventsA} | ${value.eventsB} | ${value.onlyA} | ${value.onlyB} | ` +
    `${pText(value.pValue)} | ${pText(value.bonferroniPValue)} | ${value.differenceDetectedAfterCorrection === null ? 'Not measurable' : value.differenceDetectedAfterCorrection ? 'Yes' : 'No'} |`);
  lines.push('', 'A refused or missing answer means no operational event was produced. It is never assigned a wrong classification label. ' +
    'More admitted candidates or fewer wrong candidates per scheduled document do not, by themselves, identify a better or safer model: coverage and native selection policies differ.', '',
    '## Descriptive rates', '',
    '| Measure | Arm A | Arm B | A 95% interval | B 95% interval |',
    '| --- | --- | --- | --- | --- |');
  for (const [key, label] of [['validAnswerCoverage', 'Valid answer coverage'], ['choiceAccuracyOwnValid', 'Reference matches among each arm’s valid answers'],
    ['choiceAccuracyCommonValid', 'Reference matches on the shared valid cases'], ['candidateAdmission', 'Candidate admission'],
    ['correctCandidateYield', 'Correct-candidate yield']])
    lines.push(`| ${label} | ${fraction(a[key])} | ${fraction(b[key])} | ${interval(a[key].wilson95)} | ${interval(b[key].wilson95)} |`);
  for (const [key, label] of [['wrongCandidateIncidence', 'Wrong-candidate incidence among all labelled scheduled cases'],
    ['conditionalCandidateErrorRate', 'Errors among each arm’s own candidates']])
    lines.push(`| ${label} | ${fraction(a[key])} | ${fraction(b[key])} | ${interval(a[key].clopperPearson95)} | ${interval(b[key].clopperPearson95)} |`);
  lines.push('', 'Coverage, yield and accuracy intervals use Wilson; error intervals use exact Clopper–Pearson. ' +
    'The one-sided 95% upper bounds for errors among each arm’s own candidates are ' +
    `${percent(a.conditionalCandidateErrorRate.oneSidedUpper95)} for A and ${percent(b.conditionalCandidateErrorRate.oneSidedUpper95)} for B. ` +
    'A zero denominator stays not measurable.', '',
    'The conditional candidate-error rates have different selected, potentially overlapping denominators. ' +
    'Their intervals are descriptive; there is no independent two-proportion or Fisher test attached to them. ' +
    'The paired wrong-candidate-incidence test above asks a different question, using all labelled scheduled cases.', '',
    '## Limits', '',
    'The calculations assume independent document pairs; near-copies, related papers and uncertain reference labels can weaken that assumption. ' +
    'A selected corpus does not support an automatic population-accuracy claim. No detected difference is not proof of equivalence. ' +
    'Native confidence thresholds need not have the same meaning across providers, and these are not production filing results: no independent reader agreement is tested. ' +
    'No model calls, new thresholds or model ranking are produced by this report.', '');
  return lines.join('\n');
}

function localPath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && !value.includes('\0') && !/^[\\/]{2}/.test(value) &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value)),
  'E_LOCAL_PATH', 'Use explicit local filesystem paths, not URLs or network paths.');
  return path.resolve(value);
}

export async function writeDecisionStatistics({ inputPath, outputDirectory, armA, armB, group }) {
  const source = localPath(inputPath), destination = localPath(outputDirectory), bytes = await readFile(source);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('E_INPUT_JSON', 'The input is not valid UTF-8 JSON.'); }
  const result = analyzePairedDecisions(input, { armA, armB, group });
  const report = { ...result, provenance: { inputSha256: createHash('sha256').update(bytes).digest('hex'), inputBytes: bytes.length,
    sourceSchemaVersion: input.version, generator: VERSION, mathModule: 'scripts/live-accuracy/stats.mjs' } };
  const markdown = renderDecisionStatistics(result);
  try { await mkdir(destination); }
  catch (error) { if (error.code === 'EEXIST') fail('E_OUTPUT_EXISTS', 'The output directory already exists; no artifacts were overwritten.'); throw error; }
  const jsonPath = path.join(destination, 'statistics.json'), markdownPath = path.join(destination, 'statistics.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', flush: true });
  await writeFile(markdownPath, markdown, { flag: 'wx', flush: true });
  return { report, jsonPath, markdownPath };
}

async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('Offline paired statistics: --input FILE --arm-a ID --arm-b ID --group ID --output NEW_DIR. Five exploratory paired tests; no inference.'); return;
  }
  const options = {};
  while (args.length) {
    const key = args.shift(), value = args.shift();
    requireThat(['--input', '--arm-a', '--arm-b', '--group', '--output'].includes(key) && value && !value.startsWith('--') && !Object.hasOwn(options, key),
      'E_ARGUMENTS', 'Supply --input, --arm-a, --arm-b, --group and --output exactly once.');
    options[key] = value;
  }
  requireThat(Object.keys(options).length === 5, 'E_ARGUMENTS', 'Supply --input, --arm-a, --arm-b, --group and --output.');
  const result = await writeDecisionStatistics({ inputPath: options['--input'], armA: options['--arm-a'], armB: options['--arm-b'],
    group: options['--group'], outputDirectory: options['--output'] });
  console.log(JSON.stringify({ status: 'statistics-written', group: result.report.group, pairs: result.report.pairedDocuments,
    tests: result.report.tests.length, modelCalls: 0, jsonPath: result.jsonPath, markdownPath: result.markdownPath }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'E_STATISTICS', message: error.message })); process.exitCode = 1; });
