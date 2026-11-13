/**
 * Approving a local MCP server through the queue's inbox relay (spec 7.7, 8.6, 11.8; D29). The
 * local server gift-wraps a request to the queue key and shows the user a code in the hosted
 * code's format. Typing that code into "Approve an agent" looks for the request among the queue's
 * gift wraps on its inbox relays, read as the queue key on a connection of its own (so the relay
 * does not see the queue key and the inbox key authenticate together), instead of asking
 * app.qus.me. Approving publishes the submitters list and the grant as a hosted approval does,
 * then answers the server with the queue's storage relays; a local agent has no service binding,
 * so nothing goes to app.qus.me and no host permission is needed.
 *
 * A request this device answered is remembered by rumor id and code in `storage.local` until it
 * could no longer be valid, so a replayed request or a reused code is refused.
 */
import {
  AGENT_REQUEST_MISS_MESSAGES,
  type AgentRequest,
  buildAgentRequestAnswer,
  createLocalSigner,
  displayApprovalCode,
  findAgentRequest,
  KIND_GIFT_WRAP,
  MAX_AGENT_REQUEST_TTL_SECONDS,
  NIP59_TIMESTAMP_JITTER,
  type NostrEvent,
  parseSettings,
  publishToAll,
  queryAll,
} from '@qusme/nostr';
import { nprofileEncode, npubEncode } from 'nostr-tools/nip19';
import { type KeyStore, LOCAL_HANDLED_AGENT_REQUESTS } from '../keyStore.ts';
import { closeAll, openRelays, SetupError } from '../setup/deps.ts';
import { type ApprovalChoices, publishApproval } from './approve.ts';
import { type AgentDeps, LOCKED_MESSAGE, readQueue, withQueue } from './queue.ts';

/** A local server's request as the approval screen shows it. */
export interface LocalAgentRequest {
  source: 'local';
  /** `XXXX-XXXX`. */
  code: string;
  agentPubkey: string;
  /** What the MCP client calls itself, or the server's `--name`; anyone can claim any name. */
  clientName: string;
  /** Unix seconds. */
  expiresAt: number;
  rumorId: string;
}

export const isLocalRequest = (request: object): request is LocalAgentRequest =>
  (request as { source?: unknown }).source === 'local';

/**
 * A local look-up found a request for the code but can't use it (expired, ambiguous, already
 * answered, already approved). Any other failure, including no request at all, lets the screen
 * try the code at app.qus.me, since both kinds of code look the same.
 */
export class LocalRequestRefused extends SetupError {}

interface Handled {
  rumorId: string;
  code: string;
  /** Unix seconds after which the record can go: no request it matches could still be open. */
  until: number;
}

type Store = Pick<KeyStore, 'local'>;

async function readHandled(store: Store, now: number): Promise<Handled[]> {
  const value = (await store.local.get([LOCAL_HANDLED_AGENT_REQUESTS]))[
    LOCAL_HANDLED_AGENT_REQUESTS
  ];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Handled =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Handled).rumorId === 'string' &&
      typeof (v as Handled).code === 'string' &&
      typeof (v as Handled).until === 'number' &&
      (v as Handled).until > now
  );
}

async function markHandled(store: Store, request: LocalAgentRequest, now: number): Promise<void> {
  const kept = await readHandled(store, now);
  const until = Math.max(request.expiresAt, now) + MAX_AGENT_REQUEST_TTL_SECONDS;
  const code = request.code.replace('-', '');
  await store.local.set({
    [LOCAL_HANDLED_AGENT_REQUESTS]: [...kept, { rumorId: request.rumorId, code, until }],
  });
}

/** Opens the inbox relays as the queue key; throws when none can be reached. */
async function openInbox(
  urls: readonly string[],
  deps: AgentDeps,
  sign: Parameters<typeof openRelays>[2]
) {
  if (urls.length === 0) {
    throw new SetupError(
      'The queue settings name no inbox relay, so no local request can reach it.'
    );
  }
  const opened = await openRelays(urls, deps, sign);
  if (opened.connections.length === 0) {
    throw new SetupError(`Could not reach the inbox relay ${urls.join(', ')}.`);
  }
  return opened.connections;
}

/**
 * Finds the open local request carrying `code` on the queue's inbox relays. Throws
 * {@link SetupError} saying why when there is none, or when the agent is already approved.
 */
export async function findLocalRequest(code: string, deps: AgentDeps): Promise<LocalAgentRequest> {
  return withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    const inboxRelays = snapshot.settings?.content.inbox_relays ?? [];
    const connections = await openInbox(inboxRelays, deps, (t) => session.queue.signEvent(t));
    let wraps: NostrEvent[];
    try {
      wraps = await queryAll(connections, [
        {
          kinds: [KIND_GIFT_WRAP],
          '#p': [session.pubkey],
          since: session.now - NIP59_TIMESTAMP_JITTER - MAX_AGENT_REQUEST_TTL_SECONDS,
        },
      ]);
    } finally {
      closeAll(connections);
    }
    const handled = await readHandled(deps.store, session.now);
    const found = await findAgentRequest(wraps, session.queue, code, {
      now: session.now,
      handled: (r: AgentRequest) =>
        handled.some((h) => h.rumorId === r.rumorId || h.code === r.code),
    });
    if (!found.ok) {
      const message = AGENT_REQUEST_MISS_MESSAGES[found.reason];
      throw found.reason === 'not_found'
        ? new SetupError(message)
        : new LocalRequestRefused(message);
    }
    const { request } = found;
    if (snapshot.submitters?.submitters.includes(request.agentPubkey)) {
      throw new LocalRequestRefused('That MCP server is already approved for this queue.');
    }
    return {
      source: 'local',
      code: displayApprovalCode(request.code),
      agentPubkey: request.agentPubkey,
      clientName: request.clientName,
      expiresAt: request.expiresAt,
      rumorId: request.rumorId,
    };
  });
}

/** The inbox relays from the settings copy this device keeps, else from the storage relays. */
async function inboxRelaysOf(deps: AgentDeps): Promise<string[]> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError(LOCKED_MESSAGE);
  const kept = unlocked.record.settings;
  if (kept !== undefined) {
    const parsed = await parseSettings(kept, createLocalSigner(unlocked.queueKey));
    const relays = parsed.ok ? (parsed.value.content.inbox_relays ?? []) : [];
    if (relays.length > 0) return relays;
  }
  return withQueue(
    deps,
    async (session) => (await readQueue(session)).settings?.content.inbox_relays ?? []
  );
}

/** Sends the answer to the local server on the inbox relays; throws unless one accepted it. */
async function answer(
  request: LocalAgentRequest,
  status: 'approved' | 'denied',
  deps: AgentDeps,
  options: { storage?: string[]; inboxRelays?: string[] } = {}
): Promise<void> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError(LOCKED_MESSAGE);
  const queue = createLocalSigner(unlocked.queueKey);
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const inboxRelays =
    options.inboxRelays && options.inboxRelays.length > 0
      ? options.inboxRelays
      : await inboxRelaysOf(deps);
  const event = await buildAgentRequestAnswer(
    queue,
    request.agentPubkey,
    {
      code: request.code,
      status,
      ...(options.storage !== undefined && { storage: options.storage }),
    },
    { now }
  );
  const connections = await openInbox(inboxRelays, deps, (t) => queue.signEvent(t));
  try {
    const report = await publishToAll(connections, event);
    if (report.accepted.length === 0) {
      const why = report.refused.map((r) => `${r.url}: ${r.reason}`).join('; ');
      throw new SetupError(`The inbox relay did not take the answer to the MCP server (${why}).`);
    }
  } finally {
    closeAll(connections);
  }
  await markHandled(deps.store, request, now);
}

/**
 * Approves a local server: the submitters list naming it (its label marked `local`) and its
 * grant on every storage relay, then the answer naming the storage relays on the inbox relay.
 * Needs no service permission. If the answer can't be sent, approving again republishes the same
 * list and grant and retries it.
 */
export async function approveLocalAgent(
  request: LocalAgentRequest,
  choices: ApprovalChoices,
  deps: AgentDeps
): Promise<void> {
  if (choices.label.trim() === '') throw new SetupError('Give the agent a label.');
  if ((deps.now?.() ?? Math.floor(Date.now() / 1000)) >= request.expiresAt) {
    throw new SetupError(AGENT_REQUEST_MISS_MESSAGES.expired);
  }
  const prepared = await publishApproval(request, choices, deps, { local: true });
  await answer(request, 'approved', deps, {
    storage: prepared.relays,
    inboxRelays: prepared.inboxRelays,
  });
}

/** Denies a local server: the answer says so, and nothing is published to the queue. */
export async function denyLocalAgent(request: LocalAgentRequest, deps: AgentDeps): Promise<void> {
  await answer(request, 'denied', deps);
}

/**
 * The command that starts the local server for this queue: its Queue ID as an nprofile naming
 * the inbox relay, so the server needs nothing else, or the npub when the settings can't be read.
 */
export async function localServerCommand(
  store: Pick<KeyStore, 'unlocked'>
): Promise<string | undefined> {
  const unlocked = await store.unlocked();
  if (unlocked === undefined) return undefined;
  const pubkey = unlocked.record.pubkey;
  let id: string = npubEncode(pubkey);
  const kept = unlocked.record.settings;
  if (kept !== undefined) {
    const parsed = await parseSettings(kept, createLocalSigner(unlocked.queueKey));
    const relays = parsed.ok ? (parsed.value.content.inbox_relays ?? []) : [];
    if (relays.length > 0) id = nprofileEncode({ pubkey, relays });
  }
  return `npx @qusme/mcp --queue ${id}`;
}
