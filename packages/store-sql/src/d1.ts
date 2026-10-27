import { type AnyD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './schema.ts';

/** Drizzle over a Workers D1 binding. */
export function openD1(binding: AnyD1Database) {
  return drizzle(binding, { schema });
}

export type D1Db = ReturnType<typeof openD1>;
