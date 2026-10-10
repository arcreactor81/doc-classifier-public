/**
 * MoneyField (SPEC §7.1; the Sorting Room's `.money` field, site.css): a dollar amount as text. It is never turned
 * into a floating-point number: the caller converts the text with core/ui/run-budget.ts `usdToNanodollars`, and
 * `amountProblem` says whether that would refuse it. Empty is allowed here (the caller decides whether a limit is
 * required). An invalid amount shows its error beneath the field, linked with aria-describedby, and marks the field
 * aria-invalid.
 *
 * - `heading`: the label is the panel's h3 (the artifact's "Spending limit"); without it, a small label.
 * - `hint` sits between the label and the field; `aside` is a short line beside the field (the rough cost).
 */
import './money-field.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { usdToNanodollars } from '../../../core/ui/run-budget.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';

type R<T> = T | Read<T>;

export interface MoneyFieldSpec {
  /** Unique in the page: the input's id. */
  id: string;
  label: R<string>;
  value: Read<string>;
  disabled?: Read<boolean>;
  onInput(text: string): void;
  /** The error sentence to show, or null. */
  error: Read<string | null>;
  hint?: R<string | null>;
  /** A short line beside the field (for example the rough cost), or null. */
  aside?: R<string | null>;
  /** The label is the panel's heading (an h3). */
  heading?: boolean;
  testid?: string;
}

/** 'invalid' when `usdToNanodollars` would refuse the text; null for a valid amount or an empty field. */
export function amountProblem(text: string): 'invalid' | null {
  if (text.trim() === '') return null;
  try {
    usdToNanodollars(text);
    return null;
  } catch {
    return 'invalid';
  }
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

export function moneyField(spec: MoneyFieldSpec): HTMLElement {
  const hint = computed(() => (spec.hint === undefined ? null : read(spec.hint)));
  const aside = computed(() => (spec.aside === undefined ? null : read(spec.aside)));
  const describedBy = computed(() =>
    [hint() !== null ? `${spec.id}-hint` : null, spec.error() !== null ? `${spec.id}-error` : null].filter(Boolean).join(' ') || null);
  const input = h('input', {
    class: 'money__input',
    attrs: {
      id: spec.id, type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
      'aria-invalid': computed(() => (spec.error() !== null ? 'true' : null)), 'aria-describedby': describedBy
    },
    props: { value: spec.value, ...(spec.disabled ? { disabled: spec.disabled } : {}) },
    on: { input: () => {
      if (spec.disabled?.()) { input.value = spec.value(); return; }
      spec.onInput(input.value);
    } },
    ...(spec.testid ? { testid: spec.testid } : {})
  });
  const label = h('label', { class: 'money-field__label', attrs: { for: spec.id, id: `${spec.id}-label` } },
    typeof spec.label === 'string' ? spec.label : computed(() => read(spec.label)));
  return h('div', {
    class: 'money-field',
    classes: { 'is-invalid': computed(() => spec.error() !== null), 'money-field--heading': spec.heading === true }
  },
  spec.heading === true ? h('h3', { class: 'money-field__heading' }, label) : label,
  show(computed(() => hint() !== null), () => h('p', { class: 'money-field__hint', attrs: { id: `${spec.id}-hint` } }, computed(() => hint() ?? ''))),
  h('div', { class: 'money-field__row' },
    h('div', { class: 'money' }, h('span', { class: 'money__cur', attrs: { 'aria-hidden': 'true' } }, activeUiCopy.common.currency), input),
    show(computed(() => aside() !== null), () => h('p', { class: 'money-field__aside' }, computed(() => aside() ?? '')))),
  show(computed(() => spec.error() !== null), () =>
    h('p', { class: 'money-field__error', attrs: { id: `${spec.id}-error` } },
      glyph('problem', { class: 'money-field__glyph' }), h('span', null, computed(() => spec.error() ?? '')))));
}
