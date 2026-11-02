import { createStore } from '@qusme/store-sql';
import { openSqlite } from '@qusme/store-sql/sqlite';
import { oauthFlowSuite } from './flow.suite.ts';

oauthFlowSuite('better-sqlite3', () => ({
  async fresh() {
    const db = openSqlite(':memory:');
    return { db, store: createStore(db) };
  },
}));
