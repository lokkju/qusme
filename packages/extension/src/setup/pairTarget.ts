/**
 * Pairing, the new device's side (spec 8.3 steps 3, 4, 6, 7): take a `nostrpair://` URI (pasted
 * from the QR) or a typed code (resolved through the service), run NIP-AB as the target, show the
 * SAS at once, store the received `ncryptsec` and send `complete`, then ask for the passphrase (QR)
 * or the recovery code (typed code) to open it, check the key against `qusme_npub` and the queue's
 * kind 10013, and store it under a local passphrase.
 */
import {
  createLocalSigner,
  decodeNcryptsec,
  normalizePairingCode,
  type PairingChannel,
  type PairingNotice,
  PairingTarget,
  type PairingUri,
  parsePairingUri,
  parseRecoveryCode,
  type ReceivedPayload,
  recoveryPassword,
  type UnlockSecret,
} from '@qusme/nostr';
import { getPublicKey } from 'nostr-tools/pure';
import type { PendingImport } from '../keyStore.ts';
import { checkPassphrase } from '../passphrase.ts';
import { cleanRelayUrl, loadQueueState, type SetupDeps, SetupError, sameRelays } from './deps.ts';
import { PairingLink } from './pairingLink.ts';
import { fetchPairingUri } from './service.ts';

/**
 * Resolves what the user gave the new device: a `nostrpair://` URI (a QR session) or a typed
 * code (a typed-code session, fetched from the service). For a code, the service permission is
 * requested before anything else is awaited, so call this straight from the click handler.
 */
export async function resolvePairingInput(
  input: string,
  deps: Pick<SetupDeps, 'serviceOrigin' | 'fetch' | 'requestServicePermission'>
): Promise<{ uri: PairingUri; channel: PairingChannel; deadline?: number }> {
  const text = input.trim();
  if (text.startsWith('nostrpair:')) {
    const parsed = parsePairingUri(text);
    if (!parsed.ok) throw new SetupError(`That pairing link is not valid: ${parsed.error.message}`);
    return { uri: parsed.value, channel: 'qr' };
  }
  const code = normalizePairingCode(text);
  if (code === undefined) {
    throw new SetupError('Paste the nostrpair:// link, or type the 8-character code.');
  }
  const granted = await deps.requestServicePermission();
  if (!granted) throw new SetupError('A typed code needs access to the qus.me service.');
  const { uri, expiresAt } = await fetchPairingUri(code, deps);
  return { uri, channel: 'typed-code', deadline: expiresAt * 1000 };
}

export type TargetPhase =
  /** Show the SAS; the user compares and confirms or denies. */
  | { phase: 'compare'; sas: string; confirmed: boolean; verified: boolean }
  /** The payload is stored; ask for the passphrase or the recovery code. */
  | { phase: 'unlock'; unlockWith: UnlockSecret }
  | { phase: 'failed'; message: string };

const ABORT_MESSAGES: Record<string, string> = {
  sas_mismatch: 'The codes did not match. Nothing was transferred.',
  user_denied: 'Pairing was cancelled.',
  timeout: 'Pairing timed out. Start again on both devices.',
  protocol_error: 'The other device stopped pairing.',
};

/**
 * One pairing as the new device. {@link onPhase} hears every change the UI should show.
 */
export class TargetPairing {
  readonly session: PairingTarget;
  #link: PairingLink | undefined;
  #deps: SetupDeps;
  #onPhase: (phase: TargetPhase) => void;

  private constructor(
    session: PairingTarget,
    deps: SetupDeps,
    onPhase: (phase: TargetPhase) => void
  ) {
    this.session = session;
    this.#deps = deps;
    this.#onPhase = onPhase;
  }

  static async start(
    resolved: { uri: PairingUri; channel: PairingChannel; deadline?: number },
    deps: SetupDeps,
    onPhase: (phase: TargetPhase) => void
  ): Promise<TargetPairing> {
    const session = new PairingTarget(resolved.uri, resolved.channel, {
      ...(resolved.deadline !== undefined && { deadline: resolved.deadline }),
    });
    resolved.uri.sessionSecret.fill(0);
    const pairing = new TargetPairing(session, deps, onPhase);
    pairing.#link = await PairingLink.start(session, deps, {
      onNotice: (notice) => pairing.#notice(notice),
      onError: (error) => onPhase({ phase: 'failed', message: error.message }),
    });
    // The target knows both ephemeral keys once it sends the offer, so it shows the SAS at once.
    onPhase(pairing.#compare());
    return pairing;
  }

  #compare(): TargetPhase {
    return {
      phase: 'compare',
      sas: this.session.sas as string,
      confirmed: this.session.userConfirmed,
      verified: this.session.state === 'verified',
    };
  }

  async #notice(notice: PairingNotice): Promise<void> {
    switch (notice.type) {
      case 'verified':
        this.#onPhase(this.#compare());
        return;
      case 'payload':
        await this.#store(notice.payload);
        return;
      case 'refused':
        this.#onPhase({
          phase: 'failed',
          message: 'The other device sent something other than an encrypted key. Nothing was kept.',
        });
        return;
      case 'aborted':
        this.#onPhase({
          phase: 'failed',
          message: ABORT_MESSAGES[notice.reason] ?? 'Pairing stopped.',
        });
        return;
      default:
        return;
    }
  }

  /** Stores the `ncryptsec`, then sends `complete` before asking the user anything (8.3 step 6). */
  async #store(payload: ReceivedPayload): Promise<void> {
    const pending: PendingImport = {
      ncryptsec: payload.ncryptsec,
      unlockWith: payload.unlockWith,
      receivedAt: Math.floor(Date.now() / 1000),
    };
    if (payload.relays !== undefined) pending.relays = payload.relays;
    if (payload.queuePubkey !== undefined) pending.queuePubkey = payload.queuePubkey;
    let stored = true;
    try {
      await this.#deps.store.setPendingImport(pending);
    } catch {
      stored = false;
    }
    await this.#link?.applyInline(this.session.stored(stored));
    this.#onPhase(
      stored
        ? { phase: 'unlock', unlockWith: payload.unlockWith }
        : { phase: 'failed', message: 'Could not store the key on this device.' }
    );
  }

  /** The user says both screens show the same code. */
  async confirmSas(): Promise<void> {
    await this.#link?.apply(this.session.confirmSas());
    if (!this.session.terminal && this.session.state !== 'importing') {
      this.#onPhase(this.#compare());
    }
  }

  /** The user says the codes differ, or cancels. */
  async deny(): Promise<void> {
    await this.#link?.apply(this.session.deny());
  }

  close(): void {
    this.#link?.close();
  }
}

/**
 * Opens the stored pairing payload with the passphrase (QR session) or the recovery code
 * (typed-code session) and checks it is the queue key the payload named (8.3 step 7).
 */
export function openPendingImport(pending: PendingImport, secret: string): Uint8Array {
  let password: string;
  if (pending.unlockWith === 'recovery-code') {
    const bytes = parseRecoveryCode(secret);
    if (bytes === undefined) {
      throw new SetupError('That is not a recovery code: 12 words, or 26 letters and digits.');
    }
    password = recoveryPassword(bytes);
    bytes.fill(0);
  } else {
    password = secret;
  }
  let secretKey: Uint8Array;
  try {
    secretKey = decodeNcryptsec(pending.ncryptsec, password);
  } catch {
    throw new SetupError(
      pending.unlockWith === 'recovery-code'
        ? 'That recovery code does not open the key.'
        : 'That passphrase does not open the key. Use the passphrase of the other device.'
    );
  }
  if (pending.queuePubkey === undefined || getPublicKey(secretKey) !== pending.queuePubkey) {
    secretKey.fill(0);
    throw new SetupError('The key does not match the queue the other device named. Discarded.');
  }
  return secretKey;
}

export type FinishPairResult =
  | { ok: true; storageRelays: string[]; settingsFound: boolean }
  /** No kind 10013 on the relays, or it differs from `qusme_relays`: ask for a relay URL. */
  | { ok: false; reason: 'relay_list_missing' | 'relay_list_mismatch'; message: string };

/**
 * Checks the queue's kind 10013 against `qusme_relays` and stores the key under the new local
 * passphrase. With `relayUrl` (the user's answer to a mismatch or a missing list) the 10013 is
 * read from that relay instead and becomes the storage relays. Wipes `secretKey` on success.
 */
export async function finishPairing(
  pending: PendingImport,
  secretKey: Uint8Array,
  passphrase: string,
  deps: SetupDeps,
  relayUrl?: string
): Promise<FinishPairResult> {
  const strength = checkPassphrase(passphrase);
  if (!strength.ok) throw new SetupError(strength.problem ?? 'Choose a stronger passphrase.');
  let sources = pending.relays ?? [];
  if (relayUrl !== undefined) {
    const clean = cleanRelayUrl(relayUrl);
    if (clean === undefined) throw new SetupError('That is not a wss:// relay URL.');
    sources = [clean];
  }
  if (sources.length === 0) {
    return {
      ok: false,
      reason: 'relay_list_missing',
      message: 'The other device sent no relays. Enter one of the queue’s storage relays.',
    };
  }
  const state = await loadQueueState(createLocalSigner(secretKey), sources, deps);
  if (state.relayList === undefined) {
    return {
      ok: false,
      reason: 'relay_list_missing',
      message: 'The queue’s relay list was not found there. Enter one of its storage relays.',
    };
  }
  if (relayUrl === undefined && !sameRelays(state.relayList.relays, sources)) {
    return {
      ok: false,
      reason: 'relay_list_mismatch',
      message:
        'The relays the other device sent differ from the queue’s own list. Enter one of the queue’s storage relays to continue.',
    };
  }
  await deps.store.save({
    secretKey,
    passphrase,
    storageRelays: state.relayList.relays,
    ...(state.recoveryBackup && { recoveryBackup: state.recoveryBackup }),
    ...(state.settings && { settings: state.settings }),
  });
  secretKey.fill(0);
  return { ok: true, storageRelays: state.relayList.relays, settingsFound: !!state.settings };
}
