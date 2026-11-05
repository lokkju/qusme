/**
 * Writes events and URIs made by this package's NIP-AB code, with the NIP's test vector keys, as
 * JSON for `nip-ab-buzz check` (see nip-ab-buzz/Cargo.toml), which parses them with block/buzz.
 *   node scripts/nip-ab-buzz-events.ts > /tmp/nip-ab-events.json
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { encodeNcryptsec, PairingSource, PairingTarget, parsePairingUri } from '../src/index.ts';

const SOURCE = '7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5';
const TARGET = '3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b';
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const relays = ['wss://nos.lol', 'wss://relay.ditto.pub/', 'ws://localhost:7777/p?x=1&y=2#f'];
const queueKey = new Uint8Array(32).fill(7);
const queuePubkey = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f';
const ncryptsec = encodeNcryptsec(queueKey, 'pass', { logN: 16 });
const payload = { passphraseCopy: ncryptsec, relays, queuePubkey };

function session() {
  const source = new PairingSource(relays, {
    secretKey: hexToBytes(SOURCE),
    sessionSecret: hexToBytes(SECRET),
  });
  const parsed = parsePairingUri(source.uri);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const target = new PairingTarget(parsed.value, 'qr', { secretKey: hexToBytes(TARGET) });
  source.receive(target.offer);
  return { source, target };
}

const out: unknown[] = [];
const toSource = (name: string, event: unknown) =>
  out.push({ name, recipient_privkey: SOURCE, event });
const toTarget = (name: string, event: unknown) =>
  out.push({ name, recipient_privkey: TARGET, event });

const a = session();
out.push({ name: 'uri', uri: a.source.uri });
toSource('offer', a.target.offer);
a.target.confirmSas();
const [sasConfirm, payloadEvent] = a.source.confirmSas(payload).publish;
toTarget('sas-confirm', sasConfirm);
toTarget('payload', payloadEvent);
a.target.receive(sasConfirm);
a.target.receive(payloadEvent);
toSource('complete', a.target.stored(true).publish[0]);

const b = session();
toTarget('abort user_denied', b.source.deny().publish[0]);
const c = session();
c.target.confirmSas();
for (const event of c.source.confirmSas(payload).publish) c.target.receive(event);
toSource('complete false', c.target.stored(false).publish[0]);

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
