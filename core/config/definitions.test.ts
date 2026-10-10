import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appliedThresholdStatus,capsExempt,definitionChange,definitionThreshold,editorAllowed,editorListIssue,trustedAllowed,trustedListIssue,validateDisplayNames,type ThresholdStatus} from './definitions.ts';
const types={types:[{id:'example',name:'Example',what:'A kind',not_for:'Other kinds',examples:['Example structure']}],none_of_these:{name:'None',what:'Not these'}};
test('only display names are cosmetic; model-facing names and examples are semantic',()=>{assert.equal(definitionChange(types,structuredClone(types)),'cosmetic');const next=structuredClone(types);next.types[0].name='Another';assert.equal(definitionChange(types,next),'semantic');assert.equal(definitionChange(null,types),'initial');});
test('semantic calibration resets unless explicitly inherited; cosmetic preserves',()=>{assert.deepEqual(definitionThreshold('semantic',{threshold:.95,status:'calibrated'},false),{threshold:.9,status:'untested'});assert.deepEqual(definitionThreshold('semantic',{threshold:.95,status:'calibrated'},true),{threshold:.95,status:'unverified'});assert.deepEqual(definitionThreshold('cosmetic',{threshold:.95,status:'calibrated'},false),{threshold:.95,status:'calibrated'});assert.deepEqual(definitionThreshold('initial',null,true),{threshold:.9,status:'untested'});});
test('only owner configured actor IDs authorize editors; empty and malformed lists fail closed',()=>{assert.equal(editorAllowed('["actor"]','actor'),true);assert.equal(editorAllowed('[]','actor'),false);assert.equal(editorAllowed('invalid','actor'),false);assert.equal(editorAllowed('["actor",7]','actor'),false);});
// DECISIONS 150 (owner, 9 October 2026): the trusted-users list is written as the editor list is, and read by the same code.
const LIST_VALUES=[undefined,'','[]','["actor"]','["other"]','["other","actor"]','invalid','"actor"','{"actor":"actor"}','[""]','["actor",""]','["actor",7]','["actor",null]','["actor@example.invalid"]','["actor","person@example.invalid"]'] as const;
test('trustedAllowed and editorAllowed agree on every format rule: only a listed Access user id, and a malformed list names nobody',()=>{
 for(const raw of LIST_VALUES)assert.equal(trustedAllowed(raw,'actor'),editorAllowed(raw,'actor'),String(raw));
 assert.equal(trustedAllowed('["actor"]','actor'),true);assert.equal(trustedAllowed('["other","actor"]','actor'),true);
 assert.equal(trustedAllowed(undefined,'actor'),false,'an absent list names nobody');assert.equal(trustedAllowed('[]','actor'),false);
 assert.equal(trustedAllowed('["other"]','actor'),false);assert.equal(trustedAllowed('invalid','actor'),false);assert.equal(trustedAllowed('["actor",7]','actor'),false);
});
test('the two lists share one format check: the editor list must name someone, the trusted list may be absent or empty but never malformed',()=>{
 const expected:Record<string,[ReturnType<typeof editorListIssue>,ReturnType<typeof trustedListIssue>]>={
  undefined:['missing',null],'':['missing','unreadable'],'[]':['missing',null],'["actor"]':[null,null],'["other"]':[null,null],'["other","actor"]':[null,null],
  invalid:['missing','unreadable'],'"actor"':['missing','unreadable'],'{"actor":"actor"}':['missing','unreadable'],'[""]':['missing','unreadable'],
  '["actor",""]':['missing','unreadable'],'["actor",7]':['missing','unreadable'],'["actor",null]':['missing','unreadable'],
  '["actor@example.invalid"]':['email','email'],'["actor","person@example.invalid"]':['email','email']
 };
 for(const raw of LIST_VALUES)assert.deepEqual([editorListIssue(raw),trustedListIssue(raw)],expected[String(raw)],String(raw));
});
test('exempt from the per-person caps: a listed editor or a listed trusted user, nobody else, and a malformed list exempts nobody',()=>{
 assert.equal(capsExempt('["editor"]',undefined,'editor'),true);
 assert.equal(capsExempt('["editor"]','["trusted"]','trusted'),true);
 assert.equal(capsExempt('["editor"]','["trusted"]','editor'),true);
 assert.equal(capsExempt('["editor"]','["trusted"]','visitor'),false);
 assert.equal(capsExempt('["editor"]',undefined,'visitor'),false);
 assert.equal(capsExempt('["editor"]','["trusted",7]','trusted'),false);
 assert.equal(capsExempt('["editor"]','trusted','trusted'),false);
});
test('one correction makes a threshold provisional; only a different correction applying the same value calibrates it',()=>{
 const at=(threshold:number,status:ThresholdStatus,justification:string)=>({threshold,status,justification});
 assert.equal(appliedThresholdStatus(at(.9,'untested','initial_design_threshold'),{threshold:.96,correctionId:'a'}),'provisional');
 assert.equal(appliedThresholdStatus(at(.96,'provisional','a'),{threshold:.96,correctionId:'a'}),'provisional');
 assert.equal(appliedThresholdStatus(at(.96,'provisional','a'),{threshold:.96,correctionId:'b'}),'calibrated');
 assert.equal(appliedThresholdStatus(at(.96,'provisional','a'),{threshold:.95,correctionId:'b'}),'provisional');
 assert.equal(appliedThresholdStatus(at(.96,'calibrated','b'),{threshold:.96,correctionId:'c'}),'calibrated');
 assert.equal(appliedThresholdStatus(at(.96,'calibrated','b'),{threshold:.94,correctionId:'c'}),'provisional');
 assert.equal(appliedThresholdStatus(at(.96,'unverified','inherited'),{threshold:.96,correctionId:'c'}),'provisional');
});
test('display labels must refer to real type IDs and cannot be blank',()=>{assert.doesNotThrow(()=>validateDisplayNames({example:'Visible title'},types));assert.throws(()=>validateDisplayNames({unknown:'Label'},types));assert.throws(()=>validateDisplayNames({example:''},types));});
