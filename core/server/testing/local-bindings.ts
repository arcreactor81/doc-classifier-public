// Test-only bindings: a D1-shaped adapter over node:sqlite and an in-memory R2 bucket, so server modules run
// against real SQL (the committed migrations, json_each, triggers) without Miniflare. Never imported by the Worker.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Applies every committed migration, in name order, to a fresh in-memory database. `foreignKeys: false` lets a test
 * seed only the tables it is about; the acceptance scripts exercise the constraints under Miniflare.
 */
export function migratedDatabase(options: { foreignKeys?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = fileURLToPath(new URL('../../../migrations/', import.meta.url).href);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort())
    db.exec(readFileSync(`${dir}${name}`, 'utf8').replace(/^﻿/, ''));
  if (options.foreignKeys === false) db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

const sqlValue = (value: unknown): SQLInputValue =>
  value === undefined ? null :
  typeof value === 'boolean' ? (value ? 1 : 0) :
  value as SQLInputValue;

interface LocalStatement {
  readonly sql: string;
  readonly values: SQLInputValue[];
  bind(...values: unknown[]): LocalStatement;
  first<T>(column?: string): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
}

/** The subset of D1Database the server uses: prepare/bind/first/all/run and a transactional batch. */
export function localD1(db: DatabaseSync, log?: string[]): D1Database {
  const statement = (sql: string, values: SQLInputValue[]): LocalStatement => ({
    sql,
    values,
    bind: (...next) => statement(sql, next.map(sqlValue)),
    first: async <T>(column?: string) => {
      log?.push(sql);
      const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column === undefined ? row : row[column]) as T;
    },
    all: async <T>() => {
      log?.push(sql);
      return { results: db.prepare(sql).all(...values) as T[], success: true as const, meta: {} };
    },
    run: async () => {
      log?.push(sql);
      const result = db.prepare(sql).run(...values);
      return { success: true as const, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  });
  const database = {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: LocalStatement[]) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (sql: string) => { db.exec(sql); return { count: 1, duration: 0 }; }
  };
  return database as unknown as D1Database;
}

/**
 * The next `count` single-row reads (`first`) of statements whose SQL contains `fragment` fail as D1 reports a brief
 * interruption, before reaching the database. Returns a function giving how many were lost so far.
 */
export function loseD1Reads(DB: D1Database, fragment: string, count: number): () => number {
  const prepare = DB.prepare.bind(DB);
  let lost = 0;
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const bind = statement.bind.bind(statement), first = statement.first.bind(statement) as (column?: string) => Promise<unknown>;
    return Object.assign(statement, {
      bind: (...values: unknown[]) => wrap(sql, bind(...values)),
      first: async (column?: string) => {
        if (sql.includes(fragment) && lost < count) { lost++; throw new Error('D1_ERROR: Network connection lost.'); }
        return first(column);
      }
    }) as unknown as D1PreparedStatement;
  };
  DB.prepare = sql => wrap(sql, prepare(sql));
  return () => lost;
}

/**
 * An in-memory R2 bucket honouring `If-None-Match: *` (create-only puts), as Store relies on. Like R2 it keeps the
 * `customMetadata` and a provided `sha256` (returned in `checksums`) and refuses a `sha256` that does not match the body.
 */
export function memoryR2(): R2Bucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const metadata = new Map<string, { customMetadata: Record<string, string>; sha256: string | null }>();
  const hex = (value: ArrayBuffer | string) => typeof value === 'string' ? value.toLowerCase() : Buffer.from(value).toString('hex');
  const object = (key: string, body: string) => {
    const meta = metadata.get(key) ?? { customMetadata: {}, sha256: null };
    return {
      key,
      size: new TextEncoder().encode(body).byteLength,
      customMetadata: { ...meta.customMetadata },
      checksums: meta.sha256 === null ? {} : { sha256: new Uint8Array(Buffer.from(meta.sha256, 'hex')).buffer },
      json: async <T>() => JSON.parse(body) as T,
      text: async () => body
    };
  };
  const bucket = {
    objects,
    get: async (key: string) => objects.has(key) ? object(key, objects.get(key)!) : null,
    head: async (key: string) => objects.has(key) ? object(key, objects.get(key)!) : null,
    put: async (key: string, value: unknown, options?: { onlyIf?: Headers; customMetadata?: Record<string, string>; sha256?: ArrayBuffer | string }) => {
      const createOnly = options?.onlyIf instanceof Headers && options.onlyIf.get('If-None-Match') === '*';
      if (createOnly && objects.has(key)) return null;
      const body = typeof value === 'string' ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : JSON.stringify(value);
      const actual = createHash('sha256').update(new TextEncoder().encode(body)).digest('hex');
      if (options?.sha256 !== undefined && hex(options.sha256) !== actual)
        throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
      objects.set(key, body);
      metadata.set(key, { customMetadata: { ...(options?.customMetadata ?? {}) }, sha256: options?.sha256 === undefined ? null : actual });
      return object(key, body);
    },
    delete: async (key: string | string[]) => { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item); }
  };
  return bucket as unknown as R2Bucket & { objects: Map<string, string> };
}
