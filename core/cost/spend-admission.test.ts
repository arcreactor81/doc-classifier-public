import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeRunBudget} from './run-budget.ts';
import {anthropicOverloaded,checkSpendAdmission,confidenceTooLargeRefusal,emptyBody,isolatesUnknownSpend,notProcessedAttempt,recognisesEdgeRefusal,recognisesNestedTooLarge,unknownSpendPolicy} from './spend-admission.ts';
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
 assert.throws(()=>isolatesUnknownSpend('not-processed-zero-v7'));
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
 assert.throws(()=>notProcessedAttempt('not-processed-zero-v7',429,true));
});

// DECISIONS 152, evening addendum (owner, 9 October 2026): not-processed-zero-v3 is v2 plus one recorded refusal.
const TOO_LARGE=JSON.stringify({error_type:'max_tokens_exceeded',message:'The request exceeds the model input limit.'});
test('not-processed-zero-v3 is accepted and admits unknown charges exactly as v2 does',()=>{
 assert.equal(unknownSpendPolicy('not-processed-zero-v3'),'not-processed-zero-v3');
 assert.equal(isolatesUnknownSpend('not-processed-zero-v3'),true);
 assert.deepEqual(checkSpendAdmission('not-processed-zero-v3',unlimited,known,1),{halt:false,reason:null,reached:[],unknownCalls:1});
 assert.equal(checkSpendAdmission('not-processed-zero-v3',limited,known,1).reason,'unknown_spend');
 assert.equal(checkSpendAdmission('not-processed-zero-v3',limited,{blended:'100',openai:'90',typesafe:'10'},0).reason,'limit_reached');
 assert.throws(()=>unknownSpendPolicy('not-processed-zero-v7'));
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
 assert.throws(()=>notProcessedAttempt('not-processed-zero-v7',400,false,true));
});

// DECISIONS 156, addendum of 11 October 2026 (owner, "Treat as not charged, wait and retry"): not-processed-zero-v4 is
// v3 plus Anthropic's HTTP 529 `overloaded_error`, recorded at zero and retried as an ordinary transient answer.
const OVERLOADED=JSON.stringify({type:'error',error:{type:'overloaded_error',message:'Overloaded'},request_id:'req_synthetic'});
test('not-processed-zero-v4 is accepted and admits unknown charges exactly as v3 does',()=>{
 assert.equal(unknownSpendPolicy('not-processed-zero-v4'),'not-processed-zero-v4');
 assert.equal(isolatesUnknownSpend('not-processed-zero-v4'),true);
 assert.deepEqual(checkSpendAdmission('not-processed-zero-v4',unlimited,known,1),{halt:false,reason:null,reached:[],unknownCalls:1});
 assert.equal(checkSpendAdmission('not-processed-zero-v4',limited,known,1).reason,'unknown_spend');
 assert.equal(checkSpendAdmission('not-processed-zero-v4',limited,{blended:'100',openai:'90',typesafe:'10'},0).reason,'limit_reached');
});
test("Anthropic's overload answer: a 529 from Anthropic whose body is a JSON object with error.type exactly overloaded_error and no usage",()=>{
 assert.equal(anthropicOverloaded('anthropic',529,OVERLOADED),true);
 assert.equal(anthropicOverloaded('anthropic',529,JSON.stringify({error:{type:'overloaded_error'}})),true,'the message and envelope type are not required');
 for(const [label,raw] of [
  ['another error type',JSON.stringify({type:'error',error:{type:'api_error',message:'Overloaded'}})],
  ['the type in capitals',JSON.stringify({type:'error',error:{type:'OVERLOADED_ERROR'}})],
  ['the type at the top level',JSON.stringify({type:'overloaded_error'})],
  ['usage reported',JSON.stringify({type:'error',error:{type:'overloaded_error'},usage:{input_tokens:1,output_tokens:0}})],
  ['a null usage field',JSON.stringify({type:'error',error:{type:'overloaded_error'},usage:null})],
  // The AI Gateway's own envelope (core/vendors/gateway.ts gatewayEnvelope) is never Anthropic's overload answer.
  ['the gateway envelope',JSON.stringify({success:false,result:[],messages:[],error:[{code:2005,message:'overloaded_error'}]})],
  ['the gateway envelope with errors',JSON.stringify({success:false,errors:[{code:2005,message:'overloaded_error',type:'overloaded_error'}]})],
  ['an error array',JSON.stringify({error:[{type:'overloaded_error'}]})],
  ['a malformed body','{"type":"error","error":{"type":"overloaded_error"}'],
  ['a text body','overloaded_error'],
  ['an empty body',''],
  ['no body',null]
 ] as const)assert.equal(anthropicOverloaded('anthropic',529,raw),false,label);
 for(const status of [200,400,429,500,502,503,520,null])assert.equal(anthropicOverloaded('anthropic',status,OVERLOADED),false,String(status));
 for(const vendor of ['openai','deepseek','cloudflare','typesafe'])assert.equal(anthropicOverloaded(vendor,529,OVERLOADED),false,vendor);
});
test('the v4 boundary is everything v3 records at zero plus that answer; v3, v2 and the v1 policies never record it at zero',()=>{
 const v4='not-processed-zero-v4';
 for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v4,429,bodyEmpty),true,'429 with body empty='+bodyEmpty);
 for(const status of [500,502,503,520,529,599]){assert.equal(notProcessedAttempt(v4,status,true),true,String(status));assert.equal(notProcessedAttempt(v4,status,false),false,status+' with a body');}
 for(const status of [200,204,300,400,401,403,404,408,409,413,422,499,600])for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v4,status,bodyEmpty),false,status+' empty='+bodyEmpty);
 assert.equal(notProcessedAttempt(v4,null,true),false,'a network failure has no status');
 assert.equal(notProcessedAttempt(v4,400,false,true),true,"v3's refusal is kept");
 assert.equal(notProcessedAttempt(v4,529,false,false,true),true,'the overload answer');
 // Only with status 529: the flag never widens another status, a 500 with a body above all (429 is zero by status alone).
 for(const status of [400,429,500,503,null])assert.equal(notProcessedAttempt(v4,status,false,false,true),status===429,String(status));
 for(const policy of [undefined,'halt-on-unknown-v1','isolate-unlimited-v1','not-processed-zero-v2','not-processed-zero-v3'])
  assert.equal(notProcessedAttempt(policy,529,false,false,true),false,String(policy));
 assert.throws(()=>notProcessedAttempt('not-processed-zero-v7',529,false,false,true));
});
// DECISIONS 156, addendum of 11 October 2026 (owner, "Fail that document only"): not-processed-zero-v5 is v4 plus an edge
// refusal (core/vendors/gateway.ts `edgeRefusal`: a gateway-routed 4xx in neither the vendor's own error format nor with a
// vendor request id), recorded at zero because the vendor never processed it.
test('not-processed-zero-v5 is accepted, admits unknown charges exactly as v4 does, and is the first version that recognises an edge refusal',()=>{
 assert.equal(unknownSpendPolicy('not-processed-zero-v5'),'not-processed-zero-v5');
 assert.equal(isolatesUnknownSpend('not-processed-zero-v5'),true);
 assert.deepEqual(checkSpendAdmission('not-processed-zero-v5',unlimited,known,1),{halt:false,reason:null,reached:[],unknownCalls:1});
 assert.equal(checkSpendAdmission('not-processed-zero-v5',limited,known,1).reason,'unknown_spend');
 assert.equal(recognisesEdgeRefusal('not-processed-zero-v5'),true);
 for(const policy of [undefined,'halt-on-unknown-v1','isolate-unlimited-v1','not-processed-zero-v2','not-processed-zero-v3','not-processed-zero-v4'])
  assert.equal(recognisesEdgeRefusal(policy),false,String(policy));
 assert.throws(()=>recognisesEdgeRefusal('not-processed-zero-v7'));
});
test('the v5 boundary is everything v4 records at zero plus an edge refusal; v4 and every earlier version never record it at zero',()=>{
 const v5='not-processed-zero-v5';
 for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v5,429,bodyEmpty),true,'429 with body empty='+bodyEmpty);
 for(const status of [500,502,503,520,529,599]){assert.equal(notProcessedAttempt(v5,status,true),true,String(status));assert.equal(notProcessedAttempt(v5,status,false),false,status+' with a body');}
 for(const status of [200,204,300,400,401,403,404,408,409,413,422,499,600])for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v5,status,bodyEmpty),false,status+' empty='+bodyEmpty);
 assert.equal(notProcessedAttempt(v5,400,false,true),true,"v3's refusal is kept");
 assert.equal(notProcessedAttempt(v5,529,false,false,true),true,"v4's overload answer is kept");
 for(const status of [400,403,413,418,422])assert.equal(notProcessedAttempt(v5,status,false,false,false,true),true,'an edge refusal with status '+status);
 // The flag never widens a status outside 4xx; 429 is zero by status alone.
 for(const status of [200,302,500,503,529,null])assert.equal(notProcessedAttempt(v5,status,false,false,false,true),false,String(status));
 for(const policy of [undefined,'halt-on-unknown-v1','isolate-unlimited-v1','not-processed-zero-v2','not-processed-zero-v3','not-processed-zero-v4'])
  assert.equal(notProcessedAttempt(policy,403,false,false,false,true),false,String(policy));
});
// DECISIONS 152, evening addendum (owner, 9 October 2026), applied to the shape TypeSafe returned on 12 October 2026:
// not-processed-zero-v6 is v5 plus TypeSafe's too-large refusal with `error_type` nested under `detail`. v3 to v5 keep
// their reading of that shape (an unknown charge), so a run frozen on them behaves exactly as before.
const NESTED_TOO_LARGE=JSON.stringify({detail:{error_type:'max_tokens_exceeded'}});
test('not-processed-zero-v6 is accepted, admits unknown charges exactly as v5 does, keeps the edge refusal, and is the only version that recognises the nested refusal',()=>{
 const v6='not-processed-zero-v6';
 assert.equal(unknownSpendPolicy(v6),v6);
 assert.equal(isolatesUnknownSpend(v6),true);
 assert.deepEqual(checkSpendAdmission(v6,unlimited,known,1),{halt:false,reason:null,reached:[],unknownCalls:1});
 assert.equal(checkSpendAdmission(v6,limited,known,1).reason,'unknown_spend');
 assert.equal(checkSpendAdmission(v6,limited,{blended:'100',openai:'90',typesafe:'10'},0).reason,'limit_reached');
 assert.equal(recognisesEdgeRefusal(v6),true);
 assert.equal(recognisesNestedTooLarge(v6),true);
 for(const policy of [undefined,'halt-on-unknown-v1','isolate-unlimited-v1','not-processed-zero-v2','not-processed-zero-v3','not-processed-zero-v4','not-processed-zero-v5'])
  assert.equal(recognisesNestedTooLarge(policy),false,String(policy));
 assert.throws(()=>recognisesNestedTooLarge('not-processed-zero-v7'));
});
test("the nested refusal: a 400 from the confidence check whose body's detail is an object with error_type exactly max_tokens_exceeded and no usage, recognised only when asked",()=>{
 assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,NESTED_TOO_LARGE,true),true);
 assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,JSON.stringify({detail:{error_type:'max_tokens_exceeded',message:'Too long.'}}),true),true,'a message is allowed');
 // Without the nested reading (v3 to v5) the shape is not the refusal; the recorded top-level shape is the refusal either way.
 assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,NESTED_TOO_LARGE),false);
 assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,NESTED_TOO_LARGE,false),false);
 for(const nested of [false,true])assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,TOO_LARGE,nested),true,'top level, nested='+nested);
 for(const [label,raw] of [
  ['another error type',JSON.stringify({detail:{error_type:'invalid_request'}})],
  ['the type in capitals',JSON.stringify({detail:{error_type:'MAX_TOKENS_EXCEEDED'}})],
  ['detail as text',JSON.stringify({detail:'max_tokens_exceeded'})],
  ['detail as a list',JSON.stringify({detail:[{error_type:'max_tokens_exceeded'}]})],
  ['a null detail',JSON.stringify({detail:null})],
  ['the type under error',JSON.stringify({error:{error_type:'max_tokens_exceeded'}})],
  ['the type under detail.error',JSON.stringify({detail:{error:{error_type:'max_tokens_exceeded'}}})],
  ['usage at the top level',JSON.stringify({detail:{error_type:'max_tokens_exceeded'},usage:{input_tokens:70000,output_tokens:0}})],
  ['a null usage at the top level',JSON.stringify({detail:{error_type:'max_tokens_exceeded'},usage:null})],
  ['usage inside detail',JSON.stringify({detail:{error_type:'max_tokens_exceeded',usage:{input_tokens:70000}}})],
  ['a null usage inside detail',JSON.stringify({detail:{error_type:'max_tokens_exceeded',usage:null}})],
  ['a malformed body','{"detail":{"error_type":"max_tokens_exceeded"}'],
  ['an array body',JSON.stringify([{detail:{error_type:'max_tokens_exceeded'}}])],
  ['an empty body',''],
  ['no body',null]
 ] as const)assert.equal(confidenceTooLargeRefusal('typesafe','confidence',400,raw,true),false,label);
 for(const status of [200,401,413,422,429,500,null])assert.equal(confidenceTooLargeRefusal('typesafe','confidence',status,NESTED_TOO_LARGE,true),false,String(status));
 for(const [vendor,role] of [['openai','reader'],['deepseek','reader'],['anthropic','reader'],['cloudflare','reader'],['typesafe','reader'],['openai','confidence']] as const)
  assert.equal(confidenceTooLargeRefusal(vendor,role,400,NESTED_TOO_LARGE,true),false,vendor+' '+role);
});
test('the v6 boundary is everything v5 records at zero; the caller passes the nested refusal as the too-large flag only under v6',()=>{
 const v6='not-processed-zero-v6';
 for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v6,429,bodyEmpty),true,'429 with body empty='+bodyEmpty);
 for(const status of [500,502,503,520,529,599]){assert.equal(notProcessedAttempt(v6,status,true),true,String(status));assert.equal(notProcessedAttempt(v6,status,false),false,status+' with a body');}
 for(const status of [200,204,300,400,401,403,404,408,409,413,422,499,600])for(const bodyEmpty of [true,false])assert.equal(notProcessedAttempt(v6,status,bodyEmpty),false,status+' empty='+bodyEmpty);
 assert.equal(notProcessedAttempt(v6,null,true),false,'a network failure has no status');
 assert.equal(notProcessedAttempt(v6,400,false,true),true,'the refusal, either shape');
 assert.equal(notProcessedAttempt(v6,529,false,false,true),true,"v4's overload answer is kept");
 for(const status of [400,403,413,418,422])assert.equal(notProcessedAttempt(v6,status,false,false,false,true),true,"v5's edge refusal with status "+status);
 for(const status of [200,302,500,503,529,null])assert.equal(notProcessedAttempt(v6,status,false,false,false,true),false,String(status));
 // Under v3 to v5 the nested body never sets the flag (recognisesNestedTooLarge is false), so it stays an unknown charge.
 for(const policy of ['not-processed-zero-v3','not-processed-zero-v4','not-processed-zero-v5']){
  const tooLarge=confidenceTooLargeRefusal('typesafe','confidence',400,NESTED_TOO_LARGE,recognisesNestedTooLarge(policy));
  assert.equal(notProcessedAttempt(policy,400,false,tooLarge),false,policy);
 }
 assert.equal(notProcessedAttempt(v6,400,false,confidenceTooLargeRefusal('typesafe','confidence',400,NESTED_TOO_LARGE,recognisesNestedTooLarge(v6))),true);
});
