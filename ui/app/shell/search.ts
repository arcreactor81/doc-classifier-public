/**
 * Search (the "/" palette): jump to a page, a run, or start a new run. It lists what this tab already knows (the run
 * list the store holds); it reads nothing and sends nothing. Arrow keys move, Enter opens, Escape closes; focus
 * returns to where it was.
 */
import { computed, root, signal, type Dispose } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { each, h } from '../view/dom.ts';
import { navigate } from '../router.ts';
import type { AppStore } from '../state/types.ts';
import { runDisplayName } from './run-names.ts';

interface Item { key: string; label: string; hint: string; href: string }

let open: Dispose | null = null;

function items(store: AppStore): Item[] {
  const copy = activeUiCopy.shell.search;
  const pages: Item[] = [
    { key: 'new', label: copy.newRun, hint: copy.action, href: formatRoute({ view: 'new', fromRunId: null }) },
    { key: 'home', label: activeUiCopy.nav.home, hint: copy.page, href: '#/' },
    { key: 'runs', label: activeUiCopy.nav.runs, hint: copy.page, href: '#/runs' },
    { key: 'categories', label: activeUiCopy.nav.categories, hint: copy.page, href: '#/categories' },
    { key: 'help', label: activeUiCopy.nav.help, hint: copy.page, href: '#/help' },
    { key: 'system', label: activeUiCopy.nav.health, hint: copy.page, href: '#/system' }
  ];
  const list = store.runList.peek();
  const runs = list.state === 'ready' ? list.value : list.state !== 'idle' && 'previous' in list && list.previous ? list.previous : [];
  return [...pages, ...runs.map(run => ({
    key: `run:${run.id}`, label: runDisplayName(store, run.id) ?? activeUiCopy.shell.newRun, hint: copy.run,
    href: formatRoute({ view: 'run', runId: run.id })
  }))];
}

export function openSearch(store: AppStore): void {
  if (open !== null) return;
  const copy = activeUiCopy.shell.search;
  const before = document.activeElement as HTMLElement | null;
  const all = items(store);
  root(dispose => {
    const query = signal('');
    const active = signal(0);
    const shown = computed(() => {
      const q = query().trim().toLowerCase();
      return all.filter(item => q === '' || item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q));
    });
    const keys = computed(() => shown().map(item => item.key));
    const close = () => {
      if (open === null) return;
      open = null;
      backdrop.remove();
      dispose();
      before?.focus?.();
    };
    const go = (item: Item | undefined) => { if (!item) return; close(); navigate(item.href); };
    const input = h('input', {
      attrs: { type: 'search', 'aria-label': copy.label, placeholder: copy.placeholder, autocomplete: 'off', 'aria-controls': 'search-list' },
      on: {
        input: event => { query.set((event.target as HTMLInputElement).value); active.set(0); },
        keydown: event => {
          const list = shown();
          if (event.key === 'ArrowDown') { event.preventDefault(); active.set(Math.min(list.length - 1, active.peek() + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); active.set(Math.max(0, active.peek() - 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); go(list[active.peek()]); }
          else if (event.key === 'Escape') { event.preventDefault(); close(); }
        }
      }
    });
    const backdrop = h('div', {
      class: 'modal-bg', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': copy.label }, testid: 'search',
      on: { pointerdown: event => { if (event.target === backdrop) close(); } }
    },
    h('div', { class: 'cmdk' },
      input,
      h('ul', { attrs: { id: 'search-list', role: 'listbox' } },
        each(keys, key => { const item = all.find(entry => entry.key === key); return item ? computed(() => item) : undefined; }, (item, key) =>
          // ui-rules: non-operational button: moves to a page or run, sends nothing.
          h('li', null, h('button', {
            attrs: { type: 'button', role: 'option', 'aria-selected': computed(() => (keys()[active()] === key ? 'true' : 'false')) },
            classes: { on: computed(() => keys()[active()] === key) },
            on: { click: () => go(item.peek()), pointermove: () => active.set(keys.peek().indexOf(key)) }
          }, h('span', null, item.peek().label), h('small', null, item.peek().hint))))),
      // Nothing matches: say so, and what Search looks through, rather than show an empty list.
      h('p', { class: 'cmdk__empty', attrs: { role: 'status' }, testid: 'search-no-match' },
        computed(() => (shown().length === 0 ? copy.noMatch(query().trim()) : '')))));
    document.body.append(backdrop);
    open = close;
    input.focus();
    return undefined;
  });
}

/** "/" opens Search anywhere except while typing. */
export function installSearchKey(store: AppStore): void {
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    openSearch(store);
  });
}
