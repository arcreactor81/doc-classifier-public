import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createLocalJWKSet, createRemoteJWKSet, customFetch, errors, exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { accessIssuer, actorFor, verifyAccessAssertion } from './auth.ts';
const settings={teamDomain:'unit.cloudflareaccess.com',audience:'unit-audience'};
const keys=await generateKeyPair('RS256');
async function token(options:{issuer?:string;audience?:string;expired?:boolean;subject?:string;omitSubject?:boolean}={}){
 let jwt=new SignJWT({}).setProtectedHeader({alg:'RS256'}).setIssuer(options.issuer??'https://unit.cloudflareaccess.com').setAudience(options.audience??settings.audience).setIssuedAt().setExpirationTime(options.expired?'1 second ago':'5 minutes');
 if(!options.omitSubject)jwt=jwt.setSubject(options.subject??'actor-1');
 return jwt.sign(keys.privateKey);
}
function request(jwt?:string,origin?:string){return new Request('https://unit.invalid/api/runs',{method:'POST',headers:{...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),...(origin?{Origin:origin}:{})}});}
test('Access authenticates a signed assertion and retains its subject as actor',async()=>{
 assert.equal(await verifyAccessAssertion(request(await token(),'https://unit.invalid'),settings,keys.publicKey),'actor-1');
});
test('Access rejects wrong issuer audience signature expiry or missing subject',async()=>{
 for(const options of [{issuer:'https://other.cloudflareaccess.com'},{audience:'other'},{expired:true},{omitSubject:true},{subject:''}]){
  await assert.rejects(verifyAccessAssertion(request(await token(options)),settings,keys.publicKey),{code:'E_ACCESS_INVALID'});
 }
 const other=await generateKeyPair('RS256');
 await assert.rejects(verifyAccessAssertion(request(await token()),settings,other.publicKey),{code:'E_ACCESS_INVALID'});
});
test('Access requires a valid team configuration, audience, assertion and same origin for writes',async()=>{
 assert.throws(()=>accessIssuer('https://untrusted.invalid'),{code:'E_ACCESS_CONFIGURATION'});
 await assert.rejects(verifyAccessAssertion(request(),settings,keys.publicKey),{code:'E_ACCESS_REQUIRED'});
 await assert.rejects(verifyAccessAssertion(request(await token()),{...settings,audience:''},keys.publicKey),{code:'E_ACCESS_CONFIGURATION'});
 await assert.rejects(verifyAccessAssertion(request(await token(),'https://other.invalid'),settings,keys.publicKey),{code:'E_ORIGIN'});
});

// Test audit (7 October 2026): the edges jose's RS256-only rule and the Origin check cover, pinned.
const b64=(value:object)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const claims=()=>({iss:'https://unit.cloudflareaccess.com',aud:settings.audience,sub:'actor-1',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300});
/** The public key as a JWKS, as Cloudflare publishes it but without an `alg`, so only the verifier's own rule pins RS256. */
const openJwks=async(publicKey:CryptoKey=keys.publicKey)=>createLocalJWKSet({keys:[{...(await exportJWK(publicKey)),use:'sig',kid:'k1'}]});
const sent=(jwt:string,method:string,origin?:string)=>new Request('https://unit.invalid/api/runs',{method,headers:{'Cf-Access-Jwt-Assertion':jwt,...(origin?{Origin:origin}:{})}});
test('an unsigned alg:none token is refused, against a key and against a key set',async()=>{
 const unsigned=`${b64({alg:'none',typ:'JWT'})}.${b64(claims())}.`;
 for(const source of [keys.publicKey,await openJwks()])
  await assert.rejects(verifyAccessAssertion(sent(unsigned,'POST'),settings,source),{code:'E_ACCESS_INVALID',status:401});
});
test('an HS256 token keyed with the RSA public key bytes is refused, against a key and against a key set',async()=>{
 const header=b64({alg:'HS256',typ:'JWT'}),body=b64(claims());
 for(const material of [Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey) as ArrayBuffer),Buffer.from(JSON.stringify(await exportJWK(keys.publicKey)))]){
  const confused=`${header}.${body}.${createHmac('sha256',material).update(`${header}.${body}`).digest('base64url')}`;
  for(const source of [keys.publicKey,await openJwks()])
   await assert.rejects(verifyAccessAssertion(sent(confused,'POST'),settings,source),{code:'E_ACCESS_INVALID',status:401});
 }
});
test('only RS256 is accepted: a PS256 token signed with the same RSA key is refused even by a key set that names no algorithm',async()=>{
 const pair=await generateKeyPair('RS256',{extractable:true});
 const pss=await importPKCS8(await exportPKCS8(pair.privateKey),'PS256');
 const jwt=await new SignJWT({}).setProtectedHeader({alg:'PS256',kid:'k1'}).setIssuer('https://unit.cloudflareaccess.com').setAudience(settings.audience).setSubject('actor-1').setIssuedAt().setExpirationTime('5 minutes').sign(pss);
 await assert.rejects(verifyAccessAssertion(sent(jwt,'POST'),settings,await openJwks(pair.publicKey)),{code:'E_ACCESS_INVALID',status:401});
 // The same key set accepts the RS256 token, so the refusal above is the algorithm rule alone.
 const rs=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'k1'}).setIssuer('https://unit.cloudflareaccess.com').setAudience(settings.audience).setSubject('actor-1').setIssuedAt().setExpirationTime('5 minutes').sign(pair.privateKey);
 assert.equal(await verifyAccessAssertion(sent(rs,'POST'),settings,await openJwks(pair.publicKey)),'actor-1');
});
test('a foreign Origin is allowed on a read and refused on a write; a write without an Origin is allowed',async()=>{
 assert.equal(await verifyAccessAssertion(sent(await token(),'GET','https://other.invalid'),settings,keys.publicKey),'actor-1');
 assert.equal(await verifyAccessAssertion(sent(await token(),'HEAD','https://other.invalid'),settings,keys.publicKey),'actor-1');
 for(const method of ['POST','PUT','DELETE'])
  await assert.rejects(verifyAccessAssertion(sent(await token(),method,'https://other.invalid'),settings,keys.publicKey),{code:'E_ORIGIN',status:403});
 await assert.rejects(verifyAccessAssertion(sent(await token(),'POST','null'),settings,keys.publicKey),{code:'E_ORIGIN',status:403});
 assert.equal(await verifyAccessAssertion(sent(await token(),'POST'),settings,keys.publicKey),'actor-1');
 assert.equal(await verifyAccessAssertion(sent(await token(),'POST','https://unit.invalid'),settings,keys.publicKey),'actor-1');
});

test('missing legacy team settings produce an explicit configuration blocker',()=>{
 assert.throws(()=>accessIssuer(undefined),{code:'E_ACCESS_CONFIGURATION'});
});

// Hosted evidence, 7 October 2026: one upload in 9,461 got 401 E_ACCESS_INVALID after 5,162 ms, just over jose's 5 s
// certificate timeout. Failing to get the keys is not a failed sign-in: it is its own retryable 503.
const KEYS_UNAVAILABLE={code:'E_ACCESS_KEYS_UNAVAILABLE',status:503,message:"Sign-in couldn't be checked just now. Try again in a moment."};
const INVALID={code:'E_ACCESS_INVALID',status:401,message:'Access authentication could not be verified.'};
const certs=(reply:()=>Promise<Response>)=>createRemoteJWKSet(new URL('https://unit.cloudflareaccess.com/cdn-cgi/access/certs'),{[customFetch]:reply} as never);
test('keys that cannot be retrieved are a retryable 503, never an invalid sign-in: timeout, network, non-2xx, unreadable or invalid key set',async()=>{
 const jwt=await token();
 await assert.rejects(verifyAccessAssertion(request(jwt),settings,async()=>{throw new errors.JWKSTimeout();}),KEYS_UNAVAILABLE);
 for(const reply of [
  async()=>{throw new TypeError('fetch failed');},
  async()=>new Response('upstream unavailable',{status:503}),
  async()=>new Response('<html>not json</html>',{status:200}),
  async()=>Response.json({keys:'not a list'})
 ])await assert.rejects(verifyAccessAssertion(request(jwt),settings,certs(reply)),KEYS_UNAVAILABLE);
});
test('a token that fails verification against keys that were retrieved stays 401 E_ACCESS_INVALID',async()=>{
 const jwk={...(await exportJWK(keys.publicKey)),alg:'RS256',use:'sig',kid:'published'};
 const other=await generateKeyPair('RS256');
 const signedBy=(key:CryptoKey,kid:string)=>new SignJWT({}).setProtectedHeader({alg:'RS256',kid}).setIssuer('https://unit.cloudflareaccess.com').setAudience(settings.audience).setSubject('actor-1').setIssuedAt().setExpirationTime('5 minutes').sign(key);
 for(const getter of [createLocalJWKSet({keys:[jwk]}),certs(async()=>Response.json({keys:[jwk]}))]){
  // A bad signature under a published key id, and a key id the team does not publish.
  await assert.rejects(verifyAccessAssertion(request(await signedBy(other.privateKey,'published')),settings,getter),INVALID);
  await assert.rejects(verifyAccessAssertion(request(await signedBy(other.privateKey,'unknown')),settings,getter),INVALID);
  assert.equal(await verifyAccessAssertion(request(await signedBy(keys.privateKey,'published')),settings,getter),'actor-1');
 }
});
test('through the request path, an unreachable certificate endpoint answers 503 and a good token afterwards is accepted',async()=>{
 const jwk={...(await exportJWK(keys.publicKey)),alg:'RS256',use:'sig'};
 const previous=globalThis.fetch;let reachable=false;
 globalThis.fetch=(async()=>{if(!reachable)throw new TypeError('fetch failed');return Response.json({keys:[jwk]});}) as typeof fetch;
 try{
  const env={ACCESS_TEAM_DOMAIN:'unreachable-unit.cloudflareaccess.com',ACCESS_AUD:settings.audience} as unknown as Env;
  const jwt=await token({issuer:'https://unreachable-unit.cloudflareaccess.com'});
  await assert.rejects(actorFor(request(jwt),env),KEYS_UNAVAILABLE);
  reachable=true;
  assert.equal(await actorFor(request(jwt),env),'actor-1');
 }finally{globalThis.fetch=previous;}
});

test('the Access signing keys are fetched once per team and reused by later requests (F9)',async()=>{
 const jwk={...(await exportJWK(keys.publicKey)),alg:'RS256',use:'sig'};
 const previous=globalThis.fetch,fetched:string[]=[];
 globalThis.fetch=(async(input:RequestInfo|URL)=>{fetched.push(String(input instanceof Request?input.url:input));return Response.json({keys:[jwk]});}) as typeof fetch;
 try{
  const env={ACCESS_TEAM_DOMAIN:'cache-unit.cloudflareaccess.com',ACCESS_AUD:settings.audience} as unknown as Env;
  for(let i=0;i<3;i++)assert.equal(await actorFor(request(await token({issuer:'https://cache-unit.cloudflareaccess.com'})),env),'actor-1');
  assert.deepEqual(fetched,['https://cache-unit.cloudflareaccess.com/cdn-cgi/access/certs']);
  // Another team has its own key set, fetched on its own.
  const other={...env,ACCESS_TEAM_DOMAIN:'cache-other.cloudflareaccess.com'} as unknown as Env;
  assert.equal(await actorFor(request(await token({issuer:'https://cache-other.cloudflareaccess.com'})),other),'actor-1');
  assert.deepEqual(fetched,['https://cache-unit.cloudflareaccess.com/cdn-cgi/access/certs','https://cache-other.cloudflareaccess.com/cdn-cgi/access/certs']);
 }finally{globalThis.fetch=previous;}
});
