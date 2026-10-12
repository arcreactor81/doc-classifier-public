/**
 * Count (VISUAL-SPEC-v2 §7.5, N1): a number that never counts up. The true value is in the DOM from the first frame;
 * when it changes after its first value (same mount), only the digits that changed move, each in its own box, by
 * exactly one line: the old digit leaves the top as the new one arrives from below (the reverse when the number
 * falls). The window is the numeral band, cap height to baseline, measured once per font from the font in use
 * (canvas `measureText`) and handed to the CSS as custom properties, with a static soft edge just outside it. The
 * right-hand digit leads by `--stagger-digit`. When the roll ends the element is plain text again, in the same place.
 *
 * A screen reader sees the plain number: while rolling, a visually hidden copy of the value sits beside the moving
 * parts, which are `aria-hidden`. The first value is written plain; a value that is not a whole number, or the same
 * text again, changes nothing. The hand-back waits on the animations' `finished` promise, not a timer or an event;
 * the new digit is already at rest in view, so nothing is hidden meanwhile.
 */
import './count.css';
import { effect, getOwner, onCleanup, untrack, type Read } from '../../../core/ui/reactive.ts';
import { h } from '../view/dom.ts';
import { animate, ease, ms } from '../view/motion.ts';

export interface CountOptions {
  /** The classes that give the number its font (`count__n num`, `tally__n num`): the band is measured from them. */
  class?: string;
}

/** The numeral band of one font, in the coordinates of the line box (px from its top). */
interface Band { height: number; top: number; bottom: number; fade: number; ext: number }

/** The window is clipped this share of the band beyond each edge, with a steep fade inside that margin. */
const FADE_SHARE = 0.12;
/** The window box reaches this far (in em) above and below the line box (count.css `.dg__m`). */
const EXT_EM = 0.25;

const bands = new Map<string, Band>();
let measurer: CanvasRenderingContext2D | null = null;

/** Cap height to baseline for the font `el` is set in, from the actual glyph bounds of the ten digits; cached per font. */
function numeralBand(el: Element): Band | null {
  const cs = getComputedStyle(el);
  const size = parseFloat(cs.fontSize);
  const lineHeight = /px$/.test(cs.lineHeight) ? parseFloat(cs.lineHeight) : cs.lineHeight === 'normal' ? NaN : parseFloat(cs.lineHeight) * size;
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const key = `${font}|${lineHeight}`;
  const cached = bands.get(key);
  if (cached !== undefined) return cached;
  measurer ??= document.createElement('canvas').getContext('2d');
  if (measurer === null || !Number.isFinite(size)) return null;
  measurer.font = font;
  const m = measurer.measureText('0123456789');
  const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const height = Number.isNaN(lineHeight) ? content : lineHeight;
  // The baseline, measured from the top of the line box (half-leading above the font's ascent).
  const baseline = (height - content) / 2 + m.fontBoundingBoxAscent;
  const top = baseline - m.actualBoundingBoxAscent, bottom = baseline + m.actualBoundingBoxDescent;
  const band: Band = { height, top, bottom, fade: Number(((bottom - top) * FADE_SHARE).toFixed(1)), ext: EXT_EM * size };
  bands.set(key, band);
  return band;
}

/** Writes the window's edges for this font onto the host, so every `.dg__m` beneath it reads them (count.css). */
function setBand(el: HTMLElement, band: Band): void {
  const boxHeight = band.height + 2 * band.ext;
  const top = Math.max(0, band.ext + band.top - band.fade);
  const bottom = Math.min(boxHeight, band.ext + band.bottom + band.fade);
  const px = (value: number) => `${value.toFixed(1)}px`;
  const style = el.style;
  if (style.getPropertyValue('--band-top') !== px(top)) style.setProperty('--band-top', px(top));
  if (style.getPropertyValue('--band-bottom') !== px(boxHeight - bottom)) style.setProperty('--band-bottom', px(boxHeight - bottom));
  if (style.getPropertyValue('--band-fade') !== px(band.fade)) style.setProperty('--band-fade', px(band.fade));
}

const WHOLE = /^\d+$/;

export function count(value: Read<number>, options: CountOptions = {}): HTMLElement {
  const el = h('span', options.class === undefined ? null : { class: options.class });
  let shown: string | null = null;
  let rolls: Animation[] | null = null;
  const cancel = (): void => {
    if (rolls === null) return;
    for (const roll of rolls) roll.cancel();
    rolls = null;
  };

  const render = (text: string): void => {
    if (text === shown) return;
    const before = shown;
    shown = text;
    cancel();
    if (before === null || !el.isConnected || !WHOLE.test(text) || !WHOLE.test(before)) {
      el.textContent = text;
      return;
    }
    const band = numeralBand(el);
    if (band === null) {
      el.textContent = text;
      return;
    }
    setBand(el, band);
    const up = Number(text) >= Number(before);
    const width = Math.max(text.length, before.length);
    const next = text.padStart(width, ' '), previous = before.padStart(width, ' ');
    const hidden = h('span', { class: 'visually-hidden' }, text);
    const visual = h('span', { attrs: { 'aria-hidden': 'true' } });
    const columns: HTMLElement[] = [];
    // A blank cell keeps its line height with a no-break space; a plain space would collapse the line.
    const cell = (digit: string) => h('span', null, digit === ' ' ? ' ' : digit);
    for (let i = 0; i < width; i++) {
      const a = previous[i], b = next[i];
      if (b === ' ') continue; // the number got shorter: that digit simply leaves
      if (a === b) {
        visual.append(b);
        continue;
      }
      const column = h('span', { class: 'dg__col' }, ...(up ? [cell(a), cell(b)] : [cell(b), cell(a)]));
      // The placeholder holds both digits in one grid cell, so the box is as wide as the wider of the two.
      visual.append(h('span', { class: 'dg' },
        h('span', { class: 'dg__ph' }, h('span', null, a === ' ' ? '' : a), h('span', null, b)),
        h('span', { class: 'dg__m' }, column)));
      columns.push(column);
    }
    el.textContent = '';
    el.append(hidden, visual);
    const [from, to] = up ? ['translateY(0)', 'translateY(-50%)'] : ['translateY(-50%)', 'translateY(0)'];
    const stagger = ms('--stagger-digit'), duration = ms('--dur-roll'), easing = ease('--ease-roll');
    const started = columns
      .map((column, i) => animate(column, [{ transform: from }, { transform: to }],
        { duration, delay: (columns.length - 1 - i) * stagger, easing, fill: 'both' }))
      .filter((roll): roll is Animation => roll !== null);
    rolls = started;
    // When the roll ends the count is plain text again, in exactly the same place. A roll cancelled from outside
    // (not by a newer value, which writes its own text) hands back too, so the old digit is never left showing.
    const handBack = () => {
      if (rolls !== started) return;
      rolls = null;
      el.textContent = text;
    };
    void Promise.all(started.map(roll => roll.finished)).then(handBack, handBack);
  };

  effect(() => {
    const current = value();
    untrack(() => render(String(current)));
  });
  if (getOwner() !== null) onCleanup(cancel);
  return el;
}
