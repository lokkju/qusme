/**
 * Ingestion of agent submissions (spec 11.4), as a pure step shared by the extension and the PWA:
 * gift wraps in, the drafts to publish, the destinations and quota counts to republish and the
 * wraps to delete out. The caller owns the relays; nothing here does I/O apart from the inbox
 * signers' decryption.
 *
 * Each wrap is discarded at the cheapest step that can reject it: derived `d` already present
 * (no crypto), proof of work below the lowest `min_pow` (one hash), the per-sync cap (nothing
 * opened), the seal's pubkey against the submitters list (one ECDH, before the seal's signature or
 * the rumor), then the full unwrap and the grant's rules. Junk is counted and dropped; its content
 * never leaves this module.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'nostr-tools/core';
import {
  type AgentGrant,
  DEFAULT_SUBMISSION_EXPIRATION_DAYS,
  quotaPeriodStart,
} from './agentGrant.ts';
import type { Destination, QuotaCount, RetiredInboxKey } from './appData.ts';
import { FIELD_VALUE_MAX_BYTES, utf8Length } from './counting.ts';
import { ingestedDraftD } from './draftWrap.ts';
import type { FieldValue } from './fieldValue.ts';
import { KIND_GIFT_WRAP } from './kinds.ts';
import { powOf } from './nip13.ts';
import { NIP59_TIMESTAMP_JITTER } from './nip59.ts';
import type { Signer } from './signer.ts';
import { fieldValueFromSubmission, openSubmission } from './submission.ts';

/** Gift wraps opened per sync at most; the rest wait for the next one (spec 11.4). */
export const INGEST_CAP = 100;

/**
 * How far before the last sync the inbox query starts: NIP-59's two days of timestamp
 * randomization plus an hour for clock skew between the agent's service and this device.
 */
export const INGEST_LOOKBACK_SECONDS = NIP59_TIMESTAMP_JITTER + 60 * 60;

/** How far into the future a rumor's `created_at` may be before the wrap is refused. */
export const RUMOR_FUTURE_SKEW_SECONDS = 10 * 60;

/** The `since` of the inbox query for a device that last synced at `lastSync` (unix seconds). */
export function inboxSince(lastSync: number | undefined): number | undefined {
  return lastSync === undefined ? undefined : Math.max(0, lastSync - INGEST_LOOKBACK_SECONDS);
}

/**
 * The id of the pending destination a device creates for a submission naming an unknown site and
 * account (spec 7.2, 11.4): 32 hex characters of the SHA-256 of `qus.me/destination:` followed by
 * the JSON array `[site, account]`. Two devices ingesting at once create the same one.
 */
export function pendingDestinationId(site: string, account: string): string {
  const digest = sha256(utf8ToBytes(`qus.me/destination:${JSON.stringify([site, account])}`));
  return bytesToHex(digest).slice(0, 32);
}

/**
 * When devices stop draining a retired inbox key (spec 6.4): its `retired_at` plus the longest
 * `submission_expiration_days` among the grants, or the 30-day default when there are none. The
 * grants as they were at retirement are not recorded, so the current ones stand in for them.
 */
export function retiredInboxDrainEnd(
  retired: Pick<RetiredInboxKey, 'retired_at'>,
  grants: Iterable<Pick<AgentGrant, 'submission_expiration_days'>>
): number {
  let days = 0;
  for (const grant of grants) days = Math.max(days, grant.submission_expiration_days);
  if (days === 0) days = DEFAULT_SUBMISSION_EXPIRATION_DAYS;
  return retired.retired_at + days * 24 * 60 * 60;
}

export const DISCARD_REASONS = [
  /** Not `p`-tagged to exactly one of the inbox keys being drained. */
  'not_addressed',
  /** Less NIP-13 work than the lowest (before unwrapping) or the agent's own `min_pow`. */
  'insufficient_pow',
  /** The seal's pubkey is not in the submitters list. */
  'unauthorized_submitter',
  /** Failed a NIP-59 check or is not a valid submission. */
  'invalid',
  /** Content above the 32 KiB cap (7.1). */
  'too_large',
  /** The rumor's `created_at` is in the future. */
  'future_timestamp',
  /** A listed submitter with no readable grant. */
  'no_grant',
  /** Submitted after the grant's `expires_at`. */
  'grant_expired',
  /** A destination outside the grant when it does not allow new ones. */
  'destination_not_granted',
  /** A field the grant does not list for the destination. */
  'field_not_granted',
  /** Over the grant's quota for the period (counted in `quota_counts`). */
  'over_quota',
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

export interface IngestInput {
  /** Kind 1059 events from the inbox relays, any order, duplicates allowed. */
  wraps: readonly NostrEvent[];
  /** The current inbox key and any retired ones still draining (6.4). */
  inboxes: readonly Signer[];
  /** Every `d` among the queue's draft wraps, blanked ones included. */
  existingDraftDs: ReadonlySet<string>;
  /** Wrap ids this device already ingested or discarded; skipped like an existing `d`. */
  handled?: ReadonlySet<string>;
  /** The submitters list's pubkeys (7.3). */
  submitters: ReadonlySet<string>;
  /** The queue's grants by agent pubkey (7.4). */
  grants: ReadonlyMap<string, AgentGrant>;
  /** The destinations event's list (7.2). */
  destinations: readonly Destination[];
  /** The settings' `quota_counts` (7.2). */
  quotaCounts: Readonly<Record<string, QuotaCount>>;
  /** Unix seconds. */
  now: number;
  /** Defaults to {@link INGEST_CAP}. */
  cap?: number;
}

export interface IngestedDraft {
  /** {@link ingestedDraftD} of the wrap id. */
  d: string;
  wrapId: string;
  /** The inbox pubkey the wrap was addressed to; delete it with that key. */
  inboxPubkey: string;
  submitter: string;
  /** The draft: `active`, with `source` and `destination`. */
  value: FieldValue;
}

export interface WrapRef {
  wrapId: string;
  inboxPubkey: string;
}

export interface DiscardedWrap {
  wrapId: string;
  reason: DiscardReason;
  /** Absent when the wrap was not addressed to a known inbox key. */
  inboxPubkey?: string;
  /** Known once the seal is open. */
  submitter?: string;
}

export interface IngestOutcome {
  drafts: IngestedDraft[];
  /** The input destinations followed by the pending ones created here. */
  destinations: Destination[];
  newDestinations: Destination[];
  quotaCounts: Record<string, QuotaCount>;
  quotaChanged: boolean;
  /** Already ingested (derived `d` present) or handled earlier: delete again, never reopen. */
  skipped: WrapRef[];
  /** Over the cap: left on the relay for the next sync. */
  deferred: WrapRef[];
  discarded: DiscardedWrap[];
}

const pTags = (wrap: NostrEvent): string[] =>
  wrap.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1] ?? '');

function cloneCount(count: QuotaCount): QuotaCount {
  const copy: QuotaCount = {
    period_start: count.period_start,
    accepted: [...count.accepted],
    discarded: [...count.discarded],
  };
  if (count.extra !== undefined) copy.extra = count.extra;
  return copy;
}

/**
 * Ingests submissions in the order of spec 11.4. Never throws on untrusted input: a wrap that
 * fails any step is discarded with its reason.
 */
export async function ingestSubmissions(input: IngestInput): Promise<IngestOutcome> {
  const cap = input.cap ?? INGEST_CAP;
  const inboxes = new Map<string, Signer>();
  for (const signer of input.inboxes) inboxes.set(await signer.getPublicKey(), signer);
  const grants = [...input.grants.values()];
  // Spec 11.4: only when every grant asks for work does a wrap need it before any ECDH.
  const lowestPow = grants.length === 0 ? 0 : Math.min(...grants.map((g) => g.min_pow));

  const destinations = input.destinations.map((d) => ({ ...d }));
  const newDestinations: Destination[] = [];
  const quotaCounts: Record<string, QuotaCount> = {};
  for (const [agent, count] of Object.entries(input.quotaCounts)) {
    quotaCounts[agent] = cloneCount(count);
  }
  const outcome: IngestOutcome = {
    drafts: [],
    destinations,
    newDestinations,
    quotaCounts,
    quotaChanged: false,
    skipped: [],
    deferred: [],
    discarded: [],
  };

  // A stable order, so the same wraps are deferred whichever relay answered first.
  const seen = new Set<string>();
  const wraps = [...input.wraps]
    .filter((wrap) => wrap.kind === KIND_GIFT_WRAP && !seen.has(wrap.id) && seen.add(wrap.id))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  let opened = 0;

  for (const wrap of wraps) {
    const recipients = pTags(wrap);
    const inboxPubkey = recipients.length === 1 ? recipients[0] : undefined;
    const inbox = inboxPubkey === undefined ? undefined : inboxes.get(inboxPubkey);
    if (inbox === undefined || inboxPubkey === undefined) {
      outcome.discarded.push({ wrapId: wrap.id, reason: 'not_addressed' });
      continue;
    }
    const discard = (reason: DiscardReason, submitter?: string): void => {
      const item: DiscardedWrap = { wrapId: wrap.id, reason, inboxPubkey };
      if (submitter !== undefined) item.submitter = submitter;
      outcome.discarded.push(item);
    };

    // 1. Derived d: no crypto at all.
    let d: string;
    try {
      d = ingestedDraftD(wrap.id);
    } catch {
      discard('invalid');
      continue;
    }
    if (input.existingDraftDs.has(d) || input.handled?.has(wrap.id)) {
      outcome.skipped.push({ wrapId: wrap.id, inboxPubkey });
      continue;
    }
    // 2. Proof of work below every grant's minimum: one hash, already done by the relay.
    if (lowestPow > 0 && powOf(wrap.id) < lowestPow) {
      discard('insufficient_pow');
      continue;
    }
    // 3. The per-sync cap.
    if (opened >= cap) {
      outcome.deferred.push({ wrapId: wrap.id, inboxPubkey });
      continue;
    }
    opened += 1;
    // 4 and 5. The gift wrap layer, the seal's pubkey against the list, then the rest.
    const result = await openSubmission(wrap, inbox, {
      acceptSubmitter: (pubkey) => input.submitters.has(pubkey),
    });
    if (!result.ok) {
      discard(
        result.error.code === 'unauthorized_submitter' ? 'unauthorized_submitter' : 'invalid'
      );
      continue;
    }
    const submission = result.value;
    const { submitter, value } = submission;
    if (utf8Length(value.content) > FIELD_VALUE_MAX_BYTES) {
      discard('too_large', submitter);
      continue;
    }
    if (value.createdAt > input.now + RUMOR_FUTURE_SKEW_SECONDS) {
      discard('future_timestamp', submitter);
      continue;
    }
    const grant = input.grants.get(submitter);
    if (grant === undefined) {
      discard('no_grant', submitter);
      continue;
    }
    if (powOf(wrap.id) < grant.min_pow) {
      discard('insufficient_pow', submitter);
      continue;
    }
    if (grant.expires_at !== null && grant.expires_at <= value.createdAt) {
      discard('grant_expired', submitter);
      continue;
    }
    const granted = grant.destinations.find(
      (g) => g.site === value.site && g.account === value.account
    );
    if (granted === undefined && !grant.allow_new_destinations) {
      discard('destination_not_granted', submitter);
      continue;
    }
    if (granted !== undefined && !granted.fields.includes(value.field)) {
      discard('field_not_granted', submitter);
      continue;
    }

    // 6. Quota, in the period of the rumor's created_at (the one timestamp NIP-59 keeps).
    if (!admitByQuota(quotaCounts, submitter, grant, value.createdAt, wrap.id, outcome)) {
      discard('over_quota', submitter);
      continue;
    }

    // 7. A pending destination for an unknown one.
    let destination = destinations.find(
      (x) => x.site === value.site && x.account === value.account
    );
    if (destination === undefined) {
      destination = {
        id: pendingDestinationId(value.site, value.account),
        site: value.site,
        account: value.account,
        label: `${value.site} / ${value.account}`,
        status: 'pending',
        override: granted?.override ?? null,
      };
      destinations.push(destination);
      newDestinations.push(destination);
    }
    outcome.drafts.push({
      d,
      wrapId: wrap.id,
      inboxPubkey,
      submitter,
      value: fieldValueFromSubmission(submission, destination.id),
    });
  }
  return outcome;
}

/**
 * Counts a submission against its agent's quota (spec 11.4) and says whether it is admitted. A
 * submission whose period starts after the recorded one advances the record and clears its lists;
 * one from an earlier period counts in the recorded period, so a backdated rumor can't escape the
 * quota. An id already listed keeps the decision another device made.
 */
function admitByQuota(
  counts: Record<string, QuotaCount>,
  agent: string,
  grant: AgentGrant,
  createdAt: number,
  wrapId: string,
  outcome: IngestOutcome
): boolean {
  const periodStart = quotaPeriodStart(grant.quota.period, createdAt);
  let count = counts[agent];
  if (count === undefined || periodStart > count.period_start) {
    count = { period_start: periodStart, accepted: [], discarded: [] };
    const extra = counts[agent]?.extra;
    if (extra !== undefined) count.extra = extra;
    counts[agent] = count;
    outcome.quotaChanged = true;
  }
  if (count.accepted.includes(wrapId)) return true;
  if (count.discarded.includes(wrapId)) return false;
  outcome.quotaChanged = true;
  if (count.accepted.length >= grant.quota.max_submissions) {
    count.discarded.push(wrapId);
    return false;
  }
  count.accepted.push(wrapId);
  return true;
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/**
 * Merges two `quota_counts` records (spec 11.4): per agent, the later `period_start` wins with its
 * lists; equal periods take the union of each list. An id both accepted and discarded stays
 * accepted, since its draft exists. `latest` is the settings fetched just before republishing;
 * its unknown keys are kept.
 */
export function mergeQuotaCounts(
  latest: Readonly<Record<string, QuotaCount>>,
  local: Readonly<Record<string, QuotaCount>>
): Record<string, QuotaCount> {
  const merged: Record<string, QuotaCount> = {};
  for (const agent of new Set([...Object.keys(latest), ...Object.keys(local)])) {
    const a = latest[agent];
    const b = local[agent];
    if (a === undefined || b === undefined) {
      merged[agent] = cloneCount((a ?? b) as QuotaCount);
    } else if (a.period_start !== b.period_start) {
      merged[agent] = cloneCount(a.period_start > b.period_start ? a : b);
    } else {
      const accepted = union(a.accepted, b.accepted);
      const count: QuotaCount = {
        period_start: a.period_start,
        accepted,
        discarded: union(a.discarded, b.discarded).filter((id) => !accepted.includes(id)),
      };
      const extra = a.extra ?? b.extra;
      if (extra !== undefined) count.extra = extra;
      merged[agent] = count;
    }
  }
  return merged;
}

/**
 * Merges destinations for republishing: everything in `latest`, then each local destination
 * whose id `latest` lacks. Pending ids are derived from site and account, so two devices that
 * created the same pending destination converge on one entry.
 */
export function mergeDestinations(
  latest: readonly Destination[],
  local: readonly Destination[]
): Destination[] {
  const ids = new Set(latest.map((d) => d.id));
  return [...latest, ...local.filter((d) => !ids.has(d.id))];
}
