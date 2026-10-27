import { base64 } from '@scure/base';
import { getToken, validateToken } from 'nostr-tools/nip98';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildHttpAuth,
  httpAuthHeader,
  KIND_HTTP_AUTH,
  type NostrEvent,
  verifyHttpAuth,
} from '../src/index.ts';
import { expectError, expectOk, NOW, queue, queueKey, queuePubkey, sign } from './helpers.ts';

const URL_ = 'https://app.qus.me/pair?x=1';
const BODY = JSON.stringify({ uri: 'nostrpair://example' });
const request = { url: URL_, method: 'POST', body: BODY };

describe('NIP-98 HTTP auth', () => {
  it('builds and verifies a request with a body', async () => {
    const event = await buildHttpAuth(queue, request, { now: NOW });
    expect(event.kind).toBe(KIND_HTTP_AUTH);
    expect(event.tags.map((t) => t[0])).toEqual(['u', 'method', 'payload']);
    expect(verifyEvent({ ...event })).toBe(true);
    expect(expectOk(verifyHttpAuth(httpAuthHeader(event), request, { now: NOW + 30 }))).toEqual({
      pubkey: queuePubkey,
      eventId: event.id,
      createdAt: NOW,
    });
  });

  it('builds a GET without a payload tag', async () => {
    const event = await buildHttpAuth(queue, { url: URL_, method: 'get' }, { now: NOW });
    expect(event.tags).toEqual([
      ['u', URL_],
      ['method', 'GET'],
    ]);
    expectOk(verifyHttpAuth(httpAuthHeader(event), { url: URL_, method: 'GET' }, { now: NOW }));
  });

  it('interoperates with nostr-tools in both directions', async () => {
    const ours = await buildHttpAuth(queue, request);
    expect(await validateToken(httpAuthHeader(ours), URL_, 'POST')).toBe(true);
    const theirs = await getToken(URL_, 'post', (e) => sign(e, queueKey), true, JSON.parse(BODY));
    expectOk(verifyHttpAuth(theirs, request));
  });

  it('rejects stale events, other URLs, methods and bodies', async () => {
    const header = httpAuthHeader(await buildHttpAuth(queue, request, { now: NOW }));
    expectError(verifyHttpAuth(header, request, { now: NOW + 61 }), 'stale');
    expectError(verifyHttpAuth(header, request, { now: NOW - 61 }), 'stale');
    expectError(
      verifyHttpAuth(header, { ...request, url: 'https://app.qus.me/pair' }, { now: NOW }),
      'request_mismatch'
    );
    expectError(
      verifyHttpAuth(header, { ...request, method: 'PUT' }, { now: NOW }),
      'request_mismatch'
    );
    expectError(
      verifyHttpAuth(header, { ...request, body: `${BODY} ` }, { now: NOW }),
      'request_mismatch'
    );
    expectError(
      verifyHttpAuth(header, { url: URL_, method: 'POST' }, { now: NOW }),
      'request_mismatch'
    );
    const noPayload = httpAuthHeader(
      await buildHttpAuth(queue, { url: URL_, method: 'POST' }, { now: NOW })
    );
    expectError(verifyHttpAuth(noPayload, request, { now: NOW }), 'request_mismatch');
  });

  it('rejects malformed headers, bad signatures and the wrong kind', async () => {
    const event = await buildHttpAuth(queue, request, { now: NOW });
    const encode = (value: unknown) =>
      `Nostr ${base64.encode(new TextEncoder().encode(JSON.stringify(value)))}`;
    for (const header of [
      undefined,
      null,
      '',
      'Bearer abc',
      'Nostr !!!',
      `Nostr ${'A'.repeat(20_000)}`,
      encode('x'),
    ]) {
      expectError(verifyHttpAuth(header, request, { now: NOW }), 'not_an_event');
    }
    expectError(
      verifyHttpAuth(encode({ ...event, created_at: NOW + 1 } as NostrEvent), request, {
        now: NOW,
      }),
      'bad_signature'
    );
    const note = sign({ kind: 1, created_at: NOW, tags: event.tags, content: '' });
    expectError(verifyHttpAuth(httpAuthHeader(note), request, { now: NOW }), 'wrong_kind');
  });
});
