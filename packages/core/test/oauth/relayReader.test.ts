import { createLocalSigner } from '@qusme/nostr';
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { checkStorageRelays, createWebSocketRelayReader } from '../../src/oauth/relayReader.ts';

type Script = (ws: FakeSocket, msg: unknown[]) => void;

/** A relay behind a fake WebSocket: `script` answers each message the client sends. */
class FakeSocket {
  static scripts = new Map<string, Script>();
  static sockets: FakeSocket[] = [];
  listeners = new Map<string, ((e: { data: unknown }) => void)[]>();
  sent: unknown[][] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.sockets.push(this);
    queueMicrotask(() => this.emit(FakeSocket.scripts.has(url) ? 'open' : 'error'));
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: string) {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  send(data: string) {
    const msg = JSON.parse(data) as unknown[];
    this.sent.push(msg);
    FakeSocket.scripts.get(this.url)?.(this, msg);
  }
  reply(msg: unknown[]) {
    queueMicrotask(() => this.emit('message', JSON.stringify(msg)));
  }
  close() {
    this.closed = true;
  }
}

const reader = (timeoutMs = 200) =>
  createWebSocketRelayReader({
    WebSocket: FakeSocket,
    timeoutMs,
  });
const filter = { kinds: [11235], authors: ['a'.repeat(64)], limit: 1 };

describe('WebSocket relay reader', () => {
  it('collects events until EOSE from every relay and closes', async () => {
    FakeSocket.sockets = [];
    FakeSocket.scripts = new Map<string, Script>([
      [
        'wss://one.example/',
        (ws, [type, sub]) => {
          if (type !== 'REQ') return;
          ws.reply(['EVENT', sub, { id: 'e1' }]);
          ws.reply(['EVENT', 'other-sub', { id: 'ignored' }]);
          ws.reply(['EOSE', sub]);
        },
      ],
      [
        'wss://two.example/',
        (ws, [type, sub]) => {
          if (type === 'REQ') ws.reply(['EOSE', sub]);
        },
      ],
    ]);
    const events = await reader().query({
      relays: ['wss://one.example/', 'wss://two.example/', 'wss://down.example/'],
      filter,
    });
    expect(events).toEqual([{ id: 'e1' }]);
    expect(
      FakeSocket.sockets.filter((s) => s.url !== 'wss://down.example/').every((s) => s.closed)
    ).toBe(true);
    expect(FakeSocket.sockets[0]?.sent[0]).toEqual(['REQ', expect.any(String), filter]);
  });

  it('authenticates with NIP-42 when the relay closes the REQ as auth-required, then asks again', async () => {
    const signer = createLocalSigner(generateSecretKey());
    const pubkey = await signer.getPublicKey();
    let authEvent: { id: string; pubkey: string; tags: string[][] } | undefined;
    FakeSocket.sockets = [];
    FakeSocket.scripts = new Map<string, Script>([
      [
        'wss://auth.example/',
        (ws, msg) => {
          const [type, arg] = msg as [string, unknown];
          if (type === 'REQ' && !authEvent) {
            ws.reply(['AUTH', 'challenge-1']);
            ws.reply(['CLOSED', arg, 'auth-required: show who you are']);
          } else if (type === 'AUTH') {
            authEvent = arg as typeof authEvent;
            ws.reply(['OK', authEvent?.id, true, '']);
          } else if (type === 'REQ') {
            ws.reply(['EVENT', arg, { id: 'secret-list' }]);
            ws.reply(['EOSE', arg]);
          }
        },
      ],
    ]);
    const events = await reader().query({ relays: ['wss://auth.example/'], filter, auth: signer });
    expect(events).toEqual([{ id: 'secret-list' }]);
    expect(authEvent?.pubkey).toBe(pubkey);
    expect(verifyEvent(authEvent as Parameters<typeof verifyEvent>[0])).toBe(true);
    expect(authEvent?.tags).toEqual(
      expect.arrayContaining([
        ['relay', 'wss://auth.example/'],
        ['challenge', 'challenge-1'],
      ])
    );
  });

  it('takes nothing from a relay that refuses the REQ without a signer, or never answers', async () => {
    FakeSocket.scripts = new Map<string, Script>([
      [
        'wss://closed.example/',
        (ws, [type, sub]) => {
          if (type === 'REQ') ws.reply(['CLOSED', sub, 'auth-required: no']);
        },
      ],
      ['wss://silent.example/', () => {}],
    ]);
    const started = Date.now();
    const events = await reader(50).query({
      relays: ['wss://closed.example/', 'wss://silent.example/'],
      filter,
    });
    expect(events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('storage relays named in an approval', () => {
  it('accepts distinct wss URLs on public hosts', () => {
    expect(checkStorageRelays(['wss://relay.example/', 'wss://relay.example/'])).toEqual([
      'wss://relay.example/',
    ]);
  });

  it.each([
    [[]],
    ['wss://relay.example/'],
    [['ws://relay.example/']],
    [['https://relay.example/']],
    [['wss://10.0.0.5/']],
    [['wss://relay.local/']],
    [['wss://u:p@relay.example/']],
    [Array.from({ length: 6 }, (_, i) => `wss://r${i}.example/`)],
  ])('refuses %j', (relays) => {
    expect(typeof checkStorageRelays(relays)).toBe('string');
  });
});
