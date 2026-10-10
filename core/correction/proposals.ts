import type { CorrectionDiff, CorrectionMatch, CorrectionMove, CorrectionTreeFile } from './diff.ts';

export interface ReaderEvidence {
  typeId: string;
  isType: boolean;
  quote: string;
  verdictIndex: number;
  quoteIndex: number;
  artifactKey: string
}

export interface ProposalEvidence {
  readerEvidence?: readonly ReaderEvidence[];
  fullContextUnavailable?: boolean;
  certainty: number | null;
  agreedType: string | null;
  title: string;
  digestLines: readonly string[];
  /**
   * Set when this document's retained context (digest lines, reader quotes) was not gathered in this save: it lies
   * beyond the per-save evidence cap and the per-document evidence endpoint serves it later. Certainty and agreed
   * type are still recorded, so the threshold arithmetic sees every document.
   */
  evidenceNote?: 'on_demand'
}

export interface ProposalType { id: string; name: string; what?: string; not_for?: string }

export interface ProposalDefinition { id: string; name: string; what: string; not_for: string }

export interface FolderDecision { folder: string; action: 'ignore' | 'new_type' }

export interface ProposalInput {
  correctionId: string;
  typeVersion?: string;
  currentThreshold: number;
  minimumFiledCount: number;
  diff: CorrectionDiff;
  evidence: Record<string, ProposalEvidence>;
  types: readonly ProposalType[];
  folderDecisions: readonly FolderDecision[];
  /** UI copy is supplied centrally; this module never invents distinguishing content. */
  renderNotFor(from: ProposalType, to: ProposalType): string;
}

export interface ExampleCandidate {
  readerEvidence?: ReaderEvidence[];
  fullContextUnavailable?: boolean;
  tag: string | null;
  title: string;
  digestLines: string[];
  /** Both present, and `digestLines` empty, when the context is served on demand rather than carried here. */
  evidence?: null;
  evidenceNote?: 'on_demand'
}

/** A move whose retained context was not gathered in this save carries the same on-demand marker. */
export type ProposalMove = CorrectionMove & { evidence?: null; evidenceNote?: 'on_demand' };

const ON_DEMAND = { evidence: null, evidenceNote: 'on_demand' } as const;

export interface ThresholdProposal {
  correctionId: string;
  direction: 'raise' | 'lower';
  threshold: number;
  evidenceTags: string[];
}

export interface CorrectionProposals {
  filedCheck: {
    checked: number;
    wrong: number;
    correct: number;
    status: 'insufficient_sample' | 'no_errors' | 'cannot_separate' | 'raise_proposed'
  };
  raise: (ThresholdProposal & { wrongSentToReview: number; correctSentToReview: number }) | null;
  lower: (ThresholdProposal & { additionalAutomaticLabels: number; observedErrors: number }) | null;
  examples: (ExampleCandidate & { typeId: string })[];
  notFor: {
    definitions?: { from: ProposalDefinition; to: ProposalDefinition };
    typeVersion?: string;
    fromType: string;
    toType: string;
    candidate: string;
    evidenceTags: string[]
  }[];
  newTypes: {
    folder: string;
    id: string | null;
    name: string;
    what: '';
    not_for: '';
    examples: ExampleCandidate[];
    status: 'proposed_type_not_yet_defined'
  }[];
  unresolvedFolders: string[];
  unmatched: CorrectionTreeFile[];
  ignoredFolders: string[];
  moves: ProposalMove[];
}

/** What the corrections row keeps in D1: the threshold findings and counts; the full proposals stay in R2. */
export interface StoredProposals {
  filedCheck: CorrectionProposals['filedCheck'];
  raise: CorrectionProposals['raise'];
  lower: CorrectionProposals['lower'];
  counts: { confirmations: number; moves: number; unchecked: number; unmatched: number }
}

export function storedProposals(proposals: CorrectionProposals, diff: CorrectionDiff): StoredProposals {
  return {
    filedCheck: proposals.filedCheck,
    raise: proposals.raise,
    lower: proposals.lower,
    counts: {
      confirmations: diff.confirmations.length,
      moves: diff.moves.length,
      unchecked: diff.unchecked.length,
      unmatched: diff.unmatched.length
    }
  };
}

const unit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

const proposedId = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Produces inspectable proposals only. It neither applies a threshold nor edits a type file. */
export function proposeCorrections(input: ProposalInput): CorrectionProposals {
  if (!input.correctionId || !unit(input.currentThreshold) ||
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
      (value.certainty !== null && !unit(value.certainty)) ||
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
  // Context beyond the per-save cap (or absent altogether) is an on-demand example, not a refusal: the definitions
  // editor receives a sample of the retained context, never a partial save (step 3, owner decision recorded separately).
  const example = (match: CorrectionMatch): ExampleCandidate => {
    const recorded = input.evidence[match.entry.tag];
    if (!recorded || recorded.evidenceNote)
      return { tag: match.entry.tag, title: recorded?.title ?? match.entry.originalFilename, digestLines: [], ...ON_DEMAND };
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
      ...move, entry: { ...move.entry }, file: { ...move.file },
      ...(input.evidence[move.entry.tag]?.evidenceNote ? ON_DEMAND : {})
    })),
  };
  if (enough && wrong.length > 0 && correct.length > 0) {
    // Single pass: spreading every certainty into one call throws a RangeError above about 10^5 (Audit B7.4).
    let maxWrong = -Infinity, minCorrect = Infinity;
    for (const match of wrong) maxWrong = Math.max(maxWrong, certainty(match));
    for (const match of correct) minCorrect = Math.min(minCorrect, certainty(match));
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
    // The lowest agreeing certainty below the current threshold with no disagreeing label at or above it. Trying
    // each candidate from the lowest picks the first one above the highest disagreeing certainty, so two passes give
    // the same choice without a scan per candidate (Audit B7.5). Every candidate counts itself, so `affected` is
    // never empty, and the chosen candidate has no errors.
    let highestError = -Infinity;
    for (const match of reviewLabels)
      if (match.to !== evidence(match).agreedType) highestError = Math.max(highestError, certainty(match));
    let lowest: number | null = null;
    for (const match of reviewLabels) {
      const value = certainty(match);
      if (match.to === evidence(match).agreedType && value < input.currentThreshold && value > highestError &&
        (lowest === null || value < lowest)) lowest = value;
    }
    if (lowest !== null) {
      // A Set of candidates stored -0 as +0; keep the recorded value identical.
      const threshold = lowest === 0 ? 0 : lowest;
      let affected = 0;
      for (const match of reviewLabels)
        if (certainty(match) >= threshold && certainty(match) < input.currentThreshold) affected++;
      result.lower = {
        correctionId: input.correctionId,
        direction: 'lower',
        threshold,
        evidenceTags: reviewLabels.map(match => match.entry.tag),
        additionalAutomaticLabels: affected,
        observedErrors: 0
      };
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
  const ids = proposedFolders.map(item => proposedId(item.folder));
  const idCounts = new Map<string, number>();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  const reservedIds = new Set(['none_of_these', 'human_review', 'could_not_process']);
  // The first included move for each folder and filename, which is the move `moves.find` returned, indexed once
  // instead of scanning every move for every file in a new folder (Audit B7.6).
  const movedFiles = new Map<string, Map<string, CorrectionMove>>();
  if (proposedFolders.length > 0) {
    for (const move of moves) {
      const byName = movedFiles.get(move.file.folder) ?? new Map<string, CorrectionMove>();
      if (!byName.has(move.file.filename)) byName.set(move.file.filename, move);
      movedFiles.set(move.file.folder, byName);
    }
  }
  result.newTypes = proposedFolders.map((item, index) => {
    const id = ids[index];
    const validId = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id) && !types.has(id) &&
      !reservedIds.has(id) && idCounts.get(id) === 1;
    const examples = item.files.map(file => {
      const match = movedFiles.get(file.folder)?.get(file.filename);
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
