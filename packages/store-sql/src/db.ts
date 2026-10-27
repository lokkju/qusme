import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from './schema.ts';

/**
 * The database the app is handed: D1 on Workers (async) or a SQLite file on Node (sync). The
 * repositories in store.ts await every query, which works for both.
 */
export type QusmeDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;
