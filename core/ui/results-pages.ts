/** Sequential full-page consumers. Only compact identities survive between full pages. */
import { UiShapeError, type CompactResultsView, type ResultsPageView, type CloseReply } from './wire.ts';
import type { BuilderManifest } from '../builder/builder.ts';
export type PageReader = (after: number) => Promise<ResultsPageView>;
const refuse = (detail: string): never => { throw new UiShapeError('results page', 'entries', detail); };

/** Paths and global duplicate tags are checked from identities before the first copy. No summary acts as evidence. */
export function compactBuildManifest(results: CompactResultsView): BuilderManifest {
  return { runId: results.runId, notes: results.notes,
    entries: results.entries.map(({ readerYes: _yes, ordinal: _ordinal, ...entry }) => ({ ...entry, reader: null })) };
}

/** Cross-check a complete response against the frozen submission before any local consumer sees it. */
export function validateResultIdentities(results: CompactResultsView,
  expected: readonly { fingerprint: string; originalFilename: string }[]): void {
  const wanted = new Map(expected.map(entry => [entry.fingerprint, entry.originalFilename]));
  const seen = new Set<string>(), tags = new Set<string>(), notes = new Set<string>();
  if (results.entries.length !== expected.length || results.notes.length !== expected.length)
    refuse('the compact results do not cover every expected document');
  for (const entry of results.entries) {
    if (seen.has(entry.fingerprint) || tags.has(entry.tag.toLowerCase()) || wanted.get(entry.fingerprint) !== entry.originalFilename)
      refuse('a compact document is missing, repeated or differs from the frozen submission');
    seen.add(entry.fingerprint); tags.add(entry.tag.toLowerCase());
  }
  for (const note of results.notes) {
    if (!seen.has(note.fingerprint) || notes.has(note.fingerprint)) refuse('document notes do not cover the same results');
    notes.add(note.fingerprint);
  }
}

/** Stop only between pages. A build consumer finishes its current copy and records the rest as not attempted. */
export async function walkResultPages(results: CompactResultsView, read: PageReader,
  consume: (entries: ResultsPageView['entries'], offset: number) => Promise<void>, signal?: AbortSignal): Promise<number> {
  let after = 0, offset = 0;
  const fingerprints = new Set<string>(), tags = new Set<string>();
  for (const entry of results.entries) {
    if (entry.ordinal === null || entry.ordinal <= after) refuse('the compact document order is missing or repeated');
    if (fingerprints.has(entry.fingerprint) || tags.has(entry.tag.toLowerCase())) refuse('a compact document identity is repeated');
    fingerprints.add(entry.fingerprint); tags.add(entry.tag.toLowerCase()); after = entry.ordinal!;
  }
  after = 0;
  do {
    if (signal?.aborted) return offset;
    const page = await read(after);
    if (page.runId !== results.runId || page.resultsVersion !== results.resultsVersion || page.vendors !== results.vendors)
      refuse('the page belongs to another run or results version');
    for (const key of ['pilotSkipped', 'readerContract', 'confidenceQuestionPolicy'] as const) {
      if (Object.hasOwn(page, key) !== Object.hasOwn(results, key) || page[key] !== results[key])
        refuse('the page has different recorded run settings; read the current results again');
    }
    if (Object.hasOwn(page, 'bakeoff') !== Object.hasOwn(results, 'bakeoff') || JSON.stringify(page.bakeoff) !== JSON.stringify(results.bakeoff))
      refuse('the page has different comparison provenance; read the current results again');
    let last = after;
    for (const [index, entry] of page.entries.entries()) {
      const expected = results.entries[offset + index];
      if (!expected || entry.ordinal <= last ||
        ['fingerprint', 'tag', 'originalFilename', 'destinationFolder', 'rule', 'ordinal'].some(
          key => entry[key as keyof typeof entry] !== expected[key as keyof typeof expected]))
        refuse('a page document differs from its compact identity or recorded order');
      last = entry.ordinal;
    }
    const end = offset + page.entries.length;
    if (page.next === null ? end !== results.entries.length : page.entries.length === 0 || page.next !== last || end >= results.entries.length)
      refuse('the page cursor does not describe the complete results');
    await consume(page.entries, offset);
    offset = end;
    if (page.next === null) return offset;
    after = page.next;
  } while (true);
}

export interface CopyWriter { write(chunk: string): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }
/** Writes entry JSON straight to the chosen file; no aggregate Blob, string or list of full entries. */
export async function streamResultsCopy(results: CompactResultsView, read: PageReader, writer: CopyWriter,
  progress: (done: number, total: number) => void = () => {}): Promise<void> {
  try {
    const { entries: _entries, ...header } = results;
    // Omitted legacy fields stay omitted on export; no null is invented for a missing recorded policy.
    const fields = Object.entries(header).filter(([, value]) => value !== null);
    await writer.write('{' + fields.map(([key, value]) => JSON.stringify(key) + ':' + JSON.stringify(value)).join(',') + ',"entries":[');
    let written = 0;
    await walkResultPages(results, read, async entries => {
      for (const entry of entries) {
        await writer.write((written === 0 ? '' : ',') + JSON.stringify(entry));
        written++;
      }
      progress(written, results.entries.length);
    });
    await writer.write(']}');
    await writer.close();
  } catch (error) {
    try { await writer.abort(error); } catch (abortError) {
      throw new AggregateError([error, abortError], 'Saving failed and the unfinished file could not be aborted.');
    }
    throw error;
  }
}

/** A successful incomplete answer authorizes the next page; failed requests are never retried. */
export async function closeInRounds(close: () => Promise<CloseReply>, progress: (remaining: number) => void | Promise<void>): Promise<void> {
  let before: number | null = null;
  for (;;) {
    const answer = await close();
    if (answer.closed) return;
    if (before !== null && answer.remaining >= before)
      throw new UiShapeError('close', 'remaining', 'closing made no progress; another explicit action is needed');
    before = answer.remaining;
    await progress(answer.remaining);
  }
}
