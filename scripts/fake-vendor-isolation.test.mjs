import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import {parseWranglerConfig} from './wrangler-config.mjs';
import {syntheticPack,projectPackPlugin} from './fixtures/synthetic-pack.mjs';
import {FAKE_ENTRY,configLevels,resourceNames} from './deploy-fake.mjs';
// Production cannot select the pretend vendors (DECISIONS 31 item 6): the production bundles carry neither the marker
// nor the fake modules; the seam is live until the fake entry installs it, once; and no production configuration
// shares an entry, a name or a hostname with the fake one.
const MARKER='doc-classifier-fake-vendors-v1';
const FORBIDDEN=[MARKER,'fake-vendors','fake-worker'];
async function bundle(entry){
 const result=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers','cloudflare:workflows'],plugins:[projectPackPlugin(syntheticPack(2))]});
 return result.outputFiles[0].text;
}
test('the production entry excludes the marker and fake modules; the fake entry includes them',async()=>{
 const entry='core/server/worker.ts',text=await bundle(entry);
 for(const forbidden of FORBIDDEN)assert.equal(text.includes(forbidden),false,`${entry} contains ${forbidden}`);
 assert.equal(text.includes('installOutbound'),false,entry+' must not reference the installer');
 const fake=await bundle(FAKE_ENTRY);
 assert.equal(fake.includes(MARKER),true);
 assert.equal(fake.includes('installOutbound'),true);
});
test('the seam starts live, delegates to the global fetch at call time, and installs once',async()=>{
 const {outbound,installOutbound,runVendors,FAKE_VENDORS_NOTE}=await import('../core/vendors/outbound.ts?fresh='+Date.now());
 assert.equal(outbound.vendors,'live');
 const original=globalThis.fetch;const seen=[];
 globalThis.fetch=async(input,init)=>{seen.push([String(input),init?.method??null]);return new Response('stubbed');};
 try{
  const response=await outbound.fetch('https://example.invalid/probe',{method:'POST'});
  assert.equal(await response.text(),'stubbed');assert.deepEqual(seen,[['https://example.invalid/probe','POST']]);
 }finally{globalThis.fetch=original;}
 assert.deepEqual(runVendors([]),{});assert.deepEqual(runVendors([FAKE_VENDORS_NOTE]),{vendors:'fake'});
 for(const bad of [undefined,null,'fetch',{}])assert.throws(()=>installOutbound(bad),/needs a function/);
 assert.equal(outbound.vendors,'live');
 const replacement=async()=>new Response('replaced');
 installOutbound(replacement);
 assert.equal(outbound.vendors,'fake');assert.equal(outbound.fetch,replacement);
 assert.throws(()=>installOutbound(replacement),/installed once/);
 assert.throws(()=>installOutbound(async()=>new Response('again')),/installed once/);
 assert.equal(outbound.fetch,replacement);
});
test('every production configuration starts from a production entry; the fake configuration differs from all of them in entry, names and hostname',async()=>{
 const files=(await readdir('.')).filter(name=>/^wrangler.*\.jsonc$/.test(name)).sort();
 assert.deepEqual(files,['wrangler.fake.jsonc','wrangler.jsonc','wrangler.owner.jsonc']);
 const configs=Object.fromEntries(await Promise.all(files.map(async file=>[file,parseWranglerConfig(await readFile(file,'utf8'))])));
 const fake=configs['wrangler.fake.jsonc'];
 assert.equal(fake.main,FAKE_ENTRY);assert.equal(fake.secrets_store_secrets,undefined);assert.equal(fake.env,undefined);
 const fakeNames=resourceNames(fake).map(([kind,name])=>kind+':'+name),fakeRoutes=fake.routes.map(route=>route.pattern);
 assert.equal(fakeNames.length,4);assert.equal(fakeRoutes.length,1);
 for(const file of files.filter(name=>name!=='wrangler.fake.jsonc'))for(const [where,level] of configLevels(configs[file])){
  const main=level.main??configs[file].main;
  assert.equal(main,'core/server/worker.ts',`${file} ${where} starts from ${main}`);
  for(const [kind,name] of resourceNames(level))assert.equal(fakeNames.includes(kind+':'+name),false,`${file} ${where} ${kind} ${name}`);
  for(const route of level.routes??[])assert.equal(fakeRoutes.includes(route.pattern),false,`${file} ${where} ${route.pattern}`);
  assert.equal(Array.isArray(level.secrets_store_secrets)||where!=='top level',true,`${file} ${where} keeps its credential bindings`);
 }
});
