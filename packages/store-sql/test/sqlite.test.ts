import { createStore } from '../src/index.ts';
import { openSqlite } from '../src/sqlite.ts';
import { storeSuite } from './suite.ts';

storeSuite('better-sqlite3', () => ({
  async fresh() {
    const db = openSqlite(':memory:');
    return { db, store: createStore(db) };
  },
}));
