/**
 * The site registry as a client consumes it (spec 10.3): the pinned publisher key, the snapshot
 * format lokkju/qusme-registry's `pnpm snapshot` writes, and the checks a build or a device runs
 * on it. Every value in a snapshot is a complete signed event, so a snapshot is verified with the
 * same parsers as events fetched from relays.
 *
 * {@link verifyRegistrySnapshot} is the port of the registry's `verifySnapshot` (its
 * `src/snapshot.ts`): both accept and refuse the same snapshots, which the shared vectors in
 * `test/vectors/registry-snapshot.vectors.json` check, with one difference: the relay list is
 * optional here, so a build can bundle definitions before the publisher's relay list exists, and
 * devices then refresh from {@link REGISTRY_FALLBACK_RELAYS}.
 */
import type { NostrEvent } from 'nostr-tools/core';
import { KIND_RELAY_LIST } from './kinds.ts';
import { capture, Invalid, type ParseResult } from './result.ts';
import {
  compareSiteVersions,
  parseSiteDefinitionEvent,
  type SiteDefinitionEvent,
} from './siteDef.ts';
import {
  checkKind,
  type JsonObject,
  parseJsonText,
  readRecord,
  readSignedEvent,
} from './validate.ts';

/**
 * The registry publisher's public key (hex), created 2026-11-05 (lokkju/qusme-registry,
 * `publisher/pubkey.json`). Builds pin it; a definition or relay list signed by any other key is
 * refused.
 */
export const REGISTRY_PUBLISHER =
  '144986dabaeeb884d105f2da2cac0008b3eb408bab0447a39894f87b7d94f54c';

/** The snapshot format this build reads. A change an older reader would misread gets a new number. */
export const REGISTRY_SNAPSHOT_FORMAT = 'qusme-registry-snapshot/1';

/**
 * Where devices look for the publisher's relay list when the bundled snapshot has none: the
 * publisher's own relays (decided 2026-11-05), which are also spec 9.1's recommended storage
 * relays.
 */
export const REGISTRY_FALLBACK_RELAYS: readonly string[] = [
  'wss://nos.lol',
  'wss://relay.ditto.pub',
];

const RELAY_URL = /^wss?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/;

export interface RegistryRelay {
  url: string;
  /** Absent: both read and write. */
  marker?: 'read' | 'write';
}

/** The publisher's NIP-65 relay list, verified. */
export interface RegistryRelayList {
  event: NostrEvent;
  relays: RegistryRelay[];
  /** Relays without a marker or marked `write`: where the publisher's events are fetched from. */
  writeRelays: string[];
}

/** A site definition event, verified, with its content as published for merging overrides. */
export interface RegistrySiteDefinition extends SiteDefinitionEvent {
  event: NostrEvent;
  /** The definition JSON exactly as signed; overrides merge over this (10.2), not the parse. */
  json: JsonObject;
}

/** The serialized snapshot, as `registry/snapshot.json` holds it. */
export interface RegistrySnapshot {
  format: typeof REGISTRY_SNAPSHOT_FORMAT;
  publisher: string;
  relayList?: NostrEvent;
  siteDefinitions: NostrEvent[];
}

/** A NIP-65 relay list signed by the publisher: signature, author, kind, and at least one relay. */
export function parseRegistryRelayList(
  event: unknown,
  options: { publisherPubkey: string }
): ParseResult<RegistryRelayList> {
  return capture(() => {
    const signed = readSignedEvent(event);
    checkKind(signed.kind, [KIND_RELAY_LIST]);
    if (signed.pubkey !== options.publisherPubkey) {
      throw new Invalid('wrong_author', 'not signed by the registry publisher key', 'pubkey');
    }
    const relays: RegistryRelay[] = [];
    for (const tag of signed.tags) {
      if (tag[0] !== 'r') continue;
      const url = tag[1] ?? '';
      if (!RELAY_URL.test(url)) throw new Invalid('invalid_tags', 'not a relay URL', 'tags.r');
      const marker = tag[2];
      relays.push(marker === 'read' || marker === 'write' ? { url, marker } : { url });
    }
    if (relays.length === 0) throw new Invalid('invalid_tags', 'no r tags', 'tags.r');
    const writeRelays = relays.filter((r) => r.marker !== 'read').map((r) => r.url);
    return { event: signed, relays, writeRelays };
  });
}

/** A `KIND_SITE_DEF` event signed by the publisher, with its content kept as published. */
export function parseRegistrySiteDefinition(
  event: unknown,
  options: { publisherPubkey: string }
): ParseResult<RegistrySiteDefinition> {
  const parsed = parseSiteDefinitionEvent(event, options);
  if (!parsed.ok) return parsed;
  return capture(() => {
    // parseSiteDefinitionEvent verified the event and parsed this content already.
    const signed = readSignedEvent(event);
    const json = readRecord(parseJsonText(signed.content), 'content') as JsonObject;
    return { ...parsed.value, event: signed, json };
  });
}

/**
 * Whether `candidate` should replace `current` for the same site: only a newer `version` does
 * (10.3). An equal version never replaces what a device holds, so a re-signed copy of the same
 * version changes nothing.
 */
export function isNewerSiteDefinition(
  candidate: Pick<SiteDefinitionEvent, 'definition'>,
  current: Pick<SiteDefinitionEvent, 'definition'> | undefined
): boolean {
  if (current === undefined) return true;
  return compareSiteVersions(candidate.definition.version, current.definition.version) > 0;
}

export interface RegistrySnapshotContents {
  /** Absent when the snapshot has none or it failed verification. */
  relayList?: RegistryRelayList;
  /** One per site, the newest version where the snapshot repeats one, in snapshot order. */
  definitions: RegistrySiteDefinition[];
  /** What was dropped and why: a path into the snapshot and the parser's message. */
  rejected: { path: string; reason: string }[];
}

/**
 * Reads a snapshot the lenient way a running service or device does: it never throws, keeps
 * every definition that verifies against the pinned key, and reports the rest in `rejected`. A
 * snapshot with the wrong format or publisher yields nothing.
 */
export function readRegistrySnapshot(
  value: unknown,
  pinnedPubkey: string
): RegistrySnapshotContents {
  const rejected: RegistrySnapshotContents['rejected'] = [];
  const empty = (path: string, reason: string): RegistrySnapshotContents => ({
    definitions: [],
    rejected: [{ path, reason }],
  });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return empty('', 'not an object');
  }
  const s = value as Partial<Record<keyof RegistrySnapshot, unknown>>;
  if (s.format !== REGISTRY_SNAPSHOT_FORMAT) {
    return empty('format', `not ${REGISTRY_SNAPSHOT_FORMAT}`);
  }
  if (s.publisher !== pinnedPubkey) return empty('publisher', 'not the pinned key');
  if (!Array.isArray(s.siteDefinitions)) return empty('siteDefinitions', 'missing');

  const out: RegistrySnapshotContents = { definitions: [], rejected };
  if (s.relayList !== undefined) {
    const relayList = parseRegistryRelayList(s.relayList, { publisherPubkey: pinnedPubkey });
    if (relayList.ok) out.relayList = relayList.value;
    else rejected.push({ path: 'relayList', reason: relayList.error.message });
  }
  const bySite = new Map<string, number>();
  s.siteDefinitions.forEach((event, i) => {
    const path = `siteDefinitions[${i}]`;
    const parsed = parseRegistrySiteDefinition(event, { publisherPubkey: pinnedPubkey });
    if (!parsed.ok) {
      rejected.push({ path, reason: parsed.error.message });
      return;
    }
    const { id } = parsed.value.definition;
    const at = bySite.get(id);
    if (at === undefined) {
      bySite.set(id, out.definitions.length);
      out.definitions.push(parsed.value);
      return;
    }
    rejected.push({ path, reason: `more than one event for ${id}` });
    if (isNewerSiteDefinition(parsed.value, out.definitions[at]))
      out.definitions[at] = parsed.value;
  });
  return out;
}

/**
 * Checks a snapshot strictly, as the registry's `verifySnapshot` does and as `pnpm
 * registry:update` does before writing one: the format, the publisher, the relay list when
 * present, and every site definition against the pinned key, one event per site. Throws on the
 * first failure.
 */
export function verifyRegistrySnapshot(
  value: unknown,
  pinnedPubkey: string
): { relayList?: RegistryRelayList; definitions: RegistrySiteDefinition[] } {
  const { relayList, definitions, rejected } = readRegistrySnapshot(value, pinnedPubkey);
  const first = rejected[0];
  if (first !== undefined) {
    throw new Error(`snapshot: ${first.path === '' ? '' : `${first.path}: `}${first.reason}`);
  }
  return relayList === undefined ? { definitions } : { relayList, definitions };
}
