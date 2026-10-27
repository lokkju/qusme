import { describe, expect, it } from 'vitest';
import {
  type FieldValue,
  fieldValueRumor,
  KIND_FIELD_VALUE,
  parseFieldValue,
  submissionRumor,
} from '../src/index.ts';
import { agentPubkey, exampleValue, expectError, expectOk, NOW, WRAP_ID } from './helpers.ts';

const exampleRumor = () => fieldValueRumor(exampleValue);
const withTags = (tags: string[][]) => ({ ...exampleRumor(), tags });

describe('field value rumor', () => {
  it('builds the 7.1 tags in order and parses them back', () => {
    const rumor = exampleRumor();
    expect(rumor.kind).toBe(KIND_FIELD_VALUE);
    expect(rumor.tags).toEqual([
      ['site', 'x'],
      ['account', 'lokkju'],
      ['field', 'text'],
      ['destination', '01JABCDEF'],
      ['status', 'archived:inserted'],
      ['source', WRAP_ID, agentPubkey],
      ['inserted', '1761400100', 'https://x.com/home', 'paste', 'popup', 'Post text', 'lokkju'],
      ['inserted', '1761400200', '', '', 'pwa_copy', '', ''],
      ['validation', '{"counter":"twitter-text","length":12,"ok":true}'],
    ]);
    expect(expectOk(parseFieldValue(JSON.parse(JSON.stringify(rumor))))).toEqual(exampleValue);
  });

  it('round-trips a minimal active draft', () => {
    const value: FieldValue = {
      createdAt: NOW,
      site: 'mastodon',
      account: 'lokkju@mastodon.social',
      field: 'text',
      status: 'active',
      inserted: [],
      content: '',
      reserved: [],
    };
    expect(expectOk(parseFieldValue(fieldValueRumor(value)))).toEqual(value);
  });

  it('accepts every status', () => {
    for (const status of ['active', 'archived:inserted', 'archived:dismissed'] as const) {
      const rumor = fieldValueRumor({ ...exampleValue, status });
      expect(expectOk(parseFieldValue(rumor)).status).toBe(status);
    }
  });

  it('keeps reserved tags verbatim on a round trip', () => {
    const reserved = [
      ['target', 'https://x.com/a/status/1'],
      ['sequence', 'thread-1'],
      ['position', '2', 'of', '5'],
    ];
    const parsed = expectOk(parseFieldValue(withTags([...exampleRumor().tags, ...reserved])));
    expect(parsed.reserved).toEqual(reserved);
    expect(fieldValueRumor(parsed).tags.slice(-3)).toEqual(reserved);
  });

  it('accepts a pubkey and id on the rumor but not a signature', () => {
    expectOk(parseFieldValue({ ...exampleRumor(), pubkey: agentPubkey, id: WRAP_ID }));
    expectError(parseFieldValue({ ...exampleRumor(), sig: 'f'.repeat(128) }), 'invalid_content');
  });

  it('rejects an unknown status', () => {
    const tags = exampleRumor().tags.map((t) => (t[0] === 'status' ? ['status', 'archived'] : t));
    expectError(parseFieldValue(withTags(tags)), 'invalid_tags');
  });

  for (const name of ['site', 'account', 'field', 'status']) {
    it(`rejects a missing ${name}`, () => {
      expectError(
        parseFieldValue(withTags(exampleRumor().tags.filter((t) => t[0] !== name))),
        'invalid_tags'
      );
    });
    it(`rejects a repeated ${name}`, () => {
      const tag = exampleRumor().tags.find((t) => t[0] === name) as string[];
      expectError(parseFieldValue(withTags([...exampleRumor().tags, tag])), 'invalid_tags');
    });
  }

  it('rejects empty site, account and field', () => {
    for (const name of ['site', 'account', 'field']) {
      const tags = exampleRumor().tags.map((t) => (t[0] === name ? [name, ''] : t));
      expectError(parseFieldValue(withTags(tags)), 'invalid_tags');
    }
  });

  it('rejects unknown tags, malformed source and inserted tags, and bad validation JSON', () => {
    const base = exampleRumor().tags;
    const cases: string[][][] = [
      base.map((t) => (t[0] === 'source' ? ['source', 'nothex', agentPubkey] : t)),
      base.map((t) => (t[0] === 'source' ? ['source', WRAP_ID] : t)),
      [...base, ['source', WRAP_ID, agentPubkey]],
      [...base, ['inserted', 'yesterday', '', 'paste', 'popup', '', '']],
      [...base, ['inserted', '1', '', 'paste', '', '', '']],
      [...base, ['inserted', '1', '', 'paste', 'popup']],
      base.map((t) => (t[0] === 'validation' ? ['validation', '{nope'] : t)),
      base.map((t) => (t[0] === 'validation' ? ['validation', '{"__proto__":{"x":1}}'] : t)),
      [...base, ['destination', 'second']],
      [...base, []],
    ];
    for (const tags of cases) {
      const result = parseFieldValue(withTags(tags));
      expect(result.ok, JSON.stringify(tags.at(-1))).toBe(false);
    }
  });

  it('rejects the wrong kind and non-event values without throwing', () => {
    expectError(parseFieldValue({ ...exampleRumor(), kind: 1 }), 'wrong_kind');
    for (const value of [
      null,
      'x',
      42,
      [],
      { kind: KIND_FIELD_VALUE },
      { ...exampleRumor(), tags: 'x' },
    ]) {
      expect(parseFieldValue(value).ok).toBe(false);
    }
  });

  it('refuses to build a value that would not parse', () => {
    expect(() => fieldValueRumor({ ...exampleValue, site: '' })).toThrow(/invalid field value/);
    expect(() => fieldValueRumor({ ...exampleValue, reserved: [['client', 'x']] })).toThrow(
      /not reserved/
    );
  });

  it('builds a submission rumor with only site, account, field and validation', () => {
    const rumor = submissionRumor({
      createdAt: NOW,
      site: 'x',
      account: 'lokkju',
      field: 'text',
      content: 'hi',
      reserved: [],
    });
    expect(rumor.tags).toEqual([
      ['site', 'x'],
      ['account', 'lokkju'],
      ['field', 'text'],
    ]);
  });
});
