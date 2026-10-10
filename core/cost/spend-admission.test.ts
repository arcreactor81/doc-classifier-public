import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeRunBudget} from './run-budget.ts';
import {checkSpendAdmission,confidenceTooLargeRefusal,emptyBody,isolatesUnknownSpend,notProcessedAttempt,unknownSpendPolicy} from './spend-admission.ts';
const known={blended:'20',openai:'10',typesafe:'10'};
const unlimited=authorizeRunBudget({mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true},'owner','2026-09-24');
const limited=authorizeRunBudget({mode:'limited',limits:{blended:'100',openai:null,typesafe:null},unlimitedAcknowledged:false},'owner','2026-09-24');
test('only the explicitly frozen isolation policy admits unlimited runs with unresolved charges',()=>{
 assert.equal(unknownSpendPolicy(undefined),'halt-on-unknown-v1');
 for(const policy of [undefined,'halt-on-unknown-v1'] as const)assert.equal(checkSpendAdmission(policy,unlimited,known,1).reason,'unknown_spend');
 assert.deepEqual(checkSpendAdmission('isolate-unlimited-v1',unlimited,known,2),{halt:false,reason:null,reached:[],unknownCalls:2});
});
test('every limited run pauses new inference on unknown charges even below its limit',()=>{
 for(const dimension of ['blended','openai','typesafe'] as const){
  const budget={...limited,limits:{blended:null,openai:null,typesafe:null,[dimension]:'100'}};
  assert.equal(checkSpendAdmission('isolate-unlimited-v1',budget,known,1).reason,'unknown_spend');
 }
});
test('known subtotals still stop at the limit and retained unknown counts are never treated as zero',()=>{
 assert.deepEqual(checkSpendAdmission('isolate-unlimited-v1',limited,{blended:'100',openai:'90',typesafe:'10'},0),{halt:true,reason:'limit_reached',reached:['blended'],unknownCalls:0});
 assert.deepEqual(checkSpendAdmission('isolate-unlimited-v1',limited,known,0),{halt:false,reason:null,reached:[],unknownCalls:0});
});
test('invalid accounting inputs or policy never silently authorize inference',()=>{
 assert.throws(()=>unknownSpendPolicy('unknown'));
 for(const count of [-1,0.5,NaN,Infinity])assert.throws(()=>checkSpendAdmission('isolate-unlimited-v1',unlimited,known,count));
 assert.throws(()=>checkSpendAdmission('isolate-unlimited-v1',unlimited,{...known,blended:'0'},1));
});

// DECISIONS 90: not-processed-zero-v2 admits unknown charges exactly as isolate-unlimited-v1 does ...
test('not-processed-zero-v2 is accepted and admits unknown charges under the isolate-unlimited rules',()=>{
 assert.equal(unknownSpendPolicy('not-processed-zero-v2'),'not-processed-zero-v2');
 assert.deepEqual([undefined,'halt-on-unknown-v1','isolate-unlimited-v1','not-processed-zero-v2'].map(isolatesUnknownSpend),[false,false,true,true]);
 assert.throws(()=>isolatesUnknownSpend('not-processed-zero-v4'));
 assert.deepEqual(checkSpendAdmission('not-processed-zero-v2',unlimited,known,1),{halt:false,reason:null,reached:[],unknownCalls:1});
 assert.equal(checkSpendAdmission('not-processed-zero-v2',limited,known,1).reason,'unknown_spend');
 assert.deepEqual(checkSpendAdmission('not-processed-zero-v2',limited,{blended:'100',openai:'90',typesafe:'10'},0).reason,'limit_reached');
});
// ... and its only addition is the boundary below: 429 by status; 5xx only with an empty body; nothing else, and nothing under v1.
test('the not-processed boundary: 429 by status, 5xx only with an empty body, false everywhere else and under every v1 policy',()=>{
 const v2='not-processed-zero-v2';
 for(const raw of [null,'',' ','\n\t  '])assert.equal(emptyBody(raw),true,JSON.stringify(raw));
 for(const raw of ['{}','error code: 520','<html></html>',' x '])assert.equal(emptyBody(raw),false,JSON.stringify(raw));
 for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v2,429,bodyEmpty),true,'429 with body empty='+bodyEmpty);
 for(const status of [500,502,503,520,599]){assert.equal(notProcessedAttempt(v2,status,true),true,String(status));assert.equal(notProcessedAttempt(v2,status,false),false,status+' with a body');}
 for(const status of [200,204,299,300,302,400,401,403,404,408,409,422,428,430,499,600])for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v2,status,bodyEmpty),false,status+' empty='+bodyEmpty);
 assert.equal(notProcessedAttempt(v2,null,true),false,'a network failure has no status');
 for(const policy of [undefined,'halt-on-unknown-v1','isolate-unlimited-v1'])for(const [status,bodyEmpty] of [[429,false],[429,true],[503,true]] as const)assert.equal(notProcessedAttempt(policy,status,bodyEmpty),false,String(policy));
 assert.throws(()=>notProcessedAttempt('not-processed-zero-v4',429,true));
});

// DECISIONS 152, evening addendum (owner, 9 October 2026): not-processed-zero-v3 is v2 plus one recorded refusal.
const TOO_LARGE=JSON.stringify({error_type:'max_tokens_exceeded',message:'The request exceeds the model input limit.'});
test('not-processed-zero-v3 is accepted and admits unknown charges exactly as v2 does',()=>{
 assert.equal(unknownSpendPolicy('not-processed-zero-v3'),'not-processed-zero-v3');
 assert.equal(isolatesUnknownSpend('not-processed-zero-v3'),true);
 assert.deepEqual(checkSpendAdmission('not-processed-zero-v3',unlimited,known,1),{halt:false,reason:null,reached:[],unknownCalls:1});
 assert.equal(checkSpendAdmission('not-processed-zero-v3',limited,known,1).reason,'unknown_spend');
 assert.equal(checkSpendAdmission('not-processed-zero-v3',limited,{blended:'100',openai:'90',typesafe:'10'},0).reason,'limit_reached');
 assert.throws(()=>unknownSpendPolicy('not-processed-zero-v4'));
});
test("TypeSafe's too-large refusal: a 400 from the confidence check whose body is a JSON object with error_type exactly max_tokens_exceeded and no usage",()=>{
 assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,TOO_LARGE),true);
 assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,JSON.stringify({error_type:'max_tokens_exceeded'})),true,'the message is not required');
 for(const [label,raw] of [
  ['another error type',JSON.stringify({error_type:'invalid_request',message:'The request exceeds the model input limit.'})],
  ['the type in capitals',JSON.stringify({error_type:'MAX_TOKENS_EXCEEDED'})],
  ['the type with a space',JSON.stringify({error_type:' max_tokens_exceeded'})],
  ['the type under error',JSON.stringify({error:{type:'max_tokens_exceeded',code:'max_tokens_exceeded'}})],
  ['usage reported',JSON.stringify({error_type:'max_tokens_exceeded',usage:{input_tokens:70000,output_tokens:0}})],
  ['a null usage field',JSON.stringify({error_type:'max_tokens_exceeded',usage:null})],
  ['a malformed body','{"error_type":"max_tokens_exceeded"'],
  ['a text body','max_tokens_exceeded'],
  ['an array body',JSON.stringify([{error_type:'max_tokens_exceeded'}])],
  ['a JSON string',JSON.stringify('max_tokens_exceeded')],
  ['an empty body',''],
  ['no body',null]
 ] as const)assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,raw),false,label);
 for(const status of [200,401,413,422,429,500,null])assert.equal(confidenceTooLargeRefusal('typesafe','confidence',status,TOO_LARGE),false,String(status));
 for(const [vendor,role] of [['openai','reader'],['openai','recovery'],['deepseek','reader'],['cloudflare','reader'],['typesafe','reader'],['openai','confidence']] as const)
  assert.equal(confidenceTooLargeRefusal(vendor,role,400,TOO_LARGE),false,vendor+' '+role);
});
test('the v3 boundary is everything v2 records at zero plus that refusal; v2 and the v1 policies never record the refusal at zero',()=>{
 const v3='not-processed-zero-v3';
 for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v3,429,bodyEmpty),true,'429 with body empty='+bodyEmpty);
 for(const status of [500,502,503,520,599]){assert.equal(notProcessedAttempt(v3,status,true),true,String(status));assert.equal(notProcessedAttempt(v3,status,false),false,status+' with a body');}
 for(const status of [200,204,300,400,401,403,404,408,409,413,422,499,600])for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v3,status,bodyEmpty),false,status+' empty='+bodyEmpty);
 assert.equal(notProcessedAttempt(v3,null,true),false,'a network failure has no status');
 assert.equal(notProcessedAttempt(v3,400,false,true),true,'the refusal');
 assert.equal(notProcessedAttempt(v3,null,false,true),false,'never without a status');
 for(const policy of [undefined,'halt-on-unknown-v1','isolate-unlimited-v1','not-processed-zero-v2'])assert.equal(notProcessedAttempt(policy,400,false,true),false,String(policy));
 assert.throws(()=>notProcessedAttempt('not-processed-zero-v4',400,false,true));
});
