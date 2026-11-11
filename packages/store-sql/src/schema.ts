/**
 * The service's own state (spec 8.5). Drafts are not here; they live on the user's relay. One
 * schema serves D1 on Workers and a SQLite file on Node. Timestamps are unix seconds.
 *
 * Secrets are stored only as hashes (OAuth codes and tokens) or ciphertext (agent secret keys).
 * No column holds submission content.
 *
 * Rows with a TTL carry `expires_at`; every read through the repositories filters on it and
 * `sweepExpired` deletes what has passed it.
 */
import {
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Opaque bytes. better-sqlite3 hands back a Buffer and D1 an ArrayBuffer or an array of numbers,
 * so reads are normalized to a plain Uint8Array for both drivers to return the same thing.
 */
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array | ArrayBuffer | number[] }>({
  dataType: () => 'blob',
  toDriver: (value) => value,
  fromDriver: (value) => {
    if (Array.isArray(value)) return Uint8Array.from(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    return Uint8Array.from(value);
  },
});

/**
 * MCP clients, identified by Client ID Metadata Documents (spec 8.2): `client_id` is the HTTPS URL
 * of the document, and the row caches what it said. Not swept: tokens and agent keys refer to it.
 */
export const oauthClients = sqliteTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  /** The client's metadata document as fetched. */
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
  /** How the client registered: a metadata document now, dynamic registration if it is added. */
  registrationSource: text('registration_source', {
    enum: ['metadata_document', 'dynamic'],
  }).notNull(),
  /** When the metadata document was last fetched; the caller decides when to refetch. */
  fetchedAt: integer('fetched_at').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Agent keypairs the service mints when a device fetches a pending authorization (spec 6.2, 8.2
 * step 3). One per MCP client authorization.
 */
export const agentKeys = sqliteTable(
  'agent_keys',
  {
    id: text('id').primaryKey(),
    pubkey: text('pubkey').notNull(),
    /**
     * The secret key encrypted with the service secret (the encryption is #6's). Null once the key
     * is revoked, so a revoked key is unusable by the service too.
     */
    encryptedSecretKey: bytes('encrypted_secret_key'),
    /** Which version of the service secret encrypted it, so the secret can rotate. */
    keyVersion: integer('key_version').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    uniqueIndex('agent_keys_pubkey_idx').on(t.pubkey),
    index('agent_keys_client_idx').on(t.clientId),
    index('agent_keys_key_version_idx').on(t.keyVersion),
  ]
);

/**
 * OAuth authorizations waiting for a device (spec 8.2 steps 2 to 4). `user_code` is the short code
 * the authorize page shows. An unapproved one that expires takes its minted agent key with it.
 */
export const pendingAuthorizations = sqliteTable(
  'pending_authorizations',
  {
    id: text('id').primaryKey(),
    userCode: text('user_code').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    /** The client's OAuth `state`, echoed back on the redirect. */
    state: text('state'),
    /** PKCE challenge; the method is always S256 (spec 8.2 step 1). */
    codeChallenge: text('code_challenge').notNull(),
    /** Space-separated, as in OAuth. */
    scopes: text('scopes').notNull(),
    /** RFC 8707 resource indicator the MCP client sent. */
    resource: text('resource'),
    status: text('status', { enum: ['pending', 'fetched', 'approved', 'denied'] }).notNull(),
    /** Minted when a device fetches the request (8.2 step 3). */
    agentKeyId: text('agent_key_id').references(() => agentKeys.id, { onDelete: 'set null' }),
    /** The queue whose device fetched it (the NIP-98 signer). */
    queuePubkey: text('queue_pubkey'),
    /**
     * Keyed hash (HMAC-SHA-256 under a key derived from the service secret) of the IP address that
     * started the authorization, for the open-authorizations-per-IP cap. Never the address itself;
     * gone with the row when it is swept.
     */
    clientIpHash: text('client_ip_hash'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('pending_authorizations_user_code_idx').on(t.userCode),
    index('pending_authorizations_expires_idx').on(t.expiresAt),
    index('pending_authorizations_agent_key_idx').on(t.agentKeyId),
    index('pending_authorizations_client_ip_idx').on(t.clientIpHash, t.expiresAt),
  ]
);

/** OAuth authorization codes, by hash, single use (spec 8.2 step 5). */
export const oauthCodes = sqliteTable(
  'oauth_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    agentKeyId: text('agent_key_id')
      .notNull()
      .references(() => agentKeys.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    scopes: text('scopes').notNull(),
    resource: text('resource'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('oauth_codes_expires_idx').on(t.expiresAt),
    index('oauth_codes_agent_key_idx').on(t.agentKeyId),
  ]
);

/**
 * Access and refresh tokens, by hash, bound to one agent key (spec 8.2 step 5). The queue pubkey
 * comes from the agent key's binding, so a rotation rebind (6.1) moves the tokens with it.
 */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    agentKeyId: text('agent_key_id')
      .notNull()
      .references(() => agentKeys.id, { onDelete: 'cascade' }),
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('oauth_tokens_agent_key_idx').on(t.agentKeyId),
    index('oauth_tokens_expires_idx').on(t.expiresAt),
  ]
);

/** Which queue an agent key submits to; rebound on queue key rotation (spec 6.1). */
export const bindings = sqliteTable(
  'bindings',
  {
    agentKeyId: text('agent_key_id')
      .primaryKey()
      .references(() => agentKeys.id, { onDelete: 'cascade' }),
    queuePubkey: text('queue_pubkey').notNull(),
    /** The client name shown on the approval screen. */
    clientLabel: text('client_label').notNull(),
    /**
     * The queue's storage relays as the approving device named them (spec 8.2 step 4), where the
     * service reads the agent's grant and the submitters list.
     */
    storageRelays: text('storage_relays', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /**
     * The `created_at` of the agent grant whose `storage` the relays came from (spec 7.4, 8.4), or
     * null while they are the ones the approval named. Only a newer grant moves them again.
     */
    storageGrantAt: integer('storage_grant_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('bindings_queue_idx').on(t.queuePubkey)]
);

/**
 * One row per published submission, without content (spec 8.4): `list_submissions` reads them and
 * quota counting (7.4) counts them. The caller sets `expires_at` no earlier than both the gift
 * wrap's NIP-40 expiration and the end of the quota period the receipt counts toward.
 */
export const submissionReceipts = sqliteTable(
  'submission_receipts',
  {
    giftWrapId: text('gift_wrap_id').primaryKey(),
    agentKeyId: text('agent_key_id')
      .notNull()
      .references(() => agentKeys.id, { onDelete: 'cascade' }),
    queuePubkey: text('queue_pubkey').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('submission_receipts_agent_created_idx').on(t.agentKeyId, t.createdAt),
    index('submission_receipts_queue_created_idx').on(t.queuePubkey, t.createdAt),
    index('submission_receipts_expires_idx').on(t.expiresAt),
  ]
);

/**
 * Exact counters for service-wide caps (the global daily create_draft ceiling): one row per scope
 * and window, reserved with a single conditional upsert so concurrent requests cannot pass the
 * limit, and released when the counted action fails.
 */
export const usageCounters = sqliteTable(
  'usage_counters',
  {
    scope: text('scope').notNull(),
    /** Start of the counting window, unix seconds (00:00 UTC for a daily cap). */
    windowStart: integer('window_start').notNull(),
    count: integer('count').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.windowStart] }),
    index('usage_counters_expires_idx').on(t.expiresAt),
  ]
);

/**
 * NIP-AB typed-code rendezvous (spec 8.3): the existing device posts its `nostrpair://` URI and
 * the new device fetches it once by code. Kept in SQL, not KV, on Workers too (8.5).
 */
export const pairingSessions = sqliteTable(
  'pairing_sessions',
  {
    /** 8 Crockford base32 characters, single use. */
    code: text('code').primaryKey(),
    queuePubkey: text('queue_pubkey').notNull(),
    /** The NIP-AB URI, including the source's ephemeral pubkey and session secret. */
    uri: text('uri').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('pairing_sessions_expires_idx').on(t.expiresAt)]
);

/** NIP-98 event ids seen recently, for replay protection (spec 8.5). */
export const nip98Replays = sqliteTable(
  'nip98_replays',
  {
    eventId: text('event_id').primaryKey(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('nip98_replays_expires_idx').on(t.expiresAt)]
);

/** Queues eligible for the hosted relay (spec 9.2), and what made them eligible. */
export const hostedQueues = sqliteTable('hosted_queues', {
  queuePubkey: text('queue_pubkey').primaryKey(),
  source: text('source', {
    enum: ['agent_authorization', 'pairing', 'setup', 'rotation'],
  }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
