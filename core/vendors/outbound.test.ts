import test from 'node:test';
import assert from 'node:assert/strict';
import {outbound} from './outbound.ts';

test('production outbound forwards exactly URL and unchanged HTTP options, never simulated category context',async()=>{
 const saved=globalThis.fetch;
 const sent:unknown[][]=[];
 globalThis.fetch=async(...args)=>{sent.push(args);return new Response('{}');};
 try{
  assert.equal(outbound.vendors,'live');
  const options={method:'POST',body:'{"unchanged":true}',headers:{authorization:'test-only', 'content-type':'application/json'}};
  await outbound.fetch('https://api.typesafe.ai/v1/systemone',options,{confidenceTypeIds:['type_a']});
  assert.equal(sent.length,1);assert.equal(sent[0].length,2);
  assert.equal(sent[0][0],'https://api.typesafe.ai/v1/systemone');assert.equal(sent[0][1],options);
  assert.equal(options.body,'{"unchanged":true}');assert.deepEqual(options.headers,{authorization:'test-only','content-type':'application/json'});
 }finally{globalThis.fetch=saved;}
});
