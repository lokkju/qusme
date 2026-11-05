/**
 * What the setup flows need from the outside world, injected so tests run them against fake
 * relays, a fake service and in-memory storage.
 */
import {
  type AuthSigner,
  D_RECOVERY,
  D_SETTINGS,
  KIND_APP_DATA,
  KIND_PRIVATE_RELAYS,
  type NostrEvent,
  newestFirst,
  type PrivateRelayList,
  type ProbeOptions,
  parsePrivateRelayList,
  parseRecoveryBackup,
  parseSettings,
  queryAll,
  RelayConnection,
  type Signer,
  type SocketFactory,
} from '@qusme/nostr';
import type { KeyStore } from '../keyStore.ts';

export interface SetupDeps {
  store: KeyStore;
  /** The relay client's socket; defaults to the platform `WebSocket`. */
  socket?: SocketFactory;
  /** Milliseconds the relay client waits for an answer. */
  relayTimeoutMs?: number;
  /** Options for the 9.1 probes (tests shorten the settle time). */
  probe?: ProbeOptions;
  /** scrypt cost for the recovery backup; tests lower it. Defaults to 18 (6.1). */
  logN?: number;
  /** The service origin, `https://app.qus.me`. */
  serviceOrigin: string;
  fetch: typeof fetch;
  /**
   * Asks for the optional host permission for the service origin (spec 11.2). The UI calls the
   * flow from the click handler, and the flow calls this before anything else it awaits, since
   * Firefox grants a permission request only inside the user's gesture.
   */
  requestServicePermission: () => Promise<boolean>;
  /**
   * Asks the background to sync (spec 11.4) and resolves when it has; the popup calls it on open.
   * Absent where there is no background, as in tests of the setup flows.
   */
  requestSync?: () => Promise<unknown>;
}

/** A setup step failed in a way the user can act on; `message` is written for them. */
export class SetupError extends Error {}

/** Opens a connection to each relay that answers; the ones that don't are reported. */
export async function openRelays(
  urls: readonly string[],
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>,
  autoAuth?: AuthSigner
): Promise<{ connections: RelayConnection[]; failed: { url: string; reason: string }[] }> {
  const results = await Promise.allSettled(
    urls.map((url) =>
      RelayConnection.open(url, {
        ...(deps.socket && { socket: deps.socket }),
        ...(deps.relayTimeoutMs !== undefined && { timeoutMs: deps.relayTimeoutMs }),
        ...(autoAuth && { autoAuth }),
      })
    )
  );
  const connections: RelayConnection[] = [];
  const failed: { url: string; reason: string }[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') connections.push(result.value);
    else failed.push({ url: urls[i] as string, reason: (result.reason as Error).message });
  });
  return { connections, failed };
}

export const closeAll = (connections: readonly RelayConnection[]): void => {
  for (const connection of connections) connection.close();
};

/** What a device reads about a queue once it holds the key. */
export interface QueueState {
  /** The queue's kind 10013, the authority on its storage relays (8.3 step 7). */
  relayList?: PrivateRelayList;
  /** The newest valid settings event (7.2). */
  settings?: NostrEvent;
  /** The newest valid recovery backup event (6.1). */
  recoveryBackup?: NostrEvent;
}

/**
 * Reads the queue's kind 10013 from `relays`, then its settings and recovery backup from the
 * storage relays the 10013 names (or from `relays` when there is none). A relay that asks for
 * AUTH gets the queue key (spec 9.2).
 */
export async function loadQueueState(
  signer: Signer,
  relays: readonly string[],
  deps: Pick<SetupDeps, 'socket' | 'relayTimeoutMs'>
): Promise<QueueState> {
  const pubkey = await signer.getPublicKey();
  const auth: AuthSigner = (template) => signer.signEvent(template);
  const state: QueueState = {};
  const first = await openRelays(relays, deps, auth);
  try {
    const lists = await queryAll(first.connections, [
      { kinds: [KIND_PRIVATE_RELAYS], authors: [pubkey] },
    ]);
    for (const event of lists) {
      const parsed = await parsePrivateRelayList(event, signer);
      if (parsed.ok) {
        state.relayList = parsed.value;
        break;
      }
    }
  } finally {
    closeAll(first.connections);
  }
  const storage = state.relayList?.relays ?? relays;
  const second = await openRelays(storage, deps, auth);
  try {
    const events = await queryAll(second.connections, [
      { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [D_SETTINGS, D_RECOVERY] },
    ]);
    for (const event of events.sort(newestFirst)) {
      const d = event.tags.find((t) => t[0] === 'd')?.[1];
      if (d === D_SETTINGS && state.settings === undefined) {
        if ((await parseSettings(event, signer)).ok) state.settings = event;
      } else if (d === D_RECOVERY && state.recoveryBackup === undefined) {
        if (parseRecoveryBackup(event, { queuePubkey: pubkey }).ok) state.recoveryBackup = event;
      }
    }
  } finally {
    closeAll(second.connections);
  }
  return state;
}

/** True when two relay lists name the same relays, in any order. */
export function sameRelays(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) => [...new Set(list.map(normalizeRelayUrl))].sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((url, i) => url === y[i]);
}

/**
 * A relay URL as the user typed it, trimmed, with `wss://` added when no scheme was given and a
 * lone trailing slash dropped. Returns undefined for anything that is not a `wss://` or `ws://`
 * URL with a host.
 */
export function normalizeRelayUrl(input: string): string {
  return cleanRelayUrl(input) ?? input.trim();
}

export function cleanRelayUrl(input: string): string | undefined {
  let text = input.trim();
  if (text === '') return undefined;
  if (!/^[a-z]+:\/\//i.test(text)) text = `wss://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || url.hostname === '') return undefined;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined;
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}
