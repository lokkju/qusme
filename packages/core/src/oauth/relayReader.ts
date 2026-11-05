/**
 * Reading events from a queue's storage relays (spec 8.2 step 5): the service fetches the queue's
 * current submitters list before it completes an authorization, authenticating with NIP-42 as the
 * agent key where a relay asks (9.2). The reader is injected into the app, so tests use a fake and
 * the default opens WebSockets, which both Workers and Node 24 provide as a global.
 */
import type { Signer } from '@qusme/nostr';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { isBlockedHost } from './clientMetadata.ts';

export interface RelayFilter {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  '#d'?: string[];
  '#p'?: string[];
  limit?: number;
}

export interface RelayQuery {
  relays: readonly string[];
  filter: RelayFilter;
  /** Signs NIP-42 AUTH events when a relay asks for authentication. */
  auth?: Signer;
}

/**
 * Returns the events the relays sent for the filter, from every relay that answered, unverified
 * and not deduplicated: callers verify signatures (the `@qusme/nostr` parsers do) and pick.
 */
export interface RelayReader {
  query(query: RelayQuery): Promise<unknown[]>;
}

/** Most relays an approval may name, and so the most connections one approval opens. */
export const MAX_STORAGE_RELAYS = 5;

/**
 * Checks the storage relays a device named: 1 to {@link MAX_STORAGE_RELAYS} distinct `wss://` URLs
 * whose hosts {@link isBlockedHost} allows, since the service connects to them. Returns them, or
 * a reason.
 */
export function checkStorageRelays(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'relays must be a non-empty array';
  if (value.length > MAX_STORAGE_RELAYS) return `at most ${MAX_STORAGE_RELAYS} relays`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 512) return 'relays must be URLs';
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      return `not a URL: ${item}`;
    }
    if (url.protocol !== 'wss:') return `relays must be wss:// URLs: ${item}`;
    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      return `relay URL must not have credentials or a fragment: ${item}`;
    }
    if (isBlockedHost(url.hostname)) return `relay host not allowed: ${item}`;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * The part of a WebSocket the reader uses, which the DOM's and the Workers runtime's types both
 * have (Workers' type has no `on*` properties, so the reader uses `addEventListener`).
 */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type WebSocketCtor = new (url: string) => RelaySocket;

export interface WebSocketRelayReaderOptions {
  /** The WebSocket constructor; the runtime's global by default. */
  WebSocket?: WebSocketCtor;
  /** How long to wait on each relay before taking what it sent. */
  timeoutMs?: number;
  /** Events kept per relay. */
  maxEvents?: number;
  /** Messages larger than this are ignored. */
  maxMessageBytes?: number;
}

/**
 * A {@link RelayReader} over WebSockets: one connection per relay, a REQ, NIP-42 AUTH when the
 * relay sends a challenge, and the REQ again if the relay closed it with `auth-required:`. Each
 * relay ends at EOSE, a final CLOSED, an error or the timeout; a relay that fails contributes
 * nothing rather than failing the query.
 */
export function createWebSocketRelayReader(options: WebSocketRelayReaderOptions = {}): RelayReader {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxEvents = options.maxEvents ?? 50;
  const maxMessageBytes = options.maxMessageBytes ?? 128 * 1024;

  function readOne(url: string, query: RelayQuery): Promise<unknown[]> {
    const Ctor =
      options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
    if (Ctor === undefined) return Promise.resolve([]);
    return new Promise((resolve) => {
      const events: unknown[] = [];
      const subId = crypto.randomUUID().slice(0, 16);
      let authEventId: string | undefined;
      let authed = false;
      let waitingForAuth = false;
      let retried = false;
      let settled = false;
      let ws: RelaySocket;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.send(JSON.stringify(['CLOSE', subId]));
        } catch {}
        try {
          ws.close();
        } catch {}
        resolve(events);
      };
      const timer = setTimeout(finish, timeoutMs);
      const send = (msg: unknown[]) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          finish();
        }
      };
      const req = () => send(['REQ', subId, query.filter]);

      try {
        ws = new Ctor(url);
      } catch {
        clearTimeout(timer);
        resolve([]);
        return;
      }
      ws.addEventListener('open', () => req());
      ws.addEventListener('error', () => finish());
      ws.addEventListener('close', () => finish());
      ws.addEventListener('message', (message) => {
        if (settled || typeof message.data !== 'string') return;
        if (message.data.length > maxMessageBytes) return;
        let msg: unknown;
        try {
          msg = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        const [type, a, b] = msg as [unknown, unknown, unknown];
        if (type === 'AUTH' && typeof a === 'string' && query.auth && authEventId === undefined) {
          const auth = query.auth;
          auth
            .signEvent(makeAuthEvent(url, a))
            .then((event) => {
              authEventId = event.id;
              send(['AUTH', event]);
            })
            .catch(() => finish());
        } else if (type === 'OK' && a === authEventId && authEventId !== undefined) {
          authed = b === true;
          if (!authed) finish();
          else if (waitingForAuth) {
            waitingForAuth = false;
            req();
          }
        } else if (type === 'EVENT' && a === subId) {
          if (events.length < maxEvents) events.push(b);
        } else if (type === 'EOSE' && a === subId) {
          finish();
        } else if (type === 'CLOSED' && a === subId) {
          const reason = typeof b === 'string' ? b : '';
          if (reason.startsWith('auth-required:') && query.auth && !retried) {
            retried = true;
            if (authed) req();
            else waitingForAuth = true;
          } else {
            finish();
          }
        }
      });
    });
  }

  return {
    async query(query) {
      const results = await Promise.all(query.relays.map((url) => readOne(url, query)));
      return results.flat();
    },
  };
}
