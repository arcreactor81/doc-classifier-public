import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalRun } from './preflight.ts';
import { parseUpload } from '../server/contracts.ts';
import { UPLOAD_BODY_LIMIT_BYTES } from '../domain/upload-limit.ts';
import { uiCopy } from '../ui/copy.ts';
import type { ProjectPack } from '../config/project.ts';
import type { LocalDocument } from './state.ts';
const pack={settings:{confidenceStatePolicy:'untrimmed-structured-state-v2'},structuralVocabulary:[],budget:null} as unknown as ProjectPack;
const local={runId:'local',sourcePath:'one.docx',fingerprint:'a'.repeat(64),state:'extracted',document:{fingerprint:'a'.repeat(64),originalFilename:'one.docx',fullText:'A heading\nBody',outline:{title:'A heading',headings:[],tables:[],blocks:[{position:0,text:'A heading\nBody'}]},extractorVersion:'test',parserVersions:{zip:'test',xml:'test',pdf:'test'},needsOutlineRecovery:false,notes:[]}} as LocalDocument;
test('preparation requires no local token codec and represents unknown billing counts explicitly',()=>{
 const [result]=prepareLocalRun([local],pack);
 assert.deepEqual(result.quote.tokenCounts,{readerInputTokens:null,confidenceInputTokens:null,recoveryInputTokens:null});
 assert.equal(parseUpload(result.upload).tokenizerIds.reader,null);
});
test('outline recovery is no longer blocked by an unavailable cost prediction',()=>{
 const recovery={...local,document:{...('document' in local?local.document:{}),needsOutlineRecovery:true}} as LocalDocument;
 assert.equal(prepareLocalRun([recovery],pack)[0].quote.needsOutlineRecovery,true);
});
test('invalid token claims are rejected without requiring a local tokenizer',()=>{
 const result=prepareLocalRun([local],pack)[0];
 for(const value of [-1,1.5,'unknown',undefined])assert.throws(()=>parseUpload({...result.upload,tokenCounts:{readerInputTokens:value,confidenceInputTokens:null,recoveryInputTokens:null}}));
});

test('failed documents remain explicit zero-call entries without uploaded text',()=>{
 const failed:LocalDocument={runId:'local',sourcePath:'one.bin',fingerprint:'b'.repeat(64),state:'could_not_process',failure:{code:'E_UNSUPPORTED_FORMAT',message:'Unsupported file type.'}};
 const [result]=prepareLocalRun([failed],pack);assert.equal(result.quote.failed,true);assert.deepEqual(result.quote.tokenCounts,{readerInputTokens:0,confidenceInputTokens:0,recoveryInputTokens:0});assert.equal('fullText' in result.upload,false);
});
const withText=(fingerprint:string,fullText:string,blockText=fullText)=>({...local,sourcePath:'large.docx',fingerprint,document:{...('document' in local?local.document:{}),fingerprint,originalFilename:'large.docx',fullText,outline:{title:'A heading',headings:[],tables:[],blocks:[{position:0,text:blockText}]}}}) as LocalDocument;
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const tooLarge=(fingerprint:string)=>({fingerprint,originalFilename:'large.docx',failure:{code:'E_UPLOAD_TOO_LARGE',message:uiCopy.errors.local.tooLargeToSend}});
test('a read document whose upload the service would refuse as too large is listed as could not process, counted in UTF-8 bytes',()=>{
 const text=String.fromCharCode(0xe9).repeat(9*1024*1024),large=withText('c'.repeat(64),text);
 assert.ok(JSON.stringify(large).length<UPLOAD_BODY_LIMIT_BYTES,'under the limit in characters, over it in bytes');
 const [result,normal]=prepareLocalRun([large,local],pack);
 assert.equal(result.local,large);
 assert.deepEqual(result.quote,{fingerprint:'c'.repeat(64),originalFilename:'large.docx',tokenCounts:{readerInputTokens:0,confidenceInputTokens:0,recoveryInputTokens:0},needsOutlineRecovery:false,failed:true});
 assert.deepEqual(result.upload,tooLarge('c'.repeat(64)));
 assert.deepEqual(prepareLocalRun([large],pack),[result],'the same answer at Confirm and again at send');
 assert.equal(normal.quote.failed,false);
 assert.deepEqual(normal.upload,{...('document' in local?local.document:{}),tokenCounts:{readerInputTokens:null,confidenceInputTokens:null,recoveryInputTokens:null},tokenizerIds:{reader:null,confidence:null}});
});
test('an upload exactly at the service limit is sent; one byte more is not',()=>{
 const base='A heading\nBody',probe=bytes(prepareLocalRun([withText('d'.repeat(64),base)],pack)[0].upload);
 const [kept]=prepareLocalRun([withText('d'.repeat(64),base+'x'.repeat(UPLOAD_BODY_LIMIT_BYTES-probe),base)],pack);
 assert.equal(bytes(kept.upload),UPLOAD_BODY_LIMIT_BYTES);assert.equal(kept.quote.failed,false);assert.equal(parseUpload(kept.upload).fullText.length,base.length+UPLOAD_BODY_LIMIT_BYTES-probe);
 const [refused]=prepareLocalRun([withText('d'.repeat(64),base+'x'.repeat(UPLOAD_BODY_LIMIT_BYTES-probe+1),base)],pack);
 assert.equal(refused.quote.failed,true);assert.deepEqual(refused.upload,tooLarge('d'.repeat(64)));
});
test('unfinished extraction and duplicate content cannot silently shrink the run',()=>{
 assert.throws(()=>prepareLocalRun([{runId:'local',sourcePath:'one',fingerprint:'a'.repeat(64),state:'not started'}],pack),/extraction/i);
 assert.throws(()=>prepareLocalRun([local,{...local,sourcePath:'other'}],pack),/duplicate/i);
});
