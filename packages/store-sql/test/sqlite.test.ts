import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { pairingSessions } from '../src/index.ts';
import { openSqlite } from '../src/sqlite.ts';

it('applies the migrations and creates every service-state table', () => {
  const db = openSqlite(':memory:');
  const rows = db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' order by name`
  );
  const tables = rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith('__') && !n.startsWith('sqlite_'));
  expect(tables).toEqual([
    'agent_keys',
    'oauth_clients',
    'oauth_tokens',
    'pairing_sessions',
    'queue_bindings',
  ]);
});

it('stores a pairing session with its expiry', () => {
  const db = openSqlite(':memory:');
  db.insert(pairingSessions)
    .values({
      code: 'ABC123',
      kind: 'device',
      ephemeralPubkey: 'ab'.repeat(32),
      createdAt: 1,
      expiresAt: 601,
    })
    .run();
  expect(db.select().from(pairingSessions).all()).toHaveLength(1);
});
