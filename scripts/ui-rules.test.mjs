// UI source rules enforced in the gate (SPEC §5.5 rules 1–13, plus layer rule L2 of §4.1, plus rule 14: never the word
// "fast" in a string or template literal, the AGENTS UI rule for the short literals rule 12 lets through).
// Scans ui/app/**/*.ts as text, with comments ignored. Every file is scanned: the legacy UI was deleted at the cutover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../ui/app/', import.meta.url));
/** Removed together with this exclusion by WP-13 (SPEC §11); the tripwire test below fails once they are gone. */
const REVIEW_NOTE = 'ui-rules: non-operational button';
const BUTTON_FILES = ['view/action.ts', 'components/disclosure.ts', 'components/show-control.ts',
  'components/confirm-sheet.ts', 'components/results-table.ts', 'components/evidence-drawer.ts',
  'components/folder-pick.ts', 'components/radio-cards.ts', 'shell/top-bar.ts', 'shell/run-header.ts',
  'shell/journey-rail.ts'];
const TIMER_FILES = ['state/poller.ts', 'state/clock.ts', 'view/motion.ts', 'view/action.ts', 'view/a11y.ts'];
const VIEW_LAYERS = new Set(['screens', 'components', 'shell']);
/** Property names whose string value is user-visible text (rule 12). */
const VISIBLE_KEYS = new Set(['text', 'label', 'title', 'placeholder', 'alt', 'note', 'aria-label',
  'aria-description', 'aria-valuetext']);
const EXPRESSION_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);

/** Rule 14: the word "fast" (and "faster", "fastest") in a string or template literal. Comments and identifiers are not text. */
const FAST = /\bfast/i;
const nowhere = () => false;
const only = (...files) => file => files.includes(file);

/** Regex rules over the comment-free source. `allowed(file)` names the only files that may match. */
const PATTERN_RULES = [
  { id: 1, title: 'no HTML parsing or injection', allowed: nowhere, patterns: [
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment)\b/,
    /\bdocument\s*\.\s*write(?:ln)?\s*\(/] },
  { id: 2, title: 'no inline styles except CSS custom properties', allowed: nowhere, patterns: [
    /\.style\s*\.\s*cssText\b/,
    /\bsetAttribute\s*\(\s*['"`]style['"`]/,
    /\.style\s*\.\s*(?!setProperty\b|removeProperty\b|getPropertyValue\b)[A-Za-z_$][\w$]*\s*(?:[-+]?=(?!=))/,
    /\.style\s*=(?!=)/,
    /\.style\s*\[/,
    /\bObject\s*\.\s*assign\s*\(\s*[\w$.]*\.style\b/,
    /\b(?:attrs|props)\s*:\s*\{[^}]*?(?:^|[{,\s])['"]?style['"]?\s*:/] },
  // A property name that is not a literal custom property; view/dom.ts implements `vars`, typed `--${string}`.
  { id: 2, title: 'setProperty only for CSS custom properties', allowed: only('view/dom.ts'),
    patterns: [/\.style\s*\.\s*(?:setProperty|removeProperty)\s*\(\s*(?!['"`]--)/] },
  { id: 3, title: 'replaceChildren only in view/dom.ts', allowed: only('view/dom.ts'),
    patterns: [/(?<![\w$])replaceChildren\s*\(/] },
  { id: 4, title: 'fetch only in api/client.ts', allowed: only('api/client.ts'),
    patterns: [/(?<![\w$.])fetch\s*\(/, /\b(?:window|globalThis|self)\s*\.\s*fetch\b/] },
  { id: 5, title: 'Web Storage only in persist/local-keys.ts', allowed: only('persist/local-keys.ts'),
    patterns: [/\b(?:localStorage|sessionStorage)\b/] },
  { id: 6, title: 'IndexedDB only in persist/', allowed: file => /^persist\/[^/]+\.ts$/.test(file),
    patterns: [/\bindexedDB\b/] },
  { id: 7, title: 'timers only in the poller, clock, motion, action, a11y and controllers',
    allowed: file => TIMER_FILES.includes(file) || /^controllers\/[^/]+\.ts$/.test(file),
    patterns: [/(?<![\w$])(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/] },
  // Rule 8 (no `suggestRunMode` in ui/app) went with the function: every run is Interactive and nothing suggests a mode.
  { id: 9, title: 'no window.open', allowed: nowhere,
    patterns: [/\b(?:window|globalThis|self)\s*\.\s*open\s*\(/] },
  { id: 13, title: 'mount only in main.ts and shell/stage-host.ts',
    allowed: only('main.ts', 'shell/stage-host.ts', 'view/dom.ts'),
    patterns: [/(?<![\w$])(?<!function\s+)mount\s*\(/] }
];

/** A small TypeScript lexer: strings, templates (with nested expressions), regex literals and comments. */
export function lex(source) {
  const tokens = [], blanked = source.split(''), templates = [];
  const n = source.length;
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (blanked[k] !== '\n') blanked[k] = ' '; };
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'punct') return prev.value !== ')' && prev.value !== ']';
    if (prev.type === 'ident') return EXPRESSION_KEYWORDS.has(prev.value);
    return false;
  };
  const readTemplate = token => {
    let text = '';
    while (i < n) {
      const c = source[i];
      if (c === '\\') { text += source.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i++; token.parts.push(text); token.end = i; return; }
      if (c === '$' && source[i + 1] === '{') { token.parts.push(text); i += 2; templates.push({ token, depth: 0 }); return; }
      text += c;
      i++;
    }
    token.parts.push(text);
    token.end = n;
  };
  while (i < n) {
    const c = source[i], next = source[i + 1], start = i;
    if (c === '/' && next === '/') { let end = source.indexOf('\n', i); if (end < 0) end = n; blank(i, end); i = end; continue; }
    if (c === '/' && next === '*') { let end = source.indexOf('*/', i + 2); end = end < 0 ? n : end + 2; blank(i, end); i = end; continue; }
    if (/[\s﻿]/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      i++;
      let text = '';
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') { text += source.slice(i, i + 2); i += 2; } else { text += source[i]; i++; }
      }
      i++;
      tokens.push({ type: 'str', value: text, start, end: i });
      continue;
    }
    if (c === '`') {
      const token = { type: 'tmpl', parts: [], start, end: start };
      tokens.push(token);
      i++;
      readTemplate(token);
      continue;
    }
    if (c === '}' && templates.length && templates[templates.length - 1].depth === 0) {
      i++;
      readTemplate(templates.pop().token);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const ch = source[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(source[i])) i++;
      tokens.push({ type: 'regex', value: source.slice(start, i), start, end: i });
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      while (i < n && /[\w$\u0080-￿]/.test(source[i])) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i), start, end: i });
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(source[i])) i++;
      tokens.push({ type: 'num', value: source.slice(start, i), start, end: i });
      continue;
    }
    if (templates.length) {
      if (c === '{') templates[templates.length - 1].depth++;
      else if (c === '}') templates[templates.length - 1].depth--;
    }
    tokens.push({ type: 'punct', value: c, start, end: i + 1 });
    i++;
  }
  return { tokens, code: blanked.join('') };
}

const tokenText = token => (token.type === 'tmpl' ? token.parts.join(' ') : token.value);
const wordCount = text => text.split(/\s+/).filter(word => /\p{L}/u.test(word)).length;
const isPunct = (token, value) => token?.type === 'punct' && token.value === value;

/** Rule 12: string literals of three or more words as h() children, or as visible-text property values. */
function hardCodedCopy(tokens) {
  const found = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k], prev = tokens[k - 1];
    if (token.type === 'ident' && token.value === 'h' && isPunct(tokens[k + 1], '(') &&
        !isPunct(prev, '.') && !(prev?.type === 'ident' && prev.value === 'function')) {
      const brackets = [];
      let argument = 0;
      for (let m = k + 2; m < tokens.length; m++) {
        const item = tokens[m];
        if (item.type === 'punct') {
          if ('([{'.includes(item.value)) { brackets.push(item.value); continue; }
          if (')]}'.includes(item.value)) { if (!brackets.length) break; brackets.pop(); continue; }
          if (item.value === ',' && !brackets.length) { argument++; continue; }
        }
        const direct = brackets.length === 0 || (brackets.length === 1 && brackets[0] === '[');
        if (argument >= 2 && direct && (item.type === 'str' || item.type === 'tmpl') && wordCount(tokenText(item)) >= 3)
          found.push(item);
      }
    }
    if ((token.type === 'ident' || token.type === 'str') && VISIBLE_KEYS.has(token.value) &&
        (isPunct(prev, '{') || isPunct(prev, ',')) && isPunct(tokens[k + 1], ':')) {
      const value = tokens[k + 2];
      if ((value?.type === 'str' || value?.type === 'tmpl') && wordCount(tokenText(value)) >= 3) found.push(value);
    }
  }
  return found;
}

function importsOf(code) {
  const specifiers = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g;
  for (let match; (match = pattern.exec(code));) specifiers.push({ specifier: match[2], index: match.index });
  return specifiers;
}

/** The ui/app-relative path an import resolves to, or null when it points outside ui/app or to a package. */
function resolveImport(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return target.startsWith('../') || target === '..' ? null : target;
}

const layer = file => (file.includes('/') ? file.slice(0, file.indexOf('/')) : '');

/** Every rule violation in one ui/app file (`file` is relative to ui/app, with '/' separators). */
export function checkSource(file, source) {
  const { tokens, code } = lex(source);
  const lines = source.split('\n');
  const lineOf = index => source.slice(0, index).split('\n').length;
  const violations = [];
  const report = (rule, index, detail) =>
    violations.push({ rule, file, line: lineOf(index), detail: detail ?? lines[lineOf(index) - 1].trim() });
  for (const rule of PATTERN_RULES) {
    if (rule.allowed(file)) continue;
    for (const pattern of rule.patterns) {
      const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (let match; (match = global.exec(code));) report(rule.id, match.index);
    }
  }
  const imports = importsOf(code).map(item => ({ ...item, target: resolveImport(file, item.specifier) }));
  if (VIEW_LAYERS.has(layer(file)))
    for (const { target, index, specifier } of imports) {
      if (target === null) continue;
      const targetLayer = layer(target);
      if (targetLayer === 'api' || targetLayer === 'persist' ||
          (targetLayer === 'controllers' && target !== 'controllers/registry.ts'))
        report(10, index, `a view imports ${specifier}`);
    }
  if (layer(file) === 'controllers')
    for (const { target, index, specifier } of imports)
      if (target !== null && ['shell', 'screens', 'components', 'view'].includes(layer(target)))
        report('L2', index, `a controller imports ${specifier}`);
  if (!BUTTON_FILES.includes(file)) {
    const button = /(?:(?<![\w$.])h\s*\(\s*|\bcreateElement\s*\(\s*)['"`]button['"`]/g;
    for (let match; (match = button.exec(code));) {
      const line = lineOf(match.index);
      if (!(lines[line - 1].includes(REVIEW_NOTE) || (lines[line - 2] ?? '').includes(REVIEW_NOTE))) report(11, match.index);
    }
  }
  for (const token of hardCodedCopy(tokens)) report(12, token.start, `hard-coded copy ${JSON.stringify(tokenText(token))}`);
  // AGENTS UI rule "never the word fast", for the short literals rule 12 lets through (copy-lint.test.ts scans the copy).
  for (const token of tokens)
    if ((token.type === 'str' || token.type === 'tmpl') && FAST.test(tokenText(token)))
      report(14, token.start, `the word "fast" in ${JSON.stringify(tokenText(token))}`);
  return violations;
}

function uiFiles(directory = ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...uiFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relative(ROOT, full).split(sep).join('/'));
  }
  return files.sort();
}

const hits = (file, source) => checkSource(file, source).map(v => v.rule);

test('each rule catches its violation and allows its exceptions (fixtures)', () => {
  const cases = [
    [1, 'screens/a.ts', 'el.innerHTML = value;', true],
    [1, 'screens/a.ts', '// never set innerHTML here\nconst x = 1; /* or outerHTML */', false],
    [1, 'screens/a.ts', 'document.write(x);', true],
    [1, 'components/b.ts', 'const parser = new DOMParser();', true],
    [2, 'screens/a.ts', "el.style.color = 'red';", true],
    [2, 'screens/a.ts', "el.style.setProperty('--fill', String(0.5));", false],
    [2, 'screens/a.ts', "el.style.setProperty('color', 'red');", true],
    [2, 'screens/a.ts', 'el.style.setProperty(name, value);', true],
    [2, 'view/dom.ts', 'el.style.setProperty(name, value);', false],
    [2, 'view/dom.ts', "el.style.color = 'red';", true],
    [2, 'screens/a.ts', 'el.style.cssText = s;', true],
    [2, 'screens/a.ts', "el.setAttribute('style', s);", true],
    [2, 'screens/a.ts', "Object.assign(el.style, { color: 'red' });", true],
    [2, 'screens/a.ts', "h('p', { attrs: { id: 'x', style: css } });", true],
    [2, 'screens/a.ts', "h('p', { props: { 'style': css } });", true],
    [2, 'components/chip.ts', "chip({ label, style: 'dashed' });", false],
    [3, 'screens/a.ts', 'host.replaceChildren(node);', true],
    [3, 'view/dom.ts', 'host.replaceChildren(node);', false],
    [4, 'state/run-store.ts', "const r = await fetch('/api/runs');", true],
    [4, 'state/run-store.ts', 'const r = await window.fetch(path);', true],
    [4, 'api/client.ts', 'const r = await fetch(path, init);', false],
    [4, 'state/run-store.ts', 'store.prefetch(path);', false],
    [5, 'state/x.ts', "localStorage.getItem('k');", true],
    [5, 'persist/local-keys.ts', "sessionStorage.setItem('k', v);", false],
    [6, 'state/x.ts', "indexedDB.open('db');", true],
    [6, 'persist/journey-db.ts', "indexedDB.open('db');", false],
    [7, 'screens/a.ts', 'setTimeout(tick, 5);', true],
    [7, 'view/dom.ts', 'requestAnimationFrame(draw);', true],
    [7, 'controllers/send.ts', 'setTimeout(tick, 5);', false],
    [7, 'state/poller.ts', 'const t = setInterval(tick, 5);', false],
    [9, 'shell/top-bar.ts', 'window.open(url);', true],
    [10, 'screens/a.ts', "import { request } from '../api/client.ts';", true],
    [10, 'components/b.ts', "import type { Keys } from '../persist/local-keys.ts';", true],
    [10, 'shell/c.ts', "import { run } from '../controllers/send.ts';", true],
    [10, 'screens/a.ts', "import type { Registry } from '../controllers/registry.ts';", false],
    [10, 'screens/a.ts', "import { h } from '../view/dom.ts';", false],
    [10, 'state/app-store.ts', "import { request } from '../api/client.ts';", false],
    ['L2', 'controllers/send.ts', "import { h } from '../view/dom.ts';", true],
    ['L2', 'controllers/send.ts', "import { request } from '../api/client.ts';", false],
    [11, 'screens/a.ts', "h('button', { class: 'btn' }, label);", true],
    [11, 'screens/a.ts', "const b = document.createElement('button');", true],
    [11, 'screens/a.ts', `// ${REVIEW_NOTE}: opens a local panel\nh('button', null, label);`, false],
    [11, 'components/radio-cards.ts', "h('button', null, label);", false],
    [12, 'screens/a.ts', "h('p', null, 'Three words here');", true],
    [12, 'screens/a.ts', "h('p', { class: 'lead' }, copy.lead, ' · ', 'Two words');", false],
    [12, 'screens/a.ts', "h('p', { text: 'Hard coded sentence' });", true],
    [12, 'screens/a.ts', "h('p', { attrs: { 'aria-label': 'Hard coded label text' } });", true],
    [12, 'screens/a.ts', "h('ul', null, ['One two three']);", true],
    [12, 'screens/a.ts', 'h(\'p\', null, `${count} documents were read`);', true],
    [12, 'screens/a.ts', "action({ id, label: 'Send it now', run });", true],
    [12, 'screens/a.ts', "const shown = flag ? text : 'three word string';", false],
    [12, 'screens/a.ts', "h('div', { class: 'one two three' }, h('span', { class: 'a b c' }));", false],
    [12, 'screens/a.ts', "const pattern = /it's \"odd\" text/; h('p', null, copy.x);", false],
    [13, 'screens/a.ts', 'mount(host, view);', true],
    [13, 'shell/stage-host.ts', 'mount(host, view);', false],
    [13, 'main.ts', 'mount(host, shell);', false],
    [13, 'screens/a.ts', 'function mount(host) { return host; }', false],
    [14, 'screens/a.ts', "const label = 'Fast';", true],
    [14, 'components/b.ts', 'const note = `${n} faster`;', true],
    [14, 'screens/a.ts', '// the fastest text on the page\nconst x = 1;', false],
    [14, 'screens/a.ts', 'const s = `So ${fast} it`;', false],
    [14, 'screens/a.ts', "const meal = 'breakfast';", false]
  ];
  for (const [rule, file, source, expected] of cases)
    assert.equal(hits(file, source).includes(rule), expected, `rule ${rule} on ${file}: ${source}`);
});

test('the lexer keeps strings, templates and regex literals apart from comments', () => {
  const { tokens, code } = lex("const a = 'x // y'; /* c */ const b = `t ${f({ k: 1 })} u` / 2; const r = /\\/[/]/g;");
  assert.ok(!code.includes('/* c */'));
  assert.ok(code.includes("'x // y'"));
  assert.deepEqual(tokens.filter(t => t.type === 'str').map(t => t.value), ['x // y']);
  assert.deepEqual(tokens.find(t => t.type === 'tmpl').parts, ['t ', ' u']);
  assert.equal(tokens.filter(t => t.type === 'regex').length, 1);
});

test('ui/app follows every rule', () => {
  const files = uiFiles();
  assert.ok(files.includes('main.ts'), 'main.ts is scanned');
  const violations = files.flatMap(file => checkSource(file, readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(violations.map(v => `${v.file}:${v.line} rule ${v.rule}: ${v.detail}`), []);
});

test('the legacy UI files are gone (the cutover deleted them)', () => {
  for (const file of ['app.ts', 'preflight.ts', 'categories.ts', 'reference.ts', 'style.css'])
    assert.ok(!existsSync(join(ROOT, file)), `${file} must not come back: the rebuilt UI replaced it`);
});

test('index.html is the rebuilt entry point: theme boot in head, #app, and the main.ts module', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(html, /<html lang="en" data-theme="dark">/);
  assert.match(head, /<meta charset="UTF-8">/i);
  assert.match(head, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(head, /<meta name="color-scheme" content="dark">/);
  assert.match(head, /<title><\/title>/);
  assert.match(head, /<script src="\/theme-boot\.js"><\/script>/);
  assert.match(html, /<div id="app"><\/div>/);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map(match => match[0]),
    ['<script src="/theme-boot.js"></script>', '<script type="module" src="./main.ts"></script>'],
    'exactly the classic theme boot and the main.ts module, with no inline script');
  assert.doesNotMatch(html, /\sstyle=/);
  const boot = readFileSync(join(ROOT, 'public', 'theme-boot.js'), 'utf8');
  assert.match(boot, /dataset\.theme = 'dark'/);
  assert.doesNotMatch(boot, /localStorage|matchMedia/);
  assert.doesNotMatch(boot, /\b(?:import|export)\b/, 'a classic blocking script, not a module');
});
