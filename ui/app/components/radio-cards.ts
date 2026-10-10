/**
 * RadioCards (SPEC §7.1, §4.6 M1–M2): native radios in label cards, inside a fieldset with a legend.
 *
 * - Nothing is selected until the person chooses (the value is null): a choice is never pre-filled.
 * - `onChoose` fires on `click` and on `change`, both for the same choice, so choosing the option already selected
 *   still records the moment (M2), and arrow-key selection is covered (Chromium dispatches both).
 * - A disabled option shows why beneath it, linked with aria-describedby (the parked mode, owner question Q2).
 * - `groupLabel` starts a group of options with a small heading ("Other option").
 */
import './radio-cards.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { h, show } from '../view/dom.ts';

type R<T> = T | Read<T>;

export interface RadioOption {
  value: string;
  title: R<string>;
  detail?: R<string | null>;
  /** Non-null: the option is disabled, and this sentence says why. */
  disabledReason?: R<string | null>;
  /** A heading shown before this option. */
  groupLabel?: R<string | null>;
}

export interface RadioCardsSpec {
  /** The radio group's name; element ids derive from it. */
  name: string;
  legend: R<string>;
  options: readonly RadioOption[];
  value: Read<string | null>;
  onChoose(value: string): void;
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);
const text = (value: R<string>) => (typeof value === 'string' ? value : computed(() => read(value)));

export function radioCards(spec: RadioCardsSpec): HTMLElement {
  const inputs: HTMLInputElement[] = [];
  // The browser checks a radio before `onChoose` runs. When the choice was not recorded (the caller refused it or
  // threw), the radios must go back to what is recorded: a radio never shows a choice that is not the value (M1).
  const showRecorded = () => {
    const recorded = spec.value.peek();
    for (const input of inputs) if (input.checked !== (input.value === recorded)) input.checked = input.value === recorded;
  };
  return h('fieldset', { class: 'cards', attrs: { 'data-radio-cards': spec.name }, ...(spec.testid ? { testid: spec.testid } : {}) },
    h('legend', { class: 'cards__legend' }, text(spec.legend)),
    spec.options.map(option => {
      const id = `${spec.name}-${option.value}`;
      const reason = computed(() => (option.disabledReason === undefined ? null : read(option.disabledReason)));
      const detail = computed(() => (option.detail === undefined ? null : read(option.detail)));
      const group = computed(() => (option.groupLabel === undefined ? null : read(option.groupLabel)));
      const disabled = computed(() => reason() !== null);
      const choose = () => {
        try {
          if (!disabled.peek()) spec.onChoose(option.value);
        } finally {
          showRecorded();
        }
      };
      const described = computed(() => [detail() !== null ? `${id}-detail` : null, reason() !== null ? `${id}-reason` : null]
        .filter(Boolean).join(' ') || null);
      return [
        show(computed(() => group() !== null), () => h('p', { class: 'cards__group' }, computed(() => group() ?? ''))),
        h('label', { class: 'rcard', attrs: { for: id }, classes: { 'is-disabled': disabled } },
          h('input', {
            attrs: { type: 'radio', id, name: spec.name, value: option.value, 'aria-describedby': described },
            props: { checked: computed(() => spec.value() === option.value), disabled },
            on: { click: choose, change: choose },
            ref: input => { inputs.push(input); }
          }),
          h('span', { class: 'rcard__body' },
            h('span', { class: 'rcard__title' }, text(option.title)),
            show(computed(() => detail() !== null), () =>
              h('span', { class: 'rcard__detail', attrs: { id: `${id}-detail` } }, computed(() => detail() ?? ''))),
            show(disabled, () => h('span', { class: 'rcard__reason', attrs: { id: `${id}-reason` } }, computed(() => reason() ?? '')))))
      ];
    }));
}
