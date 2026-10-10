import type { DigestInput } from '../digest/digest.ts';
import { ServerFailure } from './errors.ts';
import { UPLOAD_BODY_LIMIT_BYTES } from '../domain/upload-limit.ts';
export interface Upload {
 fingerprint:string;originalFilename:string;fullText:string;outline:DigestInput;
 extractorVersion:string;parserVersions:Record<string,string>;needsOutlineRecovery:boolean;
 tokenCounts:{readerInputTokens:number|null;confidenceInputTokens:number|null;recoveryInputTokens:number|null};
 tokenizerIds:{reader:string|null;confidence:string|null};
 /**
  * Document-level extraction notes (extractor 1.1.0 and later): content the reader could not fully read. Optional so
  * that earlier extractor versions still upload; stored as the document's notes, which the decision rules read. A
  * document with content unread goes to a person (owner decision, 29 September 2026), with one exception: a file
  * attached to a PDF (N_PDF_ATTACHMENT_UNREAD, extractor 1.2.1) is not the document's content and is informational
  * under note policy full-state-structural-info-v4 (owner decision, 1 October 2026); frozen policies keep it as review.
  */
 notes?:string[];
}
export const EXTRACTION_NOTES=['N_EXTRACTION_EMBEDDED_UNREAD','N_PAGES_WITHOUT_TEXT','N_FONT_TEXT_UNREADABLE','N_MATH_STRUCTURE_UNREAD','N_PDF_ATTACHMENT_UNREAD'] as const;
export const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function requireValue(condition:unknown, detail:string):asserts condition {if(!condition)throw new ServerFailure('E_REQUEST','request',detail);}
export function exact(v:Record<string,unknown>, keys:string[]):void {requireValue(Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Missing or unexpected request fields.');}
/** Every required key present, optional keys may be absent, and nothing else is accepted. */
export function exactWithOptional(v:Record<string,unknown>, required:string[], optional:string[]):void {requireValue(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),'Missing or unexpected request fields.');}
const string=(v:unknown):v is string=>typeof v==='string';
const position=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
/**
 * The longest file name accepted (independent review F2): 255 UTF-16 code units, as JavaScript counts a string and as
 * NTFS limits a name. Every name a common file system allows fits (ext4 and APFS allow 255 bytes, never more units).
 */
export const MAX_FILENAME_LENGTH=255;
export function identity(value:Record<string,unknown>):void {
 requireValue(string(value.fingerprint)&&/^[a-f0-9]{64}$/.test(value.fingerprint),'A full SHA-256 fingerprint is required.');
 requireValue(string(value.originalFilename)&&value.originalFilename.length>0&&!/[\/\\\u0000]/.test(value.originalFilename),'A filename without a path is required.');
 requireValue(value.originalFilename.length<=MAX_FILENAME_LENGTH,`A filename can have at most ${MAX_FILENAME_LENGTH} characters. Rename the file, then choose it again.`);
}
export function parseUpload(raw:unknown):Upload {
 requireValue(object(raw),'A JSON document object is required.');
 exactWithOptional(raw,['fingerprint','originalFilename','fullText','outline','extractorVersion','parserVersions','needsOutlineRecovery','tokenCounts','tokenizerIds'],['notes']);identity(raw);
 requireValue(raw.notes===undefined||Array.isArray(raw.notes)&&raw.notes.every(note=>(EXTRACTION_NOTES as readonly string[]).includes(note as string))&&new Set(raw.notes).size===raw.notes.length,'Extraction notes must be known codes, each at most once.');
 requireValue(string(raw.fullText)&&raw.fullText.length>0,'Extracted text is required.');
 requireValue(string(raw.extractorVersion)&&raw.extractorVersion.length>0,'Extractor version is required.');
 requireValue(object(raw.parserVersions)&&Object.values(raw.parserVersions).every(v=>string(v)&&v.length>0),'Parser versions are required.');
 requireValue(typeof raw.needsOutlineRecovery==='boolean','Outline recovery need must be explicit.');
 requireValue(object(raw.tokenCounts),'Token counts are required.');exact(raw.tokenCounts,['readerInputTokens','confidenceInputTokens','recoveryInputTokens']);
 requireValue(Object.values(raw.tokenCounts).every(v=>v===null||position(v)),'Token counts must be nonnegative integers or explicit null when unknown.');
 requireValue(object(raw.tokenizerIds),'Tokenizer IDs are required.');exact(raw.tokenizerIds,['reader','confidence']);requireValue(Object.values(raw.tokenizerIds).every(v=>v===null||string(v)&&v.length>0),'Tokenizer identities must be strings or explicit null when no local counter is used.');
 requireValue(object(raw.outline),'Outline is required.');
 requireValue(Object.keys(raw.outline).every(k=>['title','headings','tables','blocks'].includes(k)),'Unexpected outline field.');
 const outline=raw.outline;
 requireValue(outline.title===undefined||string(outline.title),'Outline title must be text.');
 requireValue(Array.isArray(outline.headings)&&Array.isArray(outline.tables)&&Array.isArray(outline.blocks),'Outline arrays are required.');
 const ids=new Set<string>();
 for(const heading of outline.headings){requireValue(object(heading),'Invalid heading.');exact(heading,['id','text','level','position']);requireValue(string(heading.id)&&!ids.has(heading.id)&&string(heading.text)&&Number.isSafeInteger(heading.level)&&Number(heading.level)>0&&position(heading.position),'Invalid heading.');ids.add(heading.id);}
 for(const table of outline.tables){requireValue(object(table),'Invalid table.');exact(table,['position','headers']);requireValue(position(table.position)&&Array.isArray(table.headers)&&table.headers.every(string),'Invalid table.');}
 for(const block of outline.blocks){requireValue(object(block),'Invalid block.');requireValue(Object.keys(block).every(k=>['position','text','headingId'].includes(k))&&position(block.position)&&string(block.text)&&(block.headingId===undefined||string(block.headingId)&&ids.has(block.headingId)),'Invalid text block.');}
 return raw as unknown as Upload;
}
export function validateManifestReady(status:string,expected:number,completed:number):void {
 if(!['complete','closed'].includes(status)||expected!==completed)throw new ServerFailure('E_MANIFEST_INCOMPLETE','request','Every document must have an outcome before a manifest is produced.',409);
}
/** Bounded parsing prevents an untrusted body from exhausting the Worker isolate. No truncation. */
export async function jsonBody(request:Request):Promise<unknown>{
 requireValue(request.headers.get('content-type')?.split(';')[0]==='application/json','Only JSON text and outline requests are accepted.');
 requireValue(request.body,'A request body is required.');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>UPLOAD_BODY_LIMIT_BYTES){await reader.cancel();throw new ServerFailure('E_REQUEST_MEMORY','request','The JSON request exceeds the Worker memory-safe upload envelope.',413);}chunks.push(part.value);}
 const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(joined));}catch{throw new ServerFailure('E_REQUEST_JSON','request','The request is not valid JSON.');}
}

/**
 * An optional JSON body (S3). A missing or empty body reads as `undefined`. A body that is not UTF-8 JSON, or that
 * is sent without the JSON content type, reads as `null`, so the caller refuses it with its own error. It never
 * throws for a missing body; like `jsonBody` it refuses a body beyond the memory-safe envelope.
 */
export async function readOptionalJson(request: Request): Promise<unknown> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > UPLOAD_BODY_LIMIT_BYTES) {
      await reader.cancel();
      throw new ServerFailure('E_REQUEST_MEMORY', 'request',
        'The JSON request exceeds the Worker memory-safe upload envelope.', 413);
    }
    chunks.push(part.value);
  }
  if (size === 0) return undefined;
  // Only an explicitly JSON request counts, as for every other state-changing route (see jsonBody).
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return null;
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined));
  } catch {
    return null;
  }
}