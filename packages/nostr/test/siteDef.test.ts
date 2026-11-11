import { describe, expect, it } from 'vitest';
import {
  compareSiteVersions,
  KIND_SITE_DEF,
  parseSiteDefinition,
  parseSiteDefinitionEvent,
  type SiteDefinition,
} from '../src/index.ts';
import {
  expectError,
  expectOk,
  NOW,
  otherKey,
  otherPubkey,
  queuePubkey,
  sign,
  tamper,
} from './helpers.ts';

// Spec 10.1's example.
const x: SiteDefinition = {
  id: 'x',
  version: '2026.10.1',
  name: 'X',
  match: ['https://x.com/*', 'https://twitter.com/*'],
  account: {
    locator: { role: 'button', name: { en: ['Account menu'] } },
    extract: '@([A-Za-z0-9_]{1,15})',
  },
  intents: { compose: 'https://x.com/intent/post?text={text}' },
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'], de: ['Beitragstext'] } }],
      inject: ['paste', 'insertText', 'clipboard'],
      constraints: { maxLength: 280, counter: 'twitter-text' },
    },
  ],
};

// Spec 10.1's Mastodon case: no fixed hosts.
const mastodon: SiteDefinition = {
  id: 'mastodon',
  version: '2026.10.1',
  name: 'Mastodon',
  match: [],
  intents: { compose: '{origin}/share?text={text}' },
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['What is on your mind?'] } }],
      inject: ['native', 'clipboard'],
      constraints: { maxLength: 500, counter: 'graphemes' },
    },
  ],
};

const defEvent = (definition: unknown, d = 'x', key = otherKey) =>
  sign(
    { kind: KIND_SITE_DEF, created_at: NOW, tags: [['d', d]], content: JSON.stringify(definition) },
    key
  );

describe('site definitions (spec 7.6, 10.1)', () => {
  it('parses the spec examples unchanged', () => {
    expect(expectOk(parseSiteDefinition(JSON.parse(JSON.stringify(x))))).toEqual(x);
    expect(expectOk(parseSiteDefinition(mastodon))).toEqual(mastodon);
  });

  it('parses a signed event from the pinned publisher', () => {
    const event = defEvent(x);
    expect(expectOk(parseSiteDefinitionEvent(event, { publisherPubkey: otherPubkey }))).toEqual({
      eventId: event.id,
      pubkey: otherPubkey,
      createdAt: NOW,
      definition: x,
    });
  });

  it('rejects another publisher, a tampered event, a d that differs from the id, the wrong kind', () => {
    const opts = { publisherPubkey: otherPubkey };
    expectError(
      parseSiteDefinitionEvent(defEvent(x), { publisherPubkey: queuePubkey }),
      'wrong_author'
    );
    const event = defEvent(x);
    expectError(
      parseSiteDefinitionEvent(
        tamper(event, { content: event.content.replace('280', '2800') }),
        opts
      ),
      'bad_signature'
    );
    expectError(parseSiteDefinitionEvent(defEvent(x, 'twitter'), opts), 'invalid_tags');
    expectError(
      parseSiteDefinitionEvent(sign({ ...event, kind: KIND_SITE_DEF - 1 }, otherKey), opts),
      'wrong_kind'
    );
    expectError(parseSiteDefinitionEvent(defEvent('{', 'x'), opts), 'invalid_content');
  });

  it('rejects unknown inject and counter values, unknown keys and other malformed definitions', () => {
    const field = x.fields[0] as SiteDefinition['fields'][number];
    const withField = (change: Record<string, unknown>) => ({
      ...x,
      fields: [{ ...field, ...change }],
    });
    const cases: unknown[] = [
      withField({ inject: [] }),
      withField({ inject: ['clipboard', 'paste'] }),
      withField({ inject: ['paste', 'paste'] }),
      withField({ constraints: { maxLength: 0 } }),
      withField({ locators: [] }),
      withField({ locators: [{ role: 'textbox', name: { de: ['Text'] } }] }),
      withField({ locators: [{ role: 'textbox', name: { en: [] } }] }),
      { ...x, fields: [] },
      { ...x, fields: [field, field] },
      { ...x, id: 'X Corp' },
      { ...x, version: '1.0' },
      { ...x, version: '2026.13.1' },
      { ...x, match: ['x.com'] },
      { ...x, match: 'https://x.com/*' },
      { ...x, account: { ...x.account, extract: '([' } },
      { ...x, account: { locator: x.account?.locator } },
      { ...x, intents: { compose: 42 } },
      JSON.parse('{"__proto__":{"evil":1}}'),
      null,
      [],
    ];
    for (const value of cases) {
      const result = parseSiteDefinition(value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_content');
    }
  });

  it('reads placeholder locators and skips a locator kind it does not know', () => {
    const field = x.fields[0] as SiteDefinition['fields'][number];
    const placeholder = { role: 'textbox', name: { en: ["What's up?"] }, by: 'placeholder' };
    const future = { role: 'textbox', name: { en: ['Post'] }, by: 'xpath' };
    const parsed = expectOk(
      parseSiteDefinition({ ...x, fields: [{ ...field, locators: [future, placeholder] }] })
    );
    expect(parsed.fields[0]?.locators).toEqual([placeholder]);
    expect(parsed.unusableFields).toBeUndefined();
    // A field whose every locator is of an unknown kind keeps working by focus (10.2).
    const onlyFuture = expectOk(
      parseSiteDefinition({ ...x, fields: [{ ...field, locators: [future] }] })
    );
    expect(onlyFuture.fields[0]?.locators).toEqual([]);
    // An account locator of an unknown kind leaves the site without account detection.
    const account = { ...x.account, locator: future };
    expect(expectOk(parseSiteDefinition({ ...x, account })).account).toBeUndefined();
    expectError(
      parseSiteDefinition({ ...x, fields: [{ ...field, locators: [{ ...placeholder, by: 1 }] }] }),
      'invalid_content'
    );
  });

  it('reads an account template from the object form of extract', () => {
    const extract = { pattern: '^@([A-Za-z0-9_]+)$', template: '{1}@{host}' };
    const parsed = expectOk(
      parseSiteDefinition({ ...mastodon, account: { ...x.account, extract } })
    );
    expect(parsed.account).toEqual({
      locator: x.account?.locator,
      extract: '^@([A-Za-z0-9_]+)$',
      template: '{1}@{host}',
    });
    // Without a template the object form means what the string does.
    expect(
      expectOk(
        parseSiteDefinition({ ...x, account: { ...x.account, extract: { pattern: '@(a)' } } })
      ).account?.extract
    ).toBe('@(a)');
    const bad: unknown[] = [
      { pattern: '@(a)', template: '{2}@{host}' },
      { pattern: '@(a)', template: '{host}' },
      { pattern: '@(a)', template: '{1}@{origin}' },
      { pattern: '@(a)', template: '{1}@{0}' },
      { pattern: '@(a)', template: '{1}}' },
      { pattern: '@(a)', template: '' },
      { pattern: '([', template: '{1}' },
      { template: '{1}' },
      [],
    ];
    for (const value of bad) {
      const result = parseSiteDefinition({ ...x, account: { ...x.account, extract: value } });
      expect(result.ok, JSON.stringify(value)).toBe(false);
    }
  });

  it('orders versions as CalVer', () => {
    expect(compareSiteVersions('2026.10.1', '2026.10.2')).toBeLessThan(0);
    expect(compareSiteVersions('2026.11.1', '2026.10.9')).toBeGreaterThan(0);
    expect(compareSiteVersions('2027.1.1', '2026.12.10')).toBeGreaterThan(0);
    expect(compareSiteVersions('2026.10.1', '2026.10.1')).toBe(0);
    expect(() => compareSiteVersions('latest', '2026.10.1')).toThrow();
  });
});
