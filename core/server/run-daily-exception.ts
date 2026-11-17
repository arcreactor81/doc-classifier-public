import { readD1 } from './d1-write-policy.ts';
import { ServerFailure } from './errors.ts';
import { editorAllowed } from '../config/definitions.ts';
import { DEEPSEEK_LOW_OPTION, peakPriceAt, vendorPricePeriods, type ProjectPack } from '../config/project.ts';
import type { RunRow } from './store.ts';
import { usageCopy } from '../ui/copy-usage.ts';

export interface RunDailyException {
  runId:string; quoteId:string; actor:string; build:string; provider:'deepseek'; model:'deepseek-flash';
  mode:'unlimited'; fingerprints:string[]; startAt:string; endAt:string; grantedAt:string;
  readerOption?:typeof DEEPSEEK_LOW_OPTION;
}
const invalid = () => new ServerFailure('E_DAILY_EXCEPTION','blocker',usageCopy.invalidRunAllowance);
const instant = (s:unknown):s is string => typeof s==='string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s;

export const scopedDeepseekPool=(runId:string)=>'deepseek/run/'+runId;

/** Read-only. Insertion is an operator-only D1 action before upload; the production API has no enrollment route. */
export async function runDailyException(db:D1Database,id:string):Promise<RunDailyException|null> {
  const row=await readD1<Omit<RunDailyException,'fingerprints'|'readerOption'>&{fingerprints_json:string;reader_option:string}>(db.prepare(`SELECT run_id AS runId, reader_option,
    quote_id AS quoteId,actor,build,provider,model_id AS model,mode,fingerprints_json,start_at AS startAt,
    end_at AS endAt,granted_at AS grantedAt FROM run_daily_exceptions WHERE run_id=?`).bind(id));
  if(row===null)return null;
  const {fingerprints_json,reader_option,...fields}=row;
  let fingerprints:unknown;try{fingerprints=JSON.parse(fingerprints_json);}catch{throw invalid();}
  if(fields.runId!==id||!fields.actor||!fields.quoteId||!/^[a-f0-9]{40}$/.test(fields.build)||fields.provider!=='deepseek'||
    fields.model!=='deepseek-flash'||fields.mode!=='unlimited'||!instant(fields.startAt)||!instant(fields.endAt)||!instant(fields.grantedAt)||
    fields.startAt>fields.grantedAt||fields.grantedAt>=fields.endAt||!Array.isArray(fingerprints)||!fingerprints.length||
    fingerprints.some(f=>typeof f!=='string'||!/^[0-9a-f]{64}$/.test(f))||new Set(fingerprints).size!==fingerprints.length)throw invalid();
  if(reader_option!=='deepseek' && reader_option!==DEEPSEEK_LOW_OPTION)throw invalid();
  // The original allowance's serialized receipt is immutable.
  return {...fields,fingerprints,...(reader_option===DEEPSEEK_LOW_OPTION?{readerOption:DEEPSEEK_LOW_OPTION}:{})};
}

export function verifyDailyException(scope:RunDailyException, run:Pick<RunRow,'id'|'quote_id'|'actor'|'expected_count'>,
  env:Pick<Env,'BUILD_COMMIT'|'DEFINITION_EDITORS'>,pack:ProjectPack,fingerprint?:string) {
  const window=pack.settings.inferenceWindow;
  if(scope.runId!==run.id||scope.quoteId!==run.quote_id||scope.actor!==run.actor||scope.build!==env.BUILD_COMMIT||
    !editorAllowed(env.DEFINITION_EDITORS,run.actor)||scope.model!==pack.pins.reader.id||(scope.readerOption??scope.provider)!==pack.selectedReaderModel||
    scope.readerOption===DEEPSEEK_LOW_OPTION && (pack.settings.readerEffort!=='low'||pack.settings.readerMaxOutputTokens!==16384)||
    scope.fingerprints.length!==run.expected_count||(fingerprint!==undefined&&!scope.fingerprints.includes(fingerprint))||
    scope.startAt!==window?.startAt||scope.endAt!==window?.endAt)throw invalid();
}

/** Refuse an unregistered study run before dispatch, including the Jev and recovery stages. */
export async function requireLowRunGrant(env:Pick<Env,'DB'|'BUILD_COMMIT'|'DEFINITION_EDITORS'>,
  run:Pick<RunRow,'id'|'quote_id'|'actor'|'expected_count'>,pack:ProjectPack,fingerprint?:string) {
  const grant=await runDailyException(env.DB,run.id);
  if(!grant || grant.readerOption!==DEEPSEEK_LOW_OPTION)throw invalid();
  verifyDailyException(grant,run,env,pack,fingerprint);
  return grant;
}

/** Existing off-peak launch checks are supplemented by a last check at each enrolled paid reader dispatch. */
export function requireScopedDispatchTime(scope:RunDailyException,now:number) {
  const rates=vendorPricePeriods(scope.provider);
  if(!Number.isSafeInteger(now)||now<Date.parse(scope.startAt)||now>=Date.parse(scope.endAt)||!rates||peakPriceAt(rates,now))
    throw new ServerFailure('E_DAILY_EXCEPTION_WINDOW','blocker',usageCopy.offPeakWindow);
}
