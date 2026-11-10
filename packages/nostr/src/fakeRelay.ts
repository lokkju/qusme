/**
 * An in-process Nostr relay for tests, exported from `@qusme/nostr/testing`. It speaks NIP-01 and
 * NIP-42 over {@link SocketLike} and models the behavior spec 9.1 cares about: replaceable,
 * addressable and ephemeral kinds, NIP-09 deletion by the author (and, optionally, by a gift
 * wrap's recipient), NIP-40 expiry at read time, an event size limit, and an inbox relay's rule
 * that kind 1059 is readable only by a connection authenticated as its `p`-tagged pubkey.
 */
import type { NostrEvent } from 'nostr-tools/core';
import { type Filter, matchFilter } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';
import { KIND_DELETION, KIND_GIFT_WRAP, KIND_RELAY_AUTH } from './kinds.ts';
import type { SocketFactory, SocketLike } from './relayClient.ts';

declare const setTimeout: (callback: () => void, ms: number) => unknown;

export interface FakeRelayOptions {
  /** NIP-42 required before any REQ or EVENT. */
  authRequired?: boolean;
  /** Kind 1059 readable only by its `p`-tagged pubkey; unauthenticated reads are refused. */
  restrictGiftWraps?: boolean;
  /** Kinds refused on write with `blocked:`. */
  refuseKinds?: number[];
  /** Largest event accepted, as JSON bytes; default 65536 (strfry's default). */
  maxEventSize?: number;
  /** Honor NIP-09 deletion from the author; default true. */
  honorDeletion?: boolean;
  /** Also honor deletion of a gift wrap by its `p`-tagged recipient (NIP-17). */
  recipientDeletion?: boolean;
  /** Sends a challenge but refuses every AUTH, as one probed relay did (spec 9.1). */
  brokenAuth?: boolean;
  /** Accepts writes but stores nothing, so reads come back empty. */
  dropWrites?: boolean;
  /**
   * Answers an EVENT with nothing at all (no OK, NOTICE or CLOSED) and stores nothing, while
   * REQs are answered as usual: what nos.lol did on 2026-11-09 (`docs/relays.md`).
   */
  silentWrites?: boolean;
  /** Unix seconds for NIP-40 checks; defaults to the clock. */
  now?: () => number;
}

interface Connection {
  socket: FakeSocket;
  challenge: string;
  authed: Set<string>;
  subs: Map<string, Filter[]>;
}

// NIP-01: metadata and follow lists are replaceable too.
const REPLACEABLE_LOW = [0, 3];
const isReplaceable = (kind: number): boolean =>
  REPLACEABLE_LOW.includes(kind) || (kind >= 10000 && kind < 20000);
const isEphemeral = (kind: number): boolean => kind >= 20000 && kind < 30000;
const isAddressable = (kind: number): boolean => kind >= 30000 && kind < 40000;
const dTag = (event: NostrEvent): string => event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
const pTags = (event: NostrEvent): string[] =>
  event.tags.filter((t) => t[0] === 'p').map((t) => t[1] as string);

let challengeSerial = 0;

export class FakeRelay {
  readonly url: string;
  readonly options: FakeRelayOptions;
  /** Every event the relay accepted, ephemeral ones included, in order. */
  readonly accepted: NostrEvent[] = [];
  /** Every REQ received: the connection's AUTH pubkeys and the filters. */
  readonly requests: { authed: string[]; filters: Filter[] }[] = [];
  #stored = new Map<string, NostrEvent>();
  #deleted = new Set<string>();
  #connections = new Set<Connection>();

  constructor(url: string, options: FakeRelayOptions = {}) {
    this.url = url;
    this.options = options;
  }

  /** Events stored now, expired ones included. */
  get events(): NostrEvent[] {
    return [...this.#stored.values()];
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  #now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Opens a connection; the network calls this. */
  connect(): SocketLike {
    const socket = new FakeSocket();
    const connection: Connection = {
      socket,
      challenge: `challenge-${++challengeSerial}`,
      authed: new Set(),
      subs: new Map(),
    };
    socket.peer = (data) => this.#receive(connection, data);
    socket.onPeerClose = () => this.#connections.delete(connection);
    this.#connections.add(connection);
    socket.open();
    if (this.options.authRequired || this.options.restrictGiftWraps || this.options.brokenAuth) {
      socket.deliver(['AUTH', connection.challenge]);
    }
    return socket;
  }

  /** Closes every connection, as a relay restart would. */
  disconnectAll(): void {
    for (const connection of this.#connections) connection.socket.serverClose();
    this.#connections.clear();
  }

  #receive(connection: Connection, data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      connection.socket.deliver(['NOTICE', 'invalid: not JSON']);
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, ...rest] = message as [unknown, ...unknown[]];
    if (type === 'EVENT') this.#onEvent(connection, rest[0] as NostrEvent);
    else if (type === 'REQ') this.#onReq(connection, rest[0] as string, rest.slice(1) as Filter[]);
    else if (type === 'CLOSE') connection.subs.delete(rest[0] as string);
    else if (type === 'AUTH') this.#onAuth(connection, rest[0] as NostrEvent);
  }

  #onAuth(connection: Connection, event: NostrEvent): void {
    const refusal = this.#authRefusal(connection, event);
    if (refusal === undefined) connection.authed.add(event.pubkey);
    connection.socket.deliver(['OK', event?.id ?? '', refusal === undefined, refusal ?? '']);
  }

  #authRefusal(connection: Connection, event: NostrEvent): string | undefined {
    if (this.options.brokenAuth) return 'restricted: auth is not available';
    if (typeof event !== 'object' || event === null || !verifyEvent(event)) {
      return 'invalid: bad signature';
    }
    const challenge = event.tags.find((t) => t[0] === 'challenge')?.[1];
    const relay = event.tags.find((t) => t[0] === 'relay')?.[1];
    if (
      event.kind !== KIND_RELAY_AUTH ||
      challenge !== connection.challenge ||
      relay !== this.url
    ) {
      return 'invalid: wrong challenge, relay or kind';
    }
    if (Math.abs(event.created_at - this.#now()) > 600) return 'invalid: stale';
    return undefined;
  }

  #onEvent(connection: Connection, event: NostrEvent): void {
    if (this.options.silentWrites) return;
    const id = typeof event === 'object' && event !== null ? event.id : '';
    const refusal = this.#writeRefusal(connection, event);
    connection.socket.deliver(['OK', id, refusal === undefined, refusal ?? '']);
    if (refusal !== undefined) return;
    this.accepted.push(event);
    if (this.options.dropWrites) return;
    if (event.kind === KIND_DELETION) this.#applyDeletion(event);
    if (!isEphemeral(event.kind)) this.#store(event);
    this.#broadcast(event);
  }

  #writeRefusal(connection: Connection, event: NostrEvent): string | undefined {
    if (this.options.authRequired && connection.authed.size === 0) {
      return 'auth-required: authenticate first';
    }
    if (typeof event !== 'object' || event === null || !verifyEvent(event)) {
      return 'invalid: bad signature';
    }
    if (JSON.stringify(event).length > (this.options.maxEventSize ?? 65536)) {
      return 'invalid: event too large';
    }
    if (this.options.refuseKinds?.includes(event.kind)) {
      return `blocked: kind ${event.kind} is not accepted here`;
    }
    if (this.#deleted.has(event.id)) return 'blocked: deleted';
    return undefined;
  }

  #store(event: NostrEvent): void {
    let key = event.id;
    if (isReplaceable(event.kind)) key = `${event.kind}:${event.pubkey}`;
    else if (isAddressable(event.kind)) key = `${event.kind}:${event.pubkey}:${dTag(event)}`;
    const existing = this.#stored.get(key);
    if (existing !== undefined && existing.created_at > event.created_at) return;
    this.#stored.set(key, event);
  }

  #applyDeletion(deletion: NostrEvent): void {
    if (this.options.honorDeletion === false) return;
    const ids = new Set(deletion.tags.filter((t) => t[0] === 'e').map((t) => t[1]));
    const addresses = new Set(deletion.tags.filter((t) => t[0] === 'a').map((t) => t[1]));
    for (const [key, event] of this.#stored) {
      const byAuthor = event.pubkey === deletion.pubkey;
      const byRecipient =
        this.options.recipientDeletion === true &&
        event.kind === KIND_GIFT_WRAP &&
        pTags(event).includes(deletion.pubkey);
      const address = `${event.kind}:${event.pubkey}:${dTag(event)}`;
      if (
        (ids.has(event.id) && (byAuthor || byRecipient)) ||
        (byAuthor && addresses.has(address))
      ) {
        this.#stored.delete(key);
        this.#deleted.add(event.id);
      }
    }
  }

  #readable(connection: Connection, event: NostrEvent): boolean {
    const expiration = event.tags.find((t) => t[0] === 'expiration')?.[1];
    if (expiration !== undefined && Number(expiration) <= this.#now()) return false;
    if (this.options.restrictGiftWraps && event.kind === KIND_GIFT_WRAP) {
      return pTags(event).some((p) => connection.authed.has(p));
    }
    return true;
  }

  #onReq(connection: Connection, id: string, filters: Filter[]): void {
    this.requests.push({ authed: [...connection.authed], filters });
    if (this.options.authRequired && connection.authed.size === 0) {
      connection.socket.deliver(['CLOSED', id, 'auth-required: authenticate first']);
      return;
    }
    const wantsWraps = filters.some((f) => f.kinds?.includes(KIND_GIFT_WRAP));
    if (this.options.restrictGiftWraps && wantsWraps && connection.authed.size === 0) {
      connection.socket.deliver(['CLOSED', id, 'auth-required: gift wraps need AUTH']);
      return;
    }
    connection.subs.set(id, filters);
    const matches = [...this.#stored.values()]
      .filter((e) => filters.some((f) => matchFilter(f, e)) && this.#readable(connection, e))
      .sort((a, b) => b.created_at - a.created_at);
    const limit = Math.min(...filters.map((f) => f.limit ?? Number.POSITIVE_INFINITY));
    for (const event of matches.slice(0, limit)) connection.socket.deliver(['EVENT', id, event]);
    connection.socket.deliver(['EOSE', id]);
  }

  #broadcast(event: NostrEvent): void {
    for (const connection of this.#connections) {
      for (const [id, filters] of connection.subs) {
        if (filters.some((f) => matchFilter(f, event)) && this.#readable(connection, event)) {
          connection.socket.deliver(['EVENT', id, event]);
        }
      }
    }
  }
}

/** One side of an in-process socket; messages are delivered on a later macrotask. */
class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  peer: ((data: string) => void) | undefined;
  onPeerClose: (() => void) | undefined;
  #closed = false;

  open(): void {
    setTimeout(() => {
      if (!this.#closed) this.onopen?.({});
    }, 0);
  }

  deliver(message: unknown[]): void {
    const data = JSON.stringify(message);
    setTimeout(() => {
      if (!this.#closed) this.onmessage?.({ data });
    }, 0);
  }

  send(data: string): void {
    if (this.#closed) throw new Error('socket is closed');
    setTimeout(() => {
      if (!this.#closed) this.peer?.(data);
    }, 0);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onPeerClose?.();
    setTimeout(() => this.onclose?.({}), 0);
  }

  serverClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    setTimeout(() => this.onclose?.({}), 0);
  }
}

/** A set of fake relays by URL, with a {@link SocketFactory} for the relay client. */
export class FakeRelayNetwork {
  readonly relays = new Map<string, FakeRelay>();

  add(url: string, options: FakeRelayOptions = {}): FakeRelay {
    const relay = new FakeRelay(url, options);
    this.relays.set(url, relay);
    return relay;
  }

  get(url: string): FakeRelay {
    const relay = this.relays.get(url);
    if (relay === undefined) throw new Error(`no fake relay at ${url}`);
    return relay;
  }

  /** Connects to the relay at `url`; an unknown URL fails the way an unreachable host does. */
  readonly socket: SocketFactory = (url) => {
    const relay = this.relays.get(url);
    if (relay !== undefined) return relay.connect();
    const socket = new FakeSocket();
    setTimeout(() => socket.onerror?.({}), 0);
    return socket;
  };
}
