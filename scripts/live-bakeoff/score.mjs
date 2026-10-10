// score.mjs - scores real runs, read by fetch.mjs, for the reader bake-off (DESIGN §10; scripts/live-bakeoff/README.md).
//
// No network and no model call: it reads the per-run files fetch.mjs saved and prints, per run and pooled per reader:
// documents, filed right, misfiled, sent to review (by rule; "none of these" expected or a category expected), could not
// process, auto-file precision (filed right / filed and scored), review load (review / documents), the reader model
// requested and the model strings the replies reported, and recorded spend per document. For each pair of runs that
// share documents (same fingerprint), how many got the same outcome and folder.
//
// Truth comes from labels a person gave, never from a model:
//   --key <file>        an answer key (either shape: {documents:[{sha256, filename, expected_category, also_acceptable?}]}
//                       or {documents:[{sha256, name, expected}]}); "none" and "none_of_these" mean no category;
//   --corrections       the owner's latest saved correction of each fetched run (confirmed labels only: a document the
//                       person did not check, a failure or an excluded one is not scored);
//   --reference <file>  a saved feedback reference fetched with fetch.mjs --references (confirmed labels only).
// Documents are matched by fingerprint (the SHA-256 of the original); a key entry is used by file name only when it has
// no hash. Two sources that disagree on a document are reported and that document is not scored.
//
// Usage: node scripts/live-bakeoff/score.mjs --in <fetch folder> [--key <file>]... [--corrections] [--reference <file>]...
//                                            [--runs <id prefix>,...] [--map runCategory=keyCategory,...] [--json]
// Exit code 0 when no scored document was misfiled, 1 when one was, 2 on unusable input.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NONE = 'none_of_these';
const REVIEW_RULES = new Set(['R0n', 'R2', 'R3', 'R4', 'R5']);
const NANO = 1e9;
const base = name => String(name ?? '').split(/[\\/]/).pop();
const normalExpected = value => (value === 'none' || value === NONE ? NONE : String(value));

/** One answer key file, either shape, as truth rows. */
export function truthFromKey(key, source = 'key') {
  if (!key || !Array.isArray(key.documents)) throw new Error(`${source}: an answer key needs a documents array`);
  return key.documents.map(doc => {
    const expected = doc.expected_category ?? doc.expected;
    if (typeof expected !== 'string' || !expected) throw new Error(`${source}: a key entry has no expected category`);
    return {
      fingerprint: typeof doc.sha256 === 'string' ? doc.sha256 : null,
      filename: base(doc.filename ?? doc.name),
      expected: normalExpected(expected),
      acceptable: Array.isArray(doc.also_acceptable) ? doc.also_acceptable.map(normalExpected) : [],
      source
    };
  });
}

/** Confirmed labels of saved feedback entries (core/correction/reference.ts ReferenceEntry). */
export function truthFromReferenceEntries(entries, source) {
  const rows = [];
  for (const entry of entries ?? []) {
    if (entry.status === 'label' && entry.labels?.length === 1)
      rows.push({ fingerprint: entry.fingerprint, filename: base(entry.originalFilename), expected: entry.labels[0], acceptable: [], source });
    else if (entry.status === 'ambiguous' && entry.labels?.length > 1)
      rows.push({ fingerprint: entry.fingerprint, filename: base(entry.originalFilename), expected: entry.labels[0], acceptable: entry.labels.slice(1), source });
  }
  return rows;
}

/** Merge truth rows; a document two sources label differently is a conflict and is not scored. */
export function mergeTruth(rows) {
  const byFingerprint = new Map(), byName = new Map(), conflicts = new Map();
  const same = (a, b) => a.expected === b.expected && [...a.acceptable].sort().join() === [...b.acceptable].sort().join();
  for (const row of rows) {
    const table = row.fingerprint ? byFingerprint : byName, id = row.fingerprint ?? row.filename;
    if (conflicts.has(id)) { conflicts.get(id).push(row); continue; }
    const seen = table.get(id);
    if (!seen) table.set(id, row);
    else if (!same(seen, row)) { conflicts.set(id, [seen, row]); table.delete(id); }
  }
  return { byFingerprint, byName, conflicts };
}

function truthFor(truth, doc) {
  if (truth.conflicts.has(doc.fingerprint)) return { conflict: true };
  return truth.byFingerprint.get(doc.fingerprint) ?? truth.byName.get(base(doc.originalFilename)) ?? null;
}

/** The documents of one fetched run with their outcome, from the run's own decisions (never recomputed). */
export function runDocuments(record) {
  const entries = new Map((record.entries ?? []).map(entry => [entry.fingerprint, entry]));
  return (record.documents ?? []).map(doc => {
    const decision = doc.decision ?? (doc.decision_json ? JSON.parse(doc.decision_json) : null);
    const entry = entries.get(doc.fingerprint);
    return {
      fingerprint: doc.fingerprint,
      originalFilename: doc.original_filename,
      rule: decision?.ruleId ?? null,
      outcome: decision?.outcome ?? null,
      folder: decision?.destinationFolder ?? null,
      typeId: decision?.typeId ?? null,
      certainty: entry?.confidenceCheck?.certainty ?? null,
      reportedReader: entry?.vendorOutputs?.reader?.model ?? null,
      // The reader's own yes answers, sorted; null when the run holds no reader output for the document.
      readerYes: Array.isArray(entry?.reader) ? entry.reader.filter(v => v.isType === true).map(v => v.typeId).sort() : null,
      outlineRecovered: entry?.outlineRecovered === true
    };
  });
}

const rate = (part, whole) => (whole ? part / whole : null);

export function scoreRun(record, truth, map = {}) {
  const docs = runDocuments(record);
  const t = { right: [], alternative: [], wrong: [], filedUnscored: [], reviewNone: [], reviewCategory: [], reviewUnscored: [],
    failed: [], pending: [], conflicts: [], noneFiled: [] };
  const byRule = {};
  let readerScored = 0, readerExact = 0;
  for (const doc of docs) {
    if (doc.outcome === null) { t.pending.push(doc); continue; }
    byRule[doc.rule] = (byRule[doc.rule] ?? 0) + 1;
    const label = truthFor(truth, doc);
    if (label?.conflict) { t.conflicts.push(doc); continue; }
    if (label && doc.readerYes) {
      // The reader alone, against the label: yes to exactly the labelled category, or to none for "none of these".
      readerScored++;
      const want = label.expected === NONE ? [] : [label.expected];
      const got = doc.readerYes.map(id => map[id] ?? id);
      if (got.join() === want.join() || (got.length === 1 && label.acceptable.includes(got[0]))) readerExact++;
    }
    if (doc.outcome === 'filed') {
      const filed = map[doc.folder] ?? doc.folder;
      if (!label) t.filedUnscored.push(doc);
      else if (label.expected === NONE) t.noneFiled.push({ doc, label });
      else if (filed === label.expected) t.right.push(doc);
      else if (label.acceptable.includes(filed)) t.alternative.push({ doc, label });
      else t.wrong.push({ doc, label });
    } else if (doc.outcome === 'review') {
      if (!label) t.reviewUnscored.push(doc);
      else (label.expected === NONE ? t.reviewNone : t.reviewCategory).push(doc);
    } else t.failed.push(doc);
  }
  const decided = docs.length - t.pending.length;
  const filed = t.right.length + t.alternative.length + t.wrong.length + t.filedUnscored.length + t.noneFiled.length;
  const filedScored = filed - t.filedUnscored.length;
  const misfiled = t.wrong.length + t.noneFiled.length;
  const review = t.reviewNone.length + t.reviewCategory.length + t.reviewUnscored.length;
  const spend = record.run?.spend ?? {};
  const nano = value => (value === undefined || value === null ? null : Number(value));
  const filedCertainties = docs.filter(d => d.outcome === 'filed' && typeof d.certainty === 'number').map(d => d.certainty);
  const reported = [...new Set(docs.map(d => d.reportedReader).filter(Boolean))].sort();
  return {
    runId: record.runId,
    createdAt: record.run?.createdAt ?? null,
    status: record.run?.status ?? null,
    threshold: record.run?.threshold ?? record.plan?.threshold ?? null,
    definitionRevisionId: record.plan?.definitionRevisionId ?? null,
    readerContract: record.plan?.readerContract ?? null,
    readerRequested: record.plan?.readerModel?.pin ?? null,
    readerLabel: record.plan?.readerModel?.label ?? null,
    readerReported: reported,
    readerReportedMissing: docs.filter(d => d.outcome !== null && d.rule !== 'R0' && !d.reportedReader).length,
    documents: docs.length, decided, pending: t.pending.length,
    filed, filedScored, filedRight: t.right.length, alsoAcceptable: t.alternative.length, misfiled,
    misfiledNoneOfThese: t.noneFiled.length, filedUnscored: t.filedUnscored.length,
    review, reviewExpectedNone: t.reviewNone.length, reviewExpectedCategory: t.reviewCategory.length, reviewUnscored: t.reviewUnscored.length,
    couldNotProcess: t.failed.length, conflicts: t.conflicts.length,
    byRule,
    readerScored, readerExact,
    autoFilePrecision: rate(t.right.length + t.alternative.length, filedScored),
    reviewLoad: rate(review, decided),
    outlineRecovered: docs.filter(d => d.outlineRecovered).length,
    lowestFilingCertainty: filedCertainties.length ? Math.min(...filedCertainties) : null,
    unaccountedCalls: record.run?.unaccountedCalls ?? null,
    spendUsd: nano(spend.blended) === null ? null : nano(spend.blended) / NANO,
    spendOpenAiUsd: nano(spend.openai) === null ? null : nano(spend.openai) / NANO,
    spendPerDocumentUsd: nano(spend.blended) === null || !decided ? null : nano(spend.blended) / NANO / decided,
    misfiles: [...t.wrong, ...t.noneFiled].map(({ doc, label }) => `${base(doc.originalFilename)}: filed in ${doc.folder}, labelled ${label.expected} (${label.source})`),
    reviewedWithCategory: t.reviewCategory.map(doc => `${base(doc.originalFilename)} (${doc.rule}${typeof doc.certainty === 'number' ? ', certainty ' + doc.certainty : ''})`),
    outcomes: new Map(docs.filter(d => d.outcome !== null).map(d => [d.fingerprint, { outcome: d.outcome, folder: d.folder, rule: d.rule, readerYes: d.readerYes, name: base(d.originalFilename) }]))
  };
}

export function comparePair(a, b) {
  let common = 0, same = 0, sameRule = 0, readerCommon = 0, sameReader = 0;
  const differences = [], readerDifferences = [];
  for (const [fingerprint, x] of a.outcomes) {
    const y = b.outcomes.get(fingerprint);
    if (!y) continue;
    common++;
    if (x.outcome === y.outcome && x.folder === y.folder) same++;
    else differences.push(`${x.name}: ${x.outcome}/${x.folder} vs ${y.outcome}/${y.folder}`);
    if (x.rule === y.rule) sameRule++;
    if (x.readerYes && y.readerYes) {
      readerCommon++;
      if (x.readerYes.join() === y.readerYes.join()) sameReader++;
      else readerDifferences.push(`${x.name}: reader yes [${x.readerYes.join(', ')}] vs [${y.readerYes.join(', ')}]`);
    }
  }
  return { a: a.runId, b: b.runId, common, same, sameRule, differences, readerCommon, sameReader, readerDifferences };
}

/** Pooled per requested reader: sums only, rates recomputed from the sums. */
export function poolByReader(scores) {
  const pools = new Map();
  for (const s of scores) {
    const key = s.readerRequested ?? 'unknown';
    const p = pools.get(key) ?? { reader: key, runs: 0, documents: 0, decided: 0, filed: 0, filedScored: 0, filedRight: 0, alsoAcceptable: 0,
      misfiled: 0, review: 0, couldNotProcess: 0, readerScored: 0, readerExact: 0, spendUsd: 0, spendKnown: true, reported: new Set() };
    p.runs++; p.documents += s.documents; p.decided += s.decided; p.filed += s.filed; p.filedScored += s.filedScored;
    p.filedRight += s.filedRight; p.alsoAcceptable += s.alsoAcceptable; p.misfiled += s.misfiled; p.review += s.review;
    p.couldNotProcess += s.couldNotProcess; p.readerScored += s.readerScored; p.readerExact += s.readerExact;
    if (s.spendUsd === null || s.unaccountedCalls) p.spendKnown = false; else p.spendUsd += s.spendUsd;
    for (const model of s.readerReported) p.reported.add(model);
    pools.set(key, p);
  }
  return [...pools.values()].map(p => ({ ...p, reported: [...p.reported].sort(),
    autoFilePrecision: rate(p.filedRight + p.alsoAcceptable, p.filedScored), reviewLoad: rate(p.review, p.decided),
    spendPerDocumentUsd: p.spendKnown && p.decided ? p.spendUsd / p.decided : null }));
}

const pct = value => (value === null ? 'n/a' : `${(100 * value).toFixed(1)}%`);
const usd = value => (value === null ? 'unknown' : `USD ${value.toFixed(4)}`);

export function formatReport({ scores, pairs, pools, conflicts }) {
  const out = ['Live bake-off score (labels from a person; outcomes as each run recorded them)'];
  for (const s of scores) {
    out.push('', `run ${s.runId}  ${s.createdAt}  ${s.status}  threshold ${s.threshold}  categories ${s.definitionRevisionId ?? 'from the pack'}`,
      `  reader requested ${s.readerRequested} (${s.readerLabel}); replies reported ${s.readerReported.join(', ') || 'nothing readable'}` +
        (s.readerReportedMissing ? `; ${s.readerReportedMissing} decided document(s) without a reported model` : ''),
      `  documents ${s.documents}, with an outcome ${s.decided}, unfinished ${s.pending}`,
      `  filed ${s.filed}: right ${s.filedRight}, misfiled ${s.misfiled}` +
        (s.alsoAcceptable ? `, into a category the labels also accept ${s.alsoAcceptable}` : '') +
        (s.filedUnscored ? `, without a label ${s.filedUnscored}` : ''),
      `  sent to review ${s.review}: "none of these" expected ${s.reviewExpectedNone}, a category expected ${s.reviewExpectedCategory}` +
        (s.reviewUnscored ? `, without a label ${s.reviewUnscored}` : ''),
      `  could not process ${s.couldNotProcess}; label conflicts ${s.conflicts}`,
      `  rules ${Object.entries(s.byRule).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
      `  auto-file precision ${pct(s.autoFilePrecision)} (${s.filedRight + s.alsoAcceptable} of ${s.filedScored} labelled); review load ${pct(s.reviewLoad)} (${s.review} of ${s.decided})`,
      `  reader alone gave exactly the labelled answer on ${s.readerExact} of ${s.readerScored}`,
      `  lowest filing certainty ${s.lowestFilingCertainty ?? 'n/a'}; headings recovered ${s.outlineRecovered}`,
      `  spend ${usd(s.spendUsd)} (OpenAI ${usd(s.spendOpenAiUsd)}), per document ${usd(s.spendPerDocumentUsd)}` +
        (s.unaccountedCalls ? `; ${s.unaccountedCalls} call(s) of unknown cost` : ''));
    for (const line of s.misfiles) out.push(`    MISFILED ${line}`);
    for (const line of s.reviewedWithCategory) out.push(`    review, a category expected: ${line}`);
  }
  if (pools.length) {
    out.push('', 'Pooled per requested reader');
    for (const p of pools)
      out.push(`  ${p.reader} (reported ${p.reported.join(', ') || 'n/a'}): ${p.runs} run(s), ${p.decided} documents, filed ${p.filed}, ` +
        `right ${p.filedRight}, misfiled ${p.misfiled}, review ${p.review}, could not process ${p.couldNotProcess}, reader alone exact ${p.readerExact} of ${p.readerScored}; ` +
        `precision ${pct(p.autoFilePrecision)}, review load ${pct(p.reviewLoad)}, per document ${usd(p.spendPerDocumentUsd)}`);
  }
  const shared = pairs.filter(p => p.common);
  if (shared.length) {
    out.push('', 'Same documents in two runs');
    for (const p of shared) {
      out.push(`  ${p.a.slice(0, 8)} vs ${p.b.slice(0, 8)}: ${p.same} of ${p.common} the same outcome and folder, ${p.sameRule} the same rule; ` +
        `reader yes answers identical on ${p.sameReader} of ${p.readerCommon}`);
      for (const line of [...p.differences, ...p.readerDifferences]) out.push(`    differs: ${line}`);
    }
  }
  if (conflicts.length) {
    out.push('', `Label conflicts between sources (not scored): ${conflicts.length}`);
    for (const c of conflicts) out.push(`  ${c}`);
  }
  return out.join('\n');
}

export function analyze(records, truthRows, map = {}) {
  const truth = mergeTruth(truthRows);
  const scores = records.map(record => scoreRun(record, truth, map));
  const pairs = [];
  for (let i = 0; i < scores.length; i++) for (let k = i + 1; k < scores.length; k++) pairs.push(comparePair(scores[i], scores[k]));
  const conflicts = [...truth.conflicts.entries()].map(([id, rows]) => `${id.slice(0, 12)}: ${rows.map(r => `${r.expected} (${r.source})`).join(' vs ')}`);
  return { scores, pairs, pools: poolByReader(scores), conflicts };
}

function parseArgs(argv) {
  const options = { key: [], reference: [] };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--corrections' || name === '--json') { options[name.slice(2)] = true; continue; }
    const value = argv[i + 1];
    if (!name.startsWith('--') || value === undefined) throw new Error(`Unexpected argument ${name}`);
    if (name === '--key' || name === '--reference') options[name.slice(2)].push(value); else options[name.slice(2)] = value;
    i++;
  }
  return options;
}
export function parseMap(text) {
  if (!text) return {};
  return Object.fromEntries(text.split(',').map(pair => {
    const [from, to] = pair.split('=').map(s => s?.trim());
    if (!from || !to) throw new Error('--map takes runCategory=keyCategory pairs');
    return [from, to];
  }));
}
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

export function main(argv) {
  const options = parseArgs(argv);
  if (!options.in) throw new Error('--in <fetch folder> is required');
  let records = readdirSync(options.in).filter(f => f.endsWith('.json') && !f.startsWith('reference-')).sort()
    .map(f => readJson(path.join(options.in, f)));
  if (options.runs) {
    const wanted = options.runs.split(',').map(s => s.trim()).filter(Boolean);
    records = wanted.map(prefix => {
      const found = records.filter(r => r.runId.startsWith(prefix));
      if (found.length !== 1) throw new Error(`Run prefix ${prefix} matches ${found.length} fetched runs`);
      return found[0];
    });
  }
  records.sort((a, b) => String(a.run?.createdAt).localeCompare(String(b.run?.createdAt)));
  const truthRows = [];
  for (const file of options.key) truthRows.push(...truthFromKey(readJson(file), `key ${path.basename(file)}`));
  for (const file of options.reference) {
    const reference = readJson(file);
    truthRows.push(...truthFromReferenceEntries(reference.entries, `feedback ${String(reference.id ?? path.basename(file)).slice(0, 8)}`));
  }
  if (options.corrections)
    for (const record of records) for (const correction of record.corrections ?? [])
      truthRows.push(...truthFromReferenceEntries(correction.referenceCandidates, `correction of ${record.runId.slice(0, 8)}`));
  if (!truthRows.length) throw new Error('No labels: give --key, --reference or --corrections');
  const result = analyze(records, truthRows, parseMap(options.map));
  if (options.json) console.log(JSON.stringify({ ...result, scores: result.scores.map(({ outcomes, ...s }) => s) }, null, 1));
  else console.log(formatReport(result));
  return result.scores.some(s => s.misfiled > 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`score: ${error.message}`); process.exitCode = 2; }
}
