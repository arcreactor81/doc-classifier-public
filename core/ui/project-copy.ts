import { uiCopy } from './copy.ts';

type Resolved<T> = T extends string ? string : T extends (...args: infer A) => infer R ? (...args: A) => R : T extends object ? { [K in keyof T]: Resolved<T[K]> } : T;
export type UiCopy = Resolved<typeof uiCopy>;
/**
 * Presentation headings and navigation, and the OpenAI reader's data line on Confirm, which states the terms of the
 * OpenAI account the site runs on (core's default says only what is true on any account; review of 7 October 2026).
 * Rule, outcome, budget, failure and action semantics, and every other data line, are protected.
 */
export const COPY_OVERRIDE_PATHS = ['hero','lede','local','localDetail','setup','setupDetail','build','buildLede','correct','correctLede','health','helpTitle','nav.home','nav.runs','nav.build','nav.correct','nav.health','nav.help','screenConfirm.readerDataNote.openai'] as const;
const paths = new Set<string>(COPY_OVERRIDE_PATHS);
export interface CopyIssue { path: string; detail: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[<>]/.test(value) && !/\b(?:fast|filed)\b/i.test(value);
export function validateProjectCopy(value: unknown): CopyIssue[] {
  if (!record(value)) return [{path: 'productName', detail: uiCopy.invalidProjectCopy}];
  const issues: CopyIssue[] = [];
  if (!safeText(value.productName)) issues.push({path: 'productName', detail: uiCopy.invalidProjectCopy});
  if (value.copyOverrides !== undefined) {
    if (!record(value.copyOverrides)) issues.push({path: 'copyOverrides', detail: uiCopy.invalidProjectCopy});
    else for (const [key, text] of Object.entries(value.copyOverrides)) {
      if (!paths.has(key) || !safeText(text)) issues.push({path: 'copyOverrides.' + key, detail: uiCopy.invalidProjectCopy});
    }
  }
  return issues;
}
export function resolveProjectCopy(value: unknown): UiCopy {
  const issues = validateProjectCopy(value);
  if (issues.length) throw Object.assign(new Error(uiCopy.invalidProjectCopy), {code: 'E_PROJECT_COPY', issues});
  const metadata = value as {productName: string; copyOverrides?: Record<string, string>};
  const result: UiCopy = {...uiCopy, product: metadata.productName};
  // Each object along an override's (allowed) path is copied before it is changed, so the base copy is never touched.
  for (const [path, text] of Object.entries(metadata.copyOverrides ?? {})) {
    const parts = path.split('.'), last = parts.pop()!;
    let node = result as unknown as Record<string, unknown>;
    for (const part of parts) {
      const copy = {...(node[part] as Record<string, unknown>)};
      node[part] = copy;
      node = copy;
    }
    node[last] = text;
  }
  return result;
}
export let activeUiCopy: UiCopy = uiCopy;
export function configureProjectCopy(value: unknown): void { activeUiCopy = resolveProjectCopy(value); }

