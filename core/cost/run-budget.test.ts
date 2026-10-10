import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRunBudget, readRunBudget, checkRunBudget, sumVendorSpend, vendorSpendDelta } from './run-budget.ts';
const limits={blended:null,openai:null,typesafe:null};
const record=(over={})=>authorizeRunBudget({mode:'limited',limits:{...limits,blended:'100'},unlimitedAcknowledged:false,...over},'person','2026-09-22T00:00:00Z');
test('monitored limits stop at equality and respect each vendor independently',()=>{
 const budget=record({limits:{blended:'200',openai:'100',typesafe:'150'}});
 assert.deepEqual(checkRunBudget(budget,{blended:'99',openai:'99',typesafe:'0'}),{halt:false,reached:[]});
 assert.deepEqual(checkRunBudget(budget,{blended:'100',openai:'100',typesafe:'0'}),{halt:true,reached:['openai']});
 assert.deepEqual(checkRunBudget(budget,{blended:'250',openai:'100',typesafe:'150'}),{halt:true,reached:['blended','openai','typesafe']});
});
test('budget requests require explicit valid limits and unlimited acknowledgement',()=>{
 for(const input of [{},{mode:'limited',limits,unlimitedAcknowledged:false},{mode:'unlimited',limits,unlimitedAcknowledged:false},{mode:'unlimited',limits:{...limits,openai:'1'},unlimitedAcknowledged:true},{mode:'limited',limits:{...limits,blended:'0'},unlimitedAcknowledged:false},{mode:'limited',limits:{...limits,blended:1},unlimitedAcknowledged:false},{mode:'limited',limits:{...limits,blended:'01'},unlimitedAcknowledged:false},{mode:'limited',limits:{...limits,blended:'1'},unlimitedAcknowledged:true}])assert.throws(()=>authorizeRunBudget(input,'person','2026-09-22'));
 const budget=record({mode:'unlimited',limits,unlimitedAcknowledged:true});assert.equal(budget.version,1);assert.equal(budget.actor,'person');assert.equal(checkRunBudget(budget,{blended:'999999',openai:'999999',typesafe:'0'}).halt,false);
 assert.throws(()=>authorizeRunBudget({mode:'unlimited',limits,unlimitedAcknowledged:true},'','2026-09-22'));
});
test('spending uses exact integer arithmetic and includes recovery in OpenAI',()=>{
 assert.deepEqual(sumVendorSpend([{role:'confidence',cost_nano:'9007199254740993'},{role:'reader',cost_nano:'3'},{role:'recovery',cost_nano:'4'}]),{blended:'9007199254741000',openai:'7',typesafe:'9007199254740993'});
 assert.throws(()=>sumVendorSpend([{role:'unknown',cost_nano:'1'}]));assert.throws(()=>sumVendorSpend([{role:'reader',cost_nano:'-1'}]));
});
test('only the three inference roles carry a recorded cost; an unknown cost counts as unknown whatever the role',()=>{
 for(const role of ['unknown','batch_metadata'])for(const cost of ['0','1'])assert.throws(()=>vendorSpendDelta(role,cost),/unknown vendor role/,role+' '+cost);
 for(const role of ['confidence','reader','recovery','batch_metadata'])assert.deepEqual(vendorSpendDelta(role,null),{openai:0n,typesafe:0n,unknown:1},role);
});
test('legacy persisted budgets retain their audit and never silently become unlimited',()=>{
 const legacy={status:'allowed',ceilingNanodollars:'50',projectLimitNanodollars:'100',limitNanodollars:'100',override:false,actor:'person',timestamp:'2026-09-22'};
 assert.equal(readRunBudget(legacy).version,0);assert.equal(checkRunBudget(readRunBudget(legacy),{blended:'100',openai:'100',typesafe:'0'}).halt,true);
 assert.equal(readRunBudget({...legacy,override:true,limitNanodollars:null}).mode,'unlimited');
 assert.throws(()=>readRunBudget({...legacy,limitNanodollars:null}));assert.throws(()=>readRunBudget({...legacy,status:'refused'}));assert.throws(()=>readRunBudget({}));
});
