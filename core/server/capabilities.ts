
import type { ProjectPack } from '../config/project.ts';
import { ServerFailure } from './errors.ts';

export type Pricing=ProjectPack['prices'];
/** Interactive is the only execution mode. */
export function pricingFor(pack:ProjectPack):Pricing['interactive']{
 const value=(pack as ProjectPack&{prices?:Pricing}).prices;
 if(!value?.verifiedAt||!value.source||!value.interactive)throw new ServerFailure('E_PRICING_UNVERIFIED','blocker','Verified published prices are not configured.');
 return value.interactive;
}
export { EXECUTION_ATTEMPTS } from '../cost/policy.ts';