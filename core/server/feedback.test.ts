import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReferenceLineage,referenceEntriesFromStored,carriedReferenceEntries,carryReference,saveReference,readReference,readReferenceHead} from './feedback.ts';
import {migratedDatabase,localD1,memoryR2} from './testing/local-bindings.ts';
import {Store,type RunRow} from './store.ts';
test('reference run must pin exact owner accepted definition revision',()=>{
 assert.doesNotThrow(()=>validateReferenceLineage('rev','rev'));
 assert.throws(()=>validateReferenceLineage('rev','other'));
 assert.throws(()=>validateReferenceLineage('rev',undefined));
});
test('stored source correction provides labels without accepting client results',()=>{
 const entry={fingerprint:'one',tag:'t',originalFilename:'file.pdf',destinationFolder:'human_review',rule:'R4'};
 const diff={confirmations:[],moves:[{entry,file:{folder:'New category',filename:'file.pdf'},matchedBy:'tag' as const,from:'human_review',to:'New category',kind:'unresolved_folder' as const}],unchecked:[],deleted:[],unmatched:[],ignored:[],unknownFolders:[]};
 assert.equal(referenceEntriesFromStored([entry],diff,['new_type'],[],{'New category':'new_type'},[])[0].labels[0],'new_type');
 assert.equal(referenceEntriesFromStored([entry],{...diff,moves:[],unchecked:[diff.moves[0]]},['new_type'],[],{},[])[0].status,'unconfirmed');
});

// Real SQL over the real migrations (feedback_labels rows, the immutability triggers, json_each) and an in-memory
// bucket for the saved correction analysis. `documents` source documents, the first confirmed in 'a', the rest moved to 'b'.
const USAGE_LIMITS={policy:'daily-usage-v1',maxDocumentsPerRun:60,maxRunsPerActorPerDay:3,openaiTokenPools:[{id:'pool',modelIds:['m'],limitTokens:1}],typesafeDailyNano:'1'};
function fixture(documents:number,options:{usageLimits?:boolean;editors?:string[];trusted?:string[]}={}){
 const db=migratedDatabase({foreignKeys:false}),bucket=memoryR2(),env={DB:localD1(db),ARTIFACTS:bucket,...(options.editors?{DEFINITION_EDITORS:JSON.stringify(options.editors)}:{}),...(options.trusted?{TRUSTED_USERS:JSON.stringify(options.trusted)}:{})} as unknown as Env,store=new Store(env);
 const types=JSON.stringify({types:[{id:'a'},{id:'b'}]});
 db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('source','owner','closed','2026-09-29','interactive',?,0.9,'initial','v',?,'{}','q')").run(documents,JSON.stringify({typeFile:JSON.parse(types),...(options.usageLimits?{settings:{usageLimits:USAGE_LIMITS}}:{})}));
 const revision=(id:string,base:string|null,typeFile:string)=>db.prepare("INSERT INTO definition_revisions(id,base_revision_id,type_version,type_file_json,display_names_json,created_at,created_by) VALUES(?,?,'v',?,'{}','2026-09-29','owner')").run(id,base,typeFile);
 revision('rev',null,types);revision('rev-2','rev',types);
 const entries=[],matches=[];
 for(let i=0;i<documents;i++){
  const entry={fingerprint:String(i).padStart(64,'0'),tag:'t-'+String(i).padStart(5,'0'),originalFilename:'doc-'+i+'.pdf',destinationFolder:'a',rule:'R1'};
  entries.push(entry);
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,decision_json,ordinal) VALUES('source',?,?,?,'complete','h',?,?)").run(entry.fingerprint,entry.tag,entry.originalFilename,JSON.stringify({destinationFolder:'a',ruleId:'R1'}),i+1);
  matches.push({entry,file:{folder:i===0?'a':'b',filename:entry.tag+'--'+entry.originalFilename,tag:entry.tag},matchedBy:'tag'});
 }
 const diff={confirmations:matches.slice(0,1),moves:matches.slice(1).map(m=>({...m,from:'a',to:'b',kind:'misfile'})),unchecked:[],deleted:[],unmatched:[],ignored:[],unknownFolders:[]};
 bucket.objects.set('analysis',JSON.stringify({diff,proposals:{ignoredFolders:[]},proposalContext:{}}));
 db.prepare("INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES('correction','source','owner','2026-09-29','raw','analysis','{}')").run();
 const run=()=>store.run('source');
 const labelRows=(id:string)=>db.prepare('SELECT fingerprint,ordinal,entry_json FROM feedback_labels WHERE reference_id=? ORDER BY ordinal').all(id) as {fingerprint:string;ordinal:number;entry_json:string}[];
 const referenceRow=(id:string)=>db.prepare('SELECT labels_json,carried_from FROM feedback_references WHERE id=?').get(id) as {labels_json:string;carried_from:string|null};
 return{db,store,run,entries,labelRows,referenceRow,revision};
}

test('saved labels are rows, written in one batch with the reference, read back in ordinal order, owner scoped',async()=>{
 const f=fixture(4_500);
 const input={definitionRevisionId:'rev',labels:[{fingerprint:f.entries[0].fingerprint,status:'ambiguous' as const,labels:['a','b']}]};
 const saved=await saveReference(f.store,await f.run(),'correction','owner',input);
 assert.equal(saved.entries.length,4_500);assert.equal(saved.carriedFrom,null);
 const rows=f.labelRows(saved.id);
 assert.equal(rows.length,4_500);
 assert.deepEqual(rows.map(row=>row.ordinal),Array.from({length:4_500},(_,i)=>i));
 assert.deepEqual(rows.map(row=>row.fingerprint),f.entries.map(entry=>entry.fingerprint));
 assert.deepEqual(rows.map(row=>JSON.parse(row.entry_json)),saved.entries);
 assert.equal(f.referenceRow(saved.id).labels_json,'[]');
 const read=await readReference(f.store,saved.id,'owner');
 assert.deepEqual(read,saved);
 assert.equal(read.entries[0].status,'ambiguous');assert.equal(read.entries[1].status,'label');assert.deepEqual(read.entries[1].labels,['b']);
 await assert.rejects(()=>readReference(f.store,saved.id,'other'));
 await assert.rejects(async()=>saveReference(f.store,await f.run(),'correction','other',input));
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n,1);
 const second=await saveReference(f.store,await f.run(),'correction','owner',input);
 assert.notEqual(second.id,saved.id);assert.equal(f.labelRows(second.id).length,4_500);
 // The rows are immutable, like the reference.
 assert.throws(()=>f.db.prepare('UPDATE feedback_labels SET entry_json=? WHERE reference_id=?').run('{}',saved.id),/immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM feedback_labels WHERE reference_id=?').run(saved.id),/immutable/);
});

test('the head reader returns lineage without labels and is owner scoped; a reference without label rows is a loud failure',async()=>{
 const f=fixture(3);
 const saved=await saveReference(f.store,await f.run(),'correction','owner',{definitionRevisionId:'rev',labels:[]});
 const head=await readReferenceHead(f.store.env,saved.id,'owner');
 assert.deepEqual(head,{id:saved.id,sourceRunId:'source',correctionId:'correction',definitionRevisionId:'rev',carriedFrom:null});
 assert.equal('entries' in head,false);
 await assert.rejects(()=>readReferenceHead(f.store.env,saved.id,'other'),/unavailable/);
 await assert.rejects(()=>readReferenceHead(f.store.env,'missing','owner'),/unavailable/);
 f.db.prepare("INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) VALUES('bare','source','correction','rev','2026-09-29','owner','[]')").run();
 await assert.rejects(()=>readReference(f.store,'bare','owner'),{code:'E_FEEDBACK_LABELS_MISSING'});
});

test('older references keep working through the migration backfill of their labels_json',async()=>{
 const f=fixture(2);
 const labels=[{fingerprint:f.entries[0].fingerprint,originalFilename:'doc-0.pdf',previousFolder:'a',previousRule:'R1',correctedFolder:'a',moved:false,status:'label',labels:['a']},{fingerprint:f.entries[1].fingerprint,originalFilename:'doc-1.pdf',previousFolder:'a',previousRule:'R1',correctedFolder:'b',moved:true,status:'label',labels:['b']}];
 f.db.prepare("INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) VALUES('old','source','correction','rev','2026-09-24','owner',?)").run(JSON.stringify(labels));
 // The 0018 backfill statement, as it ran for references that existed before the rows.
 f.db.prepare("INSERT OR IGNORE INTO feedback_labels(reference_id, fingerprint, ordinal, entry_json) SELECT r.id, json_extract(e.value, '$.fingerprint'), e.key, json(e.value) FROM feedback_references r, json_each(r.labels_json) e WHERE r.id='old'").run();
 assert.deepEqual((await readReference(f.store,'old','owner')).entries,labels);
});

test('carried labels are copied unchanged and every labelled category must exist in the target version',()=>{
 const base={originalFilename:'f.pdf',previousFolder:'human_review',previousRule:'R5',correctedFolder:'a',moved:true};
 const entries=[{...base,fingerprint:'1',status:'label' as const,labels:['a']},{...base,fingerprint:'2',status:'ambiguous' as const,labels:['a','b']},{...base,fingerprint:'3',status:'failure' as const,labels:[]},{...base,fingerprint:'4',status:'unconfirmed' as const,labels:[]}];
 const carried=carriedReferenceEntries(entries,['a','b','c']);
 assert.deepEqual(carried,entries);assert.notEqual(carried[1].labels,entries[1].labels);
 assert.throws(()=>carriedReferenceEntries(entries,['a']),/not in the active category version: b/);
});

test('carrying is owner-only, targets another active version, copies the rows and records its origin',async()=>{
 const f=fixture(2_500);
 const source=await saveReference(f.store,await f.run(),'correction','owner',{definitionRevisionId:'rev',labels:[]});
 const value=await carryReference(f.store,source.id,'owner','rev-2');
 assert.equal(value.carriedFrom,source.id);assert.equal(value.definitionRevisionId,'rev-2');assert.equal(value.sourceRunId,'source');
 assert.deepEqual(value.entries,source.entries);
 assert.deepEqual(f.labelRows(value.id),f.labelRows(source.id));
 assert.deepEqual({...f.referenceRow(value.id)},{labels_json:'[]',carried_from:source.id});
 assert.deepEqual(await readReference(f.store,value.id,'owner'),value);
 assert.equal((await readReference(f.store,source.id,'owner')).carriedFrom,null);
 await assert.rejects(()=>carryReference(f.store,source.id,'owner','rev'),/already use/);
 await assert.rejects(()=>carryReference(f.store,source.id,'owner',null),/Activate/);
 await assert.rejects(()=>carryReference(f.store,source.id,'other','rev-2'),/unavailable/);
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n,2);
 // A carry into a version missing a labelled category writes nothing.
 f.revision('rev-3','rev-2',JSON.stringify({types:[{id:'a'}]}));
 await assert.rejects(()=>carryReference(f.store,source.id,'owner','rev-3'),/not in the active category version: b/);
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n,2);
 void (undefined as unknown as RunRow);
});

// F3 (independent review, 7 October 2026): saved and carried labels share one allowance per person per UTC day.
const REFERENCE_REFUSAL={code:'E_DAILY_REFERENCE_LIMIT',status:429,message:'This site allows 30 saves of confirmed labels per person each UTC day. The allowance resets at 00:00 UTC.'};
test('usage limits: thirty saves of confirmed labels per person each UTC day, carried ones included; a refused save writes no row',async()=>{
 const f=fixture(2,{usageLimits:true}),input={definitionRevisionId:'rev',labels:[]};
 const references=()=>(f.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n;
 const labels=()=>(f.db.prepare('SELECT COUNT(*) AS n FROM feedback_labels').get() as {n:number}).n;
 const first=await saveReference(f.store,await f.run(),'correction','owner',input);
 for(let i=0;i<28;i++)await saveReference(f.store,await f.run(),'correction','owner',input);
 await carryReference(f.store,first.id,'owner','rev-2');
 assert.equal(references(),30);assert.equal(labels(),60);
 await assert.rejects(async()=>saveReference(f.store,await f.run(),'correction','owner',input),REFERENCE_REFUSAL);
 await assert.rejects(()=>carryReference(f.store,first.id,'owner','rev-2'),REFERENCE_REFUSAL);
 assert.equal(references(),30);assert.equal(labels(),60,'no label row is written without its reference');
 // The next UTC day has its own allowance.
 f.db.exec('DROP TRIGGER feedback_references_no_update');
 f.db.prepare('UPDATE feedback_references SET created_at=?').run(new Date(Date.now()-86_400_000).toISOString());
 assert.ok(await saveReference(f.store,await f.run(),'correction','owner',input));
});
test('usage limits: an editor, and a run frozen without usage limits, have no allowance on saved labels',async()=>{
 for(const options of [{usageLimits:true,editors:['owner']},{}]){
  const f=fixture(2,options),input={definitionRevisionId:'rev',labels:[]};
  for(let i=0;i<31;i++)await saveReference(f.store,await f.run(),'correction','owner',input);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n,31);
 }
});
// DECISIONS 150 (owner, 9 October 2026): a trusted user is exempt from the saved-label allowance without being an editor.
test('usage limits: a trusted user who is not an editor saves and carries past thirty label saves a day; the same person unlisted is refused',async()=>{
 const f=fixture(2,{usageLimits:true,editors:['site-owner'],trusted:['owner']}),input={definitionRevisionId:'rev',labels:[]};
 const first=await saveReference(f.store,await f.run(),'correction','owner',input);
 for(let i=0;i<30;i++)await saveReference(f.store,await f.run(),'correction','owner',input);
 await carryReference(f.store,first.id,'owner','rev-2');
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n,32);
 const visitor=fixture(2,{usageLimits:true,editors:['site-owner'],trusted:['someone-else']});
 for(let i=0;i<30;i++)await saveReference(visitor.store,await visitor.run(),'correction','owner',input);
 await assert.rejects(async()=>saveReference(visitor.store,await visitor.run(),'correction','owner',input),REFERENCE_REFUSAL);
 assert.equal((visitor.db.prepare('SELECT COUNT(*) AS n FROM feedback_references').get() as {n:number}).n,30);
});
