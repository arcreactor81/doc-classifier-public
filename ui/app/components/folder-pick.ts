/**
 * FolderPick (SPEC §7.1; REG 15): one folder the app needs, explained before the browser's dialog opens.
 *
 * - The purpose (`originals`, `copies`, `reviewed`) and a plain explanation come first; then what is chosen and the
 *   browser's permission for it (`granted` / needs asking / `denied`).
 * - A remembered folder is an offer ("Use 'Archive 2026' again"), never used without a click.
 * - Both buttons are ActionBlocks (view/action.ts): a permission problem appears in that button's own slot, with the
 *   next step. The folder work itself belongs to the caller's controller, reached through `onUseRemembered` and
 *   `onChoose`: this component touches no handle, storage or picker (SPEC §4.1 L1, §5.5 rule 10).
 */
import './folder-pick.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import type { Phrase } from '../../../core/ui/journey.ts';
import type { ErrorContext } from '../../../core/ui/error-copy.ts';
import { action, type Feedback } from '../view/action.ts';
import { h, match, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';

type R<T> = T | Read<T>;
export type FolderPurpose = 'originals' | 'copies' | 'reviewed';
export type FolderPermission = 'granted' | 'prompt' | 'denied';

export type FolderPickState =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'waiting' }
  | { kind: 'chosen'; name: string; permission: FolderPermission };

export interface FolderPickSpec {
  /** Operation id base, `area:verb:entity` (e.g. `build:originals:<runId>`); the two buttons add `-use` and `-choose`. */
  id: string;
  purpose: FolderPurpose;
  /** Why this folder is needed and what the browser will ask; shown before the dialog opens. */
  explanation: R<string>;
  state: Read<FolderPickState>;
  /** A folder this browser remembers for this purpose, offered but never used without a click. */
  remembered: Read<{ name: string } | null>;
  useLabel: (name: string) => string;
  chooseLabel: R<string>;
  /** Non-null while a controller is busy (the buttons are then disabled, with this reason in their slots). */
  busy?: Read<Phrase | readonly Phrase[] | null>;
  primary?: boolean;
  /** The context a thrown error is presented in (default 'build'; Review passes 'walk'). */
  errorContext?: ErrorContext;
  onUseRemembered(fb: Feedback, signal: AbortSignal): Promise<void>;
  onChoose(fb: Feedback, signal: AbortSignal): Promise<void>;
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

function operationId(base: string, suffix: string): string {
  const at = base.indexOf(':', base.indexOf(':') + 1);
  return at < 0 ? `${base}-${suffix}` : `${base.slice(0, at)}-${suffix}${base.slice(at)}`;
}

export function folderStatusText(state: FolderPickState): string {
  const words = activeUiCopy.common.folder;
  switch (state.kind) {
    case 'none': return words.notChosen;
    case 'checking': return words.checking;
    case 'waiting': return words.waiting;
    case 'chosen': return words.chosen(state.name);
  }
}

export function folderPick(spec: FolderPickSpec): HTMLElement {
  const words = activeUiCopy.common.folder;
  const permission = computed(() => {
    const state = spec.state();
    if (state.kind !== 'chosen') return null;
    return state.permission === 'granted' ? words.granted : state.permission === 'prompt' ? words.prompt : words.denied;
  });
  const offer = computed(() => spec.remembered()?.name ?? null);
  // With `primary`, the offer is the view's one filled button ([data-primary], SPEC §8.2); without an offer, "Choose"
  // is. The remembered folder is read asynchronously, so the choose button is rebuilt when the offer comes or goes
  // (its operation state lives in the operations store, so a rebuilt button shows the same slot).
  const chooseIsPrimary = computed(() => spec.primary === true && offer() === null);
  const chooseAction = (asPrimary: boolean) => action({
    id: operationId(spec.id, 'choose'),
    label: typeof spec.chooseLabel === 'string' ? spec.chooseLabel : computed(() => read(spec.chooseLabel)),
    kind: asPrimary ? 'primary' : 'secondary',
    primary: asPrimary,
    ...(spec.busy ? { blockedBy: spec.busy } : {}),
    errorContext: spec.errorContext ?? 'build',
    run: (fb, signal) => spec.onChoose(fb, signal)
  });
  return h('section', {
    class: 'folder-pick',
    attrs: { 'data-purpose': spec.purpose, 'data-state': computed(() => spec.state().kind) },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  h('p', { class: 'folder-pick__explain' }, typeof spec.explanation === 'string' ? spec.explanation : computed(() => read(spec.explanation))),
  h('p', { class: 'folder-pick__status' },
    glyph('folder', { class: 'folder-pick__glyph' }),
    h('span', { class: 'folder-pick__name' }, computed(() => folderStatusText(spec.state())))),
  show(computed(() => permission() !== null), () => h('p', { class: 'folder-pick__permission' }, computed(() => permission() ?? ''))),
  h('div', { class: 'folder-pick__actions' },
    show(computed(() => offer() !== null), () => action({
      id: operationId(spec.id, 'use'),
      label: computed(() => spec.useLabel(offer() ?? '')),
      kind: spec.primary ? 'primary' : 'secondary',
      primary: spec.primary === true,
      ...(spec.busy ? { blockedBy: spec.busy } : {}),
      errorContext: spec.errorContext ?? 'build',
      run: (fb, signal) => spec.onUseRemembered(fb, signal)
    })),
    match(computed(() => (chooseIsPrimary() ? 'primary' : 'secondary')), {
      primary: () => chooseAction(true),
      secondary: () => chooseAction(false)
    })));
}
