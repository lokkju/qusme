import { describe, expect, it } from 'vitest';
import {
  type CounterName,
  countCodePoints,
  countGraphemes,
  countLength,
  countMastodon,
  FIELD_VALUE_MAX_BYTES,
  type FieldConstraints,
  parseSiteDefinition,
  utf8Length,
  validateFieldValue,
  validationTagJson,
} from '../src/index.ts';
import { expectOk } from './helpers.ts';

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
const FLAG_ENGLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
const WAVE_TONE = '\u{1F44B}\u{1F3FD}';
const E_ACUTE_DECOMPOSED = 'e\u0301';
const HANGUL_JAMO = '\u1100\u1161\u11A8'; // 각 as three conjoining jamo

describe('counters', () => {
  it.each<[string, string, number, number, number]>([
    // label, text, code points, graphemes, twitter-text
    ['ASCII', 'hello', 5, 5, 5],
    ['empty', '', 0, 0, 0],
    ['CJK', '日本語', 3, 3, 6],
    ['URL', 'https://example.com/path', 24, 24, 23],
    ['ZWJ family', FAMILY, 7, 1, 2],
    ['skin tone', WAVE_TONE, 2, 1, 2],
    ['regional indicator flag', FLAG_JP, 2, 1, 2],
    ['two flags', `${FLAG_JP}${FLAG_JP}`, 4, 2, 4],
    ['tag sequence flag', FLAG_ENGLAND, 7, 1, 2],
    ['combining acute', E_ACUTE_DECOMPOSED, 2, 1, 1],
    // twitter-text normalizes to NFC first: a + U+0300 composes to U+00E0, the jamo to one syllable.
    ['stacked combining marks', 'a\u0300\u0301\u0302', 4, 1, 3],
    ['conjoining jamo', HANGUL_JAMO, 3, 1, 2],
    ['CRLF is one grapheme', 'a\r\nb', 4, 3, 4],
    ['Devanagari conjunct', 'क\u094Dष\u093F', 4, 1, 4],
  ])('%s', (_label, text, codePoints, graphemes, twitter) => {
    expect(countCodePoints(text)).toBe(codePoints);
    expect(countLength(text, 'default')).toBe(codePoints);
    expect(countGraphemes(text)).toBe(graphemes);
    expect(countLength(text, 'graphemes')).toBe(graphemes);
    expect(countLength(text, 'twitter-text')).toBe(twitter);
  });

  it('defaults to code points, not UTF-16 units', () => {
    expect(countLength('\u{1F600}')).toBe(1);
    expect('\u{1F600}'.length).toBe(2);
  });

  it('refuses a counter outside the closed set', () => {
    expect(() => countLength('x', 'words' as CounterName)).toThrow(/unknown counter/);
    expect(() => countLength('x', 'toString' as CounterName)).toThrow(/unknown counter/);
  });
});

describe('utf8Length', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['é', 2],
    ['日', 3],
    ['\u{1F600}', 4],
    ['\uD800', 3],
  ])('%j is %i bytes', (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes);
  });
});

const field = (constraints: FieldConstraints) => ({ name: 'text', constraints });

describe('validateFieldValue', () => {
  it.each<[CounterName, string, number]>([
    ['default', 'a', 300],
    ['default', '\u{1F600}', 300],
    ['graphemes', FAMILY, 300],
    ['graphemes', E_ACUTE_DECOMPOSED, 300],
    ['twitter-text', 'a', 280],
  ])('%s: %j repeated to the limit passes and one more fails', (counter, unit, limit) => {
    const at = validateFieldValue(unit.repeat(limit), field({ maxLength: limit, counter }));
    expect(at).toMatchObject({ ok: true, accepted: true, length: limit, max: limit, counter });
    expect(at.violations).toEqual([]);
    const over = validateFieldValue(unit.repeat(limit + 1), field({ maxLength: limit, counter }));
    expect(over).toMatchObject({ ok: false, accepted: false, length: limit + 1 });
    expect(over.violations).toEqual([
      { field: 'text', constraint: 'maxLength', limit, actual: limit + 1, counter },
    ]);
  });

  it('weighs twitter-text at the limit: 140 CJK characters, then emoji and URLs', () => {
    const c = field({ maxLength: 280, counter: 'twitter-text' });
    expect(validateFieldValue('日'.repeat(140), c)).toMatchObject({ ok: true, length: 280 });
    expect(validateFieldValue(`${'日'.repeat(140)}.`, c)).toMatchObject({ ok: false, length: 281 });
    expect(validateFieldValue(FAMILY.repeat(140), c)).toMatchObject({ ok: true, length: 280 });
    const urls = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(validateFieldValue(urls, c)).toMatchObject({ ok: true, length: 11 * 23 + 10 });
  });

  it('counts code points when the field names no counter, and has no max without maxLength', () => {
    const result = validateFieldValue('héllo', field({}));
    expect(result).toEqual({
      ok: true,
      accepted: true,
      lenient: false,
      counter: 'default',
      length: 5,
      bytes: 6,
      violations: [],
    });
  });

  it('lenient reports constraint violations but accepts the value', () => {
    const result = validateFieldValue('toolong', field({ maxLength: 3 }), { lenient: true });
    expect(result).toMatchObject({ ok: false, accepted: true, lenient: true, length: 7, max: 3 });
    expect(result.violations).toHaveLength(1);
  });

  it('applies the 32 KiB cap whatever the definition says, lenient or not', () => {
    const atCap = 'a'.repeat(FIELD_VALUE_MAX_BYTES);
    expect(validateFieldValue(atCap, field({}))).toMatchObject({ ok: true, bytes: 32_768 });
    const overCap = `${atCap}a`;
    for (const lenient of [false, true]) {
      const result = validateFieldValue(overCap, field({}), { lenient });
      expect(result).toMatchObject({ ok: false, accepted: false, bytes: 32_769 });
      expect(result.violations).toEqual([
        { field: 'text', constraint: 'maxBytes', limit: 32_768, actual: 32_769 },
      ]);
    }
    // Bytes, not characters: 10,923 three-byte characters are 32,769 bytes.
    const cjk = validateFieldValue('日'.repeat(10_923), field({ maxLength: 50_000 }));
    expect(cjk).toMatchObject({ ok: false, length: 10_923, bytes: 32_769 });
    // Both constraints at once, both reported.
    const both = validateFieldValue(overCap, field({ maxLength: 280, counter: 'twitter-text' }), {
      lenient: true,
    });
    expect(both.violations.map((v) => v.constraint)).toEqual(['maxLength', 'maxBytes']);
    expect(both.accepted).toBe(false);
  });

  it('throws on a constraint key or counter this build does not know', () => {
    const unknownKey = { name: 'text', constraints: { maxLines: 3 } as FieldConstraints };
    expect(() => validateFieldValue('x', unknownKey)).toThrow(/unknown constraint "maxLines"/);
    const unknownCounter = field({ counter: 'words' as CounterName });
    expect(() => validateFieldValue('x', unknownCounter)).toThrow(/unknown counter "words"/);
  });

  it('works on a field from a parsed definition', () => {
    const definition = expectOk(
      parseSiteDefinition({
        id: 'bsky',
        version: '2026.10.1',
        name: 'Bluesky',
        match: ['https://bsky.app/*'],
        fields: [
          {
            name: 'text',
            label: 'Post text',
            locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
            inject: ['insertText'],
            constraints: { maxLength: 300, counter: 'graphemes' },
          },
          {
            name: 'future',
            label: 'Future',
            locators: [{ role: 'textbox', name: { en: ['Future'] } }],
            inject: ['insertText'],
            constraints: { maxLength: 300, counter: 'words' },
          },
        ],
      })
    );
    // The unknown counter is refused when the definition loads: that field is unusable.
    expect(definition.unusableFields).toEqual([
      { name: 'future', reason: 'unknown counter words' },
    ]);
    const [text] = definition.fields;
    if (text === undefined) throw new Error('no field');
    expect(validateFieldValue(FAMILY.repeat(300), text)).toMatchObject({ ok: true, length: 300 });
  });
});

describe('mastodon counter', () => {
  it.each<[string, string, number]>([
    ['plain text', 'hello', 5],
    ['graphemes', `${FAMILY}${FLAG_JP}`, 2],
    ['a long URL counts 23', `see https://example.com/${'a'.repeat(80)}`, 4 + 23],
    ['a short URL counts 23', 'https://t.co', 23],
    ['two URLs', 'https://a.com http://b.org/x', 23 + 1 + 23],
    // Mastodon extracts URLs only with a protocol.
    ['a bare domain counts as typed', 'example.com/path', 16],
    ['a remote mention counts as its local part', '@lokkju@mastodon.social hi', 7 + 3],
    ['a local mention is unchanged', '@lokkju hi', 10],
    ['an email address is no mention', 'me@example.com', 14],
    ['a mention followed by a URL scheme is no mention', '@lokkju://x', 11],
    // A mention inside a URL belongs to the URL, which starts first.
    ['a URL holding a mention', 'https://example.social/@lokkju@mastodon.social', 23],
  ])('%s', (_label, text, expected) => {
    expect(countMastodon(text)).toBe(expected);
    expect(countLength(text, 'mastodon')).toBe(expected);
  });

  it('validates a field against it', () => {
    const value = `${'a'.repeat(476)} https://example.com/${'b'.repeat(200)}`;
    expect(validateFieldValue(value, field({ maxLength: 500, counter: 'mastodon' }))).toMatchObject(
      { ok: true, counter: 'mastodon', length: 500 }
    );
  });
});

describe('validationTagJson', () => {
  it('records counter, length, max and ok', () => {
    const result = validateFieldValue(
      'hello world!',
      field({ maxLength: 280, counter: 'twitter-text' })
    );
    expect(validationTagJson(result)).toEqual({
      counter: 'twitter-text',
      length: 12,
      max: 280,
      ok: true,
    });
    expect(JSON.stringify(validationTagJson(result))).toBe(
      '{"counter":"twitter-text","length":12,"max":280,"ok":true}'
    );
  });

  it('records lenient and the violations', () => {
    const result = validateFieldValue('toolong', field({ maxLength: 3 }), { lenient: true });
    expect(validationTagJson(result)).toEqual({
      counter: 'default',
      length: 7,
      max: 3,
      ok: false,
      lenient: true,
      violations: [{ constraint: 'maxLength', limit: 3, actual: 7, counter: 'default' }],
    });
  });
});
