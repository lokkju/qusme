/**
 * The bundled registry snapshot (spec 10.3) and effective definitions (10.2). The snapshot is
 * injected: the service has no bundled registry yet, so the default is empty and every
 * destination resolves from its override alone.
 */
import {
  type JsonObject,
  mergeSiteOverride,
  parseSiteDefinition,
  type SiteDefinition,
} from '@qusme/nostr';

/** Raw site definition JSON as the registry repository publishes it (10.1). */
export type RegistrySnapshot = readonly unknown[];

export interface Registry {
  /** Parsed definitions, by site id, in snapshot order. */
  readonly definitions: readonly SiteDefinition[];
  get(site: string): SiteDefinition | undefined;
  /** The definition as published, for merging an override over it. */
  json(site: string): JsonObject | undefined;
}

/** Parses a snapshot, throwing on an invalid or repeated definition: the snapshot is ours. */
export function loadRegistry(snapshot: RegistrySnapshot = []): Registry {
  const parsed = new Map<string, SiteDefinition>();
  const raw = new Map<string, JsonObject>();
  for (const [i, value] of snapshot.entries()) {
    const result = parseSiteDefinition(value);
    if (!result.ok) throw new Error(`registry snapshot entry ${i}: ${result.error.message}`);
    const { id } = result.value;
    if (parsed.has(id)) throw new Error(`registry snapshot repeats site ${id}`);
    parsed.set(id, result.value);
    raw.set(id, value as JsonObject);
  }
  return {
    definitions: [...parsed.values()],
    get: (site) => parsed.get(site),
    json: (site) => raw.get(site),
  };
}

export type EffectiveDefinition =
  | { kind: 'definition'; definition: SiteDefinition }
  /** No official definition, and the override (if any) is not a whole definition. */
  | { kind: 'none' }
  /** The override does not merge into a valid definition. */
  | { kind: 'invalid'; reason: string };

/**
 * The official definition with the destination's override merged over it (10.2). A custom
 * destination's override is usually only `match`, which is no whole definition, so it resolves to
 * `none` and only the 32 KiB cap applies to its values.
 */
export function effectiveDefinition(
  registry: Registry,
  site: string,
  override: JsonObject | null | undefined
): EffectiveDefinition {
  const official = registry.json(site);
  const merged = mergeSiteOverride(official, override);
  if (merged === undefined) return { kind: 'none' };
  const result = parseSiteDefinition(merged);
  if (result.ok) return { kind: 'definition', definition: result.value };
  if (official === undefined) return { kind: 'none' };
  return { kind: 'invalid', reason: result.error.message };
}
