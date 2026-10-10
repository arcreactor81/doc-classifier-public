// A small, seeded run of the storage chaos test (scripts/storage-chaos.mjs) inside the unit suite, so the end-to-end
// proof of DECISIONS 135 is re-checked on every change: 200 documents at a harsh fault rate (1 in 500 operations),
// faults that outlast the bound on 4 documents, 4 deaths inside a storage call, 3 runtime losses before a step (the
// lifecycle message and the runtime's internal error in turn) and 2 lost acknowledgements of the r07 shape (DECISIONS 144).
// On a run with spending limits a death inside a vendor stage stops the run by the money rule, so that variant injects no
// deaths. The 10,000-document runs are recorded in HANDOFF.md. Local and in-process only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./storage-chaos.mjs', import.meta.url));

for (const budget of ['unlimited', 'limited']) test(`storage chaos (${budget}, 200 documents, 1 in 500 operations): the run completes and every check holds`, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'storage-chaos-'));
  try {
    const out = path.join(dir, 'result.json');
    const run = spawnSync(process.execPath, [script, '--documents=200', '--rate=500', `--seed=${budget === 'limited' ? 7 : 6}`,
      '--persistent=4', budget === 'limited' ? '--hangs=0' : '--hangs=4', '--deferrals=3', '--lostAcks=2', '--concurrency=16', `--budget=${budget}`, `--out=${out}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, (run.stderr || '') + (run.stdout || '').slice(-4000));
    const result = JSON.parse(readFileSync(out, 'utf8'));
    for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name);
    assert.equal(result.run.status, 'complete');
    assert.ok(result.faults.injected >= 20, 'faults must actually be injected');
    assert.ok(result.setAside.length >= 1, 'faults past the bound must set documents aside');
    assert.equal(result.vendor.repeated, 0);
    assert.equal(result.faults.deferrals, 3); assert.equal(result.faults.lostAcks, 2);
    assert.ok(result.faults.runtimeInternal >= 1, 'the runtime internal error must be among the injected storage faults');
    assert.ok(result.outcomes.reentries >= 5, 'every engine failure before a step, and every lost acknowledgement followed by a broken step, is replayed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
