/** Comparison policy only: never rewrite the stored model output or source. */
export type ReaderEvidencePolicy='exact-substring-v1'|'whitespace-quotes-v1'|'layout-quotes-v2';
/** Missing only on legacy/frozen packs; never silently interpret unknown versions. */
export function readerEvidencePolicy(value:unknown):ReaderEvidencePolicy{
 if(value===undefined)return 'exact-substring-v1';
 if(value==='exact-substring-v1'||value==='whitespace-quotes-v1'||value==='layout-quotes-v2')return value;
 throw new Error('Unknown reader evidence comparison policy.');
}
/** ECMAScript whitespace collapses to one ASCII space; only curly single/double quotes map. */
export function canonicalEvidence(text:string):string{
 return text.replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\s+/gu,' ').trim();
}

/*
 * `layout-quotes-v2` (DECISIONS 156, addendum of 12 October 2026: selected by the owner and practice packs for new runs;
 * the generic pack keeps whitespace-quotes-v1; frozen runs keep theirs). whitespace-quotes-v1
 * plus three typesetting rules, each a published Unicode definition applied the same way to every document, never a list
 * of characters chosen from observed replies:
 * 1. Presentation forms. A character in one of Unicode's presentation-form blocks (Blocks.txt: Alphabetic Presentation
 *    Forms FB00..FB4F, Arabic Presentation Forms-A FB50..FDFF, Vertical Forms FE10..FE1F, CJK Compatibility Forms
 *    FE30..FE4F, Small Form Variants FE50..FE6F, Arabic Presentation Forms-B FE70..FEFF, Halfwidth and Fullwidth Forms
 *    FF00..FFEF) is read, on both sides, as its compatibility decomposition (NFKC). The Unicode Standard (ch. 23,
 *    "Compatibility characters") encodes these only as typographic variants of ordinary characters: a ligature such as
 *    U+FB01 is the letters f and i. Full NFKC is not used: it would also equate superscripts, subscripts, fractions and
 *    styled mathematical letters with plain ones, which change meaning in a formula.
 * 2. Soft hyphen. U+00AD SOFT HYPHEN marks a possible hyphenation point and is invisible unless a line breaks there
 *    (The Unicode Standard, ch. 23; UAX #14 class BA); it is removed on both sides, with a line break directly after it.
 * 3. A word broken at a line end. In the source, a hyphen (U+002D HYPHEN-MINUS, UAX #14 class HY, or U+2010 HYPHEN) between
 *    two letters (General Category L), followed by optional spaces and a mandatory line break (UAX #14 classes BK, CR, LF,
 *    NL), may be read as v1 reads it (the hyphen and one space), as the hyphen with the break removed, or with both removed.
 * Nothing else changes: no case, word, digit, symbol or order change, no character dropped or added, and the quote must
 * still be one contiguous passage. A quote v1 accepts is accepted as it is.
 */
const PRESENTATION_FORM=/[\uFB00-\uFDFF\uFE10-\uFE1F\uFE30-\uFEFF\uFF00-\uFFEF]/gu;
const LINE_BREAK='\n\v\f\r\u0085\u2028\u2029';
const SOFT_HYPHEN=new RegExp('\u00AD(?:[^\\S'+LINE_BREAK+']*['+LINE_BREAK+']\\s*)?','gu');
const layoutCharacters=(text:string)=>text.replace(PRESENTATION_FORM,form=>form.normalize('NFKC')).replace(SOFT_HYPHEN,'');
const LINE_END_HYPHEN=new RegExp('(?<=\\p{L})[-\u2010][^\\S'+LINE_BREAK+']*['+LINE_BREAK+']\\s*(?=\\p{L})','u');
const v1Spacing=(text:string)=>text.replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\s+/gu,' ');
function layoutMatches(text:string,quote:string):boolean{
 const canonicalQuote=canonicalEvidence(layoutCharacters(quote));
 if(canonicalQuote.length===0)return false;
 // The source in pieces between line-end hyphens; `breaks` maps each joint's index in `joined` to the hyphen found there.
 const pieces:string[]=[],hyphens:string[]=[];
 let rest=layoutCharacters(text);
 for(let found=LINE_END_HYPHEN.exec(rest);found;found=LINE_END_HYPHEN.exec(rest)){
  pieces.push(v1Spacing(rest.slice(0,found.index)));hyphens.push(found[0][0]!);rest=rest.slice(found.index+found[0].length);
 }
 pieces.push(v1Spacing(rest));
 const joined=pieces.join('');
 const breaks=new Map<number,string>();
 for(let i=0,at=0;i<hyphens.length;i++){at+=pieces[i]!.length;breaks.set(at,hyphens[i]!);}
 // Matches the quote from index s of `joined` and index q of the quote. At a joint the quote may continue with the
 // hyphen, the hyphen and one space, or neither; `atBreak` marks that the joint at s was already read.
 const from=(s:number,q:number,atBreak:boolean):boolean=>{
  while(q<canonicalQuote.length){
   const hyphen=atBreak?undefined:breaks.get(s);
   if(hyphen!==undefined&&canonicalQuote[q]===hyphen){
    if(from(s,q+1,true))return true;
    if(canonicalQuote[q+1]===' '&&from(s,q+2,true))return true;
   }
   atBreak=false;
   if(joined[s]!==canonicalQuote[q])return false;
   s++;q++;
  }
  return true;
 };
 for(let s=0;s<joined.length;s++)if((joined[s]===canonicalQuote[0]||breaks.has(s))&&from(s,0,false))return true;
 return false;
}
export function evidenceMatches(text:string,quote:string,policy:ReaderEvidencePolicy):boolean{
 const selected=readerEvidencePolicy(policy);
 if(selected==='exact-substring-v1')return quote.length>0&&text.includes(quote);
 const canonicalQuote=canonicalEvidence(quote);
 const v1=canonicalQuote.length>0&&canonicalEvidence(text).includes(canonicalQuote);
 return selected==='layout-quotes-v2'?v1||layoutMatches(text,quote):v1;
}
