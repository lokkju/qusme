import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schemaModule from './schema.ts';

export * as schema from './schema.ts';
export * from './schema.ts';

/**
 * The database the app is handed: D1 on Workers (async) or a SQLite file on Node (sync). Code in
 * core awaits every query, which works for both.
 */
export type QusmeDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schemaModule>;
