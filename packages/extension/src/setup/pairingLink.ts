/**
 * Runs a NIP-AB session over relays (spec 8.3 step 4): one connection per relay of the session,
 * opened for the session alone and authenticated, where a relay asks, as the session's ephemeral
 * key and never as the queue or inbox key. Events from the relays go to the state machine; what it
 * returns is published, in order, to every relay; its deadlines are kept with a timer.
 */
import {
  type NostrEvent,
  type PairingNotice,
  type PairingSource,
  type PairingStep,
  PairingTarget,
  publishToAll,
  type RelayConnection,
} from '@qusme/nostr';
import { closeAll, openRelays, type SetupDeps, SetupError } from './deps.ts';

export interface PairingLinkHandlers {
  /** Called after the step's events were published. */
  onNotice: (notice: PairingNotice) => void | Promise<void>;
  /** A publish failed on every relay, or the relays went away. */
  onError?: (error: Error) => void;
}

export class PairingLink {
  readonly session: PairingSource | PairingTarget;
  #connections: RelayConnection[];
  #handlers: PairingLinkHandlers;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #now: () => number;

  private constructor(
    session: PairingSource | PairingTarget,
    connections: RelayConnection[],
    handlers: PairingLinkHandlers,
    now: () => number
  ) {
    this.session = session;
    this.#connections = connections;
    this.#handlers = handlers;
    this.#now = now;
  }

  /**
   * Connects to the session's relays, subscribes, and for a target publishes the offer. Rejects
   * with a {@link SetupError} when no relay can be reached.
   */
  static async start(
    session: PairingSource | PairingTarget,
    deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>,
    handlers: PairingLinkHandlers,
    now: () => number = Date.now
  ): Promise<PairingLink> {
    const { connections } = await openRelays(session.relays, deps, (t) => session.signAuth(t));
    if (connections.length === 0) {
      throw new SetupError(`Could not reach any pairing relay (${session.relays.join(', ')}).`);
    }
    // A relay that challenged on connect gets the ephemeral key before the subscription, so the
    // subscription is live before the peer publishes; one that asks later is answered by autoAuth.
    await Promise.all(
      connections
        .filter((c) => c.challenge !== undefined)
        .map((c) => c.authenticate((t) => session.signAuth(t)).catch(() => undefined))
    );
    const link = new PairingLink(session, connections, handlers, now);
    for (const connection of connections) {
      connection.subscribe([session.filter], {
        onEvent: (event) => link.#enqueue(() => link.#apply(session.receive(event, link.#now()))),
      });
    }
    if (session instanceof PairingTarget) {
      await link.#publish(session.offer);
    }
    link.#arm();
    return link;
  }

  /** Runs a step the caller got from the session (a confirm, a deny, `stored`). */
  apply(step: PairingStep): Promise<void> {
    return this.#enqueue(() => this.#apply(step));
  }

  /**
   * Runs a step from inside an `onNotice` handler, which already holds the queue: `apply` there
   * would wait for itself.
   */
  applyInline(step: PairingStep): Promise<void> {
    return this.#apply(step);
  }

  /** Runs `fn` after everything already queued, so publishes keep their order. */
  #enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch((error: unknown) => this.#handlers.onError?.(error as Error));
    return next;
  }

  async #apply(step: PairingStep): Promise<void> {
    for (const event of step.publish) await this.#publish(event);
    if (step.notice !== undefined) await this.#handlers.onNotice(step.notice);
    this.#arm();
    if (this.session.terminal) this.close();
  }

  async #publish(event: NostrEvent): Promise<void> {
    if (this.#closed) return;
    const report = await publishToAll(this.#connections, event);
    if (report.accepted.length === 0) {
      throw new SetupError(
        `No pairing relay accepted the message (${report.refused.map((r) => r.reason).join('; ')}).`
      );
    }
  }

  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const deadline = this.session.nextDeadline;
    if (deadline === undefined || this.#closed) return;
    this.#timer = setTimeout(
      () => {
        void this.#enqueue(() => this.#apply(this.session.tick(this.#now())));
      },
      Math.max(0, deadline - this.#now())
    );
  }

  /** Stops the timer and closes the connections. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    closeAll(this.#connections);
  }

  get closed(): boolean {
    return this.#closed;
  }
}
