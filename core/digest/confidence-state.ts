import type {DigestInput} from './digest.ts';
import {buildStructuredState,STRUCTURED_STATE_POLICY,type StructuredStateResult} from './structured-state.ts';
import {buildCompactFullState,COMPACT_FULL_STATE_POLICY,type CompactFullStateResult} from './compact-full-state.ts';
export type ConfidenceStateResult=StructuredStateResult|CompactFullStateResult;
/** Explicit policy dispatch keeps frozen historical run input unchanged. */
export function buildConfidenceState(policy:unknown,fullText:string,outline:DigestInput,vocabulary:readonly string[]):ConfidenceStateResult{
 if(policy===STRUCTURED_STATE_POLICY)return buildStructuredState(fullText,outline,vocabulary);
 if(policy===COMPACT_FULL_STATE_POLICY)return buildCompactFullState(fullText,outline,vocabulary);
 throw new Error('An explicit supported confidence input policy is required.');
}
