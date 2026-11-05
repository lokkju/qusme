import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  giftWrap,
  KIND_APP_DATA,
  KIND_DELETION,
  KIND_GIFT_WRAP,
  publishToAll,
  queryAll,
  RelayConnection,
  RelayError,
  type SocketLike,
} from '../src/index.ts';
import { FakeRelayNetwork } from '../src/testing.ts';
import { other, otherPubkey, queue, queueKey, queuePubkey } from './helpers.ts';

const now = (): number => Math.floor(Date.now() / 1000);
const appData = (d: string, created_at = now()) =>
  finalizeEvent({ kind: KIND_APP_DATA, created_at, tags: [['d', d]], content: d }, queueKey);
const sign = (t: Parameters<typeof queue.signEvent>[0]) => queue.signEvent(t);

describe('relay client', () => {
  it('publishes, queries and keeps the newest addressable event', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://a.example');
    const c = await RelayConnection.open('wss://a.example', { socket: net.socket });
    await c.publish(appData('x', 100));
    await c.publish(appData('x', 200));
    const events = await c.query([{ kinds: [KIND_APP_DATA], authors: [queuePubkey] }]);
    expect(events.map((e) => e.created_at)).toEqual([200]);
    c.close();
    expect(c.isClosed).toBe(true);
  });

  it('reports a refusal with the relay message', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://a.example', { refuseKinds: [KIND_APP_DATA] });
    const c = await RelayConnection.open('wss://a.example', { socket: net.socket });
    await expect(c.publish(appData('x'))).rejects.toThrow(/blocked: kind/);
  });

  it('fails to connect to an unknown relay', async () => {
    const net = new FakeRelayNetwork();
    await expect(RelayConnection.open('wss://nowhere', { socket: net.socket })).rejects.toThrow(
      RelayError
    );
  });

  it('authenticates on demand when the relay asks and autoAuth is set', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://auth.example', { authRequired: true });
    const plain = await RelayConnection.open('wss://auth.example', { socket: net.socket });
    await expect(plain.publish(appData('x'))).rejects.toThrow(/auth-required/);
    await expect(plain.query([{ kinds: [KIND_APP_DATA] }])).rejects.toThrow(/auth-required/);

    const authed = await RelayConnection.open('wss://auth.example', {
      socket: net.socket,
      autoAuth: sign,
    });
    await authed.publish(appData('x'));
    expect(authed.authenticated.has(queuePubkey)).toBe(true);
    expect(await authed.query([{ kinds: [KIND_APP_DATA] }])).toHaveLength(1);
  });

  it('authenticates as several keys on one connection', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://auth.example', { authRequired: true });
    const c = await RelayConnection.open('wss://auth.example', { socket: net.socket });
    await c.authenticate(sign);
    await c.authenticate((t) => other.signEvent(t));
    expect([...c.authenticated].sort()).toEqual([queuePubkey, otherPubkey].sort());
  });

  it('reports a relay that refuses AUTH, and one that never challenges', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://broken.example', { brokenAuth: true });
    net.add('wss://open.example');
    const broken = await RelayConnection.open('wss://broken.example', { socket: net.socket });
    await expect(broken.authenticate(sign)).rejects.toThrow(/refused AUTH/);
    const open = await RelayConnection.open('wss://open.example', {
      socket: net.socket,
      timeoutMs: 50,
    });
    await expect(open.authenticate(sign)).rejects.toThrow(/no AUTH challenge/);
  });

  it('restricts gift wraps to their recipient on an inbox relay', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://inbox.example', { restrictGiftWraps: true });
    const wrap = await giftWrap({ kind: 1235, content: 'hi' }, other, queuePubkey);
    const writer = await RelayConnection.open('wss://inbox.example', { socket: net.socket });
    await writer.publish(wrap);
    const filter = { kinds: [KIND_GIFT_WRAP], '#p': [queuePubkey] };
    await expect(writer.query([filter])).rejects.toThrow(/auth-required/);
    const stranger = await RelayConnection.open('wss://inbox.example', { socket: net.socket });
    await stranger.authenticate((t) => other.signEvent(t));
    expect(await stranger.query([filter])).toEqual([]);
    const owner = await RelayConnection.open('wss://inbox.example', { socket: net.socket });
    await owner.authenticate(sign);
    expect((await owner.query([filter])).map((e) => e.id)).toEqual([wrap.id]);
  });

  it('delivers live events to a subscription and ends it on close', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://a.example');
    const reader = await RelayConnection.open('wss://a.example', { socket: net.socket });
    const writer = await RelayConnection.open('wss://a.example', { socket: net.socket });
    const seen: string[] = [];
    let closedWith: string | undefined;
    const stop = reader.subscribe([{ kinds: [KIND_APP_DATA] }], {
      onEvent: (e) => seen.push(e.id),
      onClosed: (reason) => {
        closedWith = reason;
      },
    });
    const event = appData('live');
    await writer.publish(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([event.id]);
    stop();
    await writer.publish(appData('after'));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([event.id]);
    net.get('wss://a.example').disconnectAll();
    expect(await reader.closed).toBe('connection closed');
    expect(closedWith).toBeUndefined();
  });

  it('times out a relay that never answers', async () => {
    const silent: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    };
    const c = await RelayConnection.open('wss://silent.example', {
      socket: () => {
        setTimeout(() => silent.onopen?.({}), 0);
        return silent;
      },
      timeoutMs: 30,
    });
    await expect(c.publish(appData('x'))).rejects.toThrow(/timed out/);
    await expect(c.query([{ kinds: [KIND_APP_DATA] }])).rejects.toThrow(/timed out/);
    await expect(
      RelayConnection.open('wss://never.example', {
        socket: () => ({ ...silent }),
        connectTimeoutMs: 30,
      })
    ).rejects.toThrow(/timed out/);
  });

  it('honors NIP-09 deletion and NIP-40 expiry', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://a.example');
    const c = await RelayConnection.open('wss://a.example', { socket: net.socket });
    const kept = appData('kept');
    await c.publish(kept);
    await c.publish(
      finalizeEvent(
        { kind: KIND_DELETION, created_at: now(), tags: [['e', kept.id]], content: '' },
        queueKey
      )
    );
    expect(await c.query([{ ids: [kept.id] }])).toEqual([]);
    await expect(c.publish(kept)).rejects.toThrow(/deleted/);
    const expired = finalizeEvent(
      {
        kind: KIND_APP_DATA,
        created_at: now(),
        tags: [
          ['d', 'gone'],
          ['expiration', String(now() - 1)],
        ],
        content: '',
      },
      queueKey
    );
    await c.publish(expired);
    expect(await c.query([{ ids: [expired.id] }])).toEqual([]);
  });

  it('fans out publishes and merges queries across relays', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://a.example');
    net.add('wss://b.example', { refuseKinds: [KIND_APP_DATA] });
    const connections = await Promise.all(
      ['wss://a.example', 'wss://b.example'].map((u) =>
        RelayConnection.open(u, { socket: net.socket })
      )
    );
    const report = await publishToAll(connections, appData('x'));
    expect(report.accepted).toEqual(['wss://a.example']);
    expect(report.refused[0]?.url).toBe('wss://b.example');
    const key = generateSecretKey();
    const foreign = finalizeEvent(
      { kind: KIND_APP_DATA, created_at: now() - 5, tags: [['d', 'y']], content: '' },
      key
    );
    await connections[0]?.publish(foreign);
    const merged = await queryAll(connections, [{ kinds: [KIND_APP_DATA] }]);
    expect(merged.map((e) => e.pubkey)).toEqual([queuePubkey, getPublicKey(key)]);
  });

  it('ignores malformed relay messages', async () => {
    const net = new FakeRelayNetwork();
    const relay = net.add('wss://a.example');
    const socket = net.socket;
    let raw: { onmessage: ((e: { data: unknown }) => void) | null } | undefined;
    const c = await RelayConnection.open('wss://a.example', {
      socket: (url) => {
        const s = socket(url);
        raw = s;
        return s;
      },
    });
    raw?.onmessage?.({ data: 'not json' });
    raw?.onmessage?.({ data: '{"a":1}' });
    raw?.onmessage?.({ data: 42 });
    expect(relay.connectionCount).toBe(1);
    expect(await c.query([{ kinds: [KIND_APP_DATA] }])).toEqual([]);
  });
});
