import type { NostrEvent } from 'nostr-tools/core';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { KIND_APP_DATA } from './kinds.ts';
import { NCRYPTSEC_MAX_LOG_N, type NcryptsecParams, ncryptsecParams } from './nip49.ts';
import { capture, captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkExtraTags,
  checkKind,
  decryptWith,
  extraTagsOf,
  isHex64,
  type JsonObject,
  type JsonValue,
  joinPath,
  parseJsonText,
  readArray,
  readExtra,
  readHex64,
  readInteger,
  readJsonObject,
  readOneOf,
  readRecord,
  readRelayUrl,
  readSignedEvent,
  readString,
  singleTag,
  withExtra,
} from './validate.ts';

/** NIP-78 `d` tags (spec 6.1, 7.2). */
export const D_DESTINATIONS = 'qus.me/destinations';
export const D_SETTINGS = 'qus.me/settings';
export const D_RECOVERY = 'qus.me/recovery';
export const D_ROTATED = 'qus.me/rotated';
/**
 * The NIP-32 label namespace of the recovery backup's lookup tag (6.1): `["L", ns]` and
 * `["l", <recoveryLookupTag>, ns]`. Relays index the single-letter `l`, so a device holding only
 * the recovery code asks for `#l` and needs no npub.
 */
export const RECOVERY_LOOKUP_NAMESPACE = 'qus.me/recovery-lookup';

/** `archive_retention_days` when the settings leave it unset, on any relay (spec 7.2; D30). */
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;

export const DESTINATION_STATUSES = ['confirmed', 'pending'] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

/** One destination (spec 7.2). Keys are the JSON keys. */
export interface Destination {
  id: string;
  site: string;
  account: string;
  label: string;
  status: DestinationStatus;
  /** A partial site definition merged over the official one (10.2); validated when merged. */
  override: JsonObject | null;
  /** Keys this version does not know, kept for republishing (spec 7, "Unknown fields"). */
  extra?: JsonObject;
}

export interface Destinations {
  destinations: Destination[];
  extra?: JsonObject;
}

/** One agent's ingestion record for the current quota period (spec 7.2, 11.4). */
export interface QuotaCount {
  period_start: number;
  accepted: string[];
  discarded: string[];
  extra?: JsonObject;
}

/** An inbox key that was replaced and is still drained until its grants' wraps expire (6.4). */
export interface RetiredInboxKey {
  /** The retired inbox secret key, hex. */
  key: string;
  retired_at: number;
  extra?: JsonObject;
}

/** The settings event's content (spec 7.2). */
export interface Settings {
  /**
   * Days to keep archived drafts; `null` keeps them. Absent means the default, see
   * {@link archiveRetentionDays}.
   */
  archive_retention_days?: number | null;
  /** The inbox secret key, hex (6.4). Every queue set up by v0.4 devices has one. */
  inbox_key?: string;
  /** The relays devices read the inbox key's gift wraps on (9.1). */
  inbox_relays?: string[];
  retired_inbox_keys?: RetiredInboxKey[];
  /** Keyed by agent pubkey. */
  quota_counts: Record<string, QuotaCount>;
  extra?: JsonObject;
}

/** An app data event's metadata alongside its decrypted content. */
export interface AppData<T> {
  id: string;
  pubkey: string;
  createdAt: number;
  content: T;
  /** Event tags other than `d`, kept for republishing. */
  extraTags?: string[][];
}

export interface RecoveryBackup {
  id: string;
  pubkey: string;
  createdAt: number;
  ncryptsec: string;
  params: NcryptsecParams;
  extraTags?: string[][];
}

export interface RotationMarker {
  id: string;
  /** The old queue pubkey that published the marker. */
  pubkey: string;
  createdAt: number;
  /** The new queue pubkey, hex. */
  newPubkey: string;
  /** Content keys other than `npub`. */
  extra?: JsonObject;
  extraTags?: string[][];
}

/** Options every NIP-78 builder takes; `extraTags` are written after `d`, as parsed. */
export interface AppDataOptions {
  createdAt?: number;
  extraTags?: string[][];
}

const ID_MAX = 128;
const DESTINATION_KEYS = ['id', 'site', 'account', 'label', 'status', 'override'];
const QUOTA_COUNT_KEYS = ['period_start', 'accepted', 'discarded'];
const RETIRED_INBOX_KEYS = ['key', 'retired_at'];
const SETTINGS_KEYS = [
  'archive_retention_days',
  'inbox_key',
  'inbox_relays',
  'retired_inbox_keys',
  'quota_counts',
];

function readDestination(value: unknown, path: string): Destination {
  const record = readRecord(value, path);
  const extra = readExtra(record, path, DESTINATION_KEYS, DESTINATION_KEYS);
  const p = (key: string): string => joinPath(path, key);
  const destination: Destination = {
    id: readString(record.id, p('id'), { nonEmpty: true, max: ID_MAX }),
    site: readString(record.site, p('site'), { nonEmpty: true }),
    account: readString(record.account, p('account'), { nonEmpty: true }),
    label: readString(record.label, p('label')),
    status: readOneOf(record.status, DESTINATION_STATUSES, p('status')),
    override: record.override === null ? null : readJsonObject(record.override, p('override')),
  };
  if (extra !== undefined) destination.extra = extra;
  return destination;
}

/** Validates destinations content, keeping unknown keys. Throws {@link Invalid}. */
export function readDestinations(value: unknown): Destinations {
  const record = readRecord(value, 'content');
  const extra = readExtra(record, 'content', ['destinations'], ['destinations']);
  const destinations = readArray(record.destinations, 'content.destinations').map((item, i) =>
    readDestination(item, `content.destinations[${i}]`)
  );
  if (new Set(destinations.map((d) => d.id)).size !== destinations.length) {
    throw new Invalid('invalid_content', 'repeats a destination id', 'content.destinations');
  }
  return extra === undefined ? { destinations } : { destinations, extra };
}

/** The wire JSON of destinations: known keys in spec order, then each object's extra keys. */
export function writeDestinations(content: Destinations): JsonObject {
  const destinations = content.destinations.map((d) =>
    withExtra(
      [
        ['id', d.id],
        ['site', d.site],
        ['account', d.account],
        ['label', d.label],
        ['status', d.status],
        ['override', d.override],
      ],
      d.extra,
      DESTINATION_KEYS
    )
  );
  return withExtra([['destinations', destinations]], content.extra, ['destinations']);
}

function readIdList(value: unknown, path: string): string[] {
  return readArray(value, path).map((id, i) => readHex64(id, joinPath(path, i)));
}

/** Validates settings content, keeping unknown keys. Throws {@link Invalid}. */
export function readSettings(value: unknown): Settings {
  const record = readRecord(value, 'content');
  const extra = readExtra(record, 'content', [], SETTINGS_KEYS);
  const settings: Settings = { quota_counts: {} };
  const retention = record.archive_retention_days;
  if (retention !== undefined) {
    settings.archive_retention_days =
      retention === null
        ? null
        : readInteger(retention, 'content.archive_retention_days', { min: 1 });
  }
  if (record.inbox_key !== undefined) {
    settings.inbox_key = readHex64(record.inbox_key, 'content.inbox_key');
  }
  if (record.inbox_relays !== undefined) {
    settings.inbox_relays = readArray(record.inbox_relays, 'content.inbox_relays').map((url, i) =>
      readRelayUrl(url, `content.inbox_relays[${i}]`)
    );
  }
  if (record.retired_inbox_keys !== undefined) {
    settings.retired_inbox_keys = readArray(
      record.retired_inbox_keys,
      'content.retired_inbox_keys'
    ).map((item, i) => {
      const path = `content.retired_inbox_keys[${i}]`;
      const entry = readRecord(item, path);
      const entryExtra = readExtra(entry, path, RETIRED_INBOX_KEYS, RETIRED_INBOX_KEYS);
      const retired: RetiredInboxKey = {
        key: readHex64(entry.key, `${path}.key`),
        retired_at: readInteger(entry.retired_at, `${path}.retired_at`, { min: 0 }),
      };
      if (entryExtra !== undefined) retired.extra = entryExtra;
      return retired;
    });
  }
  if (record.quota_counts !== undefined) {
    const counts = readRecord(record.quota_counts, 'content.quota_counts');
    for (const [agent, entry] of Object.entries(counts)) {
      const path = `content.quota_counts.${agent}`;
      if (!isHex64(agent)) throw new Invalid('invalid_content', 'key is not a pubkey', path);
      const count = readRecord(entry, path);
      const countExtra = readExtra(count, path, QUOTA_COUNT_KEYS, QUOTA_COUNT_KEYS);
      const parsed: QuotaCount = {
        period_start: readInteger(count.period_start, `${path}.period_start`, { min: 0 }),
        accepted: readIdList(count.accepted, `${path}.accepted`),
        discarded: readIdList(count.discarded, `${path}.discarded`),
      };
      if (countExtra !== undefined) parsed.extra = countExtra;
      settings.quota_counts[agent] = parsed;
    }
  }
  if (extra !== undefined) settings.extra = extra;
  return settings;
}

/** The wire JSON of settings: known keys in spec order, then extra keys. */
export function writeSettings(content: Settings): JsonObject {
  const counts: JsonObject = {};
  for (const [agent, count] of Object.entries(content.quota_counts)) {
    counts[agent] = withExtra(
      [
        ['period_start', count.period_start],
        ['accepted', count.accepted],
        ['discarded', count.discarded],
      ],
      count.extra,
      QUOTA_COUNT_KEYS
    );
  }
  const retired = content.retired_inbox_keys?.map((entry) =>
    withExtra(
      [
        ['key', entry.key],
        ['retired_at', entry.retired_at],
      ],
      entry.extra,
      RETIRED_INBOX_KEYS
    )
  );
  return withExtra(
    [
      ['archive_retention_days', content.archive_retention_days],
      ['inbox_key', content.inbox_key],
      ['inbox_relays', content.inbox_relays],
      ['retired_inbox_keys', retired],
      ['quota_counts', counts],
    ],
    content.extra,
    SETTINGS_KEYS
  );
}

/**
 * The effective `archive_retention_days`: the setting if present (`null` keeps archived drafts),
 * otherwise {@link DEFAULT_ARCHIVE_RETENTION_DAYS} on any relay (spec 7.2; D30).
 */
export function archiveRetentionDays(settings: Settings): number | null {
  if (settings.archive_retention_days !== undefined) return settings.archive_retention_days;
  return DEFAULT_ARCHIVE_RETENTION_DAYS;
}

function appDataTags(d: string, extraTags: string[][] | undefined): string[][] {
  return [['d', d], ...checkExtraTags(extraTags, ['d'])];
}

async function buildEncrypted(
  signer: Signer,
  d: string,
  wire: JsonValue,
  options: AppDataOptions
): Promise<NostrEvent> {
  const pubkey = await signer.getPublicKey();
  return signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: appDataTags(d, options.extraTags),
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(wire)),
  });
}

function readAppDataEvent(event: unknown, d: string): NostrEvent {
  const signed = readSignedEvent(event);
  checkKind(signed.kind, [KIND_APP_DATA]);
  if (singleTag(signed.tags, 'd', true) !== d)
    throw new Invalid('invalid_tags', `d is not ${d}`, 'tags.d');
  return signed;
}

async function readEncrypted<T>(
  event: unknown,
  signer: Signer,
  d: string,
  read: (value: unknown) => T
): Promise<AppData<T>> {
  const signed = readAppDataEvent(event, d);
  const owner = await signer.getPublicKey();
  if (signed.pubkey !== owner)
    throw new Invalid('wrong_author', 'not signed by this key', 'pubkey');
  const content = read(parseJsonText(await decryptWith(signer, owner, signed.content)));
  const result: AppData<T> = {
    id: signed.id,
    pubkey: signed.pubkey,
    createdAt: signed.created_at,
    content,
  };
  const extraTags = extraTagsOf(signed.tags, ['d']);
  if (extraTags !== undefined) result.extraTags = extraTags;
  return result;
}

function parseEncrypted<T>(
  event: unknown,
  signer: Signer,
  d: string,
  read: (value: unknown) => T
): Promise<ParseResult<AppData<T>>> {
  return captureAsync(() => readEncrypted(event, signer, d, read));
}

// Serializes with `write`, then checks the result parses back with `read`.
function checkedWire<T>(
  what: string,
  value: T,
  write: (v: T) => JsonObject,
  read: (v: unknown) => unknown
): JsonObject {
  let wire: JsonObject;
  try {
    wire = write(value);
  } catch (error) {
    throw new Error(`invalid ${what}: ${(error as Error).message}`);
  }
  checkInput(what, () => read(parseJsonText(JSON.stringify(wire))));
  return wire;
}

/**
 * Builds the destinations event (kind 30078, `d` = `qus.me/destinations`), encrypted to self.
 * Extra keys from a parse are written back after the known ones.
 */
export async function buildDestinations(
  signer: Signer,
  content: Destinations,
  options: AppDataOptions = {}
): Promise<NostrEvent> {
  const wire = checkedWire('destinations', content, writeDestinations, readDestinations);
  return buildEncrypted(signer, D_DESTINATIONS, wire, options);
}

export function parseDestinations(
  event: unknown,
  signer: Signer
): Promise<ParseResult<AppData<Destinations>>> {
  return parseEncrypted(event, signer, D_DESTINATIONS, readDestinations);
}

/** Builds the settings event (kind 30078, `d` = `qus.me/settings`), encrypted to self. */
export async function buildSettings(
  signer: Signer,
  content: Settings,
  options: AppDataOptions = {}
): Promise<NostrEvent> {
  const wire = checkedWire('settings', content, writeSettings, readSettings);
  return buildEncrypted(signer, D_SETTINGS, wire, options);
}

export function parseSettings(
  event: unknown,
  signer: Signer
): Promise<ParseResult<AppData<Settings>>> {
  return parseEncrypted(event, signer, D_SETTINGS, readSettings);
}

function readNcryptsec(text: string): NcryptsecParams {
  let params: NcryptsecParams;
  try {
    params = ncryptsecParams(text);
  } catch (error) {
    throw new Invalid(
      'invalid_content',
      `not an ncryptsec: ${(error as Error).message}`,
      'content'
    );
  }
  if (params.logN > NCRYPTSEC_MAX_LOG_N) {
    throw new Invalid('invalid_content', `log_n above ${NCRYPTSEC_MAX_LOG_N}`, 'content');
  }
  return params;
}

/**
 * Builds the recovery backup (kind 30078, `d` = `qus.me/recovery`, spec 6.1). Its content is the
 * `ncryptsec` itself, unencrypted: a recovering device does not hold the key yet.
 */
export async function buildRecoveryBackup(
  signer: Signer,
  ncryptsec: string,
  options: AppDataOptions & { lookup?: string } = {}
): Promise<NostrEvent> {
  checkInput('ncryptsec', () => readNcryptsec(ncryptsec));
  const extraTags =
    options.lookup === undefined
      ? options.extraTags
      : withRecoveryLookup(options.extraTags, options.lookup);
  return signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: appDataTags(D_RECOVERY, extraTags),
    content: ncryptsec,
  });
}

/** `extraTags` with the recovery lookup label set to `lookup`, replacing any earlier one. */
export function withRecoveryLookup(extraTags: string[][] | undefined, lookup: string): string[][] {
  if (!isHex64(lookup)) throw new Error('lookup must be 64 lowercase hex characters');
  const kept = (extraTags ?? []).filter(
    (t) =>
      !(t[0] === 'L' && t[1] === RECOVERY_LOOKUP_NAMESPACE) &&
      !(t[0] === 'l' && t[2] === RECOVERY_LOOKUP_NAMESPACE)
  );
  return [...kept, ['L', RECOVERY_LOOKUP_NAMESPACE], ['l', lookup, RECOVERY_LOOKUP_NAMESPACE]];
}

/** The backup's lookup tag, or undefined for a backup published before it had one. */
export function recoveryLookupOf(backup: { extraTags?: string[][] }): string | undefined {
  const tag = backup.extraTags?.find((t) => t[0] === 'l' && t[2] === RECOVERY_LOOKUP_NAMESPACE);
  return tag !== undefined && isHex64(tag[1]) ? tag[1] : undefined;
}

/**
 * Parses a recovery backup. With `queuePubkey`, the event must be signed by that key, as when a
 * device recovers from the npub the user typed.
 */
export function parseRecoveryBackup(
  event: unknown,
  options: { queuePubkey?: string } = {}
): ParseResult<RecoveryBackup> {
  return capture(() => {
    const signed = readAppDataEvent(event, D_RECOVERY);
    if (options.queuePubkey !== undefined && signed.pubkey !== options.queuePubkey) {
      throw new Invalid('wrong_author', 'not signed by the queue key', 'pubkey');
    }
    const backup: RecoveryBackup = {
      id: signed.id,
      pubkey: signed.pubkey,
      createdAt: signed.created_at,
      ncryptsec: signed.content,
      params: readNcryptsec(signed.content),
    };
    const extraTags = extraTagsOf(signed.tags, ['d']);
    if (extraTags !== undefined) backup.extraTags = extraTags;
    return backup;
  });
}

/**
 * Builds the rotation marker under the old key (kind 30078, `d` = `qus.me/rotated`, spec 6.1):
 * content `{"npub": "<new npub>"}`, then any `extra` keys, encrypted to the old key.
 */
export async function buildRotationMarker(
  oldSigner: Signer,
  newPubkey: string,
  options: AppDataOptions & { extra?: JsonObject } = {}
): Promise<NostrEvent> {
  if (!isHex64(newPubkey)) throw new Error('new pubkey must be 64 lowercase hex characters');
  const wire = checkedWire(
    'rotation marker',
    options.extra,
    (extra) => withExtra([['npub', npubEncode(newPubkey)]], extra, ['npub']),
    readRotation
  );
  return buildEncrypted(oldSigner, D_ROTATED, wire, options);
}

function readRotation(value: unknown): { newPubkey: string; extra: JsonObject | undefined } {
  const record = readRecord(value, 'content');
  const extra = readExtra(record, 'content', ['npub'], ['npub']);
  const npub = readString(record.npub, 'content.npub');
  try {
    const decoded = nip19Decode(npub);
    if (decoded.type === 'npub') return { newPubkey: decoded.data, extra };
  } catch {
    // reported below
  }
  throw new Invalid('invalid_content', 'not an npub', 'content.npub');
}

/**
 * Parses a rotation marker with the old key's signer. A device tells the user and offers pairing;
 * it never switches keys on the marker alone (6.1).
 */
export function parseRotationMarker(
  event: unknown,
  oldSigner: Signer
): Promise<ParseResult<RotationMarker>> {
  return captureAsync(async () => {
    const { id, pubkey, createdAt, content, extraTags } = await readEncrypted(
      event,
      oldSigner,
      D_ROTATED,
      readRotation
    );
    const marker: RotationMarker = { id, pubkey, createdAt, newPubkey: content.newPubkey };
    if (content.extra !== undefined) marker.extra = content.extra;
    if (extraTags !== undefined) marker.extraTags = extraTags;
    return marker;
  });
}
