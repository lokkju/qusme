import type { NostrEvent } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';
import { Invalid, type ParseErrorCode } from './result.ts';
import type { Signer } from './signer.ts';

/** A JSON value as decrypted content holds it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_JSON_DEPTH = 32;
// A ws or wss URL with a host and no whitespace; the package's src has no URL global to lean on.
const RELAY_URL = /^wss?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/;
// Keys that could reach an object's prototype when a consumer later merges or assigns the value
// (spec 10.2 merges overrides). Decrypted content containing them is refused outright.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

/** A plain object (not an array, not a class instance). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function readRecord(
  value: unknown,
  path: string,
  code: ParseErrorCode = 'invalid_content'
): Record<string, unknown> {
  if (!isRecord(value)) throw new Invalid(code, 'expected an object', path || undefined);
  return value;
}

/** Refuses keys outside `required` and `optional`, and any missing required key. */
export function checkKeys(
  record: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  for (const key of required) {
    if (!Object.hasOwn(record, key))
      throw new Invalid('invalid_content', 'missing', join(path, key));
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Invalid('invalid_content', 'unknown key', join(path, key));
    }
  }
}

export { join as joinPath };

export function readString(
  value: unknown,
  path: string,
  options: { nonEmpty?: boolean; max?: number } = {}
): string {
  if (typeof value !== 'string') throw new Invalid('invalid_content', 'expected a string', path);
  if (options.nonEmpty && value.length === 0) {
    throw new Invalid('invalid_content', 'must not be empty', path);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new Invalid('invalid_content', `longer than ${options.max}`, path);
  }
  return value;
}

export function readInteger(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {}
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Invalid('invalid_content', 'expected an integer', path);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Invalid('invalid_content', `below ${options.min}`, path);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Invalid('invalid_content', `above ${options.max}`, path);
  }
  return value;
}

export function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Invalid('invalid_content', 'expected a boolean', path);
  return value;
}

export function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Invalid('invalid_content', 'expected an array', path);
  return value;
}

export function readOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Invalid('invalid_content', `expected one of ${allowed.join(', ')}`, path);
  }
  return value as T;
}

export const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && HEX64.test(value);

/** A lowercase hex pubkey or event id. */
export function readHex64(
  value: unknown,
  path: string,
  code: ParseErrorCode = 'invalid_content'
): string {
  if (!isHex64(value)) throw new Invalid(code, 'expected 64 lowercase hex characters', path);
  return value;
}

/** A `wss://` or `ws://` relay URL. */
export function readRelayUrl(value: unknown, path: string): string {
  const text = readString(value, path, { nonEmpty: true, max: 2048 });
  if (!RELAY_URL.test(text))
    throw new Invalid('invalid_content', 'expected a wss:// or ws:// URL', path);
  return text;
}

/** Checks a parsed JSON value for forbidden keys and excessive depth. */
function checkJson(value: unknown, path: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw new Invalid('invalid_content', 'nested too deeply', path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      checkJson(item, join(path, i), depth + 1);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key))
        throw new Invalid('invalid_content', 'forbidden key', join(path, key));
      checkJson((value as Record<string, unknown>)[key], join(path, key), depth + 1);
    }
  }
}

/**
 * Parses untrusted JSON text: refuses `__proto__`, `constructor` and `prototype` keys anywhere and
 * nesting deeper than 32 levels.
 */
export function parseJsonText(text: string, path = 'content'): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Invalid('invalid_json', 'not JSON', path);
  }
  checkJson(value, path, 0);
  return value as JsonValue;
}

/** A JSON object from untrusted input, checked as {@link parseJsonText} checks text. */
export function readJsonObject(value: unknown, path: string): JsonObject {
  readRecord(value, path);
  checkJson(value, path, 0);
  return value as JsonObject;
}

/** Tags: an array of non-empty arrays of strings. */
export function readTags(value: unknown, path = 'tags'): string[][] {
  if (!Array.isArray(value)) throw new Invalid('not_an_event', 'expected an array', path);
  return value.map((tag, i) => {
    if (!Array.isArray(tag) || tag.length === 0 || !tag.every((item) => typeof item === 'string')) {
      throw new Invalid('not_an_event', 'expected a non-empty array of strings', join(path, i));
    }
    return [...tag] as string[];
  });
}

/**
 * Reads and verifies a signed event from untrusted input. Only the NIP-01 fields are copied, so
 * a cached verification mark on the input can't vouch for it.
 */
export function readSignedEvent(value: unknown): NostrEvent {
  const record = readRecord(value, '', 'not_an_event');
  const { id, pubkey, sig, kind, created_at, content } = record;
  if (!isHex64(id)) throw new Invalid('not_an_event', 'bad id', 'id');
  if (!isHex64(pubkey)) throw new Invalid('not_an_event', 'bad pubkey', 'pubkey');
  if (typeof sig !== 'string' || !HEX128.test(sig))
    throw new Invalid('not_an_event', 'bad sig', 'sig');
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 65535) {
    throw new Invalid('not_an_event', 'bad kind', 'kind');
  }
  if (typeof created_at !== 'number' || !Number.isSafeInteger(created_at) || created_at < 0) {
    throw new Invalid('not_an_event', 'bad created_at', 'created_at');
  }
  if (typeof content !== 'string') throw new Invalid('not_an_event', 'bad content', 'content');
  const event: NostrEvent = {
    id,
    pubkey,
    sig,
    kind,
    created_at,
    content,
    tags: readTags(record.tags),
  };
  if (!verifyEvent(event)) throw new Invalid('bad_signature', 'id or signature does not verify');
  return event;
}

export function checkKind(kind: number, accepted: readonly number[]): void {
  if (!accepted.includes(kind)) {
    throw new Invalid('wrong_kind', `kind ${kind} is not ${accepted.join(' or ')}`, 'kind');
  }
}

/** The value of a tag that must appear at most once with exactly one value. */
export function singleTag(tags: string[][], name: string, required: true): string;
export function singleTag(tags: string[][], name: string, required?: false): string | undefined;
export function singleTag(tags: string[][], name: string, required = false): string | undefined {
  const found = tags.filter((tag) => tag[0] === name);
  if (found.length === 0) {
    if (required) throw new Invalid('invalid_tags', 'missing', `tags.${name}`);
    return undefined;
  }
  if (found.length > 1) throw new Invalid('invalid_tags', 'repeated', `tags.${name}`);
  const tag = found[0] as string[];
  if (tag.length !== 2) throw new Invalid('invalid_tags', 'expected one value', `tags.${name}`);
  return tag[1] as string;
}

/** Decrypts with the signer, turning any failure into `decrypt_failed`. */
export async function decryptWith(signer: Signer, peer: string, payload: string): Promise<string> {
  try {
    return await signer.nip44Decrypt(peer, payload);
  } catch {
    throw new Invalid('decrypt_failed', 'content does not decrypt', 'content');
  }
}
