import { uiCopy } from './copy.ts';
export type SpendKey = 'blended'|'openai'|'typesafe';
export interface RunBudgetInput {mode:'limited'|'unlimited';limits:Record<SpendKey,string|null>;unlimitedAcknowledged:boolean}
/** Decimal USD only. No floating point conversion at the money boundary. */
export function usdToNanodollars(input:string):string|null {
 const value=input.trim();if(!value)return null;
 if(!/^\d{1,30}(?:\.\d{1,9})?$/.test(value))throw new Error(uiCopy.invalidBudget);
 const [whole,fraction='']=value.split('.');const nano=BigInt(whole)*1_000_000_000n+BigInt(fraction.padEnd(9,'0'));
 if(nano<=0n)throw new Error(uiCopy.invalidBudget);
 return nano.toString();
}
export function budgetFromInputs(mode:'limited'|'unlimited',inputs:Record<SpendKey,string>,acknowledged:boolean):RunBudgetInput {
 if(mode==='unlimited'){if(!acknowledged)throw new Error(uiCopy.unlimitedNeedsAcknowledgement);return {mode,limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true};}
 const limits={blended:usdToNanodollars(inputs.blended),openai:usdToNanodollars(inputs.openai),typesafe:usdToNanodollars(inputs.typesafe)};
 if(Object.values(limits).every(value=>value===null))throw new Error(uiCopy.budgetRequired);
 return {mode,limits,unlimitedAcknowledged:false};
}
export function formatNanodollars(value:string):string {
 const nano=BigInt(value);const fraction=(nano%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'').padEnd(2,'0');
 return '$'+(nano/1_000_000_000n).toString()+'.'+fraction;
}
