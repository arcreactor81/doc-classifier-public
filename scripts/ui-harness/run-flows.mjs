/**
 * `npm run check:ui` (SPEC §10.2): runs every `scripts/ui-flow/*.mjs` in name order, one Node process each, and
 * stops at the first failure. Outside the gate. Exit codes: 0 pass, 77 pending (reported, then the run
 * continues), anything else a failure.
 *
 *   node scripts/ui-harness/run-flows.mjs            every script
 *   node scripts/ui-harness/run-flows.mjs 01 05      only scripts whose names start with 01 or 05
 *
 * Writes a summary to `.local/qa/ui-rebuild/check-ui.json`.
 *
 * A script that has not finished after UI_FLOW_TIMEOUT_MS (default 10 minutes) is stopped and counts as a
 * failure, so one hung page (a `page.evaluate` that never settles, a held request never released) cannot hang
 * the whole run.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PENDING_EXIT_CODE, REPO_ROOT, writeEvidence } from './evidence.mjs';

// UI_FLOW_DIR exists only to test this runner against a scratch folder; the default is the real one.
const FLOW_DIR = process.env.UI_FLOW_DIR ? path.resolve(process.env.UI_FLOW_DIR) : path.join(REPO_ROOT, 'scripts', 'ui-flow');
const TIMEOUT_MS = process.env.UI_FLOW_TIMEOUT_MS === undefined ? 10 * 60_000 : Number(process.env.UI_FLOW_TIMEOUT_MS);
if (!Number.isSafeInteger(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error(`UI_FLOW_TIMEOUT_MS must be a positive whole number of milliseconds, not "${process.env.UI_FLOW_TIMEOUT_MS}".`);
  process.exit(1);
}
const prefixes = process.argv.slice(2);
const scripts = readdirSync(FLOW_DIR).filter(name => name.endsWith('.mjs'))
  .filter(name => !prefixes.length || prefixes.some(prefix => name.startsWith(prefix)))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const summary = { startedAt: new Date().toISOString(), filter: prefixes, timeoutMs: TIMEOUT_MS, scripts: [], status: 'pass' };
if (!scripts.length) {
  summary.status = 'fail';
  summary.reason = 'no flow script matched';
}
for (const name of scripts) {
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const run = spawnSync(process.execPath, [path.join(FLOW_DIR, name)], { cwd: REPO_ROOT, stdio: 'inherit', timeout: TIMEOUT_MS });
  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (run.error)?.code === 'ETIMEDOUT';
  const code = run.error ? null : run.status;
  const outcome = code === 0 ? 'pass' : code === PENDING_EXIT_CODE ? 'pending' : 'fail';
  if (timedOut) console.log(`${name}: stopped after ${TIMEOUT_MS} ms without finishing (counted as a failure).`);
  summary.scripts.push({ name, outcome, exitCode: code, signal: run.signal ?? null, timedOut,
    error: run.error ? String(run.error) : null, ms: Date.now() - started });
  if (outcome === 'fail') {
    summary.status = 'fail';
    summary.stoppedAt = name;
    break;
  }
}
summary.finishedAt = new Date().toISOString();
summary.counts = Object.fromEntries(['pass', 'pending', 'fail'].map(kind => [kind, summary.scripts.filter(s => s.outcome === kind).length]));
writeEvidence('check-ui', summary);
console.log(`\ncheck:ui ${summary.status}: ${summary.counts.pass} passed, ${summary.counts.pending} pending, ${summary.counts.fail} failed` +
  `${summary.stoppedAt ? ` (stopped at ${summary.stoppedAt})` : ''}${summary.reason ? ` — ${summary.reason}` : ''}.`);
process.exit(summary.status === 'pass' ? 0 : 1);
