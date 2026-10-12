/**
 * Entry point of the rebuilt UI (SPEC §6.1; walkthrough 3a step 1).
 *
 * Boot, in order:
 * 1. Create the AppStore with the route parsed from the address.
 * 2. Read Health once (R1; it is never polled). When the project names a product, apply its copy before anything is
 *    mounted (`configureProjectCopy`; health-view.ts `copyConfig` is null otherwise).
 * 3. Configure `action()` (view/action.ts): the operations store, error presentation, phrases, the slot words and the
 *    ConfirmSheet that actions with `confirm` open.
 * 4. Give the router the journey resolver for `#/run/<id>` and `#/new/<localId>` (shell/journey-facts.ts).
 * 5. Boot recovery (state/boot.ts): repair this browser's draft ↔ run links, then list the local drafts. The link
 *    repair runs before the router so that `#/new` and `#/run/<id>` see the repaired links. Nothing is sent.
 * 6. Start the router: legacy hashes and the `/health` and `How It Works.html` paths are replaced by their canonical
 *    hashes (no history entry).
 * 7. Mount the shell once (shell/app-shell.ts); StageHost mounts one view per route shape inside it.
 */
import '@fontsource-variable/bricolage-grotesque/wdth.css';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import './styles/tokens.css';
import './styles/motion.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/site.css';
import './styles/shell.css';
import { activeUiCopy, configureProjectCopy } from '../../core/ui/project-copy.ts';
import { presentError } from '../../core/ui/error-copy.ts';
import { phraseText, type Phrase } from '../../core/ui/journey.ts';
import { parseRoute } from '../../core/ui/routes.ts';
import { time } from '../../core/ui/format.ts';
import { configureActions } from './view/action.ts';
import { h, mount } from './view/dom.ts';
import { endpoints } from './api/endpoints.ts';
import { isLatest } from './api/client.ts';
import { forgetMotionPref, readViewState, writeViewState } from './persist/local-keys.ts';
import { createAppStore } from './state/app-store.ts';
import { bootRecovery } from './state/boot.ts';
import { documentVisibility } from './state/poller.ts';
import type { AppStore } from './state/types.ts';
import { configureRouteResolver, startRouter } from './router.ts';
import { LOCK_NAMES, lockState } from './controllers/locks.ts';
import { createRegistry } from './controllers/registry.ts';
import { registerControllers } from './controllers/index.ts';
import { openConfirmSheet } from './components/confirm-sheet.ts';
import { appShell } from './shell/app-shell.ts';
import { bootScreen, installRipple } from './shell/sorting-room.ts';
import { installSearchKey } from './shell/search.ts';
import { subjectResolver } from './shell/journey-facts.ts';

function configureSlots(store: AppStore): void {
  const common = activeUiCopy.common;
  configureActions({
    operations: store.operations,
    presentError: (error, context) => presentError(error, context),
    phrase: (phrase: Phrase) => phraseText(phrase, activeUiCopy),
    copy: { whyUnavailable: common.whyUnavailable, at: common.at, stillWorking: common.stillWorking, details: activeUiCopy.details },
    time,
    confirmSheet: openConfirmSheet
  });
}

/** A boot that failed before anything could mount: the heading and the problem, with its Details. */
function mountBootFailure(host: HTMLElement, error: unknown): void {
  const shown = presentError(error, 'generic');
  mount(host, () => h('main', { attrs: { id: 'main', tabindex: -1 } },
    h('h1', null, activeUiCopy.product),
    h('p', { testid: 'boot-problem' }, shown.headline),
    h('details', { attrs: { 'data-technical': true } },
      h('summary', null, activeUiCopy.details),
      h('pre', null, JSON.stringify({ code: shown.code, kind: shown.kind, ...shown.technical }, null, 2)))));
}

async function boot(host: HTMLElement): Promise<void> {
  // Motion always runs (DECISIONS 155 addendum): an old Motion switch's stored "off" is removed, never read.
  forgetMotionPref();
  const loader = bootScreen();
  document.body.append(loader.el);
  loader.step(.2, activeUiCopy.shell.boot.checking);
  const initial = parseRoute(location.hash, location.pathname);
  const store = createAppStore({
    api: endpoints,
    isLatest,
    now: () => Date.now(),
    visibility: documentVisibility(),
    sendLock: runId => lockState(LOCK_NAMES.send(runId)),
    newId: () => crypto.randomUUID()
  }, initial.route);

  const health = await store.loadHealth();
  if (health?.copyConfig) {
    try {
      configureProjectCopy(health.copyConfig);
    } catch (error) {
      store.addNote({ code: 'project-copy', runId: null, localId: null, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  document.title = activeUiCopy.product;
  loader.step(.6, activeUiCopy.shell.boot.loading);
  configureSlots(store);
  configureRouteResolver(subjectResolver());
  const controllers = createRegistry(store);
  registerControllers(controllers);
  const recovery = bootRecovery(store);
  startRouter(store);
  mount(host, () => appShell(store, { controllers, viewState: { read: readViewState, write: writeViewState } }));
  installRipple();
  installSearchKey(store);
  loader.step(1, activeUiCopy.shell.boot.ready);
  loader.finish();
  await recovery.done;
}

const host = document.getElementById('app');
if (!host) throw new Error('index.html has no #app container.');
boot(host).catch(error => mountBootFailure(host, error));
