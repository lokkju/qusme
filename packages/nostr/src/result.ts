/**
 * What a parser returns. Parsers never throw on untrusted input: a malformed, mis-signed or
 * undecryptable event comes back as `{ ok: false, error }`. They throw only on programmer errors,
 * such as a builder handed an invalid value.
 */

export type ParseErrorCode =
  /** Not an event: missing or mistyped fields, or not an object. */
  | 'not_an_event'
  /** The id or signature does not verify. */
  | 'bad_signature'
  /** The kind is not one this parser accepts (current or former number). */
  | 'wrong_kind'
  /** Signed by a key other than the expected one. */
  | 'wrong_author'
  /** A required tag is missing, repeated, malformed or unknown. */
  | 'invalid_tags'
  /** NIP-44 decryption failed, or the signer refused. */
  | 'decrypt_failed'
  /** Content that should be JSON is not. */
  | 'invalid_json'
  /** Content parsed but does not have the required shape or values. */
  | 'invalid_content'
  /** A gift wrap or seal failed NIP-59 checks. */
  | 'unwrap_failed'
  /** NIP-98: the event is outside the time window. */
  | 'stale'
  /** NIP-98: the `u`, `method` or `payload` tag does not match the request. */
  | 'request_mismatch';

export interface ParseError {
  readonly code: ParseErrorCode;
  readonly message: string;
  /** Where in the event or content the problem is, such as `tags.status` or `destinations[2].id`. */
  readonly path?: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ParseError };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });

/** Thrown inside parsers and turned into a {@link ParseError} at the parser's boundary. */
export class Invalid extends Error {
  readonly code: ParseErrorCode;
  readonly path: string | undefined;
  constructor(code: ParseErrorCode, message: string, path?: string) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.code = code;
    this.path = path;
  }
}

/** Runs a parse step and turns an {@link Invalid} into a failed result; rethrows anything else. */
export function capture<T>(parse: () => T): ParseResult<T> {
  try {
    return ok(parse());
  } catch (error) {
    if (error instanceof Invalid) return failure(error);
    throw error;
  }
}

/** {@link capture} for async parse steps. */
export async function captureAsync<T>(parse: () => Promise<T>): Promise<ParseResult<T>> {
  try {
    return ok(await parse());
  } catch (error) {
    if (error instanceof Invalid) return failure(error);
    throw error;
  }
}

function failure<T>(error: Invalid): ParseResult<T> {
  const parsed: ParseError =
    error.path === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, path: error.path };
  return { ok: false, error: parsed };
}

/**
 * Runs a validator over a builder's input. A failure there is the caller's bug, so it throws a
 * plain Error instead of returning a result.
 */
export function checkInput<T>(what: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof Invalid) throw new Error(`invalid ${what}: ${error.message}`);
    throw error;
  }
}
