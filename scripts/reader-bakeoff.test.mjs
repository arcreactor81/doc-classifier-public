import test from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest,verifyCellText,requestForCell,accountAttempt} from './reader-bakeoff/contract.mjs';
const models=['gpt-5.6-terra','gpt-6-sol'];
const text='First\nSecond';
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const typeFile={types:[{id:'type_a',name:'Type A',what:'Definition',not_for:'Exclusion',examples:['Example']}],none_of_these:{name:'None',what:'No match'}};
async function fixture(){return{id:'test-evaluation',actor:'test-owner',authorization:'owner authorized isolated comparison',baselineVerifiedAt:'2026-09-23T00:00:00Z',baselineOpenaiNano:'112141200',baselineTypesafeNano:'4185216',limitNano:'5000000000',typeFile,typeHash:await sha(JSON.stringify(typeFile)),cells:Array.from({length:5},(_,i)=>models.map((model,j)=>({id:`cell-${i}-${j}`,caseId:`case-${i}`,model,textSha256:null}))).flat().map(cell=>({...cell,textSha256:''})).map(cell=>({...cell}))};}
test('frozen comparison rejects missing or duplicate cells and arbitrary models',async()=>{
 const m=await fixture();for(const c of m.cells)c.textSha256=await sha(text);validateManifest(m);
 for(const changed of [{...m,cells:m.cells.slice(1)},{...m,cells:[...m.cells.slice(1),m.cells[1]]},{...m,cells:m.cells.map((c,i)=>i?c:{...c,model:'gpt-6-astra'})}])assert.throws(()=>validateManifest(changed));
});
test('only exact hash-checked text can construct model-only differing requests',async()=>{
 const m=await fixture();for(const c of m.cells)c.textSha256=await sha(text);await verifyCellText(m,m.cells[0],text);
 await assert.rejects(verifyCellText(m,m.cells[0],'First Second'));
 const bodies=m.cells.slice(0,2).map(c=>{const b=JSON.parse(requestForCell(m,c,text).body);delete b.model;return b;});assert.deepEqual(bodies[0],bodies[1]);
});
test('accounting requires raw persistence, exact model family and explicit zero cache counts',()=>{
 const usage={input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}};
 assert.throws(()=>accountAttempt('gpt-6-sol',{model:'gpt-6-sol',usage},false));
 assert.equal(accountAttempt('gpt-6-sol',{model:'gpt-6-sol',usage},true),'3000000');
 assert.throws(()=>accountAttempt('gpt-6-luna',{model:'gpt-6-luna',usage},true));
 assert.throws(()=>accountAttempt('gpt-6-sol',{model:'gpt-6-luna',usage},true));
 assert.throws(()=>accountAttempt('gpt-6-sol',{model:'gpt-6-sol',usage:{...usage,input_tokens_details:{cached_tokens:1,cache_write_tokens:0}}},true));
 assert.throws(()=>accountAttempt('gpt-6-sol',{model:'gpt-6-sol'},true));
});
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {initialize,runCell} from './reader-bakeoff/worker.mjs';
function database(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./reader-bakeoff/schema.sql',import.meta.url),'utf8'));db.exec('CREATE TABLE controls(id INTEGER PRIMARY KEY,kill INTEGER); INSERT INTO controls VALUES(1,0); CREATE TABLE runs(id TEXT,status TEXT); CREATE TABLE vendor_calls(cost_nano INTEGER,created_at TEXT); CREATE TABLE provider_cooldowns(scope TEXT,until_ms INTEGER);');return{raw:db,prepare(sql){let args=[];const result={bind(...values){args=values;return result;},async first(){return db.prepare(sql).get(...args)||null;},async run(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async all(){return{results:db.prepare(sql).all(...args)}}};return result;},async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};}
async function envFixture(){const m=await fixture();for(const c of m.cells)c.textSha256=await sha(text);const DB=database(),objects=new Map();const env={DB,MODEL_CALLS_ENABLED:'true',OPENAI_API_KEY:{async get(){return 'synthetic-test-only';}},ARTIFACTS:{async head(key){return objects.has(key)?{}:null;},async put(key,value){objects.set(key,typeof value==='string'?value:await new Response(value).text());},async get(key){if(!objects.has(key))return null;const v=objects.get(key);return{size:Buffer.byteLength(v),text:async()=>v};}}};await initialize(env,m);return{m,env,objects};}
const successfulResponse=model=>new Response(JSON.stringify({model,status:'completed',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({verdicts:[{type_id:'type_a',is_type:true,rationale:'Reason',evidence:['First\nSecond'],closest_alternative:null}]})}]}]}));
test('durable evaluation retains raw before accounting, refuses duplicate dispatch and follows frozen order',async()=>{
 const {m,env,objects}=await envFixture();let calls=0;const send=async()=>{calls++;return successfulResponse(m.cells[0].model);};
 await assert.rejects(runCell(env,m,m.cells[1].id,text,send));assert.equal(calls,0);
 const result=await runCell(env,m,m.cells[0].id,text,send);assert.equal(result.status,'valid');assert.equal(calls,1);assert.equal(objects.size,2);
 const row=env.DB.raw.prepare('SELECT * FROM reader_eval_attempts').get();assert.equal(row.cost_nano,3200000);assert.ok(objects.has(row.raw_key));assert.ok(objects.has(row.metadata_key));
 await assert.rejects(runCell(env,m,m.cells[0].id,text,send));assert.equal(calls,1);
});
test('kill, disabled calls, unknown usage and concurrent active cells stop new inference',async()=>{
 for(const condition of ['kill','disabled','busy','unknown']){const {m,env}=await envFixture();let calls=0;if(condition==='kill')env.DB.raw.exec('UPDATE controls SET kill=1');if(condition==='disabled')env.MODEL_CALLS_ENABLED='false';if(condition==='busy')env.DB.raw.exec("UPDATE reader_eval_campaigns SET busy='existing'");if(condition==='unknown')env.DB.raw.exec("INSERT INTO reader_eval_attempts(id,campaign_id,cell_id,body_sha256,model_requested,state,created_at) VALUES('unknown','test-evaluation','other','hash','gpt-6-sol','dispatched','2026-09-23')");await assert.rejects(runCell(env,m,m.cells[0].id,text,async()=>{calls++;return successfulResponse(m.cells[0].model);}));assert.equal(calls,0);}
});
test('raw persistence failure and unknown billed usage halt campaign without retries',async()=>{
 for(const failure of ['storage','usage']){const {m,env}=await envFixture();let calls=0;if(failure==='storage')env.ARTIFACTS.put=async()=>{throw new Error('synthetic storage failure');};const result=await runCell(env,m,m.cells[0].id,text,async()=>{calls++;return failure==='usage'?new Response(JSON.stringify({model:m.cells[0].model,status:'completed'})):successfulResponse(m.cells[0].model);});assert.equal(result.status,'failed');assert.equal(calls,1);assert.ok(env.DB.raw.prepare('SELECT halted FROM reader_eval_campaigns').get().halted);assert.equal(env.DB.raw.prepare('SELECT cost_nano FROM reader_eval_attempts').get().cost_nano,null);}
});

import {replayReader} from './reader-bakeoff/replay.mjs';
test('replay reports separate old and approved note policies without changing source notes',()=>{
 const source={notes:['N_NO_OUTLINE'],confidence:{choice:'type_a',certainty:0.95,noul:{type_a:0.9}}};const original=JSON.stringify(source);const result=replayReader(source,{verdicts:[{type_id:'type_a',is_type:true}]},['type_a']);assert.equal(result.historicalNotePolicy.ruleId,'R0n');assert.equal(result.approvedNotePolicy.ruleId,'R1');assert.deepEqual(result.approvedNotePolicy.notes,['N_NO_OUTLINE']);assert.equal(JSON.stringify(source),original);
});

test('dispatch marker write failures and absent rows halt before any HTTP request',async()=>{for(const mode of ['throw','zero']){const {m,env}=await envFixture();const prepare=env.DB.prepare.bind(env.DB);env.DB.prepare=sql=>{const q=prepare(sql);if(sql.startsWith('INSERT INTO reader_eval_attempts'))q.run=async()=>{if(mode==='throw')throw Error('synthetic marker failure');return{meta:{changes:0}};};return q;};let calls=0;const result=await runCell(env,m,m.cells[0].id,text,async()=>{calls++;return successfulResponse(m.cells[0].model);});assert.equal(result.status,'failed');assert.equal(calls,0);assert.ok(env.DB.raw.prepare('SELECT halted FROM reader_eval_campaigns').get().halted);}});

test('critical raw/accounting row updates cannot silently affect zero rows',async()=>{for(const state of ['raw_saved','accounted']){const {m,env}=await envFixture();const prepare=env.DB.prepare.bind(env.DB);env.DB.prepare=sql=>{const q=prepare(sql);if(sql.startsWith("UPDATE reader_eval_attempts SET state='"+state+"'"))q.run=async()=>({meta:{changes:0}});return q;};let calls=0;const result=await runCell(env,m,m.cells[0].id,text,async()=>{calls++;return successfulResponse(m.cells[0].model);});assert.equal(result.status,'failed');assert.equal(calls,1);assert.ok(env.DB.raw.prepare('SELECT halted FROM reader_eval_campaigns').get().halted);}});

test('shared evaluation allowance and unknown or busy attempts cover other campaigns',async()=>{for(const mode of ['spent','unknown','busy']){const {m,env}=await envFixture();await initialize(env,{...m,id:'other-evaluation'});if(mode==='busy')env.DB.raw.exec("UPDATE reader_eval_campaigns SET busy='other-cell' WHERE id='other-evaluation'");else env.DB.raw.prepare("INSERT INTO reader_eval_attempts(id,campaign_id,cell_id,body_sha256,model_requested,state,cost_nano,created_at) VALUES('other-attempt','other-evaluation','other-cell','hash','gpt-6-sol','accounted',?,?)").run(mode==='unknown'?null:4900000000,'2026-09-23T01:00:00Z');let calls=0;await assert.rejects(runCell(env,m,m.cells[0].id,text,async()=>{calls++;return successfulResponse(m.cells[0].model);}));assert.equal(calls,0);}});

import {buildEvaluationConfig} from './reader-bakeoff/prepare-config.mjs';
test('private deployment bundles full manifest while environment values contain only its hash',async()=>{const m=await fixture();for(const c of m.cells)c.textSha256=await sha(text);m.provenance='x'.repeat(11000);const owner={env:{validation:{d1_databases:[{binding:'DB',database_id:'synthetic',migrations_dir:'migrations'}],r2_buckets:[{binding:'ARTIFACTS',bucket_name:'synthetic'}],secrets_store_secrets:[{binding:'OPENAI_API_KEY',store_id:'synthetic',secret_name:'synthetic'}],vars:{ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'test'}}}};const result=await buildEvaluationConfig(owner,m,'./.local/frozen-manifest.json','./.local/deployment.json');assert.equal(result.config.vars.BAKEOFF_MANIFEST,undefined);assert.equal(result.config.vars.BAKEOFF_MANIFEST_SHA256,await sha(JSON.stringify(m)));assert.ok(Object.values(result.config.vars).every(value=>Buffer.byteLength(String(value))<5000));assert.match(result.wrapperSource,/import manifest from/);assert.match(result.wrapperSource,/createEvaluationWorker/);assert.equal(result.config.vars.MODEL_CALLS_ENABLED,'false');});
