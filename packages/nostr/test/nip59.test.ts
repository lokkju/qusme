import { hexToBytes } from '@noble/hashes/utils.js';
import { createRumor as ntCreateRumor, unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  createGiftWrap,
  createLocalSigner,
  createRumor,
  createSeal,
  giftWrap,
  KIND_GIFT_WRAP,
  KIND_SEAL,
  NIP59_TIMESTAMP_JITTER,
  type NostrEvent,
  nip44Decrypt,
  nip44Encrypt,
  type Rumor,
  randomizedTimestamp,
  unwrapGiftWrap,
} from '../src/index.ts';

const agentKey = hexToBytes('0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273');
const queueKey = hexToBytes('e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45');
const agent = createLocalSigner(agentKey);
const queue = createLocalSigner(queueKey);
const queuePubkey = getPublicKey(queueKey);
const agentPubkey = getPublicKey(agentKey);

const NOW = 1_761_350_400;
const DAY = 24 * 60 * 60;
const fieldValue = {
  kind: 30_000,
  tags: [
    ['site', 'example.com'],
    ['field', 'post'],
  ],
  content: 'hello',
  created_at: NOW,
};

// Wraps an arbitrary seal object the way createGiftWrap does, for building malformed wraps.
function wrapSeal(seal: unknown, recipient = queuePubkey): NostrEvent {
  const ephemeral = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      tags: [['p', recipient]],
      content: nip44Encrypt(ephemeral, recipient, JSON.stringify(seal)),
      created_at: NOW,
    },
    ephemeral
  );
}

// Signs a seal over arbitrary rumor JSON with `key`.
function sealJson(rumorJson: string, key: Uint8Array, recipient = queuePubkey): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_SEAL,
      tags: [],
      content: nip44Encrypt(key, recipient, rumorJson),
      created_at: NOW,
    },
    key
  );
}

describe('NIP-59 gift wraps', () => {
  it('round-trips a rumor through seal and gift wrap', async () => {
    const wrap = await giftWrap(fieldValue, agent, queuePubkey, { now: NOW });
    const opened = await unwrapGiftWrap(wrap, queue);
    expect(opened.sealPubkey).toBe(agentPubkey);
    expect(opened.wrapId).toBe(wrap.id);
    expect(opened.rumor).toEqual(createRumor(fieldValue, agentPubkey));
    expect(opened.rumor).not.toHaveProperty('sig');
    expect(opened.expiration).toBeUndefined();
  });

  it('builds rumor, seal and wrap one layer at a time', async () => {
    const rumor = createRumor(fieldValue, agentPubkey);
    const seal = await createSeal(rumor, agent, queuePubkey, { now: NOW });
    expect(seal.kind).toBe(KIND_SEAL);
    expect(seal.pubkey).toBe(agentPubkey);
    const wrap = createGiftWrap(seal, queuePubkey, { now: NOW, expiration: NOW + DAY });
    const opened = await unwrapGiftWrap(wrap, queue);
    expect(opened.rumor).toEqual(rumor);
    expect(opened.expiration).toBe(NOW + DAY);
  });

  it('p-tags the recipient and signs the wrap with a one-time key', async () => {
    const a = await giftWrap(fieldValue, agent, queuePubkey);
    const b = await giftWrap(fieldValue, agent, queuePubkey);
    expect(a.kind).toBe(KIND_GIFT_WRAP);
    expect(a.tags).toEqual([['p', queuePubkey]]);
    expect(a.pubkey).not.toBe(agentPubkey);
    expect(a.pubkey).not.toBe(b.pubkey);
  });

  it('adds a NIP-40 expiration to the wrap only', async () => {
    const expiration = NOW + 30 * DAY;
    const wrap = await giftWrap(fieldValue, agent, queuePubkey, { now: NOW, expiration });
    expect(wrap.tags).toContainEqual(['expiration', String(expiration)]);
    const seal = JSON.parse(nip44Decrypt(queueKey, wrap.pubkey, wrap.content)) as NostrEvent;
    expect(seal.kind).toBe(KIND_SEAL);
    expect(seal.tags).toEqual([]);
    expect((await unwrapGiftWrap(wrap, queue)).expiration).toBe(expiration);
  });

  it('refuses an expiration that is not in the future', async () => {
    await expect(
      giftWrap(fieldValue, agent, queuePubkey, { now: NOW, expiration: NOW })
    ).rejects.toThrow();
    await expect(
      giftWrap(fieldValue, agent, queuePubkey, { now: NOW, expiration: NOW + 0.5 })
    ).rejects.toThrow();
  });

  it('randomizes seal and wrap created_at up to two days into the past', async () => {
    const wraps = await Promise.all(
      Array.from({ length: 20 }, () => giftWrap(fieldValue, agent, queuePubkey, { now: NOW }))
    );
    const wrapTimes = new Set<number>();
    for (const wrap of wraps) {
      const seal = JSON.parse(nip44Decrypt(queueKey, wrap.pubkey, wrap.content)) as NostrEvent;
      for (const t of [wrap.created_at, seal.created_at]) {
        expect(t).toBeLessThanOrEqual(NOW);
        expect(t).toBeGreaterThanOrEqual(NOW - NIP59_TIMESTAMP_JITTER);
      }
      wrapTimes.add(wrap.created_at);
      // The rumor keeps the canonical time.
      expect((await unwrapGiftWrap(wrap, queue)).rumor.created_at).toBe(NOW);
    }
    expect(wrapTimes.size).toBeGreaterThan(1);
  });

  it('randomizedTimestamp stays within the jitter window', () => {
    for (let i = 0; i < 1000; i++) {
      const t = randomizedTimestamp({ now: NOW });
      expect(Number.isInteger(t)).toBe(true);
      expect(NOW - t).toBeGreaterThanOrEqual(0);
      expect(NOW - t).toBeLessThanOrEqual(NIP59_TIMESTAMP_JITTER);
    }
  });

  it('refuses to seal a rumor authored by another key', async () => {
    const rumor = createRumor(fieldValue, queuePubkey);
    await expect(createSeal(rumor, agent, queuePubkey)).rejects.toThrow(/rumor pubkey/);
  });

  it('only the recipient can unwrap', async () => {
    const wrap = await giftWrap(fieldValue, agent, queuePubkey);
    const stranger = createLocalSigner(generateSecretKey());
    await expect(unwrapGiftWrap(wrap, stranger)).rejects.toThrow();
  });
});

describe('NIP-59 interop with nostr-tools', () => {
  it('nostr-tools unwraps a gift wrap built here', async () => {
    const wrap = await giftWrap(fieldValue, agent, queuePubkey, { expiration: NOW + 400 * DAY });
    const rumor = unwrapEvent(wrap, queueKey);
    expect(rumor).toEqual(createRumor(fieldValue, agentPubkey));
  });

  it('unwraps a gift wrap built by nostr-tools', async () => {
    const wrap = wrapEvent(fieldValue, agentKey, queuePubkey);
    const opened = await unwrapGiftWrap(wrap, queue);
    expect(opened.sealPubkey).toBe(agentPubkey);
    expect(opened.rumor).toEqual(ntCreateRumor(fieldValue, agentKey));
  });
});

describe('NIP-59 unwrap rejects', () => {
  const rumor: Rumor = createRumor(fieldValue, agentPubkey);

  it('a seal whose signature fails', async () => {
    const seal = await createSeal(rumor, agent, queuePubkey);
    const forged = { ...seal, content: seal.content.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) };
    await expect(unwrapGiftWrap(wrapSeal(forged), queue)).rejects.toThrow(/seal signature/);
    const badSig = { ...seal, sig: seal.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
    await expect(unwrapGiftWrap(wrapSeal(badSig), queue)).rejects.toThrow(/seal signature/);
  });

  it('a seal whose pubkey differs from the rumor pubkey', async () => {
    // A seal signed by another key, holding a rumor that claims the agent wrote it.
    const impostor = generateSecretKey();
    const seal = sealJson(JSON.stringify(rumor), impostor);
    await expect(unwrapGiftWrap(wrapSeal(seal), queue)).rejects.toThrow(/differs from the seal/);
  });

  it('a seal with tags', async () => {
    const seal = finalizeEvent(
      {
        kind: KIND_SEAL,
        tags: [['p', queuePubkey]],
        content: nip44Encrypt(agentKey, queuePubkey, JSON.stringify(rumor)),
        created_at: NOW,
      },
      agentKey
    );
    await expect(unwrapGiftWrap(wrapSeal(seal), queue)).rejects.toThrow(/tags/);
  });

  it('a seal of the wrong kind', async () => {
    const seal = finalizeEvent(
      {
        kind: 1,
        tags: [],
        content: nip44Encrypt(agentKey, queuePubkey, JSON.stringify(rumor)),
        created_at: NOW,
      },
      agentKey
    );
    await expect(unwrapGiftWrap(wrapSeal(seal), queue)).rejects.toThrow(/seal/);
  });

  it('a signed rumor', async () => {
    const signed = finalizeEvent(fieldValue, agentKey);
    const seal = sealJson(JSON.stringify(signed), agentKey);
    await expect(unwrapGiftWrap(wrapSeal(seal), queue)).rejects.toThrow(/signed/);
  });

  it('a rumor whose id does not match its content', async () => {
    const seal = sealJson(JSON.stringify({ ...rumor, content: 'changed' }), agentKey);
    await expect(unwrapGiftWrap(wrapSeal(seal), queue)).rejects.toThrow(/id/);
  });

  it('a wrap whose own signature fails, or of the wrong kind', async () => {
    const wrap = await giftWrap(fieldValue, agent, queuePubkey);
    const tampered = { ...wrap, tags: [...wrap.tags, ['expiration', String(NOW + 1)]] };
    await expect(unwrapGiftWrap(tampered, queue)).rejects.toThrow(/gift wrap signature/);
    const ephemeral = generateSecretKey();
    const notAWrap = finalizeEvent(
      { kind: 1, tags: [], content: wrap.content, created_at: NOW },
      ephemeral
    );
    await expect(unwrapGiftWrap(notAWrap, queue)).rejects.toThrow(/kind/);
  });

  it('a seal that is not JSON', async () => {
    const ephemeral = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        tags: [['p', queuePubkey]],
        content: nip44Encrypt(ephemeral, queuePubkey, 'not json'),
        created_at: NOW,
      },
      ephemeral
    );
    await expect(unwrapGiftWrap(wrap, queue)).rejects.toThrow(/JSON/);
  });
});
