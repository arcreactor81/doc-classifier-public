/**
 * DOM helpers for the rebuilt UI (SPEC §5.2). Views build elements with `h`, and bind them to signals.
 *
 * - Binding: a `Read` in any prop or child becomes an effect owned by the current root. It writes only the attribute,
 *   property, text or custom property it is bound to, and only when the value differs from the last one it wrote.
 *   A binding outside any owner throws: create views inside `mount()` (or a `root()`).
 * - `each`: keyed rows between two comment anchors; each row lives in its own root and updates through its own
 *   `Read`. An order change costs O(n) moves through `moveNode`; a content change costs no move at all.
 * - `show` / `match`: swap content only when the boolean or key actually changes, and dispose the branch they leave.
 * - `mount`: `root()` plus `host.replaceChildren(view())`. Only `main.ts` and `shell/stage-host.ts` call it.
 *
 * Text is always set through `textContent` / `Text.data`; nothing here parses HTML, and markup properties and
 * attributes are refused. Inline styles are refused: only CSS custom properties are written, through `vars`.
 * DOM `props` are written after the children are appended, so a `<select>` keeps the `value` it is given.
 */
import {
  batch, effect, getOwner, onCleanup, root, runWithOwner, untrack, type Dispose, type Owner, type Read
} from '../../../core/ui/reactive.ts';

type R<T> = T | Read<T>;
export type Child = Node | string | number | Read<string | number> | null | undefined | false | readonly Child[];
export interface Props<E extends Element> {
  class?: R<string>;
  classes?: Record<string, R<boolean>>;
  text?: R<string>;
  attrs?: Record<string, R<string | number | boolean | null>>;
  props?: { [K in keyof E]?: R<E[K]> };
  vars?: Record<`--${string}`, R<string | number>>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
  ref?: (el: E) => void;
  testid?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const UNSET: unique symbol = Symbol('unset');

function isRead(value: unknown): value is Read<unknown> {
  return typeof value === 'function' && typeof (value as { peek?: unknown }).peek === 'function';
}

function requireOwner(what: string): Owner {
  const owner = getOwner();
  if (owner === null) throw new Error(`${what} needs an owner: build views inside mount() or root().`);
  return owner;
}

/** Writes `value` now, or binds it: an owned effect that writes only when the value differs from the last write. */
function bind<T>(value: R<T>, write: (next: T) => void): void {
  if (!isRead(value)) {
    write(value);
    return;
  }
  requireOwner('A reactive binding');
  const read = value as Read<T>;
  let last: T | typeof UNSET = UNSET;
  effect(() => {
    const next = read();
    if (last !== UNSET && Object.is(next, last)) return;
    last = next;
    untrack(() => write(next));
  });
}

function attrValue(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return '';
  return String(value);
}

function writeAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function checkAttrName(name: string): void {
  const lower = name.toLowerCase();
  if (lower === 'style') throw new Error('h(): inline styles are refused; bind CSS custom properties through vars.');
  if (lower.startsWith('on')) throw new Error(`h(): inline handler attribute "${name}" is refused; use on.`);
  if (lower === 'srcdoc') throw new Error('h(): markup attributes are refused; build nodes with h() and text.');
}

/** Property names that parse markup (the names ending in "HTML") are refused, even from a computed key. */
const MARKUP_PROPERTY = /HTML$/;

/** Refuses inline-style and markup DOM properties before anything is created. */
function checkDomPropNames(props: object): void {
  for (const name of Object.keys(props)) {
    if (name === 'style') throw new Error('h(): inline styles are refused; bind CSS custom properties through vars.');
    if (MARKUP_PROPERTY.test(name) || name.toLowerCase() === 'srcdoc') {
      throw new Error(`h(): the markup property "${name}" is refused; build nodes with h() and text.`);
    }
  }
}

/**
 * DOM properties are written after the children are appended: a `<select>`'s `value` (or `selectedIndex`) set
 * before its options exist would be lost, and the first option would show as chosen.
 */
function applyDomProps<E extends Element>(el: E, props: NonNullable<Props<E>['props']>): void {
  for (const [name, value] of Object.entries(props) as [string, unknown][]) {
    bind(value, next => { (el as unknown as Record<string, unknown>)[name] = next; });
  }
}

function bindAttr(el: Element, name: string, value: R<string | number | boolean | null>): void {
  checkAttrName(name);
  if (!isRead(value)) {
    writeAttr(el, name, attrValue(value));
    return;
  }
  const normalised: Read<string | null> = Object.assign(() => attrValue(value()), { peek: () => attrValue(value.peek()) });
  bind(normalised, next => writeAttr(el, name, next));
}

function tokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function applyProps<E extends Element>(el: E, props: Props<E>): void {
  if (props.class !== undefined) {
    let current: string[] = [];
    bind(props.class, next => {
      const wanted = tokens(next);
      for (const token of current) if (!wanted.includes(token)) el.classList.remove(token);
      for (const token of wanted) if (!el.classList.contains(token)) el.classList.add(token);
      current = wanted;
    });
  }
  if (props.classes !== undefined) {
    for (const [name, on] of Object.entries(props.classes)) {
      bind(on, next => { if (el.classList.contains(name) !== Boolean(next)) el.classList.toggle(name, Boolean(next)); });
    }
  }
  if (props.attrs !== undefined) {
    for (const [name, value] of Object.entries(props.attrs)) bindAttr(el, name, value);
  }
  // `props.props` is applied by h() after the children (applyDomProps).
  if (props.vars !== undefined) {
    const style = (el as unknown as ElementCSSInlineStyle).style;
    for (const [name, value] of Object.entries(props.vars) as [string, R<string | number>][]) {
      if (!name.startsWith('--')) throw new Error(`h(): vars accepts CSS custom properties only, not "${name}".`);
      bind(value, next => {
        const text = String(next);
        if (style.getPropertyValue(name) !== text) style.setProperty(name, text);
      });
    }
  }
  if (props.on !== undefined) {
    for (const [type, handler] of Object.entries(props.on) as [string, (ev: Event) => void][]) {
      if (typeof handler !== 'function') continue;
      // Handlers run untracked, and their writes flush once, at the end.
      el.addEventListener(type, event => batch(() => untrack(() => handler(event))));
    }
  }
  if (props.testid !== undefined) el.setAttribute('data-testid', props.testid);
}

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child as readonly Child[]) appendChild(parent, item);
    return;
  }
  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }
  if (typeof child === 'string' || typeof child === 'number') {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  if (isRead(child)) {
    parent.appendChild(text(child as Read<string | number>));
    return;
  }
  throw new TypeError(`h(): unsupported child of type ${typeof child}.`);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props<HTMLElementTagNameMap[K]> | null,
  ...children: Child[]): HTMLElementTagNameMap[K] {
  if (props?.props !== undefined) checkDomPropNames(props.props);
  const el = document.createElement(tag);
  if (props) {
    applyProps(el, props);
    if (props.text !== undefined) {
      if (children.length > 0) throw new Error('h(): pass either text or children, not both.');
      if (isRead(props.text)) el.appendChild(text(props.text));
      else el.textContent = props.text;
    }
  }
  for (const child of children) appendChild(el, child);
  if (props?.props !== undefined) applyDomProps(el, props.props);
  props?.ref?.(el);
  return el;
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, R<string | number>>,
  ...children: Node[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  if (attrs !== undefined) for (const [name, value] of Object.entries(attrs)) bindAttr(el, name, value);
  for (const child of children) el.appendChild(child);
  return el;
}

/** A text node bound to `value`; it writes `.data` only when the string differs. */
export function text(value: Read<string | number>): Text {
  const node = document.createTextNode('');
  bind<string | number>(value, next => {
    const data = String(next);
    if (node.data !== data) node.data = data;
  });
  return node;
}

interface Region { start: Comment; end: Comment; fragment: DocumentFragment }

function region(name: string): Region {
  const start = document.createComment(name);
  const end = document.createComment(`/${name}`);
  const fragment = document.createDocumentFragment();
  fragment.append(start, end);
  return { start, end, fragment };
}

function parentOf(anchor: Comment, what: string): Node {
  const parent = anchor.parentNode;
  if (parent === null) throw new Error(`${what}: its anchors were removed from the document.`);
  return parent;
}

/** Creates `build()` in its own root, owned by `owner` (not by the effect that asks), and returns it with its dispose. */
function owned<T>(owner: Owner, build: () => T): { value: T; dispose: Dispose } {
  return runWithOwner(owner, () => root(dispose => ({ value: build(), dispose })));
}

interface Row { el: Element; dispose: Dispose }

export function each<T>(keys: Read<readonly string[]>, item: (key: string) => Read<T> | undefined,
  row: (item: Read<T>, key: string) => Element): DocumentFragment {
  const owner = requireOwner('each()');
  const { start, fragment } = region('each');
  const rows = new Map<string, Row>();
  const create = (key: string): Row => {
    // The item read belongs to the retained row, not the reconciliation effect. Reordering or
    // filtering keys reruns that effect; its cleanup must not freeze a row that stays mounted.
    const made = owned(owner, () => {
      const read = item(key);
      if (read === undefined) throw new Error(`each(): there is no item for the key "${key}".`);
      return row(read, key);
    });
    if (!(made.value instanceof Element)) {
      made.dispose();
      throw new TypeError(`each(): the row for "${key}" must return exactly one Element.`);
    }
    return { el: made.value, dispose: made.dispose };
  };
  effect(() => {
    const list = keys();
    untrack(() => {
      const parent = parentOf(start, 'each()');
      const wanted = new Set(list);
      if (wanted.size !== list.length) throw new Error('each(): the key list contains a duplicate.');
      // 1. Dispose and remove the rows whose key has gone.
      for (const [key, entry] of rows) {
        if (wanted.has(key)) continue;
        rows.delete(key);
        entry.dispose();
        entry.el.remove();
      }
      // 2–3. Walk the new order with a cursor; create new rows; move a row only when it is not at the cursor.
      let cursor: Node | null = start.nextSibling;
      for (const key of list) {
        let entry = rows.get(key);
        if (entry === undefined) {
          entry = create(key);
          rows.set(key, entry);
        }
        if (entry.el === cursor) {
          cursor = cursor.nextSibling;
        } else if (entry.el.parentNode === parent) {
          moveNode(parent, entry.el, cursor);
        } else {
          parent.insertBefore(entry.el, cursor);
        }
      }
    });
  });
  onCleanup(() => {
    for (const entry of rows.values()) entry.dispose();
    rows.clear();
  });
  return fragment;
}

function swapper<K>(name: string, select: () => K, factory: (key: K) => (() => Node) | undefined): DocumentFragment {
  const owner = requireOwner(`${name}()`);
  const { start, end, fragment } = region(name);
  let lastKey: K | typeof UNSET = UNSET;
  let dispose: Dispose | null = null;
  effect(() => {
    const key = select();
    if (lastKey !== UNSET && Object.is(key, lastKey)) return;
    lastKey = key;
    untrack(() => {
      const parent = parentOf(start, `${name}()`);
      if (dispose !== null) {
        const leaving = dispose;
        dispose = null;
        leaving();
      }
      for (let node = start.nextSibling; node !== null && node !== end;) {
        const next: ChildNode | null = node.nextSibling;
        parent.removeChild(node);
        node = next;
      }
      const make = factory(key);
      if (make === undefined) return;
      const made = owned(owner, make);
      dispose = made.dispose;
      parent.insertBefore(made.value, end);
    });
  });
  onCleanup(() => {
    if (dispose !== null) dispose();
    dispose = null;
  });
  return fragment;
}

export function show(when: Read<boolean>, then: () => Node, otherwise?: () => Node): DocumentFragment {
  return swapper('show', () => Boolean(when()), on => (on ? then : otherwise));
}

export function match<K extends string>(value: Read<K>, cases: Partial<Record<K, () => Node>>,
  fallback?: () => Node): DocumentFragment {
  return swapper('match', value, key => (Object.prototype.hasOwnProperty.call(cases, key) ? cases[key] : undefined) ?? fallback);
}

/** Mounts `view()` into `host` inside a new root. The returned dispose disposes the root and empties the host. */
export function mount(host: Element, view: () => Node): Dispose {
  return root(dispose => {
    try {
      host.replaceChildren(view());
    } catch (error) {
      dispose();
      throw error;
    }
    return () => {
      dispose();
      host.replaceChildren();
    };
  });
}

type MoveBefore = (node: Node, child: Node | null) => void;

/**
 * Moves `node` before `before` inside `parent`. It uses the feature-detected `moveBefore`, which keeps focus,
 * selection and running animations. Where that is missing or throws, it records the focused element (and an
 * input's selection) inside `node`, inserts, and restores both.
 */
export function moveNode(parent: Node, node: Node, before: Node | null): void {
  const moveBefore = (parent as Node & { moveBefore?: MoveBefore }).moveBefore;
  if (typeof moveBefore === 'function') {
    try {
      moveBefore.call(parent, node, before);
      return;
    } catch {
      // The state-preserving move is unavailable here (for example, a disconnected parent): use the fallback.
    }
  }
  const doc = node.ownerDocument ?? document;
  const active = doc.activeElement;
  const focused = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
  const keep = focused !== null && focused !== doc.body && node.contains(focused) ? focused : null;
  let selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null = null;
  if (keep instanceof HTMLInputElement || keep instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, selectionDirection } = keep;
    if (selectionStart !== null && selectionEnd !== null) {
      selection = { start: selectionStart, end: selectionEnd, direction: selectionDirection ?? 'none' };
    }
  }
  parent.insertBefore(node, before);
  if (keep === null || !keep.isConnected) return;
  if (doc.activeElement !== keep) keep.focus({ preventScroll: true });
  if (selection !== null && (keep instanceof HTMLInputElement || keep instanceof HTMLTextAreaElement)) {
    keep.setSelectionRange(selection.start, selection.end, selection.direction);
  }
}
