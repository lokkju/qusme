import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  buildAgentGrant,
  buildHttpAuth,
  buildSubmittersList,
  createLocalSigner,
  httpAuthHeader,
  type NostrEvent,
  openSubmission,
  type Signer,
} from '@qusme/nostr';
import type { QusmeDb, Store } from '@qusme/store-sql';
import { Hono } from 'hono';
import { generateSecretKey } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentAuth,
  createAgentKeyRing,
  createApp,
  createOAuth,
  createWebSocketRelayPublisher,
  type McpAuthEnv,
  type RelayQuery,
  type RelayReader,
} from '../../src/index.ts';
import { s256 } from '../../src/oauth/secrets.ts';
import { fakeInboxRelay } from '../mcp/fakes.ts';

/** A fresh, migrated, empty store on one driver. */
export interface Harness {
  store: Store;
  db: QusmeDb;
}

const ORIGIN = 'https://app.qus.me';
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = 'https://client.example/oauth/client-metadata.json';
const REDIRECT = 'https://client.example/oauth/callback';
const LOOPBACK = 'http://127.0.0.1/callback';
const RELAYS = ['wss://relay.example/', 'wss://relay2.example/'];
const VERIFIER = 'vvvvvvvvvvvvvvvvvvvv-._~0123456789abcdefghijklmnop';
const ring = createAgentKeyRing({ secret: btoa('q'.repeat(32)) });

const clientDocument = {
  client_id: CLIENT_ID,
  client_name: 'Example Agent',
  redirect_uris: [REDIRECT, LOOPBACK],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

/** A fake of the network: the client's metadata document and the storage relays. */
function fakes() {
  const fetched: string[] = [];
  const relayEvents = new Map<string, NostrEvent[]>();
  const queries: { query: RelayQuery; authPubkey: string | undefined }[] = [];
  const fetch = async (input: string): Promise<Response> => {
    fetched.push(input);
    if (input !== CLIENT_ID) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(clientDocument), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const relayReader: RelayReader = {
    async query(query) {
      queries.push({ query, authPubkey: await query.auth?.getPublicKey() });
      return query.relays.flatMap((r) =>
        (relayEvents.get(r) ?? []).filter(
          (e) =>
            (query.filter.kinds ?? []).includes(e.kind) &&
            (query.filter.authors ?? []).includes(e.pubkey)
        )
      );
    },
  };
  /** What a device does on approval: publish the list to the queue's storage relays. */
  const publish = (event: NostrEvent, relays = RELAYS) => {
    for (const r of relays) relayEvents.set(r, [...(relayEvents.get(r) ?? []), event]);
  };
  return { fetch, fetched, relayReader, queries, publish };
}

/** OAuth flow against the app on one driver: client, browser page, device and MCP request. */
export function oauthFlowSuite(driver: string, setup: () => { fresh(): Promise<Harness> }) {
  // Each test runs several authorizations end to end; D1 through Miniflare is slow under a full
  // parallel run, so the default 5 s is not enough.
  describe(`OAuth for MCP clients on ${driver}`, { timeout: 30_000 }, () => {
    const { fresh } = setup();
    let h: Harness;
    let net: ReturnType<typeof fakes>;
    let clock: number;
    let app: ReturnType<typeof createApp>;
    let queue: Signer;
    let queuePubkey: string;
    let challenge: string;
    let requestCount = 0;
    let requestBase = 0;
    let approvedAgents: string[] = [];

    const overrides = () => ({
      fetch: net.fetch,
      relayReader: net.relayReader,
      now: () => clock,
    });

    beforeEach(async () => {
      h = await fresh();
      net = fakes();
      approvedAgents = [];
      requestCount = 0;
      requestBase = Math.floor(Date.now() / 1000);
      clock = Math.floor(Date.now() / 1000);
      queue = createLocalSigner(generateSecretKey());
      queuePubkey = await queue.getPublicKey();
      challenge = await s256(VERIFIER);
      app = createApp({
        version: 'test',
        db: h.db,
        agentKeys: ring,
        publicOrigin: ORIGIN,
        oauth: overrides(),
      });
    });

    /** A NIP-98 request from a device holding `signer` (the queue key by default). */
    async function device(
      method: string,
      path: string,
      body?: unknown,
      signer: Signer = queue
    ): Promise<Response> {
      const text = body === undefined ? undefined : JSON.stringify(body);
      // Each request in a test gets its own created_at, counting back from the test's start, so
      // two identical requests are two events and not a replay; all stay inside NIP-98's window.
      const event = await buildHttpAuth(
        signer,
        { url: ORIGIN + path, method, body: text },
        { now: requestBase - requestCount++ }
      );
      const headers: Record<string, string> = { Authorization: httpAuthHeader(event) };
      if (text !== undefined) headers['Content-Type'] = 'application/json';
      return app.request(path, { method, headers, body: text });
    }

    function authorizeUrl(params: Record<string, string | undefined> = {}): string {
      const all: Record<string, string | undefined> = {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'opaque-state',
        resource: RESOURCE,
        scope: 'drafts:submit',
        ...params,
      };
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v);
      return `/authorize?${q}`;
    }

    /** Starts an authorization; returns the page path, status path and user code. */
    async function start(params: Record<string, string | undefined> = {}) {
      const res = await app.request(authorizeUrl(params));
      expect(res.status).toBe(303);
      const page = res.headers.get('Location') ?? '';
      expect(page).toMatch(/^\/authorize\/[A-Za-z0-9_-]{43}$/);
      const html = await (await app.request(page)).text();
      const code = /class="code"[^>]*>([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(html)?.[1];
      if (!code) throw new Error('no user code on the page');
      return { page, status: `${page}/status`, code };
    }

    async function status(path: string) {
      return (await (await app.request(path)).json()) as {
        status: string;
        redirect?: string;
      };
    }

    async function fetchOnDevice(code: string) {
      const res = await device('GET', `/device/authorizations/${code}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { agent_pubkey: string; client_name: string; scopes: string[] };
    }

    async function publishList(agents: string[], createdAt = clock) {
      const labels = Object.fromEntries(
        agents.map((a) => [a, { label: 'Example Agent', authorized_at: createdAt }])
      );
      net.publish(await buildSubmittersList(queue, labels, { createdAt }));
    }

    async function approve(code: string) {
      return device('POST', `/device/authorizations/${code}/approve`, { relays: RELAYS });
    }

    function token(params: Record<string, string>) {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    }

    async function exchange(code: string, extra: Record<string, string> = {}) {
      return token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: VERIFIER,
        resource: RESOURCE,
        ...extra,
      });
    }

    /** Runs the flow to an authorization code. */
    async function authorized(params: Record<string, string | undefined> = {}) {
      const s = await start(params);
      const fetched = await fetchOnDevice(s.code);
      // As a device does: the new list keeps the agents approved before and adds this one.
      approvedAgents.push(fetched.agent_pubkey);
      await publishList(approvedAgents, clock + approvedAgents.length);
      expect((await approve(s.code)).status).toBe(200);
      const done = await status(s.status);
      expect(done.status).toBe('redirect');
      const redirect = new URL(done.redirect ?? '');
      return { ...s, agentPubkey: fetched.agent_pubkey, redirect };
    }

    async function tokens(params: Record<string, string | undefined> = {}) {
      const a = await authorized(params);
      const res = await exchange(a.redirect.searchParams.get('code') ?? '', {
        redirect_uri: params.redirect_uri ?? REDIRECT,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { access_token: string; refresh_token: string };
      return { ...a, ...body };
    }

    /** A 2025-era `tools/list` on /mcp, which needs nothing but a valid token. */
    const mcp = (accessToken?: string) =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });

    /** What the bearer middleware resolves a token to, through a probe route on the same store. */
    async function resolve(accessToken: string): Promise<AgentAuth | number> {
      const probe = new Hono<McpAuthEnv>();
      const oauth = createOAuth({
        db: h.db,
        agentKeys: ring,
        publicOrigin: ORIGIN,
        ...overrides(),
      });
      probe.get('/probe', oauth.requireBearer(), (c) => c.json(c.var.agent));
      const res = await probe.request('/probe', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return res.status === 200 ? ((await res.json()) as AgentAuth) : res.status;
    }

    it('serves authorization server and protected resource metadata', async () => {
      const as = (await (
        await app.request('/.well-known/oauth-authorization-server')
      ).json()) as Record<string, unknown>;
      expect(as).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        revocation_endpoint: `${ORIGIN}/revoke`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        client_id_metadata_document_supported: true,
      });
      expect(as).not.toHaveProperty('registration_endpoint');
      for (const path of [
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-protected-resource',
      ]) {
        const res = await app.request(path);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await res.json()).toMatchObject({
          resource: RESOURCE,
          authorization_servers: [ORIGIN],
          scopes_supported: ['drafts:submit'],
        });
      }
    });

    it('answers /mcp without a token with the RFC 9728 challenge', async () => {
      const res = await mcp();
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="drafts:submit"`
      );
      const bad = await mcp('qat_not-a-token');
      expect(bad.status).toBe(401);
      expect(bad.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
      const pre = await app.request('/mcp', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:6274',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
        'authorization'
      );
    });

    it('runs the whole flow: metadata, authorize, device approval, tokens, /mcp, refresh, revoke', async () => {
      // The client's metadata document is fetched when it first authorizes, and cached.
      const s = await start();
      expect(net.fetched).toEqual([CLIENT_ID]);
      const cached = await h.store.oauthClients.get(CLIENT_ID);
      expect(cached).toMatchObject({ clientName: 'Example Agent', fetchedAt: clock });

      const html = await (await app.request(s.page)).text();
      expect(html).toContain('Example Agent');
      expect(html).toContain('client.example');
      expect(html).toContain('<svg');
      expect(html).not.toContain('<form');
      expect(await status(s.status)).toMatchObject({ status: 'pending' });

      // The device fetches the request: the agent key is minted now (spec 8.2 step 3).
      const fetched = await fetchOnDevice(s.code);
      expect(fetched).toMatchObject({
        client_id: CLIENT_ID,
        client_name: 'Example Agent',
        client_host: 'client.example',
        redirect_host: 'client.example',
        scopes: ['drafts:submit'],
      });
      expect(fetched.agent_pubkey).toMatch(/^[0-9a-f]{64}$/);
      const key = await h.store.agentKeys.getByPubkey(fetched.agent_pubkey);
      expect(key?.clientId).toBe(CLIENT_ID);
      expect(await status(s.status)).toMatchObject({ status: 'fetched' });
      // Fetching again from the same queue returns the same key, not a second one.
      expect((await fetchOnDevice(s.code)).agent_pubkey).toBe(fetched.agent_pubkey);

      // Approval fails until the queue's submitters list on the relays names the agent key.
      const none = await approve(s.code);
      expect(none.status).toBe(409);
      expect(await none.json()).toMatchObject({ error: 'submitters_list_not_found' });
      await publishList(['a'.repeat(64)], clock - 10);
      const missing = await approve(s.code);
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ error: 'agent_not_in_submitters_list' });
      expect(await status(s.status)).toMatchObject({ status: 'fetched' });

      await publishList(['a'.repeat(64), fetched.agent_pubkey], clock);
      const ok = await approve(s.code);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: 'approved', agent_pubkey: fetched.agent_pubkey });
      // The relays were read for this queue's list, authenticating as the agent key (9.2).
      const last = net.queries.at(-1);
      expect(last?.query.relays).toEqual(RELAYS);
      expect(last?.query.filter).toMatchObject({ kinds: [11235], authors: [queuePubkey] });
      expect(last?.authPubkey).toBe(fetched.agent_pubkey);

      // The waiting page gets the redirect with the code, once.
      const done = await status(s.status);
      expect(done.status).toBe('redirect');
      const redirect = new URL(done.redirect ?? '');
      expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
      expect(redirect.searchParams.get('state')).toBe('opaque-state');
      expect(redirect.searchParams.get('iss')).toBe(ORIGIN);
      const code = redirect.searchParams.get('code') ?? '';
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await status(s.status)).toEqual({ status: 'expired' });

      // Token exchange with PKCE; only hashes are stored.
      const res = await exchange(code);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const issued = (await res.json()) as Record<string, string | number>;
      expect(issued).toMatchObject({
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'drafts:submit',
      });
      const access = issued.access_token as string;
      const refresh = issued.refresh_token as string;
      expect(access).toMatch(/^qat_/);
      expect(refresh).toMatch(/^qrt_/);
      const dump = JSON.stringify(await h.store.oauthTokens.listByAgentKey(key?.id ?? '', clock));
      expect(dump).not.toContain(access);
      expect(dump).not.toContain(refresh);

      // /mcp: past the bearer check to the tools, bound to this queue through the agent key.
      expect((await mcp(access)).status).toBe(200);
      expect(await resolve(access)).toEqual({
        agentKeyId: key?.id,
        agentPubkey: fetched.agent_pubkey,
        clientId: CLIENT_ID,
        scopes: ['drafts:submit'],
        queuePubkey,
        storageRelays: RELAYS,
      });

      // Refresh rotates the refresh token.
      const refreshed = await token({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: CLIENT_ID,
      });
      expect(refreshed.status).toBe(200);
      const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
      expect(next.refresh_token).not.toBe(refresh);
      expect((await mcp(next.access_token)).status).toBe(200);

      // The device lists and revokes the binding; every token stops working.
      const list = await device('GET', '/device/bindings');
      expect(await list.json()).toEqual({
        bindings: [
          {
            agent_pubkey: fetched.agent_pubkey,
            client_id: CLIENT_ID,
            client_name: 'Example Agent',
            client_host: 'client.example',
            relays: RELAYS,
            created_at: clock,
          },
        ],
      });
      const other = createLocalSigner(generateSecretKey());
      const foreign = await device(
        'DELETE',
        `/device/bindings/${fetched.agent_pubkey}`,
        undefined,
        other
      );
      expect(foreign.status).toBe(404);
      const revoked = await device('DELETE', `/device/bindings/${fetched.agent_pubkey}`);
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ status: 'revoked', tokens_revoked: 3 });
      expect((await mcp(access)).status).toBe(401);
      expect((await mcp(next.access_token)).status).toBe(401);
      const after = await token({
        grant_type: 'refresh_token',
        refresh_token: next.refresh_token,
        client_id: CLIENT_ID,
      });
      expect(after.status).toBe(400);
      const row = await h.store.agentKeys.get(key?.id ?? '');
      expect(row?.revokedAt).toBe(clock);
      expect(row?.encryptedSecretKey).toBeNull();
      expect(await (await device('GET', '/device/bindings')).json()).toEqual({ bindings: [] });
    });

    it('destroys the agent key when the device denies, and tells the client', async () => {
      const s = await start();
      const fetched = await fetchOnDevice(s.code);
      const res = await device('POST', `/device/authorizations/${s.code}/deny`);
      expect(res.status).toBe(200);
      expect(await h.store.agentKeys.getByPubkey(fetched.agent_pubkey)).toBeUndefined();
      const done = await status(s.status);
      const redirect = new URL(done.redirect ?? '');
      expect(redirect.searchParams.get('error')).toBe('access_denied');
      expect(redirect.searchParams.get('state')).toBe('opaque-state');
      expect(redirect.searchParams.has('code')).toBe(false);
      expect((await approve(s.code)).status).toBe(404);
    });

    it('leaves no live agent key when a fetched request expires', async () => {
      const s = await start();
      const fetched = await fetchOnDevice(s.code);
      await publishList([fetched.agent_pubkey]);
      clock += 10 * 60 + 1;
      expect((await approve(s.code)).status).toBe(404);
      expect(await status(s.status)).toEqual({ status: 'expired' });
      const swept = await h.store.sweepExpired(clock);
      expect(swept.agentKeys).toBe(1);
      expect(await h.store.agentKeys.getByPubkey(fetched.agent_pubkey)).toBeUndefined();
    });

    it('lets only the queue that fetched a request see or decide it', async () => {
      const s = await start();
      await fetchOnDevice(s.code);
      const other = createLocalSigner(generateSecretKey());
      const path = `/device/authorizations/${s.code}`;
      expect((await device('GET', path, undefined, other)).status).toBe(404);
      expect((await device('POST', `${path}/deny`, undefined, other)).status).toBe(404);
      expect((await app.request(path)).status).toBe(401);
      // Codes are read the way people type them.
      const typed = s.code.toLowerCase().replace('-', ' ');
      expect(
        (await device('GET', `/device/authorizations/${encodeURIComponent(typed)}`)).status
      ).toBe(200);
    });

    it('refuses an approval naming unusable relays', async () => {
      const s = await start();
      await fetchOnDevice(s.code);
      for (const relays of [
        [],
        ['https://relay.example/'],
        ['wss://127.0.0.1/'],
        'wss://x.example',
      ]) {
        const res = await device('POST', `/device/authorizations/${s.code}/approve`, { relays });
        expect(res.status).toBe(400);
      }
      expect(net.queries).toEqual([]);
    });

    it('requires PKCE S256 and refuses plain', async () => {
      for (const params of [
        { code_challenge_method: 'plain' },
        { code_challenge_method: undefined },
        { code_challenge: undefined },
        { code_challenge: 'short' },
      ]) {
        const res = await app.request(authorizeUrl(params));
        expect(res.status).toBe(302);
        const to = new URL(res.headers.get('Location') ?? '');
        expect(to.origin + to.pathname).toBe(REDIRECT);
        expect(to.searchParams.get('error')).toBe('invalid_request');
        expect(to.searchParams.get('state')).toBe('opaque-state');
      }
    });

    it('sends other request errors back to the client', async () => {
      const cases: [Record<string, string | undefined>, string][] = [
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
        [{ scope: 'drafts:read' }, 'invalid_scope'],
      ];
      for (const [params, error] of cases) {
        const res = await app.request(authorizeUrl(params));
        const to = new URL(res.headers.get('Location') ?? '');
        expect(to.searchParams.get('error')).toBe(error);
      }
    });

    it('never redirects to an unregistered redirect_uri', async () => {
      for (const redirect_uri of [
        'https://evil.example/cb',
        `${REDIRECT}/extra`,
        `${REDIRECT}?x=1`,
        'http://127.0.0.1/other',
        'http://192.168.1.10/callback',
      ]) {
        const res = await app.request(authorizeUrl({ redirect_uri }));
        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBeNull();
      }
      // A client that cannot be loaded gets a page, not a redirect.
      const unknown = await app.request(
        authorizeUrl({ client_id: 'https://client.example/other.json' })
      );
      expect(unknown.status).toBe(400);
      expect(unknown.headers.get('Location')).toBeNull();
      const repeated = await app.request(`${authorizeUrl()}&state=again`);
      expect(repeated.status).toBe(400);
    });

    it('lets a loopback redirect_uri use any port', async () => {
      const a = await tokens({ redirect_uri: 'http://127.0.0.1:53682/callback' });
      expect(a.redirect.origin).toBe('http://127.0.0.1:53682');
    });

    it('uses the cached client metadata document until it is stale', async () => {
      await start();
      await start();
      expect(net.fetched).toHaveLength(1);
      clock += 60 * 60;
      await start();
      expect(net.fetched).toHaveLength(2);
    });

    it('redeems an authorization code once, with the right verifier and redirect_uri', async () => {
      const a = await authorized();
      const code = a.redirect.searchParams.get('code') ?? '';
      expect((await exchange(code)).status).toBe(200);
      const again = await exchange(code);
      expect(again.status).toBe(400);
      expect(await again.json()).toMatchObject({ error: 'invalid_grant' });

      const wrong: Record<string, string>[] = [
        { code_verifier: 'w'.repeat(43) },
        { redirect_uri: LOOPBACK },
        { client_id: 'https://client.example/other.json' },
      ];
      for (const extra of wrong) {
        const b = await authorized();
        const res = await exchange(b.redirect.searchParams.get('code') ?? '', extra);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
      }
      const c = await authorized();
      const wrongResource = await exchange(c.redirect.searchParams.get('code') ?? '', {
        resource: 'https://other.example/mcp',
      });
      expect(await wrongResource.json()).toMatchObject({ error: 'invalid_target' });
    });

    it('refuses an expired authorization code', async () => {
      const a = await authorized();
      clock += 61;
      const res = await exchange(a.redirect.searchParams.get('code') ?? '');
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('revokes the grant when a rotated-out refresh token comes back', async () => {
      const t = await tokens();
      const first = await token({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: CLIENT_ID,
      });
      const next = (await first.json()) as { access_token: string; refresh_token: string };
      const replay = await token({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: CLIENT_ID,
      });
      expect(replay.status).toBe(400);
      expect((await mcp(next.access_token)).status).toBe(401);
      const later = await token({
        grant_type: 'refresh_token',
        refresh_token: next.refresh_token,
        client_id: CLIENT_ID,
      });
      expect(later.status).toBe(400);
    });

    it('refuses an access token at the token endpoint and a refresh token at /mcp', async () => {
      const t = await tokens();
      const res = await token({
        grant_type: 'refresh_token',
        refresh_token: t.access_token,
        client_id: CLIENT_ID,
      });
      expect(res.status).toBe(400);
      expect((await mcp(t.refresh_token)).status).toBe(401);
      expect((await mcp(t.access_token)).status).toBe(200);
    });

    it('expires access tokens', async () => {
      const t = await tokens();
      clock += 3600;
      expect((await mcp(t.access_token)).status).toBe(401);
    });

    it('revokes through the RFC 7009 endpoint', async () => {
      const t = await tokens();
      const revoke = (tok: string, client_id = CLIENT_ID) =>
        app.request('/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tok, client_id }).toString(),
        });
      expect((await revoke('qat_unknown')).status).toBe(200);
      // Another client's request changes nothing.
      expect((await revoke(t.access_token, 'https://other.example/c.json')).status).toBe(200);
      expect((await mcp(t.access_token)).status).toBe(200);
      expect((await revoke(t.refresh_token)).status).toBe(200);
      expect((await mcp(t.access_token)).status).toBe(401);
    });

    it('submits a draft end to end: token, /mcp create_draft, a wrap on the inbox relay', async () => {
      const relay = fakeInboxRelay({ requireAuth: true });
      app = createApp({
        version: 'test',
        db: h.db,
        agentKeys: ring,
        publicOrigin: ORIGIN,
        oauth: overrides(),
        mcp: { relayPublisher: createWebSocketRelayPublisher({ WebSocket: relay.WebSocket }) },
      });
      const t = await tokens();
      // What the device publishes with the approval: the grant, encrypted to the agent.
      const inboxKey = createLocalSigner(generateSecretKey());
      const inboxPubkey = await inboxKey.getPublicKey();
      net.publish(
        await buildAgentGrant(
          queue,
          t.agentPubkey,
          {
            inbox: ['wss://inbox.example/'],
            inbox_pubkey: inboxPubkey,
            destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
            quota: { max_submissions: 10, period: 'day' },
          },
          { createdAt: clock }
        )
      );

      const client = new Client({ name: 'flow-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(RESOURCE), {
          fetch: async (url, init) => app.request(String(url), init),
          requestInit: { headers: { Authorization: `Bearer ${t.access_token}` } },
        })
      );
      const res = (await client.callTool({
        name: 'create_draft',
        arguments: { site: 'x', account: 'lokkju', field: 'text', value: 'hello, queue' },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({
        created_at: clock,
        expires_at: clock + 30 * 86_400,
        relays: ['wss://inbox.example/'],
      });

      // The inbox relay holds exactly the wrap the receipt names, addressed to the inbox key.
      expect(relay.stored).toHaveLength(1);
      const wrap = relay.stored[0];
      expect(wrap?.id).toBe(res.structuredContent?.gift_wrap_id);
      expect(wrap?.tags.filter((tag) => tag[0] === 'p')).toEqual([['p', inboxPubkey]]);
      // It authenticated there as a key of its own, not as the agent.
      expect(relay.connections[0]?.authed).toHaveLength(1);
      expect(relay.connections[0]?.authed[0]).not.toBe(t.agentPubkey);

      // The device opens it with the inbox key: the exact rumor, sealed by the agent key.
      const opened = await openSubmission(wrap, inboxKey);
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.submitter).toBe(t.agentPubkey);
      expect(opened.value.value).toEqual({
        createdAt: clock,
        site: 'x',
        account: 'lokkju',
        field: 'text',
        content: 'hello, queue',
        validation: { counter: 'default', length: 12, ok: true },
        reserved: [],
      });
      expect(opened.value.ignoredTags).toEqual([]);

      const listed = (await client.callTool({ name: 'list_submissions', arguments: {} })) as {
        structuredContent?: { submissions: { gift_wrap_id: string }[] };
      };
      expect(listed.structuredContent?.submissions.map((r) => r.gift_wrap_id)).toEqual([wrap?.id]);
    });

    it('refuses token requests that are not public-client form posts', async () => {
      const json = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(json.status).toBe(400);
      const secret = await token({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: 'x',
      });
      expect(secret.status).toBe(401);
      const grant = await token({ grant_type: 'password', client_id: CLIENT_ID });
      expect(await grant.json()).toMatchObject({ error: 'unsupported_grant_type' });
    });

    it('requires NIP-98 on every device route', async () => {
      for (const [method, path] of [
        ['GET', '/device/authorizations/ABCD-EFGH'],
        ['POST', '/device/authorizations/ABCD-EFGH/approve'],
        ['POST', '/device/authorizations/ABCD-EFGH/deny'],
        ['GET', '/device/bindings'],
        ['DELETE', `/device/bindings/${'a'.repeat(64)}`],
      ] as const) {
        const res = await app.request(path, { method });
        expect(res.status).toBe(401);
      }
    });

    it('serves a read-only authorize page under a strict CSP', async () => {
      const s = await start();
      const res = await app.request(s.page);
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const help = await (await app.request(`/approve?code=${s.code}`)).text();
      expect(help).toContain(s.code);
    });
  });
}
