/**
 * The OAuth 2.1 authorization server for MCP clients (spec 8.2) and the bearer check in front of
 * `/mcp`, following the MCP authorization specification (revision 2025-11-25): protected resource
 * metadata (RFC 9728), authorization server metadata (RFC 8414), the authorization code grant
 * with PKCE `S256` only, resource indicators (RFC 8707), Client ID Metadata Documents, refresh
 * token rotation and token revocation (RFC 7009). `docs/oauth.md` lists the endpoints and the
 * choices the spec leaves open.
 *
 * Approval happens on a paired device, not on the authorize page: the device fetches the pending
 * authorization by its short code (minting the agent key, 8.2 step 3), publishes the submitters
 * list and grant itself, and posts a NIP-98 approval naming the queue's storage relays. The service
 * reads the submitters list from those relays and approves only if it names the agent key (step
 * 5). It never logs a code, token or verifier; secrets are stored as SHA-256 hashes.
 */
import { parseSubmittersPublic, type Signer, SUBMITTERS_KINDS } from '@qusme/nostr';
import {
  createStore,
  hashSecret,
  type PendingAuthorization,
  type QusmeDb,
  type Store,
} from '@qusme/store-sql';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { AgentKeyRing } from '../agentKeyRing.ts';
import { createAgentKeyCustody } from '../agentKeys.ts';
import { type Nip98Env, nip98Auth, parsePublicOrigin } from '../nip98.ts';
import {
  ClientMetadataError,
  type FetchLike,
  fetchClientMetadata,
  matchRedirectUri,
} from './clientMetadata.ts';
import { approveHelpPage, authorizePage, messagePage, type Page } from './pages.ts';
import { checkStorageRelays, createWebSocketRelayReader, type RelayReader } from './relayReader.ts';
import {
  formatUserCode,
  generateUserCode,
  isS256Challenge,
  normalizeUserCode,
  randomToken,
  timingSafeEqual,
  verifyPkce,
} from './secrets.ts';

/** The one scope: submit drafts to the queue that approved the client (spec 8.4). */
export const SCOPE_SUBMIT = 'drafts:submit';
export const SCOPES_SUPPORTED = [SCOPE_SUBMIT] as const;

/** Lifetimes in seconds. */
export interface OAuthLifetimes {
  /** How long a device has to fetch and approve (spec 8.2, "expires if no device approves"). */
  pendingAuthorization: number;
  authorizationCode: number;
  accessToken: number;
  /** Each refresh token's lifetime; rotation issues a new one with a fresh lifetime. */
  refreshToken: number;
  /** How long a cached Client ID Metadata Document is used before it is fetched again. */
  clientMetadataCache: number;
}

export const DEFAULT_LIFETIMES: OAuthLifetimes = {
  pendingAuthorization: 10 * 60,
  authorizationCode: 60,
  accessToken: 60 * 60,
  refreshToken: 30 * 24 * 60 * 60,
  clientMetadataCache: 60 * 60,
};

/** What an entrypoint or a test may override; everything has a default. */
export interface OAuthOverrides {
  /** Fetches Client ID Metadata Documents; the runtime's fetch by default. */
  fetch?: FetchLike;
  /** Reads submitters lists from storage relays; WebSockets by default. */
  relayReader?: RelayReader;
  /** Unix seconds; tests pass a controlled clock. NIP-98 checks keep the real one. */
  now?: () => number;
  lifetimes?: Partial<OAuthLifetimes>;
}

export interface OAuthOptions extends OAuthOverrides {
  db: QusmeDb;
  agentKeys: AgentKeyRing;
  publicOrigin: string;
}

/** What the bearer middleware resolves a token to: the agent key and the queue it is bound to. */
export interface AgentAuth {
  agentKeyId: string;
  agentPubkey: string;
  clientId: string;
  scopes: string[];
  /** From the agent key's binding, so a rotation rebind (spec 6.1) moves every token with it. */
  queuePubkey: string;
  storageRelays: string[];
}

export interface McpAuthEnv {
  Variables: { agent: AgentAuth };
}

class OAuthError extends Error {
  readonly error: string;
  readonly description: string;
  readonly status: 400 | 401 | 403;
  constructor(error: string, description: string, status: 400 | 401 | 403 = 400) {
    super(description);
    this.error = error;
    this.description = description;
    this.status = status;
  }
}

/** Query or form parameters, refusing any that repeat (RFC 6749 3.1, 3.2). */
function singleParams(params: URLSearchParams): Record<string, string> | OAuthError {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in out) return new OAuthError('invalid_request', `parameter ${key} repeated`);
    out[key] = value;
  }
  return out;
}

function parseScopes(raw: string | undefined): string[] | OAuthError {
  const scopes = (raw ?? '').split(' ').filter((s) => s !== '');
  if (scopes.length === 0) return [SCOPE_SUBMIT];
  for (const s of scopes) {
    if (!(SCOPES_SUPPORTED as readonly string[]).includes(s)) {
      return new OAuthError('invalid_scope', `unknown scope ${s}`);
    }
  }
  return [...new Set(scopes)];
}

function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return url.href;
}

function htmlPage(c: Context, page: Page, status: 200 | 400 | 404 = 200) {
  return c.html(page.html, status, page.headers);
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export function createOAuth(options: OAuthOptions) {
  const origin = parsePublicOrigin(options.publicOrigin);
  const issuer = origin;
  const resource = `${origin}/mcp`;
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const lifetimes = { ...DEFAULT_LIFETIMES, ...options.lifetimes };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const relayReader = options.relayReader ?? createWebSocketRelayReader();
  const store: Store = createStore(options.db);
  const custody = createAgentKeyCustody(store, options.agentKeys);
  const requireNip98 = nip98Auth({ publicOrigin: origin, replays: store.nip98Replays });

  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES_SUPPORTED],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://qus.me',
  };

  const protectedResourceMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES_SUPPORTED],
    bearer_methods_supported: ['header'],
    resource_name: 'qus.me',
  };

  /** The client from cache, or fetched and cached if the cache is missing or stale. */
  async function loadClient(clientId: string, t: number) {
    const cached = await store.oauthClients.get(clientId);
    if (cached && t - cached.fetchedAt < lifetimes.clientMetadataCache) return cached;
    const meta = await fetchClientMetadata(clientId, { fetch: fetchImpl });
    return store.oauthClients.upsert({
      clientId,
      metadata: meta.document,
      clientName: meta.clientName,
      redirectUris: meta.redirectUris,
      registrationSource: 'metadata_document',
      fetchedAt: t,
      createdAt: cached?.createdAt ?? t,
    });
  }

  const clientHost = (clientId: string) => {
    try {
      return new URL(clientId).host;
    } catch {
      return clientId;
    }
  };

  // Where the browser goes after approval: the host (with port) of an http(s) redirect, or the
  // scheme of a native app's private-use one, so the approval screen can show it (spec 11.8).
  const redirectHost = (redirectUri: string) => {
    try {
      const url = new URL(redirectUri);
      return url.host === '' ? url.protocol : url.host;
    } catch {
      return redirectUri;
    }
  };

  async function issueTokens(
    grant: { clientId: string; agentKeyId: string; scopes: string },
    t: number
  ) {
    const accessToken = `qat_${randomToken(32)}`;
    const refreshToken = `qrt_${randomToken(32)}`;
    await store.oauthTokens.create({
      tokenHash: await hashSecret(accessToken),
      kind: 'access',
      clientId: grant.clientId,
      agentKeyId: grant.agentKeyId,
      scopes: grant.scopes,
      createdAt: t,
      expiresAt: t + lifetimes.accessToken,
    });
    await store.oauthTokens.create({
      tokenHash: await hashSecret(refreshToken),
      kind: 'refresh',
      clientId: grant.clientId,
      agentKeyId: grant.agentKeyId,
      scopes: grant.scopes,
      createdAt: t,
      expiresAt: t + lifetimes.refreshToken,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: lifetimes.accessToken,
      refresh_token: refreshToken,
      scope: grant.scopes,
    };
  }

  /** True when the agent key is live and bound to a queue by an unrevoked binding. */
  async function grantIsLive(agentKeyId: string) {
    const key = await store.agentKeys.get(agentKeyId);
    if (!key || key.revokedAt !== null) return undefined;
    const binding = await store.bindings.get(agentKeyId);
    if (!binding || binding.revokedAt !== null) return undefined;
    return { key, binding };
  }

  type Resolution =
    | { status: 'pending' | 'fetched'; row: PendingAuthorization }
    | { status: 'redirect'; redirect: string }
    | { status: 'expired' };

  /**
   * Where a browser waiting on `id` stands. An approved or denied authorization is taken (its row
   * deleted in one statement), so the authorization code is issued once, to the first poll that
   * sees the decision.
   */
  async function resolvePending(id: string, t: number): Promise<Resolution> {
    const row = await store.pendingAuthorizations.get(id, t);
    if (!row) return { status: 'expired' };
    if (row.status === 'pending' || row.status === 'fetched') return { status: row.status, row };
    if (!(await store.pendingAuthorizations.delete(row.id))) return { status: 'expired' };
    if (row.status === 'denied' || row.agentKeyId === null) {
      return {
        status: 'redirect',
        redirect: withParams(row.redirectUri, {
          error: 'access_denied',
          error_description: 'the request was denied on the device',
          state: row.state,
          iss: issuer,
        }),
      };
    }
    const code = randomToken(32);
    await store.oauthCodes.create({
      codeHash: await hashSecret(code),
      clientId: row.clientId,
      agentKeyId: row.agentKeyId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      scopes: row.scopes,
      resource: row.resource,
      createdAt: t,
      expiresAt: t + lifetimes.authorizationCode,
    });
    return {
      status: 'redirect',
      redirect: withParams(row.redirectUri, { code, state: row.state, iss: issuer }),
    };
  }

  const routes = new Hono();
  const publicCors = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 });

  // --- Metadata --------------------------------------------------------------------------------

  routes.use('/.well-known/*', publicCors);
  routes.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata));
  // RFC 9728 3.1: the path-inserted form for /mcp, and the bare form for clients that probe it.
  routes.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata));
  routes.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata));

  // --- Authorization endpoint ------------------------------------------------------------------

  routes.get('/authorize', async (c) => {
    const t = now();
    const params = singleParams(new URL(c.req.url).searchParams);
    if (params instanceof OAuthError) {
      return htmlPage(c, messagePage('Invalid request', params.description), 400);
    }
    const clientId = params.client_id;
    if (!clientId) return htmlPage(c, messagePage('Invalid request', 'client_id is missing'), 400);
    let client: Awaited<ReturnType<typeof loadClient>>;
    try {
      client = await loadClient(clientId, t);
    } catch (err) {
      const reason =
        err instanceof ClientMetadataError ? err.message : 'client could not be loaded';
      return htmlPage(c, messagePage('Unknown client', reason), 400);
    }
    if (params.redirect_uri === undefined && client.redirectUris.length !== 1) {
      return htmlPage(c, messagePage('Invalid request', 'redirect_uri is missing'), 400);
    }
    const redirectUri = params.redirect_uri ?? (client.redirectUris[0] as string);
    if (!matchRedirectUri(client.redirectUris, redirectUri)) {
      return htmlPage(
        c,
        messagePage('Invalid request', 'redirect_uri is not registered for this client'),
        400
      );
    }

    // From here errors go back to the client (RFC 6749 4.1.2.1).
    const state = params.state;
    const back = (error: string, description: string) =>
      c.redirect(
        withParams(redirectUri, { error, error_description: description, state, iss: issuer }),
        302
      );
    if (state !== undefined && state.length > 1024)
      return back('invalid_request', 'state too long');
    if (params.response_type !== 'code') {
      return back('unsupported_response_type', 'response_type must be code');
    }
    if (params.code_challenge_method !== 'S256') {
      return back('invalid_request', 'PKCE with code_challenge_method S256 is required');
    }
    if (!params.code_challenge || !isS256Challenge(params.code_challenge)) {
      return back('invalid_request', 'code_challenge must be a base64url SHA-256 digest');
    }
    if (params.resource !== undefined && params.resource !== resource) {
      return back('invalid_target', `the only resource is ${resource}`);
    }
    const scopes = parseScopes(params.scope);
    if (scopes instanceof OAuthError) return back(scopes.error, scopes.description);

    const id = randomToken(32);
    for (let attempt = 0; ; attempt++) {
      try {
        await store.pendingAuthorizations.create({
          id,
          userCode: generateUserCode(),
          clientId,
          redirectUri,
          state: state ?? null,
          codeChallenge: params.code_challenge,
          scopes: scopes.join(' '),
          resource,
          status: 'pending',
          createdAt: t,
          expiresAt: t + lifetimes.pendingAuthorization,
        });
        break;
      } catch (err) {
        // A user code collision (40 bits, a few live at a time) is vanishingly rare; retry it.
        if (attempt >= 3) throw err;
      }
    }
    // A page of its own, so reloading it does not start another authorization.
    return c.redirect(`/authorize/${id}`, 303);
  });

  routes.get('/authorize/:id/status', async (c) => {
    const r = await resolvePending(c.req.param('id'), now());
    const body =
      r.status === 'redirect'
        ? { status: r.status, redirect: r.redirect }
        : { status: r.status, ...(r.status === 'expired' ? {} : { expires_at: r.row.expiresAt }) };
    return c.json(body, 200, { ...noStore, 'Referrer-Policy': 'no-referrer' });
  });

  routes.get('/authorize/:id', async (c) => {
    const id = c.req.param('id');
    const r = await resolvePending(id, now());
    if (r.status === 'redirect') return c.redirect(r.redirect, 302);
    if (r.status === 'expired') {
      return htmlPage(
        c,
        messagePage(
          'Request expired',
          'This request expired or was used. Start again from the app.'
        ),
        404
      );
    }
    const client = await store.oauthClients.get(r.row.clientId);
    const userCode = formatUserCode(r.row.userCode);
    return htmlPage(
      c,
      authorizePage({
        userCode,
        qrUrl: `${origin}/approve?code=${userCode}`,
        clientName: client?.clientName ?? clientHost(r.row.clientId),
        clientHost: clientHost(r.row.clientId),
        statusPath: `/authorize/${id}/status`,
        expiresAt: r.row.expiresAt,
      })
    );
  });

  // What the QR opens when a plain browser or camera app follows it, rather than a qus.me device.
  routes.get('/approve', (c) => {
    const code = normalizeUserCode(c.req.query('code') ?? '');
    return htmlPage(c, approveHelpPage(code === undefined ? undefined : formatUserCode(code)));
  });

  // --- Token and revocation endpoints ----------------------------------------------------------

  routes.use('/token', publicCors);
  routes.use('/revoke', publicCors);

  async function formParams(c: Context): Promise<Record<string, string> | OAuthError> {
    const type = c.req.header('Content-Type') ?? '';
    if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return new OAuthError('invalid_request', 'expected application/x-www-form-urlencoded');
    }
    const text = await c.req.text();
    if (text.length > 16 * 1024) return new OAuthError('invalid_request', 'request too large');
    return singleParams(new URLSearchParams(text));
  }

  const tokenError = (c: Context, err: OAuthError) =>
    c.json(
      { error: err.error, error_description: err.description },
      err.status,
      err.status === 401 ? { ...noStore, 'WWW-Authenticate': 'Bearer' } : noStore
    );

  routes.post('/token', async (c) => {
    const t = now();
    const params = await formParams(c);
    if (params instanceof OAuthError) return tokenError(c, params);
    if (params.client_secret !== undefined || c.req.header('Authorization') !== undefined) {
      return tokenError(
        c,
        new OAuthError('invalid_client', 'only public clients are supported', 401)
      );
    }
    const clientId = params.client_id;
    if (!clientId) return tokenError(c, new OAuthError('invalid_request', 'client_id is missing'));
    if (params.resource !== undefined && params.resource !== resource) {
      return tokenError(c, new OAuthError('invalid_target', `the only resource is ${resource}`));
    }

    if (params.grant_type === 'authorization_code') {
      const { code, code_verifier: verifier, redirect_uri: redirectUri } = params;
      if (!code || !verifier || !redirectUri) {
        return tokenError(
          c,
          new OAuthError('invalid_request', 'code, code_verifier and redirect_uri are required')
        );
      }
      // Deleted as it is read, so a code redeems at most once, even under concurrent requests.
      const row = await store.oauthCodes.consume(await hashSecret(code), t);
      const invalid = new OAuthError('invalid_grant', 'authorization code is invalid or expired');
      if (!row) return tokenError(c, invalid);
      if (!timingSafeEqual(row.clientId, clientId) || row.redirectUri !== redirectUri) {
        return tokenError(c, invalid);
      }
      if (!(await verifyPkce(verifier, row.codeChallenge))) {
        return tokenError(c, new OAuthError('invalid_grant', 'PKCE verification failed'));
      }
      if (row.resource !== null && row.resource !== resource) return tokenError(c, invalid);
      if (!(await grantIsLive(row.agentKeyId))) return tokenError(c, invalid);
      const body = await issueTokens(row, t);
      return c.json(body, 200, noStore);
    }

    if (params.grant_type === 'refresh_token') {
      const presented = params.refresh_token;
      if (!presented) {
        return tokenError(c, new OAuthError('invalid_request', 'refresh_token is required'));
      }
      const invalid = new OAuthError('invalid_grant', 'refresh token is invalid or expired');
      const hash = await hashSecret(presented);
      const found = await store.oauthTokens.find(hash);
      if (found?.kind !== 'refresh' || !timingSafeEqual(found.clientId, clientId)) {
        return tokenError(c, invalid);
      }
      // Revoked in one statement, so only one of two concurrent refreshes wins.
      const current = await store.oauthTokens.revoke(hash, t);
      if (!current) {
        // A rotated-out refresh token presented again: someone holds a copy. OAuth 2.1 4.3.1
        // says to revoke the grant, which here is every token of the agent key.
        await store.oauthTokens.revokeByAgentKey(found.agentKeyId, t);
        return tokenError(c, invalid);
      }
      if (current.expiresAt <= t) return tokenError(c, invalid);
      if (params.scope !== undefined) {
        const asked = parseScopes(params.scope);
        if (asked instanceof OAuthError) return tokenError(c, asked);
        const granted = current.scopes.split(' ');
        if (!asked.every((s) => granted.includes(s))) {
          return tokenError(c, new OAuthError('invalid_scope', 'scope exceeds the grant'));
        }
      }
      if (!(await grantIsLive(current.agentKeyId))) return tokenError(c, invalid);
      const body = await issueTokens(current, t);
      return c.json(body, 200, noStore);
    }

    return tokenError(
      c,
      new OAuthError(
        'unsupported_grant_type',
        'grant_type must be authorization_code or refresh_token'
      )
    );
  });

  // RFC 7009. Answers 200 for an unknown token too. Revoking a refresh token revokes the grant.
  routes.post('/revoke', async (c) => {
    const t = now();
    const params = await formParams(c);
    if (params instanceof OAuthError) return tokenError(c, params);
    if (!params.token) return tokenError(c, new OAuthError('invalid_request', 'token is missing'));
    if (!params.client_id) {
      return tokenError(c, new OAuthError('invalid_request', 'client_id is missing'));
    }
    const found = await store.oauthTokens.find(await hashSecret(params.token));
    if (found && timingSafeEqual(found.clientId, params.client_id)) {
      if (found.kind === 'refresh') await store.oauthTokens.revokeByAgentKey(found.agentKeyId, t);
      else await store.oauthTokens.revoke(found.tokenHash, t);
    }
    return c.body(null, 200, noStore);
  });

  // --- Device side (NIP-98 as the queue key) ---------------------------------------------------

  const device = new Hono<Nip98Env>();
  device.use('*', requireNip98);

  const deviceError = (
    c: Context,
    status: 400 | 404 | 409 | 502,
    error: string,
    description: string
  ) => c.json({ error, error_description: description }, status, noStore);

  /** The authorization the signing queue fetched, by code, or a reason it is not available. */
  async function fetchedBy(code: string, pubkey: string, t: number) {
    const userCode = normalizeUserCode(code);
    if (userCode === undefined) return undefined;
    const row = await store.pendingAuthorizations.getByUserCode(userCode, t);
    // A request another queue fetched is reported as missing, not as taken.
    if (!row || (row.queuePubkey !== null && row.queuePubkey !== pubkey)) return undefined;
    return row;
  }

  async function describe(row: PendingAuthorization, agentPubkey: string) {
    const client = await store.oauthClients.get(row.clientId);
    return {
      user_code: formatUserCode(row.userCode),
      status: row.status,
      client_id: row.clientId,
      client_name: client?.clientName ?? clientHost(row.clientId),
      client_host: clientHost(row.clientId),
      redirect_host: redirectHost(row.redirectUri),
      scopes: row.scopes.split(' '),
      resource: row.resource,
      agent_pubkey: agentPubkey,
      expires_at: row.expiresAt,
    };
  }

  // 8.2 step 3: fetching the request mints the agent key. Fetching again from the same queue
  // returns the same key; no other queue can fetch it after that.
  device.get('/authorizations/:code', async (c) => {
    const t = now();
    const pubkey = c.var.pubkey;
    const row = await fetchedBy(c.req.param('code'), pubkey, t);
    if (!row) return deviceError(c, 404, 'not_found', 'no such pending authorization');
    if (row.status === 'approved' || row.status === 'denied') {
      return deviceError(c, 409, 'already_decided', `the request was already ${row.status}`);
    }
    if (row.status === 'fetched' && row.agentKeyId !== null) {
      const key = await custody.get(row.agentKeyId);
      if (!key) return deviceError(c, 404, 'not_found', 'no such pending authorization');
      return c.json(await describe(row, key.pubkey), 200, noStore);
    }
    const key = await custody.mint({ clientId: row.clientId, now: t });
    const fetched = await store.pendingAuthorizations.markFetched(
      row.id,
      { agentKeyId: key.id, queuePubkey: pubkey },
      t
    );
    if (!fetched) {
      // Another fetch won, or the request expired meanwhile: this key belongs to nothing.
      await custody.destroy(key.id);
      const again = await fetchedBy(c.req.param('code'), pubkey, t);
      if (again?.status === 'fetched' && again.agentKeyId !== null) {
        const winner = await custody.get(again.agentKeyId);
        if (winner) return c.json(await describe(again, winner.pubkey), 200, noStore);
      }
      return deviceError(c, 404, 'not_found', 'no such pending authorization');
    }
    return c.json(await describe(fetched, key.pubkey), 200, noStore);
  });

  async function readJson(c: Context): Promise<Record<string, unknown> | undefined> {
    try {
      const text = await c.req.text();
      if (text.length > 16 * 1024) return undefined;
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** The newest submitters list signed by the queue key among `events` (NIP-01 replaceable). */
  function latestSubmitters(events: unknown[], queuePubkey: string) {
    let best: { id: string; createdAt: number; submitters: string[] } | undefined;
    for (const event of events) {
      const parsed = parseSubmittersPublic(event, { queuePubkey });
      if (!parsed.ok) continue;
      const list = parsed.value;
      if (
        !best ||
        list.createdAt > best.createdAt ||
        (list.createdAt === best.createdAt && list.id < best.id)
      ) {
        best = list;
      }
    }
    return best;
  }

  // 8.2 steps 4 and 5: the device has published the submitters list and grant and names the
  // queue's storage relays; the service checks the list there before approving.
  device.post('/authorizations/:code/approve', async (c) => {
    const t = now();
    const pubkey = c.var.pubkey;
    const body = await readJson(c);
    if (!body) return deviceError(c, 400, 'invalid_request', 'expected a JSON object');
    const relays = checkStorageRelays(body.relays);
    if (typeof relays === 'string') return deviceError(c, 400, 'invalid_request', relays);
    const row = await fetchedBy(c.req.param('code'), pubkey, t);
    if (!row) return deviceError(c, 404, 'not_found', 'no such pending authorization');
    if (row.status !== 'fetched' || row.agentKeyId === null) {
      return deviceError(c, 409, 'invalid_state', `the request is ${row.status}, not fetched`);
    }
    const agentKeyId = row.agentKeyId;
    const key = await custody.get(agentKeyId);
    if (!key || key.revokedAt !== null) {
      return deviceError(c, 404, 'not_found', 'no such pending authorization');
    }

    let events: unknown[];
    try {
      const auth: Signer = custody.signer(agentKeyId);
      events = await relayReader.query({
        relays,
        filter: { kinds: [...SUBMITTERS_KINDS], authors: [pubkey], limit: 1 },
        auth,
      });
    } catch {
      return deviceError(c, 502, 'relay_unavailable', 'the storage relays could not be read');
    }
    const list = latestSubmitters(events, pubkey);
    if (!list) {
      return deviceError(
        c,
        409,
        'submitters_list_not_found',
        'no submitters list signed by this queue was found on the named relays'
      );
    }
    if (!list.submitters.includes(key.pubkey)) {
      return deviceError(
        c,
        409,
        'agent_not_in_submitters_list',
        "the queue's current submitters list does not name the agent key"
      );
    }

    const client = await store.oauthClients.get(row.clientId);
    // The binding first, so a browser that sees the approval finds it; undone if the decision
    // loses (the request expired or was decided meanwhile). A binding left by an approval that
    // stopped halfway belongs to this same key, so it is replaced.
    await store.bindings.delete(agentKeyId);
    await store.bindings.create({
      agentKeyId,
      queuePubkey: pubkey,
      clientLabel: client?.clientName ?? clientHost(row.clientId),
      storageRelays: relays,
      createdAt: t,
      updatedAt: t,
    });
    const decided = await store.pendingAuthorizations.decide(row.id, 'approved', t);
    if (!decided) {
      await store.bindings.delete(agentKeyId);
      return deviceError(c, 409, 'invalid_state', 'the request expired or was already decided');
    }
    return c.json({ status: 'approved', agent_pubkey: key.pubkey }, 200, noStore);
  });

  // 8.2 step 4: a denial destroys the minted key.
  device.post('/authorizations/:code/deny', async (c) => {
    const t = now();
    const row = await fetchedBy(c.req.param('code'), c.var.pubkey, t);
    if (!row) return deviceError(c, 404, 'not_found', 'no such pending authorization');
    if (row.status !== 'fetched' || row.agentKeyId === null) {
      return deviceError(c, 409, 'invalid_state', `the request is ${row.status}, not fetched`);
    }
    const decided = await store.pendingAuthorizations.decide(row.id, 'denied', t);
    if (!decided) return deviceError(c, 409, 'invalid_state', 'the request was already decided');
    await custody.destroy(row.agentKeyId);
    return c.json({ status: 'denied' }, 200, noStore);
  });

  // The agents bound to the signing queue, for a device's revocation screen.
  device.get('/bindings', async (c) => {
    const rows = await store.bindings.listByQueue(c.var.pubkey);
    const out = [];
    for (const b of rows) {
      const key = await store.agentKeys.get(b.agentKeyId);
      if (!key || key.revokedAt !== null) continue;
      out.push({
        agent_pubkey: key.pubkey,
        client_id: key.clientId,
        client_name: b.clientLabel,
        client_host: clientHost(key.clientId),
        relays: b.storageRelays,
        created_at: b.createdAt,
      });
    }
    return c.json({ bindings: out }, 200, noStore);
  });

  // Revocation from a device (spec 8.2, "Revocation"): the binding, every token and the agent
  // key's ciphertext go. The submitters list on the relays is the device's to update.
  device.delete('/bindings/:agentPubkey', async (c) => {
    const t = now();
    const agentPubkey = c.req.param('agentPubkey').toLowerCase();
    const key = /^[0-9a-f]{64}$/.test(agentPubkey)
      ? await store.agentKeys.getByPubkey(agentPubkey)
      : undefined;
    const binding = key && (await store.bindings.get(key.id));
    if (!key || !binding || binding.queuePubkey !== c.var.pubkey) {
      return deviceError(c, 404, 'not_found', 'no such binding for this queue');
    }
    await store.bindings.revoke(key.id, t);
    const tokens = await store.oauthTokens.revokeByAgentKey(key.id, t);
    await custody.revoke(key.id, t);
    return c.json(
      { status: 'revoked', agent_pubkey: key.pubkey, tokens_revoked: tokens },
      200,
      noStore
    );
  });

  routes.route('/device', device);

  // --- Bearer check for /mcp -------------------------------------------------------------------

  const challenge = (error?: string, description?: string, scope?: string) =>
    [
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
      `scope="${scope ?? SCOPES_SUPPORTED.join(' ')}"`,
      ...(error ? [`error="${error}"`] : []),
      ...(description ? [`error_description="${description}"`] : []),
    ].join(', ');

  /**
   * Requires `Authorization: Bearer <access token>` and resolves it through token, agent key and
   * binding to the queue (spec 8.5: tokens do not store the queue). Handlers read `c.var.agent`.
   * Failures are 401 with the RFC 9728 `resource_metadata` challenge MCP clients start from.
   */
  function requireBearer(scope: string = SCOPE_SUBMIT) {
    return createMiddleware<McpAuthEnv>(async (c, next) => {
      const header = c.req.header('Authorization');
      const match = header === undefined ? null : /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
      if (!match) {
        return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': challenge() });
      }
      const t = now();
      const invalid = () =>
        c.json({ error: 'invalid_token' }, 401, {
          'WWW-Authenticate': challenge('invalid_token', 'the access token is invalid or expired'),
        });
      const token = await store.oauthTokens.get(await hashSecret(match[1] as string), t);
      if (token?.kind !== 'access') return invalid();
      const live = await grantIsLive(token.agentKeyId);
      if (!live) return invalid();
      const scopes = token.scopes.split(' ');
      if (!scopes.includes(scope)) {
        return c.json({ error: 'insufficient_scope' }, 403, {
          'WWW-Authenticate': challenge('insufficient_scope', undefined, scope),
        });
      }
      c.set('agent', {
        agentKeyId: token.agentKeyId,
        agentPubkey: live.key.pubkey,
        clientId: token.clientId,
        scopes,
        queuePubkey: live.binding.queuePubkey,
        storageRelays: live.binding.storageRelays,
      });
      await next();
    });
  }

  /** CORS for /mcp, so browser-based MCP clients can read the 401 challenge and send a token. */
  const mcpCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
    maxAge: 600,
  });

  return { routes, requireBearer, mcpCors, resource, issuer };
}

export type OAuth = ReturnType<typeof createOAuth>;
