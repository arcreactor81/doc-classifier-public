// Test-only: the production DocumentWorkflow, Runner, Store and every persistence helper run in-process against
// node:sqlite (the committed migrations) and an in-memory R2. Every storage operation is counted, and a caller may
// inject faults per operation. Only the platform classes (WorkflowEntrypoint, NonRetryableError), the Workflow step
// engine and the vendor transport are local seams. Never imported by the Worker.
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { migratedDatabase } from './local-bindings.ts';
import { Store } from '../store.ts';
import { authorizeRunBudget, type RunBudget } from '../../cost/run-budget.ts';
import { workflowInstanceId } from '../workflow-identity.ts';
import { readRunStatusInput } from '../run-status-read.ts';
import { runStatusResponse } from '../../domain/run-status.ts';
import { syntheticPack } from '../../../scripts/fixtures/synthetic-pack.mjs';
import { installOutbound } from '../../vendors/outbound.ts';
import { createFakeVendorFetch } from '../../vendors/fake-vendors.ts';
import { RUNTIME_WAIT_MS } from '../runtime-interruption.ts';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return ['cloudflare:workers', 'cloudflare:workflows'].includes(specifier)
      ? { url: specifier, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cloudflare:workers') return { format: 'module', shortCircuit: true,
      source: 'export class WorkflowEntrypoint { constructor(_ctx, env) { this.env = env; } }' };
    if (url === 'cloudflare:workflows') return { format: 'module', shortCircuit: true,
      source: 'export class NonRetryableError extends Error { constructor(message, code) { super(message); this.code = code; } }' };
    return next(url, context);
  }
});
const { DocumentWorkflow } = await import('../workflow.ts');
hooks.deregister();
export { DocumentWorkflow };

// Pretend vendors only; any other outbound request is a defect in a storage test.
globalThis.fetch = async () => { throw new Error('External requests are forbidden in the in-process Workflow harness.'); };
/** The pretend vendor the installed outbound seam answers with; a harness may replace it with a rate-limiting one. */
let fakeVendor = createFakeVendorFetch();
/** Every vendor request the harness answered, keyed by document fingerprint and role. */
export const vendorRequests = { total: 0, byDocumentRole: new Map<string, number>(), markers: new Map<string, string>() };
installOutbound(async (url, init, context) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  const label = /Synthetic document \d+\./.exec(body)?.[0];
  const fingerprint = label === undefined ? 'unknown' : vendorRequests.markers.get(label) ?? 'unknown';
  // Synthetic uploads never need heading recovery, so every OpenAI request is the reader's.
  const role = String(url).includes('typesafe') ? 'confidence' : 'reader';
  const key = fingerprint + '/' + role;
  vendorRequests.total++; vendorRequests.byDocumentRole.set(key, (vendorRequests.byDocumentRole.get(key) ?? 0) + 1);
  return fakeVendor(url, init, context);
});

/** One storage operation as the fault hooks see it. `phase` 'after' means the operation has already taken effect. */
export interface StorageOperation {
  readonly store: 'd1' | 'r2';
  /** d1: first | all | run | batch | exec; r2: get | head | put | delete | list. */
  readonly method: string;
  readonly write: boolean;
  /** d1: the SQL (the first statement's for a batch); r2: the object key. */
  readonly target: string;
  /** d1 batch: every statement's SQL. */
  readonly statements?: readonly string[];
}
/**
 * Returning an Error throws it; returning 'hang' leaves the operation's promise unsettled for ever (a dead isolate). A
 * hook may be asynchronous (to act on the database between two operations); its own storage operations re-enter the
 * hooks, so such a hook guards itself against recursion.
 */
export type FaultDecision = Error | 'hang' | void;
export interface FaultHooks {
  before?(operation: StorageOperation): FaultDecision | Promise<FaultDecision>;
  after?(operation: StorageOperation): FaultDecision | Promise<FaultDecision>;
}

export interface OperationStats {
  d1Reads: number; d1Writes: number; d1Batches: number; d1BatchStatements: number; d1RowsReturned: number;
  r2Gets: number; r2Heads: number; r2Puts: number; r2Deletes: number; r2Lists: number;
  /** Operation count by a short label: the SQL's leading words or the R2 method and key kind. */
  byLabel: Map<string, number>;
}
const emptyStats = (): OperationStats => ({ d1Reads: 0, d1Writes: 0, d1Batches: 0, d1BatchStatements: 0, d1RowsReturned: 0,
  r2Gets: 0, r2Heads: 0, r2Puts: 0, r2Deletes: 0, r2Lists: 0, byLabel: new Map() });

const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
/** A stable, content-free label: the statement's verb and table, plus the first distinguishing words. */
export function sqlLabel(sql: string): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  const insert = /^INSERT(?: OR \w+)? INTO (\w+)/i.exec(compact);
  if (insert) {
    const kind = insert[1] === 'events' ? (/'(\w+)','(\w+)'/.exec(compact)?.slice(1).join('/') ?? '') : '';
    return `INSERT ${insert[1]}${kind ? ' ' + kind : ''}`;
  }
  const update = /^UPDATE (\w+) SET (\w+)/i.exec(compact);
  if (update) return `UPDATE ${update[1]}.${update[2]}`;
  const remove = /^DELETE FROM (\w+)/i.exec(compact);
  if (remove) return `DELETE ${remove[1]}`;
  const tables = [...new Set([...compact.matchAll(/\bFROM (\w+)/gi)].map(match => match[1]))];
  return `SELECT ${tables.join('+')}`;
}
function r2Label(method: string, key: string): string {
  const parts = key.split('/');
  // <run>/<fingerprint>/<kind>/<id>: label by kind only.
  return `R2 ${method} ${parts.length >= 3 ? parts[2] : 'other'}`;
}

export function d1Error(message: string): Error { return new Error('D1_ERROR: ' + message); }
/** The Durable Object lifecycle message the step engine throws when the Workflow's engine instance is gone. */
export const lifecycleError = () => new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.');
/** The Workers runtime's own internal-failure exception (the r07 halt of 7 October 2026), with a fresh reference each time. */
export const internalError = () => new Error('internal error; reference = ' + Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''));
/**
 * Engine failures at step boundaries: before the callback is entered, or after it completed (its result is then lost);
 * and at a durable wait (`step.sleepUntil`): before the wait's time has passed, or after it (the acknowledgement lost).
 */
export interface StepFaults {
  unentered?(name: string): Error | boolean | void;
  afterCompleted?(name: string): Error | void;
  unslept?(name: string): Error | void;
  afterSlept?(name: string): Error | void;
}
export function r2Error(method: string, code: 10001 | 10043 | 10054, message = 'We encountered an internal error. Please try again.'): Error {
  return new Error(`${method}: ${message} (${code})`);
}

/** A D1-shaped adapter that counts every statement execution and consults the fault hooks around each one. */
export function countingD1(db: DatabaseSync, stats: { current: OperationStats }, faults: FaultHooks): D1Database {
  const count = (label: string) => stats.current.byLabel.set(label, (stats.current.byLabel.get(label) ?? 0) + 1);
  const settle = async (operation: StorageOperation, phase: 'before' | 'after') => {
    const decision = await faults[phase]?.(operation);
    if (decision === 'hang') await new Promise<never>(() => {});
    if (decision instanceof Error) throw decision;
  };
  interface Statement { readonly sql: string; readonly values: SQLInputValue[] }
  const sqlValue = (value: unknown): SQLInputValue => value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value as SQLInputValue;
  const execute = (statement: Statement) => db.prepare(statement.sql).run(...statement.values);
  const statement = (sql: string, values: SQLInputValue[]) => {
    const own: Statement = { sql, values };
    const operation = (method: string): StorageOperation => ({ store: 'd1', method, write: isWrite(sql), target: sql });
    const record = (write: boolean) => {
      if (write) stats.current.d1Writes++; else stats.current.d1Reads++;
      count(sqlLabel(sql) + (sql.startsWith('INSERT INTO events(') && typeof values[5] === 'string' ? ' ' + values[5] : ''));
    };
    return {
      sql, values, own,
      bind: (...next: unknown[]) => statement(sql, next.map(sqlValue)),
      first: async <T>(column?: string): Promise<T | null> => {
        const op = operation('first'); record(op.write); await settle(op, 'before');
        const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
        if (row) stats.current.d1RowsReturned++;
        await settle(op, 'after');
        if (!row) return null;
        return (column === undefined ? row : row[column]) as T;
      },
      all: async <T>() => {
        const op = operation('all'); record(op.write); await settle(op, 'before');
        const results = db.prepare(sql).all(...values) as T[];
        stats.current.d1RowsReturned += results.length;
        await settle(op, 'after');
        return { results, success: true as const, meta: {} };
      },
      run: async () => {
        const op = operation('run'); record(op.write); await settle(op, 'before');
        const result = execute(own);
        await settle(op, 'after');
        return { success: true as const, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      raw: async () => { throw new Error('raw() is not used by the server.'); }
    };
  };
  const database = {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: { own: Statement }[]) => {
      const owned = statements.map(item => item.own);
      const op: StorageOperation = { store: 'd1', method: 'batch', write: owned.some(item => isWrite(item.sql)),
        target: owned[0]?.sql ?? '', statements: owned.map(item => item.sql) };
      stats.current.d1Batches++; stats.current.d1BatchStatements += owned.length;
      count('BATCH[' + owned.map(item => sqlLabel(item.sql)).join(' + ') + ']');
      await settle(op, 'before');
      // Synchronous inside one transaction: concurrent documents cannot interleave a statement into it.
      db.exec('BEGIN');
      let results: { success: true; meta: { changes: number; last_row_id: number } }[];
      try {
        results = owned.map(item => {
          const result = execute(item);
          return { success: true as const, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error instanceof Error ? d1Error(error.message) : error;
      }
      await settle(op, 'after');
      return results;
    },
    exec: async (sql: string) => { db.exec(sql); return { count: 1, duration: 0 }; }
  };
  return database as unknown as D1Database;
}

interface StoredObject { body: Uint8Array; customMetadata: Record<string, string>; sha256: ArrayBuffer | null; md5: ArrayBuffer; uploaded: Date }
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const hashBytes = (algorithm: 'sha256' | 'md5', bytes: Uint8Array) => toArrayBuffer(new Uint8Array(createHash(algorithm).update(bytes).digest()));
const hex = (value: ArrayBuffer | string) => typeof value === 'string' ? value.toLowerCase() : Buffer.from(value).toString('hex');

/**
 * An in-memory R2 bucket with the documented semantics the server relies on: create-only puts through the
 * `If-None-Match: *` conditional header return null when the key exists; `sha256` is verified and kept in `checksums`;
 * MD5 is always kept; `customMetadata` is stored. Any attempt to replace different bytes under an existing key is
 * recorded as an overwrite violation and refused.
 */
export function countingR2(stats: { current: OperationStats }, faults: FaultHooks) {
  const objects = new Map<string, StoredObject>();
  const overwriteAttempts: string[] = [];
  const count = (label: string) => stats.current.byLabel.set(label, (stats.current.byLabel.get(label) ?? 0) + 1);
  const settle = async (operation: StorageOperation, phase: 'before' | 'after') => {
    const decision = await faults[phase]?.(operation);
    if (decision === 'hang') await new Promise<never>(() => {});
    if (decision instanceof Error) throw decision;
  };
  const view = (key: string, stored: StoredObject, withBody: boolean) => {
    const text = () => new TextDecoder().decode(stored.body);
    return {
      key, size: stored.body.byteLength, uploaded: stored.uploaded, customMetadata: { ...stored.customMetadata },
      checksums: { md5: stored.md5, ...(stored.sha256 ? { sha256: stored.sha256 } : {}) },
      httpMetadata: {}, etag: hex(stored.md5), httpEtag: `"${hex(stored.md5)}"`, version: '1', storageClass: 'Standard',
      ...(withBody ? {
        text: async () => text(), json: async <T>() => JSON.parse(text()) as T,
        arrayBuffer: async () => toArrayBuffer(stored.body.slice()),
        get body() { return new Response(stored.body.slice()).body; }
      } : {})
    };
  };
  const bytesOf = async (value: unknown): Promise<Uint8Array> => {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (value === null) return new Uint8Array();
    throw new Error('put: unsupported body in the in-memory R2.');
  };
  const bucket = {
    objects, overwriteAttempts,
    get: async (key: string) => {
      const op: StorageOperation = { store: 'r2', method: 'get', write: false, target: key };
      stats.current.r2Gets++; count(r2Label('get', key)); await settle(op, 'before');
      const stored = objects.get(key); await settle(op, 'after');
      return stored ? view(key, stored, true) : null;
    },
    head: async (key: string) => {
      const op: StorageOperation = { store: 'r2', method: 'head', write: false, target: key };
      stats.current.r2Heads++; count(r2Label('head', key)); await settle(op, 'before');
      const stored = objects.get(key); await settle(op, 'after');
      return stored ? view(key, stored, false) : null;
    },
    put: async (key: string, value: unknown, options: { onlyIf?: Headers; customMetadata?: Record<string, string>; sha256?: ArrayBuffer | string } = {}) => {
      const op: StorageOperation = { store: 'r2', method: 'put', write: true, target: key };
      stats.current.r2Puts++; count(r2Label('put', key));
      const bytes = await bytesOf(value);
      await settle(op, 'before');
      const createOnly = options.onlyIf instanceof Headers && options.onlyIf.get('If-None-Match') === '*';
      const existing = objects.get(key);
      if (existing && createOnly) { await settle(op, 'after'); return null; }
      if (existing) {
        if (Buffer.compare(Buffer.from(existing.body), Buffer.from(bytes)) !== 0) {
          overwriteAttempts.push(key);
          throw new Error(`put: refusing to replace different bytes under an existing key in the test bucket (${key}).`);
        }
      }
      const sha256 = hashBytes('sha256', bytes);
      if (options.sha256 !== undefined && hex(options.sha256) !== hex(sha256))
        throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
      const stored: StoredObject = { body: bytes, customMetadata: { ...(options.customMetadata ?? {}) },
        sha256: options.sha256 === undefined ? null : sha256, md5: hashBytes('md5', bytes), uploaded: new Date() };
      objects.set(key, stored);
      await settle(op, 'after');
      return view(key, stored, false);
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const op: StorageOperation = { store: 'r2', method: 'delete', write: true, target: key };
        stats.current.r2Deletes++; count(r2Label('delete', key)); await settle(op, 'before');
        objects.delete(key); await settle(op, 'after');
      }
    },
    list: async () => { stats.current.r2Lists++; throw new Error('list() is not used on the Workflow path.'); }
  };
  return bucket;
}

export interface HarnessOptions {
  /** Default: an acknowledged unlimited run, as in the 10,000-document practice runs. */
  budget?: 'unlimited' | 'limited';
  categories?: number;
  faults?: FaultHooks;
  /**
   * Answer one document in every this many with a 429 once per role (core/vendors/fake-vendors.ts), so a document's
   * transport retry wait and the provider cooldown wait (both durable top-level waits) are exercised. Default: never.
   */
  rateLimitEveryNth?: number;
}

/**
 * Node timers do not guarantee exact callback timing. The local step engine must fulfil sleepUntil's absolute
 * deadline even if a timer wakes early; another timer waits only the remainder. This repeats no Workflow action.
 * The production Workflow guard still independently rejects any successful early return from the real engine.
 */
export async function harnessSleepUntil(until: number): Promise<void> {
  for (let remaining = until - Date.now(); remaining > 0; remaining = until - Date.now())
    await new Promise<void>(resolve => setTimeout(resolve, remaining));
}

/** A run with its documents uploaded, ready to process. Counters are reset after setup. */
export async function workflowHarness(options: HarnessOptions = {}) {
  const db = migratedDatabase();
  const stats = { current: emptyStats() };
  const faults: FaultHooks = options.faults ?? {};
  const DB = countingD1(db, stats, faults), ARTIFACTS = countingR2(stats, faults);
  const pack = syntheticPack(options.categories ?? 4);
  const budget: RunBudget = options.budget === 'limited'
    ? authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false }, 'synthetic-owner', '2026-10-06')
    : authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'synthetic-owner', '2026-10-06');
  fakeVendor = createFakeVendorFetch(options.rateLimitEveryNth === undefined ? {} : { rateLimitEveryNth: options.rateLimitEveryNth });
  /** What the pretend Workflow binding reports for an instance (core/server/runtime-observation.ts reads it); 'running' unless set. */
  const nativeStatus = new Map<string, string>();
  const DOCUMENT_WORKFLOW = {
    get: async (id: string) => ({ id, status: async () => ({ status: nativeStatus.get(id) ?? 'running' }) }),
    create: async () => { throw new Error('The harness enters Workflows itself; nothing may create one.'); },
    createBatch: async () => { throw new Error('The harness enters Workflows itself; nothing may create one.'); }
  };
  const env = { DB, ARTIFACTS, DOCUMENT_WORKFLOW, MODEL_CALLS_ENABLED: 'true',
    JEV_API_KEY: { get: async () => 'synthetic' }, OPENAI_API_KEY: { get: async () => 'synthetic' } } as unknown as Env;
  const store = new Store(env);
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('quote','synthetic-owner','2026-10-06','interactive','types','pack','{}','{}')").run();
  const runId = 'run-synthetic';
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,'synthetic-owner','running','2026-10-06','interactive',0,0.9,'initial_design_threshold','types',?,?,'quote')")
    .run(runId, JSON.stringify(pack), JSON.stringify(budget));
  const fingerprints: string[] = [];
  const marker = new Map<string, string>();
  /** Uploads `count` synthetic documents with distinct text; each text carries a marker the vendor seam maps back. */
  const addDocuments = async (count: number) => {
    for (let index = 0; index < count; index++) {
      const ordinal = fingerprints.length + 1;
      const fingerprint = createHash('sha256').update('synthetic-document-' + ordinal).digest('hex');
      const label = `Synthetic document ${ordinal}.`;
      const fullText = `[Page 1]\nIntroduction\n${label} Its content is generated for storage tests.`;
      const inputKey = await store.put(runId, fingerprint, 'input', { fullText,
        outline: { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [],
          blocks: [{ position: 22, text: fullText.slice(22) }] },
        tokenCounts: { readerInputTokens: null }, needsOutlineRecovery: false }, true);
      db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id,ordinal) VALUES(?,?,?,?,'uploaded',?,?,?,?)")
        .run(runId, fingerprint, `r-${String(ordinal).padStart(5, '0')}`, `synthetic-${ordinal}.pdf`, inputKey,
          createHash('sha256').update(fullText).digest('hex'), await workflowInstanceId(runId, fingerprint), ordinal);
      fingerprints.push(fingerprint); marker.set(label, fingerprint); vendorRequests.markers.set(label, fingerprint);
    }
    db.prepare('UPDATE runs SET expected_count=? WHERE id=?').run(fingerprints.length, runId);
  };
  /** The durable step cache of each Workflow instance: a completed step name returns its saved value. */
  const stepCache = new Map<string, Map<string, unknown>>();
  const callbacks = new Map<string, string[]>();
  const stepFor = (instanceId: string, faults?: StepFaults | ((name: string) => boolean)) => {
    const cache = stepCache.get(instanceId) ?? new Map<string, unknown>(); stepCache.set(instanceId, cache);
    const stepFaults: StepFaults = typeof faults === 'function' ? { unentered: faults } : faults ?? {};
    return {
      do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
        if (cache.has(name)) return cache.get(name);
        const before = stepFaults.unentered?.(name);
        if (before === true) throw lifecycleError();
        if (before instanceof Error) throw before;
        (callbacks.get(instanceId) ?? callbacks.set(instanceId, []).get(instanceId)!).push(name);
        const value = await callback();
        // The engine never received this result (the r07 shape): nothing is cached, so a replay enters the step again
        // and the document's own D1 checkpoint answers it.
        const after = stepFaults.afterCompleted?.(name);
        if (after instanceof Error) throw after;
        cache.set(name, value); return value;
      },
      sleepUntil: async (name: string, until: number) => {
        const early = stepFaults.unslept?.(name);
        if (early instanceof Error) throw early;
        await harnessSleepUntil(until);
        // The time has passed but the engine's acknowledgement of the wait is lost.
        const late = stepFaults.afterSlept?.(name);
        if (late instanceof Error) throw late;
      }
    };
  };
  /**
   * Time passes: the document's recorded waiting window (RUNTIME_WAIT_MS from its first interruption) is moved into the
   * past, keeping the row's invariant (deadline = first observation + the window) and the run's pending minimum.
   */
  const expireWait = (fingerprint: string) => {
    db.prepare('UPDATE runtime_interruptions SET first_observed_ms=first_observed_ms-?,deadline_ms=deadline_ms-?,observed_ms=observed_ms-?,next_check_ms=next_check_ms-? WHERE run_id=? AND fingerprint=?')
      .run(RUNTIME_WAIT_MS + 1, RUNTIME_WAIT_MS + 1, RUNTIME_WAIT_MS + 1, RUNTIME_WAIT_MS + 1, runId, fingerprint);
    db.prepare("UPDATE runs SET runtime_pending_deadline_ms=(SELECT MIN(deadline_ms) FROM runtime_interruptions WHERE run_id=? AND state='pending') WHERE id=?").run(runId, runId);
  };
  /**
   * One entry of the document's Workflow. `faults` injects engine failures at step boundaries: the legacy boolean form
   * throws the Durable Object lifecycle message before the callback; the object form returns the exact error to throw.
   */
  const invoke = async (fingerprint: string, faults?: StepFaults | ((name: string) => boolean)) => {
    const instanceId = await workflowInstanceId(runId, fingerprint);
    return new DocumentWorkflow({} as ExecutionContext, env).run(
      { instanceId, payload: { runId, fingerprint } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
      stepFor(instanceId, faults) as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
  };
  /** One poll of the compact run status, exactly as the API reads and projects it. */
  const status = async () => runStatusResponse(await readRunStatusInput(store, env, await store.run(runId), Date.now()), null);
  const take = () => { const value = stats.current; stats.current = emptyStats(); return value; };
  return { db, env, store, runId, pack, budget, stats, take, faults, bucket: ARTIFACTS, fingerprints, marker,
    addDocuments, invoke, status, stepCache, callbacks, nativeStatus, expireWait };
}
