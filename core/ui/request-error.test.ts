import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestFailure, errorPresentation, UiRequestError } from './request-error.ts';
import { uiCopy } from './copy.ts';
test('known API failure preserves exact headline action code and raw technical context',()=>{
 const raw=JSON.stringify({error:{code:'E_RUN_STOPPED',kind:'blocker',headline:'The run stopped.',action:'Review this run before continuing.',details:{runId:'run1',vendor:'reader',requestId:'req1'}},extra:'retained'});
 const failure=parseRequestFailure(409,raw);assert.ok(failure instanceof UiRequestError);assert.equal(failure.code,'E_RUN_STOPPED');assert.equal(failure.headline,'The run stopped.');assert.equal(failure.action,'Review this run before continuing.');assert.equal(failure.rawResponse,raw);assert.deepEqual(failure.details,{runId:'run1',vendor:'reader',requestId:'req1'});
 const view=errorPresentation(failure);assert.equal(view.headline,failure.headline);assert.equal(view.action,failure.action);assert.equal(view.technical.rawResponse,raw);assert.equal(view.technical.status,409);
});
test('malformed or unknown failures remain explicit without inventing error metadata',()=>{
 for(const raw of ['<html>Proxy failure</html>','',JSON.stringify({error:{code:3,headline:'Bad',action:'Do something'}}),JSON.stringify({error:{code:'E',headline:'',action:'Help'}}),JSON.stringify({message:'unknown'})]){
  const failure=parseRequestFailure(502,raw);assert.equal(failure.code,undefined);assert.equal(failure.headline,uiCopy.unrecognizedApiError);assert.equal(failure.action,uiCopy.errorAction);assert.equal(failure.details,undefined);assert.equal(failure.rawResponse,raw);
 }
});
test('server text is not rewritten and absent details are not fabricated',()=>{
 const failure=parseRequestFailure(400,JSON.stringify({error:{code:'E_INPUT',headline:'<b>Input</b>',action:'  Read the original.  '}}));assert.equal(failure.headline,'<b>Input</b>');assert.equal(failure.action,'  Read the original.  ');assert.equal(failure.details,undefined);assert.equal(Object.hasOwn(errorPresentation(failure).technical,'details'),false);
});
test('ordinary local errors retain their technical message with honest generic recovery text',()=>{
 const local=Object.assign(new Error('Local extraction failed.'),{code:'E_EXTRACTION'});const view=errorPresentation(local);assert.equal(view.headline,uiCopy.error);assert.equal(view.action,uiCopy.errorAction);assert.equal(view.technical.message,local.message);assert.equal(view.technical.code,'E_EXTRACTION');
});
