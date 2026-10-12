// categories.mjs - activates the test's categories (categories.json) as a new category revision on the site for the
// accuracy test window, and afterwards brings back the categories that were active before (DECISIONS 156 addendum:
// "The test categories are activated for the test window and Food/Clothes/Houses reactivated afterwards").
//
// It uses the site's own editor API, exactly as the Categories editor does (core/server/definitions.ts):
//   GET  /api/definitions                      the active revision, its threshold and the history
//   POST /api/definitions/drafts               {baseRevisionId, typeFile, displayNames} -> a new immutable revision
//   POST /api/definitions/<id>/activate        {inheritThreshold: false} -> that revision becomes active
// It is an editor action: the signed-in person must be a category editor, the site records who activated what and
// when, and nothing is lost because revisions are immutable. The site never re-activates an old revision id (an
// activation needs the revision's base to be the active one, once), so "restore" saves the earlier categories again
// as a new revision whose text is identical to the earlier one and activates that.
//
// Without --apply it is a dry run: it reads (GET only, every other request blocked) and prints exactly what it would
// change. With --apply it makes exactly those two writes (a route blocks anything else) and appends what it did to the
// state file, which "restore" reads.
//
// Usage (pinned Node, from the repository root):
//   node scripts/live-accuracy/categories.mjs switch  --origin https://<site> --profile <dir> --categories <categories.json> --state <.local/...jsonl> [--apply]
//   node scripts/live-accuracy/categories.mjs restore --origin https://<site> --profile <dir> --state <.local/...jsonl> [--apply] [--accept-threshold-reset]
// Exit codes: 0 done (or dry run printed), 1 refused or failed, 2 bad arguments.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayNamesOf, typeFileFrom } from './plan.mjs';
import { journal, openSite, postThroughPage, safeMessage } from './site.mjs';

const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const INITIAL_THRESHOLD = 0.9;

/** The state file's rows; the last switch without a later restore is the one in force. */
export function openSwitch(rows) {
  let current = null;
  for (const row of rows) {
    if (row.action === 'switched') current = row;
    if (row.action === 'restored') current = null;
  }
  return current;
}
export const readState = file => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []);

const describe = (typeFile, displayNames) => (typeFile?.types ?? []).map(type => `${type.id} ("${displayNames?.[type.id] ?? type.name}")`).join(', ');

/**
 * What a switch or restore would do, from GET /api/definitions and the wanted categories. Pure.
 * Returns {ok, refusal?, lines, write?: {baseRevisionId, typeFile, displayNames}}.
 */
export function planChange({ action, definitions, wanted, state, acceptThresholdReset = false }) {
  const lines = [];
  const refuse = refusal => ({ ok: false, refusal, lines });
  if (definitions?.mode !== 'runtime') return refuse('The site does not manage categories on the website (mode is not "runtime"); nothing can be activated.');
  if (definitions.canEdit !== true) return refuse('The signed-in person is not a category editor on this site.');
  const active = definitions.active;
  lines.push(`Active now: ${active ? `revision ${active.id}, threshold ${active.threshold} (${active.thresholdStatus}), categories ${describe(active.typeFile, active.displayNames)}` : 'no website categories (the pack\'s own)'}`);
  if (action === 'switch') {
    const open = openSwitch(state);
    if (open) return refuse(`The state file already records a switch to revision ${open.testRevisionId} that has not been restored. Restore first, or use a new state file.`);
    if (active && JSON.stringify(active.typeFile) === JSON.stringify(wanted.typeFile))
      return refuse('categories.json is already the active categories; nothing to change.');
    lines.push(`Will save categories.json as a new revision based on ${active ? active.id : 'nothing'}: ${describe(wanted.typeFile, wanted.displayNames)}`);
    lines.push(`Will activate it without inheriting the threshold: the threshold becomes ${INITIAL_THRESHOLD} (untested), the design's initial value.`);
    lines.push('Runs already confirmed keep the categories they froze; new runs use the new categories. Trial confirmations and per-reader calibrations recorded against the current revision do not apply to the new one.');
    return { ok: true, lines, previous: active, write: { baseRevisionId: active?.id ?? null, typeFile: wanted.typeFile, displayNames: wanted.displayNames } };
  }
  const open = openSwitch(state);
  if (!open) return refuse('The state file records no switch to undo.');
  if (!open.previous) return refuse('Before the switch the site had no website categories; there is no earlier revision to bring back. Restore needs a person to choose the categories.');
  if (active?.id !== open.testRevisionId)
    return refuse(`The active revision is ${active?.id ?? 'none'}, not the test's ${open.testRevisionId}: someone changed the categories since the switch. Nothing will be changed; a person decides.`);
  const previous = open.previous;
  lines.push(`Will save the categories that were active before the switch (revision ${previous.id}) again, as a new revision based on ${active.id}: ${describe(previous.typeFile, previous.displayNames)}`);
  lines.push('The text is identical to the earlier revision; it gets a new revision id because the site never activates an old id twice.');
  lines.push(`Will activate it without inheriting the threshold: the threshold becomes ${INITIAL_THRESHOLD} (untested). Before the switch it was ${previous.threshold} (${previous.thresholdStatus}).`);
  const lost = previous.threshold !== INITIAL_THRESHOLD || previous.thresholdStatus !== 'untested';
  if (lost) {
    lines.push(`NOTE: the earlier threshold ${previous.threshold} (${previous.thresholdStatus}) cannot be carried over by activation; restoring it is a separate, person-approved threshold change.`);
    if (!acceptThresholdReset) return refuse(`${lines.at(-1)} Add --accept-threshold-reset to restore the categories with the ${INITIAL_THRESHOLD} (untested) threshold.`);
  }
  lines.push('Trial confirmations and saved feedback tied to the earlier revision id stay with that id (history keeps it).');
  return { ok: true, lines, previous, write: { baseRevisionId: active.id, typeFile: previous.typeFile, displayNames: previous.displayNames } };
}

/** The guard for --apply: exactly one draft (the planned body) and one activation of the draft it returned. */
export function categoryJudge(expected) {
  const state = { draftSent: false, draftId: null, activateSent: false };
  const judge = request => {
    if (!request.sameOrigin || request.method !== 'POST') return { allow: false, reason: 'not a write this helper makes' };
    if (request.path === '/api/definitions/drafts' && !state.draftSent &&
        JSON.stringify(request.body) === JSON.stringify(expected)) { state.draftSent = true; return { allow: true, reason: 'the planned draft' }; }
    if (state.draftId && request.path === `/api/definitions/${encodeURIComponent(state.draftId)}/activate` && !state.activateSent &&
        JSON.stringify(request.body) === JSON.stringify({ inheritThreshold: false })) { state.activateSent = true; return { allow: true, reason: 'activating the planned draft' }; }
    return { allow: false, reason: 'not the planned write' };
  };
  return { judge, state };
}

export async function changeCategories({ action, origin, profile, categories, stateFile, apply = false, acceptThresholdReset = false, print = console.log }) {
  const state = readState(stateFile);
  const log = journal(stateFile + '.journal.jsonl', false);
  const wanted = action === 'switch' ? (() => { const typeFile = typeFileFrom(readJson(categories), path.basename(categories)); return { typeFile, displayNames: displayNamesOf(typeFile) }; })() : null;
  const receipts = [];
  let guard = null;
  const judge = request => {
    const verdict = guard ? guard.judge(request) : { allow: false, reason: 'dry run: GET only' };
    receipts.push({ method: request.method, path: request.path, allowed: verdict.allow, reason: verdict.reason });
    log(verdict.allow ? 'write-allowed' : 'write-blocked', receipts.at(-1));
    return verdict;
  };
  const site = await openSite({ profile, origin, judge });
  try {
    await site.page.goto(origin + '/#/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const definitions = await site.get('/api/definitions');
    const plan = planChange({ action, definitions, wanted, state, acceptThresholdReset });
    log('planned', { action, apply, ok: plan.ok, refusal: plan.refusal ?? null, lines: plan.lines });
    for (const line of plan.lines) print(line);
    if (!plan.ok) { print(`REFUSED: ${plan.refusal}`); return { exitCode: 1, plan }; }
    if (!apply) { print('DRY RUN: nothing was changed. Add --apply to make exactly these changes.'); return { exitCode: 0, plan, dryRun: true }; }
    guard = categoryJudge(plan.write);
    const draft = await postThroughPage(site.page, '/api/definitions/drafts', plan.write);
    guard.state.draftId = draft.id;
    log('draft-saved', { revisionId: draft.id });
    const { active } = await postThroughPage(site.page, `/api/definitions/${encodeURIComponent(draft.id)}/activate`, { inheritThreshold: false });
    const after = await site.get('/api/definitions');
    if (after.active?.id !== draft.id) throw new Error(`after activation the active revision is ${after.active?.id ?? 'none'}, not ${draft.id}`);
    const row = action === 'switch'
      ? { at: new Date().toISOString(), action: 'switched', origin, testRevisionId: draft.id, threshold: active.threshold, thresholdStatus: active.thresholdStatus,
          previous: plan.previous ? { id: plan.previous.id, typeFile: plan.previous.typeFile, displayNames: plan.previous.displayNames, threshold: plan.previous.threshold, thresholdStatus: plan.previous.thresholdStatus } : null }
      : { at: new Date().toISOString(), action: 'restored', origin, restoredRevisionId: draft.id, sameTextAs: plan.previous.id, threshold: active.threshold, thresholdStatus: active.thresholdStatus };
    journal(stateFile, false)(row.action, row);
    print(`DONE: revision ${draft.id} is active (threshold ${active.threshold}, ${active.thresholdStatus}).`);
    return { exitCode: 0, plan, revisionId: draft.id, receipts };
  } catch (error) {
    print(`FAILED: ${safeMessage(error)}`);
    log('failed', { error: safeMessage(error) });
    return { exitCode: 1, error: safeMessage(error), receipts };
  } finally {
    await site.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...rest] = process.argv.slice(2);
  const options = {};
  try {
    if (!['switch', 'restore'].includes(action)) throw new Error('first argument: switch or restore');
    for (let i = 0; i < rest.length; i++) {
      const name = rest[i];
      if (name === '--apply' || name === '--accept-threshold-reset') { options[name.slice(2)] = true; continue; }
      if (!['--origin', '--profile', '--categories', '--state'].includes(name) || rest[i + 1] === undefined) throw new Error(`Unexpected argument ${name}`);
      options[name.slice(2)] = rest[++i];
    }
    for (const needed of ['origin', 'profile', 'state', ...(action === 'switch' ? ['categories'] : [])])
      if (!options[needed]) throw new Error(`--${needed} is required`);
    if (!/^https:\/\//.test(options.origin)) throw new Error('--origin must be an https:// address');
  } catch (error) { console.error(`categories: ${error.message}`); process.exit(2); }
  changeCategories({ action, origin: options.origin.replace(/\/+$/, ''), profile: options.profile, categories: options.categories, stateFile: options.state,
    apply: !!options.apply, acceptThresholdReset: !!options['accept-threshold-reset'] })
    .then(result => { process.exitCode = result.exitCode; }, error => { console.error(`categories: ${safeMessage(error)}`); process.exitCode = 1; });
}
