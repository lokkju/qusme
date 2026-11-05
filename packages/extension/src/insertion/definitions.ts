/**
 * Where site definitions come from (spec 10.2, 10.3): the snapshot bundled with the build, with
 * each destination's `override` (7.2) merged over it. The registry has published no definitions
 * yet, so the bundled snapshot is empty and a destination works through its override or the 10.2
 * fallback (the focused field, then the user's click). The refresh from the registry's relays
 * replaces this source later; callers take a {@link SiteDefinitionSource}, not the snapshot.
 */
import {
  type Destination,
  type JsonObject,
  mergeSiteOverride,
  parseSiteDefinition,
  type SiteDefinition,
  type SiteField,
} from '@qusme/nostr';
import type { CachedDraft } from '../sync/state.ts';

/** The registry snapshot bundled with this build: definition JSON, as the registry publishes it. */
export const BUNDLED_SITE_DEFINITIONS: readonly JsonObject[] = [];

export interface SiteDefinitionSource {
  /** The official definition JSON for a site id, unvalidated. */
  official(site: string): JsonObject | undefined;
}

/** A source over a list of definition JSON objects, keyed by their `id`. */
export function definitionSource(
  definitions: readonly JsonObject[] = BUNDLED_SITE_DEFINITIONS
): SiteDefinitionSource {
  const byId = new Map<string, JsonObject>();
  for (const definition of definitions) {
    if (typeof definition.id === 'string') byId.set(definition.id, definition);
  }
  return { official: (site) => byId.get(site) };
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

/** The draft's destination: by id when it names one, else by site and account. */
export function destinationOf(
  draft: Pick<CachedDraft, 'destination' | 'site' | 'account'>,
  destinations: readonly Destination[]
): Destination | undefined {
  if (draft.destination !== undefined) {
    const byId = destinations.find((d) => d.id === draft.destination);
    if (byId !== undefined) return byId;
  }
  return destinations.find((d) => d.site === draft.site && d.account === draft.account);
}

/** The effective definition for a draft's destination, and the draft's field in it. */
export function definitionForDraft(
  source: SiteDefinitionSource,
  draft: Pick<CachedDraft, 'destination' | 'site' | 'account' | 'field'>,
  destinations: readonly Destination[]
): { definition?: SiteDefinition; field?: SiteField } {
  const destination = destinationOf(draft, destinations);
  const definition = effectiveDefinition(source, draft.site, destination?.override);
  if (definition === undefined) return {};
  const field = definition.fields.find((f) => f.name === draft.field);
  return field === undefined ? { definition } : { definition, field };
}
