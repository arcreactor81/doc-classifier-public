export interface ProviderWait {scope:'openai'|'typesafe';until:number}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** Concurrent Workflow events can arrive out of order; preserve the maximum observed deadline per scope. */
export function activeProviderWaits(status:string,events:readonly unknown[],nowMs:number):ProviderWait[]{
 if(status!=='running'||!Number.isFinite(nowMs))return[];const latest=new Map<ProviderWait['scope'],number>();
 for(const event of events){if(!record(event)||event.stage!=='provider_cooldown'||event.kind!=='waiting'||typeof event.details_json!=='string')continue;let details:unknown;try{details=JSON.parse(event.details_json);}catch{continue;/* Unknown event details are not evidence of a provider wait. */}
  if(!record(details)||(details.scope!=='openai'&&details.scope!=='typesafe')||typeof details.until!=='number'||!Number.isSafeInteger(details.until)||details.until<0)continue;
  latest.set(details.scope,Math.max(latest.get(details.scope)??0,details.until));
 }
 return Array.from(latest,([scope,until])=>({scope,until})).filter(item=>item.until>nowMs);
}
