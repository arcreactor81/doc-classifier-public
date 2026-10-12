import test from 'node:test';
import assert from 'node:assert/strict';
import { readPilot, readPilotVerdict, readPilotConfirmation } from './trial-wire.ts';
const fp='1'.repeat(64),confirmation={id:'confirmation',createdAt:'2026-09-30T00:00:00Z',confirmedBy:'owner',filedCount:0};
const view={campaignId:'campaign',role:'pilot',pilotSize:25,filed:[],counts:{filed:0,reviewed:0,right:0,wrong:0},confirmation:null,categoryVersion:{frozen:'v1',active:'v1',matches:true}};
test('zero automatic filings still require an explicit stored confirmation',()=>{
 assert.equal(readPilot(view).confirmation,null);assert.deepEqual(readPilotConfirmation(confirmation),confirmation);
 assert.equal(readPilot({...view,confirmation}).confirmation?.filedCount,0);
});
test('trial guards preserve human verdicts and reject inconsistent counts or versions',()=>{
 const filed=[{fingerprint:fp,ordinal:1,tag:'r-test-00001',originalFilename:'item.pdf',destinationFolder:'category_a',verdict:'wrong'}];
 const v={...view,filed,counts:{filed:1,reviewed:1,right:0,wrong:1}};
 assert.equal(readPilot(v).filed[0].verdict,'wrong');
 assert.throws(()=>readPilot({...v,counts:view.counts}));
 assert.throws(()=>readPilot({...view,categoryVersion:{frozen:'v1',active:'v2',matches:true}}));
 assert.throws(()=>readPilotVerdict({id:'v',fingerprint:fp,tag:'t',verdict:'maybe',createdAt:'now'}));
});
