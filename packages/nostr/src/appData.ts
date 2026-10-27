import type { NostrEvent } from 'nostr-tools/core';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { KIND_APP_DATA } from './kinds.ts';
import { NCRYPTSEC_MAX_LOG_N, type NcryptsecParams, ncryptsecParams } from './nip49.ts';
import { capture, captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkKeys,
  checkKind,
  decryptWith,
  isHex64,
  type JsonObject,
  joinPath,
  parseJsonText,
  readArray,
  readHex64,
  readInteger,
  readJsonObject,
  readOneOf,
  readRecord,
  readSignedEvent,
  readString,
  singleTag,
} from './validate.ts';

/** NIP-78 `d` tags (spec 6.1, 7.2). */
export const D_DESTINATIONS = 'qus.me/destinations';
export const D_SETTINGS = 'qus.me/settings';
export const D_RECOVERY = 'qus.me/recovery';
export const D_ROTATED = 'qus.me/rotated';

/** `archive_retention_days` when unset on a queue on the hosted relay (spec 7.2, 9.2). */
export const HOSTED_ARCHIVE_RETENTION_DAYS = 90;

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
}

export interface Destinations {
  destinations: Destination[];
}

/** One agent's ingestion record for the current quota period (spec 7.2, 11.4). */
export interface QuotaCount {
  period_start: number;
  accepted: string[];
  discarded: string[];
}

/** The settings event's content (spec 7.2). */
export interface Settings {
  /**
   * Days to keep archived drafts; `null` keeps them. Absent means the default for the relay, see
   * {@link archiveRetentionDays}.
   */
  archive_retention_days?: number | null;
  /** Keyed by agent pubkey. */
  quota_counts: Record<string, QuotaCount>;
}

/** An app data event's metadata alongside its decrypted content. */
export interface AppData<T> {
  id: string;
  pubkey: string;
  createdAt: number;
  content: T;
}

export interface RecoveryBackup {
  id: string;
  pubkey: string;
  createdAt: number;
  ncryptsec: string;
  params: NcryptsecParams;
}

export interface RotationMarker {
  id: string;
  /** The old queue pubkey that published the marker. */
  pubkey: string;
  createdAt: number;
  /** The new queue pubkey, hex. */
  newPubkey: string;
}

const ID_MAX = 128;

function readDestination(value: unknown, path: string): Destination {
  const record = readRecord(value, path);
  checkKeys(record, path, ['id', 'site', 'account', 'label', 'status', 'override']);
  const p = (key: string): string => joinPath(path, key);
  return {
    id: readString(record.id, p('id'), { nonEmpty: true, max: ID_MAX }),
    site: readString(record.site, p('site'), { nonEmpty: true }),
    account: readString(record.account, p('account'), { nonEmpty: true }),
    label: readString(record.label, p('label')),
    status: readOneOf(record.status, DESTINATION_STATUSES, p('status')),
    override: record.override === null ? null : readJsonObject(record.override, p('override')),
  };
}

/** Validates destinations content. Throws {@link Invalid}. */
export function readDestinations(value: unknown): Destinations {
  const record = readRecord(value, 'content');
  checkKeys(record, 'content', ['destinations']);
  const destinations = readArray(record.destinations, 'content.destinations').map((item, i) =>
    readDestination(item, `content.destinations[${i}]`)
  );
  if (new Set(destinations.map((d) => d.id)).size !== destinations.length) {
    throw new Invalid('invalid_content', 'repeats a destination id', 'content.destinations');
  }
  return { destinations };
}

function readIdList(value: unknown, path: string): string[] {
  return readArray(value, path).map((id, i) => readHex64(id, joinPath(path, i)));
}

/** Validates settings content. Throws {@link Invalid}. */
export function readSettings(value: unknown): Settings {
  const record = readRecord(value, 'content');
  checkKeys(record, 'content', [], ['archive_retention_days', 'quota_counts']);
  const settings: Settings = { quota_counts: {} };
  const retention = record.archive_retention_days;
  if (retention !== undefined) {
    settings.archive_retention_days =
      retention === null
        ? null
        : readInteger(retention, 'content.archive_retention_days', { min: 1 });
  }
  if (record.quota_counts !== undefined) {
    const counts = readRecord(record.quota_counts, 'content.quota_counts');
    for (const [agent, entry] of Object.entries(counts)) {
      const path = `content.quota_counts.${agent}`;
      if (!isHex64(agent)) throw new Invalid('invalid_content', 'key is not a pubkey', path);
      const count = readRecord(entry, path);
      checkKeys(count, path, ['period_start', 'accepted', 'discarded']);
      settings.quota_counts[agent] = {
        period_start: readInteger(count.period_start, `${path}.period_start`, { min: 0 }),
        accepted: readIdList(count.accepted, `${path}.accepted`),
        discarded: readIdList(count.discarded, `${path}.discarded`),
      };
    }
  }
  return settings;
}

/**
 * The effective `archive_retention_days`: the setting if present, otherwise 90 on the hosted
 * relay and `null` (keep) elsewhere (spec 7.2).
 */
export function archiveRetentionDays(settings: Settings, onHostedRelay: boolean): number | null {
  if (settings.archive_retention_days !== undefined) return settings.archive_retention_days;
  return onHostedRelay ? HOSTED_ARCHIVE_RETENTION_DAYS : null;
}

async function buildEncrypted(
  signer: Signer,
  d: string,
  content: unknown,
  createdAt: number | undefined
): Promise<NostrEvent> {
  const pubkey = await signer.getPublicKey();
  return signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    tags: [['d', d]],
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(content)),
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
  return { id: signed.id, pubkey: signed.pubkey, createdAt: signed.created_at, content };
}

function parseEncrypted<T>(
  event: unknown,
  signer: Signer,
  d: string,
  read: (value: unknown) => T
): Promise<ParseResult<AppData<T>>> {
  return captureAsync(() => readEncrypted(event, signer, d, read));
}

/** Builds the destinations event (kind 30078, `d` = `qus.me/destinations`), encrypted to self. */
export async function buildDestinations(
  signer: Signer,
  content: Destinations,
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  const checked = checkInput('destinations', () =>
    readDestinations(JSON.parse(JSON.stringify(content)))
  );
  return buildEncrypted(signer, D_DESTINATIONS, checked, options.createdAt);
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
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  const checked = checkInput('settings', () => readSettings(JSON.parse(JSON.stringify(content))));
  return buildEncrypted(signer, D_SETTINGS, checked, options.createdAt);
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
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  checkInput('ncryptsec', () => readNcryptsec(ncryptsec));
  return signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [['d', D_RECOVERY]],
    content: ncryptsec,
  });
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
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      createdAt: signed.created_at,
      ncryptsec: signed.content,
      params: readNcryptsec(signed.content),
    };
  });
}

/**
 * Builds the rotation marker under the old key (kind 30078, `d` = `qus.me/rotated`, spec 6.1):
 * content `{"npub": "<new npub>"}` encrypted to the old key.
 */
export async function buildRotationMarker(
  oldSigner: Signer,
  newPubkey: string,
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  if (!isHex64(newPubkey)) throw new Error('new pubkey must be 64 lowercase hex characters');
  return buildEncrypted(oldSigner, D_ROTATED, { npub: npubEncode(newPubkey) }, options.createdAt);
}

function readRotation(value: unknown): string {
  const record = readRecord(value, 'content');
  checkKeys(record, 'content', ['npub']);
  const npub = readString(record.npub, 'content.npub');
  try {
    const decoded = nip19Decode(npub);
    if (decoded.type === 'npub') return decoded.data;
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
    const { id, pubkey, createdAt, content } = await readEncrypted(
      event,
      oldSigner,
      D_ROTATED,
      readRotation
    );
    return { id, pubkey, createdAt, newPubkey: content };
  });
}
