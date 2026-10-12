import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWranglerConfig} from './wrangler-config.mjs';

test('deployment parses actual JSONC syntax without TypeScript compiler APIs',()=>{
 const config=parseWranglerConfig(`{ // deployment configuration
   "name":"classifier", "vars":{"MODEL_CALLS_ENABLED":"false",},
   "route":"https://example.invalid/a/*", /* preserve URL and comment markers */
 }`);
 assert.deepEqual(config,{name:'classifier',vars:{MODEL_CALLS_ENABLED:'false'},route:'https://example.invalid/a/*'});
});
test('deployment rejects malformed or non-object configuration instead of recovering it',()=>{
 for(const text of ['{"name":}', '{"name":"x"', '{} trailing', '', 'null', '[]', '"string"', '{"name":"x",,}']){
  assert.throws(()=>parseWranglerConfig(text),/Invalid Wrangler JSON configuration/);
 }
});
