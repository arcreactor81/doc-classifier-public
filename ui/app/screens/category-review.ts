/**
 * Category review (SPEC §2.3, walkthrough 3c; journey step 9 with `from=`): what the draft changes compared with the
 * active categories (core/ui/category-changes.ts), the draft's categories, and the one decision to use them. A change
 * of meaning starts filing again at 90% certainty; keeping the current filing certainty is an explicit choice (a
 * tick), never a default. Activation applies to new runs only. Before any categories are active there is nothing to
 * compare with, and only the draft's categories are shown.
 *
 * Laid out as the artifact's review: an eyebrow naming the draft's version, a lede counting the changed categories,
 * then one panel per category with its changes in place (added words highlighted, removed words struck through, each
 * also named for assistive technology), unchanged categories marked so, then the filing-certainty choice and the
 * activate button beside "Back to editing".
 */
import { computed, signal, untrack } from '../../../core/ui/reactive.ts';
import { formatRoute, runViewRoute } from '../../../core/ui/routes.ts';
import { categoryName, categoryNames } from '../../../core/ui/result-presenter.ts';
import { categoryChanges, type CategoryChange, type CategoryChanges, type FieldChange } from '../../../core/ui/category-changes.ts';
import { versionNumbers } from '../../../core/ui/run-naming.ts';
import type { RevisionView } from '../../../core/ui/wire.ts';
import type { Segment } from '../../../core/ui/definition-diff.ts';
import { phraseText } from '../../../core/ui/journey.ts';
import type { UiCopy } from '../../../core/ui/project-copy.ts';
import { h, show } from '../view/dom.ts';
import type { ActionSpec } from '../view/action.ts';
import { navigate } from '../router.ts';
import { actionSlot } from '../components/action-slot.ts';
import { definitionCard } from '../components/definition-card.ts';
import { words } from '../components/words.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import './categories.css';

/** Added words highlighted, removed words struck through, each also named for assistive technology. */
function segmentsOf(segments: readonly Segment[], c: UiCopy['categories']): (Node | string)[] {
  return segments.map(segment => segment.kind === 'same' ? segment.text
    : h(segment.kind === 'added' ? 'ins' : 'del', null,
      h('span', { class: 'visually-hidden' }, segment.kind === 'added' ? c.statusAdded : c.statusRemoved, ' '), segment.text));
}

function fieldText(field: FieldChange, c: UiCopy['categories']): Node {
  return field.lines
    ? h('ul', { class: 'change__lines' }, field.segments.map(segment => h('li', null, segmentsOf([segment], c))))
    : h('span', null, segmentsOf(field.segments, c));
}

type TypeOf = RevisionView['typeFile']['types'][number];

/** One category of the draft as a panel: its name and fields, each changed one shown with its changes in place. */
function categoryPanel(type: TypeOf | null, name: string, change: CategoryChange | null, copy: UiCopy): HTMLElement {
  const c = copy.categories, d = copy.common.definition;
  const changed = (field: FieldChange['field']) => change?.fields.find(item => item.field === field) ?? null;
  const row = (label: string, plain: string | null, field: FieldChange | null) => field === null && plain === null ? null
    : h('div', null, h('dt', null, label), h('dd', null, field === null ? plain : fieldText(field, c)));
  const status = change === null ? c.unchanged : change.status === 'added' ? c.statusAdded : c.statusRemoved;
  const nameField = changed('name');
  const shown = changed('displayName');
  return h('article', { class: 'panel change', attrs: { 'data-change': change?.status ?? 'unchanged', 'data-type-id': change?.id ?? type?.id ?? null } },
    h('h3', { class: 'change__name' },
      change?.status === 'removed' ? h('del', null, name) : nameField === null ? name : fieldText(nameField, c),
      change?.status === 'changed' ? null : [' ', h('span', { class: 'change__status' }, '· ', status)]),
    type === null ? null : h('dl', { class: 'change__fields' },
      shown === null ? null : row(phraseText(shown.label, copy), null, shown),
      row(d.what, type.what, changed('what')),
      row(d.notFor, type.not_for, changed('not_for')),
      row(d.examples, null, changed('examples'))));
}

function changesList(draft: RevisionView, changes: CategoryChanges, copy: UiCopy): Node {
  const c = copy.categories;
  const names = categoryNames(draft.typeFile, draft.displayNames);
  const byId = new Map(changes.categories.map(change => [change.id, change]));
  const removed = changes.categories.filter(change => change.status === 'removed');
  const none = draft.typeFile.none_of_these;
  return h('div', { class: 'stack-v diff', testid: 'category-review-cards' },
    changes.reordered ? h('p', { class: 'cats-note' }, c.reordered) : null,
    draft.typeFile.types.map(type => categoryPanel(type, categoryName(type.id, names), byId.get(type.id) ?? null, copy)),
    removed.map(change => categoryPanel(null, change.name, change, copy)),
    changes.noneOfThese.length === 0 ? null : h('article', { class: 'panel change', attrs: { 'data-change': 'changed' } },
      h('h3', { class: 'change__name' }, c.noneTitle),
      h('dl', { class: 'change__fields' }, changes.noneOfThese.map(field =>
        h('div', null, h('dt', null, phraseText(field.label, copy)), h('dd', null, fieldText(field, c)))),
      changes.noneOfThese.some(field => field.field === 'what') ? null
        : h('div', null, h('dt', null, c.noneWhat), h('dd', null, none.what)))));
}

export function categoryReviewScreen(ctx: ViewContext<RouteOf<'category-review'>>): Node {
  const copy = ctx.copy, c = copy.categories;
  const store = ctx.store;
  const { revisionId, fromRunId, correctionId } = ctx.route.peek();
  void store.loadDefinitions();
  const defs = computed(() => { const d = store.definitions(); return d.state === 'ready' ? d.value : null; });
  const draft = computed(() => defs()?.drafts.find(revision => revision.id === revisionId) ?? null);
  // Whether these are the first categories, as when the page opened (activating them must not change the page).
  let firstAtOpen: boolean | null = null;
  const first = computed(() => { const d = defs(); if (d !== null && firstAtOpen === null) firstAtOpen = d.active === null; return firstAtOpen === true; });
  // Null before any categories are active: there is nothing to compare with.
  const changes = computed(() => { const d = draft(); return d === null ? null : categoryChanges(defs()?.active ?? null, d); });
  const stale = computed(() => { const d = draft(), a = defs()?.active ?? null; return d !== null && (d.baseRevisionId ?? null) !== (a?.id ?? null); });
  const inherit = signal(false);
  // Once activated, the same slot offers the next step, carrying "These categories are now in use…" (sweep LOOP-5):
  // adding documents from the setup path (owner, 6 October 2026: nothing else told them where to go), the answers from a run.
  const activated = signal(false);
  // The version this draft becomes, fixed when the page opens (activating it must not renumber the heading).
  let version: number | null = null;
  const eyebrow = computed(() => {
    const d = defs();
    if (d === null) return '';
    if (version === null) version = d.active === null ? 0 : versionNumbers(d.history).size + 1;
    return version === 0 ? c.reviewFirst : c.reviewEyebrow(version);
  });

  const primary = computed<ActionSpec | null>(() => {
    if (activated()) {
      const href = fromRunId === null ? formatRoute({ view: 'new', fromRunId: null }) : formatRoute(runViewRoute('improve', fromRunId));
      return {
        id: `categories:after-activate:${revisionId}`, label: fromRunId === null ? c.nextDocuments : c.nextAnswers,
        kind: 'primary', primary: true, run: async () => { navigate(href); }
      };
    }
    return draft() === null ? null : {
      id: `categories:activate:${revisionId}`, label: first() ? c.startUsing : c.activate, kind: 'primary', primary: true,
      errorContext: 'activate',
      blockedBy: computed(() => (stale() ? { key: 'categories.stale' } : null)),
      run: async fb => {
        await store.activateRevision(revisionId, { inheritThreshold: untrack(inherit), fromRunId });
        fb.done(c.activated);
        activated.set(true);
      }
    };
  }, { equals: (a, b) => (a?.id ?? null) === (b?.id ?? null) && a?.label === b?.label });

  // The draft as shown when the page opened: activating it removes it from the drafts, and the page stays put.
  let shownDraft: RevisionView | null = null, shownChanges: CategoryChanges | null = null;
  const held = computed(() => { const d = draft(); if (d !== null) { shownDraft = d; shownChanges = changes(); } return shownDraft; });

  return h('section', { class: 'category-review', testid: 'category-review' },
    h('div', { class: 'cats-pagehead' },
      // Opened from a run (`from=`), this belongs to the run's optional Improve area.
      fromRunId === null ? null : h('p', { class: 'eyebrow' }, copy.improve.area.overline),
      h('p', { class: 'step-eyebrow' }, eyebrow),
      h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.reviewTitle)),
      h('p', { class: 'lede' }, computed(() => {
        const x = held() === null ? null : shownChanges;
        if (x === null) return c.reviewLead;
        if (x.same) return c.noChanges;
        return '';
      }), show(computed(() => held() !== null && shownChanges !== null && !shownChanges.same), () => {
        const n = shownChanges!.categories.length + (shownChanges!.noneOfThese.length > 0 ? 1 : 0);
        return h('span', null, n > 0 ? [c.changedCount(n), ' '] : null, c.highlightBefore, ' ', h('span', { class: 'mark' }, c.highlightWord), c.highlightAfter);
      }))),
    h('div', { class: 'stack-v cats-body' },
      show(computed(() => defs() !== null && held() === null && !activated()), () => h('p', { class: 'cats-note' }, c.notFound)),
      show(computed(() => held() !== null), () => {
        const revision = shownDraft!;
        if (shownChanges !== null) return changesList(revision, shownChanges, copy);
        const names = categoryNames(revision.typeFile, revision.displayNames);
        return h('div', { class: 'cats', testid: 'category-review-cards' }, revision.typeFile.types.map(type =>
          definitionCard({ type, displayName: categoryName(type.id, names), heading: 'h3', examplesOpen: true, class: 'panel cat' })));
      }),
      show(computed(() => held() !== null && !first()), () => h('div', { class: 'panel cats-certainty' },
        // A change to website names only keeps the current filing certainty (definitionChange, cosmetic).
        show(computed(() => shownChanges?.resetsCertainty === true), () => h('p', null, c.certaintyReset), () => h('p', null, c.certaintyKept)),
        h('label', { class: 'check', attrs: { for: 'category-inherit' } },
          h('input', { attrs: { type: 'checkbox', id: 'category-inherit' }, props: { checked: inherit },
            on: { change: event => inherit.set((event.target as HTMLInputElement).checked) } }),
          h('span', null, c.keepCertainty)),
        h('p', { class: 'cats-hint' }, c.keepCertaintyHint))),
      h('div', { class: 'cats-actions' },
        actionSlot(primary, { testid: 'category-review-primary' }),
        h('a', { class: 'btn', attrs: { href: formatRoute({ view: 'category-edit', fromRunId, correctionId }) } }, c.backToEditing))));
}
