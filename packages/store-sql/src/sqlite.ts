import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

/** The SQL migrations drizzle-kit generates, shared with D1. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Drizzle over a SQLite file (or ':memory:'), with every migration applied. */
export function openSqlite(path: string) {
  const client = new Database(path);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const db = drizzle({ client, schema });
  migrate(db, { migrationsFolder });
  return db;
}

export type SqliteDb = ReturnType<typeof openSqlite>;
