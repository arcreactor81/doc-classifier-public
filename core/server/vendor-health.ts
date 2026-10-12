export interface VendorHealth {
 status:'not_contacted'|'no_response'|'response_failed'|'response_received'|'unavailable';
 latest:{role:string;httpStatus:number|null;at:string}|null;
 unknownSpendCount:number|null;
}
/** Recorded inference history only: never a live vendor probe or a claim of model validity. */
export async function readVendorHealth(db:D1Database):Promise<VendorHealth>{
 const latest=await db.prepare('SELECT role,status,created_at FROM vendor_calls ORDER BY created_at DESC,attempt_id DESC LIMIT 1').first<{role:string;status:number|null;created_at:string}>();
 const unknown=await db.prepare('SELECT COUNT(*) AS count FROM vendor_calls WHERE cost_nano IS NULL').first<{count:number}>();
 if(!unknown)throw new Error('Vendor accounting summary is unavailable.');
 return{status:!latest?'not_contacted':latest.status===null?'no_response':latest.status>=200&&latest.status<300?'response_received':'response_failed',latest:latest?{role:latest.role,httpStatus:latest.status,at:latest.created_at}:null,unknownSpendCount:unknown.count};
}
