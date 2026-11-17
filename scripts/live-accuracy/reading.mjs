/** Read the semantic count, never the animated digit markup (which holds old and new values together). */
export function readingCount(snapshot,total){
  if(!Number.isSafeInteger(total)||total<1)throw new Error('The reading progress requires the exact positive batch size.');
  if(snapshot===null)return null; // The folder can still be scanning before the reading bar is mounted.
  const integer=v=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&Number.isSafeInteger(Number(v));
  if(!snapshot||!integer(snapshot.value)||!integer(snapshot.maximum)||Number(snapshot.maximum)!==total||Number(snapshot.value)>total)
    throw new Error('The reading progress is missing, malformed or outside this batch.');
  return Number(snapshot.value);
}
export async function readReadingCount(page,total){
  const snapshot=await page.evaluate(()=>{
    const bar=document.querySelector('[data-testid="files-read-bar"]');
    return bar===null?null:{value:bar.getAttribute('aria-valuenow'),maximum:bar.getAttribute('aria-valuemax')};
  });
  return readingCount(snapshot,total);
}
