import {decide} from '../../core/domain/decision.ts';
/** Offline only: retain original notes and return both labeled counterfactuals. */
export function replayReader(source,reader,typeIds){
 const common={typeIds,threshold:0.90,failures:[],notes:[...source.notes],confidence:source.confidence,readerYes:reader.verdicts.filter(v=>v.is_type).map(v=>v.type_id)};
 return {basis:'retained-confidence-reader-isolation-counterfactual',historicalNotePolicy:decide({...common,notePolicy:'all-notes-review-v1'}),approvedNotePolicy:decide({...common,notePolicy:'full-state-structural-info-v2',confidenceStatePolicy:'untrimmed-structured-state-v2'})};
}
