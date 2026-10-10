/** Comparison policy only: never rewrite the stored model output or source. */
export type ReaderEvidencePolicy='exact-substring-v1'|'whitespace-quotes-v1';
/** Missing only on legacy/frozen packs; never silently interpret unknown versions. */
export function readerEvidencePolicy(value:unknown):ReaderEvidencePolicy{
 if(value===undefined)return 'exact-substring-v1';
 if(value==='exact-substring-v1'||value==='whitespace-quotes-v1')return value;
 throw new Error('Unknown reader evidence comparison policy.');
}
/** ECMAScript whitespace collapses to one ASCII space; only curly single/double quotes map. */
export function canonicalEvidence(text:string):string{
 return text.replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\s+/gu,' ').trim();
}
export function evidenceMatches(text:string,quote:string,policy:ReaderEvidencePolicy):boolean{
 const selected=readerEvidencePolicy(policy);
 if(selected==='exact-substring-v1')return quote.length>0&&text.includes(quote);
 const canonicalQuote=canonicalEvidence(quote);
 return canonicalQuote.length>0&&canonicalEvidence(text).includes(canonicalQuote);
}
