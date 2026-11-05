import type { JsonObject } from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import { effectiveDefinition, loadRegistry } from '../../src/index.ts';
import { REGISTRY } from './tools.suite.ts';

describe('registry snapshot', () => {
  it('is empty by default', () => {
    const registry = loadRegistry();
    expect(registry.definitions).toEqual([]);
    expect(effectiveDefinition(registry, 'x', null)).toEqual({ kind: 'none' });
  });

  it('refuses an invalid or repeated definition', () => {
    expect(() => loadRegistry([{ id: 'x' }])).toThrow(/entry 0/);
    expect(() => loadRegistry([REGISTRY[0], REGISTRY[0]])).toThrow(/repeats site x/);
  });

  it('resolves overrides, and reports one that breaks the official definition', () => {
    const registry = loadRegistry(REGISTRY);
    const merged = effectiveDefinition(registry, 'x', {
      fields: [{ name: 'text', constraints: { maxLength: 500 } }],
    });
    expect(merged.kind === 'definition' && merged.definition.fields[0]?.constraints).toEqual({
      maxLength: 500,
      counter: 'twitter-text',
    });
    expect(effectiveDefinition(registry, 'x', { match: ['not a pattern'] }).kind).toBe('invalid');
    // A custom destination with a whole definition in its override uses it.
    const custom = effectiveDefinition(registry, 'blog', {
      ...(REGISTRY[0] as JsonObject),
      id: 'blog',
    });
    expect(custom.kind).toBe('definition');
  });
});
