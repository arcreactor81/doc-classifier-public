/** Cloudflare instance IDs: at most 100 characters, alphanumeric/underscore first,
 * then alphanumeric, underscore or hyphen. Verified 2026-09-22:
 * https://developers.cloudflare.com/workflows/build/workers-api/#create
 * Hash the complete framed identities; never truncate the run or fingerprint.
 */
export async function workflowInstanceId(runId:string,fingerprint:string):Promise<string>{
 if(typeof runId!=='string'||!runId.trim()||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('Complete run identity and document fingerprint are required.');
 const input=new TextEncoder().encode(JSON.stringify(['document-workflow-v1',runId,fingerprint]));
 const hash=await crypto.subtle.digest('SHA-256',input);
 return 'doc_'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
