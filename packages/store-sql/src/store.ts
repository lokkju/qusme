/**
 * Typed repositories over the service-state tables. Every function awaits its query, so the same
 * code runs on D1 (async) and better-sqlite3 (sync). Nothing here opens a transaction: D1 has no
 * interactive ones, so each state change that must be atomic is a single statement (an UPDATE or
 * DELETE with a guarding WHERE and RETURNING), and the caller learns from the returned row whether
 * it won.
 *
 * `now` is always passed in (unix seconds), so reads of TTL rows filter on it and tests control it.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { QusmeDb } from './db.ts';
import {
  agentKeys,
  bindings,
  hostedQueues,
  nip98Replays,
  oauthClients,
  oauthCodes,
  oauthTokens,
  pairingSessions,
  pendingAuthorizations,
  submissionReceipts,
} from './schema.ts';

export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type AgentKey = typeof agentKeys.$inferSelect;
export type NewAgentKey = typeof agentKeys.$inferInsert;
export type PendingAuthorization = typeof pendingAuthorizations.$inferSelect;
export type NewPendingAuthorization = typeof pendingAuthorizations.$inferInsert;
export type OAuthCode = typeof oauthCodes.$inferSelect;
export type NewOAuthCode = typeof oauthCodes.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type Binding = typeof bindings.$inferSelect;
export type NewBinding = typeof bindings.$inferInsert;
export type SubmissionReceipt = typeof submissionReceipts.$inferSelect;
export type NewSubmissionReceipt = typeof submissionReceipts.$inferInsert;
export type PairingSession = typeof pairingSessions.$inferSelect;
export type NewPairingSession = typeof pairingSessions.$inferInsert;
export type HostedQueue = typeof hostedQueues.$inferSelect;
export type NewHostedQueue = typeof hostedQueues.$inferInsert;

/** Rows `sweepExpired` deleted, per table. */
export interface SweepResult {
  /** Agent keys minted for authorizations that expired without approval (spec 8.2). */
  agentKeys: number;
  pendingAuthorizations: number;
  oauthCodes: number;
  oauthTokens: number;
  submissionReceipts: number;
  pairingSessions: number;
  nip98Replays: number;
}

/** Hex SHA-256 of a secret (an OAuth code or token), the form those tables store. Web Crypto. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createStore(db: QusmeDb) {
  const oauthClientsRepo = {
    /** Inserts or refreshes a client's cached metadata document. */
    async upsert(row: NewOAuthClient): Promise<OAuthClient> {
      const [out] = await db
        .insert(oauthClients)
        .values(row)
        .onConflictDoUpdate({
          target: oauthClients.clientId,
          set: {
            metadata: row.metadata,
            clientName: row.clientName,
            redirectUris: row.redirectUris,
            registrationSource: row.registrationSource,
            fetchedAt: row.fetchedAt,
          },
        })
        .returning();
      return must(out);
    },
    async get(clientId: string): Promise<OAuthClient | undefined> {
      return db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get();
    },
    async update(
      clientId: string,
      patch: Partial<Omit<NewOAuthClient, 'clientId'>>
    ): Promise<OAuthClient | undefined> {
      const [out] = await db
        .update(oauthClients)
        .set(patch)
        .where(eq(oauthClients.clientId, clientId))
        .returning();
      return out;
    },
    /** Deletes the client and, by cascade, its agent keys, codes, tokens and authorizations. */
    async delete(clientId: string): Promise<boolean> {
      const out = await db
        .delete(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .returning({ id: oauthClients.clientId });
      return out.length > 0;
    },
  };

  const agentKeysRepo = {
    async create(row: NewAgentKey): Promise<AgentKey> {
      const [out] = await db.insert(agentKeys).values(row).returning();
      return must(out);
    },
    /** The key, revoked or not; check `revokedAt` before using it. */
    async get(id: string): Promise<AgentKey | undefined> {
      return db.select().from(agentKeys).where(eq(agentKeys.id, id)).get();
    },
    async getByPubkey(pubkey: string): Promise<AgentKey | undefined> {
      return db.select().from(agentKeys).where(eq(agentKeys.pubkey, pubkey)).get();
    },
    /** Unrevoked keys encrypted under an older service secret, for re-encryption (spec 8.5). */
    async listBelowKeyVersion(keyVersion: number, limit = 100): Promise<AgentKey[]> {
      return db
        .select()
        .from(agentKeys)
        .where(and(lt(agentKeys.keyVersion, keyVersion), isNull(agentKeys.revokedAt)))
        .limit(limit)
        .all();
    },
    /** Replaces the ciphertext after re-encryption under a newer service secret. */
    async reencrypt(
      id: string,
      encryptedSecretKey: Uint8Array,
      keyVersion: number
    ): Promise<AgentKey | undefined> {
      const [out] = await db
        .update(agentKeys)
        .set({ encryptedSecretKey, keyVersion })
        .where(and(eq(agentKeys.id, id), isNull(agentKeys.revokedAt)))
        .returning();
      return out;
    },
    /** Marks the key revoked and discards its ciphertext. Receipts and bindings stay. */
    async revoke(id: string, now: number): Promise<AgentKey | undefined> {
      const [out] = await db
        .update(agentKeys)
        .set({ revokedAt: now, encryptedSecretKey: null })
        .where(and(eq(agentKeys.id, id), isNull(agentKeys.revokedAt)))
        .returning();
      return out;
    },
    /**
     * Destroys the key outright, with its codes, tokens, binding and receipts (cascade). For a key
     * minted for an authorization that was denied (spec 8.2 step 4).
     */
    async delete(id: string): Promise<boolean> {
      const out = await db
        .delete(agentKeys)
        .where(eq(agentKeys.id, id))
        .returning({ id: agentKeys.id });
      return out.length > 0;
    },
  };

  const live = (now: number) => gt(pendingAuthorizations.expiresAt, now);

  const pendingAuthorizationsRepo = {
    async create(row: NewPendingAuthorization): Promise<PendingAuthorization> {
      const [out] = await db.insert(pendingAuthorizations).values(row).returning();
      return must(out);
    },
    async get(id: string, now: number): Promise<PendingAuthorization | undefined> {
      return db
        .select()
        .from(pendingAuthorizations)
        .where(and(eq(pendingAuthorizations.id, id), live(now)))
        .get();
    },
    /** By the short code the device types or scans. */
    async getByUserCode(userCode: string, now: number): Promise<PendingAuthorization | undefined> {
      return db
        .select()
        .from(pendingAuthorizations)
        .where(and(eq(pendingAuthorizations.userCode, userCode), live(now)))
        .get();
    },
    /**
     * Moves `pending` to `fetched` and records the minted agent key and the fetching queue (spec
     * 8.2 step 3). Undefined if it was already fetched, decided or expired; the caller then
     * deletes the key it minted.
     */
    async markFetched(
      id: string,
      fetch: { agentKeyId: string; queuePubkey: string },
      now: number
    ): Promise<PendingAuthorization | undefined> {
      const [out] = await db
        .update(pendingAuthorizations)
        .set({ status: 'fetched', ...fetch })
        .where(
          and(
            eq(pendingAuthorizations.id, id),
            eq(pendingAuthorizations.status, 'pending'),
            live(now)
          )
        )
        .returning();
      return out;
    },
    /** Moves `fetched` to `approved` or `denied` (spec 8.2 step 4). Undefined if not fetched. */
    async decide(
      id: string,
      status: 'approved' | 'denied',
      now: number
    ): Promise<PendingAuthorization | undefined> {
      const [out] = await db
        .update(pendingAuthorizations)
        .set({ status })
        .where(
          and(
            eq(pendingAuthorizations.id, id),
            eq(pendingAuthorizations.status, 'fetched'),
            live(now)
          )
        )
        .returning();
      return out;
    },
    async update(
      id: string,
      patch: Partial<Omit<NewPendingAuthorization, 'id'>>
    ): Promise<PendingAuthorization | undefined> {
      const [out] = await db
        .update(pendingAuthorizations)
        .set(patch)
        .where(eq(pendingAuthorizations.id, id))
        .returning();
      return out;
    },
    async delete(id: string): Promise<boolean> {
      const out = await db
        .delete(pendingAuthorizations)
        .where(eq(pendingAuthorizations.id, id))
        .returning({ id: pendingAuthorizations.id });
      return out.length > 0;
    },
  };

  const oauthCodesRepo = {
    async create(row: NewOAuthCode): Promise<OAuthCode> {
      const [out] = await db.insert(oauthCodes).values(row).returning();
      return must(out);
    },
    async get(codeHash: string, now: number): Promise<OAuthCode | undefined> {
      return db
        .select()
        .from(oauthCodes)
        .where(and(eq(oauthCodes.codeHash, codeHash), gt(oauthCodes.expiresAt, now)))
        .get();
    },
    /** Deletes and returns the code in one statement, so it redeems at most once. */
    async consume(codeHash: string, now: number): Promise<OAuthCode | undefined> {
      const [out] = await db
        .delete(oauthCodes)
        .where(and(eq(oauthCodes.codeHash, codeHash), gt(oauthCodes.expiresAt, now)))
        .returning();
      return out;
    },
    async delete(codeHash: string): Promise<boolean> {
      const out = await db
        .delete(oauthCodes)
        .where(eq(oauthCodes.codeHash, codeHash))
        .returning({ id: oauthCodes.codeHash });
      return out.length > 0;
    },
  };

  const oauthTokensRepo = {
    async create(row: NewOAuthToken): Promise<OAuthToken> {
      const [out] = await db.insert(oauthTokens).values(row).returning();
      return must(out);
    },
    /** A token that is neither expired nor revoked. */
    async get(tokenHash: string, now: number): Promise<OAuthToken | undefined> {
      return db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.tokenHash, tokenHash),
            gt(oauthTokens.expiresAt, now),
            isNull(oauthTokens.revokedAt)
          )
        )
        .get();
    },
    /**
     * The token whether or not it is revoked or expired (until swept), so a refresh token presented
     * again after rotation can be recognized as a replay (OAuth 2.1 refresh token rotation).
     */
    async find(tokenHash: string): Promise<OAuthToken | undefined> {
      return db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, tokenHash)).get();
    },
    async listByAgentKey(agentKeyId: string, now: number): Promise<OAuthToken[]> {
      return db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.agentKeyId, agentKeyId),
            gt(oauthTokens.expiresAt, now),
            isNull(oauthTokens.revokedAt)
          )
        )
        .all();
    },
    /** Revokes one token; undefined if it was already revoked or never existed. */
    async revoke(tokenHash: string, now: number): Promise<OAuthToken | undefined> {
      const [out] = await db
        .update(oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthTokens.tokenHash, tokenHash), isNull(oauthTokens.revokedAt)))
        .returning();
      return out;
    },
    /** Revokes every token of an agent key; returns how many. */
    async revokeByAgentKey(agentKeyId: string, now: number): Promise<number> {
      const out = await db
        .update(oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthTokens.agentKeyId, agentKeyId), isNull(oauthTokens.revokedAt)))
        .returning({ id: oauthTokens.tokenHash });
      return out.length;
    },
    async delete(tokenHash: string): Promise<boolean> {
      const out = await db
        .delete(oauthTokens)
        .where(eq(oauthTokens.tokenHash, tokenHash))
        .returning({ id: oauthTokens.tokenHash });
      return out.length > 0;
    },
  };

  const bindingsRepo = {
    async create(row: NewBinding): Promise<Binding> {
      const [out] = await db.insert(bindings).values(row).returning();
      return must(out);
    },
    /** The binding, revoked or not; check `revokedAt`. */
    async get(agentKeyId: string): Promise<Binding | undefined> {
      return db.select().from(bindings).where(eq(bindings.agentKeyId, agentKeyId)).get();
    },
    /** Unrevoked bindings to a queue. */
    async listByQueue(queuePubkey: string): Promise<Binding[]> {
      return db
        .select()
        .from(bindings)
        .where(and(eq(bindings.queuePubkey, queuePubkey), isNull(bindings.revokedAt)))
        .all();
    },
    async update(
      agentKeyId: string,
      patch: Partial<Omit<NewBinding, 'agentKeyId'>>
    ): Promise<Binding | undefined> {
      const [out] = await db
        .update(bindings)
        .set(patch)
        .where(eq(bindings.agentKeyId, agentKeyId))
        .returning();
      return out;
    },
    async revoke(agentKeyId: string, now: number): Promise<Binding | undefined> {
      const [out] = await db
        .update(bindings)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(bindings.agentKeyId, agentKeyId), isNull(bindings.revokedAt)))
        .returning();
      return out;
    },
    /**
     * Moves every unrevoked binding from the old queue pubkey to the new one (spec 6.1, after both
     * signatures verify). Returns how many moved; running it again moves none.
     */
    async rebindQueue(
      oldQueuePubkey: string,
      newQueuePubkey: string,
      now: number
    ): Promise<number> {
      const out = await db
        .update(bindings)
        .set({ queuePubkey: newQueuePubkey, updatedAt: now })
        .where(and(eq(bindings.queuePubkey, oldQueuePubkey), isNull(bindings.revokedAt)))
        .returning({ id: bindings.agentKeyId });
      return out.length;
    },
    async delete(agentKeyId: string): Promise<boolean> {
      const out = await db
        .delete(bindings)
        .where(eq(bindings.agentKeyId, agentKeyId))
        .returning({ id: bindings.agentKeyId });
      return out.length > 0;
    },
  };

  const receiptsLive = (now: number) => gt(submissionReceipts.expiresAt, now);

  const submissionReceiptsRepo = {
    async create(row: NewSubmissionReceipt): Promise<SubmissionReceipt> {
      const [out] = await db.insert(submissionReceipts).values(row).returning();
      return must(out);
    },
    async get(giftWrapId: string, now: number): Promise<SubmissionReceipt | undefined> {
      return db
        .select()
        .from(submissionReceipts)
        .where(and(eq(submissionReceipts.giftWrapId, giftWrapId), receiptsLive(now)))
        .get();
    },
    /**
     * An agent key's receipts, newest first (`list_submissions`, spec 8.4). `before` pages by
     * `created_at`: pass the last row's `createdAt` to get the next page.
     */
    async listByAgentKey(
      agentKeyId: string,
      now: number,
      opts: { limit?: number; before?: number } = {}
    ): Promise<SubmissionReceipt[]> {
      return db
        .select()
        .from(submissionReceipts)
        .where(
          and(
            eq(submissionReceipts.agentKeyId, agentKeyId),
            receiptsLive(now),
            opts.before === undefined ? undefined : lt(submissionReceipts.createdAt, opts.before)
          )
        )
        .orderBy(desc(submissionReceipts.createdAt), desc(submissionReceipts.giftWrapId))
        .limit(opts.limit ?? 50)
        .all();
    },
    /** Submissions by an agent key since the start of the current quota period (spec 7.4). */
    async countSince(agentKeyId: string, since: number): Promise<number> {
      const rows = await db
        .select({ id: submissionReceipts.giftWrapId })
        .from(submissionReceipts)
        .where(
          and(
            eq(submissionReceipts.agentKeyId, agentKeyId),
            gte(submissionReceipts.createdAt, since)
          )
        )
        .all();
      return rows.length;
    },
    async delete(giftWrapId: string): Promise<boolean> {
      const out = await db
        .delete(submissionReceipts)
        .where(eq(submissionReceipts.giftWrapId, giftWrapId))
        .returning({ id: submissionReceipts.giftWrapId });
      return out.length > 0;
    },
  };

  const pairingLive = (now: number) => gt(pairingSessions.expiresAt, now);

  const pairingSessionsRepo = {
    async create(row: NewPairingSession): Promise<PairingSession> {
      const [out] = await db.insert(pairingSessions).values(row).returning();
      return must(out);
    },
    /**
     * Inserts the session unless a live one holds the code; an expired row not yet swept is
     * replaced. Undefined when the code is taken, so the caller draws another.
     */
    async createIfFree(row: NewPairingSession, now: number): Promise<PairingSession | undefined> {
      const [out] = await db
        .insert(pairingSessions)
        .values(row)
        .onConflictDoUpdate({
          target: pairingSessions.code,
          set: {
            queuePubkey: row.queuePubkey,
            uri: row.uri,
            attempts: row.attempts ?? 0,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
          },
          setWhere: lte(pairingSessions.expiresAt, now),
        })
        .returning();
      return out;
    },
    /** Live sessions a queue key has open, for the per-queue cap. */
    async countLive(queuePubkey: string, now: number): Promise<number> {
      const rows = await db
        .select({ code: pairingSessions.code })
        .from(pairingSessions)
        .where(and(eq(pairingSessions.queuePubkey, queuePubkey), pairingLive(now)))
        .all();
      return rows.length;
    },
    async get(code: string, now: number): Promise<PairingSession | undefined> {
      return db
        .select()
        .from(pairingSessions)
        .where(and(eq(pairingSessions.code, code), pairingLive(now)))
        .get();
    },
    /** Counts a fetch attempt against the code; returns the new count, or undefined if none. */
    async recordAttempt(code: string, now: number): Promise<number | undefined> {
      const [out] = await db
        .update(pairingSessions)
        .set({ attempts: sql`${pairingSessions.attempts} + 1` })
        .where(and(eq(pairingSessions.code, code), pairingLive(now)))
        .returning({ attempts: pairingSessions.attempts });
      return out?.attempts;
    },
    /** Deletes and returns the session in one statement: the code works once (spec 8.3 step 3). */
    async take(code: string, now: number): Promise<PairingSession | undefined> {
      const [out] = await db
        .delete(pairingSessions)
        .where(and(eq(pairingSessions.code, code), pairingLive(now)))
        .returning();
      return out;
    },
    async delete(code: string): Promise<boolean> {
      const out = await db
        .delete(pairingSessions)
        .where(eq(pairingSessions.code, code))
        .returning({ id: pairingSessions.code });
      return out.length > 0;
    },
  };

  const nip98ReplaysRepo = {
    /**
     * Records a NIP-98 event id until `expiresAt`. True the first time; false if the id is already
     * held and unexpired, which is a replay. An expired row not yet swept counts as new.
     */
    async remember(eventId: string, expiresAt: number, now: number): Promise<boolean> {
      const out = await db
        .insert(nip98Replays)
        .values({ eventId, expiresAt })
        .onConflictDoUpdate({
          target: nip98Replays.eventId,
          set: { expiresAt },
          setWhere: lte(nip98Replays.expiresAt, now),
        })
        .returning({ id: nip98Replays.eventId });
      return out.length > 0;
    },
    async has(eventId: string, now: number): Promise<boolean> {
      const row = await db
        .select({ id: nip98Replays.eventId })
        .from(nip98Replays)
        .where(and(eq(nip98Replays.eventId, eventId), gt(nip98Replays.expiresAt, now)))
        .get();
      return row !== undefined;
    },
    async delete(eventId: string): Promise<boolean> {
      const out = await db
        .delete(nip98Replays)
        .where(eq(nip98Replays.eventId, eventId))
        .returning({ id: nip98Replays.eventId });
      return out.length > 0;
    },
  };

  const hostedQueuesRepo = {
    /** Makes a queue eligible for the hosted relay (spec 9.2). Idempotent; keeps the first source. */
    async register(row: NewHostedQueue): Promise<HostedQueue> {
      await db.insert(hostedQueues).values(row).onConflictDoNothing().run();
      return must(await hostedQueuesRepo.get(row.queuePubkey));
    },
    async get(queuePubkey: string): Promise<HostedQueue | undefined> {
      return db.select().from(hostedQueues).where(eq(hostedQueues.queuePubkey, queuePubkey)).get();
    },
    /**
     * Moves eligibility from the old queue pubkey to the new one on a rotation rebind (spec 9.2).
     * Undefined if the old one was not registered. If the new one already is, the old row goes.
     */
    async move(
      oldQueuePubkey: string,
      newQueuePubkey: string,
      now: number
    ): Promise<HostedQueue | undefined> {
      const [moved] = await db
        .update(hostedQueues)
        .set({ queuePubkey: newQueuePubkey, source: 'rotation', updatedAt: now })
        .where(and(eq(hostedQueues.queuePubkey, oldQueuePubkey), notExists(newQueuePubkey)))
        .returning();
      if (moved) return moved;
      const deleted = await db
        .delete(hostedQueues)
        .where(eq(hostedQueues.queuePubkey, oldQueuePubkey))
        .returning({ id: hostedQueues.queuePubkey });
      return deleted.length > 0 ? hostedQueuesRepo.get(newQueuePubkey) : undefined;
    },
    async delete(queuePubkey: string): Promise<boolean> {
      const out = await db
        .delete(hostedQueues)
        .where(eq(hostedQueues.queuePubkey, queuePubkey))
        .returning({ id: hostedQueues.queuePubkey });
      return out.length > 0;
    },
  };

  /** True when no hosted_queues row holds this pubkey. */
  function notExists(queuePubkey: string) {
    return sql`not exists (select 1 from ${hostedQueues} where ${hostedQueues.queuePubkey} = ${queuePubkey})`;
  }

  /**
   * Deletes every row past its `expires_at`, plus the agent keys minted for authorizations that
   * expired without approval (spec 8.2). Safe to run at any time and from more than one place;
   * each statement stands alone, so an interrupted sweep finishes on the next run.
   */
  async function sweepExpired(now: number): Promise<SweepResult> {
    const orphanedKeys = db
      .select({ id: pendingAuthorizations.agentKeyId })
      .from(pendingAuthorizations)
      .where(
        and(lte(pendingAuthorizations.expiresAt, now), ne(pendingAuthorizations.status, 'approved'))
      );
    const keys = await db
      .delete(agentKeys)
      .where(inArray(agentKeys.id, orphanedKeys))
      .returning({ id: agentKeys.id });
    const count = async (rows: Promise<unknown[]> | unknown[]) => (await rows).length;
    return {
      agentKeys: keys.length,
      pendingAuthorizations: await count(
        db
          .delete(pendingAuthorizations)
          .where(lte(pendingAuthorizations.expiresAt, now))
          .returning({ id: pendingAuthorizations.id })
      ),
      oauthCodes: await count(
        db
          .delete(oauthCodes)
          .where(lte(oauthCodes.expiresAt, now))
          .returning({ id: oauthCodes.codeHash })
      ),
      oauthTokens: await count(
        db
          .delete(oauthTokens)
          .where(lte(oauthTokens.expiresAt, now))
          .returning({ id: oauthTokens.tokenHash })
      ),
      submissionReceipts: await count(
        db
          .delete(submissionReceipts)
          .where(lte(submissionReceipts.expiresAt, now))
          .returning({ id: submissionReceipts.giftWrapId })
      ),
      pairingSessions: await count(
        db
          .delete(pairingSessions)
          .where(lte(pairingSessions.expiresAt, now))
          .returning({ id: pairingSessions.code })
      ),
      nip98Replays: await count(
        db
          .delete(nip98Replays)
          .where(lte(nip98Replays.expiresAt, now))
          .returning({ id: nip98Replays.eventId })
      ),
    };
  }

  return {
    oauthClients: oauthClientsRepo,
    agentKeys: agentKeysRepo,
    pendingAuthorizations: pendingAuthorizationsRepo,
    oauthCodes: oauthCodesRepo,
    oauthTokens: oauthTokensRepo,
    bindings: bindingsRepo,
    submissionReceipts: submissionReceiptsRepo,
    pairingSessions: pairingSessionsRepo,
    nip98Replays: nip98ReplaysRepo,
    hostedQueues: hostedQueuesRepo,
    sweepExpired,
  };
}

export type Store = ReturnType<typeof createStore>;

function must<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('store: statement returned no row');
  return row;
}
