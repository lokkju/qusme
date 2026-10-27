// X's weighted post length, ported from twitter-text 3.1.0 (github.com/twitter/twitter-text,
// js/src/parseTweet.js, extractUrlsWithIndices.js, lib/idna.js, regexp/*). Copyright 2018
// Twitter, Inc. Licensed under the Apache License, Version 2.0.
//
// The port keeps upstream's regexes and counting loop. Two things differ: the regexes are built
// once from named pieces instead of through `regexSupplant` and the legacy `RegExp.$n` statics, and
// emoji are found with the engine's Unicode properties (`EMOJI` below) instead of twemoji-parser
// 11, which stopped at Emoji 12 and so counts a newer sequence per code point. X counts every emoji
// sequence as 2 whatever its age (docs.x.com, "Counting characters").
import { CCTLDS, GTLDS } from './twitterTextTlds.ts';

/** A twitter-text configuration (upstream `config/v*.json`). */
export interface TwitterTextConfig {
  version: number;
  maxWeightedTweetLength: number;
  scale: number;
  defaultWeight: number;
  emojiParsingEnabled: boolean;
  transformedURLLength: number;
  ranges: readonly { start: number; end: number; weight: number }[];
}

const V2_RANGES = [
  { start: 0, end: 4351, weight: 100 },
  { start: 8192, end: 8205, weight: 100 },
  { start: 8208, end: 8223, weight: 100 },
  { start: 8242, end: 8247, weight: 100 },
] as const;

/** Upstream `config/v2.json`: weighted ranges, emoji counted per code point. */
export const TWITTER_TEXT_CONFIG_V2: TwitterTextConfig = {
  version: 2,
  maxWeightedTweetLength: 280,
  scale: 100,
  defaultWeight: 200,
  emojiParsingEnabled: false,
  transformedURLLength: 23,
  ranges: V2_RANGES,
};

/** Upstream `config/v3.json`, the configuration X uses: v2 plus one weight per emoji sequence. */
export const TWITTER_TEXT_CONFIG_V3: TwitterTextConfig = {
  ...TWITTER_TEXT_CONFIG_V2,
  version: 3,
  emojiParsingEnabled: true,
};

/** The result of {@link parseTweet}; field names and meanings are upstream's. */
export interface ParsedTweet {
  weightedLength: number;
  valid: boolean;
  permillage: number;
  validRangeStart: number;
  /** Inclusive UTF-16 index of the last character within the limit. */
  validRangeEnd: number;
  displayRangeStart: number;
  displayRangeEnd: number;
}

export interface ExtractedUrl {
  url: string;
  /** UTF-16 start and end (exclusive) in the text. */
  indices: [number, number];
}

// regexp/*.js, as source strings.
const invalidCharsGroup = '\\uFFFE\\uFEFF\\uFFFF';
const directionalMarkersGroup = '\\u202A-\\u202E\\u061C\\u200E\\u200F\\u2066\\u2067\\u2068\\u2069';
const spacesGroup =
  '\\x09-\\x0D\\x20\\x85\\xA0\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const punct = "\\!'#%&'\\(\\)*\\+,\\\\\\-\\.\\/:;<=>\\?@\\[\\]\\^_{|}~\\$";
const latinAccentChars =
  '\\xC0-\\xD6\\xD8-\\xF6\\xF8-\\xFF\\u0100-\\u024F\\u0253\\u0254\\u0256\\u0257\\u0259\\u025B\\u0263\\u0268\\u026F\\u0272\\u0289\\u028B\\u02BB\\u0300-\\u036F\\u1E00-\\u1EFF';
const cyrillicLettersAndMarks = '\\u0400-\\u04FF';
const tldLookahead = '(?=[^0-9a-zA-Z@+-]|$)';
const validGTLD = `(?:(?:${GTLDS})${tldLookahead})`;
const validCCTLD = `(?:(?:${CCTLDS})${tldLookahead})`;
const validPunycode = '(?:xn--[\\-0-9a-z]+)';
const validUrlPrecedingChars = `(?:[^A-Za-z0-9@＠$#＃${invalidCharsGroup}]|[${directionalMarkersGroup}]|^)`;
const invalidDomainChars = `${punct}${spacesGroup}${invalidCharsGroup}${directionalMarkersGroup}`;
const validDomainChars = `[^${invalidDomainChars}]`;
const validSubdomain = `(?:(?:${validDomainChars}(?:[_-]|${validDomainChars})*)?${validDomainChars}\\.)`;
const validDomainName = `(?:(?:${validDomainChars}(?:-|${validDomainChars})*)?${validDomainChars}\\.)`;
const validDomain = `(?:${validSubdomain}*${validDomainName}(?:${validGTLD}|${validCCTLD}|${validPunycode}))`;
const validPortNumber = '[0-9]+';
const validGeneralUrlPathChars = `[a-z${cyrillicLettersAndMarks}0-9!\\*';:=\\+,\\.\\$\\/%#\\[\\]\\-\\u2013_~@\\|&${latinAccentChars}]`;
const validUrlBalancedParens = `\\((?:${validGeneralUrlPathChars}+|(?:${validGeneralUrlPathChars}*\\(${validGeneralUrlPathChars}+\\)${validGeneralUrlPathChars}*))\\)`;
const validUrlPathEndingChars = `[\\+\\-a-z${cyrillicLettersAndMarks}0-9=_#\\/${latinAccentChars}]|(?:${validUrlBalancedParens})`;
const validUrlPath = `(?:(?:${validGeneralUrlPathChars}*(?:${validUrlBalancedParens}${validGeneralUrlPathChars}*)*${validUrlPathEndingChars})|(?:@${validGeneralUrlPathChars}+/))`;
const validUrlQueryChars = "[a-z0-9!?\\*'@\\(\\);:&=\\+\\$\\/%#\\[\\]\\-_\\.,~|]";
const validUrlQueryEndingChars = '[a-z0-9\\-_&=#\\/]';

// Groups: 1 total, 2 preceding character, 3 URL, 4 protocol, 5 domain, 6 port, 7 path, 8 query.
const EXTRACT_URL_SOURCE =
  `((${validUrlPrecedingChars})((https?:\\/\\/)?(${validDomain})(?::(${validPortNumber}))?` +
  `(\\/${validUrlPath}*)?(\\?${validUrlQueryChars}*${validUrlQueryEndingChars})?))`;
const VALID_ASCII_DOMAIN_SOURCE = `(?:(?:[\\-a-z0-9${latinAccentChars}]+)\\.)+(?:${validGTLD}|${validCCTLD}|${validPunycode})`;
const VALID_ASCII_DOMAIN = new RegExp(VALID_ASCII_DOMAIN_SOURCE, 'i');
const VALID_TCO_URL = new RegExp(
  `^https?:\\/\\/t\\.co\\/([a-z0-9]+)(?:\\?${validUrlQueryChars}*${validUrlQueryEndingChars})?`,
  'i'
);
const INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS = /[-_./]$/;
const INVALID_CHARS = new RegExp(`[${invalidCharsGroup}]`);
// An emoji as X counts one: a ZWJ sequence whose elements may lack their U+FE0F (minimally
// qualified or unqualified forms, which twemoji-parser also accepted), any RGI emoji, or a keycap
// without U+FE0F. The ZWJ alternative comes first because alternation takes the first match.
const EMOJI_ELEMENT =
  '(?:\\p{RGI_Emoji}|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)';
const EMOJI = new RegExp(
  `${EMOJI_ELEMENT}(?:\\u200D${EMOJI_ELEMENT})+|\\p{RGI_Emoji}|[0-9#*]\\u20E3`,
  'gv'
);

const MAX_URL_LENGTH = 4096;
const MAX_TCO_SLUG_LENGTH = 40;
const MAX_DOMAIN_LABEL_LENGTH = 63;
const DEFAULT_PROTOCOL = 'https://';

// Punycode (RFC 3492) as punycode.js 1.4.1 encodes a label for `toASCII`.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

const digit = (d: number): string => String.fromCharCode(d + 22 + 75 * (d < 26 ? 1 : 0));

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  for (; d > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) d = Math.floor(d / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function punycodeEncode(input: string): string {
  const points = Array.from(input, (c) => c.codePointAt(0) as number);
  let output = '';
  for (const p of points) if (p < 0x80) output += String.fromCharCode(p);
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += '-';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < points.length) {
    let m = Number.MAX_SAFE_INTEGER;
    for (const p of points) if (p >= n && p < m) m = p;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const p of points) {
      if (p < n) delta++;
      if (p === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
          if (q < t) break;
          output += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digit(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output;
}

// punycode.toASCII: maps each part between IDNA separators, prefixing encoded ones with `xn--`.
function punycodeToAscii(domain: string): string {
  return domain
    .split(/[\x2E\u3002\uFF0E\uFF61]/)
    .map((label) => (/[^\0-\x7E]/.test(label) ? `xn--${punycodeEncode(label)}` : label))
    .join('.');
}

// lib/idna.js: undefined when a label is empty or longer than 63 once encoded.
function idnaToAscii(domain: string): string | undefined {
  if (domain.startsWith('xn--') && !VALID_ASCII_DOMAIN.test(domain)) return undefined;
  const labels = domain.split('.');
  for (const label of labels) {
    const encoded = punycodeToAscii(label);
    if (encoded.length < 1 || encoded.length > MAX_DOMAIN_LABEL_LENGTH) return undefined;
  }
  return labels.join('.');
}

function isValidUrl(url: string, protocol: string, domain: string): boolean {
  const encoded = idnaToAscii(domain);
  if (encoded === undefined || encoded.length === 0) return false;
  return protocol.length + url.length + encoded.length - domain.length <= MAX_URL_LENGTH;
}

/**
 * URLs in the text as X links them, with or without a protocol (upstream
 * `extractUrlsWithIndices` with `extractUrlsWithoutProtocol: true`).
 */
export function extractUrlsWithIndices(text: string): ExtractedUrl[] {
  if (!text.includes('.')) return [];
  const urls: ExtractedUrl[] = [];
  const extractUrl = new RegExp(EXTRACT_URL_SOURCE, 'gi');
  for (let match = extractUrl.exec(text); match !== null; match = extractUrl.exec(text)) {
    const before = match[2] ?? '';
    let url = match[3] ?? '';
    const protocol = match[4];
    const domain = match[5] ?? '';
    const path = match[7];
    let endPosition = extractUrl.lastIndex;
    const startPosition = endPosition - url.length;
    if (!isValidUrl(url, protocol || DEFAULT_PROTOCOL, domain)) continue;
    if (!protocol) {
      if (INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS.test(before)) continue;
      let lastUrl: ExtractedUrl | undefined;
      let asciiEndPosition = 0;
      for (const ascii of domain.matchAll(new RegExp(VALID_ASCII_DOMAIN_SOURCE, 'gi'))) {
        const asciiDomain = ascii[0];
        const asciiStartPosition = domain.indexOf(asciiDomain, asciiEndPosition);
        asciiEndPosition = asciiStartPosition + asciiDomain.length;
        lastUrl = {
          url: asciiDomain,
          indices: [startPosition + asciiStartPosition, startPosition + asciiEndPosition],
        };
        urls.push(lastUrl);
      }
      if (lastUrl === undefined) continue;
      if (path) {
        lastUrl.url = url.replace(domain, lastUrl.url);
        lastUrl.indices[1] = endPosition;
      }
    } else {
      const tco = VALID_TCO_URL.exec(url);
      if (tco !== null) {
        const slug = tco[1];
        if (slug !== undefined && slug.length > MAX_TCO_SLUG_LENGTH) continue;
        url = tco[0];
        endPosition = startPosition + url.length;
      }
      urls.push({ url, indices: [startPosition, endPosition] });
    }
  }
  return urls;
}

function characterWeight(codeUnit: number, config: TwitterTextConfig): number {
  for (const range of config.ranges) {
    if (codeUnit >= range.start && codeUnit <= range.end) return range.weight;
  }
  return config.defaultWeight;
}

function isSurrogatePair(text: string, index: number): boolean {
  if (index >= text.length - 1) return false;
  const c = text.charCodeAt(index);
  const next = text.charCodeAt(index + 1);
  return c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Upstream `parseTweet`: X's weighted length and the valid range of the text. */
export function parseTweet(text: string, config: TwitterTextConfig = TWITTER_TEXT_CONFIG_V3) {
  const { defaultWeight, emojiParsingEnabled, scale, maxWeightedTweetLength } = config;
  const normalized = text.normalize();
  const urlAt = new Map<number, string>();
  for (const { url, indices } of extractUrlsWithIndices(normalized)) urlAt.set(indices[0], url);
  const emojiAt = new Map<number, string>();
  if (emojiParsingEnabled) {
    for (const match of normalized.matchAll(EMOJI)) emojiAt.set(match.index, match[0]);
  }
  let weightedLength = 0;
  let validDisplayIndex = 0;
  let valid = true;
  for (let i = 0; i < normalized.length; i++) {
    const url = urlAt.get(i);
    const emoji = emojiParsingEnabled ? emojiAt.get(i) : undefined;
    if (url !== undefined) {
      weightedLength += config.transformedURLLength * scale;
      i += url.length - 1;
    } else if (emoji !== undefined) {
      weightedLength += defaultWeight;
      i += emoji.length - 1;
    } else {
      i += isSurrogatePair(normalized, i) ? 1 : 0;
      // Upstream weighs the UTF-16 unit at i, which for a pair is the low surrogate.
      weightedLength += characterWeight(normalized.charCodeAt(i), config);
    }
    if (valid) valid = !INVALID_CHARS.test(normalized.substring(i, i + 1));
    if (valid && weightedLength <= maxWeightedTweetLength * scale) validDisplayIndex = i;
  }
  weightedLength /= scale;
  valid = valid && weightedLength > 0 && weightedLength <= maxWeightedTweetLength;
  const result: ParsedTweet = {
    weightedLength,
    valid,
    permillage: Math.floor((weightedLength / maxWeightedTweetLength) * 1000),
    validRangeStart: 0,
    validRangeEnd: validDisplayIndex + text.length - normalized.length,
    displayRangeStart: 0,
    displayRangeEnd: text.length > 0 ? text.length - 1 : 0,
  };
  return result;
}
