import { bytesToHex } from '@noble/hashes/utils.js';
import {
  createLocalSigner,
  D_RECOVERY,
  D_SETTINGS,
  decodeNcryptsec,
  KIND_APP_DATA,
  KIND_PRIVATE_RELAYS,
  type NostrEvent,
  parsePrivateRelayList,
  parseRecoveryCode,
  parseSettings,
  recoveryPassword,
} from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import {
  cleanRelayList,
  confirmRecoveryCode,
  DEFAULT_INBOX_RELAYS,
  DEFAULT_STORAGE_RELAYS,
  finishCreate,
  probeRelays,
  startCreate,
} from '../src/setup/create.ts';
import { SetupError } from '../src/setup/deps.ts';
import { device, INBOX, network, PASSPHRASE, STORAGE } from './helpers.ts';

const d = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1];

describe('create flow (spec 11.3)', { timeout: 30_000 }, () => {
  it('suggests the relays of spec 9.1', () => {
    expect([...DEFAULT_STORAGE_RELAYS]).toEqual([
      'wss://relay.primal.net',
      'wss://relay.ditto.pub',
    ]);
    expect([...DEFAULT_INBOX_RELAYS]).toEqual(['wss://auth.nostr1.com']);
  });

  it('shows a recovery code in both forms and confirms it in either', () => {
    const draft = startCreate();
    expect(draft.words).toHaveLength(12);
    expect(draft.base32.replace(/-/g, '')).toHaveLength(26);
    expect(parseRecoveryCode(draft.words.join(' '))).toEqual(draft.recoveryCode);
    expect(confirmRecoveryCode(draft, `${'abandon '.repeat(11)}about`)).toBe(false);
    expect(draft.confirmed).toBe(false);
    expect(confirmRecoveryCode(draft, draft.base32.toLowerCase())).toBe(true);
    expect(draft.confirmed).toBe(true);
    const other = startCreate();
    expect(confirmRecoveryCode(other, other.words.join('  '))).toBe(true);
  });

  it('publishes nothing until the code is confirmed', async () => {
    const net = network();
    const a = device(net);
    const draft = startCreate();
    await expect(
      finishCreate(
        draft,
        { passphrase: PASSPHRASE, storageRelays: STORAGE, inboxRelays: INBOX },
        a.deps
      )
    ).rejects.toThrow(/recovery code/);
    expect(net.get(STORAGE[0] as string).accepted).toEqual([]);
  });

  it('refuses a weak passphrase and bad relay URLs', async () => {
    const a = device(network());
    const draft = startCreate();
    confirmRecoveryCode(draft, draft.base32);
    await expect(
      finishCreate(
        draft,
        { passphrase: 'short', storageRelays: STORAGE, inboxRelays: INBOX },
        a.deps
      )
    ).rejects.toThrow(SetupError);
    await expect(
      finishCreate(
        draft,
        { passphrase: PASSPHRASE, storageRelays: ['https://nope.example'], inboxRelays: INBOX },
        a.deps
      )
    ).rejects.toThrow(/not a wss/);
    expect(cleanRelayList([' nos.lol ', 'wss://nos.lol/', ''], 'relay')).toEqual(['wss://nos.lol']);
    expect(() => cleanRelayList(['', ' '], 'storage relay')).toThrow(/at least one storage relay/);
  });

  it('publishes 10013, settings and the recovery backup to every storage relay and stores the key', async () => {
    const net = network();
    const a = device(net);
    const draft = startCreate();
    const { secretKey, inboxKey, recoveryCode, pubkey } = {
      ...draft,
      secretKey: draft.secretKey.slice(),
      inboxKey: draft.inboxKey.slice(),
      recoveryCode: draft.recoveryCode.slice(),
    };
    expect(confirmRecoveryCode(draft, draft.words.join(' '))).toBe(true);
    await finishCreate(
      draft,
      { passphrase: PASSPHRASE, storageRelays: STORAGE, inboxRelays: INBOX },
      a.deps
    );
    const signer = createLocalSigner(secretKey);
    for (const url of STORAGE) {
      const events = net.get(url).events.filter((e) => e.pubkey === pubkey);
      const list = events.find((e) => e.kind === KIND_PRIVATE_RELAYS) as NostrEvent;
      const relays = await parsePrivateRelayList(list, signer);
      expect(relays.ok && relays.value.relays).toEqual(STORAGE);
      const settings = events.find((e) => e.kind === KIND_APP_DATA && d(e) === D_SETTINGS);
      const parsed = await parseSettings(settings, signer);
      expect(parsed.ok && parsed.value.content.inbox_key).toBe(bytesToHex(inboxKey));
      expect(parsed.ok && parsed.value.content.inbox_relays).toEqual(INBOX);
      const backup = events.find((e) => e.kind === KIND_APP_DATA && d(e) === D_RECOVERY);
      expect(decodeNcryptsec(backup?.content as string, recoveryPassword(recoveryCode))).toEqual(
        secretKey
      );
      expect(() => decodeNcryptsec(backup?.content as string, PASSPHRASE)).toThrow();
    }
    // Nothing for the inbox relay: it holds only gift wraps.
    expect(net.get(INBOX[0] as string).accepted).toEqual([]);
    const status = await a.store.status();
    expect(status).toMatchObject({ state: 'unlocked', pubkey, stayUnlocked: false });
    expect((await a.store.unlocked())?.inboxKey).toEqual(inboxKey);
    expect(a.local.dump()).not.toContain(bytesToHex(secretKey));
    expect((await a.store.record())?.recoveryBackup).toBeDefined();
    // The draft's secrets are overwritten once setup is done.
    expect(draft.secretKey.every((b) => b === 0)).toBe(true);
    expect(draft.recoveryCode.every((b) => b === 0)).toBe(true);
  });

  it('stores nothing when a storage relay refuses, naming it', async () => {
    const net = network();
    net.add('wss://picky.example', { refuseKinds: [KIND_PRIVATE_RELAYS] });
    const a = device(net);
    const draft = startCreate();
    confirmRecoveryCode(draft, draft.base32);
    await expect(
      finishCreate(
        draft,
        {
          passphrase: PASSPHRASE,
          storageRelays: [...STORAGE, 'wss://picky.example'],
          inboxRelays: INBOX,
        },
        a.deps
      )
    ).rejects.toThrow(/picky\.example/);
    expect(await a.store.status()).toEqual({ state: 'empty' });
    // The same draft can be retried with other relays.
    await finishCreate(
      draft,
      { passphrase: PASSPHRASE, storageRelays: STORAGE, inboxRelays: INBOX },
      a.deps
    );
    expect((await a.store.status()).state).toBe('unlocked');
  });

  it('stores nothing when a storage relay is unreachable', async () => {
    const a = device(network());
    const draft = startCreate();
    confirmRecoveryCode(draft, draft.base32);
    await expect(
      finishCreate(
        draft,
        { passphrase: PASSPHRASE, storageRelays: ['wss://gone.example'], inboxRelays: INBOX },
        a.deps
      )
    ).rejects.toThrow(/Could not reach wss:\/\/gone\.example/);
    expect(await a.store.status()).toEqual({ state: 'empty' });
  });

  it('probes relays for their roles before they are saved (9.1)', async () => {
    const net = network();
    net.add('wss://open-inbox.example');
    const a = device(net);
    const results = await probeRelays(
      [
        { url: STORAGE[0] as string, role: 'storage' },
        { url: INBOX[0] as string, role: 'storage' },
        { url: INBOX[0] as string, role: 'inbox' },
        { url: 'wss://open-inbox.example', role: 'inbox' },
      ],
      a.deps
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false]);
    expect(results[1]?.failed?.name).toBe('accepts kind 31234 without AUTH');
    expect(results[3]?.failed?.name).toBe('hides gift wraps from unauthenticated reads');
  });
});
