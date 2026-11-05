import { bytesToHex } from '@noble/hashes/utils.js';
import { KIND_PAIRING, parsePairingUri } from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import type { PendingImport } from '../src/keyStore.ts';
import { SourcePairing, type SourcePhase } from '../src/setup/pairSource.ts';
import {
  finishPairing,
  openPendingImport,
  resolvePairingInput,
  TargetPairing,
  type TargetPhase,
} from '../src/setup/pairTarget.ts';
import {
  createdDevice,
  device,
  FakeService,
  network,
  PASSPHRASE,
  STORAGE,
  until,
} from './helpers.ts';

const NEW_PASSPHRASE = 'saffron tundra pocket eleven';

async function pendingOf(d: { store: { pendingImport(): Promise<PendingImport | undefined> } }) {
  const pending = await d.store.pendingImport();
  if (pending === undefined) throw new Error('no pending import');
  return pending;
}

function recorder<T extends { phase: string }>() {
  const phases: T[] = [];
  return {
    phases,
    on: (phase: T) => {
      phases.push(phase);
    },
    last: () => phases[phases.length - 1] as T,
    has: (name: string) => phases.some((p) => p.phase === name),
  };
}

async function runPairing(
  options: { typed?: boolean; storage?: Parameters<typeof network>[0] } = {}
) {
  const net = network(options.storage);
  const service = new FakeService();
  const a = await createdDevice(net, service);
  const b = device(net, service);
  const src = recorder<SourcePhase>();
  const tgt = recorder<TargetPhase>();
  const source = await SourcePairing.start(a.deps, src.on);
  let input = source.uri;
  if (options.typed) input = await source.requestCode();
  const resolved = await resolvePairingInput(input, b.deps);
  const target = await TargetPairing.start(resolved, b.deps, tgt.on);
  return { net, service, a, b, src, tgt, source, target, resolved };
}

describe('pairing end to end (spec 8.3)', { timeout: 30_000 }, () => {
  it('pairs over a QR session: same SAS, passphrase copy, then a new local passphrase', async () => {
    const { a, b, src, tgt, source, target, resolved } = await runPairing();
    expect(resolved.channel).toBe('qr');
    const sas = (tgt.phases[0] as Extract<TargetPhase, { phase: 'compare' }>).sas;
    expect(sas).toMatch(/^\d{6}$/);
    await until(() => src.has('compare'));
    expect(src.last()).toEqual({ phase: 'compare', sas });

    await target.confirmSas(); // the new device's user may confirm first
    await source.confirmSas();
    await until(() => tgt.has('unlock') && src.has('done'));
    expect(tgt.last()).toEqual({ phase: 'unlock', unlockWith: 'passphrase' });

    const pending = await pendingOf(b);
    expect(pending.ncryptsec).toBe((await a.store.record())?.ncryptsec);
    expect(pending.queuePubkey).toBe(a.pubkey);
    expect(() => openPendingImport(pending, NEW_PASSPHRASE)).toThrow(/passphrase/);
    const key = openPendingImport(pending, PASSPHRASE);
    const result = await finishPairing(pending, key, NEW_PASSPHRASE, b.deps);
    expect(result).toEqual({ ok: true, storageRelays: STORAGE, settingsFound: true });
    expect(await b.store.status()).toMatchObject({ state: 'unlocked', pubkey: a.pubkey });
    expect((await b.store.unlocked())?.inboxKey).toEqual(a.inboxKey);
    expect((await b.store.record())?.recoveryBackup).toBeDefined();
    expect(await b.store.pendingImport()).toBeUndefined();
    await b.store.lock();
    await b.store.unlock(NEW_PASSPHRASE);
    expect(b.permissionRequests).toBe(0);
    expect(source.session.state).toBe('completed');
  });

  it('pairs over a typed code: the service relays the URI and the recovery backup is sent', async () => {
    const { a, b, service, src, tgt, source, target, resolved } = await runPairing({ typed: true });
    expect(resolved.channel).toBe('typed-code');
    expect(a.permissionRequests).toBe(1);
    expect(b.permissionRequests).toBe(1);
    expect(service.posts[0]?.pubkey).toBe(a.pubkey);
    expect(service.posts[0]?.body.uri).toBe(source.uri);
    expect(src.phases.some((p) => p.phase === 'waiting' && p.code !== undefined)).toBe(true);
    expect(source.session.typedCode).toBe(true);

    await until(() => src.has('compare'));
    await source.confirmSas();
    await target.confirmSas();
    await until(() => tgt.has('unlock'));
    expect(tgt.last()).toEqual({ phase: 'unlock', unlockWith: 'recovery-code' });
    const pending = await pendingOf(b);
    expect(pending.ncryptsec).toBe((await a.store.record())?.recoveryBackup?.content);
    expect(() => openPendingImport(pending, PASSPHRASE)).toThrow(/not a recovery code/);
    const key = openPendingImport(pending, a.base32);
    expect(key).toEqual(a.secretKey);
    expect((await finishPairing(pending, key, NEW_PASSPHRASE, b.deps)).ok).toBe(true);
    expect((await b.store.status()).state).toBe('unlocked');
  });

  it('never moves an unencrypted key and authenticates only as ephemeral keys', async () => {
    const { a, net, src, tgt, source, target } = await runPairing({
      storage: { authRequired: true },
    });
    await until(() => src.has('compare'));
    await source.confirmSas();
    await target.confirmSas();
    await until(() => tgt.has('unlock'));
    const hex = bytesToHex(a.secretKey);
    for (const url of STORAGE) {
      const relay = net.get(url);
      const pairing = relay.accepted.filter((e) => e.kind === KIND_PAIRING);
      expect(pairing.length).toBeGreaterThan(0);
      expect(pairing.some((e) => e.pubkey === a.pubkey)).toBe(false);
      expect(JSON.stringify(relay.accepted)).not.toContain(hex);
      const pairingReqs = relay.requests.filter((r) =>
        r.filters.some((f) => f.kinds?.includes(KIND_PAIRING))
      );
      expect(pairingReqs.length).toBeGreaterThan(0);
      for (const req of pairingReqs) expect(req.authed).not.toContain(a.pubkey);
    }
  });

  it('stops both sides when the user says the codes differ', async () => {
    const { src, tgt, source, target } = await runPairing();
    await until(() => src.has('compare'));
    await target.deny();
    await until(() => src.has('failed'));
    expect(tgt.last()).toMatchObject({ phase: 'failed', message: /cancelled/ });
    expect(source.session.terminal).toBe(true);
  });

  it('asks for a relay when the sent relays differ from the queue’s 10013', async () => {
    const { b, src, tgt, source, target } = await runPairing();
    await until(() => src.has('compare'));
    await source.confirmSas();
    await target.confirmSas();
    await until(() => tgt.has('unlock'));
    const pending = await pendingOf(b);
    const forged = { ...pending, relays: [STORAGE[0] as string] };
    const key = openPendingImport(forged, PASSPHRASE);
    const mismatch = await finishPairing(forged, key, NEW_PASSPHRASE, b.deps);
    expect(mismatch).toMatchObject({ ok: false, reason: 'relay_list_mismatch' });
    expect((await b.store.status()).state).toBe('empty');
    const none = await finishPairing(forged, key, NEW_PASSPHRASE, b.deps, 'wss://gone.example');
    expect(none).toMatchObject({ ok: false, reason: 'relay_list_missing' });
    const fixed = await finishPairing(forged, key, NEW_PASSPHRASE, b.deps, STORAGE[1] as string);
    expect(fixed).toEqual({ ok: true, storageRelays: STORAGE, settingsFound: true });
  });

  it('discards a key that is not the queue the other device named', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    const ncryptsec = (await a.store.record())?.ncryptsec as string;
    const other = await createdDevice(network());
    expect(() =>
      openPendingImport(
        { ncryptsec, unlockWith: 'passphrase', queuePubkey: other.pubkey, receivedAt: 0 },
        PASSPHRASE
      )
    ).toThrow(/does not match/);
    expect(await b.store.status()).toEqual({ state: 'empty' });
  });

  it('resolves typed codes through the service and refuses bad input', async () => {
    const net = network();
    const service = new FakeService();
    const b = device(net, service);
    await expect(resolvePairingInput('ABCD-0001', b.deps)).rejects.toThrow(/unknown, used/);
    expect(service.lookups).toEqual(['ABCD0001']);
    await expect(resolvePairingInput('hello', b.deps)).rejects.toThrow(/nostrpair/);
    await expect(resolvePairingInput('nostrpair://zz', b.deps)).rejects.toThrow(/not valid/);
    const denied = device(net, service, { grant: false });
    await expect(resolvePairingInput('ABCD0002', denied.deps)).rejects.toThrow(/access/);
    expect(service.lookups).toHaveLength(1);
  });

  it('uses a typed code once: a second lookup fails', async () => {
    const net = network();
    const service = new FakeService();
    const a = await createdDevice(net, service);
    const b = device(net, service);
    const source = await SourcePairing.start(a.deps, () => undefined);
    const code = await source.requestCode();
    expect(await source.requestCode()).toBe(code);
    const resolved = await resolvePairingInput(code.toLowerCase(), b.deps);
    expect(parsePairingUri(source.uri).ok).toBe(true);
    expect(resolved.deadline).toBeLessThanOrEqual(source.session.expiresAt);
    await expect(resolvePairingInput(code, b.deps)).rejects.toThrow(/unknown, used/);
    source.close();
  });

  it('needs an unlocked queue to start, and a backup copy to issue a code', async () => {
    const net = network();
    const a = await createdDevice(net);
    await a.store.lock();
    await expect(SourcePairing.start(a.deps, () => undefined)).rejects.toThrow(/Unlock/);
    await a.store.unlock(PASSPHRASE);
    await a.store.update({ recoveryBackup: undefined });
    const source = await SourcePairing.start(a.deps, () => undefined);
    expect(source.canIssueCode).toBe(false);
    await expect(source.requestCode()).rejects.toThrow(/recovery backup/);
    expect(source.session.typedCode).toBe(false);
    source.close();
  });
});
