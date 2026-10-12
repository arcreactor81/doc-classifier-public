import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const event = input.trim() ? JSON.parse(input) : { hook_event_name: 'PostToolUse' };
const root = resolve(import.meta.dirname, '..');
const folder = resolve(root, '.local');
mkdirSync(folder, {recursive:true});
const statusPath = resolve(folder, 'work-status.json');
const stampPath = resolve(folder, 'last-progress-check.json');
const state = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : {status:'unconfigured'};
if (state.progressAuditsEnabled === false || state.status === 'paused') { process.stdout.write('{}'); process.exit(0); }
const previous = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath,'utf8')).time : 0;
const now = Date.now();
const due = now - previous >= 15 * 60 * 1000;
const stopping = event.hook_event_name === 'Stop';
if (due || stopping) {
  writeFileSync(stampPath, JSON.stringify({time:now}));
  appendFileSync(resolve(folder,'progress-checks.jsonl'), JSON.stringify({at:new Date(now).toISOString(), event:event.hook_event_name, status:state.status, remaining:state.remaining ?? [], blockers:state.blockers ?? []})+'\n');
}
const message = 'Progress audit: continue authorized Doc Classifier work if useful independent work remains. Review HANDOFF.md and .local/work-status.json. Respect user pauses, pending clarification, missing dependencies, and all key restrictions. A real blocked/complete status must list evidence; no update is a valid result only when nothing actionable remains.';
if (stopping && state.status === 'working' && Array.isArray(state.remaining) && state.remaining.length) {
  process.stdout.write(JSON.stringify({decision:'block',reason:message}));
} else if (due && event.hook_event_name === 'PostToolUse') {
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:message}}));
} else process.stdout.write('{}');
