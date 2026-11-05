/**
 * Recovering a queue from its published backup (spec 6.1, 11.3): the relay URL, the queue npub
 * and the recovery code open the backup; then the user chooses a passphrase for the local copy.
 */

import {
  createLocalSigner,
  D_RECOVERY,
  decodeNcryptsec,
  KIND_APP_DATA,
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
  relayUrl: string;
  queuePubkey: string;
  backup: RecoveryBackup;
  event: NostrEvent;
}

/**
 * Fetches the newest recovery backup signed by the queue key. A relay that asks for AUTH gets a
 * throwaway key, never anything linked to the queue (spec 9.2).
 */
export async function fetchRecoveryBackup(
  input: { relayUrl: string; npub: string },
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>
): Promise<FetchedBackup> {
  const relayUrl = cleanRelayUrl(input.relayUrl);
  if (relayUrl === undefined) throw new SetupError('That is not a wss:// relay URL.');
  const queuePubkey = readQueuePubkey(input.npub);
  if (queuePubkey === undefined) throw new SetupError('That is not an npub.');
  const throwaway = generateSecretKey();
  const signer = createLocalSigner(throwaway);
  throwaway.fill(0);
  const { connections } = await openRelays([relayUrl], deps, (t) => signer.signEvent(t));
  const [connection] = connections;
  if (connection === undefined) throw new SetupError(`Could not reach ${relayUrl}.`);
  try {
    let events: NostrEvent[];
    try {
      events = await connection.query([
        { kinds: [KIND_APP_DATA], authors: [queuePubkey], '#d': [D_RECOVERY] },
      ]);
    } catch (error) {
      throw new SetupError(`${relayUrl} refused the request: ${(error as Error).message}`);
    }
    for (const event of events.sort(newestFirst)) {
      const parsed = parseRecoveryBackup(event, { queuePubkey });
      if (parsed.ok) return { relayUrl, queuePubkey, backup: parsed.value, event };
    }
    throw new SetupError('No recovery backup for that npub on that relay.');
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
  /** False when the queue has no kind 10013 the key can read; the relay URL is used instead. */
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
    const state = await loadQueueState(createLocalSigner(secretKey), [fetched.relayUrl], deps);
    const storageRelays = state.relayList?.relays ?? [fetched.relayUrl];
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
