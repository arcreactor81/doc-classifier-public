/**
 * How it decides (SPEC §2.3), as the artifact's "How it decides" view: the hero with four facts and the in-page jump
 * links, then six chapters (`.x-ch`): the journey of one document, the two opinions, the rules to try, what each reader
 * costs, and the safety promises. Plain words only; every fact is the real engine's:
 *
 * - The rule simulator calls core/domain/decision.ts `decide()` itself, with this site's active categories and the
 *   current filing certainty, so the outcome shown is the one the service would record.
 * - The quote checker is core/vendors/evidence-policy.ts `evidenceMatches()`, under the site's comparison policy.
 * - The readers are this site's project pack (store.project). Their costs are measured only: the average per document
 *   the daily usage record holds for each (core/ui/cost-guide.ts); a reader with none shows no figure, never an estimate.
 *
 * The artifact's "Track record" chapter is left out: the engine records no such results to show.
 */
import { computed, effect, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { decide, type Decision } from '../../../core/domain/decision.ts';
import { evidenceMatches, readerEvidencePolicy } from '../../../core/vendors/evidence-policy.ts';
import { readerFamilyOf, type ProjectPack } from '../../../core/config/project.ts';
import { readerModelIdentity } from '../../../core/config/model-choice.ts';
import { categoryName, categoryNames } from '../../../core/ui/result-presenter.ts';
import { percent } from '../../../core/ui/format.ts';
import { costGuideRows } from '../../../core/ui/cost-guide.ts';
import { each, h, show } from '../view/dom.ts';
import { words } from '../components/words.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import './help.css';

type HelpCopy = ViewContext['copy']['help'];
interface Cat { id: string; name: string }
interface Sim { choice: string; cert: number; noul: Record<string, number>; yes: readonly string[]; fail: boolean; warn: boolean }

/** decision.ts's rules in its order; the index is the row of the rules table. */
const RULES: readonly Decision['ruleId'][] = ['R0', 'R0n', 'R1', 'R2', 'R3', 'R4', 'R5'];
const NONE = 'none_of_these';
/** The outcome colour of each rule's row: could not process, filed, or needs review. */
const TONE = ['u', 'p', 'f', 'p', 'p', 'p', 'p'] as const;

/** The readers this site offers; a site with no menu has the one reader its pack names. */
function readerOptions(p: ProjectPack): { id: string; label: string; pin: { id: string }; rates: ProjectPack['prices']['interactive']['reader'] }[] {
  if (p.readerModels !== undefined) return p.readerModels.options;
  return [{ id: readerModelIdentity(p).id ?? 'reader', label: readerModelIdentity(p).label, pin: p.pins.reader, rates: p.prices.interactive.reader }];
}

function chapter(id: string, eyebrow: string, title: string, lead: string, ...body: Node[]): HTMLElement {
  return h('section', { class: 'x-ch', attrs: { id, 'aria-labelledby': `${id}-h` } },
    h('div', { class: 'x-head' },
      h('div', null, h('div', { class: 'eyebrow' }, eyebrow), h('h2', { attrs: { id: `${id}-h` } }, title)),
      h('p', null, lead)),
    ...body);
}

const prose = (rows: readonly (readonly [string, string])[]) => rows.map(([b, text]) => h('p', null, h('b', null, b), ' ', text));

/** The six examples of the artifact, made from this site's first three categories. */
function preset(name: keyof HelpCopy['rules']['presets'], ids: readonly string[]): Sim {
  const [a, b = a, c = b] = ids;
  const noul = (values: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = values[id] ?? .05;
    return out;
  };
  switch (name) {
    case 'clean': return { choice: a, cert: .94, noul: noul({ [a]: .97, [b]: .04, [c]: .02 }), yes: [a], fail: false, warn: false };
    case 'low': return { choice: a, cert: .78, noul: noul({ [a]: .81, [b]: .2, [c]: .05 }), yes: [a], fail: false, warn: false };
    case 'dis': return { choice: a, cert: .91, noul: noul({ [a]: .88, [b]: .3, [c]: .05 }), yes: b === a ? [] : [b], fail: false, warn: false };
    case 'two': return { choice: b, cert: .62, noul: noul({ [a]: .55, [b]: .7, [c]: .1 }), yes: a === b ? [a] : [a, b], fail: false, warn: false };
    case 'none': return { choice: NONE, cert: .7, noul: noul({ [a]: .1, [b]: .2, [c]: .08 }), yes: [], fail: false, warn: false };
    case 'fail': return { choice: a, cert: .5, noul: noul({}), yes: [], fail: true, warn: false };
  }
}

/** The trace beside the outcome: each check made on the way, true when it passed. */
function trace(s: Sim, cats: readonly Cat[], threshold: number, decision: Decision | null, t: HelpCopy['rules']['trace']): [boolean, string][] {
  const name = (id: string) => cats.find(cat => cat.id === id)?.name ?? id;
  const out: [boolean, string][] = [];
  if (s.fail) return [[false, t.failed]];
  out.push([true, t.readOk]);
  if (s.warn) return [...out, [false, t.warned]];
  if (s.choice !== NONE) {
    const n = s.noul[s.choice] ?? 0;
    out.push([true, t.bestFit(name(s.choice))]);
    out.push([n >= .5, t.onItsOwn(name(s.choice), percent(n), n >= .5)]);
    const exact = s.yes.length === 1 && s.yes[0] === s.choice;
    out.push([exact, exact ? t.readerExact(name(s.choice)) : s.yes.length > 0 ? t.readerOthers(s.yes.map(name), name(s.choice)) : t.readerNone]);
  } else out.push([false, t.noneFits]);
  switch (decision?.ruleId) {
    case 'R1': case 'R2': return [...out, [decision.ruleId === 'R1', t.sure(percent(s.cert), percent(threshold), decision.ruleId === 'R1')]];
    case 'R3': return [...out, [false, t.straddles]];
    case 'R4': return [...out, [false, t.nothing]];
    default: return [...out, [false, t.disagree]];
  }
}

export function helpScreen(ctx: ViewContext<RouteOf<'help'>>): Node {
  const copy = ctx.copy, c = copy.help, store = ctx.store;
  void store.loadDefinitions();
  void store.loadProject();
  void store.loadUsage();

  // This site's categories: the active ones, or the starting set before any are active.
  const cats = computed<readonly Cat[]>(() => {
    const d = store.definitions();
    if (d.state !== 'ready') return [];
    const typeFile = d.value.active?.typeFile ?? d.value.seedTypeFile;
    const names = d.value.active ? categoryNames(typeFile, d.value.active.displayNames) : categoryNames(typeFile, {});
    return typeFile.types.map(type => ({ id: type.id, name: categoryName(type.id, names) }));
  }, { equals: (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name) });
  const noneName = computed(() => {
    const d = store.definitions();
    return d.state === 'ready' ? (d.value.active?.typeFile ?? d.value.seedTypeFile).none_of_these.name : '';
  });
  // The filing certainty in force: Health's, when the app has read it; 90% is where every category starts.
  const threshold = computed(() => { const x = store.health(); return x.state === 'ready' && x.value.filing ? x.value.filing.value : .9; });
  const pack = computed<ProjectPack | null>(() => { const p = store.project(); return p.state === 'ready' ? p.value : null; });

  // ---------- The simulator's state ----------
  const sim = signal<Sim>({ choice: NONE, cert: .94, noul: {}, yes: [], fail: false, warn: false });
  const presetOn = signal<string | null>('clean');
  effect(() => {
    const ids = cats().map(cat => cat.id);
    if (ids.length > 0) untrack(() => { sim.set(preset('clean', ids)); presetOn.set('clean'); });
  });
  const edit = (change: Partial<Sim>) => { sim.update(s => ({ ...s, ...change })); presetOn.set(null); };
  const decision = computed<Decision | null>(() => {
    const s = sim(), ids = cats().map(cat => cat.id);
    if (ids.length === 0) return null;
    try {
      return decide({
        typeIds: ids, threshold: threshold(), failures: s.fail ? ['F_EXAMPLE'] : [], notes: s.warn ? ['N_EXAMPLE'] : [],
        confidence: { choice: s.choice, certainty: s.cert, noul: Object.fromEntries(ids.map(id => [id, s.noul[id] ?? .05])) },
        readerYes: s.yes.filter(id => ids.includes(id))
      });
    } catch { return null; }
  });
  const ruleIndex = computed(() => { const d = decision(); return d === null ? -1 : RULES.indexOf(d.ruleId); });

  // ---------- Hero ----------
  const facts: readonly [Read<string> | string, string][] = [
    ['2', c.facts.opinions], [computed(() => percent(threshold())), c.facts.sure], [String(RULES.length), c.facts.rules], ['0', c.facts.uploaded]
  ];
  const jumps: readonly [string, string][] = [['x-pipeline', c.jump.journey], ['x-jev', c.jump.opinion1], ['x-reader', c.jump.opinion2],
    ['x-rules', c.jump.rules], ['x-cost', c.jump.cost], ['x-guards', c.jump.safety]];
  const hero = h('div', { class: 'x-hero' },
    h('div', { class: 'eyebrow' }, c.overline),
    h('h1', { attrs: { tabindex: -1 } }, words(c.titleA), ' ', h('em', null, words(c.titleB))),
    h('p', { class: 'lede' }, c.lead),
    h('div', { class: 'x-facts' }, facts.map(([n, label]) => h('div', { class: 'panel x-fact' }, h('b', null, n), h('span', null, label)))),
    h('nav', { class: 'x-jump', attrs: { 'aria-label': c.jumpLabel } }, jumps.map(([id, label]) =>
      // ui-rules: non-operational button — scrolls to a chapter of this page; the address stays the same.
      h('button', { attrs: { type: 'button', 'aria-controls': id }, on: { click: () => {
        const target = document.getElementById(id);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target?.querySelector('h2')?.setAttribute('tabindex', '-1');
        (target?.querySelector('h2') as HTMLElement | null)?.focus({ preventScroll: true });
      } } }, label))));

  // ---------- 1 · The journey ----------
  const journey = chapter('x-pipeline', c.journey.eyebrow, c.journey.title, c.journey.lead,
    h('div', { class: 'x-lanes' },
      h('div', { class: 'x-lane' }, h('span', { class: 'eyebrow' }, c.journey.local),
        h('div', { class: 'x-steps' }, h('div', { class: 'x-st' },
          h('span', { class: 'n' }, c.journey.start), h('b', null, c.journey.read[0]), h('p', null, c.journey.read[1])))),
      h('div', { class: 'x-lane cloud' }, h('span', { class: 'eyebrow' }, c.journey.cloud),
        h('ol', { class: 'x-steps' }, c.journey.steps.map(([title, text], i) =>
          h('li', { class: i >= 2 && i <= 4 ? 'x-st key' : 'x-st' }, h('span', { class: 'n' }, String(i + 1)), h('b', null, title), h('p', null, text)))),
        h('div', { class: 'x-flow', attrs: { 'aria-hidden': 'true' } }, h('i')))),
    h('p', { class: 'x-note' }, c.journey.note));

  // ---------- 2 · Opinion 1: the example panel follows the simulator ----------
  const nameOf = (id: string) => id === NONE ? noneName() : cats().find(cat => cat.id === id)?.name ?? id;
  const fitRows = computed(() => cats().map(cat => cat.id));
  const opinion1 = chapter('x-jev', c.opinion1.eyebrow, c.opinion1.title, c.opinion1.lead,
    h('div', { class: 'x-two' },
      h('div', { class: 'panel x-prose' }, prose(c.opinion1.prose), h('ul', { class: 'x-plain' }, c.opinion1.plain.map(line => h('li', null, line)))),
      h('div', { class: 'panel' },
        h('div', { class: 'eyebrow x-example-title' }, c.opinion1.exampleTitle),
        h('div', { class: 'x-fit' }, each(fitRows, id => computed(() => id), id => {
          const key = id.peek();
          const value = computed(() => sim().noul[key] ?? .05);
          return h('div', { class: 'x-fitrow', classes: { lead: computed(() => sim().choice === key) } },
            h('span', null, computed(() => nameOf(key))),
            h('i', { vars: { '--w': computed(() => percent(value())) } }),
            h('b', null, computed(() => percent(value()))));
        })),
        h('div', { class: 'x-sure' },
          h('span', null, c.opinion1.bestFit), h('b', null, computed(() => nameOf(sim().choice))),
          h('span', null, c.opinion1.howSure), h('b', { class: 'x-big' }, computed(() => percent(sim().cert)))),
        show(computed(() => sim().choice !== NONE), () => h('p', { class: 'x-note' },
          c.opinion1.onItsOwnBefore, ' ',
          h('b', { class: 'x-strong' }, computed(() => c.opinion1.likely(percent(sim().noul[sim().choice] ?? .05)))), ' ',
          c.opinion1.onItsOwnAfter)))));

  // ---------- 3 · Opinion 2: the quote check ----------
  const quote = signal<string>(c.opinion2.quoteStart);
  const policy = computed(() => { try { return readerEvidencePolicy(pack()?.settings.readerEvidencePolicy ?? 'whitespace-quotes-v1'); } catch { return 'whitespace-quotes-v1' as const; } });
  const verdict = computed<'ok' | 'no' | null>(() => quote().trim() === '' ? null : evidenceMatches(c.opinion2.docText, quote(), policy()) ? 'ok' : 'no');
  const readers = computed(() => {
    const p = pack();
    if (p === null) return null;
    const options = readerOptions(p);
    const def = options.find(o => o.id === (p.readerModels?.defaultId ?? options[0]?.id));
    if (!def) return null;
    return {
      def: def.label, others: options.filter(o => o !== def).map(o => o.label),
      experimental: options.filter(o => readerFamilyOf(o.pin.id)?.experimental === true).map(o => o.label)
    };
  });
  const opinion2 = chapter('x-reader', c.opinion2.eyebrow, c.opinion2.title, c.opinion2.lead,
    h('div', { class: 'x-two' },
      h('div', null,
        h('div', { class: 'x-doc', classes: { hit: computed(() => verdict() === 'ok') } },
          h('span', { class: 'lbl' }, c.opinion2.docLabel), h('span', null, c.opinion2.docText)),
        h('div', { class: 'x-qc' },
          h('label', { attrs: { for: 'xQuote' } }, c.opinion2.quoteLabel),
          h('textarea', { class: 'ta', attrs: { id: 'xQuote', rows: 2 }, props: { value: quote },
            on: { input: event => quote.set((event.target as HTMLTextAreaElement).value) } }),
          h('div', { attrs: { role: 'status' } }, show(computed(() => verdict() !== null), () =>
            h('div', { class: computed(() => `x-verdict ${verdict() ?? ''}`) },
              h('span', { attrs: { 'aria-hidden': 'true' } }, computed(() => (verdict() === 'ok' ? '✓' : '✗'))),
              h('span', null, computed(() => (verdict() === 'ok' ? c.opinion2.found : c.opinion2.notFound)))))))),
      h('div', { class: 'panel x-prose' }, prose(c.opinion2.prose),
        show(computed(() => readers() !== null), () => h('p', null, h('b', null, c.opinion2.whichHead), ' ',
          computed(() => { const r = readers(); return r === null ? '' : c.opinion2.which(r.def, r.others); }), ' ',
          computed(() => { const r = readers(); return r === null || r.experimental.length === 0 ? '' : c.opinion2.experimental(r.experimental); }))))));

  // ---------- 4 · Try the rules ----------
  const presetKeys = Object.keys(c.rules.presets) as (keyof HelpCopy['rules']['presets'])[];
  const outEl = { el: null as HTMLElement | null };
  let lastRule = -1;
  effect(() => {
    const i = ruleIndex();
    const el = outEl.el;
    if (el !== null && lastRule !== -1 && i !== lastRule) {
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
    lastRule = i;
  });
  const catIds = computed(() => cats().map(cat => cat.id));
  const slider = (id: string, label: Read<string> | string, value: Read<number>, set: (v: number) => void) =>
    h('div', { class: 'x-sl' },
      h('label', { attrs: { for: id } }, label),
      h('input', { attrs: { id, type: 'range', min: 0, max: 1, step: .01 }, props: { value: computed(() => String(value())) },
        on: { input: event => set(Number((event.target as HTMLInputElement).value)) } }),
      h('output', { attrs: { for: id } }, computed(() => percent(value()))));
  const rules = chapter('x-rules', c.rules.eyebrow, c.rules.title, c.rules.lead,
    h('div', { class: 'x-sim' },
      h('div', { class: 'panel x-ctl' },
        h('div', null, h('h3', null, c.rules.presetsTitle), h('div', { class: 'x-presets' }, presetKeys.map(key =>
          // ui-rules: non-operational button — loads an example into the controls on this page; nothing is sent.
          h('button', { class: 'x-pill', attrs: { type: 'button', 'aria-pressed': computed(() => String(presetOn() === key)) },
            on: { click: () => { const ids = untrack(catIds); if (ids.length) { sim.set(preset(key, ids)); presetOn.set(key); } } } }, c.rules.presets[key])))),
        h('div', null, h('h3', { attrs: { id: 'x-best-h' } }, c.rules.bestFit),
          h('div', { class: 'x-seg', attrs: { role: 'radiogroup', 'aria-labelledby': 'x-best-h' } },
            each(computed(() => [...catIds(), NONE]), id => computed(() => id), id => {
              const key = id.peek();
              return h('label', null,
                h('input', { attrs: { type: 'radio', name: 'xchoice', value: key }, props: { checked: computed(() => sim().choice === key) },
                  on: { change: () => edit({ choice: key }) } }),
                h('span', null, computed(() => nameOf(key))));
            })),
          h('div', { class: 'x-sl-top' }, slider('xCert', c.rules.howSure, computed(() => sim().cert), v => edit({ cert: v })))),
        h('div', null, h('h3', null, c.rules.onItsOwn),
          each(catIds, id => computed(() => id), id => {
            const key = id.peek();
            return slider(`xN-${key}`, computed(() => nameOf(key)), computed(() => sim().noul[key] ?? .05),
              v => edit({ noul: { ...untrack(sim).noul, [key]: v } }));
          })),
        h('div', null, h('h3', null, c.rules.readerYes),
          each(catIds, id => computed(() => id), id => {
            const key = id.peek();
            return h('label', { class: 'x-chk' },
              h('input', { attrs: { type: 'checkbox' }, props: { checked: computed(() => sim().yes.includes(key)) },
                on: { change: event => {
                  const on = (event.target as HTMLInputElement).checked, yes = untrack(sim).yes.filter(x => x !== key);
                  edit({ yes: on ? [...yes, key] : yes });
                } } }),
              h('span', null, computed(() => nameOf(key))));
          })),
        h('div', null, h('h3', null, c.rules.problems),
          h('label', { class: 'x-chk' }, h('input', { attrs: { type: 'checkbox' }, props: { checked: computed(() => sim().fail) },
            on: { change: event => edit({ fail: (event.target as HTMLInputElement).checked }) } }), h('span', null, c.rules.fail)),
          h('label', { class: 'x-chk' }, h('input', { attrs: { type: 'checkbox' }, props: { checked: computed(() => sim().warn) },
            on: { change: event => edit({ warn: (event.target as HTMLInputElement).checked }) } }), h('span', null, c.rules.warn)))),
      h('div', { class: 'x-res' },
        h('div', { class: computed(() => `x-out ${ruleIndex() < 0 ? '' : TONE[ruleIndex()]}`), attrs: { role: 'status', 'aria-live': 'polite' }, ref: el => { outEl.el = el; } },
          h('div', null,
            h('span', { class: 'x-rule' }, computed(() => (ruleIndex() < 0 ? '' : c.rules.ruleOf(ruleIndex() + 1, RULES.length)))),
            h('b', null, computed(() => (ruleIndex() < 0 ? '' : c.rules.outcomes[ruleIndex()][0]))),
            h('span', null, computed(() => (ruleIndex() < 0 ? '' : c.rules.outcomes[ruleIndex()][1]))))),
        h('div', { class: 'panel' }, h('h3', { class: 'x-why' }, c.rules.why),
          h('ul', { class: 'x-trace' }, each(computed(() => trace(sim(), cats(), threshold(), decision(), c.rules.trace).map((_, i) => String(i))),
            i => computed(() => trace(sim(), cats(), threshold(), decision(), c.rules.trace)[Number(i)]),
            line => h('li', null,
              h('span', { class: computed(() => (line()?.[0] ? 'y' : 'x')), attrs: { 'aria-hidden': 'true' } }, computed(() => (line()?.[0] ? '✓' : '✗'))),
              h('span', null, computed(() => line()?.[1] ?? '')))))),
        h('div', { class: 'panel x-rules-panel' }, h('table', { class: 'x-rules' }, h('tbody', null, c.rules.table.map(([what, then], i) =>
          h('tr', { classes: { hit: computed(() => ruleIndex() === i), pk: computed(() => ruleIndex() === i && TONE[i] !== 'f'), passed: computed(() => i < ruleIndex()) },
            attrs: { 'aria-current': computed(() => (ruleIndex() === i ? 'true' : null)) } },
            h('td', null, String(i + 1)), h('td', null, what), h('td', null, then)))))))));

  // ---------- 5 · Cost ----------
  // Measured figures only (core/ui/cost-guide.ts): a reader this site has not measured shows no price.
  const docs = signal(100);
  const money = (nano: number) => {
    const dollars = nano / 1e9;
    return dollars < .01 ? c.cost.underCent : dollars < 1 ? c.cost.cents(Math.round(dollars * 100)) : c.cost.dollars(dollars.toFixed(2));
  };
  const measured = computed(() => {
    const u = store.usage();
    return u.state === 'ready' && u.value.enabled ? u.value.readerModels : [];
  });
  const costRows = computed(() => {
    const p = pack();
    if (p === null) return null;
    const options = readerOptions(p), defaultId = p.readerModels?.defaultId ?? options[0].id;
    return costGuideRows(options.map(o => ({
      id: o.id, label: o.label, experimental: readerFamilyOf(o.pin.id)?.experimental === true, isDefault: o.id === defaultId
    })), measured(), docs());
  });
  const costSlider = (id: string, label: string, min: number, max: number, step: number, value: Read<number>, set: (v: number) => void) =>
    h('div', { class: 'x-sl x-sl--cost' },
      h('label', { attrs: { for: id } }, label),
      h('input', { attrs: { id, type: 'range', min, max, step }, props: { value: computed(() => String(value())) },
        on: { input: event => set(Number((event.target as HTMLInputElement).value)) } }),
      h('output', { attrs: { for: id } }, computed(() => value().toLocaleString('en'))));
  const cost = chapter('x-cost', c.cost.eyebrow, c.cost.title, c.cost.lead,
    h('div', { class: 'panel' },
      show(computed(() => costRows() === null), () => h('p', { class: 'x-note' },
        computed(() => (store.project().state === 'error' ? c.cost.unavailable : c.cost.loading)))),
      show(computed(() => costRows() !== null), () => h('div', null,
        h('div', { class: 'x-costctl' },
          costSlider('xDocs', c.cost.docs, 10, 1000, 1, docs, v => docs.set(v))),
        show(computed(() => store.usage().state === 'error'), () => h('p', { class: 'x-note' }, c.cost.usageUnavailable)),
        h('div', { class: 'x-bars' }, each(computed(() => costRows()?.map(r => r.id) ?? []), id => computed(() => costRows()?.find(r => r.id === id)),
          row => h('div', { classes: { 'x-bar': true, exp: computed(() => row()?.experimental === true), sel: computed(() => row()?.isDefault === true) },
            attrs: { 'data-measured': computed(() => (row()?.measured ? 'true' : 'false')) } },
            h('div', null, h('b', null, computed(() => row()?.name ?? '')),
              h('small', null, computed(() => { const r = row(); return r === undefined ? '' : r.isDefault ? c.cost.standard : r.experimental ? c.cost.experimental : c.cost.other; }))),
            h('div', { class: 'x-track' }, h('i', { vars: { '--w': computed(() => row()?.measured?.width ?? '0%') } })),
            h('div', { class: 'v' }, computed(() => { const m = row()?.measured; return m ? money(m.runNano) : ''; }),
              h('small', null, computed(() => {
                const m = row()?.measured;
                return m ? c.cost.measured(money(m.perDocumentNano), m.documents) : c.cost.notMeasured;
              })))))),
        h('p', { class: 'x-note' }, c.cost.note)))));

  // ---------- 6 · Safety ----------
  const minimum = computed(() => pack()?.settings.minimumFiledCount ?? null);
  const safety = chapter('x-guards', c.safety.eyebrow, c.safety.title, c.safety.lead,
    h('div', { class: 'x-guards' },
      c.safety.guards.map(([title, text]) => h('div', { class: 'panel x-guard' }, h('h3', null, title), h('p', null, text))),
      h('div', { class: 'panel x-guard' }, h('h3', null, c.safety.decide[0]),
        h('p', null, computed(() => { const n = minimum(); return n === null ? c.safety.decide[1] : c.safety.decideMinimum(n); })))));

  return h('section', { class: 'x-page', testid: 'help' }, hero, journey, opinion1, opinion2, rules, cost, safety);
}
