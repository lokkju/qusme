import { createStore } from '@qusme/store-sql';
import { openSqlite } from '@qusme/store-sql/sqlite';
import { mcpToolsSuite } from './tools.suite.ts';

mcpToolsSuite('better-sqlite3', () => ({
  async fresh() {
    const db = openSqlite(':memory:');
    return { db, store: createStore(db) };
  },
}));
