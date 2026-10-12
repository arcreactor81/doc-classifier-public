/**
 * Glyphs (SPEC §7.1 Glyph). Small stroked SVG icons on a 16 px grid, drawn in `currentColor`.
 * Every glyph is `aria-hidden="true"`: its meaning is always carried by text next to it, never by the shape or colour.
 */
import { svg } from './dom.ts';

type Shape =
  | { path: string }
  | { circle: readonly [cx: number, cy: number, r: number] }
  | { rect: readonly [x: number, y: number, width: number, height: number, rx: number] };

const GLYPHS = {
  /** Filed; done; ✓ in comparisons. */
  check: [{ path: 'M3.5 8.5l3 3 6-7' }],
  /** Needs review (a person decides). */
  person: [{ circle: [8, 5.5, 2.5] }, { path: 'M3 13.5c.6-2.6 2.6-4.2 5-4.2s4.4 1.6 5 4.2' }],
  /** Could not process. */
  slash: [{ circle: [8, 8, 5.5] }, { path: 'M4.1 11.9l7.8-7.8' }],
  /** Unverified or provisional filing certainty. */
  caution: [{ path: 'M8 2.5l6 11H2z' }, { path: 'M8 6.5v3.2' }, { path: 'M8 11.8h.01' }],
  /** An informational notice. */
  info: [{ circle: [8, 8, 6] }, { path: 'M8 7.4v3.8' }, { path: 'M8 5h.01' }],
  /** A problem notice beneath an action. */
  problem: [{ circle: [8, 8, 6] }, { path: 'M8 4.8v4' }, { path: 'M8 11.2h.01' }],
  /** ≠ in comparisons. */
  'not-equal': [{ path: 'M3 6h10' }, { path: 'M3 10h10' }, { path: 'M10.5 3l-5 10' }],
  'chevron-right': [{ path: 'M6 3.5L10.5 8 6 12.5' }],
  'chevron-down': [{ path: 'M3.5 6L8 10.5 12.5 6' }],
  'arrow-right': [{ path: 'M2.5 8h11' }, { path: 'M9 3.5L13.5 8 9 12.5' }],
  'arrow-left': [{ path: 'M13.5 8h-11' }, { path: 'M7 3.5L2.5 8 7 12.5' }],
  close: [{ path: 'M4 4l8 8' }, { path: 'M12 4l-8 8' }],
  search: [{ circle: [7, 7, 4.5] }, { path: 'M10.4 10.4L14 14' }],
  folder: [{ path: 'M1.5 4.5a1 1 0 0 1 1-1h3.4l1.6 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z' }],
  file: [{ path: 'M4 1.5h5l3.5 3.5v9.5H4z' }, { path: 'M9 1.5V5h3.5' }],
  stop: [{ rect: [3.5, 3.5, 9, 9, 1.5] }],
  pause: [{ path: 'M6 3.5v9' }, { path: 'M10 3.5v9' }],
  play: [{ path: 'M5 3.5l7 4.5-7 4.5z' }],
  sun: [{ circle: [8, 8, 3] }, { path: 'M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1' }],
  moon: [{ path: 'M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z' }],
  // The reference's promise and process glyphs (prototype-v3 index.html sprite).
  /** Originals stay on this computer. */
  lock: [{ rect: [3, 7, 10, 7, 2.2] }, { path: 'M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7' }],
  /** Two systems must agree. */
  two: [{ circle: [6, 8, 4.2] }, { circle: [10, 8, 4.2] }],
  /** Nothing changes without the person. */
  shield: [{ path: 'M8 1.8l5 2v4.1c0 3-2.1 5.1-5 6.3-2.9-1.2-5-3.3-5-6.3V3.8z' }, { path: 'M5.8 8.1l1.6 1.6 3-3.1' }],
  clock: [{ circle: [8, 8, 6] }, { path: 'M8 4.8V8l2.2 1.6' }],
  doc: [{ path: 'M4 1.8h5l3 3v9.4H4z' }, { path: 'M9 1.8v3h3M6 8.5h4M6 11h4' }],
  /** The brand mark's trail: a run's path. */
  trail: [{ path: 'M2 12.5h5.2a3.3 3.3 0 0 0 3.3-3.3V4' }, { circle: [10.5, 3.6, 1.4] }],
  'trail-off': [{ path: 'M2 12.5h5.2a3.3 3.3 0 0 0 3.3-3.3V4' }, { path: 'M2.5 2.5l11 11' }],
} as const satisfies Record<string, readonly Shape[]>;

export type GlyphName = keyof typeof GLYPHS;
export const GLYPH_NAMES = Object.keys(GLYPHS) as readonly GlyphName[];

function shape(part: Shape): SVGElement {
  if ('path' in part) return svg('path', { d: part.path });
  if ('circle' in part) return svg('circle', { cx: part.circle[0], cy: part.circle[1], r: part.circle[2] });
  const [x, y, width, height, rx] = part.rect;
  return svg('rect', { x, y, width, height, rx });
}

/** An `aria-hidden` SVG glyph. `size` is in CSS pixels (default 16); CSS may override it through the class. */
export function glyph(name: GlyphName, options: { size?: number; class?: string } = {}): SVGSVGElement {
  const parts: readonly Shape[] | undefined = GLYPHS[name];
  if (parts === undefined) throw new Error(`glyph(): there is no glyph named "${String(name)}".`);
  const size = options.size ?? 16;
  const classes = options.class === undefined ? `glyph glyph--${name}` : `glyph glyph--${name} ${options.class}`;
  return svg('svg', {
    viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
    class: classes, 'data-glyph': name,
  }, ...parts.map(shape));
}
