import { mastodonCountableText } from './mastodonText.ts';
import {
  COUNTER_NAMES,
  type CounterName,
  type FieldConstraints,
  type SiteField,
} from './siteDef.ts';
import { parseTweet } from './twitterText.ts';
import type { JsonObject } from './validate.ts';

/**
 * The most a field value's content may hold: 32 KiB of UTF-8 (spec 7.1). It keeps a draft wrap
 * under the 64 KiB event size default strfry relays accept, applies whatever the definition says,
 * and `lenient` never relaxes it (8.4).
 */
export const FIELD_VALUE_MAX_BYTES = 32_768;

let segmenter: Intl.Segmenter | undefined;

/** Unicode code points (`default`). */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Extended grapheme clusters as `Intl.Segmenter` counts them (`graphemes`, Bluesky's unit). */
export function countGraphemes(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** X's weighted length under twitter-text config v3 (`twitter-text`). */
export function countTwitterText(text: string): number {
  return parseTweet(text).weightedLength;
}

/**
 * Mastodon's length (`mastodon`): grapheme clusters, with every URL that has a protocol counted
 * as 23 and a mention `@user@domain` as `@user`, as the server's StatusLengthValidator counts.
 */
export function countMastodon(text: string): number {
  return countGraphemes(mastodonCountableText(text));
}

const COUNTERS: Record<CounterName, (text: string) => number> = {
  default: countCodePoints,
  graphemes: countGraphemes,
  'twitter-text': countTwitterText,
  mastodon: countMastodon,
};

/** The length of `text` under the named counting strategy (spec 10.1). */
export function countLength(text: string, counter: CounterName = 'default'): number {
  const count = Object.hasOwn(COUNTERS, counter) ? COUNTERS[counter] : undefined;
  if (count === undefined) throw new Error(`unknown counter ${JSON.stringify(counter)}`);
  return count(text);
}

/** UTF-8 length; a lone surrogate counts as the three bytes of the U+FFFD it encodes to. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The constraint a violation breaks: a definition's `maxLength`, or the 32 KiB cap. */
export type ConstraintName = 'maxLength' | 'maxBytes';

export interface ConstraintViolation {
  /** The field's `name`. */
  field: string;
  constraint: ConstraintName;
  limit: number;
  actual: number;
  /** The counter `limit` and `actual` are in; absent for `maxBytes`, which counts UTF-8 bytes. */
  counter?: CounterName;
}

export interface FieldValidation {
  /** No violations. */
  ok: boolean;
  /**
   * Whether the value may be saved or submitted: `ok`, or `lenient` with only definition
   * constraints broken. The 32 KiB cap fails it either way.
   */
  accepted: boolean;
  lenient: boolean;
  counter: CounterName;
  /** The value's length under `counter`. */
  length: number;
  /** The definition's `maxLength`, if it sets one. */
  max?: number;
  /** UTF-8 bytes. */
  bytes: number;
  violations: ConstraintViolation[];
}

const CONSTRAINT_KEYS: readonly string[] = [
  'maxLength',
  'counter',
] satisfies (keyof FieldConstraints)[];

/**
 * Checks a field value against an effective site definition field (spec 8.4, 10.1) and the 32 KiB
 * cap (7.1). Violations are reported whether or not `lenient` is set; `lenient` only changes
 * `accepted`. The field must come from a parsed definition: a constraint key or counter this build
 * does not know throws, since passing it would accept values the definition means to refuse.
 */
export function validateFieldValue(
  value: string,
  field: Pick<SiteField, 'name' | 'constraints'>,
  options: { lenient?: boolean } = {}
): FieldValidation {
  const { constraints } = field;
  for (const key of Object.keys(constraints)) {
    if (!CONSTRAINT_KEYS.includes(key)) {
      throw new Error(`field ${field.name}: unknown constraint ${JSON.stringify(key)}`);
    }
  }
  const counter = constraints.counter ?? 'default';
  if (!(COUNTER_NAMES as readonly string[]).includes(counter)) {
    throw new Error(`field ${field.name}: unknown counter ${JSON.stringify(counter)}`);
  }
  const lenient = options.lenient === true;
  const length = countLength(value, counter);
  const bytes = utf8Length(value);
  const violations: ConstraintViolation[] = [];
  const max = constraints.maxLength;
  if (max !== undefined && length > max) {
    violations.push({
      field: field.name,
      constraint: 'maxLength',
      limit: max,
      actual: length,
      counter,
    });
  }
  if (bytes > FIELD_VALUE_MAX_BYTES) {
    violations.push({
      field: field.name,
      constraint: 'maxBytes',
      limit: FIELD_VALUE_MAX_BYTES,
      actual: bytes,
    });
  }
  const ok = violations.length === 0;
  const accepted = ok || (lenient && violations.every((v) => v.constraint !== 'maxBytes'));
  const result: FieldValidation = { ok, accepted, lenient, counter, length, bytes, violations };
  if (max !== undefined) result.max = max;
  return result;
}

/**
 * The `validation` tag's JSON for a field value rumor (spec 7.1): counter, length, max, ok, and,
 * when set, `lenient` and the violations without the repeated field name.
 */
export function validationTagJson(result: FieldValidation): JsonObject {
  const json: JsonObject = { counter: result.counter, length: result.length };
  if (result.max !== undefined) json.max = result.max;
  json.ok = result.ok;
  if (result.lenient) json.lenient = true;
  if (result.violations.length > 0) {
    json.violations = result.violations.map(({ constraint, limit, actual, counter }) => {
      const v: JsonObject = { constraint, limit, actual };
      if (counter !== undefined) v.counter = counter;
      return v;
    });
  }
  return json;
}
