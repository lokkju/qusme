import { capture, Invalid, type ParseResult } from './result.ts';
import { readSiteDefinition, type SiteDefinition } from './siteDef.ts';
import { mergeSiteOverride } from './siteMerge.ts';
import {
  type JsonObject,
  parseJsonText,
  readArray,
  readJsonObject,
  readString,
} from './validate.ts';

const MATCH_PATTERN = /^(?:\*|https?):\/\/(?:\*|(?:\*\.)?[^/*]+)\/.*$/;

/** What a destination's override comes to once checked (spec 7.2, 10.1, 10.2). */
export interface CheckedOverride {
  override: JsonObject | null;
  /** The effective definition's `match` patterns; never empty. */
  match: string[];
  /** The effective definition, when the merge is a whole one. */
  definition?: SiteDefinition;
}

function readMatch(value: unknown, path: string): string[] {
  return readArray(value, path).map((item, i) => {
    const pattern = readString(item, `${path}[${i}]`);
    if (!MATCH_PATTERN.test(pattern)) {
      throw new Invalid('invalid_content', 'not a match pattern', `${path}[${i}]`);
    }
    return pattern;
  });
}

/**
 * Checks a destination's `override` before a device saves it. With an official definition the
 * merge (10.2) must validate as a whole definition. A custom destination (no official definition)
 * may have as little as `{ "match": [...] }`, and then only its patterns are checked; one whose
 * override lists `fields` must validate whole, since it means to be a definition. Either way the effective `match` must not be empty (10.1: devices refuse to
 * save a destination for a site with no fixed hosts without it).
 */
export function checkDestinationOverride(
  official: JsonObject | undefined,
  override: unknown
): ParseResult<CheckedOverride> {
  return capture(() => {
    const value = override === null ? null : readJsonObject(override, 'override');
    const merged = mergeSiteOverride(official, value);
    if (merged === undefined) {
      throw new Invalid('invalid_content', 'a custom destination needs match patterns', 'override');
    }
    let definition: SiteDefinition | undefined;
    let match: string[];
    // A custom override without fields has no field to validate; 11.5's fallback inserts.
    const partial = official === undefined && value !== null && value.fields === undefined;
    if (partial) {
      match = readMatch(value?.match ?? [], 'override.match');
    } else {
      // Path '' so errors name the key, such as `fields[0].inject`.
      definition = readSiteDefinition(merged);
      match = definition.match;
    }
    if (match.length === 0) {
      throw new Invalid(
        'invalid_content',
        'this site has no fixed hosts, so the destination needs match patterns',
        'override.match'
      );
    }
    const checked: CheckedOverride = { override: value, match };
    if (definition !== undefined) checked.definition = definition;
    return checked;
  });
}

/**
 * {@link checkDestinationOverride} over text a user typed: empty text is no override (`null`),
 * anything else must be a JSON object or `null`.
 */
export function parseDestinationOverride(
  official: JsonObject | undefined,
  text: string
): ParseResult<CheckedOverride> {
  if (text.trim() === '') return checkDestinationOverride(official, null);
  const parsed = capture(() => parseJsonText(text, 'override'));
  if (!parsed.ok) return parsed;
  return checkDestinationOverride(official, parsed.value);
}
