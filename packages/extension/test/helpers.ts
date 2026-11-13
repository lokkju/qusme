import { bytesToHex } from '@noble/hashes/utils.js';
import {
  buildDestinations,
  buildSettings,
  createLocalSigner,
  D_DESTINATIONS,
  type Destination,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  newestFirst,
  parseDestinations,
  publishToAll,
  RelayConnection,
  type Settings,
  verifyHttpAuth,
} from '@qusme/nostr';
import { FakeRelayNetwork, type FakeRelayOptions } from '@qusme/nostr/testing';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { KeyStore, LOCAL_QUEUE, type QueueRecord, SESSION_UNLOCKED } from '../src/keyStore.ts';
import { closeAll, type SetupDeps } from '../src/setup/deps.ts';
import { MemoryStorageArea } from '../src/storage.ts';

export const ORIGIN = 'https://app.qus.me';
export const STORAGE = ['wss://storage-a.example', 'wss://storage-b.example'];
export const INBOX = ['wss://inbox.example'];
export const PASSPHRASE = 'plum anchor violet seventeen';
/**
 * scrypt cost in tests: 64 MiB per operation instead of 256, and NIP-49's floor, so no lower. A
 * create, recover or pairing test still runs several of these, which takes more than vitest's 5 s
 * default on a busy CI runner; the suites that do (key store, create, recover, pairing, agents) set
 * a 30 s timeout. packages/nostr's nip49 test is the one that runs `log_n` 18.
 */
export const TEST_LOG_N = 16;

export function network(storage: FakeRelayOptions = {}): FakeRelayNetwork {
  const net = new FakeRelayNetwork();
  for (const url of STORAGE) net.add(url, storage);
  // Like auth.nostr1.com: gift wraps only to their recipient, and no draft wraps (docs/relays.md).
  for (const url of INBOX)
    net.add(url, { restrictGiftWraps: true, refuseKinds: [KIND_DRAFT_WRAP] });
  return net;
}

/** The typed-code rendezvous of spec 8.3, in memory, verifying NIP-98 like the service. */
export class FakeService {
  readonly codes = new Map<string, { uri: string; expiresAt: number; pubkey: string }>();
  readonly posts: { pubkey: string; body: Record<string, unknown> }[] = [];
  readonly lookups: string[] = [];
  #serial = 0;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (method === 'POST' && url === `${ORIGIN}/pair`) {
      const body = String(init?.body ?? '');
      const headers = new Headers(init?.headers);
      const auth = verifyHttpAuth(headers.get('Authorization'), { url, method, body });
      if (!auth.ok) return json(401, { error: auth.error.message });
      const parsed = JSON.parse(body) as { uri: string; expires_at: number };
      this.posts.push({ pubkey: auth.value.pubkey, body: parsed });
      const code = `ABCD${String(++this.#serial).padStart(4, '0')}`;
      const expiresAt = Math.min(Math.floor(Date.now() / 1000) + 120, parsed.expires_at);
      this.codes.set(code, { uri: parsed.uri, expiresAt, pubkey: auth.value.pubkey });
      return json(201, { code, expires_at: expiresAt });
    }
    const match = url.match(/^https:\/\/app\.qus\.me\/pair\/([^/]+)$/);
    if (method === 'GET' && match) {
      const code = decodeURIComponent(match[1] as string);
      this.lookups.push(code);
      const row = this.codes.get(code);
      this.codes.delete(code);
      if (row === undefined) return json(404, { error: 'unknown or expired code' });
      return json(200, { uri: row.uri, expires_at: row.expiresAt });
    }
    return json(404, { error: 'not found' });
  }) as typeof fetch;
}

export interface Device {
  deps: SetupDeps;
  store: KeyStore;
  local: MemoryStorageArea;
  session: MemoryStorageArea;
  permissionRequests: number;
}

/** One extension install: its own storage, the shared relays and service. */
export function device(
  net: FakeRelayNetwork,
  service = new FakeService(),
  options: { grant?: boolean } = {}
): Device {
  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const store = new KeyStore({ local, session }, { logN: TEST_LOG_N });
  const result: Device = {
    store,
    local,
    session,
    permissionRequests: 0,
    deps: {
      store,
      socket: net.socket,
      relayTimeoutMs: 500,
      probe: { settleMs: 0 },
      logN: TEST_LOG_N,
      serviceOrigin: ORIGIN,
      fetch: service.fetch,
      requestServicePermission: async () => {
        result.permissionRequests += 1;
        return options.grant ?? true;
      },
    },
  };
  return result;
}

/** Resolves once `predicate` holds, polling briefly. */
export async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Creates a queue on a fresh device and returns it with the recovery code and keys. */
export async function createdDevice(net: FakeRelayNetwork, service = new FakeService()) {
  const { confirmRecoveryCode, finishCreate, startCreate } = await import('../src/setup/create.ts');
  const a = device(net, service);
  const draft = startCreate();
  const words = draft.words.join(' ');
  const base32 = draft.base32;
  const secretKey = draft.secretKey.slice();
  const inboxKey = draft.inboxKey.slice();
  const npub = draft.npub;
  const pubkey = draft.pubkey;
  confirmRecoveryCode(draft, words);
  await finishCreate(
    draft,
    { passphrase: PASSPHRASE, storageRelays: STORAGE, inboxRelays: INBOX },
    a.deps
  );
  return Object.assign(a, { words, base32, secretKey, inboxKey, npub, pubkey });
}

/**
 * An unlocked queue on the fake storage relays with a destinations event that carries keys this
 * version does not know (spec 7, "Unknown fields"): one at the top of the content, one on the
 * destination, and an extra event tag. No service; for the destination flows. `settings` adds to
 * the settings event (an `archive_retention_days`, say).
 */
export async function destinationsQueue(
  options: { destinations?: Destination[]; settings?: Partial<Settings> } = {}
) {
  const net = network();
  const secretKey = generateSecretKey();
  const inboxKey = generateSecretKey();
  const queue = createLocalSigner(secretKey);
  const pubkey = getPublicKey(secretKey);
  const settings = await buildSettings(queue, {
    inbox_key: bytesToHex(inboxKey),
    inbox_relays: INBOX,
    quota_counts: {},
    ...options.settings,
  });
  const destinations = options.destinations ?? [
    {
      id: 'dest-x-alt',
      site: 'x',
      account: 'alt',
      label: 'X / alt',
      status: 'confirmed',
      override: null,
      extra: { color: 'teal' },
    },
  ];
  const listEvent = await buildDestinations(
    queue,
    { destinations, extra: { sort: 'label' } },
    { extraTags: [['future', 'kept']] }
  );
  const connections = await Promise.all(
    STORAGE.map((url) => RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 }))
  );
  for (const event of [settings, listEvent]) await publishToAll(connections, event);

  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const record: QueueRecord = {
    version: 1,
    pubkey,
    ncryptsec: 'ncryptsec1unused',
    storageRelays: STORAGE,
    settings,
  };
  await local.set({ [LOCAL_QUEUE]: record });
  await session.set({
    [SESSION_UNLOCKED]: { queue: bytesToHex(secretKey), inbox: bytesToHex(inboxKey) },
  });
  const store = new KeyStore({ local, session });
  let syncRequests = 0;
  const deps: SetupDeps = {
    store,
    socket: net.socket,
    relayTimeoutMs: 500,
    serviceOrigin: ORIGIN,
    fetch: (async () => new Response('not found', { status: 404 })) as typeof fetch,
    requestServicePermission: async () => true,
    requestSync: async () => {
      syncRequests += 1;
    },
  };

  /** Publishes `event` to every storage relay. */
  const publish = async (event: NostrEvent) => {
    for (const c of connections) await c.publish(event).catch(() => undefined);
  };

  /** The newest destinations event on each storage relay, decrypted. */
  const onRelays = async () => {
    const out = [];
    for (const url of STORAGE) {
      const event = net
        .get(url)
        .events.filter(
          (e) =>
            e.kind === KIND_APP_DATA &&
            e.pubkey === pubkey &&
            e.tags.some((t) => t[0] === 'd' && t[1] === D_DESTINATIONS)
        )
        .sort(newestFirst)[0];
      const parsed = await parseDestinations(event, queue);
      if (!parsed.ok) throw new Error(`no destinations on ${url}`);
      out.push(parsed.value);
    }
    return out;
  };

  return {
    net,
    queue,
    pubkey,
    store,
    session,
    deps,
    publish,
    onRelays,
    syncRequests: () => syncRequests,
    close: () => closeAll(connections),
  };
}
