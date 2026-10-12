/** Run limits monitor reported usage; they are not prepaid caps or cost predictions. */
export type SpendDimension = 'blended' | 'openai' | 'typesafe';
export type Spend = Record<SpendDimension,string>;
export type RunLimits = Record<SpendDimension,string|null>;
export interface RunBudgetRequest {mode:'limited'|'unlimited';limits:RunLimits;unlimitedAcknowledged:boolean}
export interface RunBudget extends RunBudgetRequest {version:0|1;actor:string;timestamp:string}
export class RunBudgetFailure extends Error {readonly code='E_RUN_BUDGET';readonly kind='request';constructor(message:string){super(message);this.name='RunBudgetFailure';}}
const dimensions:SpendDimension[]=['blended','openai','typesafe'];
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(message:string):never{throw new RunBudgetFailure(message);}
function exact(value:Record<string,unknown>,keys:string[]):void{if(Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)))fail('Missing or unexpected spending-limit fields.');}
function money(value:unknown):bigint{if(typeof value!=='string'||! /^(0|[1-9][0-9]*)$/.test(value)||value.length>100)fail('Spending amounts must be nonnegative integer nanodollar strings.');return BigInt(value as string);}
export function authorizeRunBudget(value:unknown,actor:string,timestamp:string):RunBudget{
 if(!object(value))fail('Choose spending limits or explicitly acknowledge no limit.');exact(value,['mode','limits','unlimitedAcknowledged']);
 if(!object(value.limits))fail('All three spending-limit fields are required.');exact(value.limits,dimensions);
 const limits={} as RunLimits;for(const key of dimensions){const amount=value.limits[key];if(amount!==null&&money(amount)<=0n)fail('A spending limit must be greater than zero.');limits[key]=amount as string|null;}
 if(value.mode!=='limited'&&value.mode!=='unlimited')fail('Select limited or unlimited spending.');
 if(value.mode==='limited'&&(!dimensions.some(key=>limits[key]!==null)||value.unlimitedAcknowledged!==false))fail('Limited spending needs at least one limit and no unlimited acknowledgement.');
 if(value.mode==='unlimited'&&(dimensions.some(key=>limits[key]!==null)||value.unlimitedAcknowledged!==true))fail('Unlimited spending requires no limits and explicit acknowledgement.');
 if(typeof actor!=='string'||!actor.trim()||!timestamp||!Number.isFinite(Date.parse(timestamp)))fail('The spending decision needs a person and timestamp.');
 return{version:1,mode:value.mode,limits,unlimitedAcknowledged:value.unlimitedAcknowledged as boolean,actor,timestamp};
}
/** Explicit legacy conversion preserves the original override and signer; malformed rows fail closed. */
export function readRunBudget(value:unknown):RunBudget{
 if(!object(value))fail('The persisted spending decision is invalid.');
 if(value.version===1||value.version===0){exact(value,['version','mode','limits','unlimitedAcknowledged','actor','timestamp']);return{...authorizeRunBudget({mode:value.mode,limits:value.limits,unlimitedAcknowledged:value.unlimitedAcknowledged},value.actor as string,value.timestamp as string),version:value.version};}
 exact(value,['status','ceilingNanodollars','projectLimitNanodollars','limitNanodollars','override','actor','timestamp']);
 money(value.ceilingNanodollars);money(value.projectLimitNanodollars);
 if(value.status!=='allowed'||typeof value.override!=='boolean'||(value.override?value.limitNanodollars!==null:value.limitNanodollars===null))fail('The legacy spending decision did not authorize this run.');
 if(!value.override&&value.limitNanodollars!==value.projectLimitNanodollars)fail('The legacy spending limit is inconsistent.');
 // A legacy zero limit was valid and must halt immediately, not be promoted to unlimited.
 if(!value.override&&value.limitNanodollars==='0'){
  const audit=authorizeRunBudget({mode:'limited',limits:{blended:'1',openai:null,typesafe:null},unlimitedAcknowledged:false},value.actor as string,value.timestamp as string);
  return{...audit,version:0,limits:{blended:'0',openai:null,typesafe:null}};
 }
 return{...authorizeRunBudget({mode:value.override?'unlimited':'limited',limits:{blended:value.limitNanodollars,openai:null,typesafe:null},unlimitedAcknowledged:value.override},value.actor as string,value.timestamp as string),version:0};
}
export function checkRunBudget(budget:RunBudget,spend:Spend):{halt:boolean;reached:SpendDimension[]}{
 const actual={blended:money(spend.blended),openai:money(spend.openai),typesafe:money(spend.typesafe)};
 if(actual.blended!==actual.openai+actual.typesafe)fail('Recorded vendor spending does not equal the blended total.');
 const reached=dimensions.filter(key=>budget.limits[key]!==null&&actual[key]>=money(budget.limits[key]));return{halt:reached.length>0,reached};
}
/** What one recorded vendor call adds to a run's spend counters: the single place the role-to-vendor mapping lives. */
export interface SpendDelta {openai:bigint;typesafe:bigint;unknown:0|1}
/**
 * confidence → TypeSafe; reader and recovery → OpenAI. A call whose cost is unknown (cost_nano null) counts as one
 * unknown call; a recorded cost under any other role is refused.
 */
export function vendorSpendDelta(role:string,cost_nano:string|null):SpendDelta{
 if(cost_nano===null)return{openai:0n,typesafe:0n,unknown:1};
 const cost=money(cost_nano);
 if(role==='confidence')return{openai:0n,typesafe:cost,unknown:0};
 if(role==='reader'||role==='recovery')return{openai:cost,typesafe:0n,unknown:0};
 return fail('A recorded cost has an unknown vendor role.');
}
export function sumVendorSpend(rows:readonly {role:string;cost_nano:string}[]):Spend{
 let openai=0n,typesafe=0n;for(const row of rows){const delta=vendorSpendDelta(row.role,row.cost_nano);openai+=delta.openai;typesafe+=delta.typesafe;}
 return{blended:(openai+typesafe).toString(),openai:openai.toString(),typesafe:typesafe.toString()};
}
