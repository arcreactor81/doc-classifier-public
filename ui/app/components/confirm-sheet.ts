/**
 * ConfirmSheet (SPEC §7.1, §8.4 M15): the confirmation before an irreversible or global action. Used only for: delete
 * uploaded text, discard a run, stop all runs, allow new runs, forget a new run, retry in a new run.
 *
 * `openConfirmSheet(spec, trigger)` is the `confirmSheet` of view/action.ts's configureActions (main.ts wires it):
 * the action whose spec has `confirm` opens the sheet, and runs only when this resolves true. The outcome then goes to
 * that action's own slot, never to the sheet (REG 11).
 *
 * - A native modal `<dialog>` (showModal) on the scrim, plus a11y.trapFocus; Esc and Cancel close it (false).
 * - With a checkbox, the confirm button stays disabled until it is ticked.
 * - Focus goes to the checkbox, or else to Cancel, and returns to the trigger when the sheet closes.
 * - One sheet at a time: opening a second one while one is open resolves false at once.
 */
import './confirm-sheet.css';
import { computed, root, signal } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import type { ConfirmSheetSpec } from '../view/action.ts';
import { h } from '../view/dom.ts';
import { restoreFocus, trapFocus } from '../view/a11y.ts';

let openSheet: HTMLDialogElement | null = null;
let sheetCount = 0;

export function openConfirmSheet(spec: ConfirmSheetSpec, trigger: HTMLButtonElement): Promise<boolean> {
  if (openSheet !== null) return Promise.resolve(false);
  const n = ++sheetCount;
  const titleId = `confirm-sheet-${n}-title`, bodyId = `confirm-sheet-${n}-body`, checkId = `confirm-sheet-${n}-check`;
  return new Promise<boolean>(resolve => {
    root(dispose => {
      const needsTick = spec.checkbox !== undefined && spec.checkbox !== null && spec.checkbox !== '';
      const ticked = signal(!needsTick);
      let finished = false;
      let untrap: (() => void) | null = null;
      const finish = (confirmed: boolean) => {
        if (finished) return;
        finished = true;
        untrap?.();
        if (dialog.open) dialog.close();
        dialog.remove();
        openSheet = null;
        dispose();
        restoreFocus(trigger);
        resolve(confirmed);
      };
      const checkbox: HTMLInputElement | null = needsTick
        ? h('input', { attrs: { type: 'checkbox', id: checkId }, on: { change: event => ticked.set((event.target as HTMLInputElement).checked) } })
        : null;
      const cancel = h('button', { class: 'btn btn--secondary', attrs: { type: 'button', 'data-sheet': 'cancel' }, on: { click: () => finish(false) } },
        activeUiCopy.common.cancel);
      const confirm = h('button', {
        class: 'btn btn--primary', attrs: { type: 'button', 'data-sheet': 'confirm' },
        props: { disabled: computed(() => !ticked()) },
        on: { click: () => { if (ticked.peek()) finish(true); } }
      }, spec.confirmLabel);
      const dialog = h('dialog', {
        class: 'sheet',
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId },
        on: { cancel: event => { event.preventDefault(); finish(false); } }
      },
      h('div', { class: 'sheet__in' },
        h('h2', { attrs: { id: titleId } }, spec.title),
        h('div', { class: 'sheet__body', attrs: { id: bodyId } }, spec.lines.map(line => h('p', null, line))),
        checkbox === null ? null : h('label', { class: 'check sheet__check', attrs: { for: checkId } },
          checkbox, h('span', null, spec.checkbox ?? '')),
        h('div', { class: 'sheet__actions' }, cancel, confirm)));
      document.body.append(dialog);
      openSheet = dialog;
      dialog.showModal();
      untrap = trapFocus(dialog);
      (checkbox ?? cancel).focus();
    });
  });
}

/** The sheet that is open now (Details and the shell lab). */
export function currentSheet(): HTMLDialogElement | null {
  return openSheet;
}
