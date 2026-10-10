/**
 * The browser gate (SPEC §6.4 `browserSupported`; §6.5 `browserGate`). It applies to the local steps only — reading
 * files, confirming a run from this computer's files, making folders and reading the reviewed folders — because
 * those need Chrome or Edge's folder access. Viewing runs and results works in any browser, so every other view is
 * shown as usual. No request is sent from here.
 */
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { browserSupported } from '../../../core/extraction/policy.ts';
import { h } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { words } from '../components/words.ts';
import type { ScreenId } from './view-context.ts';
import './gates.css';

/** The screens whose job needs the folder picker or this browser's files. */
export const LOCAL_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['files', 'confirm', 'build', 'review']);

/** Chrome or Edge on a desktop, with the File System Access folder picker (read once: it does not change). */
export function localStepsSupported(): boolean {
  return browserSupported(navigator.userAgent, 'showDirectoryPicker' in window);
}

export function browserGate(): HTMLElement {
  const copy = activeUiCopy;
  return h('section', { class: 'gate gate--browser pane', testid: 'shell-browser-gate' },
    h('div', { class: 'stage__head' },
      h('h1', { attrs: { tabindex: -1 } }, words(copy.browser)),
      h('p', { class: 'lead' }, copy.browserReason)),
    h('p', { class: 'body-text' }, copy.shell.browserGate.viewing),
    h('p', { class: 'quiet-links' },
      h('a', { class: 'link-arrow', attrs: { href: '#/' } }, copy.journey.action.goHome, glyph('arrow-right')),
      h('a', { class: 'link-arrow', attrs: { href: '#/help' } }, copy.shell.browserGate.help, glyph('arrow-right'))));
}
