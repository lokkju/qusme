/**
 * Where the extension keeps the queue key and the inbox key (spec 6.1, 6.4, 11.3).
 *
 * `storage.local` (survives restarts):
 * - `qusme.queue`: {@link QueueRecord}: the queue pubkey, the queue key's `ncryptsec` under the
 *   user's passphrase (NIP-49, `log_n` 18), the storage relays, a copy of the published recovery
 *   backup event (a typed-code pairing sends it, 8.3) and the settings event, which is
 *   NIP-44-encrypted to the queue key and holds the inbox key (7.2). So the inbox key at rest is
 *   behind the queue key, which is behind the passphrase.
 * - `qusme.stayUnlocked`: the "stay unlocked on this device" choice, off unless the user turns it
 *   on.
 * - `qusme.plainKeys`: the unlocked keys, hex, only while "stay unlocked" is on and the queue is
 *   unlocked. Lock and turning the option off delete it.
 * - `qusme.pendingImport`: a pairing payload (an `ncryptsec`) stored before the user unlocks it,
 *   since the new device sends `complete` first (8.3 step 6).
 *
 * `storage.session` (memory only, cleared when the browser closes, readable only by extension
 * pages and the service worker):
 * - `qusme.unlocked`: the unlocked queue key and inbox key, hex.
 *
 * Lock deletes `qusme.unlocked` and `qusme.plainKeys`.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  createLocalSigner,
  decodeNcryptsec,
  encodeNcryptsec,
  NCRYPTSEC_DEFAULT_LOG_N,
  type NostrEvent,
  parseSettings,
  type UnlockSecret,
} from '@qusme/nostr';
import { getPublicKey } from 'nostr-tools/pure';
import type { StorageArea } from './storage.ts';

export const LOCAL_QUEUE = 'qusme.queue';
export const LOCAL_STAY_UNLOCKED = 'qusme.stayUnlocked';
export const LOCAL_PLAIN_KEYS = 'qusme.plainKeys';
export const LOCAL_PENDING_IMPORT = 'qusme.pendingImport';
export const SESSION_UNLOCKED = 'qusme.unlocked';

export interface QueueRecord {
  version: 1;
  /** The queue pubkey, hex. */
  pubkey: string;
  /** The queue key under the user's passphrase. */
  ncryptsec: string;
  /** The storage relays, from the queue's kind 10013. */
  storageRelays: string[];
  /** The published recovery backup event, kept for typed-code pairing (6.1, 8.3). */
  recoveryBackup?: NostrEvent;
  /** The settings event (7.2), encrypted to the queue key; holds the inbox key. */
  settings?: NostrEvent;
}

/** A pairing payload held between `complete` and the user's unlock (8.3 steps 6, 7). */
export interface PendingImport {
  ncryptsec: string;
  unlockWith: UnlockSecret;
  relays?: string[];
  queuePubkey?: string;
  receivedAt: number;
}

interface HexKeys {
  queue: string;
  inbox?: string;
}

export interface UnlockedQueue {
  record: QueueRecord;
  queueKey: Uint8Array;
  /** Absent when the queue has no readable settings event yet. */
  inboxKey?: Uint8Array;
}

export type KeyStatus =
  | { state: 'empty' }
  | { state: 'locked'; pubkey: string; stayUnlocked: boolean }
  | { state: 'unlocked'; pubkey: string; stayUnlocked: boolean };

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase does not unlock this queue.');
  }
}

export interface KeyStoreOptions {
  /** scrypt cost for the local `ncryptsec`; tests lower it. Defaults to 18 (spec 6.1). */
  logN?: number;
}

export interface SaveInput {
  secretKey: Uint8Array;
  passphrase: string;
  storageRelays: string[];
  recoveryBackup?: NostrEvent;
  settings?: NostrEvent;
  /** Use this `ncryptsec` as the local copy instead of encrypting again (already under `passphrase`). */
  ncryptsec?: string;
}

const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function readHexKeys(value: unknown): HexKeys | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { queue, inbox } = value as Record<string, unknown>;
  if (!isHex64(queue)) return undefined;
  return isHex64(inbox) ? { queue, inbox } : { queue };
}

export class KeyStore {
  readonly local: StorageArea;
  readonly session: StorageArea;
  readonly logN: number;

  constructor(areas: { local: StorageArea; session: StorageArea }, options: KeyStoreOptions = {}) {
    this.local = areas.local;
    this.session = areas.session;
    this.logN = options.logN ?? NCRYPTSEC_DEFAULT_LOG_N;
  }

  async record(): Promise<QueueRecord | undefined> {
    const value = (await this.local.get([LOCAL_QUEUE]))[LOCAL_QUEUE];
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as QueueRecord;
    return record.version === 1 && isHex64(record.pubkey) ? record : undefined;
  }

  async stayUnlocked(): Promise<boolean> {
    return (await this.local.get([LOCAL_STAY_UNLOCKED]))[LOCAL_STAY_UNLOCKED] === true;
  }

  /**
   * Whether there is a queue and whether it is unlocked. With "stay unlocked" on, a browser
   * restart cleared `storage.session`; this copies the kept keys back.
   */
  async status(): Promise<KeyStatus> {
    const record = await this.record();
    if (record === undefined) return { state: 'empty' };
    const stayUnlocked = await this.stayUnlocked();
    let keys = await this.#sessionKeys();
    if (keys === undefined && stayUnlocked) {
      const plain = readHexKeys((await this.local.get([LOCAL_PLAIN_KEYS]))[LOCAL_PLAIN_KEYS]);
      if (plain !== undefined && plain.queue !== undefined) {
        await this.session.set({ [SESSION_UNLOCKED]: plain });
        keys = plain;
      }
    }
    const unlocked = keys !== undefined && getPublicKey(hexToBytes(keys.queue)) === record.pubkey;
    return unlocked
      ? { state: 'unlocked', pubkey: record.pubkey, stayUnlocked }
      : { state: 'locked', pubkey: record.pubkey, stayUnlocked };
  }

  async #sessionKeys(): Promise<HexKeys | undefined> {
    return readHexKeys((await this.session.get([SESSION_UNLOCKED]))[SESSION_UNLOCKED]);
  }

  /** The unlocked keys and the record, or undefined while locked. */
  async unlocked(): Promise<UnlockedQueue | undefined> {
    const status = await this.status();
    if (status.state !== 'unlocked') return undefined;
    const record = (await this.record()) as QueueRecord;
    const keys = (await this.#sessionKeys()) as HexKeys;
    const result: UnlockedQueue = { record, queueKey: hexToBytes(keys.queue) };
    if (keys.inbox !== undefined) result.inboxKey = hexToBytes(keys.inbox);
    return result;
  }

  /**
   * Stores a queue key under a passphrase, with what setup learned about the queue, and leaves
   * it unlocked. Replaces any queue already stored.
   */
  async save(input: SaveInput): Promise<void> {
    const ncryptsec =
      input.ncryptsec ?? encodeNcryptsec(input.secretKey, input.passphrase, { logN: this.logN });
    const record: QueueRecord = {
      version: 1,
      pubkey: getPublicKey(input.secretKey),
      ncryptsec,
      storageRelays: [...input.storageRelays],
    };
    if (input.recoveryBackup !== undefined) record.recoveryBackup = input.recoveryBackup;
    if (input.settings !== undefined) record.settings = input.settings;
    await this.local.remove([LOCAL_PLAIN_KEYS, LOCAL_PENDING_IMPORT]);
    await this.local.set({ [LOCAL_QUEUE]: record });
    await this.session.remove([SESSION_UNLOCKED]);
    await this.#open(record, input.secretKey);
  }

  /** Replaces parts of the stored record (a newer settings event or backup copy). */
  async update(patch: Partial<Pick<QueueRecord, 'storageRelays' | 'recoveryBackup' | 'settings'>>) {
    const record = await this.record();
    if (record === undefined) throw new Error('no queue is stored');
    await this.local.set({ [LOCAL_QUEUE]: { ...record, ...patch } });
  }

  /** Unlocks with the passphrase. Throws {@link WrongPassphrase}. */
  async unlock(passphrase: string): Promise<void> {
    const record = await this.record();
    if (record === undefined) throw new Error('no queue is stored');
    let secretKey: Uint8Array;
    try {
      secretKey = decodeNcryptsec(record.ncryptsec, passphrase);
    } catch {
      throw new WrongPassphrase();
    }
    if (getPublicKey(secretKey) !== record.pubkey) throw new WrongPassphrase();
    await this.#open(record, secretKey);
    secretKey.fill(0);
  }

  /** Writes the unlocked keys to the session, and locally too if "stay unlocked" is on. */
  async #open(record: QueueRecord, secretKey: Uint8Array): Promise<void> {
    const keys: HexKeys = { queue: bytesToHex(secretKey) };
    const inbox = await inboxKeyOf(record, secretKey);
    if (inbox !== undefined) keys.inbox = inbox;
    await this.session.set({ [SESSION_UNLOCKED]: keys });
    if (await this.stayUnlocked()) await this.local.set({ [LOCAL_PLAIN_KEYS]: keys });
  }

  /** Forgets the unlocked keys everywhere; the next use needs the passphrase. */
  async lock(): Promise<void> {
    await this.session.remove([SESSION_UNLOCKED]);
    await this.local.remove([LOCAL_PLAIN_KEYS]);
  }

  /**
   * "Stay unlocked on this device" (6.1): on, the unlocked keys are also kept unencrypted in
   * `storage.local` so a browser restart doesn't ask for the passphrase; off deletes that copy.
   */
  async setStayUnlocked(on: boolean): Promise<void> {
    await this.local.set({ [LOCAL_STAY_UNLOCKED]: on });
    if (!on) {
      await this.local.remove([LOCAL_PLAIN_KEYS]);
      return;
    }
    const keys = await this.#sessionKeys();
    if (keys !== undefined) await this.local.set({ [LOCAL_PLAIN_KEYS]: keys });
  }

  async setPendingImport(pending: PendingImport): Promise<void> {
    await this.local.set({ [LOCAL_PENDING_IMPORT]: pending });
  }

  async pendingImport(): Promise<PendingImport | undefined> {
    const value = (await this.local.get([LOCAL_PENDING_IMPORT]))[LOCAL_PENDING_IMPORT];
    if (typeof value !== 'object' || value === null) return undefined;
    const pending = value as PendingImport;
    return typeof pending.ncryptsec === 'string' ? pending : undefined;
  }

  async clearPendingImport(): Promise<void> {
    await this.local.remove([LOCAL_PENDING_IMPORT]);
  }

  /** Deletes everything this store wrote. */
  async forget(): Promise<void> {
    await this.session.remove([SESSION_UNLOCKED]);
    await this.local.remove([
      LOCAL_QUEUE,
      LOCAL_STAY_UNLOCKED,
      LOCAL_PLAIN_KEYS,
      LOCAL_PENDING_IMPORT,
    ]);
  }
}

/** The inbox key from the record's settings event, decrypted with the queue key, as hex. */
async function inboxKeyOf(record: QueueRecord, secretKey: Uint8Array): Promise<string | undefined> {
  if (record.settings === undefined) return undefined;
  const parsed = await parseSettings(record.settings, createLocalSigner(secretKey));
  return parsed.ok ? parsed.value.content.inbox_key : undefined;
}
