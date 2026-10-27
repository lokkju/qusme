import type { EventTemplate } from 'nostr-tools/core';
import { FIELD_VALUE_KINDS, KIND_FIELD_VALUE } from './kinds.ts';
import { capture, checkInput, Invalid, type ParseResult } from './result.ts';
import type { InjectionStrategy } from './siteDef.ts';
import {
  checkKind,
  isHex64,
  type JsonValue,
  parseJsonText,
  readRecord,
  readTags,
  singleTag,
} from './validate.ts';

/** Draft status (spec 7.1). */
export const FIELD_VALUE_STATUSES = ['active', 'archived:inserted', 'archived:dismissed'] as const;
export type FieldValueStatus = (typeof FIELD_VALUE_STATUSES)[number];

/** Tags reserved for post-v1 (spec 7.1, 15.2): kept verbatim on a round trip, never produced. */
export const RESERVED_FIELD_VALUE_TAGS = ['target', 'sequence', 'position'] as const;

/**
 * One `inserted` tag: `["inserted", at, url, strategy, method, accessible name, detected
 * account]`. A value the inserting device did not have is the empty string (the PWA has no
 * strategy or accessible name, spec 12).
 */
export interface Insertion {
  /** Unix seconds. */
  at: number;
  url: string;
  /** One of {@link INJECTION_STRATEGIES}, empty, or a strategy a newer build added. */
  strategy: InjectionStrategy | (string & {});
  /** How the insertion was made, such as the extension's popup or context menu, or `pwa_copy`. */
  method: string;
  accessibleName: string;
  detectedAccount: string;
}

/** The `source` tag of a draft ingested from an agent submission. */
export interface FieldValueSource {
  /** The submission gift wrap's id. */
  wrapId: string;
  /** The seal's pubkey: the agent that submitted it. */
  submitter: string;
}

/** A field value rumor inside a draft wrap (spec 7.1). */
export interface FieldValue {
  createdAt: number;
  site: string;
  account: string;
  field: string;
  /** The destination id from the destinations event (7.2). */
  destination?: string;
  status: FieldValueStatus;
  source?: FieldValueSource;
  /** Every `inserted` tag, in order; they accumulate across restores. */
  inserted: Insertion[];
  /** The `validation` tag's JSON. */
  validation?: JsonValue;
  /** The value to insert. */
  content: string;
  /** Reserved tags (`target`, `sequence`, `position`) as found, in order. */
  reserved: string[][];
  /**
   * Tags this version does not know, as found and in order, written back unchanged after the known
   * and reserved tags, so a device on an older build keeps what a newer one wrote (spec 7).
   */
  extraTags?: string[][];
}

/** The rumor an agent submits (spec 7.5): only what the agent knows. */
export interface SubmissionValue {
  createdAt: number;
  site: string;
  account: string;
  field: string;
  validation?: JsonValue;
  content: string;
  reserved: string[][];
}

const DRAFT_TAGS = new Set([
  'site',
  'account',
  'field',
  'destination',
  'status',
  'source',
  'inserted',
  'validation',
  ...RESERVED_FIELD_VALUE_TAGS,
]);
const SUBMISSION_TAGS = new Set([
  'site',
  'account',
  'field',
  'validation',
  ...RESERVED_FIELD_VALUE_TAGS,
]);
// Draft state an agent must never set; a submission carrying any of these is refused.
const SUBMISSION_REFUSED = new Set(['status', 'source', 'inserted', 'destination']);
const UNIX_TIME = /^(0|[1-9]\d{0,15})$/;

function required(tags: string[][], name: string): string {
  const value = singleTag(tags, name, true);
  if (value.length === 0) throw new Invalid('invalid_tags', 'must not be empty', `tags.${name}`);
  return value;
}

function readInsertion(tag: string[], i: number): Insertion {
  const path = `tags.inserted[${i}]`;
  if (tag.length !== 7) throw new Invalid('invalid_tags', 'expected six values', path);
  const [, at, url, strategy, method, accessibleName, detectedAccount] = tag as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!UNIX_TIME.test(at)) throw new Invalid('invalid_tags', 'bad timestamp', path);
  if (method === '') throw new Invalid('invalid_tags', 'method must not be empty', path);
  return {
    at: Number(at),
    url,
    strategy,
    method,
    accessibleName,
    detectedAccount,
  };
}

interface RumorFields {
  kind: number;
  createdAt: number;
  tags: string[][];
  content: string;
  pubkey?: string;
}

/** The fields of an unsigned event from untrusted input; a `sig` is refused. */
export function readRumor(value: unknown, path = 'rumor'): RumorFields {
  const record = readRecord(value, path, 'invalid_content');
  const { kind, created_at, content, pubkey, id, sig } = record;
  if (sig !== undefined)
    throw new Invalid('invalid_content', 'a rumor must not be signed', `${path}.sig`);
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 65535) {
    throw new Invalid('invalid_content', 'bad kind', `${path}.kind`);
  }
  if (typeof created_at !== 'number' || !Number.isSafeInteger(created_at) || created_at < 0) {
    throw new Invalid('invalid_content', 'bad created_at', `${path}.created_at`);
  }
  if (typeof content !== 'string')
    throw new Invalid('invalid_content', 'bad content', `${path}.content`);
  if (pubkey !== undefined && !isHex64(pubkey)) {
    throw new Invalid('invalid_content', 'bad pubkey', `${path}.pubkey`);
  }
  if (id !== undefined && !isHex64(id))
    throw new Invalid('invalid_content', 'bad id', `${path}.id`);
  let tags: string[][];
  try {
    tags = readTags(record.tags, `${path}.tags`);
  } catch (error) {
    if (error instanceof Invalid) throw new Invalid('invalid_tags', error.message, error.path);
    throw error;
  }
  const fields: RumorFields = { kind, createdAt: created_at, tags, content };
  if (pubkey !== undefined) fields.pubkey = pubkey;
  return fields;
}

function readCommon(tags: string[][], allowed: Set<string>) {
  const unknown = tags.filter((tag) => !allowed.has(tag[0] as string)).map((tag) => [...tag]);
  const validationText = singleTag(tags, 'validation');
  return {
    site: required(tags, 'site'),
    account: required(tags, 'account'),
    field: required(tags, 'field'),
    validation:
      validationText === undefined ? undefined : parseJsonText(validationText, 'tags.validation'),
    reserved: tags
      .filter((tag) => (RESERVED_FIELD_VALUE_TAGS as readonly string[]).includes(tag[0] as string))
      .map((tag) => [...tag]),
    unknown,
  };
}

/** Validates a field value rumor from a draft wrap. Throws {@link Invalid}. */
export function readFieldValue(value: unknown): FieldValue {
  const rumor = readRumor(value);
  checkKind(rumor.kind, FIELD_VALUE_KINDS);
  const { tags } = rumor;
  const common = readCommon(tags, DRAFT_TAGS);
  const status = singleTag(tags, 'status', true);
  if (!(FIELD_VALUE_STATUSES as readonly string[]).includes(status)) {
    throw new Invalid('invalid_tags', `unknown status ${JSON.stringify(status)}`, 'tags.status');
  }
  const result: FieldValue = {
    createdAt: rumor.createdAt,
    site: common.site,
    account: common.account,
    field: common.field,
    status: status as FieldValueStatus,
    inserted: tags.filter((tag) => tag[0] === 'inserted').map(readInsertion),
    content: rumor.content,
    reserved: common.reserved,
  };
  const destination = singleTag(tags, 'destination');
  if (destination !== undefined) {
    if (destination.length === 0)
      throw new Invalid('invalid_tags', 'must not be empty', 'tags.destination');
    result.destination = destination;
  }
  const sources = tags.filter((tag) => tag[0] === 'source');
  if (sources.length > 1) throw new Invalid('invalid_tags', 'repeated', 'tags.source');
  const source = sources[0];
  if (source !== undefined) {
    if (source.length !== 3 || !isHex64(source[1]) || !isHex64(source[2])) {
      throw new Invalid('invalid_tags', 'expected a wrap id and a submitter pubkey', 'tags.source');
    }
    result.source = { wrapId: source[1], submitter: source[2] };
  }
  if (common.validation !== undefined) result.validation = common.validation;
  if (common.unknown.length > 0) result.extraTags = common.unknown;
  return result;
}

/**
 * Validates the rumor of an agent submission (spec 7.5). Draft state tags (`status`, `source`,
 * `inserted`, `destination`) are refused; other unknown tags are dropped and returned in
 * `ignoredTags` for ingestion to log. Throws {@link Invalid}.
 */
export function readSubmissionValue(value: unknown): {
  value: SubmissionValue;
  ignoredTags: string[][];
} {
  const rumor = readRumor(value);
  checkKind(rumor.kind, FIELD_VALUE_KINDS);
  for (const tag of rumor.tags) {
    if (SUBMISSION_REFUSED.has(tag[0] as string)) {
      throw new Invalid('invalid_tags', 'an agent may not set draft state', `tags.${tag[0]}`);
    }
  }
  const common = readCommon(rumor.tags, SUBMISSION_TAGS);
  const result: SubmissionValue = {
    createdAt: rumor.createdAt,
    site: common.site,
    account: common.account,
    field: common.field,
    content: rumor.content,
    reserved: common.reserved,
  };
  if (common.validation !== undefined) result.validation = common.validation;
  return { value: result, ignoredTags: common.unknown };
}

/** Parses an untrusted field value rumor (already JSON-decoded). */
export function parseFieldValue(value: unknown): ParseResult<FieldValue> {
  return capture(() => readFieldValue(value));
}

function commonTags(value: { site: string; account: string; field: string }): string[][] {
  return [
    ['site', value.site],
    ['account', value.account],
    ['field', value.field],
  ];
}

/**
 * The unsigned field value rumor for a draft wrap, tags in the order of spec 7.1. Throws if the
 * value would not parse back.
 */
export function fieldValueRumor(value: FieldValue): EventTemplate {
  const tags = commonTags(value);
  if (value.destination !== undefined) tags.push(['destination', value.destination]);
  tags.push(['status', value.status]);
  if (value.source !== undefined)
    tags.push(['source', value.source.wrapId, value.source.submitter]);
  for (const i of value.inserted) {
    tags.push([
      'inserted',
      String(i.at),
      i.url,
      i.strategy,
      i.method,
      i.accessibleName,
      i.detectedAccount,
    ]);
  }
  if (value.validation !== undefined) tags.push(['validation', JSON.stringify(value.validation)]);
  for (const tag of value.reserved) {
    if (!(RESERVED_FIELD_VALUE_TAGS as readonly string[]).includes(tag[0] as string)) {
      throw new Error(`invalid field value: ${tag[0]} is not reserved`);
    }
    tags.push([...tag]);
  }
  for (const tag of value.extraTags ?? []) {
    if (DRAFT_TAGS.has(tag[0] as string)) {
      throw new Error(`invalid field value: extra tag ${tag[0]} is a known tag`);
    }
    tags.push([...tag]);
  }
  const template = {
    kind: KIND_FIELD_VALUE,
    created_at: value.createdAt,
    tags,
    content: value.content,
  };
  checkInput('field value', () => readFieldValue(template));
  return template;
}

/** The unsigned rumor an agent submits (spec 7.5). Throws if it would not parse back. */
export function submissionRumor(value: SubmissionValue): EventTemplate {
  const tags = commonTags(value);
  if (value.validation !== undefined) tags.push(['validation', JSON.stringify(value.validation)]);
  tags.push(...value.reserved.map((tag) => [...tag]));
  const template = {
    kind: KIND_FIELD_VALUE,
    created_at: value.createdAt,
    tags,
    content: value.content,
  };
  checkInput('submission', () => {
    if (readSubmissionValue(template).ignoredTags.length > 0) {
      throw new Invalid('invalid_tags', 'reserved holds a tag that is not reserved');
    }
  });
  return template;
}
