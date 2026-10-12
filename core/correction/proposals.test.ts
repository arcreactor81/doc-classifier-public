import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffCorrection, type CorrectionMatch, type CorrectionMove, type CorrectionTreeFile
} from './diff.ts';
import {
  proposeCorrections, type CorrectionProposals, type ExampleCandidate, type FolderDecision, type ProposalEvidence,
  type ProposalInput, type ProposalType
} from './proposals.ts';

function fixture(count = 50): ProposalInput {
  const manifest = Array.from({ length: count }, (_, n) => ({
    fingerprint: String(n).padStart(64, '0'),
    tag: `r-${n}`,
    originalFilename: `${n}.pdf`,
    destinationFolder: 'type_a',
    rule: 'R1'
  }));
  return {
    correctionId: 'c-1',
    currentThreshold: 0.9,
    minimumFiledCount: 50,
    diff: diffCorrection({
      manifest,
      files: manifest.map(entry => ({
        folder: 'type_a',
        filename: `${entry.tag} ${entry.originalFilename}`,
        tag: entry.tag
      })),
      checkedFolders: ['type_a'],
      typeFolders: ['type_a', 'type_b'],
      sidecarPaths: []
    }),
    evidence: Object.fromEntries(manifest.map(entry => [
      entry.tag,
      { certainty: 0.98, agreedType: 'type_a', title: entry.originalFilename, digestLines: ['1'] }
    ])),
    types: [{ id: 'type_a', name: 'Type A' }, { id: 'type_b', name: 'Type B' }],
    folderDecisions: [],
    renderNotFor: (from, to) => `${from.name}: ${to.name}`,
  };
}

function move(input: ProposalInput, index: number, to: string, certainty: number) {
  const match = input.diff.confirmations.splice(index, 1)[0];
  input.evidence[match.entry.tag].certainty = certainty;
  input.diff.moves.push({
    ...match,
    file: { ...match.file, folder: to },
    from: match.entry.destinationFolder,
    to,
    kind: 'misfile'
  });
}

test('raise proposal uses lowest correct certainty above all wrong, never mutates evidence', () => {
  const input = fixture();
  move(input, 0, 'type_b', 0.91);
  const before = JSON.stringify(input);
  const result = proposeCorrections(input);
  assert.deepEqual(
    result.filedCheck,
    { checked: 50, wrong: 1, correct: 49, status: 'raise_proposed' }
  );
  assert.equal(result.raise?.threshold, 0.98);
  assert.equal(result.raise?.correctSentToReview, 0);
  assert.equal(result.raise?.wrongSentToReview, 1);
  assert.equal(result.raise?.correctionId, 'c-1');
  assert.equal(JSON.stringify(input), before);
});

test('below minimum preserves counts without recommending either threshold direction', () => {
  const input = fixture(49);
  move(input, 0, 'type_b', 0.91);
  const result = proposeCorrections(input);
  assert.equal(result.filedCheck.checked, 49);
  assert.equal(result.filedCheck.status, 'insufficient_sample');
  assert.equal(result.raise, null);
  assert.equal(result.lower, null);
});

test('overlapping and equal certainties cannot separate; unchecked and deleted excluded', () => {
  const input = fixture();
  move(input, 0, 'type_b', 0.98);
  let result = proposeCorrections(input);
  assert.equal(result.filedCheck.status, 'cannot_separate');
  const unchecked = input.diff.confirmations.pop()!;
  input.diff.unchecked.push(unchecked);
  result = proposeCorrections(input);
  assert.equal(result.filedCheck.checked, 49);
});

test('lowering uses human R2 labels, zero observed errors at or above candidate', () => {
  const input = fixture();
  for (const [n, certainty, to] of [[100, 0.7, 'type_a'], [101, 0.6, 'type_b']] as const) {
    const entry = {
      fingerprint: String(n).padStart(64, '0'),
      tag: `r-${n}`,
      originalFilename: `${n}.pdf`,
      destinationFolder: 'human_review',
      rule: 'R2'
    };
    input.diff.moves.push({
      entry,
      file: { folder: to, filename: entry.originalFilename, tag: entry.tag },
      matchedBy: 'tag',
      from: 'human_review',
      to,
      kind: 'human_label'
    });
    input.evidence[entry.tag] = {
      certainty,
      agreedType: 'type_a',
      title: entry.originalFilename,
      digestLines: []
    };
  }
  const result = proposeCorrections(input);
  assert.equal(result.lower?.threshold, 0.7);
  assert.equal(result.lower?.additionalAutomaticLabels, 1);
  assert.equal(result.lower?.observedErrors, 0);
  input.evidence['r-101'].certainty = 0.8;
  assert.equal(proposeCorrections(input).lower, null);
});

test('unknown folders need explicit decisions; ignored entries excluded and new types are incomplete stubs', () => {
  const input = fixture();
  move(input, 0, 'Proposed Type', 0.91);
  const moved = input.diff.moves[0];
  moved.kind = 'unresolved_folder';
  input.diff.unknownFolders = [{ folder: moved.to, files: [moved.file] }];
  let result = proposeCorrections(input);
  assert.deepEqual(result.unresolvedFolders, ['Proposed Type']);
  assert.equal(result.filedCheck.checked, 49);
  input.folderDecisions = [{ folder: moved.to, action: 'new_type' }];
  result = proposeCorrections(input);
  assert.equal(result.newTypes[0].id, 'proposed_type');
  assert.equal(result.newTypes[0].what, '');
  assert.equal(result.newTypes[0].not_for, '');
  assert.equal(result.newTypes[0].examples.length, 1);
  assert.equal(result.filedCheck.checked, 50);
  input.folderDecisions = [{ folder: moved.to, action: 'ignore' }];
  assert.equal(proposeCorrections(input).filedCheck.checked, 49);
});

test('examples use confirmed and human-labelled records, not unchecked guesses; not_for is only a candidate', () => {
  const input = fixture(3);
  move(input, 0, 'type_b', 0.91);
  input.diff.unchecked.push(input.diff.confirmations.pop()!);
  const result = proposeCorrections(input);
  assert.equal(result.examples.length, 2);
  assert.deepEqual(result.examples.map(item => item.typeId).sort(), ['type_a', 'type_b']);
  assert.equal(result.notFor.length, 1);
  assert.equal(result.notFor[0].candidate, 'Type A: Type B');
});

test('human labels after processing failures accept metadata-only evidence without invented certainty', () => {
  const input = fixture(1);
  const match = input.diff.confirmations.pop()!;
  match.entry.rule = 'R0';
  match.entry.destinationFolder = 'could_not_process';
  input.diff.moves.push({
    ...match,
    file: { ...match.file, folder: 'type_b' },
    from: 'could_not_process',
    to: 'type_b',
    kind: 'human_label'
  });
  input.evidence[match.entry.tag] = {
    certainty: null,
    agreedType: null,
    title: match.entry.originalFilename,
    digestLines: []
  };
  const result = proposeCorrections(input);
  assert.equal(result.filedCheck.checked, 0);
  assert.equal(result.examples.length, 1);
  assert.equal(result.examples[0].typeId, 'type_b');
  assert.equal(result.raise, null);
  assert.equal(result.lower, null);
});

test('missing recorded certainty remains invalid for automatic-label threshold evidence', () => {
  const input = fixture(1);
  input.evidence['r-0'].certainty = null;
  assert.throws(() => proposeCorrections(input), /certainty/i);
});

test('retained reader evidence and exact definition provenance survive proposals without rewriting inputs', () => {
  const input = fixture(1);
  move(input, 0, 'type_b', 0.91);
  input.typeVersion = 'frozen-version';
  input.types = [
    { id: 'type_a', name: 'Type A', what: 'Definition A', not_for: 'Exclusion A' },
    { id: 'type_b', name: 'Type B', what: 'Definition B', not_for: 'Exclusion B' }
  ];
  input.evidence['r-0'].readerEvidence = [{
    typeId: 'type_a',
    isType: false,
    quote: ' exact\n quote ',
    verdictIndex: 0,
    quoteIndex: 0,
    artifactKey: 'retained-reader'
  }];
  input.evidence['r-0'].fullContextUnavailable = true;
  const before = JSON.stringify(input), result = proposeCorrections(input);
  assert.deepEqual(result.examples[0].readerEvidence, input.evidence['r-0'].readerEvidence);
  assert.equal(result.examples[0].fullContextUnavailable, true);
  assert.deepEqual(result.notFor[0].definitions, { from: input.types[0], to: input.types[1] });
  assert.equal(result.notFor[0].typeVersion, 'frozen-version');
  assert.equal(JSON.stringify(input), before);
});

// Step 3: retained context is gathered for a sample of documents per save. The threshold arithmetic must not notice.
test('step 3: sampled context leaves filedCheck, raise and lower unchanged; the rest is marked on demand, never refused', () => {
  const full = fixture(120);
  move(full, 0, 'type_b', 0.91);
  move(full, 0, 'type_b', 0.92);
  for (const [n, certainty, to] of [[300, 0.7, 'type_a'], [301, 0.6, 'type_b'], [302, 0.75, 'type_a']] as const) {
    const entry = { fingerprint: String(n).padStart(64, '0'), tag: `r-${n}`, originalFilename: `${n}.pdf`, destinationFolder: 'human_review', rule: 'R2' };
    full.diff.moves.push({ entry, file: { folder: to, filename: entry.originalFilename, tag: entry.tag }, matchedBy: 'tag', from: 'human_review', to, kind: 'human_label' });
    full.evidence[entry.tag] = { certainty, agreedType: 'type_a', title: entry.originalFilename, digestLines: ['line'], readerEvidence: [{ typeId: 'type_a', isType: true, quote: 'q', verdictIndex: 0, quoteIndex: 0, artifactKey: 'k' }] };
  }
  full.minimumFiledCount = 50;
  const gathered = new Set(['r-0', 'r-1', 'r-300', ...Array.from({ length: 20 }, (_, i) => `r-${i + 2}`)]);
  const sampled: ProposalInput = {
    ...full,
    evidence: Object.fromEntries(Object.entries(full.evidence).map(([tag, value]) => [tag, gathered.has(tag) ? value
      : { certainty: value.certainty, agreedType: value.agreedType, title: value.title, digestLines: [], evidenceNote: 'on_demand' as const }]))
  };
  // One matched document with no evidence entry at all: tolerated as on demand (its certainty is not needed: R3).
  const orphan = { fingerprint: '8'.repeat(64), tag: 'r-orphan', originalFilename: 'orphan.pdf', destinationFolder: 'human_review', rule: 'R3' };
  for (const input of [full, sampled])
    input.diff.moves.push({ entry: orphan, file: { folder: 'type_b', filename: 'orphan.pdf', tag: orphan.tag }, matchedBy: 'tag', from: 'human_review', to: 'type_b', kind: 'human_label' });
  const before = proposeCorrections(full), after = proposeCorrections(sampled);
  assert.deepStrictEqual(after.filedCheck, before.filedCheck);
  assert.deepStrictEqual(after.raise, before.raise);
  assert.deepStrictEqual(after.lower, before.lower);
  assert.ok(before.raise && before.lower, 'the fixture exercises both proposals');
  assert.deepStrictEqual(after.notFor, before.notFor);
  assert.equal(after.examples.length, before.examples.length);
  assert.deepStrictEqual(after.examples.map(e => e.tag), before.examples.map(e => e.tag));
  for (const example of after.examples) {
    if (gathered.has(example.tag!)) assert.deepStrictEqual(example, before.examples.find(e => e.tag === example.tag));
    else assert.deepStrictEqual([example.evidence, example.evidenceNote, example.digestLines, 'readerEvidence' in example], [null, 'on_demand', [], false]);
  }
  // Only a recorded on-demand entry marks a move (an absent entry marks its example; corrections.ts records every document).
  assert.deepStrictEqual(after.moves.filter(m => m.evidenceNote).map(m => m.entry.tag), ['r-301', 'r-302']);
  assert.ok(after.moves.filter(m => !m.evidenceNote).every(m => !('evidence' in m)));
  assert.deepStrictEqual(before.examples.find(e => e.tag === 'r-orphan'), { tag: 'r-orphan', title: 'orphan.pdf', digestLines: [], evidence: null, evidenceNote: 'on_demand', typeId: 'type_b' });
});

// SC-0 WP 0.3 (Audit B7.4, B7.5, B7.6): single-pass extremes, a linear lower-threshold search and indexed moves.
// The oracle below is proposeCorrections exactly as it was before that change; the new function must return the
// same proposals (or refuse with the same message) on every input.
const legacyUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const legacyProposedId = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
function legacyProposeCorrections(input: ProposalInput): CorrectionProposals {
  if (!input.correctionId || !legacyUnit(input.currentThreshold) ||
    !Number.isSafeInteger(input.minimumFiledCount) || input.minimumFiledCount < 1) {
    throw new Error('Invalid correction proposal policy or correction identity.');
  }
  const types = new Map(input.types.map(type => [type.id, type]));
  if (types.size !== input.types.length) throw new Error('Duplicate proposal type identity.');
  const unknown = new Set(input.diff.unknownFolders.map(item => item.folder));
  const decisions = new Map<string, FolderDecision['action']>();
  for (const decision of input.folderDecisions) {
    if (!unknown.has(decision.folder) || decisions.has(decision.folder) ||
      !['ignore', 'new_type'].includes(decision.action)) {
      throw new Error('Invalid or duplicate unknown-folder decision.');
    }
    decisions.set(decision.folder, decision.action);
  }
  const evidence = (match: CorrectionMatch): ProposalEvidence => {
    const value = input.evidence[match.entry.tag];
    if (
      !value ||
      (value.certainty !== null && !legacyUnit(value.certainty)) ||
      (value.agreedType !== null && !types.has(value.agreedType))
    ) throw new Error('Missing or invalid correction evidence.');
    return value;
  };
  const certainty = (match: CorrectionMatch): number => {
    const value = evidence(match).certainty;
    if (value === null)
      throw new Error('Recorded numeric certainty is required for threshold evidence.');
    return value;
  };
  const example = (match: CorrectionMatch): ExampleCandidate => {
    const value = evidence(match);
    return {
      tag: match.entry.tag,
      title: value.title,
      digestLines: [...value.digestLines],
      ...(value.readerEvidence ?
        { readerEvidence: value.readerEvidence.map(item => ({ ...item })) } :
        {}),
      ...(value.fullContextUnavailable !== undefined ?
        { fullContextUnavailable: value.fullContextUnavailable } :
        {})
    };
  };
  const included = (folder: string) => !unknown.has(folder) || decisions.get(folder) === 'new_type';
  const moves = input.diff.moves.filter(move => included(move.to));
  const confirmations = input.diff.confirmations.filter(match => included(match.file.folder));
  const filed = [
    ...confirmations.filter(match => match.entry.rule === 'R1'),
    ...moves.filter(move => move.entry.rule === 'R1')
  ];
  const correct = filed.filter(match => match.file.folder === match.entry.destinationFolder);
  const wrong = filed.filter(match => match.file.folder !== match.entry.destinationFolder);
  for (const match of filed) certainty(match);
  const enough = filed.length >= input.minimumFiledCount;
  const result: CorrectionProposals = {
    filedCheck: {
      checked: filed.length,
      wrong: wrong.length,
      correct: correct.length,
      status: !enough ? 'insufficient_sample' : wrong.length === 0 ? 'no_errors' : 'cannot_separate'
    },
    raise: null, lower: null, examples: [], notFor: [], newTypes: [],
    unresolvedFolders: input.diff.unknownFolders
      .filter(item => !decisions.has(item.folder))
      .map(item => item.folder),
    unmatched: input.diff.unmatched
      .filter(file => decisions.get(file.folder) !== 'ignore')
      .map(file => ({ ...file })),
    ignoredFolders: input.folderDecisions
      .filter(decision => decision.action === 'ignore')
      .map(decision => decision.folder),
    moves: input.diff.moves.map(move => ({
      ...move, entry: { ...move.entry }, file: { ...move.file }
    })),
  };
  if (enough && wrong.length > 0 && correct.length > 0) {
    const maxWrong = Math.max(...wrong.map(match => certainty(match)));
    const minCorrect = Math.min(...correct.map(match => certainty(match)));
    if (maxWrong < minCorrect && minCorrect > input.currentThreshold) {
      result.filedCheck.status = 'raise_proposed';
      result.raise = {
        correctionId: input.correctionId,
        direction: 'raise',
        threshold: minCorrect,
        evidenceTags: filed.map(match => match.entry.tag),
        wrongSentToReview: wrong.length,
        correctSentToReview: correct.filter(match => certainty(match) < minCorrect).length
      };
    }
  }
  // An unmoved review item does not provide a type label, even in a checked folder.
  const reviewLabels = moves.filter(move => move.entry.rule === 'R2' &&
    move.entry.destinationFolder === 'human_review' &&
    (types.has(move.to) || decisions.get(move.to) === 'new_type'));
  for (const match of reviewLabels) {
    certainty(match);
    if (evidence(match).agreedType === null)
      throw new Error('An R2 correction must retain the original agreed type.');
  }
  if (enough) {
    const candidates = [...new Set(reviewLabels
      .filter(match => match.to === evidence(match).agreedType)
      .map(match => certainty(match))
      .filter(certainty => certainty < input.currentThreshold))].sort((a, b) => a - b);
    for (const threshold of candidates) {
      const affected = reviewLabels.filter(match =>
        certainty(match) >= threshold && certainty(match) < input.currentThreshold);
      const errors = reviewLabels.filter(match =>
        certainty(match) >= threshold && match.to !== evidence(match).agreedType).length;
      if (affected.length > 0 && errors === 0) {
        result.lower = {
          correctionId: input.correctionId,
          direction: 'lower',
          threshold,
          evidenceTags: reviewLabels.map(match => match.entry.tag),
          additionalAutomaticLabels: affected.length,
          observedErrors: errors
        };
        break;
      }
    }
  }
  const seenExamples = new Set<string>();
  for (const match of [...confirmations, ...moves]) {
    if (!types.has(match.file.folder) || seenExamples.has(match.entry.tag)) continue;
    seenExamples.add(match.entry.tag);
    result.examples.push({ ...example(match), typeId: match.file.folder });
  }
  const pairs = new Map<string, { from: ProposalType; to: ProposalType; tags: string[] }>();
  for (const move of moves) {
    const from = types.get(move.from), to = types.get(move.to);
    if (!from || !to || from.id === to.id) continue;
    const key = JSON.stringify([from.id, to.id]);
    const pair = pairs.get(key) ?? { from, to, tags: [] };
    pair.tags.push(move.entry.tag);
    pairs.set(key, pair);
  }
  result.notFor = [...pairs.values()].map(pair => ({
    fromType: pair.from.id,
    toType: pair.to.id,
    candidate: input.renderNotFor({ ...pair.from }, { ...pair.to }),
    evidenceTags: [...pair.tags],
    ...(input.typeVersion ? { typeVersion: input.typeVersion } : {}),
    ...([pair.from, pair.to].every(type =>
      typeof type.what === 'string' && typeof type.not_for === 'string') ?
      {
        definitions: {
          from: {
            id: pair.from.id,
            name: pair.from.name,
            what: pair.from.what!,
            not_for: pair.from.not_for!
          },
          to: {
            id: pair.to.id,
            name: pair.to.name,
            what: pair.to.what!,
            not_for: pair.to.not_for!
          }
        }
      } :
      {})
  }));
  const proposedFolders = input.diff.unknownFolders
    .filter(item => decisions.get(item.folder) === 'new_type');
  const ids = proposedFolders.map(item => legacyProposedId(item.folder));
  const reservedIds = new Set(['none_of_these', 'human_review', 'could_not_process']);
  result.newTypes = proposedFolders.map((item, index) => {
    const id = ids[index];
    const validId = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id) && !types.has(id) &&
      !reservedIds.has(id) && ids.filter(value => value === id).length === 1;
    const examples = item.files.map(file => {
      const match = moves.find(move =>
        move.file.folder === file.folder && move.file.filename === file.filename);
      return match ? example(match) : { tag: null, title: file.filename, digestLines: [] };
    });
    return {
      folder: item.folder,
      id: validId ? id : null,
      name: item.folder,
      what: '',
      not_for: '',
      examples,
      status: 'proposed_type_not_yet_defined'
    };
  });
  return result;
}

/** Seeded and reproducible (mulberry32); a failing seed is named in the assertion message. */
function seeded(seed: number): () => number {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
/** Certainties drawn mostly from a small set, so ties (including -0 against +0) are common. */
function randomCertainty(random: () => number): number {
  if (random() < 0.75) return pick(random, [0, -0, 0.5, 0.7, 0.8, 0.9, 0.9, 0.95, 0.98, 1]);
  return Math.round(random() * 100) / 100;
}

interface RandomShape {
  matches: number;
  reviewShare: number;
  /** When set, about a quarter of inputs carry one fault that both versions must refuse identically. */
  faults: boolean;
}
type Fault = 'null_certainty' | 'missing_evidence' | 'unknown_agreed_type' | 'null_agreed_type' | 'bad_decision' |
  'duplicate_decision' | 'bad_threshold' | 'no_identity' | 'duplicate_type';
function randomProposalInput(random: () => number, shape: RandomShape): ProposalInput {
  const fault: Fault | null = shape.faults && random() < 0.25
    ? pick(random, ['null_certainty', 'missing_evidence', 'unknown_agreed_type', 'null_agreed_type', 'bad_decision',
      'duplicate_decision', 'bad_threshold', 'no_identity', 'duplicate_type'] as const)
    : null;
  const typeIds = ['type_a', 'type_b', 'type_c', 'type_d'].slice(0, 1 + Math.floor(random() * 4));
  const described = random() < 0.5;
  const types: ProposalType[] = typeIds.map((id, index) => ({
    id, name: `Type ${index + 1}`,
    ...(described || index === 0 ? { what: `Definition ${index + 1}`, not_for: `Exclusion ${index + 1}` } : {})
  }));
  // Unknown folders include names whose proposed identifiers collide, are reserved, or are not valid identifiers.
  const unknownPool = ['Proposed Type', 'Proposed-Type', 'Another folder', 'none of these', '123 numbers', 'Later'];
  const unknownFolders = unknownPool.slice(0, Math.floor(random() * unknownPool.length));
  const known = [...typeIds, 'human_review', 'could_not_process'];
  // Separable inputs file correct documents above every wrong one, so a raise can be proposed.
  const separable = random() < 0.35;
  const confirmations: CorrectionMatch[] = [], moves: CorrectionMove[] = [], unchecked: CorrectionMatch[] = [];
  const evidence: Record<string, ProposalEvidence> = {};
  for (let index = 0; index < shape.matches; index++) {
    const review = random() < shape.reviewShare;
    const destinationFolder = review ? 'human_review' : random() < 0.9 ? pick(random, typeIds) : 'could_not_process';
    const rule = review ? pick(random, ['R2', 'R2', 'R2', 'R5']) : destinationFolder === 'could_not_process' ? 'R0'
      : pick(random, ['R1', 'R1', 'R1', 'R1', 'R3']);
    const entry = {
      fingerprint: index.toString(16).padStart(64, '0'), tag: `r-${index}`,
      originalFilename: `${index}.pdf`, destinationFolder, rule
    };
    const moved = random() < (review ? 0.85 : 0.2);
    const folder = moved
      ? (unknownFolders.length && random() < 0.15 ? pick(random, unknownFolders) : pick(random, known))
      : destinationFolder;
    // A few repeated filenames in the same folder check that the first move for a file still wins.
    const filename = random() < 0.02 ? 'repeated.pdf' : `${entry.tag} ${entry.originalFilename}`;
    const file: CorrectionTreeFile = { folder, filename, tag: entry.tag };
    if (folder !== destinationFolder)
      moves.push({ entry, file, matchedBy: 'tag', from: destinationFolder, to: folder, kind: 'misfile' });
    else if (random() < 0.9) confirmations.push({ entry, file, matchedBy: 'tag' });
    else unchecked.push({ entry, file, matchedBy: 'tag' });
    const certainty = separable && rule === 'R1'
      ? pick(random, folder === destinationFolder ? [0.96, 0.98, 1] : [0.5, 0.9, 0.95])
      : randomCertainty(random);
    // Review labels mostly agree with the type the two systems agreed on, so lowering is often possible.
    const agreed = typeIds.includes(folder) && random() < 0.93 ? folder : pick(random, typeIds);
    evidence[entry.tag] = {
      certainty,
      agreedType: review ? agreed : random() < 0.3 ? pick(random, typeIds) : null,
      title: entry.originalFilename,
      digestLines: [`line ${index}`],
      ...(random() < 0.3 ? {
        readerEvidence: [{ typeId: pick(random, typeIds), isType: random() < 0.5, quote: `quote ${index}`,
          verdictIndex: 0, quoteIndex: 0, artifactKey: `reader-${index}` }]
      } : {}),
      ...(random() < 0.3 ? { fullContextUnavailable: random() < 0.5 } : {})
    };
  }
  const filesIn = (folder: string) => moves.filter(move => move.to === folder).map(move => ({ ...move.file }));
  const unmatched: CorrectionTreeFile[] = unknownFolders.length
    ? Array.from({ length: Math.floor(random() * 4) }, (_, index) => ({ folder: pick(random, unknownFolders), filename: `loose-${index}.pdf` }))
    : [];
  const folderDecisions: FolderDecision[] = [];
  for (const folder of unknownFolders) {
    const roll = random();
    if (roll < 0.45) folderDecisions.push({ folder, action: 'new_type' });
    else if (roll < 0.75) folderDecisions.push({ folder, action: 'ignore' });
  }
  const filed = [...confirmations, ...moves].filter(match => match.entry.rule === 'R1').length;
  const input: ProposalInput = {
    correctionId: 'c-random',
    ...(random() < 0.5 ? { typeVersion: 'frozen-version' } : {}),
    currentThreshold: pick(random, [0, 0.5, 0.7, 0.8, 0.9, 0.9, 0.95, 1]),
    minimumFiledCount: Math.max(1, pick(random, [1, 2, Math.floor(filed / 2), filed, filed + 1])),
    diff: {
      confirmations, unchecked, moves, deleted: [], ignored: [], unmatched,
      unknownFolders: unknownFolders.map(folder => ({
        folder, files: [...filesIn(folder), ...unmatched.filter(file => file.folder === folder)]
      }))
    },
    evidence,
    types,
    folderDecisions,
    renderNotFor: (from, to) => `${from.name}: ${to.name}`
  };
  // One fault, placed where it is reached: on a filed or review match when there is one.
  const reached = [...moves, ...confirmations].filter(match =>
    match.entry.rule === 'R1' || match.entry.rule === 'R2' && match.entry.destinationFolder === 'human_review');
  const target = reached.length ? pick(random, reached) : null;
  if (fault === 'null_certainty' && target) evidence[target.entry.tag]!.certainty = null;
  else if (fault === 'missing_evidence' && target) delete evidence[target.entry.tag];
  else if (fault === 'unknown_agreed_type' && target) evidence[target.entry.tag]!.agreedType = 'type_z';
  else if (fault === 'null_agreed_type' && target) evidence[target.entry.tag]!.agreedType = null;
  else if (fault === 'bad_decision') folderDecisions.push({ folder: typeIds[0]!, action: 'new_type' });
  else if (fault === 'duplicate_decision' && folderDecisions.length) folderDecisions.push({ ...folderDecisions[0]! });
  else if (fault === 'bad_threshold') input.currentThreshold = 1.5;
  else if (fault === 'no_identity') input.correctionId = '';
  else if (fault === 'duplicate_type') input.types = [...types, { ...types[0]! }];
  return input;
}

type ProposalOutcome = { proposals: CorrectionProposals; json: string } | { error: string };
function proposalOutcome(propose: () => CorrectionProposals): ProposalOutcome {
  try {
    const proposals = propose();
    return { proposals, json: JSON.stringify(proposals) };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
/** Same value (deep, -0 distinct from +0), same stored bytes (key order), and the input left untouched. */
function assertSameProposals(input: ProposalInput, label: string): ProposalOutcome {
  const before = JSON.stringify(input);
  const expected = proposalOutcome(() => legacyProposeCorrections(input));
  const actual = proposalOutcome(() => proposeCorrections(input));
  assert.deepStrictEqual(actual, expected, label);
  assert.equal(JSON.stringify(input), before, `${label}: the input is not modified`);
  return actual;
}

test('SC-0 0.3: proposals equal the previous implementation on random corrections, including refusals', () => {
  const statuses = new Set<string>();
  let lowers = 0, raises = 0, refusals = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const random = seeded(seed);
    const input = randomProposalInput(random, { matches: Math.floor(random() * 120), reviewShare: random(), faults: true });
    const outcome = assertSameProposals(input, `seed ${seed}`);
    if ('error' in outcome) { refusals++; continue; }
    statuses.add(outcome.proposals.filedCheck.status);
    if (outcome.proposals.lower) lowers++;
    if (outcome.proposals.raise) raises++;
  }
  // The generator reaches every branch the change touches.
  assert.deepEqual([...statuses].sort(), ['cannot_separate', 'insufficient_sample', 'no_errors', 'raise_proposed']);
  assert.ok(lowers > 20 && raises > 5 && refusals > 5, `lower ${lowers}, raise ${raises}, refused ${refusals}`);
});

test('SC-0 0.3: proposals equal the previous implementation at 10^5 filed documents with ties', () => {
  for (const [seed, threshold, spread] of [[7, 0.9, 'separable'], [8, 0.9, 'overlapping']] as const) {
    const random = seeded(seed);
    // The random part is review labels only, so the filed set is exactly the 10^5 documents added below.
    const input = randomProposalInput(random, { matches: 2_000, reviewShare: 1, faults: false });
    input.currentThreshold = threshold;
    // 10^5 filed documents: correct ones at or above every wrong one when separable, ties across the boundary otherwise.
    const values = spread === 'separable' ? { wrong: [0.91, 0.93, 0.95], correct: [0.96, 0.98, 1] }
      : { wrong: [0.9, 0.95, 0.98], correct: [0.95, 0.98, 1] };
    for (let index = 0; index < 100_000; index++) {
      const wrong = index % 50 === 0, tag = `f-${index}`;
      const entry = { fingerprint: `f${index}`.padStart(64, '0'), tag, originalFilename: `${index}.pdf`,
        destinationFolder: 'type_a', rule: 'R1' };
      const certainty = pick(random, wrong ? values.wrong : values.correct);
      input.evidence[tag] = { certainty, agreedType: null, title: entry.originalFilename, digestLines: [] };
      if (wrong) input.diff.moves.push({ entry, file: { folder: 'type_b', filename: tag, tag }, matchedBy: 'tag',
        from: 'type_a', to: 'type_b', kind: 'misfile' });
      else input.diff.confirmations.push({ entry, file: { folder: 'type_a', filename: tag, tag }, matchedBy: 'tag' });
    }
    if (!input.types.some(type => type.id === 'type_b')) input.types = [...input.types, { id: 'type_b', name: 'Type B' }];
    input.minimumFiledCount = 50;
    const outcome = assertSameProposals(input, `10^5 ${spread}`);
    assert.ok('proposals' in outcome, `10^5 ${spread} proposes`);
    assert.ok(outcome.proposals.filedCheck.checked >= 100_000);
    assert.equal(outcome.proposals.filedCheck.status, spread === 'separable' ? 'raise_proposed' : 'cannot_separate');
  }
});

test('SC-0 0.3: the lower search equals the previous implementation on large review sets with repeated certainties', () => {
  for (let seed = 21; seed <= 26; seed++) {
    const random = seeded(seed);
    const input = randomProposalInput(random, { matches: 6_000, reviewShare: 0.95, faults: false });
    input.minimumFiledCount = 1;
    input.currentThreshold = pick(random, [0.9, 0.95, 1]);
    assertSameProposals(input, `review seed ${seed}`);
  }
});

test('SC-0 0.3: a lowered threshold of zero is recorded as +0, as the candidate Set stored it', () => {
  const input = fixture();
  const entry = { fingerprint: '9'.repeat(64), tag: 'r-zero', originalFilename: 'zero.pdf',
    destinationFolder: 'human_review', rule: 'R2' };
  input.diff.moves.push({ entry, file: { folder: 'type_a', filename: 'zero.pdf', tag: entry.tag }, matchedBy: 'tag',
    from: 'human_review', to: 'type_a', kind: 'human_label' });
  input.evidence[entry.tag] = { certainty: -0, agreedType: 'type_a', title: 'zero.pdf', digestLines: [] };
  const outcome = assertSameProposals(input, 'negative zero');
  assert.ok('proposals' in outcome && outcome.proposals.lower);
  assert.ok(Object.is(outcome.proposals.lower.threshold, 0));
});

test('SC-0 0.3: more filed documents than one call can spread still get a proposal', () => {
  const input = fixture(1);
  input.diff.confirmations = [];
  input.evidence = {};
  const count = 200_000;
  for (let index = 0; index < count; index++) {
    const wrong = index % 100 === 0, tag = `f-${index}`;
    const entry = { fingerprint: `f${index}`.padStart(64, '0'), tag, originalFilename: `${index}.pdf`,
      destinationFolder: 'type_a', rule: 'R1' };
    input.evidence[tag] = { certainty: wrong ? 0.92 + (index % 3) / 100 : 0.96 + (index % 5) / 100, agreedType: null,
      title: entry.originalFilename, digestLines: [] };
    if (wrong) input.diff.moves.push({ entry, file: { folder: 'type_b', filename: tag, tag }, matchedBy: 'tag',
      from: 'type_a', to: 'type_b', kind: 'misfile' });
    else input.diff.confirmations.push({ entry, file: { folder: 'type_a', filename: tag, tag }, matchedBy: 'tag' });
  }
  // The previous implementation stopped here: the engine refuses to spread this many arguments into one call.
  assert.throws(() => legacyProposeCorrections(input), RangeError);
  const result = proposeCorrections(input);
  // Independent oracle: the extremes from a sort.
  const wrongValues = input.diff.moves.map(move => input.evidence[move.entry.tag]!.certainty!).sort((a, b) => a - b);
  const correctValues = input.diff.confirmations.map(match => input.evidence[match.entry.tag]!.certainty!).sort((a, b) => a - b);
  assert.ok(wrongValues.at(-1)! < correctValues[0]!);
  assert.equal(result.filedCheck.status, 'raise_proposed');
  assert.equal(result.raise?.threshold, correctValues[0]);
  assert.equal(result.raise?.wrongSentToReview, wrongValues.length);
  assert.equal(result.raise?.correctSentToReview, correctValues.filter(value => value < correctValues[0]!).length);
});
