import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  AgentKeyError,
  agentKeyRingFromEnv,
  createAgentKeyRing,
  openAgentSecret,
  SEALED_AGENT_KEY_BYTES,
  sealAgentSecret,
} from '../src/agentKeyRing.ts';

const S1 = btoa('1'.repeat(32));
const S2 = btoa('2'.repeat(32));
const ring1 = createAgentKeyRing({ secret: S1 });
const ring2 = createAgentKeyRing({ secret: S2, version: 2, previous: S1 });

function keypair() {
  const sk = generateSecretKey();
  return { sk, binding: { id: crypto.randomUUID(), pubkey: getPublicKey(sk) } };
}

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AgentKeyError);
  expect((err as AgentKeyError).code).toBe(code);
  return err as AgentKeyError;
}

describe('agent key encryption (spec 6.2)', () => {
  it('round-trips a secret key', async () => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    expect(sealed.length).toBe(SEALED_AGENT_KEY_BYTES);
    expect(sealed[0]).toBe(1);
    expect(await openAgentSecret(ring1, binding, 1, sealed)).toEqual(sk);
  });

  it('uses a fresh nonce for every encryption', async () => {
    const { sk, binding } = keypair();
    const a = await sealAgentSecret(ring1, binding, sk);
    const b = await sealAgentSecret(ring1, binding, sk);
    expect(a.subarray(1, 13)).not.toEqual(b.subarray(1, 13));
    expect(a).not.toEqual(b);
  });

  it('never stores the secret key in the clear', async () => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex(sealed)).not.toContain(hex(sk).slice(0, 16));
  });

  it.each([
    ['the format byte', 0],
    ['the nonce', 5],
    ['the ciphertext', 20],
    ['the tag', SEALED_AGENT_KEY_BYTES - 1],
  ])('detects tampering with %s', async (_, offset) => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    sealed[offset] = (sealed[offset] as number) ^ 1;
    await rejects(openAgentSecret(ring1, binding, 1, sealed), 'undecryptable');
  });

  it('refuses a truncated or extended ciphertext', async () => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    await rejects(openAgentSecret(ring1, binding, 1, sealed.subarray(1)), 'undecryptable');
    const longer = new Uint8Array(sealed.length + 1);
    longer.set(sealed);
    await rejects(openAgentSecret(ring1, binding, 1, longer), 'undecryptable');
  });

  it('binds the ciphertext to the pubkey, the row id and the key version', async () => {
    const a = keypair();
    const b = keypair();
    const sealed = await sealAgentSecret(ring2, a.binding, a.sk);
    // Another agent's pubkey (a swapped ciphertext), another row id, another version.
    await rejects(
      openAgentSecret(ring2, { ...a.binding, pubkey: b.binding.pubkey }, 2, sealed),
      'undecryptable'
    );
    await rejects(
      openAgentSecret(ring2, { ...a.binding, id: b.binding.id }, 2, sealed),
      'undecryptable'
    );
    await rejects(openAgentSecret(ring2, a.binding, 1, sealed), 'undecryptable');
  });

  it('refuses a ciphertext of a key whose pubkey is not the row’s', async () => {
    // Sealed for row a with b's secret key: AES-GCM opens it, the pubkey check refuses it.
    const a = keypair();
    const b = keypair();
    const sealed = await sealAgentSecret(ring1, a.binding, b.sk);
    await rejects(openAgentSecret(ring1, a.binding, 1, sealed), 'undecryptable');
  });

  it('refuses the wrong secret', async () => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    const other = createAgentKeyRing({ secret: S2 });
    await rejects(openAgentSecret(other, binding, 1, sealed), 'undecryptable');
  });

  it('refuses a version the ring does not hold', async () => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    const later = createAgentKeyRing({ secret: S2, version: 3, previous: S1 });
    await rejects(openAgentSecret(later, binding, 1, sealed), 'unknown_version');
  });

  it('keeps decrypting the previous version during a rotation', async () => {
    const { sk, binding } = keypair();
    const old = await sealAgentSecret(ring1, binding, sk);
    expect(await openAgentSecret(ring2, binding, 1, old)).toEqual(sk);
    const current = await sealAgentSecret(ring2, binding, sk);
    expect(await openAgentSecret(ring2, binding, 2, current)).toEqual(sk);
  });

  it('puts no key material in its errors', async () => {
    const { sk, binding } = keypair();
    const sealed = await sealAgentSecret(ring1, binding, sk);
    sealed[20] = (sealed[20] as number) ^ 1;
    const err = await rejects(openAgentSecret(ring1, binding, 1, sealed), 'undecryptable');
    expect(err.cause).toBeUndefined();
    const text = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;
    expect(text).not.toContain(S1);
    expect(text).not.toContain(Array.from(sk, (x) => x.toString(16).padStart(2, '0')).join(''));
  });
});

describe('the agent key ring', () => {
  it('reads the environment', () => {
    const ring = agentKeyRingFromEnv({ QUSME_AGENT_KEY_SECRET: `${S1}\n` });
    expect(ring.currentVersion).toBe(1);
    expect(ring.rotating).toBe(false);
    expect(ring.has(1)).toBe(true);
    expect(ring.has(0)).toBe(false);
  });

  it.each([
    [{}, /is not set/],
    [{ QUSME_AGENT_KEY_SECRET: '' }, /is not set/],
    [{ QUSME_AGENT_KEY_SECRET: 'test-secret' }, /base64 of 32 bytes/],
    [{ QUSME_AGENT_KEY_SECRET: btoa('x'.repeat(33)) }, /base64 of 32 bytes/],
    [{ QUSME_AGENT_KEY_SECRET: S1, QUSME_AGENT_KEY_VERSION: '0' }, /integer from 1/],
    [{ QUSME_AGENT_KEY_SECRET: S1, QUSME_AGENT_KEY_VERSION: '1.5' }, /integer from 1/],
    [{ QUSME_AGENT_KEY_SECRET: S1, QUSME_AGENT_KEY_SECRET_PREVIOUS: S2 }, /2 or more/],
    [
      {
        QUSME_AGENT_KEY_SECRET: S1,
        QUSME_AGENT_KEY_VERSION: '2',
        QUSME_AGENT_KEY_SECRET_PREVIOUS: S1,
      },
      /equals/,
    ],
    [
      {
        QUSME_AGENT_KEY_SECRET: S1,
        QUSME_AGENT_KEY_VERSION: '2',
        QUSME_AGENT_KEY_SECRET_PREVIOUS: 'nope',
      },
      /QUSME_AGENT_KEY_SECRET_PREVIOUS must be standard base64/,
    ],
  ])('refuses %o', (env, message) => {
    expect(() => agentKeyRingFromEnv(env)).toThrow(message);
  });

  it('exposes no secret through its properties', () => {
    const text = JSON.stringify(ring2) + Object.keys(ring2).join();
    expect(text).not.toContain(S1);
    expect(text).not.toContain(S2);
  });
});
