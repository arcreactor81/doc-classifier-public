// report.mjs - turns the JSON of scripts/live-bakeoff/score.mjs --json into a plain-language Markdown report: what was
// run, the numbers per reader with their ranges, what they prove and what they do not. Method names appear in one
// footnote only. No network, no model call; it reads one file and prints Markdown.
//
// Usage: node scripts/live-accuracy/report.mjs <score JSON file>
// Exit code 0 on success, 2 on unusable input (for example a score JSON made before the statistics were added).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filedNeeded, percent } from './stats.mjs';

const TARGETS = [0.01, 0.005, 0.001];
const count = value => Number(value).toLocaleString('en-US');
const level = confidence => `${+(confidence * 100).toFixed(4)}%`;
const usd = value => (value === null || value === undefined ? 'unknown' : `USD ${value.toFixed(4)}`);
const cell = value => String(value ?? 'n/a').replace(/\|/g, '/');
const shortRun = id => String(id).slice(0, 8);

function requireStatistics(score) {
  const missing = 'this score JSON has no accuracy statistics; make it again with scripts/live-bakeoff/score.mjs --json';
  if (!score || typeof score.confidence !== 'number' || !Array.isArray(score.scores) || !Array.isArray(score.pools) || !Array.isArray(score.pairs))
    throw new Error(missing);
  for (const pool of score.pools) if (!pool.accuracy?.misfileRate || !pool.accuracy?.reviewRate) throw new Error(missing);
}

function misfileClaim(m, c) {
  if (!m.of) return 'No filed document had a label, so these runs prove nothing about misfiles.';
  const misfiles = `${count(m.count)} misfile${m.count === 1 ? '' : 's'} in ${count(m.of)} filed document${m.of === 1 ? '' : 's'}`;
  if (m.exactUpperOneSided >= 1) return `with ${misfiles}, these documents cannot show that the misfile rate is below 100%.`;
  return `with ${misfiles}, the misfile rate is below ${percent(m.exactUpperOneSided, 'up')} with ${c} confidence.`;
}

function readerSection(pool, c) {
  const { misfileRate: m, reviewRate: r } = pool.accuracy;
  const lines = ['', `### ${pool.reader}`, ''];
  lines.push(m.of
    ? `- **Misfile rate:** ${percent(m.rate)} (${count(m.count)} of ${count(m.of)} filed documents with a label). ${c} range: ` +
      `${percent(m.exact.lower, 'down')} to ${percent(m.exact.upper, 'up')} (a second method gives ${percent(m.wilson.lower, 'down')} to ${percent(m.wilson.upper, 'up')}).`
    : '- **Misfile rate:** nothing to measure (no filed document had a label).');
  lines.push(`- **What this proves:** ${misfileClaim(m, c)}`);
  lines.push(r.of
    ? `- **Review rate:** ${percent(r.rate)} (${count(r.count)} of ${count(r.of)} documents went to a person). ${c} range: ${percent(r.wilson.lower, 'down')} to ${percent(r.wilson.upper, 'up')}.`
    : '- **Review rate:** nothing to measure (no document has an outcome).');
  lines.push(`- **Cost per document:** ${usd(pool.spendPerDocumentUsd)}${pool.spendPerDocumentUsd === null ? ' (the cost of at least one call is not known)' : ''}.`);
  return lines;
}

function pairSection(pair, confidence) {
  const alpha = level(1 - confidence);
  const nameA = pair.aReader ?? 'unknown', nameB = pair.bReader ?? 'unknown';
  const heading = pair.readersDiffer
    ? `### ${nameA} (run ${shortRun(pair.a)}) and ${nameB} (run ${shortRun(pair.b)})`
    : `### ${nameA}, two runs (${shortRun(pair.a)} and ${shortRun(pair.b)})`;
  const t = pair.paired;
  if (!t) return ['', heading, '', `The two runs share ${count(pair.common)} documents, but none has a label, so they are not compared.`];
  const labelA = pair.readersDiffer ? nameA : `run ${shortRun(pair.a)}`, labelB = pair.readersDiffer ? nameB : `run ${shortRun(pair.b)}`;
  const lines = ['', heading, '',
    `On ${count(t.documents)} documents both runs read and a person labelled: both filed right ${count(t.bothRight)}, ` +
    `only ${labelA} ${count(t.onlyA)}, only ${labelB} ${count(t.onlyB)}, neither ${count(t.neitherRight)}.`];
  const high = Math.max(t.onlyA, t.onlyB), low = Math.min(t.onlyA, t.onlyB);
  const chance = t.pValue < 0.001 ? 'less than 0.1%' : percent(t.pValue);
  if (t.onlyA === t.onlyB)
    lines.push((t.onlyA ? `Each filed right ${count(t.onlyA)} document${t.onlyA === 1 ? '' : 's'} the other did not`
      : 'Neither filed right a document the other did not') + ', so these documents show no gap. ' +
      'This does not prove the two are equally good; more shared documents could show a gap.');
  else if (t.pValue < 1 - confidence)
    lines.push(`If the two were equally good, a gap of ${count(high)} to ${count(low)} or wider would happen by chance ${chance} of the time. ` +
      `That is below ${alpha}, so the gap is very unlikely to be chance: ${t.onlyA > t.onlyB ? labelA : labelB} filed right more often on these documents.`);
  else
    lines.push(`If the two were equally good, a gap of ${count(high)} to ${count(low)} or wider would happen by chance ${chance} of the time. ` +
      `That is not below ${alpha}, so these documents do not show that either reader files right more often. ` +
      'This does not prove the two are equally good; more shared documents could show a gap.');
  if (!pair.readersDiffer) lines.push('', 'The same reader in both runs: this measures how much a reader varies from run to run, not a difference between readers.');
  return lines;
}

/** The Markdown report for one score JSON (score.mjs --json). */
export function accuracyReport(score) {
  requireStatistics(score);
  const c = level(score.confidence);
  const decided = score.scores.reduce((sum, s) => sum + (s.decided ?? 0), 0);
  const out = ['# Accuracy report', '',
    `Made from ${count(score.scores.length)} run${score.scores.length === 1 ? '' : 's'}, with ${count(decided)} document outcomes in all (a document read in two runs counts twice). ` +
    'Labels come from a person (an answer key or saved corrections), never from a model, and each outcome is the one its run recorded.'];
  if (score.conflicts?.length) out.push('', `${count(score.conflicts.length)} document(s) had labels that disagree between sources and are not counted.`);

  out.push('', '## What was run', '', '| Run | Started | Reader requested | Categories | Threshold | Documents |', '|---|---|---|---|---|---|');
  for (const s of score.scores)
    out.push(`| ${shortRun(s.runId)} | ${cell(s.createdAt)} | ${cell(s.readerRequested)} | ${cell(s.definitionRevisionId ?? 'from the pack')} | ${cell(s.threshold)} | ${count(s.documents)} |`);

  out.push('', '## Results per reader', '',
    '| Reader | Documents | Filed | Filed right | Misfiled | Sent to review | Could not process | Cost per document |', '|---|---|---|---|---|---|---|---|');
  for (const p of score.pools)
    out.push(`| ${cell(p.reader)} | ${count(p.decided)} | ${count(p.filed)} | ${count(p.filedRight + p.alsoAcceptable)} | ${count(p.misfiled)} | ` +
      `${count(p.review)} | ${count(p.couldNotProcess)} | ${usd(p.spendPerDocumentUsd)} |`);
  for (const p of score.pools) {
    if (p.alsoAcceptable) out.push('', `${p.reader}: filed right includes ${count(p.alsoAcceptable)} filed into a category the labels also accept.`);
    if (p.filed > p.filedScored) out.push('', `${p.reader}: ${count(p.filed - p.filedScored)} filed document(s) had no label and are not in the misfile rate.`);
  }

  out.push('', '## How sure we can be', '',
    `Each range is a ${c} range: worked out this way on many fresh sets of similar documents, the ranges would contain the true rate about ${c} of the time ` +
    `(the first misfile range at least ${c}). ` +
    'The "below" figure is rounded up and range ends are rounded outwards, so each statement stays true.[^methods]');
  for (const p of score.pools) out.push(...readerSection(p, c));

  out.push('', '## Comparing readers on the same documents');
  const shared = score.pairs.filter(p => p.common);
  if (!shared.some(p => p.paired)) out.push('', 'No two runs share labelled documents, so no comparison between readers is tested.');
  for (const pair of shared) out.push(...pairSection(pair, score.confidence));
  if (score.pools.length > 1) out.push('', score.unpairedNote);

  out.push('', '## How many documents would prove more', '',
    `To show the misfile rate is below a target with ${c} confidence takes at least this many filed documents with a label:`, '',
    '| To show the misfile rate is below | With no misfile | With one misfile |', '|---|---|---|');
  for (const target of TARGETS)
    out.push(`| ${+(target * 100).toFixed(4)}% | ${count(filedNeeded(target, score.confidence))} | ${count(filedNeeded(target, score.confidence, 1))} |`);

  out.push('', '## What these numbers do not prove', '',
    '- They describe documents like the ones tested. Documents of other kinds, sources or quality may do better or worse.',
    '- They take the person\'s labels as right. A wrong label shows up as a misfile, or hides one.',
    '- Each document counts as a separate test. Many near-copies of one document would make the ranges look narrower than they are.',
    '- Sending a document to a person is not an error: the review rate measures the work left for a person, not accuracy.',
    '- A document that could not be processed counts among the documents with an outcome, but is neither filed nor sent to review.',
    '- A comparison that shows no clear gap does not prove two readers are equally good.',
    '', `[^methods]: Methods, all at ${c} confidence: misfile-rate ranges are the Clopper-Pearson exact interval (first) and the Wilson score ` +
    'interval (second); each "below" figure is the one-sided Clopper-Pearson upper bound; the review-rate range is the Wilson score interval; ' +
    'documents needed come from the same one-sided bound (with no misfile, n >= ln(1 - confidence) / ln(1 - rate)); readers on the same ' +
    'documents are compared with McNemar\'s exact test, two-sided, on filed right.');
  return out.join('\n') + '\n';
}

/** Reads a score JSON file's bytes: UTF-8 with or without a byte-order mark, or UTF-16 (a PowerShell redirect). */
export function parseScoreJson(buffer) {
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString('utf16le') : buffer.toString('utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2];
    if (!file || process.argv.length > 3) throw new Error('usage: node scripts/live-accuracy/report.mjs <score JSON file>');
    process.stdout.write(accuracyReport(parseScoreJson(readFileSync(file))));
  } catch (error) { console.error(`report: ${error.message}`); process.exitCode = 2; }
}
