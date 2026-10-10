import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetFromInputs, usdToNanodollars, formatNanodollars } from './run-budget.ts';
test('USD entry converts exactly without floating point or exponent syntax',()=>{
 assert.equal(usdToNanodollars('5.01'),'5010000000');assert.equal(usdToNanodollars('123456789012345678901.123456789'),'123456789012345678901123456789');assert.equal(usdToNanodollars('0.000000001'),'1');assert.equal(usdToNanodollars('  '),null);
 for(const value of ['0','-1','1e3','Infinity','0.0000000001','1,000','$5','2.'])assert.throws(()=>usdToNanodollars(value));
 assert.equal(formatNanodollars('123456789012345678901'),'$123456789012.345678901');
});
test('empty limited budgets never imply unlimited and independent limits survive',()=>{
 assert.throws(()=>budgetFromInputs('limited',{blended:'',openai:'',typesafe:''},false));
 assert.deepEqual(budgetFromInputs('limited',{blended:'',openai:'5',typesafe:'5'},false),{mode:'limited',limits:{blended:null,openai:'5000000000',typesafe:'5000000000'},unlimitedAcknowledged:false});
});
test('unlimited requires explicit acknowledgement and clears retained input limits',()=>{
 assert.throws(()=>budgetFromInputs('unlimited',{blended:'',openai:'',typesafe:''},false));
 assert.deepEqual(budgetFromInputs('unlimited',{blended:'5',openai:'5',typesafe:'5'},true),{mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true});
});
