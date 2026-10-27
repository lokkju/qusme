import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildPrivateRelayList,
  KIND_PRIVATE_RELAYS,
  nip44Encrypt,
  parsePrivateRelayList,
} from '../src/index.ts';
import {
  expectError,
  expectOk,
  NOW,
  other,
  queue,
  queueKey,
  queuePubkey,
  sign,
} from './helpers.ts';

const listWith = (content: string) =>
  sign({
    kind: KIND_PRIVATE_RELAYS,
    created_at: NOW,
    tags: [],
    content: nip44Encrypt(queueKey, queuePubkey, content),
  });

describe('private storage relay list (NIP-37 kind 10013)', () => {
  it('round-trips relays as encrypted private tags', async () => {
    const relays = ['wss://relay.example/', 'ws://localhost:7777'];
    const event = await buildPrivateRelayList(queue, relays, { createdAt: NOW });
    expect(event.kind).toBe(KIND_PRIVATE_RELAYS);
    expect(event.tags).toEqual([]);
    expect(verifyEvent({ ...event })).toBe(true);
    expect(expectOk(await parsePrivateRelayList(event, queue)).relays).toEqual(relays);
  });

  it('rejects bad relay tags, an empty list and another author', async () => {
    for (const content of [
      '[]',
      '[["relay","https://relay.example"]]',
      '[["r","wss://relay.example"]]',
      '[["relay","wss://relay.example","write"]]',
      '{"relay":"wss://x"}',
    ]) {
      expectError(await parsePrivateRelayList(listWith(content), queue), 'invalid_content');
    }
    const event = await buildPrivateRelayList(queue, ['wss://relay.example']);
    expectError(await parsePrivateRelayList(event, other), 'wrong_author');
    await expect(buildPrivateRelayList(queue, ['relay.example'])).rejects.toThrow();
  });
});
