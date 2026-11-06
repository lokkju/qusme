/**
 * Recovering a queue from its published backup (spec 6.1, 11.3): the queue npub and the recovery
 * code open the backup; then the user chooses a passphrase for the local copy. The backup is
 * looked up on the storage relays the user gives (from the recovery sheet), or, given none, on the
 * default storage relays (9.1), where most queues live; only when it isn't there does the user
 * need a relay URL.
 */

import {
  createLocalSigner,
  D_RECOVERY,
  decodeNcryptsec,
  KIND_APP_DATA,
  KIND_PRIVATE_RELAYS,
  type NostrEvent,
  newestFirst,
  parseRecoveryBackup,
  parseRecoveryCode,
  type RecoveryBackup,
  recoveryPassword,
} from '@qusme/nostr';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { checkPassphrase } from '../passphrase.ts';
import { DEFAULT_STORAGE_RELAYS } from './create.ts';
import {
  cleanRelayUrl,
  closeAll,
  loadQueueState,
  openRelays,
  type SetupDeps,
  SetupError,
} from './deps.ts';

/** The queue pubkey (hex) from an npub, or from 64 hex characters. */
export function readQueuePubkey(input: string): string | undefined {
  const text = input.trim();
  if (/^[0-9a-f]{64}$/.test(text)) return text;
  if (!text.startsWith('npub1')) return undefined;
  try {
    const decoded = nip19Decode(text);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

export interface FetchedBackup {
  /** The relay the backup came from. */
  relayUrl: string;
  /** Every relay that holds the queue's backup or its kind 10013; where recovery reads next. */
  relays: string[];
  queuePubkey: string;
  backup: RecoveryBackup;
  event: NostrEvent;
}

/** The backup is on none of the relays asked; {@link askedDefaults} when those were the defaults. */
export class BackupNotFound extends SetupError {
  readonly askedDefaults: boolean;
  constructor(message: string, askedDefaults: boolean) {
    super(message);
    this.askedDefaults = askedDefaults;
  }
}

/**
 * Fetches the newest recovery backup signed by the queue key from one relay. A relay that asks
 * for AUTH gets a throwaway key, never anything linked to the queue (spec 9.2).
 */
export async function fetchRecoveryBackup(
  input: { relayUrl: string; npub: string },
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>
): Promise<FetchedBackup> {
  const relayUrl = cleanRelayUrl(input.relayUrl);
  if (relayUrl === undefined) throw new SetupError('That is not a wss:// relay URL.');
  return findRecoveryBackup({ npub: input.npub, relays: [relayUrl] }, deps);
}

/**
 * Looks the queue up on `relays`, or on the default storage relays (9.1) when none are given:
 * its recovery backup and its kind 10013, which marks a relay as one of the queue's storage
 * relays even where the backup is missing. Returns the newest valid backup and every relay that
 * holds either, so the 10013 can be read from them once the key is open. AUTH, where asked, is
 * with a throwaway key (9.2).
 */
export async function findRecoveryBackup(
  input: { npub: string; relays?: readonly string[] },
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs' | 'defaultStorageRelays'>
): Promise<FetchedBackup> {
  const queuePubkey = readQueuePubkey(input.npub);
  if (queuePubkey === undefined) {
    throw new SetupError(
      'That is not a Queue ID: it starts with npub1 and is on your recovery sheet.'
    );
  }
  const askedDefaults = input.relays === undefined || input.relays.length === 0;
  const relays = askedDefaults
    ? [...(deps.defaultStorageRelays ?? DEFAULT_STORAGE_RELAYS)]
    : [...(input.relays ?? [])];
  const throwaway = generateSecretKey();
  const signer = createLocalSigner(throwaway);
  throwaway.fill(0);
  const { connections, failed } = await openRelays(relays, deps, (t) => signer.signEvent(t));
  if (connections.length === 0) {
    throw new SetupError(`Could not reach ${failed.map((f) => f.url).join(', ')}.`);
  }
  try {
    const answers = await Promise.allSettled(
      connections.map((connection) =>
        connection.query([
          { kinds: [KIND_APP_DATA], authors: [queuePubkey], '#d': [D_RECOVERY] },
          { kinds: [KIND_PRIVATE_RELAYS], authors: [queuePubkey] },
        ])
      )
    );
    const holding: string[] = [];
    let best: { relayUrl: string; backup: RecoveryBackup; event: NostrEvent } | undefined;
    const refused: string[] = [];
    answers.forEach((answer, i) => {
      const url = (connections[i] as (typeof connections)[number]).url;
      if (answer.status === 'rejected') {
        refused.push(`${url} refused the request: ${(answer.reason as Error).message}`);
        return;
      }
      const mine = answer.value.filter((e) => e.pubkey === queuePubkey);
      if (mine.length > 0) holding.push(url);
      for (const event of mine.filter((e) => e.kind === KIND_APP_DATA).sort(newestFirst)) {
        const parsed = parseRecoveryBackup(event, { queuePubkey });
        if (!parsed.ok) continue;
        if (best === undefined || newestFirst(event, best.event) < 0) {
          best = { relayUrl: url, backup: parsed.value, event };
        }
        break;
      }
    });
    if (best !== undefined) return { ...best, relays: holding, queuePubkey };
    if (refused.length > 0 && refused.length === connections.length) {
      throw new SetupError(refused.join('; '));
    }
    if (askedDefaults) {
      throw new BackupNotFound(
        `This queue isn’t on the default storage servers (${relays.join(', ')}). Enter one of the storage servers on your recovery sheet.`,
        true
      );
    }
    throw new BackupNotFound(
      relays.length === 1
        ? 'No recovery backup for that npub on that relay.'
        : `No recovery backup for that Queue ID on ${relays.join(', ')}.`,
      false
    );
  } finally {
    closeAll(connections);
  }
}

/** Opens the backup with the recovery code (either form). Returns the queue key. */
export function openRecoveryBackup(fetched: FetchedBackup, recoveryCode: string): Uint8Array {
  const bytes = parseRecoveryCode(recoveryCode);
  if (bytes === undefined) {
    throw new SetupError('That is not a recovery code: 12 words, or 26 letters and digits.');
  }
  let secretKey: Uint8Array;
  try {
    secretKey = decodeNcryptsec(fetched.backup.ncryptsec, recoveryPassword(bytes));
  } catch {
    throw new SetupError('That recovery code does not open this backup.');
  } finally {
    bytes.fill(0);
  }
  if (getPublicKey(secretKey) !== fetched.queuePubkey) {
    secretKey.fill(0);
    throw new SetupError('The backup holds a different key than the npub.');
  }
  return secretKey;
}

export interface RecoverResult {
  storageRelays: string[];
  /** False when the queue has no kind 10013 the key can read; the relays it was found on are used. */
  relayListFound: boolean;
  /** False when no settings event was found, so the inbox key is not on this device yet. */
  settingsFound: boolean;
}

/**
 * Reads the queue's storage relays and settings with the key and stores it under the new
 * passphrase. Wipes `secretKey`.
 */
export async function finishRecover(
  fetched: FetchedBackup,
  secretKey: Uint8Array,
  passphrase: string,
  deps: SetupDeps
): Promise<RecoverResult> {
  const strength = checkPassphrase(passphrase);
  if (!strength.ok) throw new SetupError(strength.problem ?? 'Choose a stronger passphrase.');
  try {
    const known = fetched.relays.length > 0 ? fetched.relays : [fetched.relayUrl];
    const state = await loadQueueState(createLocalSigner(secretKey), known, deps);
    const storageRelays = state.relayList?.relays ?? known;
    await deps.store.save({
      secretKey,
      passphrase,
      storageRelays,
      recoveryBackup: state.recoveryBackup ?? fetched.event,
      ...(state.settings && { settings: state.settings }),
    });
    return {
      storageRelays,
      relayListFound: state.relayList !== undefined,
      settingsFound: state.settings !== undefined,
    };
  } finally {
    secretKey.fill(0);
  }
}
