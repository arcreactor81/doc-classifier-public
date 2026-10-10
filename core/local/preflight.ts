import type { ProjectPack } from '../config/project.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import type { LocalDocument } from './state.ts';
import { uiCopy } from '../ui/copy.ts';
import { UPLOAD_BODY_LIMIT_BYTES } from '../domain/upload-limit.ts';

export interface TokenCounts {
  readerInputTokens: number | null;
  confidenceInputTokens: number | null;
  recoveryInputTokens: number | null
}

export interface QuoteDocument {
  fingerprint: string;
  originalFilename: string;
  tokenCounts: TokenCounts;
  needsOutlineRecovery: boolean;
  failed: boolean
}

export interface PreparedDocument {
  local: LocalDocument;
  quote: QuoteDocument;
  upload: Record<string, unknown>
}

export function prepareLocalRun(
  records: readonly LocalDocument[],
  pack: ProjectPack
): PreparedDocument[] {
  const seen = new Set<string>();
  return records.map(local => {
    if (seen.has(local.fingerprint)) throw new Error(uiCopy.duplicateContent);
    seen.add(local.fingerprint);
    if (local.state === 'not started') throw new Error(uiCopy.extractionIncomplete);
    const originalFilename = 'document' in local
      ? local.document.originalFilename
      : local.sourcePath.split('/').at(-1)!;
    const identity = { fingerprint: local.fingerprint, originalFilename };
    const failed = (failure: { code: string; message: string }): PreparedDocument => ({
      local,
      quote: {
        ...identity,
        tokenCounts: { readerInputTokens: 0, confidenceInputTokens: 0, recoveryInputTokens: 0 },
        needsOutlineRecovery: false,
        failed: true
      },
      upload: { ...identity, failure }
    });
    if (local.state === 'could_not_process') return failed(local.failure);
    const document = local.document;
    // No local billing estimate: the vendors report actual usage after each request.
    const tokenCounts: TokenCounts = {
      readerInputTokens: null,
      confidenceInputTokens: null,
      recoveryInputTokens: null
    };
    const upload = { ...document, tokenCounts, tokenizerIds: { reader: null, confidence: null } };
    // The body the service would refuse as too large is never sent: the document could not be processed, like an
    // unreadable file. Measured as sent (the request body is this object as JSON, in UTF-8), so Confirm and the
    // preparation again at send always agree.
    if (new TextEncoder().encode(JSON.stringify(upload)).byteLength > UPLOAD_BODY_LIMIT_BYTES)
      return failed({ code: 'E_UPLOAD_TOO_LARGE', message: uiCopy.errors.local.tooLargeToSend });

    buildConfidenceState(
      pack.settings.confidenceStatePolicy,
      document.fullText,
      document.outline,
      pack.structuralVocabulary
    );
    return {
      local,
      quote: {
        ...identity,
        tokenCounts,
        needsOutlineRecovery: document.needsOutlineRecovery,
        failed: false
      },
      upload
    };
  });
}
