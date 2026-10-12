import type { TypeFile } from './project.ts';

export type ThresholdStatus = 'untested' | 'unverified' | 'provisional' | 'calibrated';

export type DefinitionChange = 'initial' | 'semantic' | 'cosmetic';

export interface Calibration { threshold: number; status: ThresholdStatus }

export function definitionChange(base: TypeFile | null, next: TypeFile): DefinitionChange {
  return !base
    ? 'initial'
    : JSON.stringify(base) === JSON.stringify(next) ? 'cosmetic' : 'semantic';
}

export function definitionThreshold(
  kind: DefinitionChange,
  base: Calibration | null,
  inherit: boolean
): Calibration {
  if (kind === 'cosmetic' && base) return { ...base };
  if (kind === 'semantic' && base && inherit)
    return { threshold: base.threshold, status: 'unverified' };
  return { threshold: .90, status: 'untested' };
}

/**
 * Status after an editor applies a stored threshold proposal from one correction. One correction makes a
 * threshold provisional. It becomes calibrated only when a different correction proposes and applies the same
 * value while that value is active; applying the same value again from the same correction confirms nothing.
 */
export function appliedThresholdStatus(
  current: { threshold: number; status: ThresholdStatus; justification: string },
  next: { threshold: number; correctionId: string }
): ThresholdStatus {
  if (current.threshold !== next.threshold) return 'provisional';
  if (current.status === 'calibrated') return 'calibrated';
  return current.status === 'provisional' && current.justification !== next.correctionId
    ? 'calibrated'
    : 'provisional';
}

/**
 * The one format of the two people lists, `DEFINITION_EDITORS` and `TRUSTED_USERS` (DECISIONS 150): a JSON array of
 * Cloudflare Access user IDs, each the `sub` claim of the Access JWT, never an email address (a signed-in person reads
 * their own as `actor` from GET /api/definitions). An absent setting is an empty list. Null when the text is not JSON,
 * not an array, or holds an entry that is not a non-empty string: such a list names nobody.
 */
function accessUserList(raw: string | undefined): string[] | null {
  let list: unknown;
  try { list = JSON.parse(raw ?? '[]'); } catch { return null; }
  return Array.isArray(list) && list.every(item => typeof item === 'string' && item.length > 0) ? list : null;
}

/** What is wrong with a people list, read by that one format; each list decides which of these Health refuses. */
function accessUserListIssue(raw: string | undefined): 'unreadable' | 'empty' | 'email' | null {
  const list = accessUserList(raw);
  if (list === null) return 'unreadable';
  if (list.length === 0) return 'empty';
  return list.some(item => item.includes('@')) ? 'email' : null;
}

/**
 * A listed category editor may edit categories and apply thresholds, is exempt from the per-person daily caps
 * (`capsExempt`), and is the only one who can stop or allow all runs (the global stop). A missing, empty or unreadable
 * list means nobody: Health then reads NOT READY (`editorListIssue`), and so does a list holding an email address.
 */
export function editorAllowed(raw: string | undefined, actor: string): boolean {
  return accessUserList(raw)?.includes(actor) ?? false;
}

/** Why the editor list leaves the site without an owner, or null when it names at least one Access user ID. */
export function editorListIssue(raw: string | undefined): 'missing' | 'email' | null {
  const issue = accessUserListIssue(raw);
  return issue === null || issue === 'email' ? issue : 'missing';
}

/**
 * `TRUSTED_USERS` (DECISIONS 150, owner, 9 October 2026), in the editor list's format: people the owner names who are
 * exempt from the per-person daily caps (`capsExempt`) and gain nothing else: no category editing, no global stop. An
 * absent or empty list means no trusted users, which is fine; a malformed one names nobody and Health reads NOT READY
 * (`trustedListIssue`).
 */
export function trustedAllowed(raw: string | undefined, actor: string): boolean {
  return accessUserList(raw)?.includes(actor) ?? false;
}

/** Why the trusted-users list cannot be used, or null when it is absent, empty or names only Access user IDs. */
export function trustedListIssue(raw: string | undefined): 'unreadable' | 'email' | null {
  const issue = accessUserListIssue(raw);
  return issue === 'empty' ? null : issue;
}

/**
 * Exempt from every per-person daily cap (DECISIONS 134, 140, 141 and 150): runs, price checks, saved reviews, saves of
 * confirmed labels and comparison plans. True for a listed category editor or a listed trusted user. Never an exemption
 * from the per-run document cap or the site-wide daily pools, which bind everyone. Computed once per request.
 */
export function capsExempt(editors: string | undefined, trusted: string | undefined, actor: string): boolean {
  return editorAllowed(editors, actor) || trustedAllowed(trusted, actor);
}

export function validateDisplayNames(
  value: unknown,
  types: TypeFile
): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Display names must be an object.');
  const ids = new Set(types.types.map(t => t.id));
  for (const [id, name] of Object.entries(value)) {
    if (!ids.has(id) || typeof name !== 'string' || !name.trim())
      throw new Error('Each display name must name an existing category and contain text.');
  }
}
