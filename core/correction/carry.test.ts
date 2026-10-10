import test from 'node:test';
import assert from 'node:assert/strict';
import { carryTrialChecks } from './carry.ts';
import { diffCorrection, type CorrectionManifestEntry } from './diff.ts';
import { proposeCorrections } from './proposals.ts';

const types = ['type_a', 'type_b'];
const entry = (index: number, folder = types[0], rule = 'R1'): CorrectionManifestEntry => ({
  fingerprint: index.toString(16).padStart(64, '0'), tag: `r1-${index}`, originalFilename: `${index}.pdf`, destinationFolder: folder, rule
});
const listing = (item: CorrectionManifestEntry, folder = item.destinationFolder) => ({ folder, filename: `${item.tag} ${item.originalFilename}`, tag: item.tag });
const verdict = (item: CorrectionManifestEntry, folder: string, verdict: 'right' | 'wrong' | null = 'right') =>
  ({ fingerprint: item.fingerprint, destinationFolder: folder, verdict });

// The full run: 1–4 filed in type_a, 5 filed in type_b, 6 for review. The person ticked nothing and moved 2 to type_b.
const manifest = [entry(1), entry(2), entry(3), entry(4), entry(5, types[1]), entry(6, 'human_review', 'R2')];
const files = [listing(manifest[0]), listing(manifest[1], types[1]), listing(manifest[2]), listing(manifest[3]), listing(manifest[4]), listing(manifest[5])];
const diff = () => diffCorrection({ manifest, files, checkedFolders: [], typeFolders: types, sidecarPaths: [] });
const evidence = Object.fromEntries(manifest.map(item => [item.tag, { certainty: 0.95, agreedType: null, title: item.originalFilename, digestLines: [] }]));
const propose = (d: ReturnType<typeof diff>) => proposeCorrections({ correctionId: 'c', currentThreshold: 0.9, minimumFiledCount: 3, diff: d, evidence, types: types.map(id => ({ id, name: id })), folderDecisions: [], renderNotFor: () => '' });

test('a trial check in the same place is carried as a confirmation; elsewhere, wrong, unchecked or moved ones are not', () => {
  const before = diff();
  assert.equal(before.confirmations.length, 0);
  const result = carryTrialChecks(before, manifest, [
    verdict(manifest[0], types[0]),            // same place: carried
    verdict(manifest[1], types[0]),            // the person moved it: a move, not carried
    verdict(manifest[2], types[1]),            // the trial filed it elsewhere: not carried
    verdict(manifest[3], types[0], 'wrong'),   // marked wrong in the trial: not a confirmation
    verdict(manifest[4], types[1], null),      // never checked in the trial
    verdict(manifest[5], types[0])             // came to the person this time (R2): not carried
  ]);
  assert.deepEqual(result.carried, ['r1-1']);
  assert.deepEqual(result.diff.confirmations.map(match => match.entry.tag), ['r1-1']);
  assert.deepEqual(result.diff.unchecked.map(match => match.entry.tag), ['r1-3', 'r1-4', 'r1-5', 'r1-6']);
  assert.deepEqual(result.diff.moves.map(match => match.entry.tag), ['r1-2'], 'moves are untouched');
  assert.equal(before.unchecked.length, 5, 'the input is not changed');
});

test('each document counts once: a carried check is one confirmation, and the filed check sees it with the moves', () => {
  const carried = carryTrialChecks(diff(), manifest, [verdict(manifest[0], types[0]), verdict(manifest[0], types[0])]);
  assert.deepEqual(carried.carried, ['r1-1'], 'the same verdict twice is one document');
  // 1 carried (correct) and 2 moved (wrong): the filed check counts two, the minimum of three is not reached.
  assert.deepEqual(propose(carried.diff).filedCheck, { checked: 2, wrong: 1, correct: 1, status: 'insufficient_sample' });
  assert.deepEqual(propose(diff()).filedCheck, { checked: 1, wrong: 1, correct: 0, status: 'insufficient_sample' }, 'without the carry only the move counts');
  const none = carryTrialChecks(diff(), manifest, []);
  assert.deepEqual(none.carried, []);
  assert.equal(none.diff, diff().confirmations.length === 0 ? none.diff : none.diff, 'no verdicts: the comparison is returned as it is');
});
