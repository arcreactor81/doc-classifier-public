/**
 * The browser tab's title for each screen (go/no-go review, 10 October 2026): "Results · Run 7 — Document classifier".
 * The screen's own name comes from the words the app already shows for it (its link, step label or heading), then the
 * run or draft it belongs to once that is named, then the product name the project pack defines. An address on its way
 * to its screen (`#/new`, `#/run/<id>`) shows the product name alone. Pure: no DOM.
 */
import type { UiCopy } from './project-copy.ts';
import type { RouteView } from './routes.ts';

function screenName(copy: UiCopy, view: RouteView): string | null {
  switch (view) {
    case 'home': return copy.nav.home;
    case 'runs': return copy.nav.runs;
    case 'new': case 'draft': case 'run': return null;
    case 'files': return copy.journey.steps.read.label;
    case 'confirm': return copy.journey.steps.confirm.label;
    case 'progress': return copy.shell.title.progress;
    case 'results': return copy.journey.steps.results.label;
    case 'build': return copy.nav.build;
    case 'review': return copy.nav.correct;
    case 'improve': return copy.improve.area.title;
    case 'compare': return copy.compare.title;
    case 'categories': return copy.categories.title;
    case 'category-edit': return copy.categories.editorTitle;
    case 'category-review': return copy.categories.reviewTitle;
    case 'system': return copy.nav.health;
    case 'help': return copy.help.overline;
    case 'unknown': return copy.shell.fallback.title;
  }
}

export function pageTitle(copy: UiCopy, view: RouteView, subjectName: string | null): string {
  const screen = screenName(copy, view);
  if (screen === null) return copy.product;
  return subjectName === null ? copy.shell.title.page(screen, copy.product) : copy.shell.title.run(screen, subjectName, copy.product);
}
