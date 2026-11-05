/**
 * Publishing a submission's gift wrap to the grant's inbox relays (spec 7.5, 8.4): one WebSocket
 * per relay, `EVENT`, NIP-42 AUTH when the relay sends a challenge, and the `EVENT` again if the
 * relay refused it with `auth-required:`. A relay counts only when it answers `OK` true for the
 * event id. The publisher is injected into the app, so tests use a fake relay; the default uses
 * the runtime's global WebSocket, which Workers and Node 24 both provide.
 */
import type { NostrEvent, Signer } from '@qusme/nostr';
import { makeAuthEvent } from 'nostr-tools/nip42';
import type { WebSocketCtor } from '../oauth/relayReader.ts';

export interface RelayPublishRequest {
  relays: readonly string[];
  event: NostrEvent;
  /**
   * Signs NIP-42 AUTH when a relay asks. The service passes a key generated for the connection,
   * so a relay that only wants some authenticated connection does not learn which agent sent the
   * wrap (7.5).
   */
  auth?: Signer;
  /**
   * Signs AUTH on a second attempt, made only when the relay refused the event after an AUTH as
   * `auth` with `restricted:` or `auth-required:`: a relay meeting the qus.me relay profile
   * accepts a gift wrap only from a connection authenticated as a listed submitter (9.2 rule 3),
   * so the service then authenticates as the agent key.
   */
  fallbackAuth?: Signer;
}

export interface RelayPublishResult {
  relay: string;
  ok: boolean;
  /** The relay's `OK` message, or why there was none (`timeout`, `connection failed`). */
  message: string;
}

export interface RelayPublisher {
  publish(request: RelayPublishRequest): Promise<RelayPublishResult[]>;
}

export interface WebSocketRelayPublisherOptions {
  WebSocket?: WebSocketCtor;
  /** How long to wait on each relay for its `OK`. */
  timeoutMs?: number;
  /** Messages larger than this are ignored. */
  maxMessageBytes?: number;
}

/** Longest relay message kept in a result; relays are untrusted. */
const MAX_REASON = 200;

interface Attempt {
  ok: boolean;
  message: string;
  /** Whether the connection authenticated before the relay answered. */
  authed: boolean;
}

const needsAuth = (message: string) =>
  message.startsWith('auth-required:') || message.startsWith('restricted:');

export function createWebSocketRelayPublisher(
  options: WebSocketRelayPublisherOptions = {}
): RelayPublisher {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxMessageBytes = options.maxMessageBytes ?? 16 * 1024;

  function attempt(url: string, event: NostrEvent, auth: Signer | undefined): Promise<Attempt> {
    const Ctor =
      options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
    if (Ctor === undefined) {
      return Promise.resolve({ ok: false, message: 'no WebSocket', authed: false });
    }
    return new Promise((resolve) => {
      let ws: RelaySocketLike;
      let authEventId: string | undefined;
      let authed = false;
      let resent = false;
      let waitingForAuth = false;
      let settled = false;

      const finish = (ok: boolean, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve({ ok, message: message.slice(0, MAX_REASON), authed });
      };
      const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
      const send = (msg: unknown[]) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          finish(false, 'connection failed');
        }
      };
      const sendEvent = () => send(['EVENT', event]);

      try {
        ws = new Ctor(url);
      } catch {
        clearTimeout(timer);
        resolve({ ok: false, message: 'connection failed', authed: false });
        return;
      }
      ws.addEventListener('open', () => sendEvent());
      ws.addEventListener('error', () => finish(false, 'connection failed'));
      ws.addEventListener('close', () => finish(false, 'connection closed'));
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
        const [type, a, b, c] = msg as [unknown, unknown, unknown, unknown];
        if (type === 'AUTH' && typeof a === 'string' && auth && authEventId === undefined) {
          auth
            .signEvent(makeAuthEvent(url, a))
            .then((authEvent) => {
              authEventId = authEvent.id;
              send(['AUTH', authEvent]);
            })
            .catch(() => finish(false, 'auth failed'));
        } else if (type === 'OK' && a === authEventId && authEventId !== undefined) {
          authed = b === true;
          if (!authed) finish(false, typeof c === 'string' ? c : 'auth refused');
          else if (waitingForAuth) {
            waitingForAuth = false;
            sendEvent();
          }
        } else if (type === 'OK' && a === event.id) {
          const reason = typeof c === 'string' ? c : '';
          if (b === true) finish(true, reason);
          else if (reason.startsWith('auth-required:') && auth && !resent) {
            resent = true;
            if (authed) sendEvent();
            else waitingForAuth = true;
          } else finish(false, reason || 'refused');
        }
      });
    });
  }

  async function publishOne(
    url: string,
    request: RelayPublishRequest
  ): Promise<RelayPublishResult> {
    const first = await attempt(url, request.event, request.auth);
    if (first.ok || !request.fallbackAuth || !first.authed || !needsAuth(first.message)) {
      return { relay: url, ok: first.ok, message: first.message };
    }
    const second = await attempt(url, request.event, request.fallbackAuth);
    return { relay: url, ok: second.ok, message: second.message };
  }

  return {
    publish(request) {
      return Promise.all(request.relays.map((url) => publishOne(url, request)));
    },
  };
}

type RelaySocketLike = InstanceType<WebSocketCtor>;
