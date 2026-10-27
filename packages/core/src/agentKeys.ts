/**
 * Agent key custody (spec 6.2): minting, encrypted storage, use as a Signer, revocation,
 * destruction and re-encryption under a rotated service secret. Encryption is in
 * `agentKeyRing.ts`.
 *
 * A secret key is decrypted only inside one call and zeroed when the call ends. Nothing here
 * returns, logs or puts a secret key in an error; callers get a Signer, never the bytes.
 */
import {
  type EventTemplate,
  type NostrEvent,
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  type Signer,
} from '@qusme/nostr';
import type { AgentKey, Store } from '@qusme/store-sql';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  AgentKeyError,
  type AgentKeyRing,
  openAgentSecret,
  sealAgentSecret,
} from './agentKeyRing.ts';

/** An agent key as callers see it: everything but the ciphertext. */
export interface AgentKeyInfo {
  id: string;
  pubkey: string;
  clientId: string;
  keyVersion: number;
  createdAt: number;
  revokedAt: number | null;
}

export interface MintAgentKey {
  /** The OAuth client the authorization is for. */
  clientId: string;
  /** Unix seconds. */
  now: number;
  /** The row id; a random UUID by default. */
  id?: string;
}

export interface RotationResult {
  /** Keys moved to the ring's current version. */
  reencrypted: number;
  /** Ids of keys that could not be decrypted, with why. They stay under their old version. */
  failed: { id: string; code: string }[];
}

function info(row: AgentKey): AgentKeyInfo {
  return {
    id: row.id,
    pubkey: row.pubkey,
    clientId: row.clientId,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt ?? null,
  };
}

/**
 * A Signer over a decrypted secret key that stops working, and zeroes the key and every cached
 * conversation key, when `close` is called. Zeroing is best effort: the secp256k1 and NIP-44
 * libraries may hold short-lived copies of their own.
 */
function scopedSigner(secretKey: Uint8Array, pubkey: string): { signer: Signer; close(): void } {
  let open = true;
  const conversationKeys = new Map<string, Uint8Array>();
  const check = () => {
    if (!open) throw new AgentKeyError('closed', 'agent key signer used after its call ended');
  };
  const conversationKey = (peer: string): Uint8Array => {
    let ck = conversationKeys.get(peer);
    if (ck === undefined) {
      ck = nip44ConversationKey(secretKey, peer);
      conversationKeys.set(peer, ck);
    }
    return ck;
  };
  const signer: Signer = {
    getPublicKey: async () => {
      check();
      return pubkey;
    },
    signEvent: async (template: EventTemplate): Promise<NostrEvent> => {
      check();
      return finalizeEvent(template, secretKey);
    },
    nip44Encrypt: async (peer, plaintext) => {
      check();
      return nip44EncryptWithKey(conversationKey(peer), plaintext);
    },
    nip44Decrypt: async (peer, payload) => {
      check();
      return nip44DecryptWithKey(conversationKey(peer), payload);
    },
  };
  return {
    signer,
    close() {
      open = false;
      secretKey.fill(0);
      for (const ck of conversationKeys.values()) ck.fill(0);
      conversationKeys.clear();
    },
  };
}

export function createAgentKeyCustody(store: Store, ring: AgentKeyRing) {
  async function load(id: string): Promise<AgentKey> {
    const row = await store.agentKeys.get(id);
    if (row === undefined) throw new AgentKeyError('not_found', `agent key ${id} not found`);
    if (row.revokedAt !== null || row.encryptedSecretKey === null) {
      throw new AgentKeyError('revoked', `agent key ${id} is revoked`);
    }
    return row;
  }

  function decrypt(row: AgentKey): Promise<Uint8Array> {
    return openAgentSecret(
      ring,
      { id: row.id, pubkey: row.pubkey },
      row.keyVersion,
      row.encryptedSecretKey ?? new Uint8Array(0)
    );
  }

  /**
   * Runs `fn` with a Signer for the agent key, decrypting it once for the whole call. The key is
   * zeroed and the Signer disabled when `fn` settles, so keep no reference to it.
   */
  async function withAgentKey<T>(id: string, fn: (signer: Signer) => Promise<T>): Promise<T> {
    const row = await load(id);
    const scoped = scopedSigner(await decrypt(row), row.pubkey);
    try {
      return await fn(scoped.signer);
    } finally {
      scoped.close();
    }
  }

  return {
    /**
     * Mints a keypair for an MCP client authorization (spec 8.2 step 3) and stores its secret key
     * encrypted under the ring's current version.
     */
    async mint(input: MintAgentKey): Promise<AgentKeyInfo> {
      const id = input.id ?? crypto.randomUUID();
      const secretKey = generateSecretKey();
      try {
        const pubkey = getPublicKey(secretKey);
        const row = await store.agentKeys.create({
          id,
          pubkey,
          encryptedSecretKey: await sealAgentSecret(ring, { id, pubkey }, secretKey),
          keyVersion: ring.currentVersion,
          clientId: input.clientId,
          createdAt: input.now,
        });
        return info(row);
      } finally {
        secretKey.fill(0);
      }
    },

    /** The key's public facts, revoked or not. */
    async get(id: string): Promise<AgentKeyInfo | undefined> {
      const row = await store.agentKeys.get(id);
      return row === undefined ? undefined : info(row);
    },

    withAgentKey,

    /**
     * A Signer that loads and decrypts the key afresh for every call, so a revocation takes effect
     * on the next call. For one-off use (an AUTH, a grant decryption); `withAgentKey` decrypts
     * once for a sequence such as building a submission.
     */
    signer(id: string): Signer {
      return {
        getPublicKey: async () => (await load(id)).pubkey,
        signEvent: (template) => withAgentKey(id, (s) => s.signEvent(template)),
        nip44Encrypt: (peer, plaintext) => withAgentKey(id, (s) => s.nip44Encrypt(peer, plaintext)),
        nip44Decrypt: (peer, payload) => withAgentKey(id, (s) => s.nip44Decrypt(peer, payload)),
      };
    },

    /**
     * Revokes the key and discards its ciphertext (spec 8.2, revocation). The row, its receipts
     * and binding stay. False if it was already revoked or does not exist.
     */
    async revoke(id: string, now: number): Promise<boolean> {
      return (await store.agentKeys.revoke(id, now)) !== undefined;
    },

    /**
     * Deletes the key with its codes, tokens, binding and receipts, for an authorization that was
     * denied or expired (spec 8.2 step 4). False if it did not exist.
     */
    async destroy(id: string): Promise<boolean> {
      return store.agentKeys.delete(id);
    },

    /**
     * Re-encrypts every unrevoked key below the ring's current version under the current one.
     * Idempotent and safe to run concurrently or to interrupt. Keys that do not decrypt (no secret
     * for their version, or damaged) are reported in `failed` and left as they are; the pass stops
     * when a batch moves nothing, so a batch made only of failures ends it.
     */
    async rotate(options: { batchSize?: number } = {}): Promise<RotationResult> {
      const batchSize = options.batchSize ?? 100;
      const failed = new Map<string, string>();
      let reencrypted = 0;
      for (;;) {
        const rows = await store.agentKeys.listBelowKeyVersion(ring.currentVersion, batchSize);
        let moved = 0;
        for (const row of rows) {
          if (failed.has(row.id)) continue;
          let secretKey: Uint8Array | undefined;
          try {
            secretKey = await decrypt(row);
            const sealed = await sealAgentSecret(
              ring,
              { id: row.id, pubkey: row.pubkey },
              secretKey
            );
            // Undefined if the key was revoked meanwhile; nothing to move then.
            await store.agentKeys.reencrypt(row.id, sealed, ring.currentVersion);
            moved++;
          } catch (err) {
            failed.set(row.id, err instanceof AgentKeyError ? err.code : 'error');
          } finally {
            secretKey?.fill(0);
          }
        }
        reencrypted += moved;
        if (moved === 0) break;
      }
      return { reencrypted, failed: [...failed].map(([id, code]) => ({ id, code })) };
    },
  };
}

export type AgentKeyCustody = ReturnType<typeof createAgentKeyCustody>;
