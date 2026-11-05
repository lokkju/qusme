import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  fetchRecoveryBackup,
  finishRecover,
  openRecoveryBackup,
  readQueuePubkey,
} from '../src/setup/recover.ts';
import { createdDevice, device, network, STORAGE } from './helpers.ts';

const NEW_PASSPHRASE = 'harbor lantern copper ninety';

describe('recover flow (spec 6.1, 11.3)', () => {
  it('recovers from the relay URL, npub and the recovery words', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    const fetched = await fetchRecoveryBackup(
      { relayUrl: 'storage-b.example', npub: a.npub },
      b.deps
    );
    expect(fetched.queuePubkey).toBe(a.pubkey);
    const key = openRecoveryBackup(fetched, a.words.toUpperCase());
    expect(key).toEqual(a.secretKey);
    const result = await finishRecover(fetched, key, NEW_PASSPHRASE, b.deps);
    expect(result).toEqual({ storageRelays: STORAGE, relayListFound: true, settingsFound: true });
    expect(key.every((byte) => byte === 0)).toBe(true);
    expect(await b.store.status()).toMatchObject({ state: 'unlocked', pubkey: a.pubkey });
    expect((await b.store.unlocked())?.inboxKey).toEqual(a.inboxKey);
    expect((await b.store.record())?.recoveryBackup?.id).toBe(fetched.event.id);
    expect(b.local.dump()).not.toContain(bytesToHex(a.secretKey));
    await b.store.lock();
    await b.store.unlock(NEW_PASSPHRASE);
    expect((await b.store.status()).state).toBe('unlocked');
  });

  it('opens the backup with the base32 form too, and refuses a wrong or malformed code', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    const fetched = await fetchRecoveryBackup(
      { relayUrl: STORAGE[0] as string, npub: a.npub },
      b.deps
    );
    expect(openRecoveryBackup(fetched, a.base32.toLowerCase())).toEqual(a.secretKey);
    const other = await createdDevice(network());
    expect(() => openRecoveryBackup(fetched, other.words)).toThrow(/does not open/);
    expect(() => openRecoveryBackup(fetched, 'twelve words please')).toThrow(/not a recovery code/);
  });

  it('reports a relay with no backup for the npub, and bad input', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    const stranger = await createdDevice(network());
    await expect(
      fetchRecoveryBackup({ relayUrl: STORAGE[0] as string, npub: stranger.npub }, b.deps)
    ).rejects.toThrow(/No recovery backup/);
    await expect(
      fetchRecoveryBackup({ relayUrl: 'https://x.example', npub: a.npub }, b.deps)
    ).rejects.toThrow(/not a wss/);
    await expect(
      fetchRecoveryBackup({ relayUrl: STORAGE[0] as string, npub: 'npub1nope' }, b.deps)
    ).rejects.toThrow(/not an npub/);
    await expect(
      fetchRecoveryBackup({ relayUrl: 'wss://gone.example', npub: a.npub }, b.deps)
    ).rejects.toThrow(/Could not reach/);
    expect(readQueuePubkey(a.pubkey)).toBe(a.pubkey);
  });

  it('authenticates with a throwaway key, never the queue key, where a relay asks (9.2)', async () => {
    const net = network({ authRequired: true });
    const a = await createdDevice(net);
    const b = device(net);
    const relay = net.get(STORAGE[0] as string);
    const before = relay.requests.length;
    const fetched = await fetchRecoveryBackup(
      { relayUrl: STORAGE[0] as string, npub: a.npub },
      b.deps
    );
    const authed = relay.requests.slice(before).flatMap((r) => r.authed);
    expect(authed.length).toBeGreaterThan(0);
    expect(authed).not.toContain(a.pubkey);
    expect(openRecoveryBackup(fetched, a.words)).toEqual(a.secretKey);
  });

  it('refuses a weak local passphrase', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    const fetched = await fetchRecoveryBackup(
      { relayUrl: STORAGE[0] as string, npub: a.npub },
      b.deps
    );
    await expect(
      finishRecover(fetched, openRecoveryBackup(fetched, a.words), 'short', b.deps)
    ).rejects.toThrow(/12 characters/);
    expect(await b.store.status()).toEqual({ state: 'empty' });
  });
});
