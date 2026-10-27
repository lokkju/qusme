import type { NostrEvent } from 'nostr-tools/core';
import {
  DEFAULT_SUBMISSION_EXPIRATION_DAYS,
  MAX_SUBMISSION_EXPIRATION_DAYS,
} from './agentGrant.ts';
import {
  type FieldValue,
  readSubmissionValue,
  type SubmissionValue,
  submissionRumor,
} from './fieldValue.ts';
import { KIND_GIFT_WRAP } from './kinds.ts';
import { giftWrap, unwrapGiftWrap } from './nip59.ts';
import { captureAsync, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import { readSignedEvent } from './validate.ts';

const DAY = 24 * 60 * 60;
const UNIX_TIME = /^(0|[1-9]\d{0,15})$/;

/** What an agent submits; `createdAt` defaults to now, `reserved` to none. */
export type SubmissionInput = Omit<SubmissionValue, 'createdAt' | 'reserved'> &
  Partial<Pick<SubmissionValue, 'createdAt' | 'reserved'>>;

/** An opened submission, before ingestion. */
export interface Submission {
  /** The gift wrap's id: the source of the ingested draft's `d` (11.4) and of its `source` tag. */
  wrapId: string;
  /** The seal's pubkey: the agent that submitted it. Check it against the submitters list. */
  submitter: string;
  /** The gift wrap's NIP-40 expiration. */
  expiration: number;
  /** The rumor's id. */
  rumorId: string;
  value: SubmissionValue;
  /** Tags the agent sent that this version does not know; dropped, reported for logging. */
  ignoredTags: string[][];
}

/**
 * Builds a submission (spec 7.5): the field value rumor, sealed by the agent's key and
 * gift-wrapped to the queue pubkey with a NIP-40 expiration `submissionExpirationDays` (the
 * grant's `submission_expiration_days`, default 30, at most 90) from now.
 */
export async function buildSubmission(
  agent: Signer,
  queuePubkey: string,
  value: SubmissionInput,
  options: { submissionExpirationDays?: number; now?: number } = {}
): Promise<NostrEvent> {
  const days = options.submissionExpirationDays ?? DEFAULT_SUBMISSION_EXPIRATION_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SUBMISSION_EXPIRATION_DAYS) {
    throw new Error(`submission expiration must be 1 to ${MAX_SUBMISSION_EXPIRATION_DAYS} days`);
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const rumor = submissionRumor({
    ...value,
    createdAt: value.createdAt ?? now,
    reserved: value.reserved ?? [],
  });
  return giftWrap(rumor, agent, queuePubkey, { now, expiration: now + days * DAY });
}

/**
 * Opens a submission gift wrap with the queue key's signer. Refuses a wrap not `p`-tagged to
 * exactly the queue, without a NIP-40 expiration, failing any NIP-59 check, or whose rumor is not
 * a valid submission. Does not check the submitters list or the expiration against the clock.
 */
export function openSubmission(event: unknown, queue: Signer): Promise<ParseResult<Submission>> {
  return captureAsync(async () => {
    const wrap = readSignedEvent(event);
    if (wrap.kind !== KIND_GIFT_WRAP) throw new Invalid('wrong_kind', `kind ${wrap.kind}`, 'kind');
    const queuePubkey = await queue.getPublicKey();
    const recipients = wrap.tags.filter((tag) => tag[0] === 'p');
    if (recipients.length !== 1 || recipients[0]?.[1] !== queuePubkey) {
      throw new Invalid('invalid_tags', 'not addressed to this queue alone', 'tags.p');
    }
    const expirations = wrap.tags.filter((tag) => tag[0] === 'expiration');
    const expiration = expirations[0]?.[1];
    if (expirations.length !== 1 || expiration === undefined || !UNIX_TIME.test(expiration)) {
      throw new Invalid('invalid_tags', 'needs one NIP-40 expiration', 'tags.expiration');
    }
    let opened: Awaited<ReturnType<typeof unwrapGiftWrap>>;
    try {
      opened = await unwrapGiftWrap(wrap, queue);
    } catch (error) {
      throw new Invalid('unwrap_failed', (error as Error).message);
    }
    const { value, ignoredTags } = readSubmissionValue(opened.rumor);
    return {
      wrapId: opened.wrapId,
      submitter: opened.sealPubkey,
      expiration: Number(expiration),
      rumorId: opened.rumor.id,
      value,
      ignoredTags,
    };
  });
}

/**
 * The draft a device creates when it ingests a submission (spec 11.4): `active`, with a `source`
 * tag naming the gift wrap and the submitter. Wrap it under `ingestedDraftD(submission.wrapId)`.
 */
export function fieldValueFromSubmission(submission: Submission, destination?: string): FieldValue {
  const { value } = submission;
  const draft: FieldValue = {
    createdAt: value.createdAt,
    site: value.site,
    account: value.account,
    field: value.field,
    status: 'active',
    source: { wrapId: submission.wrapId, submitter: submission.submitter },
    inserted: [],
    content: value.content,
    reserved: value.reserved.map((tag) => [...tag]),
  };
  if (destination !== undefined) draft.destination = destination;
  if (value.validation !== undefined) draft.validation = value.validation;
  return draft;
}
