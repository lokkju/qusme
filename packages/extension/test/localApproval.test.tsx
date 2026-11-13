// @vitest-environment happy-dom
/**
 * Approving a local MCP server through the inbox relay (spec 7.7, 8.6, 11.8; D29): the request a
 * local server gift-wraps to the queue key, found by its code among the queue's inbox events,
 * approved or denied with nothing sent to app.qus.me, refused once expired or already answered,
 * and revoked without the service. The last suite runs the real local server (`@qusme/mcp`)
 * against the same fake relays, from its first tool call to its first draft.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  buildAgentRequest,
  createLocalSigner,
  KIND_AGENT_GRANT,
  KIND_GIFT_WRAP,
  KIND_SUBMITTERS,
  type NostrEvent,
  openAgentRequestAnswer,
  parseSubmittersList,
  publishToAll,
  RelayConnection,
} from '@qusme/nostr';
import type { FakeRelayNetwork } from '@qusme/nostr/testing';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalAgent, createLocalServer, createRelays } from '../../mcp-local/src/index.ts';
import { defaultChoices } from '../src/agents/approve.ts';
import {
  approveLocalAgent,
  denyLocalAgent,
  findLocalRequest,
  LocalRequestRefused,
  localServerCommand,
} from '../src/agents/localRequest.ts';
import { readPendingRevocations } from '../src/agents/pendingRevocations.ts';
import { revokeAgent } from '../src/agents/revoke.ts';
import { ApproveAgentScreen } from '../src/ui/agents.tsx';
import { createdDevice, FakeService, INBOX, network, STORAGE, until } from './helpers.ts';

const now = () => Math.floor(Date.now() / 1000);
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A service that fails the test if anything reaches it: local approvals never should. */
class NoService extends FakeService {
  readonly calls: string[] = [];
  override readonly fetch = (async (input: RequestInfo | URL) => {
    this.calls.push(String(input));
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
}

async function publish(net: FakeRelayNetwork, urls: readonly string[], event: NostrEvent) {
  const connections = await Promise.all(
    urls.map((url) => RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 }))
  );
  const report = await publishToAll(connections, event);
  for (const c of connections) c.close();
  expect(report.refused).toEqual([]);
}

/** What a local server sends: its request, gift-wrapped to the queue key on the inbox relay. */
async function localRequest(
  net: FakeRelayNetwork,
  queuePubkey: string,
  options: { code?: string; createdAt?: number; expiresAt?: number; key?: Uint8Array } = {}
) {
  const key = options.key ?? generateSecretKey();
  const createdAt = options.createdAt ?? now();
  const wrap = await buildAgentRequest(
    createLocalSigner(key),
    queuePubkey,
    {
      clientName: 'Claude Desktop',
      code: options.code ?? 'QK7D-M4XR',
      expiresAt: options.expiresAt ?? createdAt + 600,
    },
    { now: createdAt }
  );
  await publish(net, INBOX, wrap);
  return { key, pubkey: getPublicKey(key) };
}

async function setup() {
  const net = network();
  const service = new NoService();
  const d = await createdDevice(net, service);
  return { net, service, d };
}

/** The gift wraps on the inbox relay addressed to `pubkey`. */
const wrapsFor = (net: FakeRelayNetwork, pubkey: string) =>
  net
    .get(INBOX[0] as string)
    .events.filter((e) => e.kind === KIND_GIFT_WRAP && e.tags.some((t) => t[1] === pubkey));

describe('local agent requests on the inbox relay (spec 7.7)', () => {
  it('finds the request by its code and approves it without app.qus.me', async () => {
    const { net, service, d } = await setup();
    const agent = await localRequest(net, d.pubkey);
    const request = await findLocalRequest('qk7d m4xr', d.deps);
    expect(request).toMatchObject({
      source: 'local',
      code: 'QK7D-M4XR',
      agentPubkey: agent.pubkey,
      clientName: 'Claude Desktop',
    });

    await approveLocalAgent(request, defaultChoices(request, []), d.deps);
    expect(service.calls).toEqual([]);
    expect(d.permissionRequests).toBe(0);

    // The list names the agent, its label marked local, and the grant is on every storage relay.
    const queue = createLocalSigner(d.secretKey);
    for (const url of STORAGE) {
      const events = net.get(url).events;
      const list = events.find((e) => e.kind === KIND_SUBMITTERS) as NostrEvent;
      const parsed = await parseSubmittersList(list, queue);
      expect(parsed.ok && parsed.value.labels[agent.pubkey]?.extra).toEqual({ local: true });
      expect(events.some((e) => e.kind === KIND_AGENT_GRANT)).toBe(true);
    }
    // The answer goes back to the agent key with the storage relays.
    const [answerWrap] = wrapsFor(net, agent.pubkey);
    const answer = await openAgentRequestAnswer(
      answerWrap as NostrEvent,
      createLocalSigner(agent.key),
      { queuePubkey: d.pubkey }
    );
    expect(answer.ok && answer.value).toMatchObject({ status: 'approved', storage: STORAGE });
  });

  it('refuses the same request or code again once answered', async () => {
    const { net, d } = await setup();
    await localRequest(net, d.pubkey);
    const request = await findLocalRequest('QK7D-M4XR', d.deps);
    await denyLocalAgent(request, d.deps);
    await expect(findLocalRequest('QK7D-M4XR', d.deps)).rejects.toThrow(LocalRequestRefused);
    // A new request from another key reusing the answered code is refused too.
    await localRequest(net, d.pubkey);
    await expect(findLocalRequest('QK7D-M4XR', d.deps)).rejects.toThrow(/already/);
  });

  it('refuses an expired request', async () => {
    const { net, d } = await setup();
    await localRequest(net, d.pubkey);
    // Relays drop the wrap at its NIP-40 expiration; a relay that keeps it, or a device clock
    // past the request's expiry, still gets a refusal.
    const later = { ...d.deps, now: () => now() + 601 };
    await expect(findLocalRequest('QK7D-M4XR', later)).rejects.toThrow(/expired/);
  });

  it('says plainly when no request has the code, for the screen to try app.qus.me', async () => {
    const { d } = await setup();
    const error = await findLocalRequest('ZZZZ-ZZZZ', d.deps).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LocalRequestRefused);
  });

  it('denies with an answer and publishes nothing to the queue', async () => {
    const { net, d } = await setup();
    const agent = await localRequest(net, d.pubkey);
    await denyLocalAgent(await findLocalRequest('QK7D-M4XR', d.deps), d.deps);
    expect(net.get(STORAGE[0] as string).events.some((e) => e.kind === KIND_SUBMITTERS)).toBe(
      false
    );
    const [wrap] = wrapsFor(net, agent.pubkey);
    const answer = await openAgentRequestAnswer(wrap as NostrEvent, createLocalSigner(agent.key), {
      queuePubkey: d.pubkey,
    });
    expect(answer.ok && answer.value.status).toBe('denied');
  });

  it('revokes a local agent on the relays alone', async () => {
    const { net, service, d } = await setup();
    await localRequest(net, d.pubkey);
    const request = await findLocalRequest('QK7D-M4XR', d.deps);
    await approveLocalAgent(request, defaultChoices(request, []), d.deps);
    const result = await revokeAgent(request.agentPubkey, d.deps);
    expect(result).toMatchObject({ listUpdated: true, service: 'not_bound', local: true });
    expect(service.calls).toEqual([]);
    expect(await readPendingRevocations(d.store)).toEqual([]);
  });

  it('offers the command that starts the local server for this queue', async () => {
    const { d } = await setup();
    const command = await localServerCommand(d.store);
    expect(command).toMatch(/^npx @qusme\/mcp --queue nprofile1/);
  });
});

describe('the approve screen with a local code', () => {
  let root: HTMLElement | undefined;
  afterEach(() => {
    if (root !== undefined) render(null, root);
    document.body.innerHTML = '';
  });
  const host = () => root as HTMLElement;
  const button = (name: string) => {
    const found = [...host().querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name
    );
    if (found === undefined) throw new Error(`no button ${name}`);
    return found;
  };
  const submit = () =>
    host()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  function type(value: string) {
    const input = host().querySelector<HTMLInputElement>('#approval-code');
    if (input === null) throw new Error('no code input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('reviews the local request, shows its agent key and approves it', async () => {
    const { net, service, d } = await setup();
    const agent = await localRequest(net, d.pubkey);
    root = document.createElement('div');
    document.body.append(root);
    let done = false;
    render(
      <ApproveAgentScreen
        deps={d.deps}
        onDone={() => {
          done = true;
        }}
        onBack={() => undefined}
      />,
      root
    );
    type('QK7D-M4XR');
    await settle();
    submit();
    await until(() => host().querySelector('[data-local-request]') !== null, 10_000);
    expect(host().textContent).toContain('Claude Desktop');
    expect(host().querySelector('[data-agent-key]')?.textContent).toMatch(/^npub1/);
    button('Approve anyway').click();
    await until(() => host().textContent?.includes('Told the MCP server') ?? false, 10_000);
    expect(service.calls).toEqual([]);
    expect(wrapsFor(net, agent.pubkey)).toHaveLength(1);
    button('Back to drafts').click();
    expect(done).toBe(true);
  });

  it('offers app.qus.me for a code no local server sent, without asking for permission', async () => {
    const { d } = await setup();
    root = document.createElement('div');
    document.body.append(root);
    render(
      <ApproveAgentScreen deps={d.deps} onDone={() => undefined} onBack={() => undefined} />,
      root
    );
    type('ZZZZ-ZZZZ');
    await settle();
    submit();
    await until(() => host().textContent?.includes('Look up at app.qus.me') ?? false, 10_000);
    expect(d.permissionRequests).toBe(0);
  });
});

describe('the local MCP server end to end', () => {
  it('asks, is approved in the extension, and drafts into the queue', async () => {
    const { net, service, d } = await setup();
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const agent = createLocalAgent({
      dir: mkdtempSync(join(tmpdir(), 'qusme-ext-local-')),
      queue: { pubkey: d.pubkey, relays: INBOX },
      relays: createRelays({ socket: net.socket, timeoutMs: 1000 }),
      registry: [],
      grantCacheSeconds: 0,
    });
    const server = createLocalServer(agent, { version: 'test' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(clientSide);
    try {
      const first = (await client.callTool({ name: 'list_destinations', arguments: {} })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(first.structuredContent.error).toBe('approval_required');
      const code = first.structuredContent.code as string;

      const request = await findLocalRequest(code, d.deps);
      expect(request.clientName).toBe('Claude Code');
      expect(request.agentPubkey).toBe(agent.agentPubkey);
      await approveLocalAgent(
        request,
        { ...defaultChoices(request, []), allowNewDestinations: true },
        d.deps
      );

      const draft = (await client.callTool({
        name: 'create_draft',
        arguments: { site: 'x', account: 'lokkju', field: 'text', value: 'from my laptop' },
      })) as { isError?: boolean; structuredContent: Record<string, unknown> };
      expect(draft.isError).toBeFalsy();
      expect(draft.structuredContent.pending_destination).toBe(true);
      expect(service.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
