import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {parseWranglerConfig} from './wrangler-config.mjs';
// The account comes from CLOUDFLARE_ACCOUNT_ID or from account_id in the local owner configuration; when both are set
// they must agree. The id is never printed: a failure names its source, not its value.
const CONFIG='wrangler.owner.jsonc';
function accountId(){
 const valid=(source,value)=>{if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value)||/^0+$/.test(value))throw new Error('The Cloudflare account id from '+source+' is not a 32-character lower-case hexadecimal id (placeholders are refused). Its value is not shown.');return value;};
 const env=process.env.CLOUDFLARE_ACCOUNT_ID===undefined?undefined:valid('CLOUDFLARE_ACCOUNT_ID',process.env.CLOUDFLARE_ACCOUNT_ID);
 const raw=existsSync(CONFIG)?parseWranglerConfig(readFileSync(CONFIG,'utf8')).account_id:undefined;
 const config=raw===undefined?undefined:valid(CONFIG+' account_id',raw);
 if(env===undefined&&config===undefined)throw new Error('No Cloudflare account id: set CLOUDFLARE_ACCOUNT_ID, or account_id in '+CONFIG+' in the working directory.');
 if(env!==undefined&&config!==undefined&&env!==config)throw new Error('CLOUDFLARE_ACCOUNT_ID and '+CONFIG+' name different accounts. Neither value is shown.');
 return env??config;
}
const account=accountId();
const raw=execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
let credentials; try{credentials=JSON.parse(raw);}catch{throw new Error('Wrangler credential response was not JSON; credential output withheld.');}
const token=credentials.token??credentials.api_token??credentials.oauth_token;
if(typeof token!=='string')throw new Error('Unrecognized Wrangler credential shape; fields: '+Object.keys(credentials).join(','));
for(const [label,path] of [['zones','/zones'],['workers','/accounts/'+account+'/workers/scripts'],['access','/accounts/'+account+'/access/apps'],['build_connections','/accounts/'+account+'/builds/repos/connections']]){
 const response=await fetch('https://api.cloudflare.com/client/v4'+path,{headers:{Authorization:'Bearer '+token}});
 const body=await response.json();
 if(!response.ok||!body.success){console.log(JSON.stringify({label,status:response.status,errors:body.errors?.map(e=>({code:e.code,message:String(e.message).split(account).join('<account>')}))}));continue;}
 const results=Array.isArray(body.result)?body.result:body.result?.items??[];
 console.log(JSON.stringify({label,items:results.map(x=>({id:x.id,name:x.name,domain:x.domain,script:x.id,uid:x.uuid,provider:x.provider}))}));
}
