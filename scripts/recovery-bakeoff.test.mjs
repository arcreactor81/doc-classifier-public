import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryRequest,validateRecoveryResult,compareReference,verifyRecoverySource} from './recovery-bakeoff/contract.mjs';
import {createHash} from 'node:crypto';
const text='Heading\nBody\nHeading\nSection';
const source={input:{artifactSha256:''},textSha256:createHash('sha256').update(text).digest('hex'),originalFingerprint:'test-fingerprint'};
test('recovery experiment permits only Luna family in recovery role and identical model-only bodies',()=>{
 const a=JSON.parse(recoveryRequest('gpt-5.6-luna',text,{effort:'low',maxOutputTokens:8192}).body),b=JSON.parse(recoveryRequest('gpt-6-luna',text,{effort:'low',maxOutputTokens:8192}).body);delete a.model;delete b.model;assert.deepEqual(a,b);assert.equal(a.max_output_tokens,8192);assert.deepEqual(a.reasoning,{effort:'low'});assert.equal(a.input[1].content,text);assert.throws(()=>recoveryRequest('gpt-6-sol',text,{effort:'low',maxOutputTokens:8192}));
});
test('recovery schema and exact full-line verifier preserve rejection and all positions',()=>{
 const raw={model:'gpt-6-luna',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({headings:['Heading',' Section','Heading Body']})}]}]};const result=validateRecoveryResult(raw,'gpt-6-luna',text);assert.deepEqual(result.verification.verified,[{text:'Heading',positions:[0,13]}]);assert.deepEqual(result.verification.rejected.map(v=>v.text),[' Section','Heading Body']);assert.deepEqual(result.value.headings,['Heading',' Section','Heading Body']);assert.throws(()=>validateRecoveryResult({...raw,model:'gpt-6-sol'},'gpt-6-luna',text));
});
test('reference comparison distinguishes definite, optional, extra and repeated candidates without rewriting',()=>{
 const candidates=['Heading','Heading','Section','Body'];const copy=JSON.stringify(candidates);const report=compareReference(text,candidates,{definite:['Heading'],optional:['Section']});assert.deepEqual(report.definiteMatched,['Heading']);assert.deepEqual(report.optionalMatched,['Section']);assert.deepEqual(report.otherExactLines,['Body']);assert.equal(report.duplicateCandidateCount,1);assert.equal(JSON.stringify(candidates),copy);
});
test('only frozen pre-recovery PDF text with actual eligibility may enter comparison',()=>{
 const input={fullText:text,needsOutlineRecovery:true,originalFilename:'sample.pdf',fingerprint:'test-fingerprint',outline:{headings:[{text:'Heading'}]}};const bytes=JSON.stringify(input);const s={...source,input:{artifactSha256:createHash('sha256').update(bytes).digest('hex')}};assert.equal(verifyRecoverySource(s,bytes,3).fullText,text);assert.throws(()=>verifyRecoverySource(s,bytes+' ',3));assert.throws(()=>verifyRecoverySource(s,bytes,1));const altered=JSON.stringify({...input,needsOutlineRecovery:false});assert.throws(()=>verifyRecoverySource({...s,input:{artifactSha256:createHash('sha256').update(altered).digest('hex')}},altered,3));
});

import {normalizeRecoveryManifest,recoveryAdapter} from './recovery-bakeoff/runtime-contract.mjs';
const h='a'.repeat(64);
function frozenRecovery(){return{id:'recovery-test',role:'recovery',actor:'owner',authorization:'explicit recovery comparison',settings:{effort:'low',maxOutputTokens:8192,minimumHeadings:3},campaignBaseline:{verifiedAt:'2026-09-23T05:17:43.053Z',openaiNano:'112141200',typesafeNano:'4185216',limitsNano:{openai:'5000000000',typesafe:'5000000000'}},sources:[{id:'case-a',eligible:true,preRecovery:true,originalHeadingCount:1,textSha256:h},{id:'case-b',eligible:true,preRecovery:true,originalHeadingCount:2,textSha256:h}],cells:['case-a','case-b'].flatMap(caseId=>['gpt-5.6-luna','gpt-6-luna'].map(model=>({id:caseId+'-'+model.replaceAll('.','-'),caseId,role:'recovery',model,textSha256:h,requestSha256:h})))};}
test('runtime recovery adapter admits exactly two eligible paired sources with shared campaign baseline',()=>{
 const m=normalizeRecoveryManifest(frozenRecovery());assert.equal(m.baselineOpenaiNano,'112141200');assert.equal(m.cells.length,4);assert.equal(recoveryAdapter.role,'recovery');assert.equal(recoveryAdapter.retryPolicy.schemaAttempts,1);
 for(const change of [{...m,role:'reader'},{...m,cells:m.cells.slice(1)},{...m,cells:m.cells.map((c,i)=>i?c:{...c,model:'gpt-6-sol'})},{...m,sources:m.sources.map((s,i)=>i?s:{...s,eligible:false})}])assert.throws(()=>recoveryAdapter.validateManifest(change));
});
test('runtime recovery accounting uses Luna prices and rejects reader identities or unknown cache usage',()=>{
 const usage={input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}};
 assert.equal(recoveryAdapter.accountAttempt('gpt-5.6-luna',{model:'gpt-5.6-luna',usage},true),'320000');assert.equal(recoveryAdapter.accountAttempt('gpt-6-luna',{model:'gpt-6-luna',usage},true),'150000');
 assert.throws(()=>recoveryAdapter.accountAttempt('gpt-6-sol',{model:'gpt-6-sol',usage},true));assert.throws(()=>recoveryAdapter.accountAttempt('gpt-6-luna',{model:'gpt-6-luna',usage:{input_tokens:1000,output_tokens:100}},true));
});

import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {initialize,runCell} from './reader-bakeoff/worker.mjs';
function evalDatabase(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./reader-bakeoff/schema.sql',import.meta.url),'utf8'));db.exec('CREATE TABLE controls(id INTEGER PRIMARY KEY,kill INTEGER);INSERT INTO controls VALUES(1,0);CREATE TABLE runs(id TEXT,status TEXT);CREATE TABLE vendor_calls(cost_nano INTEGER,created_at TEXT);CREATE TABLE provider_cooldowns(scope TEXT,until_ms INTEGER);');return{raw:db,prepare(sql){let args=[];const q={bind(...values){args=values;return q;},async first(){return db.prepare(sql).get(...args)||null;},async run(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async all(){return{results:db.prepare(sql).all(...args)}}};return q;},async batch(list){db.exec('BEGIN');try{const output=[];for(const q of list)output.push(await q.run());db.exec('COMMIT');return output;}catch(e){db.exec('ROLLBACK');throw e;}}};}
async function recoveryEnv(){const m=normalizeRecoveryManifest(frozenRecovery()),text='Heading\nBody\nSection';const digest=createHash('sha256').update(text).digest('hex');for(const s of m.sources)s.textSha256=digest;for(const c of m.cells){c.textSha256=digest;c.requestSha256=createHash('sha256').update(recoveryAdapter.requestForCell(m,c,text).body).digest('hex');}const objects=new Map();const env={DB:evalDatabase(),MODEL_CALLS_ENABLED:'true',OPENAI_API_KEY:{async get(){return 'synthetic-only';}},ARTIFACTS:{async head(k){return objects.has(k)?{}:null;},async put(k,v){objects.set(k,typeof v==='string'?v:await new Response(v).text());},async get(k){if(!objects.has(k))return null;const v=objects.get(k);return{size:Buffer.byteLength(v),text:async()=>v};}}};await initialize(env,m,recoveryAdapter);return{m,text,env,objects};}
function recoveryResponse(model,headings){return new Response(JSON.stringify({model,status:'completed',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({headings})}]}]}));}
test('shared executor accepts recovery adapter and retains invalid headings without correction',async()=>{
 const {m,text,env}=await recoveryEnv();let calls=0;const result=await runCell(env,m,m.cells[0].id,text,async()=>{calls++;return recoveryResponse(m.cells[0].model,['Heading',' Heading','Section']);},recoveryAdapter);assert.equal(calls,1);assert.equal(result.status,'valid');assert.deepEqual(result.value.headings,['Heading',' Heading','Section']);assert.deepEqual(result.value.verification.rejected,[{text:' Heading',reason:'not_an_exact_line'}]);assert.equal(env.DB.raw.prepare('SELECT cost_nano FROM reader_eval_attempts').get().cost_nano,320000);
});
test('recovery never receives reader-only schema retry',async()=>{
 const {m,text,env}=await recoveryEnv();let calls=0;const result=await runCell(env,m,m.cells[0].id,text,async()=>{calls++;return recoveryResponse(m.cells[0].model,[3]);},recoveryAdapter);assert.equal(result.status,'failed');assert.equal(calls,1);assert.equal(result.code,'E_RECOVERY_SCHEMA');
});
test('recovery uses global shared evaluator budget unknown and single-flight gates',async()=>{
 for(const condition of ['budget','unknown','busy']){const {m,text,env}=await recoveryEnv();const other={...m,id:'other-evaluation'};await initialize(env,other,recoveryAdapter);if(condition==='busy')env.DB.raw.exec("UPDATE reader_eval_campaigns SET busy='other-cell' WHERE id='other-evaluation'");else env.DB.raw.prepare("INSERT INTO reader_eval_attempts(id,campaign_id,cell_id,body_sha256,model_requested,state,cost_nano,created_at) VALUES('previous','other-evaluation','other-cell','hash','gpt-6-sol','accounted',?,'2026-09-23T06:00:00Z')").run(condition==='budget'?4887858800:null);let calls=0;await assert.rejects(runCell(env,m,m.cells[0].id,text,async()=>{calls++;return recoveryResponse(m.cells[0].model,['Heading']);},recoveryAdapter));assert.equal(calls,0);}
});
