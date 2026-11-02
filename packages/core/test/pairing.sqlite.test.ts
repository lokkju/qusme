import { openSqlite } from '@qusme/store-sql/sqlite';
import { pairingSuite } from './pairing.suite.ts';

pairingSuite('better-sqlite3', () => ({
  async fresh() {
    return openSqlite(':memory:');
  },
}));
