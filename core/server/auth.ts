import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ServerFailure, accessCopy } from './errors.ts';
export interface LegacyAccessBindings { ACCESS_TEAM_DOMAIN?:string; ACCESS_AUD?:string }
export { accessCopy };
/** The Access signing keys could not be obtained: the person's sign-in was never checked against them. */
class AccessKeysUnavailable extends Error {}
/**
 * Getting the team's keys is kept apart from checking the token (hosted evidence, 7 October 2026: one upload in 9,461 was
 * refused as an invalid sign-in after 5,162 ms, just past jose's 5 s certificate timeout). Anything the key getter throws
 * is a retrieval failure (jose's JWKSTimeout, a network or non-2xx certificate fetch, an unreadable or invalid key set),
 * except that the token names no published key (or an ambiguous one), which is the token's own failure. jose resolves the
 * key only after the header and the RS256-only algorithm check pass, so a token rejected there never reaches it.
 */
function retrievalSeparated(keys:JWTVerifyGetKey):JWTVerifyGetKey{
 return async(header,token)=>{
  try{return await keys(header,token);}
  catch(error){
   if(error instanceof errors.JWKSNoMatchingKey||error instanceof errors.JWKSMultipleMatchingKeys)throw error;
   throw new AccessKeysUnavailable('The Access signing keys could not be retrieved.',{cause:error});
  }
 };
}
export function accessIssuer(domain:string|undefined):string {
 if(typeof domain!=='string')throw new ServerFailure('E_ACCESS_CONFIGURATION','blocker','The existing Access team domain is not configured.');
 const host=domain.replace(/^https:\/\//,'').replace(/\/$/,'');
 if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(host))throw new ServerFailure('E_ACCESS_CONFIGURATION','blocker','The existing Access team domain is not configured.');
 return `https://${host}`;
}
export async function verifyAccessAssertion(request:Request,settings:{teamDomain:string;audience:string},keys:CryptoKey|JWTVerifyGetKey):Promise<string>{
 const issuer=accessIssuer(settings.teamDomain);
 if(!settings.audience)throw new ServerFailure('E_ACCESS_CONFIGURATION','blocker','The existing Access application audience is not configured.');
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 if(!token)throw new ServerFailure('E_ACCESS_REQUIRED','request','Sign in through the configured Access application.',401);
 try{
  const {payload}=await jwtVerify(token,typeof keys==='function'?retrievalSeparated(keys):keys,{issuer,audience:settings.audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub']});
  if(typeof payload.sub!=='string'||!payload.sub)throw new Error('Missing actor subject.');
  if(request.method!=='GET'&&request.method!=='HEAD'){
   const origin=request.headers.get('Origin');
   if(origin&&origin!==new URL(request.url).origin)throw new ServerFailure('E_ORIGIN','request','The request must come from this application.',403);
  }
  return payload.sub;
 }catch(error){
  if(error instanceof ServerFailure)throw error;
  // Retryable: nothing is wrong with the sign-in, which stays valid; a later request fetches the keys again.
  if(error instanceof AccessKeysUnavailable)throw new ServerFailure('E_ACCESS_KEYS_UNAVAILABLE','request',accessCopy.keysUnavailable,503);
  throw new ServerFailure('E_ACCESS_INVALID','request','Access authentication could not be verified.',401);
 }
}
/**
 * One remote key set per Access team, kept for the isolate's life so its certificates are fetched once and then reused
 * under jose's own freshness rules (10-minute cache, refetch on an unknown key id), instead of once per request (F9).
 * It holds parsed keys only, never a request's I/O object; on Workers jose never shares an in-flight fetch between
 * requests (jose 6.2.12, jwks/remote.js `isCloudflareWorkers`).
 */
const accessKeySets=new Map<string,JWTVerifyGetKey>();
function accessKeySet(issuer:string):JWTVerifyGetKey{
 let keys=accessKeySets.get(issuer);
 if(!keys){keys=createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));accessKeySets.set(issuer,keys);}
 return keys;
}
export async function actorFor(request:Request,env:Env & LegacyAccessBindings):Promise<string>{
 const issuer=accessIssuer(env.ACCESS_TEAM_DOMAIN);
 return verifyAccessAssertion(request,{teamDomain:env.ACCESS_TEAM_DOMAIN!,audience:env.ACCESS_AUD??''},accessKeySet(issuer));
}
