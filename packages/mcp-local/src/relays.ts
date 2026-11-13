/**
 * Relays for the local server: the service's own WebSocket relay reader and publisher
 * (`@qusme/core/mcp`), over Node's global WebSocket by default, or over a `@qusme/nostr`
 * {@link SocketFactory} (the tests' fake relays) through {@link socketConstructor}.
 */
import {
  createWebSocketRelayPublisher,
  createWebSocketRelayReader,
  type RelayPublisher,
  type RelayReader,
  type RelaySocket,
  type WebSocketCtor,
} from '@qusme/core/mcp';
import type { SocketFactory } from '@qusme/nostr';

export interface Relays {
  reader: RelayReader;
  publisher: RelayPublisher;
}

/** A WebSocket constructor whose sockets come from `factory` (`onX` setters to `addEventListener`). */
export function socketConstructor(factory: SocketFactory): WebSocketCtor {
  return class implements RelaySocket {
    #socket: ReturnType<SocketFactory>;
    #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    constructor(url: string) {
      this.#socket = factory(url);
      const fire = (type: string) => (event: unknown) => {
        for (const listener of this.#listeners.get(type) ?? []) {
          listener((event ?? {}) as { data: unknown });
        }
      };
      this.#socket.onopen = fire('open');
      this.#socket.onmessage = fire('message');
      this.#socket.onclose = fire('close');
      this.#socket.onerror = fire('error');
    }
    send(data: string): void {
      this.#socket.send(data);
    }
    close(): void {
      this.#socket.close();
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }
  } as unknown as WebSocketCtor;
}

export function createRelays(options: { socket?: SocketFactory; timeoutMs?: number } = {}): Relays {
  const WebSocket = options.socket === undefined ? undefined : socketConstructor(options.socket);
  const common = {
    ...(WebSocket !== undefined && { WebSocket }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  };
  return {
    reader: createWebSocketRelayReader(common),
    publisher: createWebSocketRelayPublisher(common),
  };
}
