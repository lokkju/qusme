import type { AnyD1Database } from 'drizzle-orm/d1';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll } from 'vitest';
import { openD1 } from '../src/d1.ts';
import { createStore } from '../src/index.ts';
import { migrationStatements } from './harness.ts';
import { storeSuite } from './suite.ts';

// D1 as workerd runs it, through Miniflare. One instance for the file; each test gets the
// migrated schema with every row deleted.
let mf: Miniflare;
type MiniflareD1 = Awaited<ReturnType<Miniflare['getD1Database']>>;
let d1: MiniflareD1;

// Children before parents, for the foreign keys.
const TABLES = [
  'oauth_tokens',
  'oauth_codes',
  'bindings',
  'submission_receipts',
  'pending_authorizations',
  'agent_keys',
  'oauth_clients',
  'pairing_sessions',
  'usage_counters',
  'nip98_replays',
  'hosted_queues',
];

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'store',
          compatibilityDate: '2026-10-20',
          modules: [
            {
              type: 'ESModule',
              path: 'store.mjs',
              contents:
                'export default { fetch() { return new Response(null, { status: 204 }); } };',
            },
          ],
          d1Databases: { DB: 'store-test' },
        },
      ],
    })
  );
  d1 = await mf.getD1Database('DB');
  for (const statements of migrationStatements()) {
    await d1.batch(statements.map((s) => d1.prepare(s)));
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

storeSuite('D1 (Miniflare)', () => ({
  async fresh() {
    await d1.batch(TABLES.map((t) => d1.prepare(`DELETE FROM ${t}`)));
    // Miniflare's D1 proxy and drizzle's D1 type are the same API declared twice.
    const db = openD1(d1 as unknown as AnyD1Database);
    return { db, store: createStore(db) };
  },
}));
