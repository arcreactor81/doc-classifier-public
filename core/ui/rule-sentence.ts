/**
 * The rule sentence at the top of the evidence drawer (SPEC §6.2 `rule-sentence.ts`, §7.2 EvidenceDrawer).
 *
 * Pure. It restates recorded facts only — the recorded rule, the certainty check's recorded certainty and choice, the
 * reader's recorded yes answers, the independent yes/no check, and the run's filing certainty — and never recomputes
 * the outcome (SPEC §0.1 rule 1): the branch is always the recorded rule. The certainty check and the independent
 * yes/no check are never combined into one figure. Percentages are whole; decimals stay in Details.
 */
import { reasonsCopy } from './copy-reasons.ts';
import { percent } from './format.ts';
import { NONE_OF_THESE, categoryName, noteLines, type CategoryNames } from './result-presenter.ts';
import type { ConfidenceOutput, ReaderOutput } from '../vendors/validate.ts';

/** The recorded decision: a StatusDecision (S1, R12) or `decisionOfEntry(entry)` for a results-file entry. */
export interface DecisionFacts {
  ruleId: string;
  /** Recorded for R1 only; null or absent otherwise. */
  typeId?: string | null;
  destinationFolder?: string | null;
  notes?: readonly string[];
}

/** Evidence as R12 returns it, or a results entry's `vendorOutputs`: the validated vendor outputs. */
export interface VendorEvidence { confidence: ConfidenceOutput | null; reader: ReaderOutput | null }
/** Evidence as a results-file entry carries it (older files have only this). */
export interface EntryEvidence {
  confidenceCheck: { choice: string; certainty: number; noul: Readonly<Record<string, number>> } | null;
  reader: readonly { typeId: string; isType: boolean }[] | null;
}
export type RuleEvidence = VendorEvidence | EntryEvidence;

interface Facts {
  certainty: number | null;
  choice: string | null;
  noul: Readonly<Record<string, number>> | null;
  readerYes: readonly string[] | null;
}

function factsOf(evidence: RuleEvidence | null): Facts {
  if (!evidence) return { certainty: null, choice: null, noul: null, readerYes: null };
  if ('confidenceCheck' in evidence) {
    const check = evidence.confidenceCheck;
    return {
      certainty: check?.certainty ?? null,
      choice: check?.choice ?? null,
      noul: check?.noul ?? null,
      readerYes: evidence.reader ? evidence.reader.filter(item => item.isType).map(item => item.typeId) : null
    };
  }
  const confidence = evidence.confidence;
  return {
    certainty: confidence?.confidence ?? null,
    choice: confidence?.choice ?? null,
    noul: confidence?.nouls ?? null,
    readerYes: evidence.reader ? evidence.reader.verdicts.filter(item => item.is_type).map(item => item.type_id) : null
  };
}

/** A results-file entry's decision facts (the entry records the rule and the folder; R1's folder is its category). */
export function decisionOfEntry(entry: { rule: string; destinationFolder: string; notes?: readonly string[] | null }): DecisionFacts {
  return {
    ruleId: entry.rule,
    typeId: entry.rule === 'R1' ? entry.destinationFolder : null,
    destinationFolder: entry.destinationFolder,
    notes: entry.notes ?? []
  };
}

/** Whole percent exactly as the rest of the UI shows it (format.ts `percent`): 0.96 → "96%". */
export function wholePercent(fraction: number): string {
  return percent(fraction);
}
/** The displayed whole number, so the "just below" check compares what the person reads. */
const whole = (fraction: number) => Number.parseInt(percent(fraction), 10);

/**
 * One sentence, e.g. "Filed in Procedures: both systems chose it, and the certainty check was 96% sure (90% needed)."
 * `threshold` is the run's filing certainty as a decimal (the one that decided the run); `displayNames` is the
 * complete map from `categoryNames`. When rounding would make the figures contradict the recorded rule (0.8996
 * against 0.90 both read "90%"), the sentence says "just below" instead of showing a misleading number. When the
 * figures contradict the rule outright (a different filing certainty was passed), no figures are stated.
 */
export function ruleSentence(decision: DecisionFacts, evidence: RuleEvidence | null, threshold: number,
  displayNames: CategoryNames): string {
  const copy = reasonsCopy.rule;
  const facts = factsOf(evidence);
  const needed = wholePercent(threshold);
  const name = (id: string) => categoryName(id, displayNames);
  const names = (ids: readonly string[]) => reasonsCopy.list(ids.map(name));
  switch (decision.ruleId) {
    case 'R0':
      return copy.failed;
    case 'R0n': {
      const lines = noteLines(decision.notes ?? []);
      return lines.length ? copy.notes(lines.join(' ')) : copy.notesNoLines;
    }
    case 'R1': {
      const id = decision.typeId ?? decision.destinationFolder ?? facts.choice ?? '';
      // Figures that contradict the recorded rule (a filing certainty other than the one that decided it) are not
      // stated: the sentence keeps to the rule. Whole-percent rounding never reverses "at least", so 90.4% against
      // 90% reads "90% sure (90% needed)", which is true.
      if (facts.certainty === null || facts.certainty < threshold) return copy.filedNoFigures(name(id));
      return copy.filed(name(id), wholePercent(facts.certainty), needed);
    }
    case 'R2': {
      const id = facts.choice;
      if (id === null || id === NONE_OF_THESE || facts.certainty === null) return copy.lowCertaintyNoFigures(needed);
      if (facts.certainty >= threshold) return copy.lowCertaintyNotSure(name(id));
      return whole(facts.certainty) < whole(threshold)
        ? copy.lowCertainty(name(id), wholePercent(facts.certainty), needed)
        : copy.lowCertaintyJustBelow(name(id), needed);
    }
    case 'R3':
      return facts.readerYes && facts.readerYes.length >= 2 ? copy.straddles(names(facts.readerYes)) : copy.straddlesNoNames;
    case 'R4':
      return copy.newCategory;
    case 'R5': {
      const { choice, readerYes, noul } = facts;
      if (choice === null || readerYes === null || readerYes.length > 1) return copy.disagreeNoFigures;
      if (readerYes.length === 1) {
        const [readerChoice] = readerYes;
        return readerChoice === choice ? copy.disagreeYesNo(name(choice)) : copy.disagree(name(choice), name(readerChoice));
      }
      if (choice !== NONE_OF_THESE) return copy.disagreeReaderNone(name(choice));
      const yes = noul ? Object.keys(noul).filter(id => noul[id] >= 0.5) : [];
      return yes.length ? copy.disagreeYesNoOther(names(yes)) : copy.disagreeNoFigures;
    }
    default:
      return copy.unknown;
  }
}
