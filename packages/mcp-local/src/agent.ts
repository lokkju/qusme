/**
 * The local agent (spec 8.6): its key, its approval through the queue's inbox relay (7.7, D29),
 * and the {@link ToolSession} the shared tools run on. Grants and the submitters list are read
 * from the queue's storage relays as the agent key, exactly as the service reads them (8.4): the
 * same caches, the same checks, the same move to a newer grant's `storage`. What the service
 * keeps in its database this keeps in files under the config directory.
 */
import {
  type AgentAuth,
  checkGrant,
  checkStorageRelays,
  createGrantCache,
  createSubmittersCache,
  loadRegistry,
  type Registry,
  type RegistrySnapshot,
  storageMoveFor,
  ToolError,
  type ToolSession,
} from '@qusme/core/mcp';
import {
  AGENT_REQUEST_TTL_SECONDS,
  type AgentGrant,
  buildAgentRequest,
  createLocalSigner,
  displayApprovalCode,
  generatePairingCode,
  KIND_GIFT_WRAP,
  NIP59_TIMESTAMP_JITTER,
  type NostrEvent,
  openAgentRequestAnswer,
} from '@qusme/nostr';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { loadOrCreateAgentKey } from './agentKey.ts';
import type { QueueId } from './queueId.ts';
import { DEFAULT_INBOX_RELAYS } from './queueId.ts';
import { createReceiptLog } from './receipts.ts';
import { createRelays, type Relays } from './relays.ts';
import { type LocalState, type PendingRequest, readState, writeState } from './state.ts';

/** Highest grant `min_pow` mined by default: about 16 million hashes, under a minute for a short value. */
export const DEFAULT_LOCAL_MAX_POW = 24;
/** A pending code is replaced once it has less than this left, so the user never types a dying one. */
const CODE_MIN_REMAINING = 60;
/** Seconds a grant read from the relays is reused, as at the service. */
const GRANT_CACHE_SECONDS = 30;

export interface LocalAgentOptions {
  /** The config directory: agent key, state and receipts. */
  dir: string;
  /** `--queue`; may be left out once the state names a queue. */
  queue?: QueueId;
  /** `--inbox`, overriding the nprofile's hints and the default. */
  inbox?: string[];
  /** `--name`, overriding what the MCP client calls itself. */
  name?: string;
  relays?: Relays;
  registry?: RegistrySnapshot;
  /** Unix seconds. */
  now?: () => number;
  maxPow?: number;
  /** Lines for the user, on stderr in the CLI. */
  log?: (line: string) => void;
  grantCacheSeconds?: number;
}

export type ApprovalStatus = 'approved' | 'pending' | 'denied';

/** `npub1abcdefgh…uvwxyz`, as the extension's approval screen shows an agent key. */
export function shortNpub(pubkey: string): string {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

export class LocalAgentConfigError extends Error {}

export function createLocalAgent(options: LocalAgentOptions) {
  const { dir } = options;
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? (() => undefined);
  const key = loadOrCreateAgentKey(dir);
  const signer = createLocalSigner(key);
  const agentPubkey = getPublicKey(key);
  const relays = options.relays ?? createRelays();
  const registry: Registry = loadRegistry(options.registry);
  const receipts = createReceiptLog(dir);
  const maxPow = options.maxPow ?? DEFAULT_LOCAL_MAX_POW;
  const cacheOptions = {
    relayReader: relays.reader,
    ttlSeconds: options.grantCacheSeconds ?? GRANT_CACHE_SECONDS,
  };
  const grants = createGrantCache(cacheOptions);
  const submitters = createSubmittersCache(cacheOptions);
  let clientName = options.name;

  let state = initialState();
  writeState(dir, state);

  function initialState(): LocalState {
    const saved = readState(dir);
    const queue = options.queue;
    if (queue === undefined && saved === undefined) {
      throw new LocalAgentConfigError(
        'Pass your Queue ID once with --queue npub1…; the qus.me extension shows it.'
      );
    }
    const inbox =
      options.inbox && options.inbox.length > 0
        ? options.inbox
        : queue !== undefined && queue.relays.length > 0
          ? queue.relays
          : undefined;
    // Another queue than last time starts over: approval is per queue.
    if (saved === undefined || (queue !== undefined && queue.pubkey !== saved.queue_pubkey)) {
      return {
        version: 1,
        queue_pubkey: (queue as QueueId).pubkey,
        inbox_relays: inbox ?? [...DEFAULT_INBOX_RELAYS],
      };
    }
    return inbox === undefined ? saved : { ...saved, inbox_relays: inbox };
  }

  function save(next: LocalState): void {
    state = next;
    writeState(dir, state);
  }

  function agentAuth(): AgentAuth {
    return {
      agentKeyId: 'local',
      agentPubkey,
      clientId: 'local',
      scopes: [],
      queuePubkey: state.queue_pubkey,
      storageRelays: state.storage_relays ?? [],
      storageGrantAt: state.storage_grant_at ?? null,
    };
  }

  function codeMessage(request: PendingRequest, now: number): string {
    const minutes = Math.max(1, Math.round((request.expires_at - now) / 60));
    return (
      `Open the qus.me extension, choose "Approve an agent" and enter ${displayApprovalCode(request.code)}. ` +
      `It expires in about ${minutes} minute${minutes === 1 ? '' : 's'}. The approval screen shows ` +
      `this server's agent key as ${shortNpub(agentPubkey)}.`
    );
  }

  /**
   * The request the user approves: the pending one while it has time left, else a fresh code. It
   * goes to the inbox relays once; a relay that refuses it is reported, and the next call retries.
   */
  let inFlight: Promise<PendingRequest> | undefined;
  function ensureRequest(): Promise<PendingRequest> {
    // One at a time: the client's initialize and its first tool call both ask at start.
    inFlight ??= sendRequest().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function sendRequest(): Promise<PendingRequest> {
    const now = clock();
    let request = state.request;
    if (request === undefined || request.expires_at - now < CODE_MIN_REMAINING) {
      request = {
        code: generatePairingCode(),
        expires_at: now + AGENT_REQUEST_TTL_SECONDS,
        client_name: clientName ?? 'Local MCP server',
      };
      save({ ...state, request });
      log(`qus.me: this MCP server is not approved yet. ${codeMessage(request, now)}`);
    }
    if (request.published_at === undefined) {
      const wrap = await buildAgentRequest(
        signer,
        state.queue_pubkey,
        { clientName: request.client_name, code: request.code, expiresAt: request.expires_at },
        { now }
      );
      // A key of the connection's own: the inbox relay learns nothing about the agent from AUTH.
      const connectionKey = generateSecretKey();
      let results: Awaited<ReturnType<Relays['publisher']['publish']>>;
      try {
        results = await relays.publisher.publish({
          relays: state.inbox_relays,
          event: wrap,
          auth: createLocalSigner(connectionKey),
        });
      } finally {
        connectionKey.fill(0);
      }
      if (!results.some((r) => r.ok)) {
        const why = results.map((r) => `${r.relay}: ${r.message}`).join('; ');
        log(`qus.me: the approval request did not reach the inbox relay (${why}).`);
        throw new ToolError(
          'approval_required',
          "This qus.me server could not send its approval request to the queue's inbox relay " +
            `(${why}). Nothing was submitted. If the user's queue uses another inbox relay, ` +
            "they can add --inbox wss://… to this server's configuration.",
          { code: displayApprovalCode(request.code), inbox_relays: state.inbox_relays }
        );
      }
      request = { ...request, published_at: now };
      save({ ...state, request });
    }
    return request;
  }

  /** Reads the queue's answer to the pending request from the inbox relays, as the agent key. */
  async function checkAnswer(): Promise<ApprovalStatus> {
    if (state.storage_relays !== undefined) return 'approved';
    const request = state.request;
    if (request?.published_at === undefined) return 'pending';
    const events = (await relays.reader.query({
      relays: state.inbox_relays,
      filter: {
        kinds: [KIND_GIFT_WRAP],
        '#p': [agentPubkey],
        // NIP-59 backdates a wrap's created_at by up to two days.
        since: request.published_at - NIP59_TIMESTAMP_JITTER - 60,
      },
      auth: signer,
    })) as NostrEvent[];
    for (const event of events) {
      const opened = await openAgentRequestAnswer(event, signer, {
        queuePubkey: state.queue_pubkey,
      });
      if (!opened.ok || opened.value.code !== request.code) continue;
      const answer = opened.value;
      if (answer.status === 'denied') {
        const { request: _dropped, ...rest } = state;
        save({ ...rest, denied_at: clock() });
        log('qus.me: the request was denied in the qus.me extension.');
        return 'denied';
      }
      const storage = checkStorageRelays((answer.storage ?? []).slice(0, 5));
      if (typeof storage === 'string') continue;
      const { request: _done, denied_at: _old, ...rest } = state;
      save({ ...rest, storage_relays: storage, storage_grant_at: null });
      log(`qus.me: approved. Reading the grant from ${storage.join(', ')}.`);
      return 'approved';
    }
    return 'pending';
  }

  /** Throws `approval_required` with the code the user should enter, after sending the request. */
  async function requireApproval(denied: boolean): Promise<never> {
    const request = await ensureRequest();
    const now = clock();
    throw new ToolError(
      'approval_required',
      (denied
        ? 'The user denied the last request from this qus.me server. '
        : 'This qus.me server is waiting for the user to approve it. ') +
        `Nothing was done. Ask the user to approve it: ${codeMessage(request, now)} ` +
        'Then call this tool again.',
      {
        code: displayApprovalCode(request.code),
        expires_at: request.expires_at,
        agent_key: npubEncode(agentPubkey),
      }
    );
  }

  /** The current grant, as the service reads it (8.4), once the user has approved this agent. */
  async function currentGrant(now: number): Promise<AgentGrant> {
    if (state.storage_relays === undefined) {
      let status: ApprovalStatus = 'pending';
      try {
        status = await checkAnswer();
      } catch {
        status = 'pending';
      }
      if (status !== 'approved') return requireApproval(status === 'denied');
    }
    const agent = agentAuth();
    const [found, list] = await Promise.all([
      grants.get(agent, signer, now).catch(() => undefined),
      submitters.get(agent, signer, now),
    ]);
    if (found === undefined && list === undefined) {
      throw new ToolError(
        'grant_not_found',
        "No grant for this agent was found on the queue's storage relays " +
          `(${agent.storageRelays.join(', ')}). They may be unreachable; try again shortly.`
      );
    }
    let checked: NonNullable<typeof found>;
    try {
      checked = checkGrant(found, list?.submitters, agentPubkey, now);
    } catch (error) {
      if (error instanceof ToolError && error.code === 'grant_revoked') {
        throw new ToolError(
          'grant_revoked',
          `${error.message} To ask again, the user runs: npx @qusme/mcp approve`
        );
      }
      throw error;
    }
    if (list === undefined) {
      log('qus.me: no storage relay returned the submitters list; going ahead on the grant.');
    }
    const moveTo = storageMoveFor(agent, checked);
    if (moveTo !== undefined) {
      save({ ...state, storage_relays: moveTo, storage_grant_at: checked.createdAt });
      log(`qus.me: the queue moved to ${moveTo.join(', ')}.`);
    }
    return checked.grant;
  }

  function toolSession(): ToolSession {
    const now = clock();
    return {
      now,
      currentGrant: () => currentGrant(now),
      countSince: async (start) => receipts.countSince(start),
      withAgentSigner: (fn) => fn(signer),
      publisher: relays.publisher,
      recordReceipt: async (receipt) => {
        receipts.append({ ...receipt, queuePubkey: state.queue_pubkey });
      },
      listReceipts: async (page) => receipts.list(now, page),
      maxPow,
      minerName: 'this local qus.me server',
    };
  }

  return {
    agentPubkey,
    registry,
    toolSession,
    ensureRequest,
    checkAnswer,
    codeMessage: (request: PendingRequest) => codeMessage(request, clock()),
    /** The MCP client's name, for the request; `--name` wins. */
    setClientName(name: string) {
      if (options.name === undefined) clientName = name;
    },
    /** Forgets the approval, so the next request asks again (after a revocation). */
    resetApproval() {
      const { storage_relays: _s, storage_grant_at: _g, request: _r, ...rest } = state;
      save(rest);
      grants.clear();
      submitters.clear();
    },
    get state(): LocalState {
      return state;
    },
  };
}

export type LocalAgent = ReturnType<typeof createLocalAgent>;
