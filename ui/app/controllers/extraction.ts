import { initialSelection } from '../../../core/ui/trial-plan.ts';
/**
 * The ExtractionController (SPEC §6.1; walkthrough 3a steps 5–6; §4.7 lock `dc:extract:<localId>`): one per draft.
 * It chooses the folder, looks for sorted copies inside it, scans, and reads every file on this computer with the
 * ExtractionPool, keeping the draft's files in step with IndexedDB. Logic only (SPEC §4.1 L2): it writes the
 * DraftStore's `scan`, `files` and `sourceName`, reports to the caller's feedback slot (`StepReport`), and shows its
 * work in the TopBar through `ctx.begin('reading', label)` ("57 of 114").
 *
 * - Nothing is sent: the only request is `GET /api/project` for the reading policy.
 * - Every file to read gets its record ("waiting") before reading starts, so the count is determinate and duplicates
 *   are known right after the scan (DraftStore.counts). The reading itself never skips or merges a copy.
 * - System and lock files (Thumbs.db, Office's "~$" files, …; `core/local/source-scan.ts` NOT_DOCUMENTS) are left out by
 *   the scan, unopened: the scan state lists them (`skipped`), and they get no record, no count and nothing is sent.
 * - A file the reader cannot read is recorded as "could not be read" with its own reason, and only that file fails;
 *   the others carry on (the pool fails only the document a worker held, F8). A failure that is not the document's
 *   own (the reader could not start, storage refused a write, the file vanished) records nothing against the file: it
 *   stays waiting, the folder read ends as `failed`, and choosing the folder again finishes it.
 * - A folder that no longer matches this draft's records is `changed-source`: records are never rewritten. "Read the
 *   folder again as a new run" (`startOver`) begins a new draft with the same saved answers and reads it there.
 * - A draft that started a run refuses a new folder (DraftFrozenError). Another tab reading the same draft makes this
 *   one show the stored counts only (`elsewhere`); the chosen folder is then not remembered either, so the folder the
 *   other tab is reading stays `source:<localId>`.
 * - Folder access is asked only from the person's click (`chooseFolder`, `useRemembered`, `lookAgain`, …).
 * - One piece of work at a time per draft in this tab: a second call while one runs gets the running one's outcome.
 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ExtractionPool } from '../../../core/extraction/pool.ts';
import { discoverGeneratedTrees, scanExtractionSource } from '../../../core/local/source-scan.ts';
import type { LocalDirectoryHandle, LocalFileHandle } from '../../../core/builder/browser.ts';
import type { LocalDocument } from '../../../core/local/state.ts';
import { signal } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { presentError, type UiErrorView } from '../../../core/ui/error-copy.ts';
import { DraftFrozenError, ElsewhereError, NO_REPORT, workTracker, type StepReport } from '../../../core/ui/run-controls.ts';
import {
  EXTRACTION_WORKERS, documentFailure, excludedPaths, extractOptions, outputCheck, planExtraction
} from '../../../core/ui/extraction-plan.ts';
import { stillOnDraft } from '../../../core/ui/confirm-plan.ts';
import { getProject } from '../api/endpoints.ts';
import { HANDLE_KEYS, pickDirectory, readHandle, requestPermission, saveHandle } from '../persist/handles.ts';
import { beginDraft, draftReference, readRetry, readServerRun, writeRetryMissing, readDraftBakeoff } from '../persist/local-keys.ts';
import { listLocalRecords, openLocalRunStore } from '../persist/local-records.ts';
import { navigate } from '../router.ts';
import type { DraftStore } from '../state/types.ts';
import { LOCK_NAMES, withLock } from './locks.ts';
import type { ControllerContext, ControllerRegistry } from './registry.ts';

export type ExtractionOutcome =
  /** The person closed the folder picker: nothing changed. */
  | { kind: 'cancelled' }
  /** Another tab of this browser is reading this draft; its stored counts are shown. */
  | { kind: 'elsewhere' }
  /** The folder holds sorted copies from an earlier run; the person chooses what to read. */
  | { kind: 'needs-choice'; trees: readonly { path: string; runId: string }[]; rootIsOutput: boolean }
  | { kind: 'changed-source'; missing: number }
  /**
   * Every file has an outcome. `localId` is the draft that was read (a new one after `startOver`). `retryMissing`
   * counts retry documents the folder did not hold with their original content.
   */
  | { kind: 'read'; localId: string; total: number; ready: number; failed: number; duplicates: number; retryMissing: number }
  | { kind: 'failed'; error: UiErrorView };

export interface ExtractionController {
  /** "Choose folder": the browser's picker (read access), remembered as `source:<localId>`, then read. */
  chooseFolder(report?: StepReport): Promise<ExtractionOutcome>;
  /** "Use 'X' again": a remembered folder handle (`source:<localId>`, another draft's, or the old UI's `source`). */
  useRemembered(key: string, report?: StepReport): Promise<ExtractionOutcome>;
  /** "Read only the original files": the folder again, leaving out the sorted copies found in it. */
  excludeOutputs(report?: StepReport): Promise<ExtractionOutcome>;
  /** "Read the folder again as a new run": a new draft (same saved answers) reads the same folder. */
  startOver(report?: StepReport): Promise<ExtractionOutcome>;
  /** "Look again": the remembered folder is scanned again for this draft. */
  lookAgain(report?: StepReport): Promise<ExtractionOutcome>;
  /** Reads `folder` into this draft (every action above ends here; `startOver` on the new draft). */
  readFolder(folder: FileSystemDirectoryHandle, report?: StepReport, excluded?: readonly string[]): Promise<ExtractionOutcome>;
}

declare module './registry.ts' {
  interface ControllerKinds { extraction: ExtractionController }
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** The browser's handle, read through the structural type the core scanners take. */
const asLocal = (folder: FileSystemDirectoryHandle): LocalDirectoryHandle => folder as unknown as LocalDirectoryHandle;

/** One original, by its path in the chosen folder, as the File the reader records (with `name`). */
async function openOriginal(root: LocalDirectoryHandle, path: string, name: string): Promise<File> {
  const parts = path.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  const handle: LocalFileHandle = await directory.getFileHandle(parts[parts.length - 1]);
  return new File([await handle.getFile()], name);
}

function createExtractionController(ctx: ControllerContext, registry: ControllerRegistry): ExtractionController {
  const localId = ctx.id;
  const store = ctx.store;
  const draft: DraftStore = store.draftStore(localId);
  let released = false;
  const work = workTracker(() => {
    released = true;
    ctx.release();
  });
  /** A caller that kept this instance after its work ended is served by the registry's current one. */
  const fresh = (): ExtractionController => registry.extraction(localId);
  /** The TopBar's progress part while reading ("57 of 114"); empty while the folder is scanned. */
  const label = signal('');

  const failed = (error: unknown, report: StepReport, scanFailed: boolean): ExtractionOutcome => {
    const view = presentError(error, 'read');
    if (scanFailed) draft.scan.set({ kind: 'failed', error: view });
    report.problem(error, 'read');
    return { kind: 'failed', error: view };
  };

  const frozenRun = (): string | null => draft.runId.peek() ?? readServerRun(localId);

  /** The work under `dc:extract:<localId>`. */
  async function readLocked(folder: FileSystemDirectoryHandle, report: StepReport, excluded: readonly string[] | undefined): Promise<ExtractionOutcome> {
    const copy = activeUiCopy.screenFiles;
    label.set('');
    const end = ctx.begin('reading', label);
    const root = asLocal(folder);
    try {
      draft.sourceName.set(folder.name);
      draft.scan.set({ kind: 'scanning', looked: 0 });
      report.working(copy.scanningStep);
      if (excluded === undefined) {
        const found = outputCheck(await discoverGeneratedTrees(root));
        if (found.kind === 'found') {
          draft.scan.set({ kind: 'needs-choice', trees: found.trees, rootIsOutput: found.rootIsOutput });
          report.clear();
          return { kind: 'needs-choice', trees: found.trees, rootIsOutput: found.rootIsOutput };
        }
      }
      const pack = (await getProject()).value;
      const options = extractOptions(pack.settings, pdfWorkerUrl);
      const scanned = await scanExtractionSource(root, {
        excludedGeneratedTrees: excluded ?? [],
        onProgress: looked => draft.scan.set({ kind: 'scanning', looked })
      });
      await draft.loadFiles();
      const retry = readRetry(localId);
      const plan = planExtraction({
        records: await listLocalRecords(localId),
        scanned: scanned.files.map(file => ({ path: file.path, fingerprint: file.fingerprint })),
        retry
      });
      if (plan.kind === 'changed-source') {
        draft.scan.set({ kind: 'changed-source', missing: plan.missing });
        report.clear();
        return { kind: 'changed-source', missing: plan.missing };
      }
      if (retry === null && scanned.files.length > 0) {
        const selection = await draft.loadTrial();
        // Earlier releases saved an empty default when a folder had no files. It records no document choice.
        // Only that untouched default can be initialized again; a real collection/subset or campaign stays as chosen.
        const emptyDefault = selection !== null && selection.sourceLocalId === localId && selection.role === 'ordinary' &&
          selection.campaignId === null && selection.trialRunId === null && selection.skipPilot !== true &&
          selection.order.length === 0 && selection.selected.length === 0;
        if (selection === null || emptyDefault)
          await draft.setTrial(initialSelection(localId, scanned.files, pack.settings.pilotSize!, scanned.files.map(file => file.fingerprint)));
      }
      if (retry !== null) writeRetryMissing(localId, plan.retryMissing.map(document => document.fingerprint));

      const problems: unknown[] = [];
      const records = await openLocalRunStore();
      let pool: ExtractionPool | null = null;
      try {
        // Every file to read has its record before reading starts, so the count is determinate ("Read 0 of 5") and
        // duplicates are counted at once.
        const placed: LocalDocument[] = [];
        for (const item of plan.toRead) {
          if (item.resumed) continue;
          const waiting: LocalDocument = { runId: localId, sourcePath: item.recordPath, fingerprint: item.fingerprint, state: 'not started' };
          await records.put(waiting);
          placed.push(waiting);
        }
        draft.applyRecords(placed);
        draft.scan.set({ kind: 'reading', skipped: scanned.skipped });
        let settled = plan.kept;
        const progress = () => {
          label.set(copy.activity(settled, plan.total));
          report.working(copy.readingStep, { done: settled, total: plan.total });
        };
        progress();
        if (plan.toRead.length > 0) pool = new ExtractionPool(EXTRACTION_WORKERS, options);
        const queue = [...plan.toRead];
        const reader = async (reading: ExtractionPool): Promise<void> => {
          for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
            let next: LocalDocument;
            try {
              const file = await openOriginal(root, item.sourcePath, item.name);
              try {
                const document = await reading.extract(file);
                next = { runId: localId, sourcePath: item.recordPath, fingerprint: item.fingerprint, state: 'extracted', document };
              } catch (error) {
                const failure = documentFailure(error);
                if (failure === null) throw error;
                next = { runId: localId, sourcePath: item.recordPath, fingerprint: item.fingerprint, state: 'could_not_process', failure };
              }
              await records.put(next);
            } catch (error) {
              // Not this document's own failure: nothing is recorded against it, and it stays waiting.
              problems.push(error);
              continue;
            }
            // The count moves only when the file's record is written.
            draft.applyRecords([next]);
            settled++;
            progress();
          }
        };
        if (pool !== null) {
          const reading = pool;
          await Promise.all(Array.from({ length: EXTRACTION_WORKERS }, () => reader(reading)));
        }
      } finally {
        pool?.close();
        records.close();
      }
      await draft.loadFiles();
      if (problems.length > 0) return failed(problems[0], report, true);
      draft.scan.set({ kind: 'done', skipped: scanned.skipped });
      const counts = draft.counts.peek();
      report.done(copy.readDone(counts.read, counts.failed));
      return {
        kind: 'read', localId, total: counts.total, ready: counts.read, failed: counts.failed, duplicates: counts.duplicates,
        retryMissing: plan.retryMissing.length
      };
    } catch (error) {
      return failed(error, report, true);
    } finally {
      end();
    }
  }

  /**
   * Reads `folder` under the lock. `rememberAs` is saved only by the tab that reads: while another tab reads this
   * draft, this one shows the stored counts and leaves the folder that tab is reading remembered.
   */
  async function readFolderNow(folder: FileSystemDirectoryHandle, report: StepReport, excluded?: readonly string[],
    rememberAs: string | null = null): Promise<ExtractionOutcome> {
    if (readDraftBakeoff(localId) !== null) return failed(new Error(activeUiCopy.bakeoff.locked), report, false);
    const frozen = frozenRun();
    if (frozen !== null) return failed(new DraftFrozenError(frozen), report, false);
    let locked: { ran: true; value: ExtractionOutcome } | { ran: false };
    try {
      locked = await withLock(LOCK_NAMES.extract(localId), async () => {
        if (rememberAs !== null) {
          try {
            await saveHandle(rememberAs, folder);
          } catch (error) {
            return failed(error, report, false);
          }
        }
        return readLocked(folder, report, excluded);
      });
    } catch (error) {
      return failed(error, report, true);
    }
    if (locked.ran) return locked.value;
    // Another tab is reading this draft: show what it has stored so far, read-only.
    await draft.loadFiles().catch(() => undefined);
    report.problem(new ElsewhereError('extract'), 'read');
    return { kind: 'elsewhere' };
  }

  /** The folder remembered under `key`, with read access asked for now (the person's click). */
  async function remembered(key: string): Promise<FileSystemDirectoryHandle> {
    const folder = await readHandle(key);
    if (folder === null) throw new DOMException(`No folder is remembered under ${key}.`, 'NotFoundError');
    const permission = await requestPermission(folder, 'read');
    if (permission !== 'granted') throw new DOMException(`Read access to the folder was ${permission}.`, 'NotAllowedError');
    return folder;
  }

  const frozenCheck = (report: StepReport): ExtractionOutcome | null => {
    if (readDraftBakeoff(localId) !== null) return failed(new Error(activeUiCopy.bakeoff.locked), report, false);
    const frozen = frozenRun();
    return frozen === null ? null : failed(new DraftFrozenError(frozen), report, false);
  };

  return {
    chooseFolder(report = NO_REPORT) {
      if (released) return fresh().chooseFolder(report);
      return work.run('extract', async () => {
        const refused = frozenCheck(report);
        if (refused !== null) return refused;
        let folder: FileSystemDirectoryHandle;
        try {
          folder = await pickDirectory('read', { id: 'originals' });
        } catch (error) {
          if (isAbort(error)) {
            report.clear();
            return { kind: 'cancelled' };
          }
          return failed(error, report, false);
        }
        return readFolderNow(folder, report, undefined, HANDLE_KEYS.source(localId));
      });
    },

    useRemembered(key, report = NO_REPORT) {
      if (released) return fresh().useRemembered(key, report);
      return work.run('extract', async () => {
        const refused = frozenCheck(report);
        if (refused !== null) return refused;
        let folder: FileSystemDirectoryHandle;
        try {
          folder = await remembered(key);
        } catch (error) {
          return failed(error, report, false);
        }
        const own = HANDLE_KEYS.source(localId);
        return readFolderNow(folder, report, undefined, key === own ? null : own);
      });
    },

    excludeOutputs(report = NO_REPORT) {
      if (released) return fresh().excludeOutputs(report);
      return work.run('extract', async () => {
        const refused = frozenCheck(report);
        if (refused !== null) return refused;
        const scan = draft.scan.peek();
        let folder: FileSystemDirectoryHandle, excluded: string[];
        try {
          if (scan.kind !== 'needs-choice') throw Object.assign(new Error('E_LOCAL_GENERATED_TREE_SELECTION'), { code: 'E_LOCAL_GENERATED_TREE_SELECTION' });
          excluded = excludedPaths(scan.trees);
          folder = await remembered(HANDLE_KEYS.source(localId));
        } catch (error) {
          return failed(error, report, false);
        }
        return readFolderNow(folder, report, excluded);
      });
    },

    startOver(report = NO_REPORT) {
      if (released) return fresh().startOver(report);
      return work.run('extract', async () => {
        let folder: FileSystemDirectoryHandle, next: string;
        try {
          folder = await remembered(HANDLE_KEYS.source(localId));
          // A new draft in this tab, checked against the same saved answers; the old draft's records stay as they are.
          next = beginDraft(crypto.randomUUID(), draftReference(localId));
          await saveHandle(HANDLE_KEYS.source(next), folder);
        } catch (error) {
          return failed(error, report, false);
        }
        // The documented result of the click: the new draft's Files view (only if the person is still on this draft).
        if (stillOnDraft(store.route.peek(), localId)) navigate({ view: 'files', localId: next });
        return registry.extraction(next).readFolder(folder, report);
      });
    },

    lookAgain(report = NO_REPORT) {
      if (released) return fresh().lookAgain(report);
      return work.run('extract', async () => {
        const refused = frozenCheck(report);
        if (refused !== null) return refused;
        let folder: FileSystemDirectoryHandle;
        try {
          folder = await remembered(HANDLE_KEYS.source(localId));
        } catch (error) {
          return failed(error, report, false);
        }
        return readFolderNow(folder, report);
      });
    },

    readFolder(folder, report = NO_REPORT, excluded) {
      if (released) return fresh().readFolder(folder, report, excluded);
      return work.run('extract', () => readFolderNow(folder, report, excluded));
    }
  };
}

export function register(registry: ControllerRegistry): void {
  registry.register('extraction', ctx => createExtractionController(ctx, registry));
}
