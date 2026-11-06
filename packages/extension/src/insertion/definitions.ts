/**
 * Where site definitions come from (spec 10.2, 10.3): the registry's definitions, with each
 * destination's `override` (7.2) merged over them. The extension's source is
 * `RegistryDefinitionSource` (`registry.ts`): the snapshot bundled with the build, refreshed
 * from the publisher's relays. A site with no definition works through its destination's override
 * or the 10.2 fallback (the focused field, then the user's click). Callers take a
 * {@link SiteDefinitionSource}, not the snapshot.
 */
import {
  type Destination,
  type JsonObject,
  mergeSiteOverride,
  parseSiteDefinition,
  type SiteDefinition,
  type SiteField,
  sameAccount,
} from '@qusme/nostr';
import type { CachedDraft } from '../sync/state.ts';
import { BUNDLED_REGISTRY } from './registry.ts';

/**
 * The definitions of the registry snapshot bundled with this build that verify against the pinned
 * publisher key: definition JSON, as the registry publishes it.
 */
export const BUNDLED_SITE_DEFINITIONS: readonly JsonObject[] = BUNDLED_REGISTRY.definitions.map(
  (d) => d.json
);

export interface SiteDefinitionSource {
  /** The official definition JSON for a site id, unvalidated. */
  official(site: string): JsonObject | undefined;
  /** Every official definition held, unvalidated, for choosing a site (the Destinations screen). */
  sites(): JsonObject[];
  /** Calls `listener` whenever the definitions change; returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void;
}

/** A source over a list of definition JSON objects, keyed by their `id`. */
export function definitionSource(
  definitions: readonly JsonObject[] = BUNDLED_SITE_DEFINITIONS
): SiteDefinitionSource {
  const byId = new Map<string, JsonObject>();
  for (const definition of definitions) {
    if (typeof definition.id === 'string') byId.set(definition.id, definition);
  }
  return { official: (site) => byId.get(site), sites: () => [...byId.values()] };
}

/**
 * The effective definition (10.2): the official one with the override merged over it, validated.
 * Undefined when there is neither, or when the merge doesn't validate (an override that names no
 * fields for a site with no official definition, say), so the caller falls back.
 */
export function effectiveDefinition(
  source: SiteDefinitionSource,
  site: string,
  override: JsonObject | null | undefined
): SiteDefinition | undefined {
  const merged = mergeSiteOverride(source.official(site), override);
  if (merged === undefined) return undefined;
  const parsed = parseSiteDefinition(merged);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * The draft's destination: by id when it names one, else by site and account, accounts compared
 * by `normalizeAccount` under each destination's effective definition when `source` is given.
 */
export function destinationOf(
  draft: Pick<CachedDraft, 'destination' | 'site' | 'account'>,
  destinations: readonly Destination[],
  source?: SiteDefinitionSource
): Destination | undefined {
  if (draft.destination !== undefined) {
    const byId = destinations.find((d) => d.id === draft.destination);
    if (byId !== undefined) return byId;
  }
  return destinations.find(
    (d) =>
      d.site === draft.site &&
      sameAccount(
        d.site,
        d.account,
        draft.account,
        source && effectiveDefinition(source, d.site, d.override)
      )
  );
}

/** The effective definition for a draft's destination, and the draft's field in it. */
export function definitionForDraft(
  source: SiteDefinitionSource,
  draft: Pick<CachedDraft, 'destination' | 'site' | 'account' | 'field'>,
  destinations: readonly Destination[]
): { definition?: SiteDefinition; field?: SiteField } {
  const destination = destinationOf(draft, destinations, source);
  const definition = effectiveDefinition(source, draft.site, destination?.override);
  if (definition === undefined) return {};
  const field = definition.fields.find((f) => f.name === draft.field);
  return field === undefined ? { definition } : { definition, field };
}
