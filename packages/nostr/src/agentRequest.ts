/**
 * A local agent's approval request and the queue's answer (spec 7.7, decided as D29). A local MCP
 * server (spec 8.6) holds its own agent key and has no service to hold a pending authorization
 * for it, so it asks through the queue's inbox relay instead: it gift-wraps a request
 * (`KIND_AGENT_REQUEST`, NIP-59) to the queue pubkey, sealed by the agent key, carrying the short
 * code it shows the user, its client name and an expiry. A device the user types that code into
 * finds the request among the queue's gift wraps, approves it as it would a hosted one, and
 * gift-wraps an answer back to the agent key naming the queue's storage relays, where the agent
 * then reads its grant.
 *
 * The seal is signed by the agent key, so the request proves the agent holds it; the answer's
 * seal is signed by the queue key, and the agent accepts no other. The answer only says where to
 * look: the grant and the submitters list, both signed by the queue key, are still the authority.
 */
import type { NostrEvent } from 'nostr-tools/core';
import { MAX_GRANT_STORAGE_RELAYS } from './agentGrant.ts';
import { KIND_AGENT_REQUEST } from './kinds.ts';
import { giftWrap, SealRefused, unwrapGiftWrap } from './nip59.ts';
import { formatPairingCode, normalizePairingCode } from './pairingCode.ts';
import { captureAsync, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  parseJsonText,
  readArray,
  readInteger,
  readOneOf,
  readRecord,
  readRelayUrl,
  readString,
} from './validate.ts';

/** How long a local server's request stays open: the hosted pending authorization's 10 minutes. */
export const AGENT_REQUEST_TTL_SECONDS = 10 * 60;
/** The longest a device accepts between a request's `created_at` and its `expires_at`. */
export const MAX_AGENT_REQUEST_TTL_SECONDS = 15 * 60;
/** How long an answer's gift wrap stays on the inbox relay (NIP-40). */
export const AGENT_REQUEST_ANSWER_TTL_SECONDS = 24 * 60 * 60;
/** Longest client name kept; longer ones are cut. */
export const MAX_CLIENT_NAME_LENGTH = 100;
/** Most gift wraps a device opens looking for one code. */
export const MAX_AGENT_REQUESTS_OPENED = 200;
/** How far in the future a request's `created_at` may be, for clock skew. */
const FUTURE_SKEW_SECONDS = 10 * 60;

/** What a local server asks with. */
export interface AgentRequestInput {
  /** What the MCP client calls itself, or the user's `--name`. */
  clientName: string;
  /** The code shown to the user, in any form {@link normalizePairingCode} reads. */
  code: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A request as a device reads it. */
export interface AgentRequest {
  /** The seal's pubkey: the agent key that asks, proven by its signature. */
  agentPubkey: string;
  clientName: string;
  /** Canonical, 8 Crockford base32 characters without the hyphen. */
  code: string;
  expiresAt: number;
  /** The rumor's `created_at`, which NIP-59 does not randomize. */
  createdAt: number;
  rumorId: string;
  wrapId: string;
}

export type AgentRequestStatus = 'approved' | 'denied';

/** The queue's answer as the agent reads it. */
export interface AgentRequestAnswer {
  code: string;
  status: AgentRequestStatus;
  /** The queue's storage relays, on an approval (1 to 8 distinct URLs). */
  storage?: string[];
  createdAt: number;
  wrapId: string;
}

/** Control characters and the like out, whitespace collapsed, cut to the longest kept. */
export function cleanClientName(name: string): string {
  const cleaned = name
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...cleaned];
  return chars.length > MAX_CLIENT_NAME_LENGTH
    ? `${chars.slice(0, MAX_CLIENT_NAME_LENGTH - 1).join('')}…`
    : cleaned;
}

function canonicalCode(code: string): string {
  const canonical = normalizePairingCode(code);
  if (canonical === undefined) throw new Error('not an approval code');
  return canonical;
}

/**
 * Builds the request: a gift wrap to `queuePubkey`, sealed by the agent key, with a NIP-40
 * expiration at the request's own, so relays drop it once it cannot be approved.
 */
export async function buildAgentRequest(
  agent: Signer,
  queuePubkey: string,
  input: AgentRequestInput,
  options: { now?: number } = {}
): Promise<NostrEvent> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const code = canonicalCode(input.code);
  const { expiresAt } = input;
  if (
    !Number.isInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > MAX_AGENT_REQUEST_TTL_SECONDS
  ) {
    throw new Error(`expires_at must be within ${MAX_AGENT_REQUEST_TTL_SECONDS} seconds from now`);
  }
  const clientName = cleanClientName(input.clientName) || 'Local MCP server';
  const content = JSON.stringify({
    type: 'request',
    client_name: clientName,
    code,
    expires_at: expiresAt,
  });
  return giftWrap({ kind: KIND_AGENT_REQUEST, created_at: now, content }, agent, queuePubkey, {
    now,
    expiration: expiresAt,
  });
}

/**
 * Opens a request addressed to the queue key. Checks its shape only; {@link findAgentRequest}
 * checks the times against the clock.
 */
export function openAgentRequest(
  wrap: NostrEvent,
  queue: Signer
): Promise<ParseResult<AgentRequest>> {
  return captureAsync(async () => {
    let opened: Awaited<ReturnType<typeof unwrapGiftWrap>>;
    try {
      opened = await unwrapGiftWrap(wrap, queue);
    } catch (error) {
      throw new Invalid('unwrap_failed', (error as Error).message, '');
    }
    const { rumor } = opened;
    if (rumor.kind !== KIND_AGENT_REQUEST) {
      throw new Invalid('wrong_kind', `expected kind ${KIND_AGENT_REQUEST}`, 'kind');
    }
    const body = readRecord(parseJsonText(rumor.content), 'content');
    readOneOf(body.type, ['request'] as const, 'content.type');
    const code = normalizePairingCode(body.code);
    if (code === undefined) throw new Invalid('invalid_content', 'not a code', 'content.code');
    const clientName = cleanClientName(
      readString(body.client_name, 'content.client_name', { max: 1000 })
    );
    return {
      agentPubkey: opened.sealPubkey,
      clientName: clientName || 'Local MCP server',
      code,
      expiresAt: readInteger(body.expires_at, 'content.expires_at', { min: 0 }),
      createdAt: rumor.created_at,
      rumorId: rumor.id,
      wrapId: opened.wrapId,
    };
  });
}

/** Why no request was found for a code. */
export type AgentRequestMiss =
  /** No open request carries the code. */
  | 'not_found'
  /** Every request carrying the code has expired, or asked to live too long. */
  | 'expired'
  /** Requests from different agent keys carry the code; approving either could be the wrong one. */
  | 'ambiguous'
  /** The device already approved or denied this request (or this code). */
  | 'handled';

export type AgentRequestLookup =
  | { ok: true; request: AgentRequest }
  | { ok: false; reason: AgentRequestMiss };

/**
 * Finds the open request carrying `code` among gift wraps addressed to the queue key: opens at
 * most {@link MAX_AGENT_REQUESTS_OPENED}, skips whatever is not a request, and refuses one that
 * has expired, whose `expires_at` is more than {@link MAX_AGENT_REQUEST_TTL_SECONDS} after its
 * `created_at`, or whose `created_at` is more than ten minutes ahead of the clock. `handled` says
 * whether the device already answered a request (by rumor id or code), so a replayed or reused
 * code is refused. Several open requests from one agent key read as its newest.
 */
export async function findAgentRequest(
  wraps: readonly NostrEvent[],
  queue: Signer,
  code: string,
  options: { now?: number; handled?: (request: AgentRequest) => boolean } = {}
): Promise<AgentRequestLookup> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const target = normalizePairingCode(code);
  if (target === undefined) return { ok: false, reason: 'not_found' };
  let sawExpired = false;
  const open: AgentRequest[] = [];
  for (const wrap of wraps.slice(0, MAX_AGENT_REQUESTS_OPENED)) {
    const parsed = await openAgentRequest(wrap, queue);
    if (!parsed.ok || parsed.value.code !== target) continue;
    const request = parsed.value;
    const tooLong = request.expiresAt - request.createdAt > MAX_AGENT_REQUEST_TTL_SECONDS;
    if (request.expiresAt <= now || tooLong || request.createdAt > now + FUTURE_SKEW_SECONDS) {
      sawExpired = true;
      continue;
    }
    if (options.handled?.(request)) return { ok: false, reason: 'handled' };
    open.push(request);
  }
  if (open.length === 0) return { ok: false, reason: sawExpired ? 'expired' : 'not_found' };
  if (new Set(open.map((r) => r.agentPubkey)).size > 1) return { ok: false, reason: 'ambiguous' };
  open.sort((a, b) => b.createdAt - a.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
  return { ok: true, request: open[0] as AgentRequest };
}

/** What each miss means, for the user. */
export const AGENT_REQUEST_MISS_MESSAGES: Record<AgentRequestMiss, string> = {
  not_found: 'No request with that code reached your inbox relay.',
  expired: 'That request has expired. Restart the MCP server for a new code.',
  ambiguous:
    'Two different agents sent requests with that code, so qus.me can’t tell which one is yours. Restart the MCP server for a new code.',
  handled: 'That request was already approved or denied.',
};

/**
 * Builds the queue's answer: a gift wrap to the agent key, sealed by the queue key. An approval
 * carries the queue's storage relays, so the agent knows where to read its grant.
 */
export async function buildAgentRequestAnswer(
  queue: Signer,
  agentPubkey: string,
  answer: { code: string; status: AgentRequestStatus; storage?: readonly string[] },
  options: { now?: number } = {}
): Promise<NostrEvent> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    type: answer.status,
    code: canonicalCode(answer.code),
  };
  if (answer.status === 'approved') {
    const storage = [...new Set(answer.storage ?? [])];
    if (storage.length === 0 || storage.length > MAX_GRANT_STORAGE_RELAYS) {
      throw new Error(`an approval names 1 to ${MAX_GRANT_STORAGE_RELAYS} storage relays`);
    }
    storage.forEach((url, i) => {
      readRelayUrl(url, `storage[${i}]`);
    });
    body.storage = storage;
  }
  return giftWrap(
    { kind: KIND_AGENT_REQUEST, created_at: now, content: JSON.stringify(body) },
    queue,
    agentPubkey,
    { now, expiration: now + AGENT_REQUEST_ANSWER_TTL_SECONDS }
  );
}

/**
 * Opens an answer addressed to the agent key. The seal must be the queue key's; an answer sealed
 * by anyone else is refused as `wrong_author`.
 */
export function openAgentRequestAnswer(
  wrap: NostrEvent,
  agent: Signer,
  options: { queuePubkey: string }
): Promise<ParseResult<AgentRequestAnswer>> {
  return captureAsync(async () => {
    let opened: Awaited<ReturnType<typeof unwrapGiftWrap>>;
    try {
      opened = await unwrapGiftWrap(wrap, agent, {
        acceptSeal: (pubkey) => pubkey === options.queuePubkey,
      });
    } catch (error) {
      const refused = error instanceof SealRefused;
      throw new Invalid(
        refused ? 'wrong_author' : 'unwrap_failed',
        refused ? 'not sealed by the queue key' : (error as Error).message,
        ''
      );
    }
    const { rumor } = opened;
    if (rumor.kind !== KIND_AGENT_REQUEST) {
      throw new Invalid('wrong_kind', `expected kind ${KIND_AGENT_REQUEST}`, 'kind');
    }
    const body = readRecord(parseJsonText(rumor.content), 'content');
    const status = readOneOf(body.type, ['approved', 'denied'] as const, 'content.type');
    const code = normalizePairingCode(body.code);
    if (code === undefined) throw new Invalid('invalid_content', 'not a code', 'content.code');
    const answer: AgentRequestAnswer = {
      code,
      status,
      createdAt: rumor.created_at,
      wrapId: opened.wrapId,
    };
    if (status === 'approved') {
      const list = readArray(body.storage, 'content.storage');
      if (list.length === 0 || list.length > MAX_GRANT_STORAGE_RELAYS) {
        throw new Invalid('invalid_content', 'expected 1 to 8 relays', 'content.storage');
      }
      answer.storage = [...new Set(list.map((u, i) => readRelayUrl(u, `content.storage[${i}]`)))];
    }
    return answer;
  });
}

/** A code for display, `ABCD-EFGH`, from any form a user or event gives. */
export function displayApprovalCode(code: string): string {
  return formatPairingCode(canonicalCode(code));
}
