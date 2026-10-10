/**
 * EvidencePanel (SPEC §7.2 evidence drawer; prototype-v3 la.js `evidenceHTML`): why one document went where it went,
 * in the two systems' own recorded words. Shown on demand from Results, directly beneath the document's row.
 * - The lead: the recorded rule restated (core/ui/rule-sentence.ts) under "Why it came to you" / "Why it was filed".
 * - The two systems, side by side: the certainty with its filing threshold, the separate category probabilities,
 *   and its yes or no per category; the reader's yes or no per category, its
 *   reason and the exact quotes it relied on. The two are never combined (AGENTS §4).
 * - Judged against these categories: the definition of what each system chose, with the sentences that name the
 *   other one marked (components/definition-card.ts).
 * - Two disclosures: what the systems read (kept on the computer that read the files) and Details (technical).
 * - Only validated outputs are shown, exactly as recorded; nothing is reworded or summarised.
 */
import './evidence-panel.css';
import { computed, effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { percent } from '../../../core/ui/format.ts';
import { NONE_OF_THESE, categoryName, type CategoryNames } from '../../../core/ui/result-presenter.ts';
import { ruleSentence, type DecisionFacts } from '../../../core/ui/rule-sentence.ts';
import type { DocumentType } from '../../../core/config/project.ts';
import type { EvidenceView } from '../../../core/ui/wire.ts';
import type { UiErrorView } from '../../../core/ui/error-copy.ts';
import type { ConfidenceOutput, ReaderOutput } from '../../../core/vendors/validate.ts';
import { h, match } from '../view/dom.ts';
import { animate, ease, ms, trace } from '../view/motion.ts';
import { definitionCard } from './definition-card.ts';
import { disclosure } from './disclosure.ts';
import { errorNotice } from './notice.ts';

export type EvidenceAnswers = Pick<EvidenceView, 'confidence' | 'reader' | 'failure'>;
export type EvidenceLoad =
  | { state: 'loading' }
  | { state: 'ready'; answers: EvidenceAnswers }
  | { state: 'error'; error: UiErrorView };

export interface EvidencePanelSpec {
  filename: string;
  names: CategoryNames;
  /** The run's frozen categories, for the definition cards. */
  types: readonly DocumentType[];
  /** The run's filing certainty as a decimal (the one that decided this run). */
  threshold: number;
  /** The recorded decision (rule, category, notes); null while the document has no outcome. */
  decision: DecisionFacts | null;
  load: Read<EvidenceLoad>;
  testid?: string;
}

type Name = (id: string) => string;

/** The independent yes/no check reads "Yes" from this value up (core/domain/decision.ts). */
const NOUL_YES = 0.5;

// The drawer's opening (prototype-v3 la.js `openEvidence`): the offsets between its parts; the durations are tokens.
const BLOCK_LEAD_MS = 80;
const BLOCK_STEP_MS = 70;
const TRACE_LEAD_MS = 220;
const TRACE_STEP_MS = 120;
const BAR_LEAD_MS = 320;
const BAR_STEP_MS = 40;

export function evidencePanel(spec: EvidencePanelSpec): HTMLElement {
  const e = activeUiCopy.evidence;
  const state = computed(() => spec.load().state);
  return h('div', {
    class: 'ev',
    attrs: { role: 'region', 'aria-label': e.title(spec.filename), 'aria-busy': computed(() => (state() === 'loading' ? 'true' : null)) },
    testid: spec.testid ?? 'evidence'
  },
  match(state, {
    loading: () => h('p', { class: 'ev-loading' }, e.loading),
    error: () => {
      const load = spec.load.peek();
      return load.state === 'error' ? errorNotice(load.error, 'problem') : document.createTextNode('');
    },
    ready: () => {
      const load = spec.load.peek();
      if (load.state !== 'ready') return document.createTextNode('');
      const body = answersView(load.answers, spec);
      // After this turn's insertion: the body is built before match() appends it.
      queueMicrotask(() => enter(body));
      return body;
    }
  }));
}

/** The category ids in the run's order (its categories, then "none of these", then anything else recorded). */
function orderIds(keys: readonly string[], types: readonly DocumentType[]): string[] {
  const known = [...types.map(type => type.id), NONE_OF_THESE].filter(id => keys.includes(id));
  return [...known, ...keys.filter(id => !known.includes(id))];
}

function answersView(answers: EvidenceAnswers, spec: EvidencePanelSpec): HTMLElement {
  const e = activeUiCopy.evidence;
  const name: Name = id => categoryName(id, spec.names);
  const { confidence, reader, failure } = answers;
  const decision = spec.decision;
  const rule = decision?.ruleId ?? null;
  const readerYes = reader === null ? [] : reader.verdicts.filter(verdict => verdict.is_type).map(verdict => verdict.type_id);
  const overline = failure !== null || rule === 'R0' ? e.whyFailed : rule === 'R1' ? e.whyFiled : e.whyToYou;
  const lead = decision === null ? e.noOutcomeYet : ruleSentence(decision, { confidence, reader }, spec.threshold, spec.names);
  const parts: Node[] = [
    h('div', { class: 'ev-lead' }, h('p', { class: 'overline' }, overline), h('p', { class: 'ev-lead__text' }, lead))
  ];
  if (failure !== null) {
    parts.push(h('div', { class: 'ev-failure' },
      h('p', null, e.failed),
      h('p', { class: 'quote' }, failure.message),
      h('p', { class: 'small faint' }, e.failedNote)));
  }
  if (confidence !== null || reader !== null) {
    parts.push(h('div', { class: 'ev-block' },
      h('p', { class: 'ev-h' }, e.sideBySide),
      h('div', { class: 'ev-2' }, certaintySection(confidence, spec, name), readerSection(reader, name))));
  }
  const cards = judgedCards(rule, decision, confidence, reader, readerYes, spec, name);
  if (cards.length > 0) {
    parts.push(h('div', { class: 'ev-block' },
      h('p', { class: 'ev-h' }, e.judgedAgainstThese),
      h('div', { class: cards.length === 1 ? 'ev-2 ev-2--one' : 'ev-2' }, cards)));
  }
  parts.push(disclosure({ summary: e.whatRead, class: 'ev-disc', content: () => h('p', { class: 'small faint' }, e.onlyHere) }));
  parts.push(disclosure({
    summary: activeUiCopy.details, technical: true, class: 'ev-disc',
    content: () => h('div', null,
      h('p', { class: 'small' }, e.detailsIntro),
      h('pre', null, JSON.stringify({ decision, certaintyCheck: confidence, reader, failure }, null, 2)))
  }));
  return h('div', { class: 'ev-body' }, parts);
}

function systemTop(title: string, sub: string): HTMLElement {
  return h('div', { class: 'sys__top' },
    h('p', { class: 'sys__name' }, h('i', { attrs: { 'aria-hidden': 'true' } }), title),
    h('p', { class: 'sys__sub' }, sub));
}

/** The certainty check: its one choice among all categories, then its separate yes or no for each. */
function certaintySection(confidence: ConfidenceOutput | null, spec: EvidencePanelSpec, name: Name): HTMLElement {
  const e = activeUiCopy.evidence;
  const parts: Node[] = [systemTop(e.certaintyCheck, e.oneChoice)];
  if (confidence === null) parts.push(h('p', { class: 'sys__reason faint' }, e.notRecorded));
  else {
    const ids = orderIds(Object.keys(confidence.probabilities), spec.types);
    parts.push(h('div', { class: 'bars', testid: 'ev-certainty' },
      h('div', { class: 'bar-row' },
        h('span', { class: 'bar-row__name' }, e.certainty),
        h('span', { class: 'bar', vars: { '--mark': spec.threshold } },
          h('i', { vars: { '--fill': confidence.confidence } }),
          h('span', { class: 'bar__mark', attrs: { 'aria-hidden': 'true' } })),
        h('span', { class: 'v' }, percent(confidence.confidence))),
      h('p', { class: 'bars__note' }, h('i', { attrs: { 'aria-hidden': 'true' } }), e.neededToFile(percent(spec.threshold)))));
    parts.push(h('p', { class: 'ev-h ev-h--in' }, e.categoryShares));
    parts.push(h('div', { class: 'bars', testid: 'ev-choice-probabilities' }, ids.map(id => h('div', { class: 'bar-row', classes: { 'is-choice': id === confidence.choice } },
      h('span', { class: 'bar-row__name' }, name(id)),
      h('span', { class: 'bar' }, h('i', { vars: { '--fill': confidence.probabilities[id] } })),
      h('span', { class: 'v' }, percent(confidence.probabilities[id]))))));
    parts.push(h('p', { class: 'ev-h ev-h--in' }, e.separateYesNo));
    parts.push(h('p', { class: 'sys__sub sys__sub--under' }, e.notCombined));
    parts.push(h('div', { class: 'yn' }, orderIds(Object.keys(confidence.nouls), spec.types).map(id => {
      const yes = confidence.nouls[id] >= NOUL_YES;
      return h('div', null,
        h('span', null, name(id)),
        h('b', { classes: { no: !yes } }, e.yesNoValue(yes ? e.yes : e.no, percent(confidence.nouls[id]))));
    })));
  }
  return h('section', { class: 'sys sys--check', attrs: { 'aria-label': e.certaintyCheck }, testid: 'ev-check' }, parts);
}

/** The reader: a yes or no for each category, then the reason and the exact quotes behind each yes. */
function readerSection(reader: ReaderOutput | null, name: Name): HTMLElement {
  const e = activeUiCopy.evidence;
  const parts: Node[] = [systemTop(e.reader, e.yesNoEach)];
  if (reader === null) parts.push(h('p', { class: 'sys__reason faint' }, e.notRecorded));
  else {
    parts.push(h('div', { class: 'yn' }, reader.verdicts.map(verdict => h('div', null,
      h('span', null, name(verdict.type_id)),
      h('b', { classes: { no: !verdict.is_type } }, verdict.is_type ? e.yes : e.no)))));
    const fits = reader.verdicts.filter(verdict => verdict.is_type);
    if (fits.length === 0) {
      parts.push(h('p', { class: 'ev-h ev-h--in' }, e.itsReason), h('p', { class: 'sys__reason' }, e.fitsNone));
      const closest = reader.verdicts.find(verdict => verdict.closest_alternative !== null)?.closest_alternative ?? null;
      if (closest !== null) parts.push(h('p', { class: 'sys__reason faint' }, e.closest(name(closest))));
    }
    for (const verdict of fits) {
      parts.push(h('p', { class: 'ev-h ev-h--in' }, fits.length > 1 ? e.reasonFor(name(verdict.type_id)) : e.itsReason));
      parts.push(h('p', { class: 'sys__reason' }, verdict.rationale));
      parts.push(h('p', { class: 'ev-h ev-h--in' }, e.quotes));
      if (verdict.evidence.length === 0) parts.push(h('p', { class: 'sys__reason faint' }, e.noQuotes));
      else parts.push(...verdict.evidence.map(quote => h('p', { class: 'quote' }, quote)));
    }
  }
  return h('section', { class: 'sys sys--reader', attrs: { 'aria-label': e.reader }, testid: 'ev-reader' }, parts);
}

/**
 * The definitions the document was judged against, by the recorded rule: what each system chose, and (for a document
 * that came to the person) the category it was weighed against. Each card marks the sentences naming the other.
 */
function judgedCards(rule: string | null, decision: DecisionFacts | null, confidence: ConfidenceOutput | null,
  reader: ReaderOutput | null, readerYes: readonly string[], spec: EvidencePanelSpec, name: Name): HTMLElement[] {
  const e = activeUiCopy.evidence;
  const card = (id: string | null, by: string, other: string | null): HTMLElement | null => {
    const type = id === null ? null : spec.types.find(item => item.id === id) ?? null;
    if (type === null) return null;
    return h('div', { class: 'ev-def' },
      h('p', { class: 'ev-def__by' }, by),
      definitionCard({
        type, displayName: name(type.id), heading: 'h4', folder: false,
        neighbours: other === null || other === type.id ? [] : [name(other)]
      }));
  };
  const present = (cards: readonly (HTMLElement | null)[]) => cards.filter((item): item is HTMLElement => item !== null);
  const choice = confidence === null || confidence.choice === NONE_OF_THESE ? null : confidence.choice;
  // The certainty check's categories by its recorded percentages, highest first ("none of these" aside).
  const ranked = confidence === null ? [] : orderIds(Object.keys(confidence.probabilities), spec.types)
    .filter(id => id !== NONE_OF_THESE)
    .sort((a, b) => confidence.probabilities[b] - confidence.probabilities[a]);
  switch (rule) {
    case 'R1':
    case 'R0n':
      return present([card(decision?.typeId ?? choice, e.bothChose, null)]);
    case 'R2': {
      const alternative = reader?.verdicts.find(verdict => verdict.type_id === choice)?.closest_alternative
        ?? ranked.find(id => id !== choice) ?? null;
      return present([card(choice, e.bothChose, alternative), card(alternative, e.closestAlternative, choice)]);
    }
    case 'R3':
      return present(readerYes.map((id, index) => card(id, index === 0 ? e.readerFits : e.andAlso, readerYes[index === 0 ? 1 : 0] ?? null)));
    case 'R4':
      return present([card(ranked[0] ?? null, e.closestForCheck, ranked[1] ?? null), card(ranked[1] ?? null, e.nextClosest, ranked[0] ?? null)]);
    case 'R5': {
      const readerChoice = readerYes.length === 1 ? readerYes[0] : null;
      if (readerChoice !== null && readerChoice === choice) return present([card(choice, e.bothChose, null)]);
      return present([card(choice, e.checkChose, readerChoice), card(readerChoice, e.readerChose, choice)]);
    }
    default:
      return [];
  }
}

/** The drawer opens in reading order: its blocks rise one after another, each system's edge is traced, the bars fill. */
function enter(body: HTMLElement): void {
  if (!body.isConnected) return;
  animate(body, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-reveal') });
  const duration = ms('--dur-pane'), easing = ease('--ease-out');
  [...body.children].forEach((block, index) => animate(block,
    [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
    { duration, delay: BLOCK_LEAD_MS + index * BLOCK_STEP_MS, easing }));
  [...body.querySelectorAll<HTMLElement>('.sys')].forEach((pane, index) => trace(pane, { delay: TRACE_LEAD_MS + index * TRACE_STEP_MS }));
  [...body.querySelectorAll<HTMLElement>('.bar > i')].forEach((fill, index) => animate(fill,
    [{ transform: 'scaleX(0)' }, { transform: `scaleX(${fill.style.getPropertyValue('--fill') || '0'})` }],
    { duration: ms('--dur-fill'), delay: BAR_LEAD_MS + index * BAR_STEP_MS, easing: ease('--ease-fill') }));
}

export interface EvidenceSheetSpec {
  filename: string;
  outcome: Read<'filed' | 'review' | 'failed' | null>;
  names: CategoryNames;
  threshold: number;
  decision: DecisionFacts | null;
  load: Read<EvidenceLoad>;
  /** Where "How this was decided" goes (the Help page). */
  helpHref: string;
}

/** At most this many of the reader's quotes are marked on the sheet (all of them are in the panel beneath). */
const SHEET_QUOTES = 3;

/**
 * The top of the evidence drawer (The Sorting Room's `.sheet-doc` and `.verdicts`): the document as a paper sheet with
 * its outcome stamp and the reader's exact quotes marked, then the two opinions side by side as one line each (the
 * certainty check's choice and certainty; the reader's choice and whether it agrees) and the recorded rule restated,
 * then "How this was decided". Only recorded values are shown; nothing is invented for a document with no answers.
 */
export function evidenceSheet(spec: EvidenceSheetSpec): HTMLElement {
  const e = activeUiCopy.evidence;
  const name: Name = id => categoryName(id, spec.names);
  const stampKey = computed(() => spec.outcome() ?? null);
  const stem = spec.filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const answers = computed(() => { const load = spec.load(); return load.state === 'ready' ? load.answers : null; });
  const body = computed(() => {
    const a = answers();
    if (spec.load().state === 'loading') return [{ kind: 'muted' as const, text: e.loading }];
    if (a === null) return [];
    if (a.failure !== null) return [{ kind: 'muted' as const, text: a.failure.message }];
    const quotes = (a.reader?.verdicts ?? []).filter(v => v.is_type).flatMap(v => v.evidence).slice(0, SHEET_QUOTES);
    if (quotes.length === 0) return [{ kind: 'muted' as const, text: e.noTextSent }];
    return [...quotes.map(text => ({ kind: 'quote' as const, text })), { kind: 'muted' as const, text: e.quotedNote }];
  });
  const sheetBody = h('div', { class: 'sheet-doc__body' });
  effect(() => {
    const lines = body(), review = spec.outcome() === 'review';
    untrack(() => {
      while (sheetBody.firstChild) sheetBody.firstChild.remove();
      for (const line of lines) {
        sheetBody.append(line.kind === 'quote'
          ? h('p', null, h('span', { class: review ? 'mark p' : 'mark' }, line.text))
          : h('p', { class: 'm' }, line.text));
      }
    });
  });
  const certainty = computed(() => {
    const c = answers()?.confidence ?? null;
    if (c === null) return { what: '—', value: '' };
    return { what: c.choice === NONE_OF_THESE ? e.noneFits : name(c.choice), value: percent(c.confidence) };
  });
  const reader = computed(() => {
    const a = answers(), r = a?.reader ?? null;
    if (r === null) return { what: '—', value: '', agrees: null as boolean | null };
    const yes = r.verdicts.filter(v => v.is_type).map(v => v.type_id);
    const choice = a?.confidence?.choice ?? null;
    const agrees = choice !== null && yes.length === 1 && yes[0] === choice;
    return { what: yes.length === 0 ? e.noneFits : yes.map(name).join(', '), value: agrees ? e.agrees : e.differs, agrees };
  });
  const why = computed(() => {
    const a = answers();
    if (spec.decision === null) return e.noOutcomeYet;
    return a === null ? '' : ruleSentence(spec.decision, { confidence: a.confidence, reader: a.reader }, spec.threshold, spec.names);
  });
  const verdict = (label: string, what: Read<string>, value: Read<string>, tone: Read<string>) =>
    h('div', { class: 'verdict' },
      h('span', { class: 'w' }, label),
      h('b', null, what),
      h('span', { class: computed(() => `v mono ${tone()}`) }, value));
  return h('div', { class: 'ev-sheet' },
    h('div', { class: 'sheet-doc' },
      h('span', { class: computed(() => `stamp ${stampKey() === 'filed' ? 'f' : stampKey() === 'review' ? 'p' : 'u'}`),
        attrs: { hidden: computed(() => stampKey() === null) } },
      computed(() => { const k = stampKey(); return k === null ? '' : e.stamp[k]; })),
      h('h4', null, stem),
      h('div', { class: 'fn' }, `${spec.filename} · ${e.readHere}`),
      sheetBody),
    h('div', { class: 'verdicts' },
      verdict(e.opinion.certainty, computed(() => certainty().what), computed(() => certainty().value), computed(() => '')),
      verdict(e.opinion.reader, computed(() => reader().what), computed(() => reader().value),
        computed(() => (reader().agrees === null ? '' : reader().agrees ? 'is-agree' : 'is-differ'))),
      h('div', { class: 'verdict verdict--why' }, h('span', { class: 'w' }, e.opinion.why), h('span', null, why))),
    h('div', { class: 'ev-sheet__how' },
      h('a', { class: 'btn go', attrs: { href: spec.helpHref } }, e.howDecided),
      h('p', { class: 'hint' }, e.howDecidedNote)));
}
