/**
 * Recovering a queue from its published backup (spec 6.1, 11.3): the recovery code opens the
 * backup, then the user chooses a passphrase for the local copy. The code alone finds the backup
 * through its lookup tag; the queue npub, when the user has it, narrows the search to that key.
 * Recovery asks every relay it knows of at once, the user's, the default storage relays and the
 * earlier defaults (9.1), and succeeds when any of them holds a backup the code opens.
 */

import {
  buildRecoveryBackup,
  createLocalSigner,
  D_RECOVERY,
  decodeNcryptsec,
  KIND_APP_DATA,
  KIND_PRIVATE_RELAYS,
  type NostrEvent,
  newestFirst,
  parseRecoveryBackup,
  parseRecoveryCode,
  publishToAll,
  type RecoveryBackup,
  recoveryLookupOf,
  recoveryLookupTag,
  recoveryPassword,
  type Signer,
} from '@qusme/nostr';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { checkPassphrase } from '../passphrase.ts';
import { DEFAULT_STORAGE_RELAYS } from './create.ts';
import {
  cleanRelayUrl,
  closeAll,
  loadQueueState,
  normalizeRelayUrl,
  openRelays,
  type SetupDeps,
  SetupError,
} from './deps.ts';

/**
 * The storage relays setup suggested before 2026-11-09 (9.1). Queues made then live there, and
 * nos.lol has since stopped accepting writes, so their backups may be on relay.ditto.pub alone.
 */
export const PREVIOUS_DEFAULT_STORAGE_RELAYS = ['wss://nos.lol', 'wss://relay.ditto.pub'] as const;

/**
 * How many backups without a lookup tag a code-only recovery tries to open. Those backups predate
 * the tag, so the only way to tell which is the user's is to open each, at scrypt cost log_n 18.
 */
export const UNTAGGED_BACKUP_LIMIT = 8;

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

/**
 * Every relay recovery asks: the ones given first, then the default storage relays now and before
 * (9.1), each once. `deps.defaultStorageRelays` replaces both default lists (tests use it).
 */
export function recoveryRelays(
  given: readonly string[] | undefined,
  deps: Pick<SetupDeps, 'defaultStorageRelays'>
): string[] {
  const defaults = deps.defaultStorageRelays ?? [
    ...DEFAULT_STORAGE_RELAYS,
    ...PREVIOUS_DEFAULT_STORAGE_RELAYS,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of [...(given ?? []), ...defaults]) {
    const clean = cleanRelayUrl(url);
    if (clean === undefined) continue;
    const key = normalizeRelayUrl(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
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

/** No relay holds a backup the code (or npub) leads to. {@link relays} were asked. */
export class BackupNotFound extends SetupError {
  readonly relays: readonly string[];
  constructor(message: string, relays: readonly string[]) {
    super(message);
    this.relays = relays;
  }
}

/**
 * None of the relays asked could be reached, so whether they hold a backup is unknown. {@link relays}
 * were asked. A network that blocks the default relays ends here, and the user can name another.
 */
export class RelaysUnreachable extends SetupError {
  readonly relays: readonly string[];
  constructor(message: string, relays: readonly string[]) {
    super(message);
    this.relays = relays;
  }
}

/** The relays named in a message, and the ones that could not be reached. */
function relaysClause(asked: readonly string[], unreachable: readonly string[]): string {
  const reached = asked.filter((url) => !unreachable.includes(url));
  const tail = unreachable.length > 0 ? ` (${unreachable.join(', ')} could not be reached)` : '';
  return `${reached.join(', ')}${tail}`;
}

/**
 * Opens `relays` with a throwaway AUTH key, never anything linked to the queue (spec 9.2). Throws
 * {@link RelaysUnreachable} when none answers; `hint` follows the relays in its message.
 */
async function openForLookup(
  relays: readonly string[],
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>,
  hint = ''
) {
  const throwaway = generateSecretKey();
  const signer = createLocalSigner(throwaway);
  throwaway.fill(0);
  const opened = await openRelays(relays, deps, (t) => signer.signEvent(t));
  if (opened.connections.length === 0) {
    throw new RelaysUnreachable(`Could not reach any of ${relays.join(', ')}.${hint}`, relays);
  }
  return { ...opened, unreachable: opened.failed.map((f) => f.url) };
}

/**
 * Fetches the newest recovery backup signed by the queue key from one relay, and only that relay.
 */
export async function fetchRecoveryBackup(
  input: { relayUrl: string; npub: string },
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>
): Promise<FetchedBackup> {
  const relayUrl = cleanRelayUrl(input.relayUrl);
  if (relayUrl === undefined) throw new SetupError('That is not a wss:// relay URL.');
  return findRecoveryBackup({ npub: input.npub, relays: [relayUrl], only: true }, deps);
}

/**
 * Looks the queue up by its npub on {@link recoveryRelays} (or on `relays` alone with `only`): its
 * recovery backup and its kind 10013, which marks a relay as one of the queue's storage relays
 * even where the backup is missing. Returns the newest valid backup and every relay that holds
 * either, so the 10013 can be read from them once the key is open.
 */
export async function findRecoveryBackup(
  input: { npub: string; relays?: readonly string[]; only?: boolean },
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs' | 'defaultStorageRelays'>
): Promise<FetchedBackup> {
  const queuePubkey = readQueuePubkey(input.npub);
  if (queuePubkey === undefined) {
    throw new SetupError(
      'That is not a Queue ID: it starts with npub1 and is on your recovery sheet.'
    );
  }
  const relays = input.only ? [...(input.relays ?? [])] : recoveryRelays(input.relays, deps);
  const { connections, unreachable } = await openForLookup(
    relays,
    deps,
    input.only ? '' : ' If the queue is on another storage server, enter it below.'
  );
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
    throw new BackupNotFound(
      `No recovery backup for that Queue ID on ${relaysClause(relays, unreachable)}. If the queue is on another relay, enter it below.`,
      relays
    );
  } finally {
    closeAll(connections);
  }
}

/** Parses the recovery code, or throws the error the user sees for one that is not a code. */
function readCode(recoveryCode: string): Uint8Array {
  const bytes = parseRecoveryCode(recoveryCode);
  if (bytes === undefined) {
    throw new SetupError(
      'That is not a recovery code: 12 words from the list, or 26 letters and digits. Check for a mistyped word or character.'
    );
  }
  return bytes;
}

/** The queue key from a backup's ncryptsec, or undefined when the password does not open it. */
function tryOpen(backup: RecoveryBackup, password: string): Uint8Array | undefined {
  let secretKey: Uint8Array;
  try {
    secretKey = decodeNcryptsec(backup.ncryptsec, password);
  } catch {
    return undefined;
  }
  if (getPublicKey(secretKey) !== backup.pubkey) {
    secretKey.fill(0);
    return undefined;
  }
  return secretKey;
}

/** Opens the backup with the recovery code (either form). Returns the queue key. */
export function openRecoveryBackup(fetched: FetchedBackup, recoveryCode: string): Uint8Array {
  const bytes = readCode(recoveryCode);
  const password = recoveryPassword(bytes);
  bytes.fill(0);
  let secretKey: Uint8Array;
  try {
    secretKey = decodeNcryptsec(fetched.backup.ncryptsec, password);
  } catch {
    throw new SetupError(
      `Found this queue’s backup on ${fetched.relayUrl}, but that recovery code does not open it.`
    );
  }
  if (getPublicKey(secretKey) !== fetched.queuePubkey) {
    secretKey.fill(0);
    throw new SetupError('The backup holds a different key than the npub.');
  }
  return secretKey;
}

interface Candidate {
  event: NostrEvent;
  backup: RecoveryBackup;
  relayUrl: string;
  relays: string[];
  tagged: boolean;
}

/**
 * Finds the backups the code may open on `relays`: those carrying its lookup tag, and the newest
 * backup of each queue whose backup predates the tag (6.1). A backup tagged for another code is
 * never this code's and is skipped. Tagged first, then untagged newest first.
 */
async function findBackupsByCode(
  lookup: string,
  relays: readonly string[],
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>
): Promise<{ candidates: Candidate[]; unreachable: string[] }> {
  const { connections, unreachable } = await openForLookup(
    relays,
    deps,
    ' If your recovery sheet lists other storage servers, enter one below.'
  );
  try {
    const byPubkey = new Map<string, Candidate>();
    await Promise.all(
      connections.map(async (connection) => {
        const [tagged, all] = await Promise.allSettled([
          connection.query([{ kinds: [KIND_APP_DATA], '#l': [lookup] }]),
          connection.query([{ kinds: [KIND_APP_DATA], '#d': [D_RECOVERY], limit: 100 }]),
        ]);
        const events = [
          ...(tagged.status === 'fulfilled' ? tagged.value : []),
          ...(all.status === 'fulfilled' ? all.value : []),
        ];
        for (const event of events) {
          const parsed = parseRecoveryBackup(event);
          if (!parsed.ok) continue;
          const tag = recoveryLookupOf(parsed.value);
          if (tag !== undefined && tag !== lookup) continue;
          const seen = byPubkey.get(event.pubkey);
          if (seen === undefined) {
            byPubkey.set(event.pubkey, {
              event,
              backup: parsed.value,
              relayUrl: connection.url,
              relays: [connection.url],
              tagged: tag !== undefined,
            });
            continue;
          }
          if (!seen.relays.includes(connection.url)) seen.relays.push(connection.url);
          if (newestFirst(event, seen.event) < 0) {
            Object.assign(seen, {
              event,
              backup: parsed.value,
              relayUrl: connection.url,
              tagged: tag !== undefined,
            });
          }
        }
      })
    );
    const candidates = [...byPubkey.values()].sort(
      (a, b) => Number(b.tagged) - Number(a.tagged) || newestFirst(a.event, b.event)
    );
    return { candidates, unreachable };
  } finally {
    closeAll(connections);
  }
}

/** Lets the popup repaint between scrypt runs, which block the thread. */
const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

export interface OpenedBackup {
  fetched: FetchedBackup;
  /** The queue key. {@link finishRecover} wipes it. */
  key: Uint8Array;
  /** The code's lookup tag, so {@link finishRecover} can add it to a backup that lacks it. */
  lookup: string;
}

/**
 * Finds and opens the queue's backup with the recovery code, and the npub when the user has it
 * (6.1, 11.3). Asks {@link recoveryRelays}: `relays` (from the sheet or typed) and the default
 * storage relays now and before. Errors name what went wrong: the code is not a code, no relay
 * holds a backup (naming the relays asked), or a backup was found and the code does not open it.
 */
export async function recoverWithCode(
  input: { code: string; npub?: string; relays?: readonly string[] },
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs' | 'defaultStorageRelays'>
): Promise<OpenedBackup> {
  const bytes = readCode(input.code);
  const lookup = recoveryLookupTag(bytes);
  const password = recoveryPassword(bytes);
  bytes.fill(0);

  if (input.npub !== undefined) {
    const fetched = await findRecoveryBackup(
      { npub: input.npub, ...(input.relays && { relays: input.relays }) },
      deps
    );
    return { fetched, key: openRecoveryBackup(fetched, input.code), lookup };
  }

  const relays = recoveryRelays(input.relays, deps);
  const { candidates, unreachable } = await findBackupsByCode(lookup, relays, deps);
  const where = relaysClause(relays, unreachable);
  if (candidates.length === 0) {
    throw new BackupNotFound(
      `No recovery backup found on ${where}. If your recovery sheet lists other storage servers, enter one below, or add the Queue ID (npub1…).`,
      relays
    );
  }
  const tagged = candidates.filter((c) => c.tagged);
  const untagged = candidates.filter((c) => !c.tagged).slice(0, UNTAGGED_BACKUP_LIMIT);
  for (const candidate of [...tagged, ...untagged]) {
    await yieldToUi();
    const key = tryOpen(candidate.backup, password);
    if (key === undefined) continue;
    return {
      fetched: {
        relayUrl: candidate.relayUrl,
        relays: candidate.relays,
        queuePubkey: candidate.event.pubkey,
        backup: candidate.backup,
        event: candidate.event,
      },
      key,
      lookup,
    };
  }
  if (tagged.length > 0) {
    throw new SetupError(
      `Found the backup for this code on ${tagged[0]?.relayUrl}, but the code does not open it.`
    );
  }
  const more = candidates.length > untagged.length;
  throw new BackupNotFound(
    `None of the ${untagged.length} recovery backups on ${where} opens with this code${
      more ? ' (more were not tried)' : ''
    }. Add the Queue ID (npub1…) from your recovery sheet, or enter another storage server below.`,
    relays
  );
}

/**
 * Republishes the backup in `backupEvent` with the code's lookup tag, signed by the queue key, to
 * `relays`, so the code alone finds it from now on (6.1). The ncryptsec is unchanged. Returns the
 * new event when at least one relay took it.
 */
export async function publishTaggedBackup(
  signer: Signer,
  backupEvent: NostrEvent,
  lookup: string,
  relays: readonly string[],
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>
): Promise<NostrEvent | undefined> {
  const pubkey = await signer.getPublicKey();
  const parsed = parseRecoveryBackup(backupEvent, { queuePubkey: pubkey });
  if (!parsed.ok) return undefined;
  const event = await buildRecoveryBackup(signer, parsed.value.ncryptsec, {
    lookup,
    ...(parsed.value.extraTags && { extraTags: parsed.value.extraTags }),
    // Replaces the old backup (kind 30078 is addressable), even within the same second.
    createdAt: Math.max(Math.floor(Date.now() / 1000), backupEvent.created_at + 1),
  });
  const { connections } = await openRelays(relays, deps, (t) => signer.signEvent(t));
  try {
    if (connections.length === 0) return undefined;
    const report = await publishToAll(connections, event);
    return report.accepted.length > 0 ? event : undefined;
  } finally {
    closeAll(connections);
  }
}

export interface RecoverResult {
  storageRelays: string[];
  /** False when the queue has no kind 10013 the key can read; the relays it was found on are used. */
  relayListFound: boolean;
  /** False when no settings event was found, so the inbox key is not on this device yet. */
  settingsFound: boolean;
  /** Set when a lookup was given: true when the backup now carries it on a storage relay. */
  lookupAdded?: boolean;
}

/**
 * Reads the queue's storage relays and settings with the key and stores it under the new
 * passphrase. Given the code's `lookup`, adds it to a backup that predates it, so the code alone
 * finds the queue next time. Wipes `secretKey`.
 */
export async function finishRecover(
  fetched: FetchedBackup,
  secretKey: Uint8Array,
  passphrase: string,
  deps: SetupDeps,
  options: { lookup?: string } = {}
): Promise<RecoverResult> {
  const strength = checkPassphrase(passphrase);
  if (!strength.ok) throw new SetupError(strength.problem ?? 'Choose a stronger passphrase.');
  try {
    const known = fetched.relays.length > 0 ? fetched.relays : [fetched.relayUrl];
    const signer = createLocalSigner(secretKey);
    const state = await loadQueueState(signer, known, deps);
    const storageRelays = state.relayList?.relays ?? known;
    let recoveryBackup = state.recoveryBackup ?? fetched.event;
    let lookupAdded: boolean | undefined;
    if (options.lookup !== undefined) {
      const current = parseRecoveryBackup(recoveryBackup);
      if (current.ok && recoveryLookupOf(current.value) === options.lookup) {
        lookupAdded = true;
      } else if (current.ok && current.value.ncryptsec === fetched.backup.ncryptsec) {
        // Only the backup the code just opened is tagged: a tag on a backup the code does not
        // open would send a code-only recovery to the wrong ciphertext.
        const tagged = await publishTaggedBackup(
          signer,
          recoveryBackup,
          options.lookup,
          storageRelays,
          deps
        );
        if (tagged !== undefined) recoveryBackup = tagged;
        lookupAdded = tagged !== undefined;
      } else {
        lookupAdded = false;
      }
    }
    await deps.store.save({
      secretKey,
      passphrase,
      storageRelays,
      recoveryBackup,
      ...(state.settings && { settings: state.settings }),
    });
    return {
      storageRelays,
      relayListFound: state.relayList !== undefined,
      settingsFound: state.settings !== undefined,
      ...(lookupAdded !== undefined && { lookupAdded }),
    };
  } finally {
    secretKey.fill(0);
  }
}

/**
 * Adds the lookup tag to this device's queue backup when it lacks one (6.1). The device never
 * keeps the recovery code, so the user types it once; it must open the queue's current backup.
 */
export async function addRecoveryLookup(recoveryCode: string, deps: SetupDeps): Promise<void> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
  const { record, queueKey } = unlocked;
  const signer = createLocalSigner(queueKey);
  try {
    const backupEvent =
      record.recoveryBackup ??
      (await loadQueueState(signer, record.storageRelays, deps)).recoveryBackup;
    if (backupEvent === undefined) {
      throw new SetupError('The queue’s recovery backup was not found on its storage relays.');
    }
    const parsed = parseRecoveryBackup(backupEvent, { queuePubkey: record.pubkey });
    if (!parsed.ok) throw new SetupError('The queue’s recovery backup could not be read.');
    const bytes = readCode(recoveryCode);
    const lookup = recoveryLookupTag(bytes);
    const password = recoveryPassword(bytes);
    bytes.fill(0);
    const opened = tryOpen(parsed.value, password);
    if (opened === undefined) {
      throw new SetupError('That recovery code does not open this queue’s backup.');
    }
    opened.fill(0);
    const tagged = await publishTaggedBackup(
      signer,
      backupEvent,
      lookup,
      record.storageRelays,
      deps
    );
    if (tagged === undefined) {
      throw new SetupError(
        `None of the storage relays (${record.storageRelays.join(', ')}) took the updated backup.`
      );
    }
    await deps.store.update({ recoveryBackup: tagged });
  } finally {
    queueKey.fill(0);
    unlocked.inboxKey?.fill(0);
  }
}

/** True when this device's copy of the backup lacks the lookup tag, so the code alone can't find it. */
export function backupNeedsLookup(record: { recoveryBackup?: NostrEvent } | undefined): boolean {
  if (record?.recoveryBackup === undefined) return false;
  const parsed = parseRecoveryBackup(record.recoveryBackup);
  return parsed.ok && recoveryLookupOf(parsed.value) === undefined;
}
