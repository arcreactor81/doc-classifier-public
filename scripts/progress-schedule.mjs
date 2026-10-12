import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const state=JSON.parse(readFileSync(resolve(root,'.local/work-status.json'),'utf8'));
const target=JSON.parse(readFileSync(resolve(root,'.local/progress-target.json'),'utf8'));
const record={at:new Date().toISOString(),status:state.status,thread:target.threadId};
if(state.status==='working'&&state.progressAuditsEnabled!==false){
 const message='Scheduled 15-minute progress audit requested by the owner: review remaining authorized Doc Classifier work and continue wherever independent progress is possible. If genuinely blocked or complete, record the evidence in HANDOFF.md and .local/work-status.json; no update is acceptable when nothing actionable remains. Respect user pauses, pending questions, key restrictions and repository invariants. This reminder does not authorize new vendor calls.';
 const run=spawnSync(target.codexPath,['queue','--thread',target.threadId,'--message',message],{encoding:'utf8',windowsHide:true,cwd:root,timeout:90000});
 record.exitCode=run.status; record.result=run.error?.message??(run.stdout+run.stderr).trim();
}else record.result='No queued continuation: work status is not working.';
appendFileSync(resolve(root,'.local/progress-schedule.jsonl'),JSON.stringify(record)+'\n');
if(record.exitCode!==undefined&&record.exitCode!==0)process.exit(1);
