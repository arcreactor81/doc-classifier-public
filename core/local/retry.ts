import type { SourceFile } from '../builder/builder.ts';
import { uiCopy } from '../ui/copy.ts';

export interface RetryDocument { fingerprint: string; originalFilename: string }

export interface RetrySession {
  runId: string;
  parentRunId: string;
  createdAt: string;
  documents: RetryDocument[]
}

export function createRetrySession(
  parentRunId: string,
  documents: readonly RetryDocument[],
  createdAt: string,
  runId: string
): RetrySession {
  if (
    !parentRunId || !runId || parentRunId === runId || !Number.isFinite(Date.parse(createdAt)) ||
    !documents.length ||
    documents.some(item => !item.originalFilename || !/^[a-f0-9]{64}$/.test(item.fingerprint)) ||
    new Set(documents.map(item => item.fingerprint)).size !== documents.length
  ) throw new Error(uiCopy.invalidRetry);
  return { runId, parentRunId, createdAt, documents: documents.map(item => ({ ...item })) };
}

export function matchRetrySources(session: RetrySession, sources: readonly SourceFile[]): {
  matched: { document: RetryDocument; source: SourceFile }[];
  missing: RetryDocument[];
  excluded: SourceFile[]
} {
  const available = new Map<string, SourceFile>();
  const excluded: SourceFile[] = [];
  const required = new Set(session.documents.map(item => item.fingerprint));
  for (
    const source of [...sources].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  ) {
    if (!required.has(source.fingerprint) || available.has(source.fingerprint))
      excluded.push(source);
    else
      available.set(source.fingerprint, source);
  }
  const matched: { document: RetryDocument; source: SourceFile }[] = [],
    missing: RetryDocument[] = [];
  for (const document of session.documents) {
    const source = available.get(document.fingerprint);
    if (source) matched.push({ document, source });
    else missing.push({ ...document });
  }
  return { matched, missing, excluded };
}

export function assertRetryComplete(
  session: RetrySession,
  records: readonly { fingerprint: string }[]
): void {
  const actual = new Set(records.map(item => item.fingerprint)),
    required = new Set(session.documents.map(item => item.fingerprint));
  if (records.length !== actual.size || [...actual].some(value => !required.has(value)))
    throw new Error(uiCopy.retryScope);
  if ([...required].some(value => !actual.has(value))) throw new Error(uiCopy.retryMissing);
}

export function readRetrySession(
  storage: Pick<Storage, 'getItem'>,
  runId: string
): RetrySession | null {
  const raw = storage.getItem('retry-session:' + runId);
  if (raw === null) return null;
  const value = JSON.parse(raw) as RetrySession;
  if (value.runId !== runId) throw new Error(uiCopy.invalidRetry);
  return createRetrySession(value.parentRunId, value.documents, value.createdAt, value.runId);
}
