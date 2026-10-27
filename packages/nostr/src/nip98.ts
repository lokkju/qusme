import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, utf8 } from '@scure/base';
import type { NostrEvent } from 'nostr-tools/core';
import { KIND_HTTP_AUTH } from './kinds.ts';
import { capture, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import { checkKind, parseJsonText, readSignedEvent, singleTag } from './validate.ts';

/** How far `created_at` may be from the server's clock, either way, in seconds (NIP-98). */
export const HTTP_AUTH_WINDOW_SECONDS = 60;

const SCHEME = 'Nostr ';
const MAX_HEADER = 16 * 1024;

export interface HttpRequestFacts {
  /** The absolute request URL, query included. */
  url: string;
  method: string;
  /** The request body; its SHA-256 goes in the `payload` tag. */
  body?: Uint8Array | string;
}

export interface HttpAuth {
  /** The authenticated pubkey. */
  pubkey: string;
  /** The event id, for the service's replay protection (spec 8.5). */
  eventId: string;
  createdAt: number;
}

const bodyBytes = (body: Uint8Array | string): Uint8Array =>
  typeof body === 'string' ? utf8ToBytes(body) : body;

/**
 * Builds a NIP-98 auth event (kind 27235) for one request: `u`, `method`, and a `payload` hash
 * when there is a non-empty body.
 */
export async function buildHttpAuth(
  signer: Signer,
  request: HttpRequestFacts,
  options: { now?: number } = {}
): Promise<NostrEvent> {
  const tags = [
    ['u', request.url],
    ['method', request.method.toUpperCase()],
  ];
  if (request.body !== undefined && bodyBytes(request.body).length > 0) {
    tags.push(['payload', bytesToHex(sha256(bodyBytes(request.body)))]);
  }
  return signer.signEvent({
    kind: KIND_HTTP_AUTH,
    created_at: options.now ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });
}

/** The `Authorization` header value for an auth event: `Nostr <base64 JSON>`. */
export function httpAuthHeader(event: NostrEvent): string {
  return SCHEME + base64.encode(utf8ToBytes(JSON.stringify(event)));
}

/**
 * Verifies an `Authorization` header against the request (NIP-98): scheme `Nostr`, a valid kind
 * 27235 signature, `created_at` within {@link HTTP_AUTH_WINDOW_SECONDS} of now, `u` exactly the
 * URL, `method` the method, and, when the request has a body or the event a `payload` tag, the
 * body's SHA-256. Replay protection is the caller's (spec 8.5).
 */
export function verifyHttpAuth(
  header: string | null | undefined,
  request: HttpRequestFacts,
  options: { now?: number; windowSeconds?: number } = {}
): ParseResult<HttpAuth> {
  return capture(() => {
    if (typeof header !== 'string' || !header.startsWith(SCHEME) || header.length > MAX_HEADER) {
      throw new Invalid('not_an_event', 'expected a Nostr authorization header');
    }
    let json: string;
    try {
      json = utf8.encode(base64.decode(header.slice(SCHEME.length).trim()));
    } catch {
      throw new Invalid('not_an_event', 'not base64');
    }
    const event = readSignedEvent(parseJsonText(json, 'header'));
    checkKind(event.kind, [KIND_HTTP_AUTH]);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const window = options.windowSeconds ?? HTTP_AUTH_WINDOW_SECONDS;
    if (Math.abs(now - event.created_at) > window) {
      throw new Invalid('stale', `created_at is more than ${window} s from now`, 'created_at');
    }
    if (singleTag(event.tags, 'u', true) !== request.url) {
      throw new Invalid('request_mismatch', 'u is not the request URL', 'tags.u');
    }
    if (singleTag(event.tags, 'method', true).toUpperCase() !== request.method.toUpperCase()) {
      throw new Invalid('request_mismatch', 'method is not the request method', 'tags.method');
    }
    const payload = singleTag(event.tags, 'payload');
    const body = request.body === undefined ? new Uint8Array() : bodyBytes(request.body);
    if (payload !== undefined || body.length > 0) {
      if (payload !== bytesToHex(sha256(body))) {
        throw new Invalid('request_mismatch', 'payload is not the body hash', 'tags.payload');
      }
    }
    return { pubkey: event.pubkey, eventId: event.id, createdAt: event.created_at };
  });
}
