import type { NostrEvent } from 'nostr-tools/core';
import { AGENT_GRANT_KINDS, KIND_AGENT_GRANT } from './kinds.ts';
import { captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkExtraTags,
  checkKind,
  decryptWith,
  extraTagsOf,
  isHex64,
  type JsonObject,
  type JsonValue,
  joinPath,
  parseJsonText,
  readArray,
  readBoolean,
  readExtra,
  readInteger,
  readOneOf,
  readRecord,
  readRelayUrl,
  readSignedEvent,
  readString,
  singleTag,
  withExtra,
} from './validate.ts';

const DESTINATION_KEYS = ['site', 'account', 'fields'];
const QUOTA_KEYS = ['max_submissions', 'period'];
const GRANT_REQUIRED = ['inbox', 'destinations', 'quota'];
const GRANT_KEYS = [
  ...GRANT_REQUIRED,
  'allow_new_destinations',
  'submission_expiration_days',
  'expires_at',
];

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
  /** Keys this version does not know (queue side only; spec 7, "Unknown fields"). */
  extra?: JsonObject;
}

export interface GrantQuota {
  max_submissions: number;
  period: QuotaPeriod;
  extra?: JsonObject;
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
  extra?: JsonObject;
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
  /** Tags other than `d` (queue side only). */
  extraTags?: string[][];
}

function readGrantDestination(value: unknown, path: string, keepExtra: boolean): GrantDestination {
  const record = readRecord(value, path);
  const extra = readExtra(record, path, DESTINATION_KEYS, DESTINATION_KEYS);
  const fieldsPath = joinPath(path, 'fields');
  const fields = readArray(record.fields, fieldsPath).map((f, i) =>
    readString(f, joinPath(fieldsPath, i), { nonEmpty: true })
  );
  if (fields.length === 0) throw new Invalid('invalid_content', 'must not be empty', fieldsPath);
  const destination: GrantDestination = {
    site: readString(record.site, joinPath(path, 'site'), { nonEmpty: true }),
    account: readString(record.account, joinPath(path, 'account'), { nonEmpty: true }),
    fields,
  };
  if (keepExtra && extra !== undefined) destination.extra = extra;
  return destination;
}

/**
 * Validates grant content and applies the defaults. Unknown keys are kept in `extra` when
 * `keepExtra` (the queue side, which republishes grants) and dropped otherwise (the agent side,
 * which only reads them). Throws {@link Invalid}.
 */
export function readAgentGrant(value: unknown, options: { keepExtra?: boolean } = {}): AgentGrant {
  const keepExtra = options.keepExtra ?? true;
  const record = readRecord(value, 'content');
  const extra = readExtra(record, 'content', GRANT_REQUIRED, GRANT_KEYS);
  const inbox = readArray(record.inbox, 'content.inbox').map((url, i) =>
    readRelayUrl(url, `content.inbox[${i}]`)
  );
  if (inbox.length === 0)
    throw new Invalid('invalid_content', 'must not be empty', 'content.inbox');
  const quota = readRecord(record.quota, 'content.quota');
  const quotaExtra = readExtra(quota, 'content.quota', QUOTA_KEYS, QUOTA_KEYS);
  const grant: AgentGrant = {
    inbox,
    destinations: readArray(record.destinations, 'content.destinations').map((d, i) =>
      readGrantDestination(d, `content.destinations[${i}]`, keepExtra)
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
  if (keepExtra && quotaExtra !== undefined) grant.quota.extra = quotaExtra;
  if (keepExtra && extra !== undefined) grant.extra = extra;
  return grant;
}

/** The wire JSON of a grant with defaults applied: known keys in spec order, then extras. */
function writeAgentGrant(grant: AgentGrant): JsonObject {
  return withExtra(
    [
      ['inbox', grant.inbox],
      [
        'destinations',
        grant.destinations.map((d) =>
          withExtra(
            [
              ['site', d.site],
              ['account', d.account],
              ['fields', d.fields],
            ],
            d.extra,
            DESTINATION_KEYS
          )
        ),
      ],
      ['allow_new_destinations', grant.allow_new_destinations],
      ['submission_expiration_days', grant.submission_expiration_days],
      [
        'quota',
        withExtra(
          [
            ['max_submissions', grant.quota.max_submissions],
            ['period', grant.quota.period],
          ],
          grant.quota.extra,
          QUOTA_KEYS
        ),
      ],
      ['expires_at', grant.expires_at],
    ] as [string, JsonValue][],
    grant.extra,
    GRANT_KEYS
  );
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
  options: { createdAt?: number; extraTags?: string[][] } = {}
): Promise<NostrEvent> {
  if (!isHex64(agentPubkey)) throw new Error('agent pubkey must be 64 lowercase hex characters');
  const full: AgentGrant = {
    ...grant,
    allow_new_destinations: grant.allow_new_destinations ?? false,
    submission_expiration_days:
      grant.submission_expiration_days ?? DEFAULT_SUBMISSION_EXPIRATION_DAYS,
    expires_at: grant.expires_at ?? null,
  };
  let wire: JsonObject;
  let extraTags: string[][];
  try {
    wire = writeAgentGrant(full);
    extraTags = checkExtraTags(options.extraTags, ['d']);
  } catch (error) {
    throw new Error(`invalid agent grant: ${(error as Error).message}`);
  }
  checkInput('agent grant', () => readAgentGrant(parseJsonText(JSON.stringify(wire))));
  return signer.signEvent({
    kind: KIND_AGENT_GRANT,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [['d', agentPubkey], ...extraTags],
    content: await signer.nip44Encrypt(agentPubkey, JSON.stringify(wire)),
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
    // The queue republishes grants and keeps unknown keys; the agent side only reads, and drops them.
    const queueSide = self === signed.pubkey;
    const grant = readAgentGrant(parseJsonText(await decryptWith(signer, peer, signed.content)), {
      keepExtra: queueSide,
    });
    const result: AgentGrantEvent = {
      id: signed.id,
      pubkey: signed.pubkey,
      agentPubkey,
      createdAt: signed.created_at,
      grant,
    };
    const extraTags = queueSide ? extraTagsOf(signed.tags, ['d']) : undefined;
    if (extraTags !== undefined) result.extraTags = extraTags;
    return result;
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
