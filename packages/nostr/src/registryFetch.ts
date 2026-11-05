/**
 * A device's registry refresh over the network (spec 10.3): the publisher's current NIP-65 relay
 * list from the bundled relays, then every `KIND_SITE_DEF` from its write relays. Everything is
 * verified against the pinned publisher key before it is returned; deciding what replaces the
 * definitions a device already holds is the caller's job ({@link isNewerSiteDefinition}).
 */
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { KIND_RELAY_LIST, SITE_DEF_KINDS } from './kinds.ts';
import {
  isNewerSiteDefinition,
  parseRegistryRelayList,
  parseRegistrySiteDefinition,
  type RegistryRelayList,
  type RegistrySiteDefinition,
} from './registry.ts';
import { newestFirst, RelayConnection, type SocketFactory } from './relayClient.ts';

export interface RegistryFetchOptions {
  publisherPubkey: string;
  /** Where to read the relay list: the bundled list's relays, else the fallback relays. */
  bootstrapRelays: readonly string[];
  /** The relay list the device holds; a fetched one is used only if it is newer. */
  knownRelayList?: RegistryRelayList;
  socket?: SocketFactory;
  /** Milliseconds to wait for each relay to open and answer. */
  timeoutMs?: number;
}

export interface RegistryFetchResult {
  /** The newest verified relay list: the fetched one, or `knownRelayList`. */
  relayList?: RegistryRelayList;
  /** Verified definitions, the newest version per site. */
  definitions: RegistrySiteDefinition[];
  /** Events dropped for failing verification. */
  rejected: number;
  /** Relays that answered a query. None means the device keeps what it has. */
  reached: string[];
}

/** Fetches and verifies the publisher's relay list and site definitions. Never throws. */
export async function fetchRegistry(options: RegistryFetchOptions): Promise<RegistryFetchResult> {
  const pinned = options.publisherPubkey;
  const connections = new Map<string, Promise<RelayConnection | undefined>>();
  const connect = (url: string): Promise<RelayConnection | undefined> => {
    let pending = connections.get(url);
    if (pending === undefined) {
      pending = RelayConnection.open(url, {
        ...(options.socket && { socket: options.socket }),
        ...(options.timeoutMs !== undefined && {
          timeoutMs: options.timeoutMs,
          connectTimeoutMs: options.timeoutMs,
        }),
      }).catch(() => undefined);
      connections.set(url, pending);
    }
    return pending;
  };
  const reached = new Set<string>();
  const query = async (urls: readonly string[], filter: Filter): Promise<NostrEvent[]> => {
    const results = await Promise.all(
      [...new Set(urls)].map(async (url) => {
        const connection = await connect(url);
        if (connection === undefined) return [];
        try {
          const events = await connection.query([filter]);
          reached.add(url);
          return events;
        } catch {
          return [];
        }
      })
    );
    const byId = new Map<string, NostrEvent>();
    for (const event of results.flat()) byId.set(event.id, event);
    return [...byId.values()].sort(newestFirst);
  };

  let rejected = 0;
  try {
    let relayList = options.knownRelayList;
    const lists = await query(options.bootstrapRelays, {
      kinds: [KIND_RELAY_LIST],
      authors: [pinned],
    });
    for (const event of lists) {
      const parsed = parseRegistryRelayList(event, { publisherPubkey: pinned });
      if (!parsed.ok) {
        rejected++;
        continue;
      }
      if (relayList === undefined || newestFirst(parsed.value.event, relayList.event) < 0) {
        relayList = parsed.value;
      }
      break;
    }

    const sources = relayList?.writeRelays ?? options.bootstrapRelays;
    const events = await query(sources, { kinds: [...SITE_DEF_KINDS], authors: [pinned] });
    const bySite = new Map<string, RegistrySiteDefinition>();
    for (const event of events) {
      const parsed = parseRegistrySiteDefinition(event, { publisherPubkey: pinned });
      if (!parsed.ok) {
        rejected++;
        continue;
      }
      const { id } = parsed.value.definition;
      if (isNewerSiteDefinition(parsed.value, bySite.get(id))) bySite.set(id, parsed.value);
    }
    const result: RegistryFetchResult = {
      definitions: [...bySite.values()],
      rejected,
      reached: [...reached],
    };
    if (relayList !== undefined) result.relayList = relayList;
    return result;
  } finally {
    for (const pending of connections.values()) {
      const connection = await pending;
      connection?.close();
    }
  }
}
