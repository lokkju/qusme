import { createLocalSigner, giftWrap, KIND_FIELD_VALUE } from '@qusme/nostr';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createWebSocketRelayPublisher } from '../../src/index.ts';
import type { RelaySocket, WebSocketCtor } from '../../src/oauth/relayReader.ts';
import { fakeInboxRelay } from './fakes.ts';

const RELAY = 'wss://inbox.example/';
const agent = createLocalSigner(generateSecretKey());
const connection = createLocalSigner(generateSecretKey());
const recipient = createLocalSigner(generateSecretKey());

async function wrap() {
  return giftWrap(
    { kind: KIND_FIELD_VALUE, content: 'hi', tags: [] },
    agent,
    await recipient.getPublicKey()
  );
}

describe('WebSocket relay publisher', () => {
  it('publishes to a relay that asks for nothing', async () => {
    const relay = fakeInboxRelay();
    const event = await wrap();
    const publisher = createWebSocketRelayPublisher({ WebSocket: relay.WebSocket });
    expect(await publisher.publish({ relays: [RELAY], event, auth: connection })).toEqual([
      { relay: RELAY, ok: true, message: '' },
    ]);
    expect(relay.stored.map((e) => e.id)).toEqual([event.id]);
    expect(relay.connections[0]?.authed).toEqual([]);
  });

  it('authenticates when the relay asks and sends the event again', async () => {
    const relay = fakeInboxRelay({ requireAuth: true });
    const event = await wrap();
    const publisher = createWebSocketRelayPublisher({ WebSocket: relay.WebSocket });
    const [result] = await publisher.publish({
      relays: [RELAY],
      event,
      auth: connection,
      fallbackAuth: agent,
    });
    expect(result?.ok).toBe(true);
    expect(relay.connections).toHaveLength(1);
    expect(relay.connections[0]?.authed).toEqual([await connection.getPublicKey()]);
    expect(relay.stored).toHaveLength(1);
  });

  it('falls back to the agent key on a relay that admits only submitters', async () => {
    const relay = fakeInboxRelay({ requireAuth: true, submitters: [await agent.getPublicKey()] });
    const event = await wrap();
    const publisher = createWebSocketRelayPublisher({ WebSocket: relay.WebSocket });
    const [result] = await publisher.publish({
      relays: [RELAY],
      event,
      auth: connection,
      fallbackAuth: agent,
    });
    expect(result?.ok).toBe(true);
    expect(relay.connections.map((c) => c.authed)).toEqual([
      [await connection.getPublicKey()],
      [await agent.getPublicKey()],
    ]);
    expect(relay.stored).toHaveLength(1);
  });

  it('reports a refusal, and does not fall back without a fallback key', async () => {
    const relay = fakeInboxRelay({ requireAuth: true, submitters: [await agent.getPublicKey()] });
    const publisher = createWebSocketRelayPublisher({ WebSocket: relay.WebSocket });
    const [result] = await publisher.publish({
      relays: [RELAY],
      event: await wrap(),
      auth: connection,
    });
    expect(result).toEqual({ relay: RELAY, ok: false, message: 'restricted: not a submitter' });
    expect(relay.connections).toHaveLength(1);
    expect(relay.stored).toHaveLength(0);
  });

  it('gives up on a silent relay, and on one it cannot connect to', async () => {
    class Silent implements RelaySocket {
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    const silent = createWebSocketRelayPublisher({ WebSocket: Silent, timeoutMs: 20 });
    expect(await silent.publish({ relays: [RELAY], event: await wrap() })).toEqual([
      { relay: RELAY, ok: false, message: 'timeout' },
    ]);
    const Broken = class {
      constructor() {
        throw new Error('refused');
      }
    } as unknown as WebSocketCtor;
    const broken = createWebSocketRelayPublisher({ WebSocket: Broken });
    expect(await broken.publish({ relays: [RELAY], event: await wrap() })).toEqual([
      { relay: RELAY, ok: false, message: 'connection failed' },
    ]);
  });
});
