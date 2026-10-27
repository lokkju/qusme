import { describe, expect, it } from 'vitest';
import {
  extractUrlsWithIndices,
  parseTweet,
  TWITTER_TEXT_CONFIG_V2,
  TWITTER_TEXT_CONFIG_V3,
} from '../src/index.ts';
import vectors from './vectors/twitter-text.vectors.json' with { type: 'json' };

// Upstream's conformance suite (validate.yml, extract.yml), run as upstream's JS tests run it:
// WeightedTweetsCounterTest with config v2, the emoji and directional-marker tests with v3.
describe('twitter-text conformance', () => {
  it.each(vectors.WeightedTweetsCounterTest)('v2: $description', ({ text, expected }) => {
    expect(parseTweet(text, TWITTER_TEXT_CONFIG_V2)).toEqual(expected);
  });

  it.each(vectors.WeightedTweetsWithDiscountedEmojiCounterTest)(
    'v3: $description',
    ({ text, expected }) => {
      expect(parseTweet(text, TWITTER_TEXT_CONFIG_V3)).toEqual(expected);
    }
  );

  it.each(vectors.UnicodeDirectionalMarkerCounterTest)('v3: $description', ({ text, expected }) => {
    expect(parseTweet(text)).toEqual(expected);
  });

  it.each([...vectors.urls, ...vectors.tco_urls_with_params])(
    'urls: $description',
    ({ text, expected }) => {
      expect(extractUrlsWithIndices(text).map((u) => u.url)).toEqual(expected);
    }
  );

  it.each([...vectors.urls_with_indices, ...vectors.urls_with_directional_markers])(
    'urls with indices: $description',
    ({ text, expected }) => {
      expect(extractUrlsWithIndices(text)).toEqual(expected);
    }
  );
});

describe('twitter-text weighting', () => {
  it.each([
    ['plain Latin', 'hello', 5],
    ['a URL with a protocol counts 23', 'see https://example.com/a/very/long/path?q=1', 27],
    ['a URL without a protocol counts 23', 'example.com', 23],
    ['two URLs', 'a.com b.org', 47],
    ['CJK weighs 2', '日本語', 6],
    ['Hangul weighs 2', '한국어', 6],
    ['Cyrillic is in the weight-1 range', 'привет', 6],
    ['curly quotes and the en dash weigh 1', '“x” –', 5],
    ['one emoji weighs 2', '\u{1F600}', 2],
    ['skin tone modifier sequence weighs 2', '\u{1F44B}\u{1F3FD}', 2],
    ['ZWJ family weighs 2', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', 2],
    ['flag weighs 2', '\u{1F1EF}\u{1F1F5}', 2],
    ['keycap weighs 2', '#\uFE0F\u20E3', 2],
    ['Emoji 15 (shaking face) weighs 2', '\u{1FAE8}', 2],
    ['Emoji 15.1 ZWJ (phoenix) weighs 2', '\u{1F426}\u200D\u{1F525}', 2],
    ['text-presentation copyright sign is a symbol, weight 1', '©', 1],
    ['decomposed é is normalized to one code point', 'e\u0301', 1],
    // Forms twemoji-parser 11 missed or counted per code point; X counts any emoji as 2.
    ['minimally qualified ZWJ (heart on fire, no FE0F) weighs 2', '\u2764\u200D\u{1F525}', 2],
    ['unqualified keycap weighs 2', '1\u20E3', 2],
    ['Emoji 12 skin tone (pinching hand) weighs 2', '\u{1F90F}\u{1F3FB}', 2],
    ['a dangling ZWJ is not part of the emoji', '\u{1F600}\u200Da', 4],
  ])('%s', (_label, text, expected) => {
    expect(parseTweet(text).weightedLength).toBe(expected);
  });

  it('is valid at exactly 280 and not at 281', () => {
    expect(parseTweet('a'.repeat(280))).toMatchObject({ weightedLength: 280, valid: true });
    expect(parseTweet('a'.repeat(281))).toMatchObject({ weightedLength: 281, valid: false });
    expect(parseTweet('日'.repeat(140))).toMatchObject({ weightedLength: 280, valid: true });
    expect(parseTweet(`${'日'.repeat(140)}a`)).toMatchObject({ valid: false });
  });
});
