import {
  createLocalSigner,
  type JsonObject,
  KIND_SITE_DEF,
  REGISTRY_PUBLISHER,
  REGISTRY_SNAPSHOT_FORMAT,
} from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import { bundledRegistry, effectiveDefinition, loadRegistry } from '../../src/index.ts';
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

describe('bundled registry', () => {
  const publisher = createLocalSigner(new Uint8Array(32).fill(3));
  const sign = (definition: unknown, signer = publisher) =>
    signer.signEvent({
      kind: KIND_SITE_DEF,
      created_at: 1_793_836_800,
      tags: [['d', (definition as { id: string }).id]],
      content: JSON.stringify(definition),
    });

  it('keeps definitions signed by the pinned key, as published, and logs the rest', async () => {
    const pubkey = await publisher.getPublicKey();
    const stranger = createLocalSigner(new Uint8Array(32).fill(4));
    const snapshot = {
      format: REGISTRY_SNAPSHOT_FORMAT,
      publisher: pubkey,
      siteDefinitions: [
        await sign(REGISTRY[0]),
        await sign({ ...(REGISTRY[0] as JsonObject), id: 'other' }, stranger),
      ],
    };
    const logs: string[] = [];
    const definitions = bundledRegistry(snapshot, { publisher: pubkey, log: (l) => logs.push(l) });
    expect(definitions).toEqual([REGISTRY[0]]);
    expect(loadRegistry(definitions).get('x')?.id).toBe('x');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^registry snapshot: dropped siteDefinitions\[1\]: /);
  });

  it('pins the production publisher by default', async () => {
    const snapshot = {
      format: REGISTRY_SNAPSHOT_FORMAT,
      publisher: REGISTRY_PUBLISHER,
      siteDefinitions: [await sign(REGISTRY[0])],
    };
    expect(bundledRegistry(snapshot)).toEqual([]);
  });
});
