// WCAG contrast of the design tokens (SPEC §8.1, §10.1). Parses ui/app/styles/tokens.css for the dark-only product and checks
// the required pairs of the visual-language study §5.2 (light) and §5.3 (dark). The two tables list the same 73
// token pairs, so one table is evaluated in each theme: 103 required pairs in the active dark palette. The five "info" rows of each
// table are decorative, have no minimum, and are not encoded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../ui/app/styles/tokens.css', import.meta.url), 'utf8');
const TEXT = 4.5, UI = 3;
const SURFACES = ['--canvas', '--surface', '--surface-2', '--surface-3', '--raised'];

/** [foreground, background, minimum, use] — rows 1–73 of VL §5.2 / §5.3, in order. */
export const PAIRS = [
  ...[...SURFACES, '--accent-soft'].map(bg => ['--ink', bg, TEXT, 'body text']),                          // 1–6
  ...[...SURFACES, '--accent-soft'].map(bg => ['--ink-2', bg, TEXT, 'secondary text']),                   // 7–12
  ...[...SURFACES, '--accent-soft'].map(bg => ['--ink-3', bg, TEXT, 'tertiary text']),                    // 13–18
  ...[...SURFACES, '--accent-soft'].map(bg => ['--accent', bg, TEXT, 'link, current tab label']),         // 19–24
  ['--accent-strong', '--surface', TEXT, 'link hover'],                                                   // 25
  ['--on-accent', '--accent', TEXT, 'primary button'],                                                    // 26
  ['--on-accent', '--accent-strong', TEXT, 'primary button hover and pressed'],                           // 27
  ['--ink-3', '--surface-2', TEXT, 'disabled control label'],                                             // 28
  ['--sys-confidence', '--surface', TEXT, 'certainty check label'],                                       // 29
  ['--sys-confidence', '--sys-confidence-soft', TEXT, 'certainty check on its soft fill'],               // 30
  ['--sys-reader', '--surface', TEXT, 'reader label'],                                                    // 31
  ['--sys-reader', '--sys-reader-soft', TEXT, 'reader on its soft fill'],                                 // 32
  ...['filed', 'review', 'failed'].flatMap(outcome => [
    [`--${outcome}`, `--${outcome}-soft`, TEXT, `${outcome} outcome pill`],                               // 33, 41, 49
    ...SURFACES.map(bg => [`--${outcome}`, bg, TEXT, `${outcome} outcome text or count`]),                // 34–38, 42–46, 50–54
    ['--ink', `--${outcome}-soft`, TEXT, `body text in a ${outcome} banner`],                             // 39, 47, 55
    ['--ink-2', `--${outcome}-soft`, TEXT, `secondary text in a ${outcome} banner`]                       // 40, 48, 56
  ]),
  ...['--surface', '--surface-2', '--raised'].map(bg => ['--line-strong', bg, UI, 'input, checkbox, radio border']), // 57–59
  ...SURFACES.map(bg => ['--accent', bg, UI, 'focus ring and tab indicator']),                            // 60–64
  ['--accent', '--track', UI, 'progress fill'],                                                           // 65
  ...['filed', 'review', 'failed'].flatMap(outcome => [
    [`--${outcome}`, '--track', UI, `${outcome} outcome meter`],                                          // 66, 68, 70
    [`--${outcome}`, '--surface', UI, `${outcome} outcome swatch`]                                        // 67, 69, 71
  ]),
  ['--sys-confidence', '--surface', UI, 'certainty check rule'],                                          // 72
  ['--sys-reader', '--surface', UI, 'reader rule'],                                                       // 73
  // VISUAL-SPEC-v2 §2.6: the light, the leading edge, red non-text, the outcome fills, the cut, the primary.
  ...['--canvas', '--surface', '--surface-2', '--raised', '--accent-soft'].map(bg => ['--light', bg, UI, 'the live light']), // 74–78
  ...['--canvas', '--surface', '--raised', '--track'].map(bg => ['--trail', bg, UI, 'leading edge, bar head']),          // 79–82
  ['--ink-3', '--track', UI, 'muted leading edge, grey ring'],                                                            // 83
  ...['--canvas', '--surface', '--surface-2', '--raised', '--track'].map(bg => ['--fail-line', bg, UI, 'red: failed light, rule, edge']), // 84–88
  ['--failed', '--accent-soft', TEXT, 'failure word in an open row'],                                                    // 89
  ...['filed', 'review', 'failed'].flatMap(outcome =>
    ['--surface', '--raised', '--track'].map(bg => [`--${outcome}-bar`, bg, UI, `${outcome} fill`])),                    // 90–98
  ...['filed', 'review', 'failed'].map(outcome => ['--raised', `--${outcome}-bar`, UI, `the cut between segments (${outcome})`]), // 99–101
  ['--on-accent', '--primary-1', TEXT, 'primary button, top'],                                                            // 102
  ['--on-accent', '--primary-2', TEXT, 'primary button, bottom']                                                          // 103
];

/** Themed tokens: each theme declares every one of them itself (VISUAL-SPEC-v2 §2.2–2.3). */
const THEMED = ['color-scheme', '--canvas', '--surface', '--surface-2', '--surface-3', '--raised', '--scrim',
  '--ink', '--ink-2', '--ink-3', '--line', '--line-2', '--line-strong', '--track', '--accent', '--accent-strong',
  '--accent-soft', '--on-accent', '--trail', '--glow', '--light', '--primary-1', '--primary-2', '--reading-fill',
  '--sys-confidence', '--sys-confidence-soft', '--sys-reader', '--sys-reader-soft', '--filed', '--filed-soft',
  '--filed-bar', '--review', '--review-soft', '--review-bar', '--failed', '--failed-soft', '--failed-bar', '--fail-line',
  '--light-glow', '--light-glow-soft', '--fail-glow', '--edge-lit', '--fail-edge-lit', '--trace-band', '--fail-trace-band',
  '--sheen', '--ground-glow-1', '--ground-glow-2', '--lattice', '--focus-halo', '--hold-a', '--status-halo-strength',
  '--shadow-1', '--shadow-2', '--inner-highlight'];
/** Non-themed tokens: declared once, in :root (VISUAL-SPEC-v2 §2.4, §7.2). */
const SHARED = ['--font-sans', '--font-display', '--font-mono', '--fs-12', '--fs-13', '--fs-14', '--fs-15', '--fs-17',
  '--fs-20', '--fs-24', '--fs-26', '--fs-30', '--fs-40', '--fs-hero', '--fs-h1', '--fs-count', '--fs-tally', '--fs-spend',
  '--lh-tight', '--lh-snug', '--lh-body', '--lh-read', '--lh-display', '--lh-count', '--fw-light', '--fw-regular',
  '--fw-medium', '--fw-semibold', '--tracking-display', '--tracking-hero', '--tracking-count', '--tracking-heading',
  '--tracking-body', '--tracking-overline', '--measure', '--measure-narrow', '--measure-now', '--sp-0-5', '--sp-1',
  '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-7', '--sp-8', '--sp-9', '--sp-10', '--sp-11', '--r-xs',
  '--r-sm', '--r', '--r-card', '--r-lg', '--r-xl', '--r-pill', '--control-h', '--control-h-sm', '--control-h-xl',
  '--icon-btn', '--track-h', '--track-h-lg', '--tab-indicator', '--focus-width', '--focus-offset', '--page-max',
  '--gutter', '--stage-narrow', '--stage-wide', '--topbar-h', '--runstrip-h', '--row-h', '--panel-w', '--spine-w',
  '--spine-gap', '--light-dot', '--dur-press', '--dur-hover', '--dur-reveal', '--dur-word', '--dur-change', '--dur-fail',
  '--dur-rule', '--dur-list', '--dur-roll', '--dur-exit', '--dur-exit-launch', '--dur-pane', '--dur-move', '--dur-fill',
  '--dur-flash', '--dur-trace', '--dur-trace-open', '--dur-pulse', '--dur-beat', '--dur-settle', '--dur-hold',
  '--dur-power', '--dur-tick', '--dur-spine', '--dur-ignite', '--dur-handoff', '--delay-ignite', '--dur-show', '--dur-tab',
  '--dur-ambient', '--dur-sweep',
  '--stagger', '--stagger-word', '--stagger-head', '--stagger-digit', '--stagger-row', '--ease-out', '--ease-glide',
  '--ease-roll', '--ease-fill', '--ease-trace', '--ease-leave', '--ease-in', '--ease-inout', '--ease-beat', '--ease-linear'];
/** Every token of the light block. */
const REQUIRED = [...THEMED, ...SHARED];
/** Themed tokens that are effects, not plain colours (excluded from the hex check). */
const EFFECTS = ['color-scheme', '--scrim', '--glow', '--light-glow', '--light-glow-soft', '--fail-glow', '--edge-lit',
  '--fail-edge-lit', '--trace-band', '--fail-trace-band', '--sheen', '--ground-glow-1', '--ground-glow-2', '--lattice',
  '--focus-halo', '--hold-a', '--status-halo-strength', '--shadow-1', '--shadow-2', '--inner-highlight'];
/** The themed tokens that are plain colours (6-digit hex). */
const COLOURS = THEMED.filter(name => !EFFECTS.includes(name));

/** Blocks of a stylesheet as {path: selectors from outermost, declarations: Map}. Comments are ignored. */
function blocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [], open = [];
  let buffer = '';
  for (const ch of text) {
    if (ch === '{') { open.push({ selector: buffer.trim().replace(/\s+/g, ' '), body: '' }); buffer = ''; continue; }
    if (ch === '}') {
      const block = open.pop();
      assert.ok(block, 'tokens.css has balanced braces');
      block.body += buffer;
      buffer = '';
      const declarations = new Map();
      for (const [, name, value] of block.body.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) {
        assert.ok(!declarations.has(name), `${block.selector} declares ${name} once`);
        declarations.set(name, value.trim());
      }
      found.push({ path: [...open.map(parent => parent.selector), block.selector], declarations });
      continue;
    }
    buffer += ch;
    if (ch === ';' && open.length) { open[open.length - 1].body += buffer; buffer = ''; }
  }
  assert.equal(open.length, 0, 'tokens.css has balanced braces');
  return found;
}

function block(path) {
  const matches = blocks(CSS).filter(item => item.path.join(' | ') === path.join(' | '));
  assert.equal(matches.length, 1, `tokens.css has exactly one block ${path.join(' ')}`);
  return matches[0].declarations;
}

const DARK = block([':root']);

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a 6-digit hex colour`);
  const [r, g, b] = [1, 3, 5].map(at => channel(parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x contrast ratio. */
export function contrast(foreground, background) {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

function failures(theme, name) {
  const failed = [];
  for (const [fg, bg, minimum, use] of PAIRS) {
    const foreground = theme.get(fg), background = theme.get(bg);
    if (foreground === undefined || background === undefined) {
      failed.push(`${name}: ${foreground === undefined ? fg : bg} is missing (${use})`);
      continue;
    }
    const ratio = contrast(foreground, background);
    if (ratio < minimum) failed.push(`${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${minimum}:1 (${use})`);
  }
  return failed;
}

test('the pair table is VL §5.2–5.3 plus VISUAL-SPEC-v2 §2.6: 103 pairs per theme, 59 text and 44 non-text', () => {
  assert.equal(PAIRS.length, 103);
  assert.equal(PAIRS.filter(pair => pair[2] === TEXT).length, 59);
  assert.equal(PAIRS.filter(pair => pair[2] === UI).length, 44);
  assert.deepEqual(PAIRS[0].slice(0, 3), ['--ink', '--canvas', TEXT]);
  assert.deepEqual(PAIRS[25].slice(0, 3), ['--on-accent', '--accent', TEXT]);
  assert.deepEqual(PAIRS[48].slice(0, 3), ['--failed', '--failed-soft', TEXT]);
  assert.deepEqual(PAIRS[56].slice(0, 3), ['--line-strong', '--surface', UI]);
  assert.deepEqual(PAIRS[72].slice(0, 3), ['--sys-reader', '--surface', UI]);
  for (const [fg, bg] of PAIRS) assert.ok(COLOURS.includes(fg) && COLOURS.includes(bg), `${fg} on ${bg} are colour tokens`);
});

test('the contrast formula reproduces the study’s recorded ratios', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#777777').toFixed(2), '1.00');
  assert.equal(contrast('#18212C', '#EEF1F5').toFixed(2), '14.34');   // light 1
  assert.equal(contrast('#5A6674', '#E6EAF0').toFixed(2), '4.85');    // light 16
  assert.equal(contrast('#0B1733', '#86A9FF').toFixed(2), '7.71');    // dark 26
  assert.equal(contrast('#667384', '#1B2430').toFixed(2), '3.24');    // dark 59
});

test('dark-only tokens are the default, with every required colour and motion token', () => {
  assert.deepEqual(REQUIRED.filter(name => !DARK.has(name)), [], 'default dark block');
  assert.deepEqual([...DARK.keys()].filter(name => !REQUIRED.includes(name)), [], 'only declared tokens');
  assert.equal(DARK.get('color-scheme'), 'dark');
  for (const token of COLOURS) assert.match(DARK.get(token), /^#[0-9A-F]{6}$/i, token);
});

test('no stored/system-light CSS branch can replace the dark default', () => {
  assert.doesNotMatch(CSS, /:root\[data-theme|prefers-color-scheme/);
});

test('dark theme: 103 of 103 required pairs meet their minimum', t => {
  assert.deepEqual(failures(DARK, 'dark'), []);
  t.diagnostic(`${PAIRS.length} of ${PAIRS.length} required pairs pass (dark-only)`);
});

test('a missing token or a failing pair is reported, not skipped', () => {
  const broken = new Map(DARK);
  broken.delete('--ink-3');
  broken.set('--review', '#182129');
  const failed = failures(broken, 'probe');
  assert.ok(failed.some(line => line.includes('--ink-3 is missing')));
  assert.ok(failed.some(line => line.includes('--review on --canvas')));
});
