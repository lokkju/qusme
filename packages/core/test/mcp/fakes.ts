/**
 * Fakes of the network the MCP tools reach: storage relays the grant is read from, an inbox relay
 * as a WebSocket the real publisher talks to, and a recording publisher.
 */
import type { NostrEvent } from '@qusme/nostr';
import { verifyEvent } from 'nostr-tools/pure';
import type {
  RelayPublisher,
  RelayPublishRequest,
  RelayPublishResult,
  RelayReader,
} from '../../src/index.ts';
import type { RelayFilter, RelayQuery, RelaySocket } from '../../src/oauth/relayReader.ts';

function matches(filter: RelayFilter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  const d = filter['#d'];
  if (d && !event.tags.some((t) => t[0] === 'd' && d.includes(t[1] as string))) return false;
  return true;
}

/** Storage relays: events by relay URL, served to every query that matches. */
export function fakeStorage() {
  const events = new Map<string, NostrEvent[]>();
  const queries: { query: RelayQuery; authPubkey: string | undefined }[] = [];
  const reader: RelayReader = {
    async query(query) {
      queries.push({ query, authPubkey: await query.auth?.getPublicKey() });
      return query.relays.flatMap((r) =>
        (events.get(r) ?? []).filter((e) => matches(query.filter, e))
      );
    },
  };
  const publish = (event: NostrEvent, relays: readonly string[]) => {
    for (const r of relays) events.set(r, [...(events.get(r) ?? []), event]);
  };
  return { reader, queries, publish, events };
}

/** A publisher that records what it was asked to publish; relays in `failing` refuse. */
export function recordingPublisher() {
  const published: {
    relay: string;
    event: NostrEvent;
    request: RelayPublishRequest;
    /** Taken during the call: the agent key's signer stops working when the call ends. */
    authPubkey: string | undefined;
    fallbackPubkey: string | undefined;
  }[] = [];
  const failing = new Set<string>();
  const publisher: RelayPublisher = {
    async publish(request) {
      const authPubkey = await request.auth?.getPublicKey();
      const fallbackPubkey = await request.fallbackAuth?.getPublicKey();
      return request.relays.map((relay): RelayPublishResult => {
        if (failing.has(relay)) return { relay, ok: false, message: 'error: down' };
        published.push({ relay, event: request.event, request, authPubkey, fallbackPubkey });
        return { relay, ok: true, message: '' };
      });
    },
  };
  return { publisher, published, failing };
}

export interface FakeRelayOptions {
  /** Send an AUTH challenge on connect and refuse events before AUTH with `auth-required:`. */
  requireAuth?: boolean;
  /** Accept a gift wrap only from a connection authenticated as one of these (9.2 rule 3). */
  submitters?: string[];
}

/**
 * An inbox relay behind a fake WebSocket constructor, for the real publisher: NIP-01 `EVENT` and
 * `OK`, and NIP-42 AUTH. Records stored events and the pubkeys each connection authenticated as.
 */
export function fakeInboxRelay(options: FakeRelayOptions = {}) {
  const stored: NostrEvent[] = [];
  const connections: { url: string; authed: string[] }[] = [];

  class FakeSocket implements RelaySocket {
    private listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};
    private readonly challenge = crypto.randomUUID();
    private readonly conn: { url: string; authed: string[] };
    private closed = false;

    constructor(url: string) {
      this.conn = { url, authed: [] };
      connections.push(this.conn);
      queueMicrotask(() => {
        this.emit('open', { data: undefined });
        if (options.requireAuth) this.reply(['AUTH', this.challenge]);
      });
    }

    addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
      const list = this.listeners[type] ?? [];
      list.push(listener);
      this.listeners[type] = list;
    }

    private emit(type: string, event: { data: unknown }) {
      for (const l of this.listeners[type] ?? []) l(event);
    }

    private reply(msg: unknown[]) {
      queueMicrotask(() => {
        if (!this.closed) this.emit('message', { data: JSON.stringify(msg) });
      });
    }

    send(data: string): void {
      const [type, value] = JSON.parse(data) as [string, NostrEvent];
      if (type === 'AUTH') {
        const tag = (name: string) => value.tags.find((t) => t[0] === name)?.[1];
        const good =
          verifyEvent({ ...value }) &&
          value.kind === 22242 &&
          tag('challenge') === this.challenge &&
          tag('relay') === this.conn.url;
        if (good) this.conn.authed.push(value.pubkey);
        this.reply(['OK', value.id, good, good ? '' : 'invalid: bad auth']);
      } else if (type === 'EVENT') {
        if (options.requireAuth && this.conn.authed.length === 0) {
          this.reply(['OK', value.id, false, 'auth-required: authenticate first']);
        } else if (
          options.submitters &&
          !this.conn.authed.some((p) => options.submitters?.includes(p))
        ) {
          this.reply(['OK', value.id, false, 'restricted: not a submitter']);
        } else if (!verifyEvent({ ...value })) {
          this.reply(['OK', value.id, false, 'invalid: bad signature']);
        } else {
          stored.push(value);
          this.reply(['OK', value.id, true, '']);
        }
      }
    }

    close(): void {
      this.closed = true;
    }
  }

  return { WebSocket: FakeSocket, stored, connections };
}
