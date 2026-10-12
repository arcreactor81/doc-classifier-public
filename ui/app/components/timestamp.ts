/**
 * Timestamp (SPEC §7.1): `<time datetime>` with the local time, and optionally how long ago, which follows the minute
 * clock (text only, no motion). A missing time reads "Unknown" and carries no datetime: never a made-up time.
 */
import './timestamp.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { dateShort, relative as ago, time, timeShort } from '../../../core/ui/format.ts';
import { h, show } from '../view/dom.ts';

export type TimestampFormat = 'time' | 'short' | 'date-time';

export interface TimestampSpec {
  /** Epoch milliseconds, or null when not known. */
  at: Read<number | null>;
  format?: TimestampFormat;
  /** The minute clock (`store.minuteClock`): adds " · 41 min ago", updated once a minute. */
  relativeTo?: Read<number>;
  /** Wraps the formatted time in a sentence, e.g. `common.checkedAt`. */
  wrap?: (formatted: string) => string;
  testid?: string;
}

export function formatAt(ms: number, format: TimestampFormat): string {
  if (format === 'short') return timeShort(ms);
  if (format === 'date-time') return `${dateShort(ms)} ${timeShort(ms)}`;
  return time(ms);
}

export function timestamp(spec: TimestampSpec): HTMLElement {
  const format = spec.format ?? 'time';
  const text = computed(() => {
    const at = spec.at();
    const shown = at === null ? activeUiCopy.common.unknown : formatAt(at, format);
    return spec.wrap ? spec.wrap(shown) : shown;
  });
  const since = computed(() => {
    const at = spec.at();
    return at === null || spec.relativeTo === undefined ? null : ago(at, spec.relativeTo());
  });
  return h('span', { class: 'timestamp', ...(spec.testid ? { testid: spec.testid } : {}) },
    h('time', {
      attrs: {
        datetime: computed(() => { const at = spec.at(); return at === null ? null : new Date(at).toISOString(); }),
        'data-unknown': computed(() => spec.at() === null)
      }
    }, text),
    show(computed(() => since() !== null), () => h('span', { class: 'timestamp__ago' }, ' · ', computed(() => since() ?? ''))));
}
