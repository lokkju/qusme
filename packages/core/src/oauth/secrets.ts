/**
 * Random secrets, PKCE and the short user code. Web Crypto only, so it runs on Workers and Node.
 */

const encoder = new TextEncoder();

/** Unpadded base64url of `bytes`. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` random bytes as unpadded base64url. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Compares two strings in time that depends only on their lengths, for secrets and values derived
 * from them (PKCE challenges). A length difference returns false at once; lengths are not secret
 * here, since every compared value has a fixed, public length.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** RFC 7636 4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is base64url of a SHA-256 digest: exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function isCodeVerifier(value: string): boolean {
  return VERIFIER.test(value);
}

export function isS256Challenge(value: string): boolean {
  return CHALLENGE.test(value);
}

/** BASE64URL(SHA256(ASCII(code_verifier))), RFC 7636 4.2. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** True when `verifier` is well formed and hashes to `challenge` (PKCE S256 only). */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!isCodeVerifier(verifier)) return false;
  return timingSafeEqual(await s256(verifier), challenge);
}

/** Crockford base32, without I, L, O and U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const USER_CODE_LENGTH = 8;

/**
 * A short code for the authorize page (spec 8.2 step 2): 8 Crockford base32 characters (40 bits),
 * shown as `XXXX-XXXX`. Stored without the hyphen.
 */
export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH));
  let code = '';
  // 256 is a multiple of 32, so taking each byte mod 32 is unbiased.
  for (const b of bytes) code += CROCKFORD[b % 32];
  return code;
}

/** `ABCD1234` as `ABCD-1234`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Normalizes a code as a person typed it: case, hyphens and spaces ignored, and Crockford's
 * confusable letters read as digits (I and L as 1, O as 0). Undefined if it cannot be a code.
 */
export function normalizeUserCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (code.length !== USER_CODE_LENGTH) return undefined;
  for (const ch of code) if (!CROCKFORD.includes(ch)) return undefined;
  return code;
}
