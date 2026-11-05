/**
 * Site definitions from the registry (spec 10.3): the snapshot bundled with this build, refreshed
 * from the publisher's relays. A refresh reads the publisher's current NIP-65 relay list from the
 * bundled list's relays (or {@link REGISTRY_FALLBACK_RELAYS} when the build has none), then every
 * `KIND_SITE_DEF` from its write relays, and accepts a definition only when it verifies against
 * the pinned publisher key and its version is newer than the one held. Verified events are cached
 * in `storage.local`; they are public data. If no relay answers, the device keeps what it has.
 */
import {
  fetchRegistry,
  isNewerSiteDefinition,
  type JsonObject,
  type NostrEvent,
  parseRegistryRelayList,
  parseRegistrySiteDefinition,
  REGISTRY_FALLBACK_RELAYS,
  REGISTRY_PUBLISHER,
  type RegistryRelayList,
  type RegistrySiteDefinition,
  readRegistrySnapshot,
  type SocketFactory,
} from '@qusme/nostr';
import snapshot from '../../../../registry/snapshot.json' with { type: 'json' };
import type { StorageArea } from '../storage.ts';
import type { SiteDefinitionSource } from './definitions.ts';

/** The `storage.local` key holding the verified events of the last refresh. */
export const LOCAL_REGISTRY = 'qusme.registry';
/** Least time between two refreshes, in seconds; syncs run every few minutes. */
export const REGISTRY_REFRESH_SECONDS = 6 * 60 * 60;

/** The snapshot bundled with this build, verified against the pinned key. */
export const BUNDLED_REGISTRY = readRegistrySnapshot(snapshot, REGISTRY_PUBLISHER);

interface StoredRegistry {
  relayList?: NostrEvent;
  siteDefinitions: NostrEvent[];
  /** Unix seconds of the last refresh attempt, answered or not. */
  checkedAt: number;
}

export interface RegistrySourceOptions {
  local: StorageArea;
  /** The bundled snapshot; this build's `registry/snapshot.json` by default. */
  snapshot?: unknown;
  /** The pinned publisher key; {@link REGISTRY_PUBLISHER} unless a test pins its own. */
  publisher?: string;
  socket?: SocketFactory;
  relayTimeoutMs?: number;
  /** Unix seconds. */
  now?: () => number;
}

export type RegistryRefresh =
  | { state: 'skipped' }
  | { state: 'unreachable' }
  | { state: 'refreshed'; updated: string[]; rejected: number };

/** A {@link SiteDefinitionSource} over the bundled snapshot, the cache and relay refreshes. */
export class RegistryDefinitionSource implements SiteDefinitionSource {
  readonly #options: RegistrySourceOptions;
  readonly #publisher: string;
  readonly #bySite = new Map<string, RegistrySiteDefinition>();
  readonly #listeners = new Set<() => void>();
  #relayList: RegistryRelayList | undefined;
  #refreshing: Promise<RegistryRefresh> | undefined;

  constructor(options: RegistrySourceOptions) {
    this.#options = options;
    this.#publisher = options.publisher ?? REGISTRY_PUBLISHER;
    const bundled =
      options.snapshot === undefined && this.#publisher === REGISTRY_PUBLISHER
        ? BUNDLED_REGISTRY
        : readRegistrySnapshot(options.snapshot ?? snapshot, this.#publisher);
    this.#relayList = bundled.relayList;
    for (const definition of bundled.definitions) this.#accept(definition);
  }

  official(site: string): JsonObject | undefined {
    return this.#bySite.get(site)?.json;
  }

  /** The version held for a site, for tests and the UI. */
  version(site: string): string | undefined {
    return this.#bySite.get(site)?.definition.version;
  }

  /** Called after the definitions change, so the context menu can follow new match patterns. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Adds the cached events from the last refresh. Each is verified again: the cache is ours, but
   * re-checking costs little and keeps the pin the only authority.
   */
  async load(): Promise<void> {
    const stored = await this.#read();
    if (stored === undefined) return;
    let changed = false;
    if (stored.relayList !== undefined) {
      const list = parseRegistryRelayList(stored.relayList, { publisherPubkey: this.#publisher });
      if (list.ok) changed = this.#acceptRelayList(list.value) || changed;
    }
    for (const event of stored.siteDefinitions) {
      const parsed = parseRegistrySiteDefinition(event, { publisherPubkey: this.#publisher });
      if (parsed.ok) changed = this.#accept(parsed.value) || changed;
    }
    if (changed) this.#notify();
  }

  /**
   * Refreshes from the relays, at most once per {@link REGISTRY_REFRESH_SECONDS} unless forced.
   * Never throws; one refresh runs at a time.
   */
  refresh(options: { force?: boolean } = {}): Promise<RegistryRefresh> {
    if (this.#refreshing === undefined) {
      this.#refreshing = this.#refreshOnce(options.force === true)
        .catch((): RegistryRefresh => ({ state: 'unreachable' }))
        .finally(() => {
          this.#refreshing = undefined;
        });
    }
    return this.#refreshing;
  }

  async #refreshOnce(force: boolean): Promise<RegistryRefresh> {
    const now = this.#options.now?.() ?? Math.floor(Date.now() / 1000);
    const stored = await this.#read();
    if (!force && stored !== undefined && now - stored.checkedAt < REGISTRY_REFRESH_SECONDS) {
      return { state: 'skipped' };
    }
    const bootstrapRelays = this.#relayList?.relays.map((r) => r.url) ?? REGISTRY_FALLBACK_RELAYS;
    const fetched = await fetchRegistry({
      publisherPubkey: this.#publisher,
      bootstrapRelays,
      ...(this.#relayList && { knownRelayList: this.#relayList }),
      ...(this.#options.socket && { socket: this.#options.socket }),
      ...(this.#options.relayTimeoutMs !== undefined && {
        timeoutMs: this.#options.relayTimeoutMs,
      }),
    });
    if (fetched.reached.length === 0) {
      await this.#write({ ...(stored ?? { siteDefinitions: [] }), checkedAt: now });
      return { state: 'unreachable' };
    }
    let changed = fetched.relayList !== undefined && this.#acceptRelayList(fetched.relayList);
    const updated: string[] = [];
    for (const definition of fetched.definitions) {
      if (this.#accept(definition)) updated.push(definition.definition.id);
    }
    changed = changed || updated.length > 0;
    await this.#write({
      ...(this.#relayList && { relayList: this.#relayList.event }),
      siteDefinitions: [...this.#bySite.values()].map((d) => d.event),
      checkedAt: now,
    });
    if (changed) this.#notify();
    return { state: 'refreshed', updated, rejected: fetched.rejected };
  }

  /** Holds `definition` if it is newer than the version held; true if it was. */
  #accept(definition: RegistrySiteDefinition): boolean {
    const { id } = definition.definition;
    if (!isNewerSiteDefinition(definition, this.#bySite.get(id))) return false;
    this.#bySite.set(id, definition);
    return true;
  }

  #acceptRelayList(list: RegistryRelayList): boolean {
    const held = this.#relayList?.event;
    if (held !== undefined && list.event.created_at <= held.created_at) return false;
    this.#relayList = list;
    return true;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  async #read(): Promise<StoredRegistry | undefined> {
    const value = (await this.#options.local.get([LOCAL_REGISTRY]))[LOCAL_REGISTRY] as
      | Partial<StoredRegistry>
      | undefined;
    if (typeof value !== 'object' || value === null) return undefined;
    return {
      ...(typeof value.relayList === 'object' && { relayList: value.relayList }),
      siteDefinitions: Array.isArray(value.siteDefinitions) ? value.siteDefinitions : [],
      checkedAt: typeof value.checkedAt === 'number' ? value.checkedAt : 0,
    };
  }

  async #write(stored: StoredRegistry): Promise<void> {
    await this.#options.local.set({ [LOCAL_REGISTRY]: stored });
  }
}
