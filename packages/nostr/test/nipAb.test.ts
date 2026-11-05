import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildPairingUri,
  decodeNcryptsec,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhShared,
  encodeNcryptsec,
  isCurvePoint,
  KIND_PAIRING,
  matchesQueuePubkey,
  type NostrEvent,
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  PAIRING_SESSION_TIMEOUT_MS,
  PAIRING_STEP_TIMEOUT_MS,
  PairingSource,
  type PairingStep,
  PairingTarget,
  type PairingUri,
  pairingFilter,
  parsePairingUri,
} from '../src/index.ts';
import { expectOk, queueKey, queuePubkey } from './helpers.ts';

// NIP-AB's test vectors (nostr-protocol/nips#2328 at 61236b8, "Test Vectors").
const NIP = {
  sessionSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
  sourcePrivkey: '7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5',
  sourcePubkey: '199e64ca60662cb2d6e91d16cb065be51ad74a6ee5f8c5b0fdc53d246611ed9a',
  targetPrivkey: '3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b',
  targetPubkey: '89a9fa762105d0aee2b19678246fe7b823aabbc4f4bf691a1ce8a70fcd36d6e4',
  sessionId: 'fb357d0f8e8d5a5ba3b2a91cb18c119e1567b07ffa38cdebb73e68df78f5a380',
  ecdhShared: '9b4b6d6990713d89d6d9982e506ee1bbcde6f05c54d9d2978696e8a7274d4408',
  sasInput: 'e8b03a329f3a0ac37fe7fbe929171e14b72812be67e33c5d6e193543c41798d3',
  sasCode: '863346',
  transcriptHash: 'd662818ff8911fc60a2d025f8b8b4756107104e85888dd202d28db5ca2cf28d3',
};

interface BuzzEvent {
  plaintext: string;
  event: NostrEvent;
}
// Written by scripts/nip-ab-buzz from block/buzz's buzz-core (see its Cargo.toml).
const buzz = JSON.parse(
  readFileSync(new URL('./vectors/nip-ab-buzz.vectors.json', import.meta.url), 'utf8')
) as {
  buzz_rev: string;
  ncryptsec: string;
  derivations: Record<string, string>;
  uris: { relays: string[]; uri: string }[];
  qr_cases: { uri: string; ok: boolean; relays?: string[]; error?: string }[];
  to_source: Record<string, BuzzEvent>;
  to_target: Record<string, BuzzEvent>;
};

const T0 = 1_761_400_000_000;
const RELAYS = ['wss://nos.lol', 'wss://relay.ditto.pub'];
// NIP-49's example ncryptsec (password "nostr", log_n 16) and the key it holds.
const NCRYPTSEC = buzz.ncryptsec;
const NCRYPTSEC_KEY = '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683';
const passphraseCopy = encodeNcryptsec(queueKey, 'correct horse', { logN: 16 });
const recoveryBackup = encodeNcryptsec(queueKey, '00112233445566778899aabbccddeeff', {
  logN: 16,
});
const sourcePayload = { passphraseCopy, recoveryBackup, relays: RELAYS, queuePubkey };

/** The session's protected fields, for checks the public API can't make. */
const internals = (session: PairingSource | PairingTarget) =>
  session as unknown as Record<
    'secretKey' | 'sessionSecret' | 'sessionId' | 'sasInput' | 'conversationKey',
    Uint8Array
  >;
const secretOf = (session: PairingSource | PairingTarget): Uint8Array =>
  internals(session).secretKey;

const decryptFor = (secretKey: Uint8Array, event: NostrEvent): Record<string, unknown> =>
  JSON.parse(nip44DecryptWithKey(nip44ConversationKey(secretKey, event.pubkey), event.content));

/** Delivers every event of a step to `to`, returning the last step that had a notice. */
function deliver(step: PairingStep, to: PairingSource | PairingTarget, now = T0): PairingStep[] {
  return step.publish.map((event) => to.receive(event, now));
}

function pair(channel: 'qr' | 'typed-code' = 'qr') {
  const source = new PairingSource(RELAYS, { now: T0 });
  if (channel === 'typed-code') source.markTypedCode();
  const uri = expectOk(parsePairingUri(source.uri));
  const target = new PairingTarget(uri, channel, { now: T0 });
  return { source, target, uri };
}

/** A kind 24134 event from `secretKey` to `recipient` with any plaintext. */
function rawMessage(
  secretKey: Uint8Array,
  recipient: string,
  plaintext: string,
  tags: string[][] = [['p', recipient]],
  kind = KIND_PAIRING
): NostrEvent {
  return finalizeEvent(
    {
      kind,
      created_at: T0 / 1000,
      tags,
      content: nip44EncryptWithKey(nip44ConversationKey(secretKey, recipient), plaintext),
    },
    secretKey
  );
}

describe('NIP-AB derivations', () => {
  it('matches the NIP test vectors', () => {
    const secret = hexToBytes(NIP.sessionSecret);
    expect(getPublicKey(hexToBytes(NIP.sourcePrivkey))).toBe(NIP.sourcePubkey);
    expect(getPublicKey(hexToBytes(NIP.targetPrivkey))).toBe(NIP.targetPubkey);
    expect(bytesToHex(deriveSessionId(secret))).toBe(NIP.sessionId);
    const ecdh = ecdhShared(hexToBytes(NIP.sourcePrivkey), NIP.targetPubkey);
    expect(bytesToHex(ecdh)).toBe(NIP.ecdhShared);
    expect(bytesToHex(ecdhShared(hexToBytes(NIP.targetPrivkey), NIP.sourcePubkey))).toBe(
      NIP.ecdhShared
    );
    const sas = deriveSas(ecdh, secret);
    expect(bytesToHex(sas.input)).toBe(NIP.sasInput);
    expect(sas.code).toBe(NIP.sasCode);
    const hash = deriveTranscriptHash(
      hexToBytes(NIP.sessionId),
      NIP.sourcePubkey,
      NIP.targetPubkey,
      sas.input,
      secret
    );
    expect(bytesToHex(hash)).toBe(NIP.transcriptHash);
  });

  it('matches the derivations buzz-core computes', () => {
    expect(buzz.derivations).toEqual({
      session_id: NIP.sessionId,
      ecdh_shared: NIP.ecdhShared,
      sas_input: NIP.sasInput,
      sas_code: NIP.sasCode,
      transcript_hash: NIP.transcriptHash,
    });
  });

  it('uses the unhashed x-coordinate, not the NIP-44 conversation key', () => {
    const ck = nip44ConversationKey(hexToBytes(NIP.sourcePrivkey), NIP.targetPubkey);
    expect(bytesToHex(ck)).not.toBe(NIP.ecdhShared);
  });

  it('pads the SAS to six digits', () => {
    // Search the derivation for an ECDH input whose SAS has a leading zero.
    const secret = hexToBytes(NIP.sessionSecret);
    let found: string | undefined;
    for (let i = 0; i < 2000 && found === undefined; i++) {
      const ecdh = new Uint8Array(32).fill(1);
      new DataView(ecdh.buffer).setUint32(0, i);
      const { code } = deriveSas(ecdh, secret);
      if (code.startsWith('0')) found = code;
    }
    expect(found).toMatch(/^0\d{5}$/);
  });

  it('checks pubkeys are curve points', () => {
    expect(isCurvePoint(NIP.sourcePubkey)).toBe(true);
    expect(isCurvePoint('0'.repeat(64))).toBe(false);
    expect(isCurvePoint('f'.repeat(64))).toBe(false);
    expect(isCurvePoint(NIP.sourcePubkey.toUpperCase())).toBe(false);
    expect(() => ecdhShared(hexToBytes(NIP.sourcePrivkey), 'f'.repeat(64))).toThrow();
  });

  it('refuses a session secret of the wrong length', () => {
    expect(() => deriveSessionId(new Uint8Array(31))).toThrow();
    expect(() => deriveSessionId(new Uint8Array(33))).toThrow();
  });
});

describe('nostrpair:// URIs', () => {
  const secret = hexToBytes(NIP.sessionSecret);

  it('round-trips, percent-encoding relays', () => {
    const relays = ['wss://nos.lol', 'ws://localhost:7777/path?x=1&y=2#frag'];
    const uri = buildPairingUri({ sourcePubkey: NIP.sourcePubkey, sessionSecret: secret, relays });
    expect(uri).toBe(
      `nostrpair://${NIP.sourcePubkey}?secret=${NIP.sessionSecret}` +
        '&relay=wss%3A%2F%2Fnos.lol&relay=ws%3A%2F%2Flocalhost%3A7777%2Fpath%3Fx%3D1%26y%3D2%23frag&v=1'
    );
    const parsed = expectOk(parsePairingUri(uri));
    expect(parsed.sourcePubkey).toBe(NIP.sourcePubkey);
    expect(bytesToHex(parsed.sessionSecret)).toBe(NIP.sessionSecret);
    expect(parsed.relays).toEqual(relays);
    expect(parsed.version).toBe(1);
  });

  it('parses the URIs buzz-core encodes', () => {
    for (const { uri, relays } of buzz.uris) {
      const parsed = expectOk(parsePairingUri(uri));
      expect(parsed.relays).toEqual(relays);
      expect(parsed.sourcePubkey).toBe(NIP.sourcePubkey);
    }
  });

  it("agrees with buzz-core's decode_qr, except that it also checks the curve", () => {
    expect(buzz.qr_cases.length).toBeGreaterThan(15);
    for (const c of buzz.qr_cases) {
      const result = parsePairingUri(c.uri);
      const offCurve = c.uri.startsWith(`nostrpair://${'f'.repeat(64)}`);
      expect({ uri: c.uri, ok: result.ok }).toEqual({ uri: c.uri, ok: c.ok && !offCurve });
      if (result.ok && c.relays) expect(result.value.relays).toEqual(c.relays);
    }
  });

  it('refuses what the NIP requires it to refuse', () => {
    const base = `nostrpair://${NIP.sourcePubkey}?secret=${NIP.sessionSecret}&relay=wss%3A%2F%2Fa.example`;
    expect(parsePairingUri(`${base}&v=1`).ok).toBe(true);
    expect(parsePairingUri(`${base}&v=abc`).ok).toBe(false);
    expect(parsePairingUri(`${base}&v=1&v=1`).ok).toBe(false);
    expect(parsePairingUri(`${base}&secret=${NIP.sessionSecret}`).ok).toBe(false);
    expect(parsePairingUri(`${base}&relay=%E0%A4%A`).ok).toBe(false);
    expect(parsePairingUri(42).ok).toBe(false);
  });

  it('refuses to build a malformed URI', () => {
    const ok = { sourcePubkey: NIP.sourcePubkey, sessionSecret: secret, relays: RELAYS };
    expect(() => buildPairingUri({ ...ok, relays: [] })).toThrow();
    expect(() => buildPairingUri({ ...ok, relays: ['https://x.example'] })).toThrow();
    expect(() => buildPairingUri({ ...ok, relays: [...RELAYS, 'wss://c', 'wss://d'] })).toThrow();
    expect(() => buildPairingUri({ ...ok, sessionSecret: new Uint8Array(32) })).toThrow();
    expect(() => buildPairingUri({ ...ok, sourcePubkey: 'f'.repeat(64) })).toThrow();
  });
});

describe('NIP-AB sessions', () => {
  it('pairs over QR, sending the passphrase copy', () => {
    const { source, target } = pair('qr');
    expect(target.offer.kind).toBe(KIND_PAIRING);
    expect(target.offer.tags).toEqual([['p', source.pubkey]]);
    expect(source.filter).toEqual(pairingFilter(source.pubkey));
    expect(target.filter).toEqual({ kinds: [KIND_PAIRING], '#p': [target.pubkey] });

    const offered = source.receive(target.offer, T0);
    expect(offered).toEqual({ publish: [], notice: { type: 'sas', sas: target.sas } });
    expect(source.state).toBe('confirming');

    const sent = source.confirmSas(sourcePayload, T0 + 1000);
    expect(sent.publish.map((e) => decryptFor(secretOf(target), e).type)).toEqual([
      'sas-confirm',
      'payload',
    ]);
    const [verified, held] = deliver(sent, target, T0 + 1000);
    expect(verified?.notice).toEqual({ type: 'verified' });
    expect(held).toEqual({ publish: [] });
    expect(target.state).toBe('verified');

    const released = target.confirmSas(T0 + 2000);
    expect(released.notice).toEqual({
      type: 'payload',
      payload: {
        ncryptsec: passphraseCopy,
        logN: 16,
        unlockWith: 'passphrase',
        relays: RELAYS,
        queuePubkey,
      },
    });
    expect(target.state).toBe('importing');

    const complete = target.stored(true, T0 + 2500);
    expect(target.state).toBe('completed');
    expect(deliver(complete, source, T0 + 2500)).toEqual([
      { publish: [], notice: { type: 'complete', success: true } },
    ]);
    expect(source.state).toBe('completed');
    expect(source.nextDeadline).toBeUndefined();
    expect(target.nextDeadline).toBeUndefined();

    const payload = released.notice?.type === 'payload' ? released.notice.payload : undefined;
    if (payload === undefined) throw new Error('no payload');
    const key = decodeNcryptsec(payload.ncryptsec, 'correct horse');
    expect(matchesQueuePubkey(key, payload)).toBe(true);
    expect(matchesQueuePubkey(hexToBytes(NIP.sourcePrivkey), payload)).toBe(false);
  });

  it('sends the recovery backup once a typed code was issued', () => {
    const { source, target } = pair('typed-code');
    expect(source.typedCode).toBe(true);
    expect(source.unlockWith).toBe('recovery-code');
    expect(target.unlockWith).toBe('recovery-code');
    source.receive(target.offer, T0);
    target.confirmSas(T0);
    const steps = deliver(source.confirmSas(sourcePayload, T0), target, T0);
    const notice = steps[1]?.notice;
    expect(notice?.type === 'payload' && notice.payload.ncryptsec).toBe(recoveryBackup);
    expect(notice?.type === 'payload' && notice.payload.unlockWith).toBe('recovery-code');
  });

  it('puts the qus.me fields beside the NIP-AB ones in the payload', () => {
    const { source, target } = pair('qr');
    source.receive(target.offer, T0);
    const [, payload] = source.confirmSas(sourcePayload, T0).publish;
    if (payload === undefined) throw new Error('no payload');
    expect(decryptFor(secretOf(target), payload)).toEqual({
      type: 'payload',
      payload_type: 'nsec',
      payload: passphraseCopy,
      qusme_relays: RELAYS,
      qusme_npub: npubEncode(queuePubkey),
    });
  });

  it('sends complete with an explicit success, as buzz requires', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    target.confirmSas(T0);
    deliver(source.confirmSas(sourcePayload, T0), target, T0);
    const [complete] = target.stored(false, T0).publish;
    if (complete === undefined) throw new Error('no complete');
    expect(decryptFor(secretOf(source), complete)).toEqual({ type: 'complete', success: false });
    expect(target.state).toBe('failed');
    expect(source.receive(complete, T0).notice).toEqual({ type: 'complete', success: false });
    expect(source.state).toBe('failed');
  });

  it('refuses to issue a code once an offer arrived', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    expect(() => source.markTypedCode()).toThrow();
  });

  it('never sends anything but the ncryptsec the session calls for', () => {
    const nsecLike = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
    const qr = pair('qr');
    qr.source.receive(qr.target.offer, T0);
    expect(() => qr.source.confirmSas({ ...sourcePayload, passphraseCopy: undefined }, T0)).toThrow(
      /passphrase copy/
    );
    expect(() =>
      qr.source.confirmSas({ ...sourcePayload, passphraseCopy: nsecLike }, T0)
    ).toThrow();
    expect(() => qr.source.confirmSas({ ...sourcePayload, relays: [] }, T0)).toThrow();
    expect(() => qr.source.confirmSas({ ...sourcePayload, relays: ['https://x'] }, T0)).toThrow();
    expect(() => qr.source.confirmSas({ ...sourcePayload, queuePubkey: 'npub1x' }, T0)).toThrow();
    const typed = pair('typed-code');
    typed.source.receive(typed.target.offer, T0);
    expect(() =>
      typed.source.confirmSas({ ...sourcePayload, recoveryBackup: undefined }, T0)
    ).toThrow(/recovery backup/);
    expect(qr.source.state).toBe('confirming');
  });

  it('holds a payload that arrives before sas-confirm, and before the user confirms', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    const [sasConfirm, payload] = source.confirmSas(sourcePayload, T0).publish;
    if (sasConfirm === undefined || payload === undefined) throw new Error('missing events');
    expect(target.receive(payload, T0)).toEqual({ publish: [] });
    expect(target.state).toBe('offered');
    expect(target.receive(sasConfirm, T0)).toEqual({ publish: [], notice: { type: 'verified' } });
    expect(target.state).toBe('verified');
    expect(target.confirmSas(T0).notice?.type).toBe('payload');
  });

  it('lets the target user confirm before the source does', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    expect(target.confirmSas(T0)).toEqual({ publish: [] });
    expect(target.userConfirmed).toBe(true);
    const [verified, released] = deliver(source.confirmSas(sourcePayload, T0), target, T0);
    expect(verified?.notice).toEqual({ type: 'verified' });
    expect(released?.notice?.type).toBe('payload');
  });

  it('aborts with sas_mismatch on a wrong transcript hash and drops the payload', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    const [, payload] = source.confirmSas(sourcePayload, T0).publish;
    if (payload === undefined) throw new Error('no payload');
    target.receive(payload, T0);
    target.confirmSas(T0);
    const bad = rawMessage(
      secretOf(source),
      target.pubkey,
      JSON.stringify({ type: 'sas-confirm', transcript_hash: '00'.repeat(32) })
    );
    // The source's key is wiped only once it ends; this test session is still sending.
    const step = target.receive(bad, T0);
    expect(step.notice).toEqual({ type: 'aborted', reason: 'sas_mismatch', by: 'local' });
    expect(step.publish).toHaveLength(1);
    expect(decryptFor(secretOf(source), step.publish[0] as NostrEvent)).toEqual({
      type: 'abort',
      reason: 'sas_mismatch',
    });
    expect(target.state).toBe('aborted');
    expect(target.confirmSas(T0)).toEqual({ publish: [] });
  });

  it('refuses a payload that is not an ncryptsec, telling the source', () => {
    for (const [payload, reason] of [
      [{ type: 'payload', payload_type: 'nsec', payload: 'nsec1abc' }, 'not_ncryptsec'],
      [{ type: 'payload', payload: 'ncryptsec1notreally' }, 'not_ncryptsec'],
      [{ type: 'payload', payload_type: 'bunker', payload: NCRYPTSEC }, 'unsupported_payload_type'],
    ] as const) {
      const { source, target } = pair();
      source.receive(target.offer, T0);
      const [sasConfirm] = source.confirmSas(sourcePayload, T0).publish;
      target.receive(sasConfirm, T0);
      target.confirmSas(T0);
      const step = target.receive(
        rawMessage(secretOf(source), target.pubkey, JSON.stringify(payload)),
        T0
      );
      expect(step.notice).toEqual({ type: 'refused', reason });
      expect(decryptFor(secretOf(source), step.publish[0] as NostrEvent)).toEqual({
        type: 'complete',
        success: false,
      });
      expect(target.state).toBe('refused');
    }
  });

  it('accepts a payload without payload_type or the qus.me fields, as a plain NIP-AB source sends', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    const [sasConfirm] = source.confirmSas(sourcePayload, T0).publish;
    target.receive(sasConfirm, T0);
    target.confirmSas(T0);
    const step = target.receive(
      rawMessage(
        secretOf(source),
        target.pubkey,
        JSON.stringify({ type: 'payload', payload: NCRYPTSEC, qusme_relays: ['nope'], extra: 1 })
      ),
      T0
    );
    expect(step.notice).toEqual({
      type: 'payload',
      payload: { ncryptsec: NCRYPTSEC, logN: 16, unlockWith: 'passphrase' },
    });
  });

  it('locks to the first valid offer and ignores every other key', () => {
    const { source, target, uri } = pair();
    const intruder = new PairingTarget(uri, 'qr', { now: T0 });
    source.receive(target.offer, T0);
    expect(source.receive(intruder.offer, T0)).toEqual({ publish: [] });
    expect(source.sas).toBe(target.sas);
    const forged = rawMessage(
      hexToBytes(NIP.targetPrivkey),
      source.pubkey,
      JSON.stringify({ type: 'abort', reason: 'user_denied' })
    );
    expect(source.receive(forged, T0)).toEqual({ publish: [] });
    expect(source.state).toBe('confirming');
  });

  it('ignores offers with a wrong session id or version, and malformed ones', () => {
    const { source, target } = pair();
    const key = secretOf(target);
    const sessionId = bytesToHex(internals(source).sessionId);
    for (const plaintext of [
      JSON.stringify({ type: 'offer', version: 1, session_id: '00'.repeat(32) }),
      JSON.stringify({ type: 'offer', version: 2, session_id: sessionId }),
      JSON.stringify({ type: 'offer', session_id: sessionId }),
      JSON.stringify({ type: 'sas-confirm', transcript_hash: '00'.repeat(32) }),
      JSON.stringify({ type: 'abort', reason: 'user_denied' }),
      '{"type":"offer","__proto__":{}}',
      'not json',
    ]) {
      expect(source.receive(rawMessage(key, source.pubkey, plaintext), T0)).toEqual({
        publish: [],
      });
    }
    expect(source.state).toBe('waiting');
    expect(source.receive(target.offer, T0).notice?.type).toBe('sas');
  });

  it('discards events that fail validation', () => {
    const { source, target } = pair();
    const key = secretOf(target);
    const offer = JSON.stringify({
      type: 'offer',
      version: 1,
      session_id: bytesToHex(internals(source).sessionId),
    });
    const cases: unknown[] = [
      rawMessage(key, source.pubkey, offer, [['p', source.pubkey]], 24133),
      rawMessage(key, source.pubkey, offer, []),
      rawMessage(key, source.pubkey, offer, [
        ['p', source.pubkey],
        ['p', source.pubkey],
      ]),
      rawMessage(key, source.pubkey, offer, [['p', target.pubkey]]),
      { ...target.offer, content: `${target.offer.content}x` },
      { ...target.offer, content: 'AgAA' },
      { ...target.offer, sig: '0'.repeat(128) },
      'not an event',
      null,
    ];
    for (const event of cases) expect(source.receive(event, T0)).toEqual({ publish: [] });
    expect(source.state).toBe('waiting');
  });

  it('ignores a repeated event id', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    target.confirmSas(T0);
    deliver(source.confirmSas(sourcePayload, T0), target, T0);
    const [complete] = target.stored(true, T0).publish;
    expect(source.receive(complete, T0).notice).toEqual({ type: 'complete', success: true });
    expect(source.receive(complete, T0)).toEqual({ publish: [] });
  });

  it('ends on an abort from the peer, reading unknown reasons as protocol_error', () => {
    const a = pair();
    a.source.receive(a.target.offer, T0);
    const denied = a.target.deny(T0);
    expect(denied.notice).toEqual({ type: 'aborted', reason: 'user_denied', by: 'local' });
    expect(deliver(denied, a.source, T0)[0]?.notice).toEqual({
      type: 'aborted',
      reason: 'user_denied',
      by: 'peer',
    });
    expect(a.source.state).toBe('aborted');

    const b = pair();
    b.source.receive(b.target.offer, T0);
    const odd = rawMessage(
      secretOf(b.source),
      b.target.pubkey,
      JSON.stringify({ type: 'abort', reason: 'solar_flare' })
    );
    expect(b.target.receive(odd, T0).notice).toEqual({
      type: 'aborted',
      reason: 'protocol_error',
      by: 'peer',
    });
  });

  it('signs NIP-42 AUTH as the ephemeral key, nothing else, and nothing once ended', () => {
    const { source, target } = pair();
    const auth = (session: PairingSource | PairingTarget) =>
      session.signAuth({ kind: 22242, created_at: 1, tags: [['challenge', 'c']], content: '' });
    expect(auth(source).pubkey).toBe(source.pubkey);
    expect(auth(target).pubkey).toBe(target.pubkey);
    expect(verifyEvent(auth(target))).toBe(true);
    expect(() => source.signAuth({ kind: 1, created_at: 1, tags: [], content: '' })).toThrow(
      /22242/
    );
    source.deny(T0);
    expect(() => auth(source)).toThrow(/ended/);
  });

  it('wipes its secrets when it ends', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    source.deny(T0);
    for (const field of [
      'secretKey',
      'sessionSecret',
      'sessionId',
      'sasInput',
      'conversationKey',
    ]) {
      expect((source as unknown as Record<string, Uint8Array>)[field]?.every((b) => b === 0)).toBe(
        true
      );
    }
  });

  it('jitters created_at up to 30 seconds into the past, never the future', () => {
    const uri = expectOk(parsePairingUri(new PairingSource(RELAYS, { now: T0 }).uri));
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const { created_at } = new PairingTarget(uri, 'qr', { now: T0 }).offer;
      expect(created_at).toBeLessThanOrEqual(T0 / 1000);
      expect(created_at).toBeGreaterThanOrEqual(T0 / 1000 - 30);
      seen.add(created_at);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(new PairingTarget(uri, 'qr', { now: T0, jitter: false }).offer.created_at).toBe(
      T0 / 1000
    );
  });
});

describe('NIP-AB timeouts', () => {
  it('ends the source 120 s after the QR was shown', () => {
    const { source } = pair();
    expect(source.nextDeadline).toBe(T0 + PAIRING_SESSION_TIMEOUT_MS);
    expect(source.tick(T0 + PAIRING_SESSION_TIMEOUT_MS - 1)).toEqual({ publish: [] });
    // No peer yet, so nothing to tell.
    expect(source.tick(T0 + PAIRING_SESSION_TIMEOUT_MS)).toEqual({
      publish: [],
      notice: { type: 'aborted', reason: 'timeout', by: 'local' },
    });
  });

  it('refuses a late offer and tells a locked peer about the timeout', () => {
    const a = pair();
    expect(a.source.receive(a.target.offer, T0 + PAIRING_SESSION_TIMEOUT_MS).notice).toEqual({
      type: 'aborted',
      reason: 'timeout',
      by: 'local',
    });
    const b = pair();
    b.source.receive(b.target.offer, T0);
    const step = b.source.tick(T0 + PAIRING_SESSION_TIMEOUT_MS);
    expect(step.publish).toHaveLength(1);
    expect(deliver(step, b.target, T0 + 1)[0]?.notice).toEqual({
      type: 'aborted',
      reason: 'timeout',
      by: 'peer',
    });
  });

  it('reports an unconfirmed transfer 30 s after sending the payload', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    source.confirmSas(sourcePayload, T0 + 5000);
    expect(source.nextDeadline).toBe(T0 + 5000 + PAIRING_STEP_TIMEOUT_MS);
    expect(source.tick(T0 + 5000 + PAIRING_STEP_TIMEOUT_MS)).toEqual({
      publish: [],
      notice: { type: 'unconfirmed' },
    });
    expect(source.state).toBe('unconfirmed');
  });

  it('aborts the target 30 s after sas-confirm when no payload comes', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    const [sasConfirm] = source.confirmSas(sourcePayload, T0).publish;
    target.receive(sasConfirm, T0 + 1000);
    expect(target.nextDeadline).toBe(T0 + 1000 + PAIRING_STEP_TIMEOUT_MS);
    const step = target.tick(T0 + 1000 + PAIRING_STEP_TIMEOUT_MS);
    expect(step.notice).toEqual({ type: 'aborted', reason: 'timeout', by: 'local' });
    expect(step.publish).toHaveLength(1);
  });

  it('waits for the target user within the session deadline once the payload is held', () => {
    const { source, target } = pair();
    source.receive(target.offer, T0);
    deliver(source.confirmSas(sourcePayload, T0), target, T0);
    expect(target.nextDeadline).toBe(T0 + PAIRING_SESSION_TIMEOUT_MS);
    expect(target.confirmSas(T0 + 60_000).notice?.type).toBe('payload');
    // Storing is local; complete still goes out after the deadline.
    expect(target.stored(true, T0 + PAIRING_SESSION_TIMEOUT_MS + 1).publish).toHaveLength(1);
  });

  it('honors an earlier deadline, such as a typed code expiring', () => {
    const uri: PairingUri = expectOk(parsePairingUri(new PairingSource(RELAYS, { now: T0 }).uri));
    const target = new PairingTarget(uri, 'typed-code', { now: T0, deadline: T0 + 10_000 });
    expect(target.nextDeadline).toBe(T0 + 10_000);
    expect(target.tick(T0 + 10_000).notice?.type).toBe('aborted');
  });
});

describe('interop with block/buzz', () => {
  const uriFor = (): PairingUri => expectOk(parsePairingUri(buzz.uris[0]?.uri));
  const sourceFor = () =>
    new PairingSource(['wss://relay.example.com'], {
      now: T0,
      secretKey: hexToBytes(NIP.sourcePrivkey),
      sessionSecret: hexToBytes(NIP.sessionSecret),
    });
  const targetFor = () =>
    new PairingTarget(uriFor(), 'qr', { now: T0, secretKey: hexToBytes(NIP.targetPrivkey) });
  const to = buzz.to_source;
  const tt = buzz.to_target;

  it('pins the buzz revision the vectors came from', () => {
    expect(buzz.buzz_rev).toMatch(/^[0-9a-f]{40}$/);
  });

  it('builds the same URI buzz-core does, up to percent-encoding', () => {
    const source = sourceFor();
    expect(expectOk(parsePairingUri(source.uri)).relays).toEqual(
      expectOk(parsePairingUri(buzz.uris[0]?.uri)).relays
    );
    expect(source.uri.split('?')[0]).toBe(buzz.uris[0]?.uri.split('?')[0]);
  });

  it("accepts buzz's offer and shows the NIP's SAS", () => {
    const source = sourceFor();
    expect(source.receive(to.offer_bad_session?.event, T0)).toEqual({ publish: [] });
    expect(source.receive(to.offer?.event, T0).notice).toEqual({ type: 'sas', sas: NIP.sasCode });
  });

  it("accepts buzz's desktop-code offer extension as a plain offer", () => {
    expect(sourceFor().receive(to.offer_desktop_code?.event, T0).notice?.type).toBe('sas');
  });

  it("reads buzz's complete and abort", () => {
    for (const [name, notice] of [
      ['complete', { type: 'complete', success: true }],
      ['complete_failed', { type: 'complete', success: false }],
      ['abort_user_denied', { type: 'aborted', reason: 'user_denied', by: 'peer' }],
      ['abort_sas_mismatch', { type: 'aborted', reason: 'sas_mismatch', by: 'peer' }],
    ] as const) {
      const source = sourceFor();
      source.receive(to.offer?.event, T0);
      if (name.startsWith('complete')) source.confirmSas(sourcePayload, T0);
      expect(source.receive(to[name]?.event, T0).notice).toEqual(notice);
    }
  });

  it('sends a transcript hash buzz computes too', () => {
    const source = sourceFor();
    source.receive(to.offer?.event, T0);
    const [sasConfirm] = source.confirmSas(sourcePayload, T0).publish;
    if (sasConfirm === undefined) throw new Error('no sas-confirm');
    expect(decryptFor(hexToBytes(NIP.targetPrivkey), sasConfirm)).toEqual(
      JSON.parse(tt.sas_confirm?.plaintext ?? '')
    );
  });

  it("verifies buzz's sas-confirm and imports its ncryptsec payload", () => {
    const target = targetFor();
    expect(target.sas).toBe(NIP.sasCode);
    expect(decryptFor(hexToBytes(NIP.sourcePrivkey), target.offer)).toEqual(
      JSON.parse(to.offer?.plaintext ?? '')
    );
    target.receive(tt.payload?.event, T0);
    expect(target.receive(tt.sas_confirm?.event, T0).notice).toEqual({ type: 'verified' });
    const step = target.confirmSas(T0);
    expect(step.notice).toEqual({
      type: 'payload',
      payload: { ncryptsec: NCRYPTSEC, logN: 16, unlockWith: 'passphrase' },
    });
    expect(bytesToHex(decodeNcryptsec(NCRYPTSEC, 'nostr'))).toBe(NCRYPTSEC_KEY);
  });

  it("refuses buzz's raw nsec and custom payloads", () => {
    for (const name of ['payload_nsec', 'payload_custom'] as const) {
      const target = targetFor();
      target.receive(tt.sas_confirm?.event, T0);
      target.confirmSas(T0);
      const step = target.receive(tt[name]?.event, T0);
      expect(step.notice?.type).toBe('refused');
      expect(step.publish).toHaveLength(1);
    }
  });

  it("aborts on buzz's bad transcript hash and reads its timeout abort", () => {
    const a = targetFor();
    expect(a.receive(tt.sas_confirm_bad?.event, T0).notice).toEqual({
      type: 'aborted',
      reason: 'sas_mismatch',
      by: 'local',
    });
    expect(targetFor().receive(tt.abort_timeout?.event, T0).notice).toEqual({
      type: 'aborted',
      reason: 'timeout',
      by: 'peer',
    });
  });
});
