/**
 * The screen registry (SPEC §2.3, §6.1): every screen StageHost can mount, imported statically, with the route it is
 * mounted for and its stage width (SPEC §2.7). Phase-5 packages replace the bodies of their screen files and never
 * edit this file: the names and signatures below are the contract.
 *
 * Which screen a route shows (Welcome or Home, the gates, the Fallback) is decided by shell/stage-host.ts.
 */
import type { Route } from '../../../core/ui/routes.ts';
import type { RouteOf, ScreenId, View } from '../shell/view-context.ts';
import { welcomeScreen } from './welcome.ts';
import { homeScreen } from './home.ts';
import { runsScreen } from './runs.ts';
import { filesScreen } from './files.ts';
import { confirmScreen } from './confirm.ts';
import { progressScreen } from './progress.ts';
import { resultsScreen } from './results.ts';
import { buildScreen } from './build.ts';
import { reviewScreen } from './review.ts';
import { improveScreen, compareScreen } from './improve.ts';
import { categoriesScreen } from './categories.ts';
import { categoryEditorScreen } from './category-editor.ts';
import { categoryReviewScreen } from './category-review.ts';
import { systemScreen } from './system.ts';
import { helpScreen } from './help.ts';
import { fallbackScreen } from './fallback.ts';

/** The route each screen is mounted for. */
export interface ScreenRoutes {
  welcome: RouteOf<'home'>;
  home: RouteOf<'home'>;
  runs: RouteOf<'runs'>;
  files: RouteOf<'files'>;
  confirm: RouteOf<'confirm'>;
  progress: RouteOf<'progress'>;
  results: RouteOf<'results'>;
  build: RouteOf<'build'>;
  review: RouteOf<'review'>;
  improve: RouteOf<'improve'>;
  compare: RouteOf<'compare'>;
  categories: RouteOf<'categories'>;
  'category-editor': RouteOf<'category-edit'>;
  'category-review': RouteOf<'category-review'>;
  system: RouteOf<'system'>;
  help: RouteOf<'help'>;
  fallback: Route;
}

export const SCREENS: { readonly [K in ScreenId]: View<ScreenRoutes[K]> } = {
  welcome: welcomeScreen,
  home: homeScreen,
  runs: runsScreen,
  files: filesScreen,
  confirm: confirmScreen,
  progress: progressScreen,
  results: resultsScreen,
  build: buildScreen,
  review: reviewScreen,
  improve: improveScreen,
  compare: compareScreen,
  categories: categoriesScreen,
  'category-editor': categoryEditorScreen,
  'category-review': categoryReviewScreen,
  system: systemScreen,
  help: helpScreen,
  fallback: fallbackScreen
};

/** SPEC §2.7: narrow (760 px) or wide (1180 px). Screens the table does not list are wide, the gates narrow. */
export const SCREEN_WIDTH: Readonly<Record<ScreenId, 'narrow' | 'wide'>> = {
  welcome: 'wide', home: 'wide', runs: 'wide', files: 'narrow', confirm: 'narrow', progress: 'wide', results: 'wide',
  build: 'narrow', review: 'wide', improve: 'wide', compare: 'wide', categories: 'wide', 'category-editor': 'wide',
  'category-review': 'narrow', system: 'narrow', help: 'wide', fallback: 'narrow'
};

/**
 * The screen for a route that has one screen. `home` is Home or Welcome, decided with the facts (stage-host.ts);
 * `new`, `run` and `draft` are subjects on their way to their view (the router resolves them); `unknown` is the
 * Fallback.
 */
export function screenOfRoute(route: Route): ScreenId | 'home-or-welcome' | 'subject' {
  switch (route.view) {
    case 'home': return 'home-or-welcome';
    case 'new':
    case 'run':
    case 'draft':
      return 'subject';
    case 'category-edit': return 'category-editor';
    case 'unknown': return 'fallback';
    default: return route.view;
  }
}
