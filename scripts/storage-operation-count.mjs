// Counts every D1 and R2 operation the production Workflow path performs per document, in-process (node:sqlite with
// the committed migrations, an in-memory R2, pretend vendors), plus what one poll of the run status reads.
// Usage: node scripts/storage-operation-count.mjs [documents=50] [--json]
// Nothing here contacts a network or a hosted service.
import { workflowHarness } from '../core/server/testing/workflow-harness.ts';

const count = Number(process.argv.slice(2).find(value => /^\d+$/.test(value)) ?? 50);
const json = process.argv.includes('--json');
if (!Number.isSafeInteger(count) || count < 1) throw new Error('documents must be a positive integer');

const h = await workflowHarness();
await h.addDocuments(count);
const upload = h.take();
for (const fingerprint of h.fingerprints) await h.invoke(fingerprint);
const workflow = h.take();
const run = h.db.prepare('SELECT status FROM runs WHERE id=?').get(h.runId);
if (run.status !== 'complete') throw new Error(`The run did not complete: ${run.status}`);
await h.status();
const poll = h.take();
const rows = Object.fromEntries(['events', 'checkpoints', 'artifacts', 'vendor_calls', 'vendor_circuit_outcomes']
  .map(table => [table, Number(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(h.runId).n)]));

const perDocument = stats => ({
  d1Reads: stats.d1Reads / count, d1Writes: stats.d1Writes / count, d1Batches: stats.d1Batches / count,
  d1RoundTrips: (stats.d1Reads + stats.d1Writes + stats.d1Batches) / count,
  r2Gets: stats.r2Gets / count, r2Heads: stats.r2Heads / count, r2Puts: stats.r2Puts / count, r2Deletes: stats.r2Deletes / count,
  storageRoundTrips: (stats.d1Reads + stats.d1Writes + stats.d1Batches + stats.r2Gets + stats.r2Heads + stats.r2Puts + stats.r2Deletes) / count
});
const labels = stats => [...stats.byLabel.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, perDocument: n / count }));
const result = {
  documents: count,
  workflowPerDocument: perDocument(workflow), workflowByLabel: labels(workflow),
  uploadPerDocument: perDocument(upload),
  rowsPerDocument: Object.fromEntries(Object.entries(rows).map(([table, n]) => [table, n / count])),
  statusPoll: { d1Statements: poll.d1Reads + poll.d1Writes, d1RowsReturned: poll.d1RowsReturned, rowsReturnedPerDocument: poll.d1RowsReturned / count,
    byLabel: [...poll.byLabel.entries()].map(([label, n]) => ({ label, n })) }
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  const fixed = value => Number.isInteger(value) ? String(value) : value.toFixed(2);
  console.log(`Workflow path, per document (${count} documents, pretend vendors, no faults):`);
  for (const [key, value] of Object.entries(result.workflowPerDocument)) console.log(`  ${key.padEnd(18)} ${fixed(value)}`);
  console.log('By operation (per document):');
  for (const { label, perDocument: value } of result.workflowByLabel) console.log(`  ${fixed(value).padStart(6)}  ${label}`);
  console.log('Rows written per document:', Object.entries(result.rowsPerDocument).map(([t, v]) => `${t}=${fixed(v)}`).join(' '));
  console.log(`One status poll: ${result.statusPoll.d1Statements} D1 statements, ${result.statusPoll.d1RowsReturned} rows returned (${fixed(result.statusPoll.rowsReturnedPerDocument)} per document)`);
  for (const { label, n } of result.statusPoll.byLabel) console.log(`  ${String(n).padStart(4)}  ${label}`);
}
