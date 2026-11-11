// Mastodon's post length (spec 10.1, `mastodon`), after StatusLengthValidator and Extractor in
// mastodon/mastodon v4.7.5 (app/validators/status_length_validator.rb, app/lib/extractor.rb,
// Account::MENTION_RE in app/models/account.rb).
import { END_MENTION_MATCH, extractUrlsWithIndices } from './twitterText.ts';

/** What every URL counts as: Mastodon's `URL_PLACEHOLDER_CHARS`. */
export const MASTODON_URL_LENGTH = 23;

// Account::MENTION_RE: `@user` or `@user@domain`, not after `=`, `/` or a word character. Ruby's
// [[:word:]] is letters, marks, decimal digits and connector punctuation.
const WORD = '[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]';
const MENTION_SOURCE = `(?<![=/]|${WORD})@(([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)(?:@${WORD}+(?:[.-]+${WORD}+)*)?)`;
const MAX_DOMAIN_LENGTH = 253;

interface Entity {
  start: number;
  end: number;
  replacement: string;
}

function mentions(text: string): Entity[] {
  if (!/[@＠]/.test(text)) return [];
  const found: Entity[] = [];
  for (const match of text.matchAll(new RegExp(MENTION_SOURCE, 'giu'))) {
    const screenName = match[1] as string;
    const end = (match.index as number) + match[0].length;
    if (END_MENTION_MATCH.test(text.slice(end))) continue;
    const [user, domain] = screenName.split('@') as [string, string | undefined];
    if (domain !== undefined && domain.length > MAX_DOMAIN_LENGTH) continue;
    found.push({ start: match.index as number, end, replacement: `@${user}` });
  }
  return found;
}

/**
 * The text Mastodon counts: each URL with a protocol becomes 23 characters and each mention
 * `@user@domain` becomes `@user`. Overlapping entities keep the one that starts first
 * (`remove_overlapping_entities`).
 */
export function mastodonCountableText(text: string): string {
  const urls: Entity[] = extractUrlsWithIndices(text, { withoutProtocol: false }).map(
    ({ indices: [start, end] }) => ({ start, end, replacement: 'x'.repeat(MASTODON_URL_LENGTH) })
  );
  const entities = [...urls, ...mentions(text)].sort((a, b) => a.start - b.start);
  let result = '';
  let at = 0;
  for (const entity of entities) {
    if (entity.start < at) continue;
    result += text.slice(at, entity.start) + entity.replacement;
    at = entity.end;
  }
  return result + text.slice(at);
}
