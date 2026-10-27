import type { NostrEvent } from 'nostr-tools/core';
import { AGENT_GRANT_KINDS, KIND_AGENT_GRANT } from './kinds.ts';
import { captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkKeys,
  checkKind,
  decryptWith,
  isHex64,
  joinPath,
  parseJsonText,
  readArray,
  readBoolean,
  readInteger,
  readOneOf,
  readRecord,
  readRelayUrl,
  readSignedEvent,
  readString,
  singleTag,
} from './validate.ts';

/** `submission_expiration_days` when a grant leaves it out (spec 7.4). */
export const DEFAULT_SUBMISSION_EXPIRATION_DAYS = 30;
/** The most `submission_expiration_days` may be; devices never publish more (spec 7.4). */
export const MAX_SUBMISSION_EXPIRATION_DAYS = 90;

export const QUOTA_PERIODS = ['day', 'week', 'month'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

/** A destination shared with an agent. Keys are the JSON keys (spec 7.4). */
export interface GrantDestination {
  site: string;
  account: string;
  fields: string[];
}

export interface GrantQuota {
  max_submissions: number;
  period: QuotaPeriod;
}

/** A grant's content with defaults applied. */
export interface AgentGrant {
  inbox: string[];
  destinations: GrantDestination[];
  allow_new_destinations: boolean;
  submission_expiration_days: number;
  quota: GrantQuota;
  /** Unix seconds, or `null` for no expiry. */
  expires_at: number | null;
}

/** What a device builds a grant from; the defaulted fields may be left out. */
export type AgentGrantInput = Omit<
  AgentGrant,
  'allow_new_destinations' | 'submission_expiration_days' | 'expires_at'
> &
  Partial<Pick<AgentGrant, 'allow_new_destinations' | 'submission_expiration_days' | 'expires_at'>>;

export interface AgentGrantEvent {
  id: string;
  /** The queue pubkey that signed the grant. */
  pubkey: string;
  /** The agent pubkey, from `d`. */
  agentPubkey: string;
  createdAt: number;
  grant: AgentGrant;
}

function readGrantDestination(value: unknown, path: string): GrantDestination {
  const record = readRecord(value, path);
  checkKeys(record, path, ['site', 'account', 'fields']);
  const fieldsPath = joinPath(path, 'fields');
  const fields = readArray(record.fields, fieldsPath).map((f, i) =>
    readString(f, joinPath(fieldsPath, i), { nonEmpty: true })
  );
  if (fields.length === 0) throw new Invalid('invalid_content', 'must not be empty', fieldsPath);
  return {
    site: readString(record.site, joinPath(path, 'site'), { nonEmpty: true }),
    account: readString(record.account, joinPath(path, 'account'), { nonEmpty: true }),
    fields,
  };
}

/** Validates grant content and applies the defaults. Throws {@link Invalid}. */
export function readAgentGrant(value: unknown): AgentGrant {
  const record = readRecord(value, 'content');
  checkKeys(
    record,
    'content',
    ['inbox', 'destinations', 'quota'],
    ['allow_new_destinations', 'submission_expiration_days', 'expires_at']
  );
  const inbox = readArray(record.inbox, 'content.inbox').map((url, i) =>
    readRelayUrl(url, `content.inbox[${i}]`)
  );
  if (inbox.length === 0)
    throw new Invalid('invalid_content', 'must not be empty', 'content.inbox');
  const quota = readRecord(record.quota, 'content.quota');
  checkKeys(quota, 'content.quota', ['max_submissions', 'period']);
  return {
    inbox,
    destinations: readArray(record.destinations, 'content.destinations').map((d, i) =>
      readGrantDestination(d, `content.destinations[${i}]`)
    ),
    allow_new_destinations:
      record.allow_new_destinations === undefined
        ? false
        : readBoolean(record.allow_new_destinations, 'content.allow_new_destinations'),
    submission_expiration_days:
      record.submission_expiration_days === undefined
        ? DEFAULT_SUBMISSION_EXPIRATION_DAYS
        : readInteger(record.submission_expiration_days, 'content.submission_expiration_days', {
            min: 1,
            max: MAX_SUBMISSION_EXPIRATION_DAYS,
          }),
    quota: {
      max_submissions: readInteger(quota.max_submissions, 'content.quota.max_submissions', {
        min: 1,
      }),
      period: readOneOf(quota.period, QUOTA_PERIODS, 'content.quota.period'),
    },
    expires_at:
      record.expires_at === undefined || record.expires_at === null
        ? null
        : readInteger(record.expires_at, 'content.expires_at', { min: 0 }),
  };
}

/**
 * Builds an agent grant (`KIND_AGENT_GRANT`, `d` = agent pubkey, spec 7.4), signed by the queue
 * key with content NIP-44-encrypted to the agent. Every field is written out, defaults included.
 * Throws on `submission_expiration_days` above 90, which devices never publish.
 */
export async function buildAgentGrant(
  signer: Signer,
  agentPubkey: string,
  grant: AgentGrantInput,
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  if (!isHex64(agentPubkey)) throw new Error('agent pubkey must be 64 lowercase hex characters');
  const checked = checkInput('agent grant', () =>
    readAgentGrant(JSON.parse(JSON.stringify(grant)))
  );
  return signer.signEvent({
    kind: KIND_AGENT_GRANT,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [['d', agentPubkey]],
    content: await signer.nip44Encrypt(agentPubkey, JSON.stringify(checked)),
  });
}

/**
 * Parses and decrypts an agent grant. `signer` is either the agent (the service, authenticated as
 * the agent key) or the queue key that signed it; NIP-44's conversation key is the same both ways.
 * A grant that does not decrypt, or with `submission_expiration_days` above 90, is refused.
 */
export function parseAgentGrant(
  event: unknown,
  signer: Signer
): Promise<ParseResult<AgentGrantEvent>> {
  return captureAsync(async () => {
    const signed = readSignedEvent(event);
    checkKind(signed.kind, AGENT_GRANT_KINDS);
    const agentPubkey = singleTag(signed.tags, 'd', true);
    if (!isHex64(agentPubkey)) throw new Invalid('invalid_tags', 'd is not a pubkey', 'tags.d');
    const self = await signer.getPublicKey();
    let peer: string;
    if (self === agentPubkey) peer = signed.pubkey;
    else if (self === signed.pubkey) peer = agentPubkey;
    else throw new Invalid('wrong_author', 'neither the granting queue nor the agent', 'pubkey');
    const grant = readAgentGrant(parseJsonText(await decryptWith(signer, peer, signed.content)));
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      agentPubkey,
      createdAt: signed.created_at,
      grant,
    };
  });
}

/**
 * The start of the UTC calendar period containing `time` (spec 7.4): days at 00:00 UTC, weeks on
 * Monday at 00:00 UTC, months on the first at 00:00 UTC. Unix seconds in and out.
 */
export function quotaPeriodStart(period: QuotaPeriod, time: number): number {
  const date = new Date(time * 1000);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  let start: number;
  if (period === 'day') start = Date.UTC(y, m, d);
  else if (period === 'week') start = Date.UTC(y, m, d - ((date.getUTCDay() + 6) % 7));
  else start = Date.UTC(y, m, 1);
  return start / 1000;
}
