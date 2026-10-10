/**
 * Click-through sweep, every-view group — script 17: rendered contrast in dark mode (owner rule 10).
 *
 * At every view of the every-view tour, in dark mode at 1280 and 390 px, every visible text run is sampled:
 * its rendered colour (getComputedStyle, with the element's and its ancestors' opacity) against its effective
 * background, composited from the root down through every ancestor's background-color and the colour stops of
 * any background-image (gradients: every stop is a candidate, the worst one counts; `approx: true` marks these).
 * The contrast is computed here with the WCAG 2.x relative-luminance formula. Owner rule: text 4.5:1 (large text
 * is not relaxed; its size is recorded), non-text 3:1. Disabled controls are exempt (WCAG 1.4.3) and listed apart.
 *
 * Named categories are reported per theme: headings, body, muted text, links, the primary button label, outcome
 * pills, the failure notice, the status light words and reasons. Non-text: the status light's dot (and with its
 * halo), its waiting ring and its grey (stale) ring, the red ring, track and meter fills against their track, the
 * failure notice's red rule and glyph, and text-field borders.
 *
 * Not sampled: pixels (colours are computed, not read from the screen), overlapping non-ancestor layers, focus rings,
 * native checkbox and radio rendering.
 */
import { checkTour, eachVariant, tourEveryView } from './07-feedback-adjacency.mjs';
import { runScript } from '../ui-harness/evidence.mjs';

const SCRIPT = '17-contrast';
const TEXT_MIN = 4.5, NON_TEXT_MIN = 3;

/** Runs in the page: samples text and non-text pairs. */
function sample() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const parse = (css, depth = 0) => {
    const s = String(css ?? '').trim();
    if (!s || s === 'none') return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(v => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^color\(srgb\s+([^)]+)\)$/i.exec(s);
    if (m) {
      const [rgb, alpha] = m[1].split('/');
      const p = rgb.trim().split(/\s+/).map(parseFloat);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: alpha === undefined ? 1 : parseFloat(alpha) };
    }
    m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let hex = m[1];
      if (hex.length <= 4) hex = [...hex].map(c => c + c).join('');
      const n = parseInt(hex.slice(0, 6), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
    }
    if (depth > 0) return null;
    ctx.fillStyle = '#010203';
    ctx.fillStyle = s;
    return ctx.fillStyle === '#010203' && s !== '#010203' ? null : parse(ctx.fillStyle, 1);
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1
  });
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = c => `#${[c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
  const colorsIn = image => (image.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi) ?? []).map(c => parse(c)).filter(Boolean);
  const trim = list => {
    const seen = new Map();
    for (const c of list) seen.set(hex(c), c);
    const all = [...seen.values()].sort((a, b) => lum(a) - lum(b));
    return all.length > 12 ? [...all.slice(0, 6), ...all.slice(-6)] : all;
  };
  const layerCache = new Map();
  /** Effective background candidates behind `el` (its own background included). */
  const backgrounds = el => {
    if (layerCache.has(el)) return layerCache.get(el);
    const parent = el.parentElement;
    let base, approx = false;
    if (parent) ({ candidates: base, approx } = backgrounds(parent));
    else base = [{ r: 255, g: 255, b: 255, a: 1 }];
    const cs = getComputedStyle(el);
    let candidates = base;
    const color = parse(cs.backgroundColor);
    if (color && color.a > 0) candidates = candidates.map(c => over(color, c));
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const stops = colorsIn(cs.backgroundImage);
      if (stops.length) { candidates = trim(candidates.flatMap(c => stops.map(s => over(s, c)))); approx = true; }
    }
    // The ground's two fixed glows (body::before) are counted at their strongest. The 1px lattice lines (body::after,
    // 160px apart) are not a surface anything sits on and are left out.
    if (el === document.body) {
      for (const pseudo of ['::before']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none') continue;
        const stops = colorsIn(ps.backgroundImage ?? '');
        if (stops.length) { candidates = trim([...candidates, ...candidates.flatMap(c => stops.map(s => over(s, c)))]); approx = true; }
      }
    }
    const result = { candidates, approx };
    layerCache.set(el, result);
    return result;
  };
  const opacityOf = el => { let o = 1; for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
  const worst = (fg, bgs) => {
    let min = Infinity, at = null;
    for (const bg of bgs) { const r = ratio(over(fg, bg), bg); if (r < min) { min = r; at = bg; } }
    return { ratio: Math.round(min * 100) / 100, bg: at ? hex(at) : null };
  };
  const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const root = getComputedStyle(document.documentElement);
  const token = name => parse(root.getPropertyValue(name));
  const mutedColors = ['--ink-2', '--ink-3'].map(token).filter(Boolean).map(hex);
  const describe = el => `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : ''}`;
  const categoryOf = (el, fgHex) => {
    if (el.closest('.notice--failure')) return 'failure notice';
    if (el.closest('.status__state')) return `light word (${el.closest('[data-light]')?.getAttribute('data-light') ?? '?'})`;
    if (el.closest('.status__why')) return 'light reason';
    const pill = el.closest('.pill');
    if (pill) return `outcome pill (${[...pill.classList].find(c => c.startsWith('pill--'))?.slice(6) ?? 'plain'})`;
    if (el.closest('button[data-primary]')) return 'primary button label';
    if (el.closest('h1, h2, h3, h4')) return 'heading';
    if (el.closest('a')) return 'link';
    if (el.closest('button')) return 'button label';
    if (el.closest('.notice--problem, .notice--blocker')) return 'problem notice';
    if (mutedColors.includes(fgHex)) return 'muted text';
    return 'body text';
  };

  const text = [], exempt = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const done = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || done.has(el) || !node.data.trim()) continue;
    done.add(el);
    if (el.closest('script,style,noscript,template,.visually-hidden') || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    const cs = getComputedStyle(el);
    if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') { exempt.push({ reason: 'background-clip text', element: describe(el) }); continue; }
    const fg0 = parse(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color);
    if (!fg0) continue;
    const fg = { ...fg0, a: fg0.a * opacityOf(el) };
    const disabled = el.closest('button:disabled, [aria-disabled="true"], input:disabled, textarea:disabled, select:disabled, fieldset:disabled');
    const { candidates, approx } = backgrounds(el);
    const w = worst(fg, candidates);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
    const entry = { category: categoryOf(el, hex(fg0)), text: node.data.trim().slice(0, 60), element: describe(el),
      testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null, fg: hex(fg0), alpha: Math.round(fg.a * 100) / 100,
      bg: w.bg, ratio: w.ratio, size, weight, large: size >= 24 || (size >= 18.66 && weight >= 700), approx };
    if (disabled) exempt.push({ reason: 'disabled control', ...entry }); else text.push(entry);
  }
  // Placeholders are text a person reads.
  for (const input of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (!visible(input) || !input.placeholder || input.value) continue;
    const fg = parse(getComputedStyle(input, '::placeholder').color);
    if (!fg) continue;
    const w = worst(fg, backgrounds(input).candidates);
    text.push({ category: 'placeholder', text: input.placeholder.slice(0, 60), element: describe(input), fg: hex(fg), bg: w.bg, ratio: w.ratio,
      size: parseFloat(getComputedStyle(input).fontSize), approx: backgrounds(input).approx });
  }

  const nonText = [];
  const push = (kind, el, fg, bgs, extra = {}) => {
    if (!fg) return;
    const w = worst(fg, bgs);
    nonText.push({ kind, element: describe(el), testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      fg: hex(fg), alpha: Math.round(fg.a * 100) / 100, bg: w.bg, ratio: w.ratio, ...extra });
  };
  const insetColor = shadow => { const m = /(rgba?\([^)]*\)|color\(srgb[^)]*\)|#[0-9a-f]{3,8})[^,]*inset|inset[^,]*?(rgba?\([^)]*\)|color\(srgb[^)]*\)|#[0-9a-f]{3,8})/i.exec(shadow ?? ''); return m ? parse(m[1] ?? m[2]) : null; };
  for (const ind of document.querySelectorAll('.ind')) {
    if (!visible(ind)) continue;
    const light = ind.closest('[data-light]')?.getAttribute('data-light') ?? '?';
    const bgs = backgrounds(ind.parentElement).candidates;
    const dot = ind.querySelector('.ind__dot');
    const dcs = dot ? getComputedStyle(dot) : null;
    const fill = parse(dcs?.backgroundColor);
    if (fill && fill.a > 0) {
      push(`light dot (${light})`, ind, fill, bgs);
      const halo = ind.querySelector('.ind__halo');
      const hcs = halo ? getComputedStyle(halo) : null;
      const glow = colorsIn(hcs?.backgroundImage ?? '').find(c => c.a > 0);
      // The halo is radial (closest-side, glow → transparent) and centred on the dot: at the dot's edge it has faded by
      // dot radius / halo radius. That is the colour next to the dot.
      const edge = halo && dot ? Math.min(1, dot.getBoundingClientRect().width / Math.max(1, halo.getBoundingClientRect().width)) : 0;
      // A pulsing halo is taken at its brightest (the live keyframes reach opacity 1). The dot's own 3px soft ring
      // (box-shadow spread, the dot colour at 16%) lies between the dot and the halo, so it is composited on top.
      const haloOpacity = halo.getAnimations().length ? 1 : parseFloat(hcs.opacity);
      const soft = colorsIn((dcs?.boxShadow ?? '').replace(/[^,]*inset[^,]*/g, '')).find(c => c.a > 0 && c.a < 1) ?? null;
      if (glow) push(`light dot against its halo (${light})`, ind, fill,
        bgs.map(b => { const h = over({ ...glow, a: glow.a * (1 - edge) * haloOpacity }, b); return soft ? over(soft, h) : h; }),
        { haloOpacity, haloFadeAtDotEdge: Math.round(edge * 100) / 100, softRing: soft ? hex(soft) + `@${Math.round(soft.a * 100) / 100}` : null });
    } else push(`light ring, hollow dot (${light})`, ind, insetColor(dcs?.boxShadow), bgs);
    const hold = ind.querySelector('.ind__hold');
    const hc = hold ? getComputedStyle(hold) : null;
    if (hc && parseFloat(hc.opacity) > 0) {
      const c = parse(hc.borderTopColor);
      if (c) push(`light outer ring (${light})`, ind, { ...c, a: c.a * parseFloat(hc.opacity) }, bgs);
    }
    const ring = ind.querySelector('.ind__ring');
    const rc = ring ? getComputedStyle(ring) : null;
    if (rc && (light === 'live' || light === 'failed')) push(`light pulse ring at its brightest (${light})`, ind, parse(rc.borderTopColor), bgs);
  }
  for (const fill of document.querySelectorAll('.track__fill, .feedback__meter-fill')) {
    if (!visible(fill)) continue;
    const track = fill.closest('.track, .feedback__meter');
    if (!track) continue;
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(fill).transform);
    if (m && parseFloat(m[1].split(',')[0]) === 0) continue;
    const tcs = getComputedStyle(track);
    const trackBgs = backgrounds(track).candidates;
    const fcs = getComputedStyle(fill);
    const own = parse(fcs.backgroundColor);
    // A patterned fill (the stalled track's dashes) is read by its marks, not its gaps: its strongest stop counts.
    const stops = colorsIn(fcs.backgroundImage ?? '').filter(c => c.a > 0);
    const mark = stops.length ? stops.map(c => ({ c, r: worst(c, trackBgs).ratio })).sort((a, b) => b.r - a.r)[0].c : own;
    if (mark && mark.a > 0)
      push(`${fill.classList.contains('track__fill') ? 'track' : 'meter'} fill against its track${track.className.includes('stalled') ? ' (stalled)' : ''}`, fill, mark, trackBgs,
        { track: tcs.backgroundColor, patterned: stops.length > 0 });
  }
  for (const n of document.querySelectorAll('.notice--failure')) {
    if (!visible(n)) continue;
    const bgs = backgrounds(n).candidates;
    // The rule is a ::before since T5 (notice.css); action.ts's older problem notice still draws it as an inset shadow.
    const before = parse(getComputedStyle(n, '::before').backgroundColor);
    push('failure notice red rule', n, before && before.a > 0 ? before : insetColor(getComputedStyle(n).boxShadow), bgs);
    const glyph = n.querySelector('.notice__glyph');
    if (glyph) push('failure notice glyph', glyph, parse(getComputedStyle(glyph).color), bgs);
  }
  for (const field of document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"], input[type="number"], textarea, select')) {
    if (!visible(field) || field.disabled) continue;
    const outside = field.parentElement ? backgrounds(field.parentElement).candidates : [{ r: 255, g: 255, b: 255, a: 1 }];
    push('text field border', field, parse(getComputedStyle(field).borderTopColor), outside, { id: field.id || null });
  }
  return { theme: document.documentElement.dataset.theme ?? null, text, nonText, exempt };
}

await runScript(SCRIPT, 'Owner rule 10: text 4.5:1 and non-text 3:1 in dark mode (every view, rendered colours)',
  async ({ checks, evidence }) => {
    const perStation = {};
    const tour = await tourEveryView({
      label: SCRIPT,
      log: line => console.log(line),
      async visit(station, { page }) {
        perStation[station] = await eachVariant(page, async () => page.evaluate(sample));
      }
    });
    checkTour(checks, tour, evidence);

    const low = {}, minima = {}, nonTextLow = {}, nonTextSeen = {}, exempt = [];
    const keyOf = (theme, e) => `${theme}|${e.category ?? e.kind}|${e.fg}|${e.bg}`;
    for (const [station, variants] of Object.entries(perStation)) {
      for (const v of variants) {
        const r = v.result, theme = v.theme;
        if (r.theme !== theme) checks.check(`${station}: sampled in the ${theme} theme`, false, r.theme);
        for (const e of r.text) {
          const mkey = `${theme}|${e.category}`;
          if (!minima[mkey] || e.ratio < minima[mkey].ratio) minima[mkey] = { ...e, station, width: v.width };
          if (e.ratio < TEXT_MIN) {
            const k = keyOf(theme, e);
            (low[k] ??= { theme, category: e.category, fg: e.fg, bg: e.bg, ratio: e.ratio, large: e.large, approx: e.approx, where: [] })
              .where.push({ station, width: v.width, text: e.text, element: e.element, testid: e.testid });
          }
        }
        for (const e of r.nonText) {
          const kkey = `${theme}|${e.kind}`;
          if (!nonTextSeen[kkey] || e.ratio < nonTextSeen[kkey].ratio) nonTextSeen[kkey] = { ...e, station, width: v.width };
          if (e.ratio < NON_TEXT_MIN) {
            const k = keyOf(theme, e);
            (nonTextLow[k] ??= { theme, kind: e.kind, fg: e.fg, alpha: e.alpha, bg: e.bg, ratio: e.ratio, where: [] })
              .where.push({ station, width: v.width, element: e.element, testid: e.testid });
          }
        }
        if (v.width === 1280) exempt.push(...r.exempt.map(e => ({ station, theme, ...e })));
      }
    }
    const trimWhere = entry => ({ ...entry, where: [...new Map(entry.where.map(w => [`${w.station}|${w.text ?? w.element}`, w])).values()].slice(0, 12),
      stations: [...new Set(entry.where.map(w => w.station))] });
    evidence.textMinimaByCategory = minima;
    evidence.nonTextByKind = nonTextSeen;
    evidence.textUnder45 = Object.values(low).map(trimWhere);
    evidence.nonTextUnder3 = Object.values(nonTextLow).map(trimWhere);
    evidence.exemptDisabled = exempt.slice(0, 60);

    for (const theme of ['dark']) {
      const lowT = Object.values(low).filter(e => e.theme === theme).map(trimWhere);
      checks.check(`${theme}: every visible text run is at least 4.5:1 against its background (all views, 1280 and 390)`, lowT.length === 0,
        lowT.length ? lowT : undefined);
      // The halo is measured separately, with the same 3:1 requirement as every other meaningful edge.
      const againstGlow = e => e.kind.startsWith('light dot against its halo');
      const lowN = Object.values(nonTextLow).filter(e => e.theme === theme && !againstGlow(e)).map(trimWhere);
      checks.check(`${theme}: every light, ring, fill, rule and field border sampled is at least 3:1 against what is next to it`, lowN.length === 0,
        lowN.length ? lowN : undefined);
      const lowGlow = Object.values(nonTextLow).filter(e => e.theme === theme && againstGlow(e)).map(trimWhere);
      checks.check(`${theme}: the light's dot is at least 3:1 against its own glow`, lowGlow.length === 0, lowGlow.length ? lowGlow : undefined);
      // A named category is checked where the tour showed it; one it never showed is listed as not sampled
      // (reported under not_checked), never counted as passed.
      for (const category of ['heading', 'body text', 'muted text', 'link', 'primary button label', 'outcome pill (filed)', 'outcome pill (review)',
        'outcome pill (failed)', 'failure notice', 'light word (live)', 'light word (failed)', 'light word (stale)', 'light word (waiting)',
        'light word (done)', 'light reason']) {
        const m = minima[`${theme}|${category}`];
        if (!m) { (evidence.notSampled ??= []).push(`${theme}: ${category}`); continue; }
        checks.check(`${theme}: ${category} — lowest contrast at least 4.5:1`, m.ratio >= TEXT_MIN,
          { ratio: m.ratio, fg: m.fg, bg: m.bg, text: m.text, station: m.station, approx: m.approx });
      }
      for (const kind of ['light dot (live)', 'light dot (waiting)', 'light dot (failed)', 'light ring, hollow dot (stale)', 'light ring, hollow dot (done)',
        'light outer ring (waiting)', 'track fill against its track', 'failure notice red rule']) {
        const m = nonTextSeen[`${theme}|${kind}`];
        if (!m) { (evidence.notSampled ??= []).push(`${theme}: ${kind}`); continue; }
        checks.check(`${theme}: ${kind} — at least 3:1`, m.ratio >= NON_TEXT_MIN,
          { ratio: m.ratio, fg: m.fg, alpha: m.alpha, bg: m.bg, station: m.station });
      }
    }
    evidence.lightsSeen = [...new Set(Object.values(perStation).flat().flatMap(v => v.result.nonText.map(e => e.kind))
      .filter(kind => kind.startsWith('light')))];
  });
