import { describe, expect, it } from 'vitest';
import {
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  PROBE_LARGE_EVENT_BYTES,
  probeInboxRelay,
  probeRelay,
  probeStorageRelay,
} from '../src/index.ts';
import { FakeRelayNetwork } from '../src/testing.ts';

const fast = (net: FakeRelayNetwork) => ({ socket: net.socket, settleMs: 0, timeoutMs: 200 });

describe('storage relay probe (spec 9.1)', () => {
  it('passes a relay that meets the storage role and cleans up', async () => {
    const net = new FakeRelayNetwork();
    const relay = net.add('wss://storage.example');
    const result = await probeStorageRelay('wss://storage.example', fast(net));
    expect(result.failed).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toContain('accepts a 64 KiB event');
    expect(result.checks.map((c) => c.name)).toContain('honors NIP-09 deletion');
    const large = relay.accepted.find((e) => e.kind === KIND_DRAFT_WRAP && e.content.length > 1000);
    expect(JSON.stringify(large).length).toBe(PROBE_LARGE_EVENT_BYTES);
    expect(relay.events.filter((e) => e.kind !== 5)).toEqual([]);
  });

  it.each([
    ['a relay that wants AUTH', { authRequired: true }, /without AUTH/],
    ['a relay that refuses a queue kind', { refuseKinds: [KIND_APP_DATA] }, /kind 30078/],
    ['a relay with a small event limit', { maxEventSize: 32 * 1024 }, /64 KiB/],
    ['a relay that ignores deletion', { honorDeletion: false }, /deletion/],
    ['a relay that stores nothing', { dropWrites: true }, /back/],
  ])('refuses %s, naming the check', async (_, options, name) => {
    const net = new FakeRelayNetwork();
    net.add('wss://bad.example', options);
    const result = await probeStorageRelay('wss://bad.example', fast(net));
    expect(result.ok).toBe(false);
    expect(result.failed?.name).toMatch(name);
  });

  it('refuses an unreachable relay', async () => {
    const result = await probeRelay(
      'wss://nowhere.example',
      'storage',
      fast(new FakeRelayNetwork())
    );
    expect(result.failed?.name).toBe('connects');
  });
});

describe('inbox relay probe (spec 9.1)', () => {
  it('passes a relay that restricts gift wraps to the recipient', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://inbox.example', { restrictGiftWraps: true, recipientDeletion: true });
    const result = await probeInboxRelay('wss://inbox.example', fast(net));
    expect(result.failed).toBeUndefined();
    expect(result.checks.map((c) => c.name)).toEqual([
      'connects',
      'accepts a gift wrap',
      'hides gift wraps from unauthenticated reads',
      'supports NIP-42 AUTH',
      'hides gift wraps from other authenticated keys',
      'serves the gift wrap to its recipient',
    ]);
    expect(net.get('wss://inbox.example').events.filter((e) => e.kind === 1059)).toEqual([]);
  });

  it('passes a relay that wants AUTH for everything', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://inbox.example', { restrictGiftWraps: true, authRequired: true });
    expect((await probeRelay('wss://inbox.example', 'inbox', fast(net))).ok).toBe(true);
  });

  it('refuses a relay that serves gift wraps to anyone', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://open.example');
    const result = await probeInboxRelay('wss://open.example', fast(net));
    expect(result.failed?.name).toBe('hides gift wraps from unauthenticated reads');
  });

  it('refuses a relay whose AUTH never succeeds', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://broken.example', { restrictGiftWraps: true, brokenAuth: true });
    const result = await probeInboxRelay('wss://broken.example', fast(net));
    expect(result.failed?.name).toBe('supports NIP-42 AUTH');
  });

  it('refuses a relay that refuses gift wraps', async () => {
    const net = new FakeRelayNetwork();
    net.add('wss://nowraps.example', { refuseKinds: [1059] });
    const result = await probeInboxRelay('wss://nowraps.example', fast(net));
    expect(result.failed?.name).toBe('accepts a gift wrap');
  });
});
