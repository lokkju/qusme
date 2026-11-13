/**
 * A queue on fake relays, and what a device does to it: publish a submitters list and a grant,
 * find a local agent's request by its code, and answer it (spec 7.3, 7.4, 7.7).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  type AgentGrantInput,
  buildAgentGrant,
  buildAgentRequestAnswer,
  buildSubmittersList,
  createLocalSigner,
  findAgentRequest,
  KIND_GIFT_WRAP,
  type NostrEvent,
  RelayConnection,
} from '@qusme/nostr';
import { FakeRelayNetwork } from '@qusme/nostr/testing';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  createLocalAgent,
  createLocalServer,
  createRelays,
  type LocalAgentOptions,
} from '../src/index.ts';

export const STORAGE = 'wss://storage.example';
export const INBOX = 'wss://inbox.example';

export const now = () => Math.floor(Date.now() / 1000);

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qusme-mcp-test-'));
}

export function queueOnFakeRelays() {
  const network = new FakeRelayNetwork();
  const storage = network.add(STORAGE);
  const inbox = network.add(INBOX, { restrictGiftWraps: true });
  const queueKey = generateSecretKey();
  const queue = createLocalSigner(queueKey);
  const queuePubkey = getPublicKey(queueKey);
  const inboxKey = generateSecretKey();
  const inboxPubkey = getPublicKey(inboxKey);
  let lastCreatedAt = now();
  const nextCreatedAt = () => {
    lastCreatedAt = Math.max(now(), lastCreatedAt + 1);
    return lastCreatedAt;
  };

  async function connect(url: string, as?: Uint8Array): Promise<RelayConnection> {
    const connection = await RelayConnection.open(url, { socket: network.socket, timeoutMs: 1000 });
    if (as !== undefined) {
      const signer = createLocalSigner(as);
      await connection.authenticate((t) => signer.signEvent(t));
    }
    return connection;
  }

  async function publish(url: string, event: NostrEvent): Promise<void> {
    const connection = await connect(url);
    try {
      await connection.publish(event);
    } finally {
      connection.close();
    }
  }

  /** What a device publishes on approval: the list naming the agents, then the grant. */
  async function approve(agentPubkey: string, grant: Partial<AgentGrantInput> = {}) {
    await setSubmitters([agentPubkey]);
    const event = await buildAgentGrant(
      queue,
      agentPubkey,
      {
        inbox: [INBOX],
        inbox_pubkey: inboxPubkey,
        destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
        allow_new_destinations: false,
        submission_expiration_days: 30,
        quota: { max_submissions: 50, period: 'day' },
        expires_at: null,
        storage: [STORAGE],
        ...grant,
      },
      { createdAt: nextCreatedAt() }
    );
    await publish(STORAGE, event);
  }

  async function setSubmitters(agents: string[]) {
    const labels = Object.fromEntries(
      agents.map((a) => [a, { label: 'Claude Desktop', authorized_at: now() }])
    );
    await publish(
      STORAGE,
      await buildSubmittersList(queue, labels, { createdAt: nextCreatedAt() })
    );
  }

  /** The device's look-up: the queue's gift wraps on the inbox relay, read as the queue key. */
  async function findRequest(code: string, handled?: Parameters<typeof findAgentRequest>[3]) {
    const connection = await connect(INBOX, queueKey);
    try {
      const wraps = await connection.query([{ kinds: [KIND_GIFT_WRAP], '#p': [queuePubkey] }]);
      return await findAgentRequest(wraps, queue, code, handled);
    } finally {
      connection.close();
    }
  }

  async function answer(agentPubkey: string, code: string, status: 'approved' | 'denied') {
    const wrap = await buildAgentRequestAnswer(queue, agentPubkey, {
      code,
      status,
      ...(status === 'approved' && { storage: [STORAGE] }),
    });
    await publish(INBOX, wrap);
  }

  /** Gift wraps on the inbox relay addressed to the inbox key: the agent's submissions. */
  const submissions = () =>
    inbox.events.filter(
      (e) => e.kind === KIND_GIFT_WRAP && e.tags.some((t) => t[0] === 'p' && t[1] === inboxPubkey)
    );

  return {
    network,
    storage,
    inbox,
    queueKey,
    queuePubkey,
    inboxPubkey,
    approve,
    setSubmitters,
    findRequest,
    answer,
    submissions,
  };
}

export type TestQueue = ReturnType<typeof queueOnFakeRelays>;

/** A local agent on the queue's fake relays, with an MCP client connected over memory. */
export async function localServer(
  q: TestQueue,
  options: Partial<LocalAgentOptions> = {},
  clientInfo = { name: 'claude-ai', version: '1.0.0' }
) {
  const dir = options.dir ?? tempDir();
  const lines: string[] = [];
  const agent = createLocalAgent({
    dir,
    queue: { pubkey: q.queuePubkey, relays: [INBOX] },
    relays: createRelays({ socket: q.network.socket, timeoutMs: 1000 }),
    registry: [],
    grantCacheSeconds: 0,
    log: (line) => lines.push(line),
    ...options,
  });
  const server = createLocalServer(agent, { version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(clientInfo);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result as { isError?: boolean; structuredContent: Record<string, unknown> };
  };
  return { agent, client, call, dir, lines, close: () => client.close() };
}

/** Waits until `check` holds, up to a second. */
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never held');
}
