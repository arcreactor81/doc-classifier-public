/**
 * The card answers the Review screen keeps on this computer (`review-cards:<runId>`, ui/app/persist/local-keys.ts), as
 * the real walk controller reads them. A stored value this release cannot read is never repaired and the cards start
 * afresh, as before; the person is now told so once, and the value stays as it was until their next answer replaces it.
 * Web Storage and the `storage` event are stood in for here (Node has neither); flow 32 shows the same in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { uiCopy } from './copy.ts';
import { effect } from './reactive.ts';
import type { ControllerContext } from '../../ui/app/controllers/registry.ts';
import type { ClientNote } from '../../ui/app/state/types.ts';

class MemoryStorage {
  readonly #items = new Map<string, string>();
  get length() { return this.#items.size; }
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  getItem(key: string) { return this.#items.has(key) ? this.#items.get(key)! : null; }
  setItem(key: string, value: string) { this.#items.set(key, String(value)); }
  removeItem(key: string) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
}
const local = new MemoryStorage(), tab = new MemoryStorage();
const storageListeners = new Set<(event: unknown) => void>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: tab });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === 'storage') storageListeners.add(listener); },
  removeEventListener: (type: string, listener: (event: unknown) => void) => { if (type === 'storage') storageListeners.delete(listener); }
} });
const { createWalkController } = await import('../../ui/app/controllers/walk.ts');

/** Another tab wrote `key`: what the browser tells this tab. */
const otherTabWrote = (key: string) => { for (const listener of [...storageListeners]) listener({ storageArea: local, key }); };

function controllerFor(runId: string) {
  const notes: Omit<ClientNote, 'at'>[] = [];
  const context = {
    store: { runStore: () => ({}), addNote: (note: Omit<ClientNote, 'at'>) => { notes.push(note); } },
    kind: 'walk', id: runId, runId, localId: null, begin: () => () => undefined, release: () => undefined
  } as unknown as ControllerContext;
  return { walk: createWalkController(context), notes };
}

test('card answers this computer cannot read: said once, left as they were, and replaced by the next answer', () => {
  const key = 'review-cards:run-damaged', damaged = '{"answers": {"doc-a": {"kind": "ri';
  local.setItem(key, damaged);
  const { walk, notes } = controllerFor('run-damaged');
  try {
    assert.deepEqual(walk.cards(), { answers: {}, recheck: [] }, 'the cards start afresh, as before');
    assert.equal(walk.cardsLoaded(), false, 'the folder ticks still wait');
    assert.match(walk.cardsProblem() ?? '', /review-cards:run-damaged/, 'the problem names the stored value (shown in Details)');
    assert.equal(local.getItem(key), damaged, 'reading never repairs or deletes the stored value');
    assert.deepEqual(notes.map(note => note.code), ['boot-stored-value']);

    // Another tab writes it again, still unreadable (once as before, once differently): the person was told already.
    otherTabWrote(key);
    local.setItem(key, '{"answers": 3, "recheck": []}');
    otherTabWrote(key);
    assert.equal(notes.length, 1, 'noted once, not on every read');
    assert.match(walk.cardsProblem() ?? '', /expected \{answers, recheck\}/, 'the problem shown is the latest one');

    // The next answer starts the stored answers afresh (today's behaviour) and the notice goes.
    walk.answer('doc-b', { kind: 'right' });
    assert.equal(walk.cardsProblem(), null);
    assert.equal(walk.cardsLoaded(), true);
    assert.deepEqual(JSON.parse(local.getItem(key)!), { answers: { 'doc-b': { kind: 'right' } }, recheck: [] });
    assert.equal(notes.length, 1);
  } finally { walk.dispose(); }
});

test('card answers this computer can read: no problem and nothing noted', () => {
  const key = 'review-cards:run-readable';
  local.setItem(key, JSON.stringify({ answers: { 'doc-a': { kind: 'move', to: 'procedures' } }, recheck: [] }));
  const { walk, notes } = controllerFor('run-readable');
  try {
    assert.equal(walk.cardsProblem(), null);
    assert.equal(walk.cardsLoaded(), true);
    assert.deepEqual(walk.cards().answers, { 'doc-a': { kind: 'move', to: 'procedures' } });
    assert.deepEqual(notes, []);
    // A damaged value from another tab is said, and this tab keeps the answers it had (unchanged behaviour); a readable
    // one after it clears the problem, with nothing more noted.
    local.setItem(key, 'not readable');
    otherTabWrote(key);
    assert.notEqual(walk.cardsProblem(), null);
    assert.deepEqual(walk.cards().answers, { 'doc-a': { kind: 'move', to: 'procedures' } });
    local.setItem(key, JSON.stringify({ answers: {}, recheck: ['f'] }));
    otherTabWrote(key);
    assert.equal(walk.cardsProblem(), null);
    assert.deepEqual(walk.cards(), { answers: {}, recheck: ['f'] });
    assert.equal(notes.length, 1);
  } finally { walk.dispose(); }
});

test('the notice says it in plain words: unsaved answers on this computer could not be read, and may be missing here', () => {
  const text = uiCopy.review.cards.answersUnread;
  assert.match(text, /unsaved answers on this computer couldn't be read/);
  // True both on opening (none shown) and after another tab left them unreadable (this tab keeps its own).
  assert.match(text, /some or all of them are missing here/);
});

test('a readable cross-tab update publishes its answers before allowing folder-tick effects again', () => {
  const key = 'review-cards:run-recovered';
  const initial = { answers: { 'doc-a': { kind: 'right' } }, recheck: [] };
  local.setItem(key, JSON.stringify(initial));
  const { walk } = controllerFor('run-recovered');
  const usableAnswers: unknown[] = [];
  // Review's folder-tick effect reads these same signals; it may enqueue a durable tick as soon as cardsLoaded is true.
  const stop = effect(() => { if (walk.cardsLoaded()) usableAnswers.push(walk.cards()); });
  try {
    local.setItem(key, 'not readable');
    otherTabWrote(key);
    assert.equal(walk.cardsLoaded(), false);
    assert.deepEqual(walk.cards(), initial, 'retained answers remain visible while the stored value cannot be read');
    const fresh = { answers: {}, recheck: [] };
    local.setItem(key, JSON.stringify(fresh));
    otherTabWrote(key);
    assert.deepEqual(usableAnswers, [initial, fresh], 'recovery must never enable a folder tick from the older Right answer');
    assert.equal(walk.cardsProblem(), null);
  } finally { stop(); walk.dispose(); }
});
