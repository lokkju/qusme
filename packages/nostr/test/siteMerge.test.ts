import { describe, expect, it } from 'vitest';
import { type JsonObject, mergeSiteOverride, parseSiteDefinition } from '../src/index.ts';

const official: JsonObject = {
  id: 'mastodon',
  version: '2026.10.1',
  name: 'Mastodon',
  match: [],
  intents: { compose: '{origin}/share?text={text}' },
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
      inject: ['paste', 'clipboard'],
      constraints: { maxLength: 500 },
    },
    {
      name: 'cw',
      label: 'Content warning',
      locators: [{ role: 'textbox', name: { en: ['Content warning'] } }],
      inject: ['insertText'],
    },
  ],
};

describe('effective site definition (spec 10.2)', () => {
  it('returns the official definition when there is no override', () => {
    expect(mergeSiteOverride(official, null)).toBe(official);
    expect(mergeSiteOverride(official, undefined)).toBe(official);
    expect(mergeSiteOverride(undefined, null)).toBeUndefined();
  });

  it('merges objects, replaces scalars and arrays, removes keys set to null', () => {
    const merged = mergeSiteOverride(official, {
      match: ['https://mastodon.social/*'],
      name: 'Mastodon (social)',
      intents: null,
    });
    expect(merged?.match).toEqual(['https://mastodon.social/*']);
    expect(merged?.name).toBe('Mastodon (social)');
    expect(merged).not.toHaveProperty('intents');
    expect(merged?.fields).toEqual(official.fields);
  });

  it('merges fields by name and appends new ones', () => {
    const merged = mergeSiteOverride(official, {
      fields: [
        { name: 'text', constraints: { maxLength: 1000 } },
        { name: 'cw', inject: ['paste'] },
        {
          name: 'alt',
          label: 'Alt text',
          locators: [{ role: 'textbox', name: { en: ['Alt'] } }],
          inject: ['paste'],
        },
      ],
    });
    const definition = parseSiteDefinition(merged);
    if (!definition.ok) throw new Error(definition.error.message);
    const [text, cw, alt] = definition.value.fields;
    expect(text?.constraints).toEqual({ maxLength: 1000 });
    expect(text?.inject).toEqual(['paste', 'clipboard']);
    expect(cw?.inject).toEqual(['paste']);
    expect(alt?.name).toBe('alt');
    // The official definition is untouched.
    expect((official.fields as JsonObject[])[0]?.constraints).toEqual({ maxLength: 500 });
  });

  it('drops a constraint the override sets to null', () => {
    const merged = mergeSiteOverride(official, {
      fields: [{ name: 'text', constraints: { maxLength: null } }],
    });
    expect((merged?.fields as JsonObject[] | undefined)?.[0]?.constraints).toEqual({});
  });

  it('takes the override alone for a custom destination', () => {
    const override = { match: ['https://example.social/*'] };
    const merged = mergeSiteOverride(undefined, override);
    expect(merged).toEqual(override);
    expect(merged).not.toBe(override);
  });
});
