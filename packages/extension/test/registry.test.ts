import {
  compareSiteVersions,
  type JsonObject,
  KIND_RELAY_LIST,
  KIND_SITE_DEF,
  type NostrEvent,
  REGISTRY_FALLBACK_RELAYS,
  REGISTRY_SNAPSHOT_FORMAT,
  RelayConnection,
} from '@qusme/nostr';
import { FakeRelayNetwork } from '@qusme/nostr/testing';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { definitionForDraft, effectiveDefinition } from '../src/insertion/definitions.ts';
import { documentUrlPatterns } from '../src/insertion/matching.ts';
import {
  BUNDLED_REGISTRY,
  LOCAL_REGISTRY,
  REGISTRY_REFRESH_SECONDS,
  RegistryDefinitionSource,
} from '../src/insertion/registry.ts';
import { MemoryStorageArea } from '../src/storage.ts';

// A throwaway publisher, pinned in place of the production key for these tests.
const publisherKey = generateSecretKey();
const publisher = getPublicKey(publisherKey);
const strangerKey = generateSecretKey();
const WRITE = 'wss://registry-write.example';
const NOW = 1_793_836_800;

const definition = (id: string, version: string, maxLength = 280): JsonObject => ({
  id,
  version,
  name: id,
  match: [`https://${id}.example/*`],
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
      inject: ['paste', 'clipboard'],
      constraints: { maxLength },
    },
  ],
});

const sign = (def: JsonObject, key = publisherKey, createdAt = NOW): NostrEvent =>
  finalizeEvent(
    {
      kind: KIND_SITE_DEF,
      created_at: createdAt,
      tags: [['d', String(def.id)]],
      content: JSON.stringify(def),
    },
    key
  );

const relayList = (urls: string[], createdAt = NOW): NostrEvent =>
  finalizeEvent(
    { kind: KIND_RELAY_LIST, created_at: createdAt, tags: urls.map((u) => ['r', u]), content: '' },
    publisherKey
  );

const snapshotOf = (siteDefinitions: NostrEvent[], list?: NostrEvent) => ({
  format: REGISTRY_SNAPSHOT_FORMAT,
  publisher,
  ...(list && { relayList: list }),
  siteDefinitions,
});

async function seed(net: FakeRelayNetwork, url: string, events: NostrEvent[]): Promise<void> {
  const connection = await RelayConnection.open(url, { socket: net.socket });
  for (const event of events) await connection.publish(event);
  connection.close();
}

function source(
  snapshot: unknown,
  net: FakeRelayNetwork,
  local = new MemoryStorageArea(),
  now = () => NOW
) {
  return new RegistryDefinitionSource({
    local,
    snapshot,
    publisher,
    socket: net.socket,
    relayTimeoutMs: 500,
    now,
  });
}

describe('the bundled registry', () => {
  it('verifies against the production key and holds the X definition', () => {
    expect(BUNDLED_REGISTRY.rejected).toEqual([]);
    expect(BUNDLED_REGISTRY.definitions.map((d) => d.definition.id)).toEqual(['x']);
    const x = BUNDLED_REGISTRY.definitions[0]?.definition;
    expect(compareSiteVersions(x?.version ?? '', '2026.11.2')).toBeGreaterThanOrEqual(0);
    expect(x?.fields[0]?.inject[0]).toBe('insertText');
  });

  it('drops a bundled definition that fails verification', () => {
    const net = new FakeRelayNetwork();
    const good = sign(definition('x', '2026.11.1'));
    const bad = { ...sign(definition('y', '2026.11.1')), content: '{}' };
    const foreign = sign(definition('z', '2026.11.1'), strangerKey);
    const s = source(snapshotOf([good, bad, foreign]), net);
    expect(s.official('x')).toEqual(definition('x', '2026.11.1'));
    expect(s.official('y')).toBeUndefined();
    expect(s.official('z')).toBeUndefined();
  });
});

describe('RegistryDefinitionSource.refresh', () => {
  it('fetches from the fallback relays when the snapshot has no relay list', async () => {
    const net = new FakeRelayNetwork();
    for (const url of REGISTRY_FALLBACK_RELAYS) net.add(url);
    await seed(net, REGISTRY_FALLBACK_RELAYS[0] as string, [sign(definition('x', '2026.11.2'))]);
    const s = source(snapshotOf([sign(definition('x', '2026.11.1'))]), net);
    const result = await s.refresh();
    expect(result).toEqual({ state: 'refreshed', updated: ['x'], rejected: 0 });
    expect(s.version('x')).toBe('2026.11.2');
  });

  it('prefers the newer version, refuses an older one and ignores other authors', async () => {
    const net = new FakeRelayNetwork();
    net.add(WRITE);
    await seed(net, WRITE, [
      sign(definition('x', '2026.11.10')),
      // Older than the bundled 2026.12.1, though signed later: never a downgrade.
      sign(definition('y', '2026.11.1'), publisherKey, NOW + 100),
      // Newer, but not the publisher's.
      sign(definition('z', '2027.1.1'), strangerKey),
      sign(definition('new', '2026.11.1')),
    ]);
    const s = source(
      snapshotOf(
        [
          sign(definition('x', '2026.11.9')),
          sign(definition('y', '2026.12.1')),
          sign(definition('z', '2026.11.1')),
        ],
        relayList([WRITE])
      ),
      net
    );
    const result = await s.refresh();
    expect(result.state === 'refreshed' && [...result.updated].sort()).toEqual(['new', 'x']);
    // The authors filter keeps the stranger's event out; parsing would refuse it anyway.
    expect(result).toMatchObject({ rejected: 0 });
    expect(s.version('x')).toBe('2026.11.10');
    expect(s.version('y')).toBe('2026.12.1');
    expect(s.version('z')).toBe('2026.11.1');
    expect(s.version('new')).toBe('2026.11.1');
  });

  it('caches verified events and never lets the cache downgrade the bundle', async () => {
    const net = new FakeRelayNetwork();
    net.add(WRITE);
    await seed(net, WRITE, [sign(definition('x', '2026.11.5'))]);
    const local = new MemoryStorageArea();
    const bundle = snapshotOf([sign(definition('x', '2026.11.1'))], relayList([WRITE]));
    await source(bundle, net, local).refresh();

    // Another context (the popup) reads the cache.
    const popup = source(bundle, new FakeRelayNetwork(), local);
    expect(popup.version('x')).toBe('2026.11.1');
    await popup.load();
    expect(popup.version('x')).toBe('2026.11.5');

    // A newer build bundles 2026.12.1; the cached 2026.11.5 does not replace it.
    const newer = source(snapshotOf([sign(definition('x', '2026.12.1'))]), net, local);
    await newer.load();
    expect(newer.version('x')).toBe('2026.12.1');
  });

  it('ignores a cached event that fails verification', async () => {
    const local = new MemoryStorageArea();
    const forged = {
      ...sign(definition('x', '2027.1.1')),
      content: JSON.stringify(definition('x', '2027.1.2')),
    };
    await local.set({
      [LOCAL_REGISTRY]: {
        siteDefinitions: [forged, sign(definition('y', '2027.1.1'), strangerKey)],
        checkedAt: NOW,
      },
    });
    const s = source(
      snapshotOf([sign(definition('x', '2026.11.1'))]),
      new FakeRelayNetwork(),
      local
    );
    await s.load();
    expect(s.version('x')).toBe('2026.11.1');
    expect(s.official('y')).toBeUndefined();
  });

  it('keeps what it has when no relay answers, and waits before trying again', async () => {
    let clock = NOW;
    const net = new FakeRelayNetwork();
    const local = new MemoryStorageArea();
    const s = source(snapshotOf([sign(definition('x', '2026.11.1'))]), net, local, () => clock);
    expect(await s.refresh()).toEqual({ state: 'unreachable' });
    expect(s.version('x')).toBe('2026.11.1');
    clock += 60;
    expect(await s.refresh()).toEqual({ state: 'skipped' });
    clock += REGISTRY_REFRESH_SECONDS;
    expect(await s.refresh()).toEqual({ state: 'unreachable' });
    expect(await s.refresh({ force: true })).toEqual({ state: 'unreachable' });
  });

  it('adopts a newer relay list and tells subscribers about new definitions', async () => {
    const OLD = 'wss://old.example';
    const net = new FakeRelayNetwork();
    net.add(OLD);
    net.add(WRITE);
    await seed(net, OLD, [relayList([WRITE], NOW + 10)]);
    await seed(net, WRITE, [sign(definition('x', '2026.11.1'))]);
    const s = source(snapshotOf([], relayList([OLD])), net);
    let calls = 0;
    s.subscribe(() => calls++);
    expect((await s.refresh()).state).toBe('refreshed');
    expect(s.version('x')).toBe('2026.11.1');
    expect(calls).toBe(1);
  });
});

describe('effective definitions over the registry source', () => {
  it('merges the destination override over the refreshed definition', async () => {
    const net = new FakeRelayNetwork();
    net.add(WRITE);
    await seed(net, WRITE, [sign(definition('x', '2026.11.2', 500))]);
    const s = source(snapshotOf([sign(definition('x', '2026.11.1'))], relayList([WRITE])), net);

    const destination = {
      id: 'dest-x',
      site: 'x',
      account: 'lokkju',
      label: 'X',
      status: 'confirmed' as const,
      override: { match: ['https://x.mirror.example/*'] },
    };
    expect(effectiveDefinition(s, 'x', null)?.fields[0]?.constraints.maxLength).toBe(280);
    await s.refresh();
    const merged = definitionForDraft(
      s,
      { destination: 'dest-x', site: 'x', account: 'lokkju', field: 'text' },
      [destination]
    );
    expect(merged.definition?.version).toBe('2026.11.2');
    expect(merged.field?.constraints.maxLength).toBe(500);
    expect(merged.definition?.match).toEqual(['https://x.mirror.example/*']);
    expect(documentUrlPatterns([destination], s)).toEqual(['https://x.mirror.example/*']);
  });
});
