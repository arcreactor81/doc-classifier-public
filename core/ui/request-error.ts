import { uiCopy } from './copy.ts';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
export class UiRequestError extends Error {
 readonly status:number;readonly rawResponse:string;readonly code:string|undefined;readonly headline:string;readonly action:string;readonly details:unknown;
 constructor(status:number,rawResponse:string,known?:{code:string;headline:string;action:string;details?:unknown}){
  super(known?.headline??uiCopy.unrecognizedApiError);this.name='UiRequestError';this.status=status;this.rawResponse=rawResponse;this.code=known?.code;this.headline=known?.headline??uiCopy.unrecognizedApiError;this.action=known?.action??uiCopy.errorAction;this.details=known?.details;
 }
}
/** A UI-side code (never sent by the server): Cloudflare Access refused the request because the sign-in ran out. */
export const SIGN_IN_EXPIRED='E_SIGNIN_EXPIRED';
/**
 * Render server-provided wording only from the known envelope; retain every raw response for inspection.
 * A 401 without the app's envelope is Cloudflare Access's own answer for an expired session (the client asks for it
 * with `X-Requested-With`, api/client.ts): every refusal the app itself makes carries the envelope.
 */
export function parseRequestFailure(status:number,rawResponse:string):UiRequestError {
 let parsed:unknown;try{parsed=JSON.parse(rawResponse);}catch{/* Unknown response remains visible as raw technical detail below. */}
 const error=object(parsed)&&object(parsed.error)?parsed.error:null;
 if(error&&nonempty(error.code)&&nonempty(error.headline)&&nonempty(error.action))return new UiRequestError(status,rawResponse,{code:error.code,headline:error.headline,action:error.action,...(Object.hasOwn(error,'details')?{details:error.details}:{})});
 if(status===401)return new UiRequestError(status,rawResponse,{code:SIGN_IN_EXPIRED,headline:uiCopy.errors.headline.signInExpired,action:uiCopy.errors.action.signInExpired});
 return new UiRequestError(status,rawResponse);
}
export function errorPresentation(error:unknown):{headline:string;action:string;technical:Record<string,unknown>} {
 if(error instanceof UiRequestError)return{headline:error.headline,action:error.action,technical:{status:error.status,...(error.code===undefined?{}:{code:error.code}),...(error.details===undefined?{}:{details:error.details}),rawResponse:error.rawResponse}};
 return{headline:uiCopy.error,action:uiCopy.errorAction,technical:error instanceof Error?{...error,message:error.message}:{value:error}};
}
