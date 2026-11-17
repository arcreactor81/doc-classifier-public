import test from 'node:test';
import assert from 'node:assert/strict';
import { readVendorHealth } from './vendor-health.ts';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { migratedDatabase, localD1 } from './testing/local-bindings.ts';
function database(latest:unknown,unknown:number){return{prepare:(sql:string)=>({first:async()=>{assert.ok(sql.includes('FROM vendor_calls'));return sql.includes('COUNT(*)')?{count:unknown}:latest;}})} as D1Database;}
test('no recorded inference calls remains not contacted',async()=>{assert.deepEqual(await readVendorHealth(database(null,0)),{status:'not_contacted',latest:null,unknownSpendCount:0});});
test('a submitted attempt without an HTTP response is not reported as never contacted',async()=>{const latest={role:'confidence',status:null,created_at:'2026-09-22T12:00:00Z'};assert.deepEqual(await readVendorHealth(database(latest,3)),{status:'no_response',latest:{role:'confidence',httpStatus:null,at:latest.created_at},unknownSpendCount:3});});
test('latest failed and successful HTTP responses are distinct and retain unknown usage',async()=>{for(const [status,expected] of [[429,'response_failed'],[200,'response_received']]){const result=await readVendorHealth(database({role:'reader',status,created_at:'2026-09-22T12:00:00Z'},1));assert.equal(result.status,expected);assert.equal(result.latest?.httpStatus,status);assert.equal(result.unknownSpendCount,1);}});

test('the sparse unknown-cost index covers existing and new ledger rows without changing Health', async t => {
  const db = migratedDatabase({ foreignKeys: false }), log: string[] = [], binding = localD1(db, log);
  const index = 'vendor_calls_unknown_cost', count = process.env.VENDOR_HEALTH_BENCHMARK === '1' ? 20_000 : 100;
  const fixed = '2026-01-01T00:00:00.000Z';
  try {
    // Start before the migration; historical receipts already exist when an installation is upgraded.
    db.exec('DROP INDEX IF EXISTS ' + index);
    const insert = db.prepare(`INSERT INTO vendor_calls
      (attempt_id,run_id,fingerprint,role,model_requested,status,latency_ms,raw_key,created_at,cost_nano)
      VALUES(?,'run','fingerprint','reader','model',?,1,'raw',?,?)`);
    db.exec('BEGIN');
    for (let i=0; i<count; i++) insert.run(String(i).padStart(6,'0'), 200, fixed, i<12 ? null : '100000');
    insert.run('z', 503, fixed, '0');
    db.exec('COMMIT');
    const before = await readVendorHealth(binding);
    assert.deepEqual(before, {status:'response_failed', latest:{role:'reader',httpStatus:503,at:fixed}, unknownSpendCount:12});
    const [latestSql, countSql] = log;
    const plan = (sql:string) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row=>String(row.detail)).join('\n');
    assert.match(plan(countSql!), /SCAN vendor_calls$/);
    const timed = () => {
      const statement=db.prepare(countSql!), samples:number[]=[];
      for(let i=0;i<7;i++) {
        const start=performance.now();
        for(let n=0;n<100;n++) statement.get();
        samples.push(performance.now()-start);
      }
      return samples.sort((a,b)=>a-b)[3]!;
    };
    const beforeMs=count===20_000 ? timed() : null;
    db.exec(readFileSync(new URL('../../migrations/0034_vendor_calls_unknown_cost.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readVendorHealth(binding),before);
    assert.match(plan(countSql!), /USING (?:COVERING )?INDEX vendor_calls_unknown_cost/);
    assert.match(plan(latestSql!), /vendor_calls_created/);
    if (beforeMs !== null) t.diagnostic(`20,001 receipts (12 unknown), median 100 COUNTs: ${beforeMs.toFixed(2)} -> ${timed().toFixed(2)} ms.`);
    insert.run('zz', 520, fixed, null);
    assert.deepEqual(await readVendorHealth(binding), {status:'response_failed',latest:{role:'reader',httpStatus:520,at:fixed},unknownSpendCount:13});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n,count+2);
  } finally { db.close(); }
});
