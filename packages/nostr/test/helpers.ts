import { hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { expect } from 'vitest';
import {
  createLocalSigner,
  type EventTemplate,
  type FieldValue,
  type NostrEvent,
  type ParseErrorCode,
  type ParseResult,
} from '../src/index.ts';

export const queueKey = hexToBytes(
  'e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45'
);
export const agentKey = hexToBytes(
  '0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273'
);
export const otherKey = hexToBytes(
  '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a'
);
export const queue = createLocalSigner(queueKey);
export const agent = createLocalSigner(agentKey);
export const other = createLocalSigner(otherKey);
export const queuePubkey = getPublicKey(queueKey);
export const agentPubkey = getPublicKey(agentKey);
export const otherPubkey = getPublicKey(otherKey);

export const NOW = 1_761_400_000;
export const DAY = 24 * 60 * 60;

/** Asserts success and returns the value. */
export function expectOk<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Asserts failure with `code`. */
export function expectError<T>(result: ParseResult<T>, code: ParseErrorCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

/** Signs a template with a raw key, for building events the package's builders refuse to. */
export function sign(template: EventTemplate, key: Uint8Array = queueKey): NostrEvent {
  return finalizeEvent(template, key);
}

/** A copy of a signed event with one field changed and the signature left stale. */
export function tamper(event: NostrEvent, change: Partial<NostrEvent>): NostrEvent {
  return { ...event, ...change };
}

export const WRAP_ID = 'a'.repeat(64);

// The 7.1 example rumor with every tag.
export const exampleValue: FieldValue = {
  createdAt: 1_761_400_000,
  site: 'x',
  account: 'lokkju',
  field: 'text',
  destination: '01JABCDEF',
  status: 'archived:inserted',
  source: { wrapId: WRAP_ID, submitter: agentPubkey },
  inserted: [
    {
      at: 1_761_400_100,
      url: 'https://x.com/home',
      strategy: 'paste',
      method: 'popup',
      accessibleName: 'Post text',
      detectedAccount: 'lokkju',
    },
    {
      at: 1_761_400_200,
      url: '',
      strategy: '',
      method: 'pwa_copy',
      accessibleName: '',
      detectedAccount: '',
    },
  ],
  validation: { counter: 'twitter-text', length: 12, ok: true },
  content: 'hello, world',
  reserved: [],
};
