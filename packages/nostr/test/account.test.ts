import { describe, expect, it } from 'vitest';
import {
  displayAccount,
  normalizeAccount,
  parseSiteDefinition,
  sameAccount,
} from '../src/index.ts';

const definition = (account: Record<string, unknown>) => ({
  id: 'x',
  version: '2026.10.1',
  name: 'X',
  match: ['https://x.com/*'],
  account: {
    locator: { role: 'button', name: { en: ['Account menu'] } },
    extract: '@(\\w+)',
    ...account,
  },
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
      inject: ['paste', 'clipboard'],
    },
  ],
});

describe('account normalization (spec 10.1)', () => {
  it('strips one leading @ and surrounding whitespace, and folds case by default', () => {
    for (const account of ['@Handle', 'handle', ' handle ', ' @HANDLE ']) {
      expect(normalizeAccount('x', account)).toBe('handle');
    }
    expect(sameAccount('x', '@Handle', ' handle ')).toBe(true);
    expect(sameAccount('x', 'handle', 'other')).toBe(false);
    expect(normalizeAccount('mastodon', 'Me@Example.Social')).toBe('me@example.social');
  });

  it('keeps the account as typed for display, minus the @ and whitespace', () => {
    expect(displayAccount(' @Handle ')).toBe('Handle');
    expect(displayAccount('me@example.social')).toBe('me@example.social');
  });

  it('keeps case where the definition says accounts are case-sensitive', () => {
    const parsed = parseSiteDefinition(definition({ caseSensitive: true }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.account?.caseSensitive).toBe(true);
    expect(normalizeAccount('x', '@Handle', parsed.value)).toBe('Handle');
    expect(sameAccount('x', 'Handle', 'handle', parsed.value)).toBe(false);
    expect(sameAccount('x', '@Handle', ' Handle ', parsed.value)).toBe(true);
    // A definition for another site doesn't apply.
    expect(normalizeAccount('bsky', 'Handle', parsed.value)).toBe('handle');
  });

  it('defaults caseSensitive to false and refuses a value that is not a boolean', () => {
    const parsed = parseSiteDefinition(definition({}));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.account).not.toHaveProperty('caseSensitive');
    expect(normalizeAccount('x', 'Handle', parsed.value)).toBe('handle');
    const bad = parseSiteDefinition(definition({ caseSensitive: 'yes' }));
    expect(bad.ok).toBe(false);
  });
});
