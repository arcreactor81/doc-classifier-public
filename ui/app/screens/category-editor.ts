/**
 * Category editor (SPEC §2.3, walkthroughs 3a step 1 and 3c; journey step 9 with `from=`). The person describes each
 * category in their own words: what belongs, what doesn't (naming the neighbour it is confused with), and examples.
 * "Review changes" saves the edits as a draft revision and opens its review; nothing is used until it is activated
 * there. The draft starts from the active categories, or from the app's starting set when none are active.
 * Laid out as the artifact's editor: an eyebrow naming the draft's version, one panel per category (name and folder,
 * then what belongs and what doesn't side by side, then the examples), and "Review changes" beside Cancel.
 */
import { trialEvidence } from '../components/trial-review.ts';
import { computed, effect, signal, untrack } from '../../../core/ui/reactive.ts';
import { formatRoute, runViewRoute } from '../../../core/ui/routes.ts';
import { versionNumbers } from '../../../core/ui/run-naming.ts';
import { assignCategoryIds } from '../../../core/ui/category-id.ts';
import type { TypeFile } from '../../../core/config/project.ts';
import type { Phrase } from '../../../core/ui/journey.ts';
import { each, h, show } from '../view/dom.ts';
import { action, type ActionSpec } from '../view/action.ts';
import { navigate } from '../router.ts';
import { actionSlot } from '../components/action-slot.ts';
import { words } from '../components/words.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import './categories.css';

interface Card { key: string; id: string | null; name: string; what: string; notFor: string; examples: string }
type CardField = 'name' | 'what' | 'notFor' | 'examples';

let nextKey = 0;
const cardOf = (type: TypeFile['types'][number] | null): Card => ({
  key: `card-${++nextKey}`, id: type?.id ?? null, name: type?.name ?? '', what: type?.what ?? '',
  notFor: type?.not_for ?? '', examples: (type?.examples ?? []).join('\n')
});

export function categoryEditorScreen(ctx: ViewContext<RouteOf<'category-edit'>>): Node {
  const copy = ctx.copy, c = copy.categories;
  const store = ctx.store;
  const { fromRunId, correctionId } = ctx.route.peek();
  void store.loadDefinitions();
  const evidenceFingerprint = fromRunId === null ? null : ctx.controllers.trial(fromRunId).editorEvidence();
  const evidenceRun = fromRunId !== null && evidenceFingerprint !== null ? store.runStore(fromRunId) : null;
  if(evidenceRun) { void evidenceRun.loadPlan(); void evidenceRun.readStatus(); }

  const defs = computed(() => { const d = store.definitions(); return d.state === 'ready' ? d.value : null; });

  const cards = signal<readonly Card[]>([]);
  const none = signal({ name: '', what: '' });
  let started = false;
  effect(() => {
    const d = defs();
    if (d === null || started) return;
    started = true;
    const source = d.active?.typeFile ?? d.seedTypeFile;
    untrack(() => {
      cards.set(source.types.length > 0 ? source.types.map(cardOf) : [cardOf(null)]);
      none.set({ name: source.none_of_these.name, what: source.none_of_these.what });
    });
  });

  // Opened from a saved review: each new folder the person made there is offered as a category, added only when they
  // choose it (sweep LOOP-6). The wording is theirs to write; the folder's files are not offered as examples.
  const fromRun = fromRunId !== null && correctionId !== null ? store.runStore(fromRunId) : null;
  if (fromRun !== null) {
    const held = fromRun.correction.peek();
    if (held.state !== 'ready' || held.value?.correctionId !== correctionId) void fromRun.loadCorrection(correctionId!);
  }
  const taken = signal<ReadonlySet<string>>(new Set());
  const suggestions = computed(() => {
    const loaded = fromRun?.correction();
    if (loaded === undefined || loaded.state !== 'ready' || loaded.value === null) return [];
    return loaded.value.proposals.newTypes.filter(type => !taken().has(type.folder));
  });

  const setField = (key: string, field: CardField, value: string) =>
    cards.update(list => list.map(card => (card.key === key ? { ...card, [field]: value } : card)));
  const keys = computed(() => cards().map(card => card.key));
  const readCard = (key: string) => {
    let last: Card | undefined;
    return computed(() => (last = cards().find(card => card.key === key) ?? last) as Card);
  };

  const save: ActionSpec = {
    id: 'categories:review-changes:page', label: c.review, kind: 'primary', primary: true, errorContext: 'draft-save',
    // Every field the service requires is checked here first, naming the category, so a person is never sent to
    // Details for a missing example (sweep AS-4).
    blockedBy: computed(() => missingFields(cards(), none())),
    run: async fb => {
      const list = untrack(cards).filter(card => card.name.trim() !== '');
      const ids = assignCategoryIds(list.map(card => ({ id: card.id, name: card.name.trim() })));
      const types = list.map((card, i) => ({
        id: ids[i], name: card.name.trim(), what: card.what.trim(), not_for: card.notFor.trim(),
        examples: card.examples.split('\n').map(line => line.trim()).filter(Boolean)
      }));
      const typeFile: TypeFile = { types, none_of_these: { name: none.peek().name.trim(), what: none.peek().what.trim() } };
      const displayNames = Object.fromEntries(types.map(type => [type.id, type.name]));
      const revision = await store.saveCategoryDraft({ baseRevisionId: defs.peek()?.active?.id ?? null, typeFile, displayNames });
      fb.done(c.saved);
      navigate(formatRoute({ view: 'category-review', revisionId: revision.id, fromRunId, correctionId }));
    }
  };

  // The draft becomes the next version when it is activated (versions count activations, oldest first).
  const eyebrow = computed(() => {
    const d = defs();
    if (d === null) return '';
    return d.active === null ? c.editingFirst : c.editingEyebrow(versionNumbers(d.history).size + 1);
  });
  const cancelHref = fromRunId === null ? formatRoute({ view: 'categories' }) : formatRoute(runViewRoute('improve', fromRunId));

  return h('section', { class: 'category-editor', testid: 'category-editor' },
    h('div', { class: 'cats-pagehead' },
      // Opened from a run (`from=`), this belongs to the run's optional Improve area.
      fromRunId === null ? null : h('p', { class: 'eyebrow' }, copy.improve.area.overline),
      h('p', { class: 'step-eyebrow' }, eyebrow),
      h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.editorTitle)),
      h('p', { class: 'lede' }, c.editorLead)),
    h('div', { class: 'stack-v cats-body' },
      show(computed(() => evidenceRun !== null && evidenceRun.plan().state === 'ready'), () => h('section', { class: 'panel cats-evidence', testid: 'trial-editor-evidence' },
        h('h2', { class: 'cats-h2' }, copy.trial.editorEvidence), h('p', { class: 'cats-muted' }, copy.trial.editorNote),
        trialEvidence(evidenceRun!, evidenceFingerprint!),
        h('a', { class: 'btn', attrs: { href: formatRoute({ view: 'results', runId: fromRunId!, q: '', show: 'all', cat: null, doc: evidenceFingerprint, limit: 100 }) } }, copy.trial.returnTrial))),

      show(computed(() => defs() !== null && !defs()!.canEdit), () => h('p', { class: 'cats-note' }, c.readOnly)),
      show(computed(() => suggestions().length > 0), () => h('section', { class: 'panel category-suggestions', testid: 'category-suggestions' },
        h('h2', { class: 'cats-h2' }, c.suggestedTitle),
        h('p', { class: 'cats-muted' }, c.suggestedLead),
        h('div', { class: 'cats-suggest-row' },
          each(computed(() => suggestions().map(type => type.folder)), folder => computed(() => folder), folder => {
            const name = folder.peek();
            const type = untrack(suggestions).find(item => item.folder === name)!;
            return action({
              id: `categories:add-suggested:${name}`, label: c.addSuggested(name), kind: 'secondary',
              run: async () => {
                cards.update(list => [...list, { ...cardOf(null), id: type.id, name: type.name }]);
                taken.update(set => new Set([...set, name]));
              }
            });
          })))),
      h('div', { class: 'stack-v category-cards', testid: 'category-cards' },
        each(keys, readCard, card => {
          const key = card.peek().key;
          return h('article', { class: 'panel category-card', testid: 'category-card' },
            h('div', { class: 'grid-2' },
              field(`${key}-name`, c.name, null, computed(() => card().name), value => setField(key, 'name', value), 'input'),
              h('div', { class: 'field' },
                h('span', { class: 'lab' }, c.folder),
                h('div', { class: 'mono cats-folder' }, computed(() => card().id ?? c.folderLater))),
              field(`${key}-what`, c.what, c.whatHint, computed(() => card().what), value => setField(key, 'what', value), 'textarea'),
              field(`${key}-not`, c.notFor, c.notForHint, computed(() => card().notFor), value => setField(key, 'notFor', value), 'textarea')),
            field(`${key}-ex`, c.examples, null, computed(() => card().examples), value => setField(key, 'examples', value), 'textarea'),
            h('div', { class: 'cats-remove' }, action({
              id: `categories:remove:${key}`, label: c.remove, kind: 'quiet',
              run: async () => { cards.update(list => list.filter(item => item.key !== key)); }
            })));
        })),
      action({ id: 'categories:add:page', label: c.add, kind: 'secondary', run: async () => { cards.update(list => [...list, cardOf(null)]); } }),
      h('fieldset', { class: 'panel category-none' },
        h('legend', { class: 'cats-legend-title' }, c.noneTitle),
        h('div', { class: 'grid-2' },
          field('none-name', c.noneName, null, computed(() => none().name), value => none.update(n => ({ ...n, name: value })), 'input'),
          field('none-what', c.noneWhat, null, computed(() => none().what), value => none.update(n => ({ ...n, what: value })), 'textarea'))),
      h('div', { class: 'cats-actions' },
        actionSlot(computed(() => save), { testid: 'category-editor-primary' }),
        h('a', { class: 'btn', attrs: { href: cancelHref } }, copy.common.cancel))));
}

/** What the service would refuse, as plain reasons naming the category (core/config/project.ts validateTypeFile). */
function missingFields(cards: readonly Card[], none: { name: string; what: string }): Phrase[] {
  const reasons: Phrase[] = [];
  const blank = (card: Card) => [card.name, card.what, card.notFor, card.examples].every(text => text.trim() === '');
  const used = cards.filter(card => !blank(card));
  if (used.every(card => card.name.trim() === '')) return [{ key: 'categories.needOne' }];
  const seen = new Set<string>();
  for (const card of used) {
    const name = card.name.trim();
    if (name === '') { reasons.push({ key: 'categories.needName' }); continue; }
    const key = name.toLocaleLowerCase('en');
    if (seen.has(key)) reasons.push({ key: 'categories.needDistinct', args: { name } });
    seen.add(key);
    if (card.what.trim() === '') reasons.push({ key: 'categories.needWhat', args: { name } });
    if (card.notFor.trim() === '') reasons.push({ key: 'categories.needNotFor', args: { name } });
    if (!card.examples.split('\n').some(line => line.trim() !== '')) reasons.push({ key: 'categories.needExample', args: { name } });
  }
  if (none.name.trim() === '' || none.what.trim() === '') reasons.push({ key: 'categories.needNone' });
  return reasons;
}

function field(id: string, label: string, hint: string | null, value: () => string, onInput: (value: string) => void,
  kind: 'input' | 'textarea'): HTMLElement {
  const input = kind === 'input'
    ? h('input', { class: 'ti', attrs: { id, type: 'text', 'aria-describedby': hint === null ? null : `${id}-hint` },
      props: { value: computed(value) }, on: { input: event => onInput((event.target as HTMLInputElement).value) } })
    : h('textarea', { class: 'ta', attrs: { id, rows: 3, 'aria-describedby': hint === null ? null : `${id}-hint` },
      props: { value: computed(value) }, on: { input: event => onInput((event.target as HTMLTextAreaElement).value) } });
  return h('div', { class: 'field' },
    h('label', { attrs: { for: id } }, label),
    input,
    hint === null ? null : h('p', { class: 'cats-hint', attrs: { id: `${id}-hint` } }, hint));
}
