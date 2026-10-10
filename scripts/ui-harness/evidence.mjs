/**
 * Evidence for the UI flow scripts (SPEC §10.2: each script writes `.local/qa/ui-rebuild/<script>.json` and
 * screenshots). `.local/` is ignored by Git.
 *
 * `runScript(name, spec, body)` is the common frame: it runs `body({checks, evidence, defer})`, runs the deferred
 * clean-ups in reverse order, writes the evidence file, prints one line per check, and sets the exit code:
 * 0 pass, 1 fail, PENDING_EXIT_CODE (77, the usual "skipped" code) for a script marked pending with the WP that
 * will make it green. `scripts/ui-harness/run-flows.mjs` (npm run check:ui) reads these codes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const QA_DIR = path.join(REPO_ROOT, '.local', 'qa', 'ui-rebuild');
export const PENDING_EXIT_CODE = 77;

export function writeEvidence(name, data) {
  mkdirSync(QA_DIR, { recursive: true });
  const file = path.join(QA_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** A full-page screenshot at `.local/qa/ui-rebuild/<name>.png`; returns the repo-relative path. */
export async function screenshot(page, name, { fullPage = true } = {}) {
  mkdirSync(QA_DIR, { recursive: true });
  const file = path.join(QA_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return path.relative(REPO_ROOT, file).replaceAll('\\', '/');
}

export function createChecks() {
  const results = [];
  return {
    results,
    /** Records one named check. `detail` is kept in the evidence either way. */
    check(name, ok, detail) {
      results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
      return Boolean(ok);
    },
    /**
     * A check whose expected behaviour is an open owner question: recorded and printed, but not a failure. A script
     * whose only unmet checks are these exits pending (PENDING_EXIT_CODE) until the owner answers.
     */
    ask(name, ok, detail, question) {
      results.push({ name, ok: Boolean(ok), question, ...(detail === undefined ? {} : { detail }) });
      return Boolean(ok);
    },
    get passed() { return results.filter(r => r.ok).length; },
    get failed() { return results.filter(r => !r.ok && r.question === undefined).length; },
    get asked() { return results.filter(r => !r.ok && r.question !== undefined).length; }
  };
}

/**
 * @param {string} name the script's file name without `.mjs`, e.g. '01-launch-smoke'
 * @param {string} spec what it asserts, e.g. 'SPEC §10.2 script 1'
 * @param {(ctx: { checks: ReturnType<typeof createChecks>, evidence: Record<string, unknown>,
 *   defer: (fn: () => unknown) => void }) => Promise<void>} body
 */
export async function runScript(name, spec, body) {
  const checks = createChecks(), deferred = [];
  const evidence = { script: name, spec, startedAt: new Date().toISOString(), node: process.version, platform: process.platform };
  let crash = null;
  try {
    await body({ checks, evidence, defer: fn => deferred.push(fn) });
  } catch (error) {
    crash = error;
  }
  for (const fn of deferred.reverse()) {
    try { await fn(); } catch (error) { evidence.cleanupErrors = [...(evidence.cleanupErrors ?? []), String(error?.stack ?? error)]; }
  }
  if (crash) checks.check('the script ran to completion', false, String(crash?.stack ?? crash));
  const status = !checks.results.length || checks.failed > 0 ? 'fail' : checks.asked > 0 ? 'pending' : 'pass';
  Object.assign(evidence, { finishedAt: new Date().toISOString(), status, passed: checks.passed, failed: checks.failed, asked: checks.asked, checks: checks.results });
  const file = writeEvidence(name, evidence);
  for (const result of checks.results) {
    const mark = result.ok ? 'ok  ' : result.question === undefined ? 'FAIL' : 'ASK ';
    const detail = result.ok || result.detail === undefined ? '' : ` — ${typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail)}`;
    console.log(`${mark} ${result.name}${result.question === undefined || result.ok ? '' : ` [owner question: ${result.question}]`}${detail}`);
  }
  console.log(`${name}: ${status} (${checks.passed} passed, ${checks.failed} failed, ${checks.asked} awaiting the owner). Evidence: ${path.relative(REPO_ROOT, file).replaceAll('\\', '/')}`);
  process.exitCode = status === 'pass' ? 0 : status === 'pending' ? PENDING_EXIT_CODE : 1;
  return evidence;
}

/** Marks a flow script pending: writes its evidence and exits with PENDING_EXIT_CODE. */
export function pending(name, { wp, reason }) {
  const file = writeEvidence(name, { script: name, status: 'pending', wp, reason, at: new Date().toISOString() });
  console.log(`${name}: pending until ${wp} — ${reason}. Evidence: ${path.relative(REPO_ROOT, file).replaceAll('\\', '/')}`);
  process.exit(PENDING_EXIT_CODE);
}
