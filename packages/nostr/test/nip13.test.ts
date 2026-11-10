import { getEventHash, getPublicKey, serializeEvent, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildSubmission,
  KIND_FIELD_VALUE,
  minePow,
  NIP59_TIMESTAMP_JITTER,
  openSubmission,
  PowBudgetExceeded,
  powOf,
} from '../src/index.ts';
import { agent, agentPubkey, expectOk, NOW, otherKey, queue, queuePubkey } from './helpers.ts';

describe('NIP-13 proof of work', () => {
  it('counts leading zero bits', () => {
    expect(powOf('f'.repeat(64))).toBe(0);
    expect(powOf(`0${'f'.repeat(63)}`)).toBe(4);
    expect(powOf(`01${'0'.repeat(62)}`)).toBe(7);
    expect(powOf(`002f${'0'.repeat(60)}`)).toBe(10);
    expect(powOf('0'.repeat(64))).toBe(256);
  });

  it('mines a nonce tag and keeps created_at', () => {
    const event = {
      kind: KIND_FIELD_VALUE,
      created_at: 1_000,
      tags: [['site', 'x']],
      content: 'hello',
      pubkey: getPublicKey(otherKey),
    };
    const mined = minePow(event, 10);
    expect(mined.created_at).toBe(1_000);
    expect(mined.tags[0]).toEqual(['site', 'x']);
    expect(mined.tags[1]?.[0]).toBe('nonce');
    expect(mined.tags[1]?.[2]).toBe('10');
    expect(powOf(getEventHash(mined))).toBeGreaterThanOrEqual(10);
    expect(event.tags).toHaveLength(1);
    expect(() => minePow(event, 257)).toThrow();
  });

  it('refuses before hashing when the expected work alone exceeds the budget', () => {
    const event = {
      kind: KIND_FIELD_VALUE,
      created_at: 1_000,
      tags: [],
      content: 'x'.repeat(1_000),
      pubkey: getPublicKey(otherKey),
    };
    const error = (() => {
      try {
        minePow(event, 10, { maxBytes: 1_000 * 1_024 });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(PowBudgetExceeded);
    expect(error).toMatchObject({ difficulty: 10, maxBytes: 1_024_000, hashes: 0 });
    expect((error as PowBudgetExceeded).eventBytes).toBeGreaterThan(1_000);
  });

  it('stops hashing at the budget and succeeds with one more attempt', () => {
    // Mining is deterministic for a fixed event, so find one whose nonce lies past 2^4 attempts,
    // which the up-front check allows, then give the budget one attempt fewer than it needs.
    const base = {
      kind: KIND_FIELD_VALUE,
      created_at: 1_000,
      tags: [],
      pubkey: getPublicKey(otherKey),
    };
    for (let i = 0; ; i++) {
      const event = { ...base, content: `value ${i}` };
      const mined = minePow(event, 4);
      const nonce = Number(mined.tags[0]?.[1]);
      if (nonce <= 16) continue;
      const bytes = new TextEncoder().encode(
        serializeEvent({ ...event, tags: [['nonce', '0', '4']] })
      ).length;
      expect(() => minePow(event, 4, { maxBytes: nonce * bytes })).toThrow(PowBudgetExceeded);
      try {
        minePow(event, 4, { maxBytes: nonce * bytes });
      } catch (e) {
        expect(e).toMatchObject({ hashes: nonce, eventBytes: bytes });
      }
      expect(minePow(event, 4, { maxBytes: (nonce + 1) * bytes }).tags[0]?.[1]).toBe(String(nonce));
      break;
    }
  });

  it('puts the work on a submission gift wrap, which still opens', async () => {
    const value = { site: 'x', account: 'lokkju', field: 'text', content: 'hi' };
    const wrap = await buildSubmission(agent, queuePubkey, value, { now: NOW, pow: 12 });
    expect(verifyEvent({ ...wrap })).toBe(true);
    expect(powOf(wrap.id)).toBeGreaterThanOrEqual(12);
    expect(wrap.tags.find((t) => t[0] === 'nonce')?.[2]).toBe('12');
    expect(wrap.created_at).toBeLessThanOrEqual(NOW);
    expect(wrap.created_at).toBeGreaterThanOrEqual(NOW - NIP59_TIMESTAMP_JITTER);
    const opened = expectOk(await openSubmission(wrap, queue));
    expect(opened.submitter).toBe(agentPubkey);
    expect(opened.value.content).toBe('hi');
  });
});
