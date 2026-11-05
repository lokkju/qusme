/**
 * Pairing, the existing device's side (spec 8.3 steps 1, 2, 4, 5): on an unlocked device, start a
 * NIP-AB session over up to three storage relays, show the `nostrpair://` URI as a QR code, and on
 * request post it to the service for a typed code. When the new device's offer arrives, show the
 * SAS; on the user's confirmation send the passphrase copy (QR session) or the published recovery
 * backup (typed-code session), with the storage relays and the queue npub.
 */
import {
  createLocalSigner,
  NOSTRPAIR_MAX_RELAYS,
  type PairingNotice,
  PairingSource,
} from '@qusme/nostr';
import type { UnlockedQueue } from '../keyStore.ts';
import { type SetupDeps, SetupError } from './deps.ts';
import { PairingLink } from './pairingLink.ts';
import { postPairingCode } from './service.ts';

export type SourcePhase =
  /** Show the QR (and the typed code, once issued); wait for the new device. */
  | { phase: 'waiting'; uri: string; code?: string }
  /** An offer arrived: show the SAS and ask the user to compare. */
  | { phase: 'compare'; sas: string }
  /** The payload went out; waiting for `complete`. */
  | { phase: 'sent' }
  | { phase: 'done' }
  /** No `complete` in 30 s: probably fine, the user checks the other device. */
  | { phase: 'unconfirmed' }
  | { phase: 'failed'; message: string };

const ABORT_MESSAGES: Record<string, string> = {
  sas_mismatch: 'The other device saw a different code. Nothing was sent.',
  user_denied: 'Pairing was cancelled.',
  timeout: 'Pairing timed out.',
  protocol_error: 'The other device stopped pairing.',
};

export class SourcePairing {
  readonly session: PairingSource;
  #link: PairingLink | undefined;
  #unlocked: UnlockedQueue;
  #deps: SetupDeps;
  #onPhase: (phase: SourcePhase) => void;
  #code: string | undefined;

  private constructor(
    session: PairingSource,
    unlocked: UnlockedQueue,
    deps: SetupDeps,
    onPhase: (phase: SourcePhase) => void
  ) {
    this.session = session;
    this.#unlocked = unlocked;
    this.#deps = deps;
    this.#onPhase = onPhase;
  }

  /** Starts a session. The queue must be unlocked. */
  static async start(
    deps: SetupDeps,
    onPhase: (phase: SourcePhase) => void
  ): Promise<SourcePairing> {
    const unlocked = await deps.store.unlocked();
    if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
    const relays = unlocked.record.storageRelays.slice(0, NOSTRPAIR_MAX_RELAYS);
    if (relays.length === 0) throw new SetupError('This queue has no storage relays.');
    const session = new PairingSource(relays);
    const pairing = new SourcePairing(session, unlocked, deps, onPhase);
    pairing.#link = await PairingLink.start(session, deps, {
      onNotice: (notice) => pairing.#notice(notice),
      onError: (error) => onPhase({ phase: 'failed', message: error.message }),
    });
    onPhase({ phase: 'waiting', uri: session.uri });
    return pairing;
  }

  get uri(): string {
    return this.session.uri;
  }

  /** Whether this device can issue a typed code: it needs its copy of the recovery backup. */
  get canIssueCode(): boolean {
    return this.#unlocked.record.recoveryBackup !== undefined && this.session.state === 'waiting';
  }

  /**
   * Posts the URI to the service for a typed code (8.3 step 2). Requests the service permission
   * first, so call it straight from the click handler. Marks the session typed-code before
   * posting: it then sends the recovery backup, never the passphrase copy.
   */
  async requestCode(): Promise<string> {
    if (this.#code !== undefined) return this.#code;
    if (this.#unlocked.record.recoveryBackup === undefined) {
      throw new SetupError('This device has no copy of the recovery backup; pair with the QR.');
    }
    if (this.session.state !== 'waiting') throw new SetupError('Pairing has already moved on.');
    const granted = await this.#deps.requestServicePermission();
    if (!granted) throw new SetupError('A typed code needs access to the qus.me service.');
    this.session.markTypedCode();
    const { code } = await postPairingCode(
      createLocalSigner(this.#unlocked.queueKey),
      this.session.uri,
      Math.floor(this.session.expiresAt / 1000),
      this.#deps
    );
    this.#code = code;
    this.#onPhase({ phase: 'waiting', uri: this.session.uri, code });
    return code;
  }

  async #notice(notice: PairingNotice): Promise<void> {
    switch (notice.type) {
      case 'sas':
        this.#onPhase({ phase: 'compare', sas: notice.sas });
        return;
      case 'complete':
        this.#onPhase(
          notice.success
            ? { phase: 'done' }
            : { phase: 'failed', message: 'The other device could not store the key.' }
        );
        return;
      case 'unconfirmed':
        this.#onPhase({ phase: 'unconfirmed' });
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

  /** Both screens show the same code: send the payload the session calls for. */
  async confirmSas(): Promise<void> {
    const { record } = this.#unlocked;
    const step = this.session.confirmSas({
      passphraseCopy: record.ncryptsec,
      ...(record.recoveryBackup && { recoveryBackup: record.recoveryBackup.content }),
      relays: record.storageRelays,
      queuePubkey: record.pubkey,
    });
    await this.#link?.apply(step);
    if (this.session.state === 'sent') this.#onPhase({ phase: 'sent' });
  }

  /** The codes differ, or the user cancels. */
  async deny(): Promise<void> {
    await this.#link?.apply(this.session.deny());
  }

  close(): void {
    this.#link?.close();
    this.#unlocked.queueKey.fill(0);
    this.#unlocked.inboxKey?.fill(0);
  }
}
