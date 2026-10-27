import { defineConfig } from 'drizzle-kit';

// Migrations are plain SQL in ./migrations. Wrangler applies them to D1
// (`wrangler d1 migrations apply`, via migrations_dir in entry-worker's wrangler.jsonc) and
// drizzle's migrator applies them to the Node entrypoint's SQLite file.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
