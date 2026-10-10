import test from 'node:test';
import assert from 'node:assert/strict';
import { readVendorHealth } from './vendor-health.ts';
function database(latest:unknown,unknown:number){return{prepare:(sql:string)=>({first:async()=>{assert.ok(sql.includes('FROM vendor_calls'));return sql.includes('COUNT(*)')?{count:unknown}:latest;}})} as D1Database;}
test('no recorded inference calls remains not contacted',async()=>{assert.deepEqual(await readVendorHealth(database(null,0)),{status:'not_contacted',latest:null,unknownSpendCount:0});});
test('a submitted attempt without an HTTP response is not reported as never contacted',async()=>{const latest={role:'confidence',status:null,created_at:'2026-09-22T12:00:00Z'};assert.deepEqual(await readVendorHealth(database(latest,3)),{status:'no_response',latest:{role:'confidence',httpStatus:null,at:latest.created_at},unknownSpendCount:3});});
test('latest failed and successful HTTP responses are distinct and retain unknown usage',async()=>{for(const [status,expected] of [[429,'response_failed'],[200,'response_received']]){const result=await readVendorHealth(database({role:'reader',status,created_at:'2026-09-22T12:00:00Z'},1));assert.equal(result.status,expected);assert.equal(result.latest?.httpStatus,status);assert.equal(result.unknownSpendCount,1);}});
