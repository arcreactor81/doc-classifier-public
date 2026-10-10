/**
 * Migration 0032: the per-person daily counts of price checks, saved reviews and saved labels (independent review F2/F3)
 * read their person's rows for one UTC day through an index, not the whole table, so a busy public site does not pay
 * for a full scan on every save.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migratedDatabase } from './testing/local-bindings.ts';
import { dailyRecordPredicate, type DailyRecordKind } from './daily-allowance.ts';

const INDEX: Readonly<Record<DailyRecordKind, string>> = {
  quote: 'quotes_actor_created',
  correction: 'corrections_actor_created',
  reference: 'feedback_references_confirmed_by_created'
};

test('each daily record count searches its own index rather than scanning the table', () => {
  const db = migratedDatabase();
  try {
    const limits = { maxRunsPerActorPerDay: 3 } as Parameters<typeof dailyRecordPredicate>[1];
    for (const kind of Object.keys(INDEX) as DailyRecordKind[]) {
      const predicate = dailyRecordPredicate(kind, limits, { actor: 'person', capsExempt: false, at: '2026-10-07T12:00:00.000Z' });
      const details = db.prepare('EXPLAIN QUERY PLAN SELECT 1 WHERE ' + predicate.sql).all(...predicate.params).map(row => String(row.detail));
      assert.ok(details.some(detail => detail.includes(`USING COVERING INDEX ${INDEX[kind]}`) || detail.includes(`USING INDEX ${INDEX[kind]}`)), kind + ': ' + details.join(' | '));
      assert.ok(!details.some(detail => /^SCAN c/.test(detail)), kind + ': ' + details.join(' | '));
    }
  } finally { db.close(); }
});
