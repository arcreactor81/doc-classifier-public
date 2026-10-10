export interface VerifiedRecoveryLine { text: string; positions: number[] }
export interface RecoveryVerification {
  verified: VerifiedRecoveryLine[];
  rejected: { text: string; reason: 'not_an_exact_line' }[];
}

/** Verification only: repeated lines expose every possible position, never guess one. */
export function verifyRecoveredHeadings(text: string, candidates: readonly string[]): RecoveryVerification {
  const positions = new Map<string, number[]>();
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    const line = match[0].replace(/(?:\r\n|\r|\n)$/, '');
    if (line.length === 0) continue;
    const occurrences = positions.get(line) ?? [];
    occurrences.push(match.index);
    positions.set(line, occurrences);
  }
  const result: RecoveryVerification = { verified: [], rejected: [] };
  for (const candidate of candidates) {
    const found = positions.get(candidate);
    if (found) result.verified.push({ text: candidate, positions: [...found] });
    else result.rejected.push({ text: candidate, reason: 'not_an_exact_line' });
  }
  return result;
}
