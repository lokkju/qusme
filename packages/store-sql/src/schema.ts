/**
 * The service's own state (spec 8.5): OAuth clients and tokens, agent keys (encrypted), queue-pubkey
 * bindings and pairing sessions. Drafts are not here; they live on the user's relay. One schema
 * serves D1 on Workers and a SQLite file on Node. Timestamps are unix seconds.
 */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** MCP clients registered with the OAuth 2.1 authorization server (spec 8.2). */
export const oauthClients = sqliteTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  /** JSON array of registered redirect URIs. */
  redirectUris: text('redirect_uris').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Access and refresh tokens, stored by hash, bound to one agent key (spec 8.2 step 5). */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    agentPubkey: text('agent_pubkey')
      .notNull()
      .references(() => agentKeys.pubkey, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('oauth_tokens_agent_idx').on(t.agentPubkey)]
);

/** Agent keypairs the service mints and holds, one per MCP client authorization (spec 6.2). */
export const agentKeys = sqliteTable('agent_keys', {
  pubkey: text('pubkey').primaryKey(),
  /** The secret key, encrypted with QUSME_AGENT_KEY_SECRET. Never stored in plaintext. */
  encryptedSecretKey: text('encrypted_secret_key').notNull(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  label: text('label'),
  createdAt: integer('created_at').notNull(),
  destroyedAt: integer('destroyed_at'),
});

/** Which queue an agent key submits to; rebound on queue key rotation (spec 6.1). */
export const queueBindings = sqliteTable(
  'queue_bindings',
  {
    agentPubkey: text('agent_pubkey')
      .primaryKey()
      .references(() => agentKeys.pubkey, { onDelete: 'cascade' }),
    queuePubkey: text('queue_pubkey').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('queue_bindings_queue_idx').on(t.queuePubkey)]
);

/**
 * Device pairing rendezvous (spec 8.3) and pending agent authorizations (8.2). Short-lived: rows
 * past expires_at are dead and get swept. Kept in SQL, not KV, on Workers too (spec 8.5).
 */
export const pairingSessions = sqliteTable(
  'pairing_sessions',
  {
    code: text('code').primaryKey(),
    kind: text('kind', { enum: ['device', 'agent'] }).notNull(),
    /** The new device's ephemeral pubkey (device pairing). */
    ephemeralPubkey: text('ephemeral_pubkey'),
    /** The pending OAuth authorization's id (agent authorization). */
    authorizationId: text('authorization_id'),
    /** The key-transfer gift wrap's event id, relayed to the new device. */
    giftWrapId: text('gift_wrap_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('pairing_sessions_expires_idx').on(t.expiresAt)]
);
