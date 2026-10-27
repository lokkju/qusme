import { readFile } from 'node:fs/promises';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  createLocalSigner,
  nip44ConversationKey,
  nip44Decrypt,
  nip44DecryptFromSelf,
  nip44DecryptWithKey,
  nip44Encrypt,
  nip44EncryptToSelf,
  nip44EncryptWithKey,
} from '../src/index.ts';
import vectors from './vectors/nip44.vectors.json' with { type: 'json' };

// From https://github.com/paulmillr/nip44 (nip44.vectors.json); NIP-44 publishes this checksum.
const VECTORS_SHA256 = '269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040';
const { valid, invalid } = vectors.v2;

it('uses the vectors file NIP-44 publishes the checksum of', async () => {
  const file = await readFile(new URL('./vectors/nip44.vectors.json', import.meta.url));
  expect(bytesToHex(sha256(file))).toBe(VECTORS_SHA256);
});

describe('NIP-44 v2 official vectors', () => {
  it.each(valid.get_conversation_key)('conversation key $conversation_key', (v) => {
    expect(bytesToHex(nip44ConversationKey(hexToBytes(v.sec1), v.pub2))).toBe(v.conversation_key);
  });

  it.each(valid.encrypt_decrypt)('encrypts and decrypts $plaintext', (v) => {
    const sec1 = hexToBytes(v.sec1);
    const sec2 = hexToBytes(v.sec2);
    const pub1 = getPublicKey(sec1);
    const pub2 = getPublicKey(sec2);
    const ck = nip44ConversationKey(sec1, pub2);
    expect(bytesToHex(ck)).toBe(v.conversation_key);
    const payload = nip44EncryptWithKey(ck, v.plaintext, hexToBytes(v.nonce));
    expect(payload).toBe(v.payload);
    expect(bytesToHex(nip44ConversationKey(sec2, pub1))).toBe(v.conversation_key);
    expect(nip44Decrypt(sec2, pub1, payload)).toBe(v.plaintext);
  });

  it.each(valid.encrypt_decrypt_long_msg)('long message of $repeat x $pattern', (v) => {
    const plaintext = v.pattern.repeat(v.repeat);
    expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(v.plaintext_sha256);
    const ck = hexToBytes(v.conversation_key);
    const payload = nip44EncryptWithKey(ck, plaintext, hexToBytes(v.nonce));
    expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(v.payload_sha256);
    expect(nip44DecryptWithKey(ck, payload)).toBe(plaintext);
  });

  // The vectors file lists 65536, 100000 and 10000000 as invalid lengths too; NIP-44's extended
  // length prefix (the table below) made those valid since, so only the empty message still is.
  it('refuses to encrypt an empty message', () => {
    expect(invalid.encrypt_msg_lengths).toContain(0);
    expect(() => nip44EncryptWithKey(new Uint8Array(32).fill(1), '')).toThrow();
  });

  // "Extended length prefix test vectors" in the NIP-44 text.
  it.each([
    [
      65535,
      '6e1bebca6a8229364a162a72ef064826c4cd7457bf54f190ef782bd9deff3e42',
      '6d8c2810d1e870fbaa1f0a0937126cca837a15f9260e27060c331d70a3c0bc84',
    ],
    [
      65536,
      'bf718b6f653bebc184e1479f1935b8da974d701b893afcf49e701f3e2f9f9c5a',
      'b7b4edb36ba92e267d322d56d9aebc22e7fa96ff52e3c12adc07f07a43cbc616',
    ],
    [
      65537,
      '008ffc88d3c96a9f307524eb361e47c5222a887fc45fa0c1fb8d429c5c23b430',
      'eeb7c7c5373894ea2c1547cfd3ccb15d5a0b2d619da852e5c79df792dcc9e435',
    ],
  ])('extended length prefix at %i bytes', (length, plaintextSha256, payloadSha256) => {
    const ck = hexToBytes('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d');
    const nonce = hexToBytes('0000000000000000000000000000000000000000000000000000000000000001');
    const plaintext = 'a'.repeat(length);
    expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(plaintextSha256);
    const payload = nip44EncryptWithKey(ck, plaintext, nonce);
    expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(payloadSha256);
    expect(nip44DecryptWithKey(ck, payload)).toBe(plaintext);
  });

  it.each(invalid.get_conversation_key)('refuses a conversation key: $note', (v) => {
    expect(() => nip44ConversationKey(hexToBytes(v.sec1), v.pub2)).toThrow();
  });

  it.each(invalid.decrypt)('refuses to decrypt: $note', (v) => {
    expect(() => nip44DecryptWithKey(hexToBytes(v.conversation_key), v.payload)).toThrow();
  });
});

describe('NIP-44 between keys', () => {
  const alice = hexToBytes('0000000000000000000000000000000000000000000000000000000000000001');
  const bob = hexToBytes('0000000000000000000000000000000000000000000000000000000000000002');

  it('encrypts to a pubkey and decrypts from it', () => {
    const payload = nip44Encrypt(alice, getPublicKey(bob), 'hello bob');
    expect(nip44Decrypt(bob, getPublicKey(alice), payload)).toBe('hello bob');
  });

  it('uses a fresh nonce each time', () => {
    const a = nip44Encrypt(alice, getPublicKey(bob), 'same');
    const b = nip44Encrypt(alice, getPublicKey(bob), 'same');
    expect(a).not.toBe(b);
  });

  it('encrypts to self through a signer', async () => {
    const signer = createLocalSigner(alice);
    const payload = await nip44EncryptToSelf(signer, '{"destinations":[]}');
    expect(await nip44DecryptFromSelf(signer, payload)).toBe('{"destinations":[]}');
    // The same payload is what the raw-key helpers make for the key's own pubkey.
    expect(nip44Decrypt(alice, getPublicKey(alice), payload)).toBe('{"destinations":[]}');
  });

  it('a local signer interoperates with the raw-key helpers', async () => {
    const signer = createLocalSigner(alice);
    const payload = await signer.nip44Encrypt(getPublicKey(bob), 'via signer');
    expect(nip44Decrypt(bob, getPublicKey(alice), payload)).toBe('via signer');
    const reply = nip44Encrypt(bob, getPublicKey(alice), 'reply');
    expect(await signer.nip44Decrypt(getPublicKey(bob), reply)).toBe('reply');
  });

  it('a local signer signs events with its key', async () => {
    const signer = createLocalSigner(alice);
    const event = await signer.signEvent({ kind: 1, tags: [], content: 'x', created_at: 1 });
    expect(event.pubkey).toBe(await signer.getPublicKey());
    expect(event.pubkey).toBe(getPublicKey(alice));
  });

  it('a local signer refuses a key of the wrong length', () => {
    expect(() => createLocalSigner(new Uint8Array(31))).toThrow();
  });
});
