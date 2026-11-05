import { describe, expect, it } from 'vitest';
import {
  checkDestinationOverride,
  type JsonObject,
  parseDestinationOverride,
} from '../src/index.ts';

const field = {
  name: 'text',
  label: 'Post text',
  locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
  inject: ['paste', 'clipboard'],
};
const x: JsonObject = {
  id: 'x',
  version: '2026.10.1',
  name: 'X',
  match: ['https://x.com/*'],
  fields: [field],
};
const mastodon: JsonObject = { ...x, id: 'mastodon', name: 'Mastodon', match: [] };

describe('destination overrides (spec 10.1, 10.2)', () => {
  it('takes no override for a site with fixed hosts', () => {
    const checked = checkDestinationOverride(x, null);
    expect(checked.ok && checked.value).toMatchObject({
      override: null,
      match: ['https://x.com/*'],
      definition: { id: 'x' },
    });
  });

  it('needs match patterns for a site with no fixed hosts', () => {
    const missing = checkDestinationOverride(mastodon, null);
    expect(!missing.ok && missing.error.message).toMatch(/no fixed hosts/);
    const given = checkDestinationOverride(mastodon, { match: ['https://mastodon.social/*'] });
    expect(given.ok && given.value.match).toEqual(['https://mastodon.social/*']);
  });

  it('refuses an override whose merge is not a valid definition', () => {
    const bad = checkDestinationOverride(x, {
      fields: [{ name: 'text', inject: ['clipboard', 'paste'] }],
    });
    expect(!bad.ok && bad.error.message).toMatch(/clipboard must be last/);
    const badMatch = checkDestinationOverride(x, { match: ['x.com'] });
    expect(!badMatch.ok && badMatch.error.message).toMatch(/not a match pattern/);
  });

  it('lets a custom destination give only its match patterns', () => {
    const custom = checkDestinationOverride(undefined, { match: ['https://blog.example/*'] });
    expect(custom.ok && custom.value).toEqual({
      override: { match: ['https://blog.example/*'] },
      match: ['https://blog.example/*'],
    });
    for (const override of [null, {}, { match: [] }, { match: ['blog.example'] }]) {
      expect(checkDestinationOverride(undefined, override).ok).toBe(false);
    }
    // With fields it means to be a whole definition, and must be one.
    expect(
      checkDestinationOverride(undefined, { match: ['https://blog.example/*'], fields: [field] }).ok
    ).toBe(false);
    const whole = checkDestinationOverride(undefined, { ...x, id: 'blog' });
    expect(whole.ok && whole.value.definition?.id).toBe('blog');
  });

  it('reads typed text: empty is none, anything else a JSON object', () => {
    expect(parseDestinationOverride(x, '  ')).toMatchObject({
      ok: true,
      value: { override: null },
    });
    expect(parseDestinationOverride(x, 'null')).toMatchObject({
      ok: true,
      value: { override: null },
    });
    const notJson = parseDestinationOverride(x, '{"match":');
    expect(!notJson.ok && notJson.error.code).toBe('invalid_json');
    const notObject = parseDestinationOverride(x, '["https://x.com/*"]');
    expect(notObject.ok).toBe(false);
    const ok = parseDestinationOverride(x, '{"match":["https://x.com/lokkju/*"]}');
    expect(ok.ok && ok.value.match).toEqual(['https://x.com/lokkju/*']);
  });
});
