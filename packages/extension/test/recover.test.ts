import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  BackupNotFound,
  fetchRecoveryBackup,
  findRecoveryBackup,
  finishRecover,
  openRecoveryBackup,
  RelaysUnreachable,
  readQueuePubkey,
} from '../src/setup/recover.ts';
import { parseRecoverySheet, recoverySheetText } from '../src/setup/recoverySheet.ts';
import { createdDevice, device, INBOX, network, STORAGE } from './helpers.ts';

const NEW_PASSPHRASE = 'harbor lantern copper ninety';

describe('recover flow (spec 6.1, 11.3)', { timeout: 30_000 }, () => {
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
    ).rejects.toThrow(/not a Queue ID/);
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

  it('finds the queue on the default storage relays from the npub and code alone, then reads its 10013', async () => {
    const net = network();
    net.add('wss://default-empty.example');
    const a = await createdDevice(net);
    const b = device(net);
    // Only one default relay holds the queue; the 10013 read with the key names both.
    b.deps.defaultStorageRelays = ['wss://default-empty.example', STORAGE[1] as string];
    const fetched = await findRecoveryBackup({ npub: a.npub }, b.deps);
    expect(fetched.relayUrl).toBe(STORAGE[1]);
    expect(fetched.relays).toEqual([STORAGE[1]]);
    const key = openRecoveryBackup(fetched, a.words);
    const result = await finishRecover(fetched, key, NEW_PASSPHRASE, b.deps);
    expect(result).toEqual({ storageRelays: STORAGE, relayListFound: true, settingsFound: true });
    expect((await b.store.record())?.storageRelays).toEqual(STORAGE);
  });

  it('names every relay asked when none has the queue, then finds it on a relay the user adds', async () => {
    const net = network();
    net.add('wss://default-empty.example');
    const a = await createdDevice(net);
    const b = device(net);
    b.deps.defaultStorageRelays = ['wss://default-empty.example', 'wss://gone.example'];
    const missing = findRecoveryBackup({ npub: a.npub }, b.deps);
    await expect(missing).rejects.toThrow(
      'No recovery backup for that Queue ID on wss://default-empty.example (wss://gone.example could not be reached).'
    );
    await expect(missing).rejects.toBeInstanceOf(BackupNotFound);
    const fetched = await findRecoveryBackup(
      { npub: a.npub, relays: [STORAGE[0] as string] },
      b.deps
    );
    expect(openRecoveryBackup(fetched, a.base32)).toEqual(a.secretKey);
  });

  it('names the relays when no default can be reached, then finds the queue on one the user adds', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    b.deps.defaultStorageRelays = ['wss://gone-a.example', 'wss://gone-b.example'];
    const unreachable = findRecoveryBackup({ npub: a.npub }, b.deps);
    await expect(unreachable).rejects.toThrow(
      'Could not reach any of wss://gone-a.example, wss://gone-b.example. If the queue is on another storage server, enter it below.'
    );
    await expect(unreachable).rejects.toBeInstanceOf(RelaysUnreachable);
    await expect(unreachable).rejects.toMatchObject({
      relays: ['wss://gone-a.example', 'wss://gone-b.example'],
    });
    const fetched = await findRecoveryBackup(
      { npub: a.npub, relays: [STORAGE[0] as string] },
      b.deps
    );
    expect(fetched.relayUrl).toBe(STORAGE[0]);
    expect(openRecoveryBackup(fetched, a.words)).toEqual(a.secretKey);
  });

  it('recovers from a pasted recovery sheet: its storage relays, npub and code', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    b.deps.defaultStorageRelays = ['wss://unreachable.example'];
    const text = recoverySheetText({
      words: a.words.split(' '),
      base32: a.base32,
      npub: a.npub,
      storageRelays: STORAGE,
      inboxRelays: INBOX,
      createdAt: new Date(),
    });
    const parsed = parseRecoverySheet(text);
    expect(parsed.storageRelays).toEqual(STORAGE);
    const fetched = await findRecoveryBackup(
      { npub: parsed.npub as string, relays: parsed.storageRelays },
      b.deps
    );
    expect(fetched.relays.sort()).toEqual([...STORAGE].sort());
    expect(openRecoveryBackup(fetched, parsed.code as string)).toEqual(a.secretKey);
  });
});
