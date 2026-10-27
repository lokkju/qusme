import { SITE_DEF_KINDS } from './kinds.ts';
import { capture, Invalid, type ParseResult } from './result.ts';
import {
  checkKind,
  joinPath,
  parseJsonText,
  readArray,
  readExtra,
  readInteger,
  readRecord,
  readSignedEvent,
  readString,
  singleTag,
} from './validate.ts';

/** Injection strategies (spec 11.6), a closed set in code. `clipboard` is always last. */
export const INJECTION_STRATEGIES = ['paste', 'insertText', 'native', 'clipboard'] as const;
export type InjectionStrategy = (typeof INJECTION_STRATEGIES)[number];

/**
 * Names of the counting strategies a definition's `constraints.counter` may reference (spec
 * 10.1). The strategies themselves live elsewhere; a definition naming any other fails to load.
 */
export const COUNTER_NAMES = ['default', 'graphemes', 'twitter-text'] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

/** An ARIA role and accessible names keyed by `document.documentElement.lang`, `en` required. */
export interface Locator {
  role: string;
  name: Record<string, string[]>;
}

export interface FieldConstraints {
  maxLength?: number;
  counter?: CounterName;
}

export interface SiteField {
  name: string;
  label: string;
  locators: Locator[];
  inject: InjectionStrategy[];
  constraints: FieldConstraints;
}

export interface SiteAccount {
  locator: Locator;
  /** A regular expression whose first capture group is the account. */
  extract: string;
}

/** A site definition (spec 10.1). Keys are the JSON keys. */
export interface SiteDefinition {
  id: string;
  /** CalVer, `YYYY.MM.N`. */
  version: string;
  name: string;
  /** Match patterns; empty for a site with no fixed hosts, such as Mastodon (10.1). */
  match: string[];
  account?: SiteAccount;
  /** Intent URL templates by name (`compose`), with `{text}` and `{origin}` placeholders. */
  intents?: Record<string, string>;
  /** The fields this version can use. */
  fields: SiteField[];
  /**
   * Fields left out because they name an injection strategy or counter this version does not
   * know; present only when there are some.
   */
  unusableFields?: UnusableField[];
}

export interface UnusableField {
  name: string;
  reason: string;
}

export interface SiteDefinitionEvent {
  eventId: string;
  pubkey: string;
  createdAt: number;
  definition: SiteDefinition;
}

const SITE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,6})$/;
const MATCH_PATTERN = /^(?:\*|https?):\/\/(?:\*|(?:\*\.)?[^/*]+)\/.*$/;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const NAME_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

function readLocator(value: unknown, path: string): Locator {
  const record = readRecord(value, path);
  requireKeys(record, path, ['role', 'name']);
  const names = readRecord(record.name, joinPath(path, 'name'));
  if (!Object.hasOwn(names, 'en')) {
    throw new Invalid('invalid_content', 'missing the en fallback', joinPath(path, 'name'));
  }
  const name: Record<string, string[]> = {};
  for (const [lang, list] of Object.entries(names)) {
    const langPath = joinPath(joinPath(path, 'name'), lang);
    if (!LANG.test(lang)) throw new Invalid('invalid_content', 'not a language tag', langPath);
    const items = readArray(list, langPath);
    if (items.length === 0) throw new Invalid('invalid_content', 'must not be empty', langPath);
    name[lang] = items.map((item, i) =>
      readString(item, joinPath(langPath, i), { nonEmpty: true })
    );
  }
  return { role: readString(record.role, joinPath(path, 'role'), { nonEmpty: true }), name };
}

function readLocators(value: unknown, path: string): Locator[] {
  const items = readArray(value, path);
  if (items.length === 0) throw new Invalid('invalid_content', 'must not be empty', path);
  return items.map((item, i) => readLocator(item, joinPath(path, i)));
}

// Site definitions ignore keys they don't know (spec 7, "Unknown fields"): a newer registry must
// not break an older client, and clients never republish definitions.
function requireKeys(record: Record<string, unknown>, path: string, required: string[]): void {
  readExtra(record, path, required, required);
}

function readField(value: unknown, path: string): SiteField | UnusableField {
  const record = readRecord(value, path);
  requireKeys(record, path, ['name', 'label', 'locators', 'inject']);
  const name = readString(record.name, joinPath(path, 'name'), { nonEmpty: true, max: 128 });
  const label = readString(record.label, joinPath(path, 'label'), { nonEmpty: true });
  const locators = readLocators(record.locators, joinPath(path, 'locators'));
  const injectPath = joinPath(path, 'inject');
  const inject = readArray(record.inject, injectPath).map((item, i) =>
    readString(item, joinPath(injectPath, i), { nonEmpty: true })
  );
  if (inject.length === 0) throw new Invalid('invalid_content', 'must not be empty', injectPath);
  if (new Set(inject).size !== inject.length) {
    throw new Invalid('invalid_content', 'repeats a strategy', injectPath);
  }
  const clipboard = inject.indexOf('clipboard');
  if (clipboard !== -1 && clipboard !== inject.length - 1) {
    throw new Invalid('invalid_content', 'clipboard must be last', injectPath);
  }
  const unknownStrategy = inject.find(
    (s) => !(INJECTION_STRATEGIES as readonly string[]).includes(s)
  );
  let unusable: string | undefined =
    unknownStrategy === undefined ? undefined : `unknown injection strategy ${unknownStrategy}`;
  const constraints: FieldConstraints = {};
  if (record.constraints !== undefined) {
    const cPath = joinPath(path, 'constraints');
    const c = readRecord(record.constraints, cPath);
    requireKeys(c, cPath, []);
    if (c.maxLength !== undefined) {
      constraints.maxLength = readInteger(c.maxLength, joinPath(cPath, 'maxLength'), { min: 1 });
    }
    if (c.counter !== undefined) {
      const counter = readString(c.counter, joinPath(cPath, 'counter'), { nonEmpty: true });
      if ((COUNTER_NAMES as readonly string[]).includes(counter)) {
        constraints.counter = counter as CounterName;
      } else {
        unusable ??= `unknown counter ${counter}`;
      }
    }
  }
  if (unusable !== undefined) return { name, reason: unusable };
  return { name, label, locators, inject: inject as InjectionStrategy[], constraints };
}

/**
 * Validates a site definition JSON value (spec 10.1). Unknown keys are ignored; a field naming an
 * unknown injection strategy or counter is moved to `unusableFields`.
 */
export function readSiteDefinition(value: unknown, path = ''): SiteDefinition {
  const record = readRecord(value, path);
  requireKeys(record, path, ['id', 'version', 'name', 'match', 'fields']);
  const id = readString(record.id, joinPath(path, 'id'), { max: 128 });
  if (!SITE_ID.test(id))
    throw new Invalid('invalid_content', 'not a site id', joinPath(path, 'id'));
  const version = readString(record.version, joinPath(path, 'version'));
  const v = VERSION.exec(version);
  if (v === null || Number(v[2]) < 1 || Number(v[2]) > 12) {
    throw new Invalid('invalid_content', 'expected YYYY.MM.N', joinPath(path, 'version'));
  }
  const matchPath = joinPath(path, 'match');
  const match = readArray(record.match, matchPath).map((item, i) => {
    const pattern = readString(item, joinPath(matchPath, i));
    if (!MATCH_PATTERN.test(pattern)) {
      throw new Invalid('invalid_content', 'not a match pattern', joinPath(matchPath, i));
    }
    return pattern;
  });
  const fieldsPath = joinPath(path, 'fields');
  const read = readArray(record.fields, fieldsPath).map((item, i) =>
    readField(item, joinPath(fieldsPath, i))
  );
  if (read.length === 0) throw new Invalid('invalid_content', 'must not be empty', fieldsPath);
  if (new Set(read.map((f) => f.name)).size !== read.length) {
    throw new Invalid('invalid_content', 'repeats a field name', fieldsPath);
  }
  const fields = read.filter((f): f is SiteField => !('reason' in f));
  const unusableFields = read.filter((f): f is UnusableField => 'reason' in f);
  const definition: SiteDefinition = {
    id,
    version,
    name: readString(record.name, joinPath(path, 'name'), { nonEmpty: true }),
    match,
    fields,
  };
  if (record.account !== undefined) {
    const aPath = joinPath(path, 'account');
    const account = readRecord(record.account, aPath);
    requireKeys(account, aPath, ['locator', 'extract']);
    const extract = readString(account.extract, joinPath(aPath, 'extract'), { nonEmpty: true });
    try {
      new RegExp(extract);
    } catch {
      throw new Invalid('invalid_content', 'not a regular expression', joinPath(aPath, 'extract'));
    }
    definition.account = {
      locator: readLocator(account.locator, joinPath(aPath, 'locator')),
      extract,
    };
  }
  if (record.intents !== undefined) {
    const iPath = joinPath(path, 'intents');
    const intents: Record<string, string> = {};
    for (const [name, template] of Object.entries(readRecord(record.intents, iPath))) {
      if (!NAME_KEY.test(name))
        throw new Invalid('invalid_content', 'bad intent name', joinPath(iPath, name));
      intents[name] = readString(template, joinPath(iPath, name), { nonEmpty: true });
    }
    definition.intents = intents;
  }
  if (unusableFields.length > 0) definition.unusableFields = unusableFields;
  return definition;
}

/** Validates a site definition from untrusted JSON (already parsed). */
export function parseSiteDefinition(value: unknown): ParseResult<SiteDefinition> {
  return capture(() => readSiteDefinition(value));
}

/**
 * Parses a `KIND_SITE_DEF` event (spec 7.6, 10.3): signature valid, signed by the pinned registry
 * publisher key, `d` equal to the definition's `id`, content a valid definition.
 */
export function parseSiteDefinitionEvent(
  event: unknown,
  options: { publisherPubkey: string }
): ParseResult<SiteDefinitionEvent> {
  return capture(() => {
    const signed = readSignedEvent(event);
    checkKind(signed.kind, SITE_DEF_KINDS);
    if (signed.pubkey !== options.publisherPubkey) {
      throw new Invalid('wrong_author', 'not signed by the registry publisher key', 'pubkey');
    }
    const d = singleTag(signed.tags, 'd', true);
    const definition = readSiteDefinition(parseJsonText(signed.content), 'content');
    if (definition.id !== d)
      throw new Invalid('invalid_tags', 'd differs from the definition id', 'tags.d');
    return { eventId: signed.id, pubkey: signed.pubkey, createdAt: signed.created_at, definition };
  });
}

/**
 * Orders two definition versions (`YYYY.MM.N`): negative if `a` is older. A device replaces its
 * bundled definition only with a newer one (10.3).
 */
export function compareSiteVersions(a: string, b: string): number {
  const parts = (v: string): number[] => {
    const m = VERSION.exec(v);
    if (m === null) throw new Error(`not a site definition version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}
