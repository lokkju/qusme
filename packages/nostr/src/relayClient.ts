/**
 * A small NIP-01 and NIP-42 relay client for the extension and the PWA. One connection per
 * relay and identity: it authenticates as whichever keys the caller asks for (the queue key on a
 * storage relay that wants AUTH, the inbox key on the inbox relay, a pairing session's ephemeral
 * key, a probe's throwaway keys), and NIP-42 allows several on one connection.
 *
 * nostr-tools' `AbstractRelay` was the alternative. It authenticates only after a relay answers
 * `auth-required`, with one `onauth` callback per connection, and it reconnects and pings on its
 * own; the probes of spec 9.1 need to choose exactly which key a connection is authenticated as,
 * and to see a refusal as a refusal. This client does no reconnecting: a caller that wants a long
 * subscription (sync, 11.4) opens a new connection when {@link RelayConnection.closed} resolves.
 *
 * The socket is injected ({@link SocketFactory}), so tests run against an in-process relay and the
 * extension's service worker and popup use the platform `WebSocket`.
 */
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { KIND_RELAY_AUTH } from './kinds.ts';

// The package compiles without DOM or Node types; these are the platform globals it uses.
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/** The part of the WebSocket API the client uses; the platform `WebSocket` satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** Signs an AUTH event template (kind 22242); a {@link Signer}'s `signEvent` fits. */
export type AuthSigner = (template: EventTemplate) => Promise<NostrEvent> | NostrEvent;

export interface RelayClientOptions {
  /** Defaults to the platform `WebSocket`. */
  socket?: SocketFactory;
  /** Milliseconds to wait for the socket to open. */
  connectTimeoutMs?: number;
  /** Milliseconds to wait for an `OK`, an `EOSE` or an AUTH challenge. */
  timeoutMs?: number;
  /**
   * Signs AUTH when the relay refuses a publish or a query with `auth-required`; the client then
   * retries once. Leave it out and such a refusal is reported as one.
   */
  autoAuth?: AuthSigner;
}

export const RELAY_CONNECT_TIMEOUT_MS = 8000;
export const RELAY_TIMEOUT_MS = 8000;

/** A relay refused something or never answered; `message` is the relay's text or the reason. */
export class RelayError extends Error {
  readonly url: string;
  readonly reason: string;
  constructor(url: string, reason: string) {
    super(`${url}: ${reason}`);
    this.url = url;
    this.reason = reason;
  }
}

const isAuthRequired = (message: string): boolean => message.startsWith('auth-required');

type Message = [string, ...unknown[]];

const defaultSocket: SocketFactory = (url) => {
  const Platform = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (Platform === undefined) throw new Error('no WebSocket in this environment');
  return new Platform(url);
};

/**
 * One open connection to one relay. Create it with {@link RelayConnection.open}.
 */
export class RelayConnection {
  readonly url: string;
  /** Pubkeys this connection has authenticated as. */
  readonly authenticated = new Set<string>();
  /** Resolves when the socket closes, with the reason. */
  readonly closed: Promise<string>;
  #socket: SocketLike;
  #challenge: string | undefined;
  #listeners = new Set<(message: Message) => void>();
  #isClosed = false;
  #closeReason: string | undefined;
  #timeoutMs: number;
  #autoAuth: AuthSigner | undefined;
  #serial = 0;
  #resolveClosed!: (reason: string) => void;

  private constructor(url: string, socket: SocketLike, options: RelayClientOptions) {
    this.url = url;
    this.#socket = socket;
    this.#timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
    this.#autoAuth = options.autoAuth;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.onmessage = (event) => this.#onMessage(event.data);
    socket.onclose = () => this.#markClosed('connection closed');
    socket.onerror = () => this.#markClosed('connection error');
  }

  /** Opens a connection. Rejects with a {@link RelayError} if it doesn't open in time. */
  static open(url: string, options: RelayClientOptions = {}): Promise<RelayConnection> {
    const factory = options.socket ?? defaultSocket;
    const timeout = options.connectTimeoutMs ?? RELAY_CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = factory(url);
      } catch (error) {
        reject(new RelayError(url, `cannot connect: ${(error as Error).message}`));
        return;
      }
      // Messages that arrive between open and the constructor (an AUTH challenge) are kept.
      const early: unknown[] = [];
      socket.onmessage = (event) => early.push(event.data);
      const timer = setTimeout(() => {
        socket.onopen = socket.onerror = socket.onclose = null;
        try {
          socket.close();
        } catch {
          // already closed
        }
        reject(new RelayError(url, 'connection timed out'));
      }, timeout);
      const fail = (): void => {
        clearTimeout(timer);
        reject(new RelayError(url, 'cannot connect'));
      };
      socket.onerror = fail;
      socket.onclose = fail;
      socket.onopen = () => {
        clearTimeout(timer);
        socket.onopen = null;
        const connection = new RelayConnection(url, socket, options);
        for (const data of early) connection.#onMessage(data);
        resolve(connection);
      };
    });
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }

  /** The relay's latest AUTH challenge, if it sent one. */
  get challenge(): string | undefined {
    return this.#challenge;
  }

  #markClosed(reason: string): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#closeReason = reason;
    this.#resolveClosed(reason);
    for (const listener of [...this.#listeners]) listener(['__closed', reason]);
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string' || data.length > 512 * 1024) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== 'string') return;
    if (message[0] === 'AUTH' && typeof message[1] === 'string') this.#challenge = message[1];
    for (const listener of [...this.#listeners]) listener(message as Message);
  }

  #send(message: unknown[]): void {
    if (this.#isClosed) throw new RelayError(this.url, this.#closeReason ?? 'connection closed');
    this.#socket.send(JSON.stringify(message));
  }

  /** Waits for a message matching `match`, the socket closing, or the timeout. */
  #waitFor(match: (message: Message) => boolean, timeoutMs: number): Promise<Message | undefined> {
    return new Promise((resolve) => {
      const done = (message: Message | undefined): void => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(message);
      };
      const listener = (message: Message): void => {
        if (message[0] === '__closed') done(undefined);
        else if (match(message)) done(message);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.#listeners.add(listener);
    });
  }

  /**
   * Authenticates as the signer's key (NIP-42), waiting for a challenge if none came yet.
   * Rejects with a {@link RelayError} if no challenge arrives, the relay refuses, or no `OK`.
   */
  async authenticate(sign: AuthSigner): Promise<string> {
    if (this.#challenge === undefined) {
      await this.#waitFor((m) => m[0] === 'AUTH' && typeof m[1] === 'string', this.#timeoutMs);
    }
    const challenge = this.#challenge;
    if (challenge === undefined) throw new RelayError(this.url, 'sent no AUTH challenge');
    const event = await sign({
      kind: KIND_RELAY_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['relay', this.url],
        ['challenge', challenge],
      ],
      content: '',
    });
    const ok = this.#waitFor((m) => m[0] === 'OK' && m[1] === event.id, this.#timeoutMs);
    this.#send(['AUTH', event]);
    const answer = await ok;
    if (answer === undefined) throw new RelayError(this.url, 'no answer to AUTH');
    if (answer[2] !== true)
      throw new RelayError(this.url, `refused AUTH: ${String(answer[3] ?? '')}`);
    this.authenticated.add(event.pubkey);
    return event.pubkey;
  }

  /**
   * Publishes an event and waits for the relay's `OK`. Rejects with a {@link RelayError} carrying
   * the relay's message on a refusal or a timeout. Retries once after AUTH on `auth-required`
   * when the connection has `autoAuth`.
   */
  async publish(event: NostrEvent): Promise<void> {
    const answer = await this.#publishOnce(event);
    if (answer.ok) return;
    if (isAuthRequired(answer.message) && this.#autoAuth !== undefined) {
      await this.authenticate(this.#autoAuth);
      const retry = await this.#publishOnce(event);
      if (retry.ok) return;
      throw new RelayError(this.url, retry.message);
    }
    throw new RelayError(this.url, answer.message);
  }

  async #publishOnce(event: NostrEvent): Promise<{ ok: boolean; message: string }> {
    const ok = this.#waitFor((m) => m[0] === 'OK' && m[1] === event.id, this.#timeoutMs);
    this.#send(['EVENT', event]);
    const answer = await ok;
    if (answer === undefined) {
      return { ok: false, message: this.#closeReason ?? 'no OK (timed out)' };
    }
    return { ok: answer[2] === true, message: String(answer[3] ?? '') };
  }

  /**
   * The stored events matching the filters, collected until `EOSE`. A `CLOSED` with
   * `auth-required` is retried once after AUTH when the connection has `autoAuth`; any other
   * `CLOSED`, or one with no `autoAuth`, rejects with the relay's message. Rejects on a timeout.
   */
  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const first = await this.#queryOnce(filters);
    if (first.closed === undefined) return first.events;
    if (isAuthRequired(first.closed) && this.#autoAuth !== undefined) {
      await this.authenticate(this.#autoAuth);
      const retry = await this.#queryOnce(filters);
      if (retry.closed === undefined) return retry.events;
      throw new RelayError(this.url, retry.closed);
    }
    throw new RelayError(this.url, first.closed);
  }

  async #queryOnce(filters: Filter[]): Promise<{ events: NostrEvent[]; closed?: string }> {
    const id = `q${++this.#serial}`;
    const events: NostrEvent[] = [];
    const end = new Promise<{ events: NostrEvent[]; closed?: string }>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
      };
      const listener = (m: Message): void => {
        if (m[0] === '__closed') {
          done();
          reject(new RelayError(this.url, String(m[1])));
        } else if (m[1] !== id) {
          return;
        } else if (m[0] === 'EVENT' && isEventShape(m[2])) {
          events.push(m[2]);
        } else if (m[0] === 'EOSE') {
          done();
          this.#trySend(['CLOSE', id]);
          resolve({ events });
        } else if (m[0] === 'CLOSED') {
          done();
          resolve({ events, closed: String(m[2] ?? '') });
        }
      };
      const timer = setTimeout(() => {
        done();
        this.#trySend(['CLOSE', id]);
        reject(new RelayError(this.url, 'no EOSE (timed out)'));
      }, this.#timeoutMs);
      this.#listeners.add(listener);
    });
    this.#send(['REQ', id, ...filters]);
    return end;
  }

  /**
   * A live subscription. `onEvent` gets every event, stored and new; `onClosed` the relay's
   * `CLOSED` message or the connection's end. Returns a function that ends it.
   */
  subscribe(
    filters: Filter[],
    handlers: { onEvent: (event: NostrEvent) => void; onClosed?: (reason: string) => void }
  ): () => void {
    const id = `s${++this.#serial}`;
    let open = true;
    const listener = (m: Message): void => {
      if (m[0] === '__closed') {
        stop();
        handlers.onClosed?.(String(m[1]));
      } else if (m[1] !== id) {
        return;
      } else if (m[0] === 'EVENT' && isEventShape(m[2])) {
        handlers.onEvent(m[2]);
      } else if (m[0] === 'CLOSED') {
        this.#listeners.delete(listener);
        open = false;
        handlers.onClosed?.(String(m[2] ?? ''));
      }
    };
    const stop = (): void => {
      if (!open) return;
      open = false;
      this.#listeners.delete(listener);
      this.#trySend(['CLOSE', id]);
    };
    this.#listeners.add(listener);
    this.#send(['REQ', id, ...filters]);
    return stop;
  }

  #trySend(message: unknown[]): void {
    if (this.#isClosed) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      // closing anyway
    }
  }

  close(): void {
    if (this.#isClosed) return;
    try {
      this.#socket.close();
    } catch {
      // already closed
    }
    this.#markClosed('closed by client');
  }
}

function isEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.kind === 'number' &&
    typeof e.created_at === 'number' &&
    typeof e.content === 'string' &&
    typeof e.sig === 'string' &&
    Array.isArray(e.tags)
  );
}

/** Newest first by `created_at`, ties broken by lowest id (NIP-01's rule for replaceables). */
export function newestFirst(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What happened on each relay of a fan-out publish. */
export interface PublishReport {
  accepted: string[];
  refused: { url: string; reason: string }[];
}

/** Publishes one event on every connection; never rejects. */
export async function publishToAll(
  connections: readonly RelayConnection[],
  event: NostrEvent
): Promise<PublishReport> {
  const report: PublishReport = { accepted: [], refused: [] };
  await Promise.all(
    connections.map(async (connection) => {
      try {
        await connection.publish(event);
        report.accepted.push(connection.url);
      } catch (error) {
        const reason = error instanceof RelayError ? error.reason : (error as Error).message;
        report.refused.push({ url: connection.url, reason });
      }
    })
  );
  return report;
}

/** Queries every connection and merges the results by id; a relay that fails is skipped. */
export async function queryAll(
  connections: readonly RelayConnection[],
  filters: Filter[]
): Promise<NostrEvent[]> {
  const results = await Promise.allSettled(connections.map((c) => c.query(filters)));
  const byId = new Map<string, NostrEvent>();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value) byId.set(event.id, event);
  }
  return [...byId.values()].sort(newestFirst);
}
