import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReaderRequest,buildRecoveryRequest,decodeReader,verifyModelPolicy,type ReaderEvaluationPolicy} from './requests.ts';
const policy:ReaderEvaluationPolicy={purpose:'owner_authorized_evaluation',role:'reader',authorization:'test-only explicit owner experiment',models:['gpt-5.6-terra','gpt-6-sol']};
const types={types:[{id:'type_a',name:'Type A',what:'Definition',not_for:'Exclusion',examples:['Example']}],none_of_these:{name:'None',what:'No match'}};
const pin=(id:string)=>({id,policy:'owner_approved_alias' as const,date:'2026-09-23',reason:'Explicit evaluation only'});
const raw=(model:string,evidence='A\nB')=>({model,status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({verdicts:[{type_id:'type_a',is_type:true,rationale:'Reason',evidence:[evidence],closest_alternative:null}]})}]}]});
test('approved Sol and Luna6 production requests match their frozen evaluation roles',()=>{
 const input={pin:pin('gpt-6-sol'),typeFile:types,text:'A\nB',effort:'low',maxOutputTokens:16384};
 assert.equal(buildReaderRequest(input).body,buildReaderRequest(input,policy).body);
 verifyModelPolicy(pin('gpt-6-sol'),'gpt-6-sol','reader');
 assert.throws(()=>buildReaderRequest({...input,pin:pin('gpt-6-luna')}),/policy/);
 const recovery={pin:pin('gpt-6-luna'),text:'A\nB',effort:'low',maxOutputTokens:8192};
 assert.equal(buildRecoveryRequest(recovery).body,buildRecoveryRequest(recovery,{purpose:'owner_authorized_evaluation',role:'recovery',authorization:'recorded comparison',models:['gpt-6-luna']}).body);
});
test('explicit reader evaluation preserves all request fields except the model',()=>{
 const bodies=policy.models.map(id=>JSON.parse(buildReaderRequest({pin:pin(id),typeFile:types,text:'A\nB',effort:'low',maxOutputTokens:16384},policy).body));
 for(const body of bodies){delete body.model;assert.deepEqual(body,bodies[0]);assert.equal(body.max_output_tokens,16384);assert.equal(body.input[1].content,'A\nB');}
 assert.throws(()=>buildReaderRequest({pin:pin('gpt-6-astra'),typeFile:types,text:'A',effort:'low',maxOutputTokens:1},policy),/policy/);
});
test('evaluation decoder keeps returned identity and exact evidence validation',()=>{
 assert.equal(decodeReader(raw('gpt-6-sol-2026-09-22'),pin('gpt-6-sol'),['type_a'],'A\nB',policy).model,'gpt-6-sol-2026-09-22');
 assert.throws(()=>decodeReader(raw('gpt-6-luna'),pin('gpt-6-sol'),['type_a'],'A\nB',policy),/model/i);
 assert.throws(()=>decodeReader(raw('gpt-6-sol','A B'),pin('gpt-6-sol'),['type_a'],'A\nB',policy),/verbatim/);
 assert.throws(()=>decodeReader({...raw('gpt-6-sol'),status:'incomplete'},pin('gpt-6-sol'),['type_a'],'A\nB',policy),/complete/);
});

test('evaluation model authorization is strictly role scoped',()=>{
 const recovery={...policy,role:'recovery' as const,models:['gpt-5.6-luna','gpt-6-luna']};
 assert.throws(()=>buildReaderRequest({pin:pin('gpt-6-luna'),typeFile:types,text:'A',effort:'low',maxOutputTokens:16384},{...policy,models:['gpt-6-luna']}),/policy/);
 assert.throws(()=>buildRecoveryRequest({pin:pin('gpt-6-sol'),text:'A',effort:'low',maxOutputTokens:8192},{...recovery,models:['gpt-6-sol']}),/policy/);
 assert.equal(buildRecoveryRequest({pin:pin('gpt-6-luna'),text:'A',effort:'low',maxOutputTokens:8192},recovery).model,'gpt-6-luna');
});
