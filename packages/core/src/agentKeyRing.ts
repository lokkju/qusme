/**
 * The service secret that encrypts agent secret keys at rest (spec 6.2), and the encryption
 * itself. Web Crypto only, so it runs unchanged on Workers and Node.
 *
 * Scheme, per agent key:
 *
 *   binding = "qus.me/agent-key/v1" || 0x00 || u32be(key_version) || pubkey (32 bytes)
 *   kek     = HKDF-SHA256(ikm = service secret of key_version, salt = empty, info = binding)
 *   aad     = binding || utf8(agent key id)
 *   nonce   = 12 random bytes
 *   stored  = 0x01 || nonce || AES-256-GCM(kek, nonce, aad, secret key)   (61 bytes)
 *
 * The key version and the pubkey select the key and are authenticated, and the row id is
 * authenticated too, so a ciphertext moved to another row, another pubkey or another version does
 * not decrypt. Decryption also checks that the secret key's pubkey is the row's.
 */
import { getPublicKey } from 'nostr-tools/pure';

/** The environment variables an entrypoint reads the ring from. */
export const AGENT_KEY_ENV = {
  secret: 'QUSME_AGENT_KEY_SECRET',
  version: 'QUSME_AGENT_KEY_VERSION',
  previous: 'QUSME_AGENT_KEY_SECRET_PREVIOUS',
} as const;

export interface AgentKeySecrets {
  /** The current service secret: standard base64 of 32 bytes. */
  secret: string;
  /** The current secret's version, an integer from 1. Defaults to 1. */
  version?: number;
  /** The secret of version `version - 1`, present only while a rotation is under way. */
  previous?: string;
}

/**
 * The service secrets by version. The raw bytes stay in a closure and are never exposed; each is
 * imported once as a non-extractable HKDF key.
 */
export interface AgentKeyRing {
  /** The version new and re-encrypted agent keys are encrypted under. */
  readonly currentVersion: number;
  /** True while the previous version's secret is configured, so a rotation can run. */
  readonly rotating: boolean;
  /** True if this ring can decrypt keys under `version`. */
  has(version: number): boolean;
  /** The HKDF key for `version`; throws `unknown_version` if the ring lacks it. */
  hkdfKey(version: number): Promise<CryptoKey>;
}

export type AgentKeyErrorCode =
  | 'invalid_secret'
  | 'not_found'
  | 'revoked'
  | 'unknown_version'
  | 'undecryptable'
  | 'closed';

/** Every custody failure. Messages name the agent key id at most, never key material. */
export class AgentKeyError extends Error {
  readonly code: AgentKeyErrorCode;
  constructor(code: AgentKeyErrorCode, message: string) {
    super(message);
    this.name = 'AgentKeyError';
    this.code = code;
  }
}

const CONTEXT = new TextEncoder().encode('qus.me/agent-key/v1');
const FORMAT = 1;
const NONCE_BYTES = 12;
const SECRET_KEY_BYTES = 32;
const TAG_BYTES = 16;
/** Length of a stored ciphertext: format byte, nonce, encrypted 32-byte key, GCM tag. */
export const SEALED_AGENT_KEY_BYTES = 1 + NONCE_BYTES + SECRET_KEY_BYTES + TAG_BYTES;

const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

function decodeSecret(value: string, name: string): Uint8Array<ArrayBuffer> {
  const trimmed = value.trim();
  if (!BASE64_32.test(trimmed)) {
    throw new AgentKeyError('invalid_secret', `${name} must be standard base64 of 32 bytes`);
  }
  return Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function createAgentKeyRing(secrets: AgentKeySecrets): AgentKeyRing {
  const version = secrets.version ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > 0xffffffff) {
    throw new AgentKeyError('invalid_secret', `${AGENT_KEY_ENV.version} must be an integer from 1`);
  }
  const raw = new Map<number, Uint8Array<ArrayBuffer>>([
    [version, decodeSecret(secrets.secret, AGENT_KEY_ENV.secret)],
  ]);
  if (secrets.previous !== undefined) {
    if (version < 2) {
      throw new AgentKeyError(
        'invalid_secret',
        `${AGENT_KEY_ENV.previous} needs ${AGENT_KEY_ENV.version} of 2 or more`
      );
    }
    const previous = decodeSecret(secrets.previous, AGENT_KEY_ENV.previous);
    if (sameBytes(previous, raw.get(version) as Uint8Array)) {
      throw new AgentKeyError(
        'invalid_secret',
        `${AGENT_KEY_ENV.previous} equals ${AGENT_KEY_ENV.secret}`
      );
    }
    raw.set(version - 1, previous);
  }
  const imported = new Map<number, Promise<CryptoKey>>();
  return {
    currentVersion: version,
    rotating: raw.size > 1,
    has: (v) => raw.has(v),
    hkdfKey(v) {
      let key = imported.get(v);
      if (key === undefined) {
        const bytes = raw.get(v);
        if (bytes === undefined) {
          return Promise.reject(
            new AgentKeyError('unknown_version', `no service secret for key version ${v}`)
          );
        }
        key = crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
        imported.set(v, key);
      }
      return key;
    },
  };
}

/**
 * Reads the ring from an environment (Node's `process.env` or a Worker's `env`). Throws if the
 * secret is missing or malformed, so an entrypoint refuses to start without a usable one.
 */
export function agentKeyRingFromEnv(env: Record<string, unknown>): AgentKeyRing {
  const secret = env[AGENT_KEY_ENV.secret];
  if (typeof secret !== 'string' || secret === '') {
    throw new AgentKeyError('invalid_secret', `${AGENT_KEY_ENV.secret} is not set`);
  }
  const versionText = env[AGENT_KEY_ENV.version];
  let version: number | undefined;
  if (typeof versionText === 'string' && versionText !== '') {
    if (!/^[1-9][0-9]*$/.test(versionText)) {
      throw new AgentKeyError(
        'invalid_secret',
        `${AGENT_KEY_ENV.version} must be an integer from 1`
      );
    }
    version = Number(versionText);
  }
  const previous = env[AGENT_KEY_ENV.previous];
  return createAgentKeyRing({
    secret,
    version,
    previous: typeof previous === 'string' && previous !== '' ? previous : undefined,
  });
}

/** What a ciphertext is bound to: the agent key's row id and pubkey. */
export interface AgentKeyBinding {
  id: string;
  pubkey: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new AgentKeyError('undecryptable', 'agent pubkey is not 32 bytes of lowercase hex');
  }
  return Uint8Array.from({ length: 32 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  );
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function bindingBytes(version: number, pubkey: string): Uint8Array<ArrayBuffer> {
  const v = new Uint8Array(4);
  new DataView(v.buffer).setUint32(0, version);
  return concat(CONTEXT, new Uint8Array([0]), v, hexToBytes(pubkey));
}

async function kekFor(
  ring: AgentKeyRing,
  version: number,
  info: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    await ring.hkdfKey(version),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypts an agent secret key under `version` (the ring's current one by default). */
export async function sealAgentSecret(
  ring: AgentKeyRing,
  binding: AgentKeyBinding,
  secretKey: Uint8Array,
  version = ring.currentVersion
): Promise<Uint8Array> {
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new AgentKeyError('undecryptable', 'agent secret key must be 32 bytes');
  }
  const info = bindingBytes(version, binding.pubkey);
  const aad = concat(info, new TextEncoder().encode(binding.id));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = concat(secretKey);
  try {
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      await kekFor(ring, version, info),
      plaintext
    );
    return concat(new Uint8Array([FORMAT]), nonce, new Uint8Array(sealed));
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Decrypts a stored agent secret key. The caller owns the returned bytes and must zero them when
 * done; custody does this in `withAgentKey`. Every failure is `undecryptable` or
 * `unknown_version`, with no detail from the cipher.
 */
export async function openAgentSecret(
  ring: AgentKeyRing,
  binding: AgentKeyBinding,
  version: number,
  sealed: Uint8Array
): Promise<Uint8Array> {
  const fail = () => new AgentKeyError('undecryptable', `agent key ${binding.id} does not decrypt`);
  if (sealed.length !== SEALED_AGENT_KEY_BYTES || sealed[0] !== FORMAT) throw fail();
  if (!ring.has(version)) {
    throw new AgentKeyError(
      'unknown_version',
      `agent key ${binding.id} is under key version ${version}, which is not configured`
    );
  }
  const info = bindingBytes(version, binding.pubkey);
  const aad = concat(info, new TextEncoder().encode(binding.id));
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: concat(sealed.subarray(1, 1 + NONCE_BYTES)), additionalData: aad },
        await kekFor(ring, version, info),
        concat(sealed.subarray(1 + NONCE_BYTES))
      )
    );
  } catch {
    throw fail();
  }
  let matches = false;
  try {
    matches = plain.length === SECRET_KEY_BYTES && getPublicKey(plain) === binding.pubkey;
  } catch {
    // Not a valid secp256k1 secret key.
  }
  if (!matches) {
    plain.fill(0);
    throw fail();
  }
  return plain;
}
