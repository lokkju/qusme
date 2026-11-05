/**
 * Creating a new queue (spec 11.3): generate the queue key and the inbox key, choose a passphrase,
 * show the recovery code once and confirm it was saved, choose and probe storage relays and an
 * inbox relay (9.1), then publish the kind 10013, the settings and the recovery backup, and store
 * the key. Nothing is published before the code is confirmed (6.1).
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  buildPrivateRelayList,
  buildRecoveryBackup,
  buildSettings,
  createLocalSigner,
  encodeNcryptsec,
  formatRecoveryBase32,
  generateRecoveryCode,
  NCRYPTSEC_DEFAULT_LOG_N,
  type ProbeResult,
  parseRecoveryCode,
  probeRelay,
  publishToAll,
  type RelayRole,
  recoveryCodeToBase32,
  recoveryCodeToWords,
  recoveryPassword,
} from '@qusme/nostr';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { checkPassphrase } from '../passphrase.ts';
import { cleanRelayUrl, closeAll, openRelays, type SetupDeps, SetupError } from './deps.ts';

/** Spec 9.1's recommendation: two storage relays and an inbox relay, all editable at setup. */
export const DEFAULT_STORAGE_RELAYS = ['wss://nos.lol', 'wss://relay.ditto.pub'] as const;
export const DEFAULT_INBOX_RELAYS = ['wss://auth.nostr1.com'] as const;

/** A queue being created. Held in memory by the setup screen until {@link finishCreate}. */
export interface CreateDraft {
  readonly secretKey: Uint8Array;
  readonly inboxKey: Uint8Array;
  readonly pubkey: string;
  readonly npub: string;
  /** The recovery code's 12 words and its base32 form, for the one time they are shown. */
  readonly words: string[];
  readonly base32: string;
  readonly recoveryCode: Uint8Array;
  /** Set by {@link confirmRecoveryCode}; {@link finishCreate} refuses to publish without it. */
  confirmed: boolean;
}

export function startCreate(): CreateDraft {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const recoveryCode = generateRecoveryCode();
  return {
    secretKey,
    inboxKey: generateSecretKey(),
    pubkey,
    npub: npubEncode(pubkey),
    words: recoveryCodeToWords(recoveryCode),
    base32: formatRecoveryBase32(recoveryCodeToBase32(recoveryCode)),
    recoveryCode,
    confirmed: false,
  };
}

/**
 * The user typed the code back, in either form, to show it was saved (6.1). True and marks the
 * draft confirmed when it matches.
 */
export function confirmRecoveryCode(draft: CreateDraft, typed: string): boolean {
  const bytes = parseRecoveryCode(typed);
  const match =
    bytes !== undefined &&
    bytes.length === draft.recoveryCode.length &&
    bytes.every((b, i) => b === draft.recoveryCode[i]);
  bytes?.fill(0);
  if (match) draft.confirmed = true;
  return match;
}

/** Cleans a list of relay URLs as typed; throws {@link SetupError} naming a bad one. */
export function cleanRelayList(urls: readonly string[], what: string): string[] {
  const cleaned: string[] = [];
  for (const url of urls) {
    if (url.trim() === '') continue;
    const clean = cleanRelayUrl(url);
    if (clean === undefined) throw new SetupError(`${url.trim()} is not a wss:// relay URL.`);
    if (!cleaned.includes(clean)) cleaned.push(clean);
  }
  if (cleaned.length === 0) throw new SetupError(`Add at least one ${what}.`);
  return cleaned;
}

/** Probes each relay for its role (9.1). */
export function probeRelays(
  relays: { url: string; role: RelayRole }[],
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs' | 'probe'>
): Promise<ProbeResult[]> {
  return Promise.all(
    relays.map(({ url, role }) =>
      probeRelay(url, role, {
        ...deps.probe,
        ...(deps.socket && { socket: deps.socket }),
        ...(deps.relayTimeoutMs !== undefined && { timeoutMs: deps.relayTimeoutMs }),
      })
    )
  );
}

export interface FinishCreateInput {
  passphrase: string;
  storageRelays: string[];
  inboxRelays: string[];
}

/**
 * Publishes the queue's kind 10013, settings (with the inbox key and relays) and recovery backup
 * to every storage relay, then stores the key under the passphrase and leaves it unlocked. Every
 * storage relay must accept every event; otherwise nothing is stored and the error names the
 * relays that refused, so the user can change them and try again with the same draft.
 */
export async function finishCreate(
  draft: CreateDraft,
  input: FinishCreateInput,
  deps: SetupDeps
): Promise<void> {
  if (!draft.confirmed) throw new SetupError('Confirm the recovery code first.');
  const strength = checkPassphrase(input.passphrase);
  if (!strength.ok) throw new SetupError(strength.problem ?? 'Choose a stronger passphrase.');
  const storageRelays = cleanRelayList(input.storageRelays, 'storage relay');
  const inboxRelays = cleanRelayList(input.inboxRelays, 'inbox relay');
  const logN = deps.logN ?? NCRYPTSEC_DEFAULT_LOG_N;

  const signer = createLocalSigner(draft.secretKey);
  const backupNcryptsec = encodeNcryptsec(draft.secretKey, recoveryPassword(draft.recoveryCode), {
    logN,
  });
  const relayList = await buildPrivateRelayList(signer, storageRelays);
  const settings = await buildSettings(signer, {
    inbox_key: bytesToHex(draft.inboxKey),
    inbox_relays: inboxRelays,
    quota_counts: {},
  });
  const backup = await buildRecoveryBackup(signer, backupNcryptsec);

  const { connections, failed } = await openRelays(storageRelays, deps, (t) => signer.signEvent(t));
  try {
    if (failed.length > 0) {
      throw new SetupError(`Could not reach ${failed.map((f) => f.url).join(', ')}.`);
    }
    for (const event of [relayList, settings, backup]) {
      const report = await publishToAll(connections, event);
      if (report.refused.length > 0) {
        const detail = report.refused.map((r) => `${r.url} (${r.reason})`).join(', ');
        throw new SetupError(`Publishing failed on ${detail}.`);
      }
    }
  } finally {
    closeAll(connections);
  }

  await deps.store.save({
    secretKey: draft.secretKey,
    passphrase: input.passphrase,
    storageRelays,
    recoveryBackup: backup,
    settings,
  });
  wipeDraft(draft);
}

/** Overwrites the draft's secrets; call when setup finishes or is abandoned. */
export function wipeDraft(draft: CreateDraft): void {
  draft.secretKey.fill(0);
  draft.inboxKey.fill(0);
  draft.recoveryCode.fill(0);
  draft.words.fill('');
}
