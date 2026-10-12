import test from 'node:test';
import assert from 'node:assert/strict';
import {CorrectionValidationError,type CorrectionValidationCode} from '../correction/diff.ts';
import * as errors from './errors.ts';

test('correction listing errors are actionable request failures, not internal blockers',()=>{
 const codes:CorrectionValidationCode[]=['E_CORRECTION_PATH','E_CORRECTION_ROOT_FOLDER','E_CORRECTION_DUPLICATE_PATH','E_CORRECTION_AMBIGUOUS_IDENTITY'];
 for(const code of codes){const issue=errors.failure(new CorrectionValidationError(code,'Rejected listing.'));assert.equal(issue.code,code);assert.equal(issue.kind,'request');assert.equal(issue.status,400);const body=errors.failureResponse(issue);assert.ok(body.error.headline);assert.ok(body.error.action);assert.notEqual(body.error.action,errors.serverCopy.action);assert.equal(body.error.details.message,'Rejected listing.');}
});
test('corrupt saved manifest identities stay blocking rather than blaming folder selection',()=>{
 const issue=errors.failure(new CorrectionValidationError('E_CORRECTION_MANIFEST_IDENTITY','Saved identities conflict.'));assert.equal(issue.code,'E_CORRECTION_MANIFEST_IDENTITY');assert.equal(issue.kind,'blocker');assert.equal(issue.status,409);assert.match(errors.failureResponse(issue).error.action,/technical contact/);
});
test('unexpected errors remain internal and never disclose exception contents',()=>{
 const issue=errors.failure(new Error('private sentinel exception'));const body=errors.failureResponse(issue);assert.equal(issue.code,'E_INTERNAL');assert.equal(issue.status,500);assert.ok(!JSON.stringify(body).includes('private sentinel'));assert.equal(body.error.action,errors.serverCopy.action);
});
