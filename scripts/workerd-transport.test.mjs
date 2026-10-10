import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Miniflare} from 'miniflare';
import {executeVendor} from '../core/vendors/transport.ts';
test('actual Workers runtime accepts transport and never follows credential-bearing redirects',async()=>{
 const received=[];const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({path:req.url,body});if(req.url==='/redirect'){res.writeHead(302,{location:'/must-not-follow'});res.end('redirect');}else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:0},value:true}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
 const script='export default {async fetch(request){const data=await request.json();try{return await fetch('+JSON.stringify(local)+'+data.path,{...data.init,signal:AbortSignal.timeout(600000)});}catch(error){return Response.json({constructionError:error.name},{status:590});}}};';
 let mf;try{
  mf=new Miniflare({workers:[{config:{name:'transport-regression',compatibilityDate:'2026-09-22',manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:script}}}}}]});
  const dispatch=(path,init)=>mf.dispatchFetch('http://local.test/',{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({path,init})});
  const unsupported=await dispatch('/ok',{method:'POST',headers:{authorization:'Bearer synthetic-only-key'},body:'{}',redirect:'error'});assert.equal(unsupported.status,590);assert.equal((await unsupported.json()).constructionError,'TypeError');assert.equal(received.length,0);
  let path='/ok',index=0;const raw=[],logs=[];
  const request={role:'confidence',endpoint:'https://api.typesafe.ai/v1/systemone',model:'jev-1.13.0',modelPolicy:{id:'jev-1.13.0',policy:'versioned',date:'2026-09-22',reason:'test'},body:'{"model":"jev-1.13.0","state":"synthetic"}'};
  const deps={fetch:async(url,init)=>{assert.equal(url,request.endpoint);return dispatch(path,init);},guard:async()=>{},readSecret:async()=> 'synthetic-only-key',now:Date.now,sleep:async()=>{},attemptId:()=> 'a'+(++index),persistRaw:async value=>{raw.push(value);},logCall:async value=>{logs.push(value);},recordDocumentOutcome:async()=>0};
  const policy={transportAttempts:3,schemaAttempts:1,baseDelayMs:1,serverErrorBaseDelayMs:1,maxBackoffMs:1,consecutiveFailureLimit:3};
  assert.equal((await executeVendor(request,policy,deps,value=>value.value)).value,true);assert.equal(received.length,1);assert.equal(received[0].body,request.body);
  path='/redirect';await assert.rejects(executeVendor(request,policy,deps,value=>value),{code:'E_VENDOR_REDIRECT'});assert.deepEqual(received.map(r=>r.path),['/ok','/redirect']);assert.equal(raw.at(-1).status,302);assert.equal(logs.at(-1).networkFailure,false);
 }finally{if(mf)await mf.dispose();await new Promise(resolve=>server.close(resolve));}
});
