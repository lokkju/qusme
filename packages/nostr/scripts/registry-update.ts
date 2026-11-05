/**
 * Copies a registry snapshot into this repository's build input, `registry/snapshot.json`, after
 * verifying it against the pinned publisher key (spec 10.3). Run from the repository root:
 *
 *   pnpm registry:update [<qusme-registry checkout>]     # default ../qusme-registry
 *
 * It reads `<checkout>/dist/snapshot.json` (the registry's `pnpm snapshot` output), refuses one
 * that fails verification, and refuses a snapshot that would replace a site's bundled definition
 * with an older version unless `--allow-downgrade` is given.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareSiteVersions,
  REGISTRY_PUBLISHER,
  readRegistrySnapshot,
  verifyRegistrySnapshot,
} from '../src/index.ts';

export interface UpdateOptions {
  /** The snapshot to copy. */
  source: string;
  /** The build input to write. */
  target: string;
  /** The pinned publisher key; tests pass a throwaway one. */
  pinned?: string;
  allowDowngrade?: boolean;
}

/** Verifies `source` and writes it to `target`; returns one line per site for the operator. */
export function updateSnapshot(options: UpdateOptions): string[] {
  const pinned = options.pinned ?? REGISTRY_PUBLISHER;
  const text = readFileSync(options.source, 'utf8');
  const snapshot: unknown = JSON.parse(text);
  const verified = verifyRegistrySnapshot(snapshot, pinned);

  let current: ReturnType<typeof readRegistrySnapshot>['definitions'] = [];
  try {
    current = readRegistrySnapshot(
      JSON.parse(readFileSync(options.target, 'utf8')),
      pinned
    ).definitions;
  } catch {
    // No current snapshot, or one that isn't JSON: nothing to compare against.
  }
  const lines: string[] = [];
  for (const old of current) {
    const next = verified.definitions.find((d) => d.definition.id === old.definition.id);
    if (next === undefined) {
      lines.push(`${old.definition.id}: removed (was ${old.definition.version})`);
      continue;
    }
    if (compareSiteVersions(next.definition.version, old.definition.version) < 0) {
      const message = `${old.definition.id}: ${next.definition.version} is older than the bundled ${old.definition.version}`;
      if (!options.allowDowngrade) throw new Error(`${message}; pass --allow-downgrade to accept`);
      lines.push(`${message} (allowed)`);
    }
  }
  for (const d of verified.definitions) {
    const old = current.find((c) => c.definition.id === d.definition.id);
    lines.push(
      old === undefined
        ? `${d.definition.id}: ${d.definition.version} (new)`
        : `${d.definition.id}: ${old.definition.version} -> ${d.definition.version}`
    );
  }
  lines.push(
    verified.relayList === undefined
      ? 'relay list: none; devices fall back to REGISTRY_FALLBACK_RELAYS'
      : `relay list: ${verified.relayList.relays.map((r) => r.url).join(', ')}`
  );
  writeFileSync(options.target, `${JSON.stringify(snapshot, null, 2)}\n`);
  return lines;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowDowngrade = args.includes('--allow-downgrade');
  const positional = args.filter((a) => !a.startsWith('--'));
  const root = process.cwd();
  const checkout = resolve(root, positional[0] ?? '../qusme-registry');
  try {
    const lines = updateSnapshot({
      source: resolve(checkout, 'dist', 'snapshot.json'),
      target: resolve(root, 'registry', 'snapshot.json'),
      allowDowngrade,
    });
    for (const line of lines) console.log(line);
    console.log('wrote registry/snapshot.json');
  } catch (error) {
    console.error(`registry:update: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
