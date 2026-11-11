/**
 * Recovery from the recovery code alone, and from every relay a queue may be on (spec 6.1, 9.1).
 * The regression case: a queue made before 2026-11-09 on the then-default storage relays,
 * nos.lol and relay.ditto.pub, whose backup has no lookup tag and is now on relay.ditto.pub alone
 * (nos.lol drops every write), recovered by a user who kept only the code.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  buildPrivateRelayList,
  buildRecoveryBackup,
  buildSettings,
  createLocalSigner,
  encodeNcryptsec,
  formatRecoveryBase32,
  generateRecoveryCode,
  type NostrEvent,
  parseRecoveryBackup,
  parseRecoveryCode,
  RelayConnection,
  recoveryCodeToBase32,
  recoveryCodeToWords,
  recoveryLookupOf,
  recoveryLookupTag,
  recoveryPassword,
} from '@qusme/nostr';
import type { FakeRelayNetwork } from '@qusme/nostr/testing';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STORAGE_RELAYS } from '../src/setup/create.ts';
import {
  addRecoveryLookup,
  BackupNotFound,
  backupNeedsLookup,
  finishRecover,
  PREVIOUS_DEFAULT_STORAGE_RELAYS,
  recoverWithCode,
  recoveryRelays,
} from '../src/setup/recover.ts';
import { parseRecoverySheet } from '../src/setup/recoverySheet.ts';
import { lookupRelays } from '../src/ui/recover.tsx';
import { createdDevice, device, INBOX, network, TEST_LOG_N } from './helpers.ts';

const PRIMAL = 'wss://relay.primal.net';
const NOSLOL = 'wss://nos.lol';
const DITTO = 'wss://relay.ditto.pub';
const NEW_PASSPHRASE = 'harbor lantern copper ninety';

/** Today's public relays as fakes: primal empty, nos.lol taking nothing, ditto holding the queue. */
function publicRelays(options: { primal?: boolean } = {}): FakeRelayNetwork {
  const net = network();
  if (options.primal !== false) net.add(PRIMAL);
  net.add(NOSLOL, { silentWrites: true });
  net.add(DITTO);
  return net;
}

async function seed(net: FakeRelayNetwork, url: string, events: NostrEvent[]): Promise<void> {
  const connection = await RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 });
  for (const event of events) await connection.publish(event);
  connection.close();
}

/**
 * A queue as setup made it between 2026-11-05 and 2026-11-08: storage on nos.lol and ditto, and a
 * recovery backup with no lookup tag. Its events are on ditto only.
 */
async function legacyQueue(net: FakeRelayNetwork) {
  const secretKey = generateSecretKey();
  const code = generateRecoveryCode();
  const signer = createLocalSigner(secretKey);
  const ncryptsec = encodeNcryptsec(secretKey, recoveryPassword(code), { logN: TEST_LOG_N });
  const backup = await buildRecoveryBackup(signer, ncryptsec);
  const relayList = await buildPrivateRelayList(signer, [...PREVIOUS_DEFAULT_STORAGE_RELAYS]);
  const settings = await buildSettings(signer, {
    inbox_key: bytesToHex(generateSecretKey()),
    inbox_relays: INBOX,
    quota_counts: {},
  });
  await seed(net, DITTO, [relayList, settings, backup]);
  const pubkey = getPublicKey(secretKey);
  return {
    secretKey,
    pubkey,
    npub: npubEncode(pubkey),
    words: recoveryCodeToWords(code).join(' '),
    base32: formatRecoveryBase32(recoveryCodeToBase32(code)),
    lookup: recoveryLookupTag(code),
    backup,
  };
}

const lookupOnRelay = (net: FakeRelayNetwork, url: string, pubkey: string) =>
  net
    .get(url)
    .events.filter((e) => e.pubkey === pubkey && e.kind === 30078)
    .map((e) => parseRecoveryBackup(e))
    .flatMap((p) => (p.ok ? [recoveryLookupOf(p.value)] : []));

describe('recovery from the code alone (spec 6.1)', { timeout: 60_000 }, () => {
  it('asks the current and earlier default storage relays, and the ones given first', () => {
    expect(recoveryRelays(undefined, {})).toEqual([
      ...DEFAULT_STORAGE_RELAYS,
      NOSLOL, // relay.ditto.pub is in both lists and is asked once
    ]);
    expect(recoveryRelays(['wss://mine.example/', DITTO], {})).toEqual([
      'wss://mine.example',
      DITTO,
      PRIMAL,
      NOSLOL,
    ]);
  });

  it('recovers a pre-2026-11-09 queue from the 12 words alone when only relay.ditto.pub has it', async () => {
    const net = publicRelays();
    const q = await legacyQueue(net);
    expect(net.get(NOSLOL).events).toEqual([]);
    expect(net.get(PRIMAL).events).toEqual([]);
    const b = device(net);
    const opened = await recoverWithCode({ code: q.words }, b.deps);
    expect(opened.fetched.relayUrl).toBe(DITTO);
    expect(opened.fetched.queuePubkey).toBe(q.pubkey);
    expect(opened.key).toEqual(q.secretKey);

    const result = await finishRecover(opened.fetched, opened.key, NEW_PASSPHRASE, b.deps, {
      lookup: opened.lookup,
    });
    expect(result).toEqual({
      storageRelays: [...PREVIOUS_DEFAULT_STORAGE_RELAYS],
      relayListFound: true,
      settingsFound: true,
      lookupAdded: true,
    });
    // The backup on ditto now carries the lookup tag, and so does this device's copy.
    expect(lookupOnRelay(net, DITTO, q.pubkey)).toEqual([q.lookup]);
    expect(backupNeedsLookup(await b.store.record())).toBe(false);
    expect((await b.store.record())?.recoveryBackup?.content).toBe(q.backup.content);

    // A second device now finds it by the tag.
    const c = device(net);
    const again = await recoverWithCode({ code: q.words }, c.deps);
    expect(recoveryLookupOf(again.fetched.backup)).toBe(q.lookup);
    expect(again.key).toEqual(q.secretKey);
  });

  it('recovers from the 26-character code alone, as printed or typed loosely', async () => {
    const net = publicRelays();
    const q = await legacyQueue(net);
    const plain = q.base32.replace(/-/g, '');
    for (const typed of [
      q.base32,
      plain.toLowerCase(),
      q.base32.replace(/-/g, ' '),
      `  ${q.base32}\n`,
      plain.replace(/1/g, 'l').replace(/0/g, 'O'),
    ]) {
      // Through the recovery box, as the screen does it.
      const parsed = parseRecoverySheet(typed);
      expect(parsed.npub).toBeUndefined();
      expect(parsed.code).toBeDefined();
      const b = device(net);
      const opened = await recoverWithCode(
        { code: parsed.code as string, relays: lookupRelays(parsed, '') },
        b.deps
      );
      expect(opened.key).toEqual(q.secretKey);
    }
  });

  it('recovers with the Queue ID and code when primal has nothing and nos.lol never got it', async () => {
    const net = publicRelays();
    const q = await legacyQueue(net);
    const b = device(net);
    const opened = await recoverWithCode({ code: q.words, npub: q.npub }, b.deps);
    expect(opened.fetched.relayUrl).toBe(DITTO);
    expect(opened.fetched.relays).toEqual([DITTO]);
    expect(opened.key).toEqual(q.secretKey);
  });

  it('still finds it with primal unreachable', async () => {
    const net = publicRelays({ primal: false });
    const q = await legacyQueue(net);
    const opened = await recoverWithCode({ code: q.words }, device(net).deps);
    expect(opened.key).toEqual(q.secretKey);
  });

  it('opens the right backup among other queues’ backups, untagged and tagged', async () => {
    const net = publicRelays();
    await legacyQueue(net);
    const q = await legacyQueue(net);
    await legacyQueue(net);
    // A queue made by this build: its backup is tagged for its own code, so it is never tried.
    const fresh = await createdDevice(net);
    await seed(net, DITTO, [(await fresh.store.record())?.recoveryBackup as NostrEvent]);
    const opened = await recoverWithCode({ code: q.base32 }, device(net).deps);
    expect(opened.key).toEqual(q.secretKey);
    const theirs = await recoverWithCode({ code: fresh.words }, device(net).deps);
    expect(theirs.key).toEqual(fresh.secretKey);
    expect(theirs.fetched.relayUrl).toBe(DITTO);
  });

  it('says which failure it was: not a code, no backup anywhere, or a code that opens nothing', async () => {
    const net = publicRelays({ primal: false });
    const b = device(net);
    await expect(recoverWithCode({ code: 'abandon ability able' }, b.deps)).rejects.toThrow(
      /That is not a recovery code/
    );
    const nobody = recoveryCodeToWords(generateRecoveryCode()).join(' ');
    const missing = recoverWithCode({ code: nobody }, b.deps);
    await expect(missing).rejects.toBeInstanceOf(BackupNotFound);
    await expect(missing).rejects.toThrow(
      `No recovery backup found on ${DITTO}, ${NOSLOL} (${PRIMAL} could not be reached).`
    );

    const q = await legacyQueue(net);
    await expect(recoverWithCode({ code: nobody }, b.deps)).rejects.toThrow(
      `None of the 1 recovery backups on ${DITTO}, ${NOSLOL} (${PRIMAL} could not be reached) opens with this code.`
    );
    await expect(recoverWithCode({ code: nobody, npub: q.npub }, b.deps)).rejects.toThrow(
      `Found this queue’s backup on ${DITTO}, but that recovery code does not open it.`
    );
  });

  it('tags a new queue’s backup at setup', async () => {
    const a = await createdDevice(network());
    const backup = (await a.store.record())?.recoveryBackup;
    const parsed = parseRecoveryBackup(backup);
    const code = parseRecoveryCode(a.words) as Uint8Array;
    expect(parsed.ok && recoveryLookupOf(parsed.value)).toBe(recoveryLookupTag(code));
    expect(backupNeedsLookup(await a.store.record())).toBe(false);
  });

  it('adds the tag from an unlocked device once the user types the code', async () => {
    const net = publicRelays();
    const q = await legacyQueue(net);
    const b = device(net);
    // Recovered by Queue ID before this build: no tag yet.
    const opened = await recoverWithCode({ code: q.words, npub: q.npub }, b.deps);
    await finishRecover(opened.fetched, opened.key, NEW_PASSPHRASE, b.deps);
    expect(backupNeedsLookup(await b.store.record())).toBe(true);

    const other = recoveryCodeToWords(generateRecoveryCode()).join(' ');
    await expect(addRecoveryLookup(other, b.deps)).rejects.toThrow(/does not open/);
    await expect(addRecoveryLookup('nope', b.deps)).rejects.toThrow(/not a recovery code/);
    await addRecoveryLookup(q.base32, b.deps);
    expect(backupNeedsLookup(await b.store.record())).toBe(false);
    expect(lookupOnRelay(net, DITTO, q.pubkey)).toEqual([q.lookup]);
    expect((await b.store.status()).state).toBe('unlocked');
  });
});
