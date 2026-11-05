import { KIND_DRAFT_WRAP, verifyHttpAuth } from '@qusme/nostr';
import { FakeRelayNetwork, type FakeRelayOptions } from '@qusme/nostr/testing';
import { KeyStore } from '../src/keyStore.ts';
import type { SetupDeps } from '../src/setup/deps.ts';
import { MemoryStorageArea } from '../src/storage.ts';

export const ORIGIN = 'https://app.qus.me';
export const STORAGE = ['wss://storage-a.example', 'wss://storage-b.example'];
export const INBOX = ['wss://inbox.example'];
export const PASSPHRASE = 'plum anchor violet seventeen';
/** scrypt cost in tests: 64 MiB per operation instead of 256. */
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
