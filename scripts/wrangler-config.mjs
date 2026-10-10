import {parse as parseJsonc} from 'jsonc-parser';
export function parseWranglerConfig(text){
 const errors=[];
 const config=parseJsonc(text,errors,{allowTrailingComma:true});
 if(errors.length||!config||typeof config!=='object'||Array.isArray(config))throw new Error('Invalid Wrangler JSON configuration.');
 return config;
}
