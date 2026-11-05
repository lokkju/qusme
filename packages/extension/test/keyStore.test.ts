import { bytesToHex } from '@noble/hashes/utils.js';
import { buildSettings, createLocalSigner, ncryptsecParams } from '@qusme/nostr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  KeyStore,
  LOCAL_PLAIN_KEYS,
  LOCAL_QUEUE,
  SESSION_UNLOCKED,
  WrongPassphrase,
} from '../src/keyStore.ts';
import { MemoryStorageArea } from '../src/storage.ts';
import { PASSPHRASE, STORAGE, TEST_LOG_N } from './helpers.ts';

async function setup() {
  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const store = new KeyStore({ local, session }, { logN: TEST_LOG_N });
  const secretKey = generateSecretKey();
  const inboxKey = generateSecretKey();
  const settings = await buildSettings(createLocalSigner(secretKey), {
    inbox_key: bytesToHex(inboxKey),
    inbox_relays: ['wss://inbox.example'],
    quota_counts: {},
  });
  await store.save({ secretKey, passphrase: PASSPHRASE, storageRelays: STORAGE, settings });
  return { local, session, store, secretKey, inboxKey, hex: bytesToHex(secretKey) };
}

describe('key store (spec 6.1)', () => {
  it('starts empty', async () => {
    const store = new KeyStore({
      local: new MemoryStorageArea(),
      session: new MemoryStorageArea(),
    });
    expect(await store.status()).toEqual({ state: 'empty' });
    expect(store.logN).toBe(18);
  });

  it('keeps the ncryptsec locally and the unlocked keys only in the session', async () => {
    const { local, session, store, secretKey, inboxKey, hex } = await setup();
    const record = await store.record();
    expect(record?.pubkey).toBe(getPublicKey(secretKey));
    expect(ncryptsecParams(record?.ncryptsec as string).logN).toBe(TEST_LOG_N);
    expect(local.dump()).not.toContain(hex);
    expect(local.dump()).not.toContain(bytesToHex(inboxKey));
    expect(local.data.has(LOCAL_PLAIN_KEYS)).toBe(false);
    expect(session.dump()).toContain(hex);
    const unlocked = await store.unlocked();
    expect(unlocked?.queueKey).toEqual(secretKey);
    expect(unlocked?.inboxKey).toEqual(inboxKey);
    expect(await store.status()).toEqual({
      state: 'unlocked',
      pubkey: getPublicKey(secretKey),
      stayUnlocked: false,
    });
  });

  it('locks, refuses a wrong passphrase and unlocks with the right one', async () => {
    const { session, store, inboxKey } = await setup();
    await store.lock();
    expect(session.data.has(SESSION_UNLOCKED)).toBe(false);
    expect((await store.status()).state).toBe('locked');
    expect(await store.unlocked()).toBeUndefined();
    await expect(store.unlock('not the passphrase')).rejects.toThrow(WrongPassphrase);
    expect((await store.status()).state).toBe('locked');
    await store.unlock(PASSPHRASE);
    expect((await store.status()).state).toBe('unlocked');
    expect((await store.unlocked())?.inboxKey).toEqual(inboxKey);
  });

  it('locks on browser restart unless "stay unlocked" is on', async () => {
    const { local, store, hex } = await setup();
    const restarted = new KeyStore({ local, session: new MemoryStorageArea() });
    expect((await restarted.status()).state).toBe('locked');

    await store.setStayUnlocked(true);
    expect(local.dump()).toContain(hex);
    const again = new KeyStore({ local, session: new MemoryStorageArea() });
    expect(await again.status()).toMatchObject({ state: 'unlocked', stayUnlocked: true });
    expect((await again.unlocked())?.inboxKey).toBeDefined();
  });

  it('wipes the unencrypted copy on lock and when "stay unlocked" is turned off', async () => {
    const { local, store, hex } = await setup();
    await store.setStayUnlocked(true);
    await store.lock();
    expect(local.dump()).not.toContain(hex);
    await store.unlock(PASSPHRASE);
    expect(local.dump()).toContain(hex);
    await store.setStayUnlocked(false);
    expect(local.dump()).not.toContain(hex);
    expect((await store.status()).state).toBe('unlocked');
  });

  it('turning "stay unlocked" on while locked stores nothing', async () => {
    const { local, store, hex } = await setup();
    await store.lock();
    await store.setStayUnlocked(true);
    expect(local.dump()).not.toContain(hex);
  });

  it('ignores session keys for another queue', async () => {
    const { session, store } = await setup();
    await session.set({ [SESSION_UNLOCKED]: { queue: bytesToHex(generateSecretKey()) } });
    expect((await store.status()).state).toBe('locked');
  });

  it('holds a pending pairing import and forgets everything', async () => {
    const { local, session, store } = await setup();
    await store.setPendingImport({
      ncryptsec: 'ncryptsec1x',
      unlockWith: 'passphrase',
      receivedAt: 1,
    });
    expect((await store.pendingImport())?.unlockWith).toBe('passphrase');
    await store.clearPendingImport();
    expect(await store.pendingImport()).toBeUndefined();
    await store.forget();
    expect(local.data.has(LOCAL_QUEUE)).toBe(false);
    expect(session.data.size).toBe(0);
    expect(await store.status()).toEqual({ state: 'empty' });
  });
});
