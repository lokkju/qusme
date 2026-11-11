/**
 * Agent approval, revocation and pending destinations (spec 8.2, 11.8) against the real service
 * app from `@qusme/core` on SQLite, with the fake relay network standing in for the storage and
 * inbox relays on both sides: the service reads the submitters list and grants from the same
 * fake relays the device publishes to, and an MCP client drives the agent's side.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createAgentKeyRing, createApp, type RelayPublisher, type RelayReader } from '@qusme/core';
import {
  buildAgentGrant,
  buildDestinations,
  buildSettings,
  createLocalSigner,
  D_DESTINATIONS,
  type Destination,
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  KIND_SUBMITTERS,
  type NostrEvent,
  newestFirst,
  parseAgentGrant,
  parseDestinations,
  parseDraftWrap,
  parseSubmittersList,
  parseSubmittersPublic,
  publishToAll,
  RelayConnection,
  verifyHttpAuth,
} from '@qusme/nostr';
import type { FakeRelayNetwork, FakeRelayOptions } from '@qusme/nostr/testing';
import { openSqlite } from '@qusme/store-sql/sqlite';
import type { Filter } from 'nostr-tools/filter';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PERMISSION_MESSAGE,
  type ApprovalChoices,
  approveAgent,
  defaultChoices,
  denyAgent,
  grantFor,
  sharesNothing,
} from '../src/agents/approve.ts';
import { parseApprovalCode } from '../src/agents/code.ts';
import {
  confirmPendingDestination,
  mergePendingDestination,
  rejectPendingDestination,
} from '../src/agents/destinations.ts';
import {
  choicesFromGrant,
  editGrant,
  shareCandidates,
  shareDestination,
} from '../src/agents/grants.ts';
import { readPendingRevocations } from '../src/agents/pendingRevocations.ts';
import type { AgentDeps } from '../src/agents/queue.ts';
import { type RevokeResult, revokeAgent } from '../src/agents/revoke.ts';
import { type AuthorizationRequest, fetchAuthorization } from '../src/agents/service.ts';
import { loadAgents } from '../src/agents/view.ts';
import { KeyStore, LOCAL_QUEUE, type QueueRecord, SESSION_UNLOCKED } from '../src/keyStore.ts';
import { MemoryStorageArea } from '../src/storage.ts';
import { syncOnce } from '../src/sync/engine.ts';
import {
  AgentItem,
  AgentsList,
  ApprovalDone,
  ApprovalReview,
  EditGrantView,
  GrantForm,
  RequestSummary,
  revokeMessage,
  ShareOfferView,
} from '../src/ui/agents.tsx';
import { INBOX, network, ORIGIN, STORAGE } from './helpers.ts';

const CLIENT_ID = 'https://client.example/oauth/client-metadata.json';
const REDIRECT = 'https://client.example/oauth/callback';
const RESOURCE = `${ORIGIN}/mcp`;
const VERIFIER = 'vvvvvvvvvvvvvvvvvvvv-._~0123456789abcdefghijklmnop';
const REGISTRY = [
  {
    id: 'x',
    version: '2026.10.1',
    name: 'X',
    match: ['https://x.com/*'],
    fields: [
      {
        name: 'text',
        label: 'Post text',
        locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
        inject: ['paste', 'clipboard'],
        constraints: { maxLength: 280 },
      },
    ],
  },
];
const X_LOKKJU: Destination = {
  id: 'dest-x-lokkju',
  site: 'x',
  account: 'lokkju',
  label: 'X / lokkju',
  status: 'confirmed',
  override: null,
};
const X_ALT: Destination = {
  id: 'dest-x-alt',
  site: 'x',
  account: 'alt',
  label: 'X / alt',
  status: 'confirmed',
  override: { match: ['https://x.com/alt/*'] },
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function publishTo(net: FakeRelayNetwork, urls: readonly string[], event: NostrEvent) {
  const connections = await Promise.all(
    urls.map((url) => RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 }))
  );
  const report = await publishToAll(connections, event);
  for (const c of connections) c.close();
  expect(report.refused).toEqual([]);
}

/** The newest event of `kind` (and `d`) a fake relay holds from `author`. */
function newestOn(net: FakeRelayNetwork, url: string, kind: number, author: string, d?: string) {
  return net
    .get(url)
    .events.filter(
      (e) =>
        e.kind === kind &&
        e.pubkey === author &&
        (d === undefined || e.tags.some((t) => t[0] === 'd' && t[1] === d))
    )
    .sort(newestFirst)[0];
}

/** The service's relay reader and publisher over the fake network, as the WebSocket ones behave. */
function serviceRelays(net: FakeRelayNetwork, state: { lag: number }) {
  const reader: RelayReader = {
    async query(query) {
      // Relay propagation: the first `lag` reads of a submitters list see nothing yet.
      if (query.filter.kinds?.includes(KIND_SUBMITTERS) && state.lag > 0) {
        state.lag -= 1;
        return [];
      }
      const out: unknown[] = [];
      for (const url of query.relays) {
        try {
          const auth = query.auth;
          const c = await RelayConnection.open(url, {
            socket: net.socket,
            timeoutMs: 500,
            ...(auth && { autoAuth: (t) => auth.signEvent(t) }),
          });
          out.push(...(await c.query([query.filter as Filter])));
          c.close();
        } catch {}
      }
      return out;
    },
  };
  const publisher: RelayPublisher = {
    async publish(request) {
      return Promise.all(
        request.relays.map(async (relay) => {
          try {
            const c = await RelayConnection.open(relay, { socket: net.socket, timeoutMs: 500 });
            await c.publish(request.event);
            c.close();
            return { relay, ok: true, message: '' };
          } catch (error) {
            return { relay, ok: false, message: (error as Error).message };
          }
        })
      );
    },
  };
  return { reader, publisher };
}

/**
 * A queue (settings with the inbox key, two confirmed destinations) on the fake relays, an
 * unlocked extension install holding it, and the service app.
 */
async function harness(options: { storage?: FakeRelayOptions } = {}) {
  const net = network(options.storage);
  const secretKey = generateSecretKey();
  const inboxKey = generateSecretKey();
  const queue = createLocalSigner(secretKey);
  const queuePubkey = getPublicKey(secretKey);
  const settings = await buildSettings(queue, {
    inbox_key: bytesToHex(inboxKey),
    inbox_relays: INBOX,
    quota_counts: {},
  });
  await publishTo(net, STORAGE, settings);
  await publishTo(
    net,
    STORAGE,
    await buildDestinations(queue, { destinations: [X_LOKKJU, X_ALT] })
  );

  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const record: QueueRecord = {
    version: 1,
    pubkey: queuePubkey,
    ncryptsec: 'ncryptsec1unused',
    storageRelays: STORAGE,
    settings,
  };
  await local.set({ [LOCAL_QUEUE]: record });
  await session.set({
    [SESSION_UNLOCKED]: { queue: bytesToHex(secretKey), inbox: bytesToHex(inboxKey) },
  });
  const store = new KeyStore({ local, session });

  const relayState = { lag: 0 };
  const relays = serviceRelays(net, relayState);
  const app = createApp({
    version: 'test',
    db: openSqlite(':memory:'),
    agentKeys: createAgentKeyRing({ secret: btoa('e'.repeat(32)) }),
    publicOrigin: ORIGIN,
    oauth: {
      relayReader: relays.reader,
      fetch: async (input: string) =>
        input === CLIENT_ID
          ? Response.json({
              client_id: CLIENT_ID,
              client_name: 'Example Agent',
              redirect_uris: [REDIRECT],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            })
          : new Response('not found', { status: 404 }),
    },
    mcp: { registry: REGISTRY, relayPublisher: relays.publisher, grantCacheSeconds: 0 },
  });

  /** Every device request the service got, with the NIP-98 pubkey and what the relays held. */
  const calls: {
    method: string;
    path: string;
    authPubkey: string | undefined;
    onRelays: { submitters: string[][]; grants: number };
  }[] = [];
  let permissionRequests = 0;
  /** `down` makes every service request fail as offline; `permission` is the user's answer. */
  const service = { down: false, permission: true };
  const deps: AgentDeps = {
    store,
    socket: net.socket,
    relayTimeoutMs: 500,
    serviceOrigin: ORIGIN,
    approvalRetryMs: [5, 5, 5],
    requestServicePermission: async () => {
      permissionRequests += 1;
      return service.permission;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (service.down) throw new TypeError('Failed to fetch');
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      const auth = verifyHttpAuth(new Headers(init?.headers).get('Authorization'), {
        url,
        method,
        ...(body !== undefined && { body }),
      });
      calls.push({
        method,
        path: new URL(url).pathname,
        authPubkey: auth.ok ? auth.value.pubkey : undefined,
        onRelays: {
          submitters: STORAGE.map((r) => {
            const e = newestOn(net, r, KIND_SUBMITTERS, queuePubkey);
            const parsed = e && parseSubmittersPublic(e, { queuePubkey });
            return parsed?.ok ? parsed.value.submitters : [];
          }),
          grants: STORAGE.filter((r) => newestOn(net, r, KIND_AGENT_GRANT, queuePubkey)).length,
        },
      });
      return app.request(url, init);
    }) as typeof fetch,
  };

  /** An MCP client starting OAuth: the waiting page's path and the code it shows. */
  async function startAuthorization() {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: base64url(sha256(utf8ToBytes(VERIFIER))),
      code_challenge_method: 'S256',
      state: 'opaque',
      resource: RESOURCE,
      scope: 'drafts:submit',
    });
    const res = await app.request(`/authorize?${q}`);
    expect(res.status).toBe(303);
    const page = res.headers.get('Location') ?? '';
    const html = await (await app.request(page)).text();
    const code = /class="code"[^>]*>([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(html)?.[1];
    if (code === undefined) throw new Error('no code on the page');
    return { page, code };
  }

  async function pageStatus(page: string) {
    return (await (await app.request(`${page}/status`)).json()) as {
      status: string;
      redirect?: string;
    };
  }

  /** The client collects the redirect, redeems the code and connects to /mcp. */
  async function connectAgent(page: string) {
    const done = await pageStatus(page);
    expect(done.status).toBe('redirect');
    const code = new URL(done.redirect ?? '').searchParams.get('code') ?? '';
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const { access_token: token } = (await res.json()) as { access_token: string };
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: async (url, init) => app.request(String(url), init),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
    return { client, call };
  }

  /** Runs the whole approval: start, fetch on the device, approve with `choices`. */
  async function approved(edit: (c: ApprovalChoices) => ApprovalChoices = (c) => c) {
    const start = await startAuthorization();
    const request = await fetchAuthorization(queue, start.code, deps);
    const choices = edit({
      ...defaultChoices(request),
      destinations: [{ id: X_LOKKJU.id, fields: ['text'] }],
    });
    await approveAgent(request, choices, deps);
    return { ...start, request };
  }

  return {
    net,
    app,
    deps,
    store,
    queue,
    queuePubkey,
    inboxKey,
    calls,
    relayState,
    service,
    local,
    permissions: () => permissionRequests,
    startAuthorization,
    pageStatus,
    connectAgent,
    approved,
  };
}

describe('approval codes', () => {
  it('reads typed codes, the QR link, and nothing else', () => {
    expect(parseApprovalCode('abcd-1234', ORIGIN)).toBe('ABCD-1234');
    expect(parseApprovalCode(' ab cd 12 34 ', ORIGIN)).toBe('ABCD-1234');
    expect(parseApprovalCode('ABCDI0LO', ORIGIN)).toBe('ABCD-1010');
    expect(parseApprovalCode('https://app.qus.me/approve?code=WXYZ-5678', ORIGIN)).toBe(
      'WXYZ-5678'
    );
    expect(
      parseApprovalCode('https://evil.example/approve?code=WXYZ-5678', ORIGIN)
    ).toBeUndefined();
    expect(parseApprovalCode('https://app.qus.me/other?code=WXYZ-5678', ORIGIN)).toBeUndefined();
    expect(parseApprovalCode('ABC-123', ORIGIN)).toBeUndefined();
    expect(parseApprovalCode('ABCD-123U', ORIGIN)).toBeUndefined();
  });
});

describe('the grant an approval publishes', () => {
  const settings = {
    inbox_key: bytesToHex(generateSecretKey()),
    inbox_relays: INBOX,
    quota_counts: {},
  };
  const choices: ApprovalChoices = {
    label: 'Agent',
    destinations: [
      { id: X_LOKKJU.id, fields: [' text ', 'text', ''] },
      { id: X_ALT.id, fields: ['text'] },
    ],
    allowNewDestinations: false,
    quota: { max_submissions: 10, period: 'week' },
    submissionExpirationDays: 30,
    expiresAt: null,
  };

  it('carries the inbox key, each destination with its override, and the limits', () => {
    const grant = grantFor(choices, [X_LOKKJU, X_ALT], settings, 1000);
    expect(grant).toEqual({
      inbox: INBOX,
      inbox_pubkey: getPublicKey(hexToBytes(settings.inbox_key)),
      destinations: [
        { site: 'x', account: 'lokkju', fields: ['text'] },
        { site: 'x', account: 'alt', fields: ['text'], override: X_ALT.override },
      ],
      allow_new_destinations: false,
      submission_expiration_days: 30,
      quota: { max_submissions: 10, period: 'week' },
      expires_at: null,
    });
  });

  it('refuses what devices never publish', () => {
    expect(() =>
      grantFor({ ...choices, submissionExpirationDays: 91 }, [X_LOKKJU, X_ALT], settings, 1000)
    ).toThrow(/1 to 90 days/);
    expect(() => grantFor(choices, [X_LOKKJU, X_ALT], { quota_counts: {} }, 1000)).toThrow(
      /inbox key/
    );
    expect(() =>
      grantFor({ ...choices, expiresAt: 999 }, [X_LOKKJU, X_ALT], settings, 1000)
    ).toThrow(/future/);
    expect(() =>
      grantFor(choices, [X_LOKKJU, { ...X_ALT, status: 'pending' }], settings, 1000)
    ).toThrow(/no longer in the queue/);
    expect(() =>
      grantFor(
        { ...choices, destinations: [{ id: X_LOKKJU.id, fields: [' '] }] },
        [X_LOKKJU],
        settings,
        1000
      )
    ).toThrow(/at least one field/);
  });

  it('starts with new destinations off and the spec defaults', () => {
    const request = { clientName: 'Example Agent' } as AuthorizationRequest;
    expect(defaultChoices(request)).toEqual({
      label: 'Example Agent',
      destinations: [],
      allowNewDestinations: false,
      quota: { max_submissions: 50, period: 'day' },
      submissionExpirationDays: 30,
      expiresAt: null,
    });
  });
});

describe('agent approval against the service', { timeout: 30_000 }, () => {
  it('approves: publishes the list and grant, then the approval, and the agent can draft', async () => {
    const h = await harness();
    const start = await h.startAuthorization();

    // The device fetches the request with NIP-98 as the queue key; the service mints the key.
    const request = await fetchAuthorization(h.queue, start.code, h.deps);
    expect(request).toMatchObject({
      code: start.code,
      clientId: CLIENT_ID,
      clientHost: 'client.example',
      clientName: 'Example Agent',
      redirectHost: 'client.example',
      scopes: ['drafts:submit'],
    });
    expect(request.agentPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(h.calls[0]).toMatchObject({
      method: 'GET',
      path: `/device/authorizations/${start.code}`,
      authPubkey: h.queuePubkey,
    });

    const choices: ApprovalChoices = {
      ...defaultChoices(request),
      label: 'My agent',
      destinations: [
        { id: X_LOKKJU.id, fields: ['text'] },
        { id: X_ALT.id, fields: ['text'] },
      ],
      quota: { max_submissions: 5, period: 'day' },
      submissionExpirationDays: 14,
    };
    expect(await approveAgent(request, choices, h.deps)).toEqual({ attempts: 1 });

    // Both events were on every storage relay before the approval reached the service.
    const approval = h.calls.find((c) => c.path.endsWith('/approve'));
    expect(approval).toMatchObject({ method: 'POST', authPubkey: h.queuePubkey });
    expect(approval?.onRelays.submitters).toEqual([[request.agentPubkey], [request.agentPubkey]]);
    expect(approval?.onRelays.grants).toBe(STORAGE.length);

    // The list labels are encrypted to the queue; the p tags are public.
    for (const url of STORAGE) {
      const list = newestOn(h.net, url, KIND_SUBMITTERS, h.queuePubkey) as NostrEvent;
      expect(list.tags).toEqual([['p', request.agentPubkey]]);
      expect(list.content).not.toContain('My agent');
      const parsed = await parseSubmittersList(list, h.queue);
      expect(parsed.ok && parsed.value.labels[request.agentPubkey]?.label).toBe('My agent');
      const grant = newestOn(h.net, url, KIND_AGENT_GRANT, h.queuePubkey, request.agentPubkey);
      const read = await parseAgentGrant(grant, h.queue);
      expect(read.ok && read.value.grant).toMatchObject({
        inbox: INBOX,
        inbox_pubkey: getPublicKey(h.inboxKey),
        destinations: [
          { site: 'x', account: 'lokkju', fields: ['text'] },
          { site: 'x', account: 'alt', fields: ['text'], override: X_ALT.override },
        ],
        allow_new_destinations: false,
        submission_expiration_days: 14,
        quota: { max_submissions: 5, period: 'day' },
        expires_at: null,
      });
    }

    // The client gets its code and tokens; the service reads and decrypts the grant as the agent.
    const agent = await h.connectAgent(start.page);
    const listed = await agent.call('list_destinations');
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toMatchObject({
      destinations: [
        { site: 'x', account: 'lokkju', fields: [{ name: 'text' }] },
        { site: 'x', account: 'alt', fields: [{ name: 'text' }] },
      ],
      allow_new_destinations: false,
      submission_expiration_days: 14,
      expires_at: null,
    });

    // A draft it submits reaches the inbox and the device ingests it under the agent's label.
    const created = await agent.call('create_draft', {
      site: 'x',
      account: 'lokkju',
      field: 'text',
      value: 'hello from the agent',
    });
    expect(created.isError).toBeFalsy();
    const synced = await syncOnce({ store: h.store, socket: h.net.socket, relayTimeoutMs: 500 });
    expect(synced.state === 'synced' && synced.summary.ingested).toBe(1);
    const destinations = await agent.call('create_draft', {
      site: 'x',
      account: 'someone-else',
      field: 'text',
      value: 'not granted',
    });
    expect(destinations.structuredContent?.error).toBe('destination_not_granted');
    await agent.client.close();
  });

  it('retries a 409 while the relays catch up, then gives up with the error', async () => {
    const h = await harness();
    h.relayState.lag = 2;
    const first = await h.startAuthorization();
    const request = await fetchAuthorization(h.queue, first.code, h.deps);
    expect(await approveAgent(request, defaultChoices(request), h.deps)).toEqual({ attempts: 3 });
    expect((await h.pageStatus(first.page)).status).toBe('redirect');

    h.relayState.lag = 10;
    const second = await h.startAuthorization();
    const again = await fetchAuthorization(h.queue, second.code, h.deps);
    await expect(approveAgent(again, defaultChoices(again), h.deps)).rejects.toThrow(
      /submitters_list_not_found/
    );
    // Three retries after the first attempt, and the request is still open for another try.
    expect(
      h.calls.filter((c) => c.path === `/device/authorizations/${second.code}/approve`)
    ).toHaveLength(4);
    expect((await h.pageStatus(second.page)).status).toBe('fetched');
    h.relayState.lag = 0;
    expect(await approveAgent(again, defaultChoices(again), h.deps)).toEqual({ attempts: 1 });
    // Both agents stay on the list: the second approval kept the first.
    const list = newestOn(h.net, STORAGE[0] as string, KIND_SUBMITTERS, h.queuePubkey);
    expect(list?.tags).toEqual([
      ['p', request.agentPubkey],
      ['p', again.agentPubkey],
    ]);
  });

  it('asks for the service permission at approval and publishes nothing without it', async () => {
    const h = await harness();
    const start = await h.startAuthorization();
    const request = await fetchAuthorization(h.queue, start.code, h.deps);
    const before = h.permissions();
    h.service.permission = false;
    await expect(approveAgent(request, defaultChoices(request), h.deps)).rejects.toThrow(
      APPROVAL_PERMISSION_MESSAGE
    );
    expect(h.permissions()).toBe(before + 1);
    expect(newestOn(h.net, STORAGE[0] as string, KIND_SUBMITTERS, h.queuePubkey)).toBeUndefined();
    expect(h.calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
    h.service.permission = true;
    expect(await approveAgent(request, defaultChoices(request), h.deps)).toEqual({ attempts: 1 });
    expect(h.permissions()).toBe(before + 2);
  });

  it('denies: nothing is published and the client is refused', async () => {
    const h = await harness();
    const start = await h.startAuthorization();
    const request = await fetchAuthorization(h.queue, start.code, h.deps);
    await denyAgent(request, h.deps);
    expect(h.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/device/authorizations/${start.code}/deny`,
      authPubkey: h.queuePubkey,
    });
    expect(newestOn(h.net, STORAGE[0] as string, KIND_SUBMITTERS, h.queuePubkey)).toBeUndefined();
    const done = await h.pageStatus(start.page);
    expect(new URL(done.redirect ?? '').searchParams.get('error')).toBe('access_denied');
    await expect(denyAgent(request, h.deps)).rejects.toThrow(/expired|already/);
  });

  it('refuses to approve or deny while the queue is locked', async () => {
    const h = await harness();
    const start = await h.startAuthorization();
    const request = await fetchAuthorization(h.queue, start.code, h.deps);
    await h.store.lock();
    const before = h.calls.length;
    await expect(approveAgent(request, defaultChoices(request), h.deps)).rejects.toThrow(
      'Unlock the queue first.'
    );
    await expect(denyAgent(request, h.deps)).rejects.toThrow('Unlock the queue first.');
    await expect(revokeAgent(request.agentPubkey, h.deps)).rejects.toThrow(
      'Unlock the queue first.'
    );
    expect(h.calls.length).toBe(before);
    expect(newestOn(h.net, STORAGE[0] as string, KIND_SUBMITTERS, h.queuePubkey)).toBeUndefined();
  });

  it('refuses an approval when a storage relay is unreachable, before publishing', async () => {
    const h = await harness();
    const start = await h.startAuthorization();
    const request = await fetchAuthorization(h.queue, start.code, h.deps);
    const record = (await h.store.record()) as QueueRecord;
    await h.store.update({ storageRelays: [...record.storageRelays, 'wss://gone.example'] });
    await expect(approveAgent(request, defaultChoices(request), h.deps)).rejects.toThrow(
      /gone\.example/
    );
    expect(newestOn(h.net, STORAGE[0] as string, KIND_SUBMITTERS, h.queuePubkey)).toBeUndefined();
  });
});

describe('agents list and revocation', { timeout: 30_000 }, () => {
  it('lists agents with their labels and the client host, and revokes list first', async () => {
    const h = await harness();
    const one = await h.approved((c) => ({ ...c, label: 'First' }));
    const two = await h.approved((c) => ({ ...c, label: 'Second' }));
    const agent = await h.connectAgent(one.page);

    const view = await loadAgents(h.deps, { withService: true });
    expect(view.bindingsError).toBeUndefined();
    expect(
      view.agents.map((a) => [
        a.label,
        a.listed,
        a.binding?.clientHost,
        a.grant?.destinations.length,
      ])
    ).toEqual([
      ['First', true, 'client.example', 1],
      ['Second', true, 'client.example', 1],
    ]);

    const result = await revokeAgent(one.request.agentPubkey, h.deps);
    expect(result).toEqual({ listUpdated: true, refusals: [], service: 'revoked' });
    expect(await readPendingRevocations(h.store)).toEqual([]);
    // The DELETE came after every storage relay had the list without the agent.
    const del = h.calls.find((c) => c.method === 'DELETE');
    expect(del).toMatchObject({
      path: `/device/bindings/${one.request.agentPubkey}`,
      authPubkey: h.queuePubkey,
    });
    expect(del?.onRelays.submitters).toEqual([
      [two.request.agentPubkey],
      [two.request.agentPubkey],
    ]);
    // The grant was asked to be deleted; the fake relays honor it.
    expect(
      newestOn(
        h.net,
        STORAGE[0] as string,
        KIND_AGENT_GRANT,
        h.queuePubkey,
        one.request.agentPubkey
      )
    ).toBeUndefined();
    // The service no longer accepts the agent's token.
    await expect(agent.call('list_destinations')).rejects.toThrow();

    const after = await loadAgents(h.deps, { withService: true });
    expect(after.agents.map((a) => a.label)).toEqual(['Second']);
  });

  it('keeps a revocation pending without the permission, and the service refuses the agent anyway', async () => {
    // Storage relays that ignore NIP-09, as most ordinary relays do: the grant stays readable.
    const h = await harness({ storage: { honorDeletion: false } });
    const one = await h.approved((c) => ({ ...c, label: 'Mine' }));
    const agent = await h.connectAgent(one.page);
    const draft = (value: string) => ({ site: 'x', account: 'lokkju', field: 'text', value });
    expect((await agent.call('create_draft', draft('before'))).isError).toBeFalsy();
    const inboxBefore = h.net.get(INBOX[0] as string).events.length;

    const result = await revokeAgent(one.request.agentPubkey, h.deps, { serviceAllowed: false });
    expect(result).toMatchObject({ listUpdated: true, refusals: [], service: 'pending' });
    expect(result.serviceError).toMatch(/permission/);
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(
      newestOn(
        h.net,
        STORAGE[0] as string,
        KIND_AGENT_GRANT,
        h.queuePubkey,
        one.request.agentPubkey
      )
    ).toBeDefined();
    expect(await readPendingRevocations(h.store, h.queuePubkey)).toEqual([
      expect.objectContaining({ agentPubkey: one.request.agentPubkey, label: 'Mine' }),
    ]);

    // The token still works, but the service reads the submitters list and refuses.
    const refused = await agent.call('create_draft', draft('after revocation'));
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.error).toBe('grant_revoked');
    expect(String(refused.structuredContent?.message)).toMatch(/revoked/);
    expect(h.net.get(INBOX[0] as string).events.length).toBe(inboxBefore);

    // The agents list shows it as revoked here and still being finished with the service.
    const view = await loadAgents(h.deps, { withService: true });
    expect(view.agents).toEqual([
      expect.objectContaining({
        agentPubkey: one.request.agentPubkey,
        label: 'Mine',
        listed: false,
        pendingRevocation: expect.objectContaining({
          lastError: expect.stringMatching(/permission/),
        }),
      }),
    ]);

    // The next sync finishes it; the token stops working and the record goes.
    const synced = await syncOnce({
      store: h.store,
      socket: h.net.socket,
      relayTimeoutMs: 500,
      serviceOrigin: ORIGIN,
      fetch: h.deps.fetch,
    });
    expect(synced.state).toBe('synced');
    expect(h.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(await readPendingRevocations(h.store)).toEqual([]);
    await expect(agent.call('list_destinations')).rejects.toThrow();
    expect((await loadAgents(h.deps, { withService: true })).agents).toEqual([]);
    await agent.client.close();
  });

  it('persists a revocation the service could not be told about and retries it on each sync', async () => {
    const h = await harness();
    const one = await h.approved((c) => ({ ...c, label: 'Mine' }));
    h.service.down = true;
    const result = await revokeAgent(one.request.agentPubkey, h.deps);
    expect(result).toMatchObject({
      listUpdated: true,
      service: 'pending',
      serviceError: 'Could not reach the qus.me service.',
    });
    // In storage.local, so a new popup or a restarted background finds it.
    const reopened = new KeyStore({ local: h.local, session: new MemoryStorageArea() });
    expect(await readPendingRevocations(reopened)).toEqual([
      {
        queuePubkey: h.queuePubkey,
        agentPubkey: one.request.agentPubkey,
        label: 'Mine',
        since: expect.any(Number),
        lastError: 'Could not reach the qus.me service.',
      },
    ]);
    // Offline, the agents list still shows it, from the record alone.
    const offline = await loadAgents(h.deps, { withService: true });
    expect(offline.bindingsError).toBeDefined();
    expect(
      offline.agents.map((a) => [a.label, a.listed, a.pendingRevocation !== undefined])
    ).toEqual([['Mine', false, true]]);

    const sync = () =>
      syncOnce({
        store: h.store,
        socket: h.net.socket,
        relayTimeoutMs: 500,
        serviceOrigin: ORIGIN,
        fetch: h.deps.fetch,
      });
    await sync();
    expect(await readPendingRevocations(h.store)).toHaveLength(1);
    h.service.down = false;
    await sync();
    expect(await readPendingRevocations(h.store)).toEqual([]);
    expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([
      expect.objectContaining({
        path: `/device/bindings/${one.request.agentPubkey}`,
        authPubkey: h.queuePubkey,
      }),
    ]);
  });

  it('drops a pending record once the service answers without the binding', async () => {
    const h = await harness();
    const one = await h.approved();
    await revokeAgent(one.request.agentPubkey, h.deps, { serviceAllowed: false });
    // Another device finished it with the service.
    expect(await revokeAgent(one.request.agentPubkey, h.deps)).toMatchObject({
      listUpdated: false,
      service: 'revoked',
    });
    expect(await readPendingRevocations(h.store)).toEqual([]);
    await revokeAgent(one.request.agentPubkey, h.deps, { serviceAllowed: false });
    expect(await readPendingRevocations(h.store)).toHaveLength(1);
    expect((await loadAgents(h.deps, { withService: true })).agents).toEqual([]);
    expect(await readPendingRevocations(h.store)).toEqual([]);
  });
});

describe('pending destinations', { timeout: 30_000 }, () => {
  /** An agent allowed to propose new destinations submits for an unknown one; the device syncs. */
  async function proposed() {
    const h = await harness();
    const one = await h.approved((c) => ({ ...c, allowNewDestinations: true }));
    const agent = await h.connectAgent(one.page);
    for (const value of ['first proposal', 'second proposal']) {
      const res = await agent.call('create_draft', {
        site: 'x',
        account: 'newcomer',
        field: 'text',
        value,
      });
      expect(res.structuredContent?.pending_destination).toBe(true);
    }
    await agent.call('create_draft', {
      site: 'x',
      account: 'lokkju',
      field: 'text',
      value: 'kept',
    });
    await agent.client.close();
    const synced = await syncOnce({ store: h.store, socket: h.net.socket, relayTimeoutMs: 500 });
    expect(synced.state === 'synced' && synced.summary.ingested).toBe(3);
    const view = await loadAgents(h.deps, { withService: false });
    expect(view.pending.map((d) => [d.label, d.status])).toEqual([['x / newcomer', 'pending']]);
    return { h, pending: view.pending[0] as Destination };
  }

  async function destinationsOnRelay(h: Awaited<ReturnType<typeof harness>>) {
    const event = newestOn(
      h.net,
      STORAGE[1] as string,
      KIND_APP_DATA,
      h.queuePubkey,
      D_DESTINATIONS
    );
    const parsed = await parseDestinations(event, h.queue);
    if (!parsed.ok) throw new Error('no destinations');
    return parsed.value.content.destinations;
  }

  async function draftsOnRelay(h: Awaited<ReturnType<typeof harness>>) {
    const out: { account: string; status: string }[] = [];
    const latest = new Map<string, NostrEvent>();
    for (const e of h.net
      .get(STORAGE[0] as string)
      .events.filter((e) => e.kind === KIND_DRAFT_WRAP)) {
      const d = e.tags.find((t) => t[0] === 'd')?.[1] as string;
      const prev = latest.get(d);
      if (prev === undefined || e.created_at > prev.created_at) latest.set(d, e);
    }
    for (const e of latest.values()) {
      const parsed = await parseDraftWrap(e, h.queue);
      if (parsed.ok && !parsed.value.deleted && parsed.value.draft.type === 'field_value') {
        const v = parsed.value.draft.value;
        out.push({ account: v.account, status: v.status });
      }
    }
    return out.sort((a, b) => (a.account + a.status).localeCompare(b.account + b.status));
  }

  it('confirms a pending destination', async () => {
    const { h, pending } = await proposed();
    await confirmPendingDestination(pending.id, h.deps);
    const destinations = await destinationsOnRelay(h);
    expect(destinations.map((d) => [d.account, d.status])).toEqual([
      ['lokkju', 'confirmed'],
      ['alt', 'confirmed'],
      ['newcomer', 'confirmed'],
    ]);
    expect((await loadAgents(h.deps, { withService: false })).pending).toEqual([]);
    await expect(confirmPendingDestination(pending.id, h.deps)).rejects.toThrow(
      /no longer pending/
    );
  });

  it('merges a pending destination into a confirmed one, moving its drafts', async () => {
    const { h, pending } = await proposed();
    await expect(mergePendingDestination(pending.id, pending.id, h.deps)).rejects.toThrow(
      /another destination/
    );
    await expect(mergePendingDestination(X_ALT.id, X_LOKKJU.id, h.deps)).rejects.toThrow(
      /no longer pending/
    );
    expect(await mergePendingDestination(pending.id, X_ALT.id, h.deps)).toEqual({ moved: 2 });
    expect((await destinationsOnRelay(h)).map((d) => d.id)).toEqual([X_LOKKJU.id, X_ALT.id]);
    expect(await draftsOnRelay(h)).toEqual([
      { account: 'alt', status: 'active' },
      { account: 'alt', status: 'active' },
      { account: 'lokkju', status: 'active' },
    ]);
    // Each moved draft names the target by id, so it is listed and inserted as the target's.
    for (const e of h.net.get(STORAGE[1] as string).events) {
      if (e.kind !== KIND_DRAFT_WRAP) continue;
      const parsed = await parseDraftWrap(e, h.queue);
      if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value') continue;
      const v = parsed.value.draft.value;
      if (v.account === 'alt') expect(v.destination).toBe(X_ALT.id);
    }
    await expect(mergePendingDestination(pending.id, X_ALT.id, h.deps)).rejects.toThrow(
      /no longer pending/
    );
  });

  it('leaves a pending destination when its drafts cannot be moved', async () => {
    const { h, pending } = await proposed();
    h.net.get(STORAGE[1] as string).options.refuseKinds = [KIND_DRAFT_WRAP];
    await expect(mergePendingDestination(pending.id, X_ALT.id, h.deps)).rejects.toThrow(
      /stays pending/
    );
    expect((await destinationsOnRelay(h)).map((d) => d.status)).toEqual([
      'confirmed',
      'confirmed',
      'pending',
    ]);
  });

  it('rejects a pending destination and dismisses only its drafts', async () => {
    const { h, pending } = await proposed();
    expect(await rejectPendingDestination(pending.id, h.deps)).toEqual({ dismissed: 2 });
    expect((await destinationsOnRelay(h)).map((d) => d.id)).toEqual([X_LOKKJU.id, X_ALT.id]);
    expect(await draftsOnRelay(h)).toEqual([
      { account: 'lokkju', status: 'active' },
      { account: 'newcomer', status: 'archived:dismissed' },
      { account: 'newcomer', status: 'archived:dismissed' },
    ]);
  });
});

describe('editing an agent grant', { timeout: 30_000 }, () => {
  async function grantOn(h: Awaited<ReturnType<typeof harness>>, agent: string, url = STORAGE[0]) {
    const event = newestOn(h.net, url as string, KIND_AGENT_GRANT, h.queuePubkey, agent);
    const parsed = await parseAgentGrant(event, h.queue);
    if (!parsed.ok) throw new Error('no grant');
    return parsed.value;
  }

  it('republishes the grant and the label, and the agent can draft where it now may', async () => {
    const h = await harness();
    const one = await h.approved((c) => ({ ...c, label: 'Mine' }));
    const pubkey = one.request.agentPubkey;
    // A grant a newer build wrote: unknown keys, an extra tag and proof of work this form leaves.
    const before = await grantOn(h, pubkey);
    const newer = await buildAgentGrant(
      h.queue,
      pubkey,
      {
        ...before.grant,
        min_pow: 1,
        extra: { future: 'top' },
        quota: { ...before.grant.quota, extra: { burst: 2 } },
        destinations: before.grant.destinations.map((d) => ({ ...d, extra: { color: 'teal' } })),
      },
      { createdAt: before.createdAt + 1, extraTags: [['future', 'kept']] }
    );
    await publishTo(h.net, STORAGE, newer);
    const agent = await h.connectAgent(one.page);
    const draft = (account: string) => ({ site: 'x', account, field: 'text', value: 'hi' });
    expect((await agent.call('create_draft', draft('alt'))).structuredContent?.error).toBe(
      'destination_not_granted'
    );

    const view = await loadAgents(h.deps, { withService: false });
    const row = view.agents[0] as (typeof view.agents)[number];
    const start = choicesFromGrant(
      'Mine',
      row.grant as NonNullable<typeof row.grant>,
      view.confirmed
    );
    expect(start.choices.destinations).toEqual([{ id: X_LOKKJU.id, fields: ['text'] }]);
    expect(start.dropped).toEqual([]);
    await editGrant(
      pubkey,
      {
        ...start.choices,
        label: 'Renamed',
        destinations: [...start.choices.destinations, { id: X_ALT.id, fields: ['text'] }],
        quota: { max_submissions: 9, period: 'week' },
        submissionExpirationDays: 7,
      },
      h.deps
    );

    for (const url of STORAGE) {
      const edited = await grantOn(h, pubkey, url);
      expect(edited.grant).toMatchObject({
        min_pow: 1,
        extra: { future: 'top' },
        quota: { max_submissions: 9, period: 'week', extra: { burst: 2 } },
        submission_expiration_days: 7,
        destinations: [
          { site: 'x', account: 'lokkju', fields: ['text'], extra: { color: 'teal' } },
          { site: 'x', account: 'alt', fields: ['text'], override: X_ALT.override },
        ],
      });
      expect(edited.extraTags).toEqual([['future', 'kept']]);
      const list = newestOn(h.net, url, KIND_SUBMITTERS, h.queuePubkey) as NostrEvent;
      const parsed = await parseSubmittersList(list, h.queue);
      expect(parsed.ok && parsed.value.labels[pubkey]).toMatchObject({ label: 'Renamed' });
      expect(parsed.ok && parsed.value.submitters).toEqual([pubkey]);
    }
    expect(h.calls.filter((c) => c.method !== 'GET').map((c) => c.path)).not.toContain(
      `/device/bindings/${pubkey}`
    );
    const listed = await agent.call('list_destinations');
    expect(
      ((listed.structuredContent?.destinations ?? []) as { account: string }[]).map(
        (d) => d.account
      )
    ).toEqual(['lokkju', 'alt']);
    await agent.client.close();
  });

  it('refuses to edit or share with a revoked agent, so revocation is never undone', async () => {
    const h = await harness({ storage: { honorDeletion: false } });
    const one = await h.approved((c) => ({ ...c, label: 'Mine' }));
    const pubkey = one.request.agentPubkey;
    const view = await loadAgents(h.deps, { withService: false });
    const grant = view.agents[0]?.grant as NonNullable<(typeof view.agents)[number]['grant']>;
    const { choices } = choicesFromGrant('Mine', grant, view.confirmed);
    h.service.down = true;
    const revoked = await revokeAgent(pubkey, h.deps);
    expect(revoked.service).toBe('pending');
    const grantsBefore = h.net
      .get(STORAGE[0] as string)
      .events.filter((e) => e.kind === KIND_AGENT_GRANT).length;
    await expect(editGrant(pubkey, choices, h.deps)).rejects.toThrow(/revoked/);
    await expect(shareDestination(X_ALT.id, [pubkey], h.deps)).rejects.toThrow(/revoked/);
    expect(
      h.net.get(STORAGE[0] as string).events.filter((e) => e.kind === KIND_AGENT_GRANT).length
    ).toBe(grantsBefore);
    const list = newestOn(h.net, STORAGE[0] as string, KIND_SUBMITTERS, h.queuePubkey);
    const parsed = await parseSubmittersList(list, h.queue);
    expect(parsed.ok && parsed.value.submitters).toEqual([]);
    // The revocation still reaches the service once it is back.
    h.service.down = false;
    await syncOnce({
      store: h.store,
      socket: h.net.socket,
      relayTimeoutMs: 500,
      serviceOrigin: ORIGIN,
      ...(h.deps.fetch !== undefined && { fetch: h.deps.fetch }),
    });
    expect(await readPendingRevocations(h.store)).toEqual([]);
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('shares a destination with the agents chosen, once', async () => {
    const h = await harness();
    const one = await h.approved((c) => ({ ...c, label: 'One' }));
    const two = await h.approved((c) => ({ ...c, label: 'Two' }));
    const view = await loadAgents(h.deps, { withService: false });
    expect(shareCandidates(view.agents, X_ALT, h.deps.now?.() ?? 0).length).toBe(2);
    expect(shareCandidates(view.agents, X_LOKKJU, 0)).toEqual([]);
    expect(await shareDestination(X_ALT.id, [one.request.agentPubkey], h.deps)).toEqual([
      one.request.agentPubkey,
    ]);
    expect(
      (await grantOn(h, one.request.agentPubkey)).grant.destinations.map((d) => d.account)
    ).toEqual(['lokkju', 'alt']);
    expect(
      (await grantOn(h, two.request.agentPubkey)).grant.destinations.map((d) => d.account)
    ).toEqual(['lokkju']);
    expect(await shareDestination(X_ALT.id, [one.request.agentPubkey], h.deps)).toEqual([]);
  });
});

describe('agent screens', () => {
  const request: AuthorizationRequest = {
    code: 'ABCD-1234',
    agentPubkey: 'a'.repeat(64),
    clientId: 'https://evil.example/<b>meta</b>.json',
    clientHost: 'evil.example',
    clientName: '<img src=x onerror=alert(1)>Claude Desktop',
    redirectHost: 'evil.example',
    scopes: ['drafts:submit'],
    expiresAt: 0,
  };

  it('shows the request as text with the client host prominent', () => {
    const html = renderToString(<RequestSummary request={request} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)>Claude Desktop');
    expect(html).toContain('&lt;b>meta&lt;/b>');
    expect(html).toMatch(/text-2xl[^>]*>evil\.example</);
    expect(html).toContain('Only approve if you just connected an agent from evil.example.');
    expect(html).toContain('The name is whatever the client says it is');
    // Client ID, scope and agent key sit under Details.
    expect(html.indexOf('<summary')).toBeLessThan(html.indexOf('Client ID<'));
  });

  it('ticks every confirmed destination by default', () => {
    const pending = { ...X_ALT, id: 'p'.repeat(32), status: 'pending' as const };
    const choices = defaultChoices(request, [X_LOKKJU, X_ALT, pending]);
    expect(choices.destinations).toEqual([
      { id: X_LOKKJU.id, fields: ['text'] },
      { id: X_ALT.id, fields: ['text'] },
    ]);
    expect(choices.allowNewDestinations).toBe(false);
    const html = renderToString(
      <GrantForm destinations={[X_LOKKJU, X_ALT]} choices={choices} onChange={() => {}} />
    );
    expect(html.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2);
  });

  const review = (choices: ApprovalChoices, destinations = [X_LOKKJU]) =>
    renderToString(
      <ApprovalReview
        request={request}
        destinations={destinations}
        choices={choices}
        busy={undefined}
        error={undefined}
        onChange={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onBack={() => {}}
      />
    );

  it('warns above Approve when nothing is shared and new destinations are off', () => {
    const none = { ...defaultChoices(request), label: '<i>Bot</i>' };
    const html = review(none);
    expect(html).toContain('role="alert"');
    expect(html).toContain("This agent won't be able to draft anything");
    expect(html).toContain('Nothing is shared with &lt;i>Bot&lt;/i>');
    expect(html).toContain('>Approve anyway<');
    expect(sharesNothing(none)).toBe(true);
  });

  it('does not warn when a destination is shared or new ones are allowed', () => {
    for (const choices of [
      defaultChoices(request, [X_LOKKJU]),
      { ...defaultChoices(request), allowNewDestinations: true },
    ]) {
      const html = review(choices);
      expect(html).not.toContain("won't be able to draft anything");
      expect(html).toContain('>Approve<');
      expect(sharesNothing(choices)).toBe(false);
    }
  });

  it('lists the finished steps and what was shared when done', () => {
    const html = renderToString(
      <ApprovalDone name="<b>Claude</b>" shared={['X / lokkju', 'X / alt']} onDone={() => {}} />
    );
    expect(html).not.toContain('<b>Claude');
    expect(html).toContain('&lt;b>Claude&lt;/b> is connected');
    const steps = [
      'Saved to your queue',
      'qus.me confirmed the approval',
      '&lt;b>Claude&lt;/b> finishes signing in on its own',
    ];
    const at = steps.map((step) => html.indexOf(step));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('Shared: X / lokkju, X / alt.');
    expect(html).toContain('>Back to drafts<');
  });

  it('offers new destinations off by default, with the explanation', () => {
    const html = renderToString(
      <GrantForm
        destinations={[X_LOKKJU, { ...X_ALT, label: '<script>x</script>' }]}
        choices={defaultChoices(request)}
        onChange={() => {}}
      />
    );
    expect(html).toMatch(/id="allow-new-destinations"(?![^>]*checked)[^>]*>/);
    expect(html).toContain('Let it propose new destinations');
    expect(html).toContain('each new one waits as pending until you confirm it');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script>x&lt;/script>');
  });

  it('lists agents and pending destinations as text', () => {
    const html = renderToString(
      <AgentsList
        busy={false}
        onRevoke={() => {}}
        onRetry={() => {}}
        onConfirm={() => {}}
        onReject={() => {}}
        view={{
          agents: [
            {
              agentPubkey: 'b'.repeat(64),
              label: '<i>mine</i>',
              listed: true,
              binding: {
                agentPubkey: 'b'.repeat(64),
                clientId: CLIENT_ID,
                clientHost: 'client.example',
                clientName: '<u>Spoof</u>',
                relays: STORAGE,
                createdAt: 0,
              },
            },
          ],
          pending: [{ ...X_ALT, status: 'pending', label: '<em>x / new</em>' }],
          confirmed: [X_LOKKJU],
        }}
      />
    );
    expect(html).not.toMatch(/<(i|u|em)>/);
    expect(html).toContain('&lt;i>mine&lt;/i>');
    expect(html).toContain('calls itself &lt;u>Spoof&lt;/u>');
    expect(html).toContain('&lt;em>x / new&lt;/em>');
    expect(html).toContain('Reject and dismiss its drafts');
  });

  it('shows a revocation still being finished with qus.me, with Retry and no Revoke', () => {
    const html = renderToString(
      <AgentsList
        busy={false}
        onRevoke={() => {}}
        onRetry={() => {}}
        onConfirm={() => {}}
        onReject={() => {}}
        view={{
          agents: [
            {
              agentPubkey: 'c'.repeat(64),
              label: '<b>Mine</b>',
              listed: false,
              pendingRevocation: { since: 0, lastError: 'Could not reach the qus.me service.' },
            },
          ],
          pending: [],
          confirmed: [],
        }}
      />
    );
    expect(html).toContain('Revoked on your devices; finishing with qus.me…');
    expect(html).toContain('may still look like it works');
    expect(html).toContain('Last try: Could not reach the qus.me service.');
    expect(html).toContain('>Retry<');
    expect(html).not.toContain('Revoke…');
    expect(html).toContain('&lt;b>Mine&lt;/b>');
  });

  it('says plainly what a revocation did', () => {
    const done: RevokeResult = { listUpdated: true, refusals: [], service: 'revoked' };
    expect(revokeMessage('Claude', done)).toBe(
      'Claude can no longer send drafts. Remove it from its client too.'
    );
    const pending = revokeMessage('Claude', { ...done, service: 'pending' });
    expect(pending).toMatch(/^Revoked on your devices; finishing with qus\.me…/);
    expect(pending).toContain('Claude may still look like it works');
    expect(pending).toContain('next sync, or press Retry');
  });
});

describe('grant editing screens', () => {
  const grant = {
    inbox: INBOX,
    inbox_pubkey: 'a'.repeat(64),
    min_pow: 0,
    destinations: [
      { site: 'x', account: 'LOKKJU', fields: ['text'] },
      { site: 'x', account: 'gone', fields: ['text'] },
    ],
    allow_new_destinations: true,
    submission_expiration_days: 30,
    quota: { max_submissions: 50, period: 'day' as const },
    expires_at: null,
  };
  const row = { agentPubkey: 'b'.repeat(64), label: '<i>mine</i>', listed: true, grant };

  it('maps the grant onto the destinations, by normalized account, and names what is gone', () => {
    const start = choicesFromGrant('mine', grant, [X_LOKKJU, X_ALT]);
    expect(start.choices).toMatchObject({
      label: 'mine',
      destinations: [{ id: X_LOKKJU.id, fields: ['text'] }],
      allowNewDestinations: true,
    });
    expect(start.dropped.map((d) => d.account)).toEqual(['gone']);
    const html = renderToString(
      <EditGrantView
        agent={row}
        destinations={[X_LOKKJU, X_ALT]}
        start={start}
        choices={start.choices}
        busy={undefined}
        error={undefined}
        onChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain('&lt;i>mine&lt;/i>');
    expect(html).toContain('x / gone');
    expect(html).toContain('Save');
  });

  it('offers Edit access only to an authorized agent with a grant', () => {
    const props = { busy: false, onRevoke: () => {}, onRetry: () => {}, onEdit: () => {} };
    expect(renderToString(<AgentItem agent={row} {...props} />)).toContain('Edit access');
    expect(
      renderToString(<AgentItem agent={{ ...row, listed: false }} {...props} />)
    ).not.toContain('Edit access');
  });

  it('offers merging a pending destination into a confirmed one', () => {
    const html = renderToString(
      <AgentsList
        busy={false}
        onRevoke={() => {}}
        onRetry={() => {}}
        onConfirm={() => {}}
        onReject={() => {}}
        onMerge={() => {}}
        view={{ agents: [], pending: [{ ...X_ALT, status: 'pending' }], confirmed: [X_LOKKJU] }}
      />
    );
    expect(html).toContain('Merge into an existing account');
  });

  it('lists the agents a destination can be shared with, as text', () => {
    const html = renderToString(
      <ShareOfferView
        destination={X_ALT}
        candidates={[row]}
        chosen={[]}
        busy={false}
        onToggle={() => {}}
        onShare={() => {}}
        onSkip={() => {}}
      />
    );
    expect(html).toContain('Share X / alt with');
    expect(html).toContain('&lt;i>mine&lt;/i>');
    const none = renderToString(
      <ShareOfferView
        destination={X_ALT}
        candidates={[]}
        chosen={[]}
        busy={false}
        onToggle={() => {}}
        onShare={() => {}}
        onSkip={() => {}}
      />
    );
    expect(none).toBe('');
    const expired = { ...row, grant: { ...grant, expires_at: 10 } };
    expect(shareCandidates([row, expired], X_ALT, 100)).toEqual([row]);
  });
});
