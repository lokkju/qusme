import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { QusmeDb, Store } from '../src/index.ts';
import { migrationsFolder } from '../src/sqlite.ts';

/** What each driver's test file hands the shared suite: a fresh, migrated, empty store. */
export interface Harness {
  store: Store;
  db: QusmeDb;
}

/**
 * The migrations as wrangler applies them to D1: in journal order, each file's statements split at
 * drizzle's breakpoints.
 */
export function migrationStatements(): string[][] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) =>
    readFileSync(join(migrationsFolder, `${e.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

/** Renames a table, for tests that need a query on it to fail on either driver. */
export async function renameTable(db: QusmeDb, from: string, to: string): Promise<void> {
  await db.run(sql.raw(`alter table ${from} rename to ${to}`));
}
