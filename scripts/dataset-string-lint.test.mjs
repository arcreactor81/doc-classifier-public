// Dataset-string lint (Scale §4 P0-4, §6 WP 0.6; AGENTS §4 "No client or test-document strings in code, prompts
// or UI text. Corpus filenames appear only under .local/").
//
// The denylist is private: .local/dataset-denylist.txt holds corpus filenames, run, reference and revision ids,
// category ids and similar strings, one per line, and is never committed. This test fails if any entry appears,
// case-insensitively, in the content or the path of any file outside .local/ (code, prompts, copy, fixtures, packs,
// configuration and documentation). Without the denylist the repository scan is skipped with a notice; the scanner's
// own self-test always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const DENYLIST='.local/dataset-denylist.txt';
/** A shorter entry would match ordinary text; it is refused rather than silently ignored. */
const MIN_ENTRY_LENGTH=6;
/** Never scanned, at any depth: private data, dependencies, generated output and Git internals. */
const SKIPPED_DIRECTORIES=new Set(['.local','node_modules','.git','dist','.wrangler','coverage','node-compile-cache']);
/**
 * Append-only records that quote history (AGENTS §8: append, never rewrite). Named one by one, never by pattern,
 * so a new file is always scanned. HANDOFF.md and DESIGN.md are the dated logs; the doc is a historical plan
 * that cites past run ids (SC0-A found them; redacting them is left to their owner). The public copy leaves out the
 * second historical plan (docs/reader-bakeoff-plan.md), so it is not exempted here either.
 */
const RECORD_FILES=new Set(['HANDOFF.md','DESIGN.md','docs/action-plan.md']);

/** Entries with their denylist line numbers. Blank lines and lines starting with # are ignored. */
function parseDenylist(text){
 const entries=new Map();
 text.replace(/^﻿/,'').split(/\r?\n/).forEach((raw,index)=>{
  const entry=raw.trim();if(!entry||entry.startsWith('#'))return;
  if(entry.length<MIN_ENTRY_LENGTH)throw new Error(`Denylist line ${index+1} is shorter than ${MIN_ENTRY_LENGTH} characters and would match ordinary text.`);
  const key=entry.toLowerCase();if(!entries.has(key))entries.set(key,index+1);
 });
 if(!entries.size)throw new Error('The denylist has no entries.');
 return entries;
}

function* files(root,directory=''){
 for(const item of readdirSync(join(root,directory),{withFileTypes:true})){
  const path=directory?directory+'/'+item.name:item.name;
  if(item.isDirectory()){if(!SKIPPED_DIRECTORIES.has(item.name))yield* files(root,path);}
  else if(item.isFile())yield path;
 }
}

const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/**
 * Every reading of a file's bytes that could hold an entry: UTF-16 when the file starts with a UTF-16 byte-order mark,
 * otherwise both UTF-8 and latin1. ASCII bytes read the same in UTF-8 and latin1, so binary files are scanned too; a
 * non-ASCII entry is found whether the file is UTF-8 or a single-byte encoding. No reading is ever skipped silently.
 */
function readings(bytes){
 if(bytes[0]===0xff&&bytes[1]===0xfe)return [bytes.subarray(2).toString('utf16le')];
 if(bytes[0]===0xfe&&bytes[1]===0xff){const body=Buffer.from(bytes.subarray(2,2+((bytes.length-2)&~1)));return [body.swap16().toString('utf16le')];}
 return [bytes.toString('utf8'),bytes.toString('latin1')];
}

/** Every occurrence outside the skipped directories and record files: {path, line, denylistLine}. */
function scan(root,entries,records=RECORD_FILES){
 const pattern=new RegExp([...entries.keys()].sort((a,b)=>b.length-a.length).map(escape).join('|'),'gi');
 const findings=[];
 for(const path of files(root)){
  if(records.has(path))continue;
  for(const match of path.matchAll(pattern))findings.push({path,line:0,denylistLine:entries.get(match[0].toLowerCase())});
  // One finding per line and entry, however many readings see it.
  const seen=new Set();
  for(const content of readings(readFileSync(join(root,path))))
   for(const match of content.matchAll(pattern)){
    const line=content.slice(0,match.index).split('\n').length,denylistLine=entries.get(match[0].toLowerCase());
    if(!seen.has(line+':'+denylistLine)){seen.add(line+':'+denylistLine);findings.push({path,line,denylistLine});}
   }
 }
 return findings;
}

// Findings name the file, line and denylist line, never the string itself, so test output does not repeat it.
const describe=findings=>findings.slice(0,25).map(f=>`${f.path}${f.line?':'+f.line:' (path)'} matches denylist line ${f.denylistLine}`).join('\n')+(findings.length>25?`\n… and ${findings.length-25} more`:'');

test('the scanner fails on a planted corpus string and skips only private data and named records',()=>{
 const root=mkdtempSync(join(tmpdir(),'dataset-lint-'));
 try{
  const planted='Planted-Corpus-Name-0042.pdf',plantedId='0000feed-planted-run-identity';
  const write=(path,text)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);};
  write('core/clean.ts','export const value = "placeholder";\n');
  write('core/leak.ts','// line one\nconst name = "'+planted.toUpperCase()+'";\n');
  write('ui/app/copy.json','{"hero":"Documents such as planted-corpus-name-0042.pdf"}');
  write('scripts/fixtures/'+plantedId+'.json','{}');
  write('projects/sample/binary.bin',Buffer.concat([Buffer.from([0,159,146,150]),Buffer.from(plantedId)]));
  write('.local/private.txt',planted);write('core/.local/nested.txt',planted);write('node_modules/pkg/index.js',planted);write('dist/app.js',planted);
  write('HANDOFF.md',planted);write('docs/HANDOFF.md',planted);
  const entries=parseDenylist(`# private\n\n${planted}\n${plantedId}\n${planted.toLowerCase()}\n`);
  assert.equal(entries.size,2,'duplicates collapse case-insensitively');
  const findings=scan(root,entries).map(({path,line,denylistLine})=>[path,line,denylistLine]).sort((a,b)=>a[0].localeCompare(b[0])||a[1]-b[1]);
  assert.deepEqual(findings,[
   ['core/leak.ts',2,3],
   ['docs/HANDOFF.md',1,3],
   ['projects/sample/binary.bin',1,4],
   ['scripts/fixtures/'+plantedId+'.json',0,4],
   ['ui/app/copy.json',1,3]
  ]);
  assert.match(describe(scan(root,entries)),/core\/leak\.ts:2 matches denylist line 3/);
  // Content findings are reported by position only; a path finding necessarily shows the offending path.
  assert.doesNotMatch(describe(scan(root,entries)),new RegExp(escape(planted),'i'),'a failure report never repeats a string found in content');
  assert.deepEqual(scan(root,entries,new Set()).map(f=>f.path).filter(path=>path==='HANDOFF.md'),['HANDOFF.md']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the scanner reads UTF-8, single-byte and UTF-16 text, so no encoding hides an entry',()=>{
 const root=mkdtempSync(join(tmpdir(),'dataset-lint-encoding-'));
 try{
  const accented='Planted-Accentué-Name-0043.docx',plain='planted-plain-name-0044.pptx';
  const write=(path,bytes)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),bytes);};
  write('docs/utf8.md',Buffer.from('first\nSee '+accented.toUpperCase()+'\n','utf8'));
  write('docs/latin1.txt',Buffer.from('x '+accented+'\n','latin1'));
  write('docs/utf16le.txt',Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('a\n'+plain,'utf16le')]));
  write('docs/utf16be.txt',Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from('a\nb\n'+plain,'utf16le').swap16()]));
  write('docs/twice.txt',Buffer.from(plain+' and '+plain+'\n','utf8'));
  const findings=scan(root,parseDenylist(accented+'\n'+plain+'\n')).map(({path,line,denylistLine})=>[path,line,denylistLine]).sort((a,b)=>a[0].localeCompare(b[0]));
  assert.deepEqual(findings,[
   ['docs/latin1.txt',1,1],
   ['docs/twice.txt',1,2],
   ['docs/utf16be.txt',3,2],
   ['docs/utf16le.txt',2,2],
   ['docs/utf8.md',2,1]
  ]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the denylist refuses entries too short to be specific and an empty list',()=>{
 assert.throws(()=>parseDenylist('# comment\nabc\n'),/line 2 is shorter than 6/);
 assert.throws(()=>parseDenylist('# only comments\n\n'),/no entries/);
 assert.deepEqual([...parseDenylist('﻿example-entry\r\n  spaced-entry  \n')],[['example-entry',1],['spaced-entry',2]]);
});

test('every exempt record file exists, so the exemption cannot silently widen',()=>{
 for(const path of RECORD_FILES)assert.ok(existsSync(join(ROOT,path)),path);
});

const denylistPath=join(ROOT,DENYLIST);
test('no dataset string appears outside .local/',{skip:existsSync(denylistPath)?false:`Notice: ${DENYLIST} is absent on this machine, so the repository scan is skipped. It is private and never committed; the scanner self-test above still ran.`},()=>{
 const findings=scan(ROOT,parseDenylist(readFileSync(denylistPath,'utf8')));
 assert.equal(findings.length,0,'Dataset strings found outside .local/:\n'+describe(findings));
});
