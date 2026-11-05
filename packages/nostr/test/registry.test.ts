import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  fetchRegistry,
  isNewerSiteDefinition,
  KIND_RELAY_LIST,
  KIND_SITE_DEF,
  type NostrEvent,
  parseRegistryRelayList,
  parseRegistrySiteDefinition,
  REGISTRY_FALLBACK_RELAYS,
  REGISTRY_PUBLISHER,
  REGISTRY_SNAPSHOT_FORMAT,
  RelayConnection,
  readRegistrySnapshot,
  verifyRegistrySnapshot,
} from '../src/index.ts';
import { FakeRelayNetwork } from '../src/testing.ts';

interface Vectors {
  publisher: string;
  cases: { name: string; valid: boolean; snapshot: Record<string, unknown> }[];
}
const vectors = JSON.parse(
  readFileSync(new URL('./vectors/registry-snapshot.vectors.json', import.meta.url), 'utf8')
) as Vectors;

const publisherKey = generateSecretKey();
const publisher = getPublicKey(publisherKey);
const otherKey = generateSecretKey();

const definition = (version: string, id = 'example', maxLength = 280) => ({
  id,
  version,
  name: `Site ${id}`,
  match: [`https://${id}.example/*`],
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
      inject: ['paste', 'clipboard'],
      constraints: { maxLength },
      // Unknown keys are kept in the published JSON for merging (10.2).
      future: true,
    },
  ],
});

const siteDef = (
  def: ReturnType<typeof definition>,
  key = publisherKey,
  createdAt = 1_793_836_800
): NostrEvent =>
  finalizeEvent(
    {
      kind: KIND_SITE_DEF,
      created_at: createdAt,
      tags: [['d', def.id]],
      content: JSON.stringify(def),
    },
    key
  );
const relayList = (urls: string[][], key = publisherKey, createdAt = 1_793_836_800): NostrEvent =>
  finalizeEvent(
    {
      kind: KIND_RELAY_LIST,
      created_at: createdAt,
      tags: urls.map((u) => ['r', ...u]),
      content: '',
    },
    key
  );

describe('the pinned registry publisher', () => {
  it('is the production key from lokkju/qusme-registry', () => {
    expect(REGISTRY_PUBLISHER).toBe(
      '144986dabaeeb884d105f2da2cac0008b3eb408bab0447a39894f87b7d94f54c'
    );
    expect(REGISTRY_FALLBACK_RELAYS).toEqual(['wss://nos.lol', 'wss://relay.ditto.pub']);
  });

  it('matches the committed snapshot', () => {
    const committed = JSON.parse(
      readFileSync(new URL('../../../registry/snapshot.json', import.meta.url), 'utf8')
    );
    expect(committed.publisher).toBe(REGISTRY_PUBLISHER);
    expect(() => verifyRegistrySnapshot(committed, REGISTRY_PUBLISHER)).not.toThrow();
  });
});

describe('verifyRegistrySnapshot', () => {
  it.each(vectors.cases)('agrees with the registry on: $name', ({ valid, snapshot }) => {
    const verify = () => verifyRegistrySnapshot(snapshot, vectors.publisher);
    if (valid) expect(verify).not.toThrow();
    else expect(verify).toThrow(/^snapshot: /);
  });

  it('returns the relay list and the definitions as published', () => {
    const good = vectors.cases.find((c) => c.name === 'good')?.snapshot ?? {};
    const verified = verifyRegistrySnapshot(good, vectors.publisher);
    expect(verified.relayList?.writeRelays).toEqual(['wss://nos.lol', 'wss://relay.ditto.pub']);
    expect(verified.definitions.map((d) => d.definition.id)).toEqual(['example', 'other']);
    expect(verified.definitions[0]?.json).toEqual(
      JSON.parse((good.siteDefinitions as NostrEvent[])[0]?.content ?? '')
    );
  });

  it('accepts a snapshot without a relay list', () => {
    const snapshot = {
      format: REGISTRY_SNAPSHOT_FORMAT,
      publisher,
      siteDefinitions: [siteDef(definition('2026.11.1'))],
    };
    const verified = verifyRegistrySnapshot(snapshot, publisher);
    expect(verified.relayList).toBeUndefined();
    expect(verified.definitions).toHaveLength(1);
  });

  it('refuses a snapshot for another publisher', () => {
    const snapshot = { format: REGISTRY_SNAPSHOT_FORMAT, publisher, siteDefinitions: [] };
    expect(() => verifyRegistrySnapshot(snapshot, REGISTRY_PUBLISHER)).toThrow(/publisher/);
    expect(() => verifyRegistrySnapshot(null, publisher)).toThrow(/not an object/);
  });
});

describe('readRegistrySnapshot', () => {
  it('keeps what verifies and reports the rest', () => {
    const good = siteDef(definition('2026.11.1'));
    const tampered = { ...siteDef(definition('2026.11.1', 'b')), content: '{}' };
    const foreign = siteDef(definition('2026.11.1', 'c'), otherKey);
    const read = readRegistrySnapshot(
      {
        format: REGISTRY_SNAPSHOT_FORMAT,
        publisher,
        relayList: relayList([['wss://nos.lol']], otherKey),
        siteDefinitions: [good, tampered, foreign],
      },
      publisher
    );
    expect(read.definitions.map((d) => d.definition.id)).toEqual(['example']);
    expect(read.relayList).toBeUndefined();
    expect(read.rejected.map((r) => r.path)).toEqual([
      'relayList',
      'siteDefinitions[1]',
      'siteDefinitions[2]',
    ]);
  });

  it('keeps the newest version of a repeated site', () => {
    const read = readRegistrySnapshot(
      {
        format: REGISTRY_SNAPSHOT_FORMAT,
        publisher,
        siteDefinitions: [siteDef(definition('2026.11.2')), siteDef(definition('2026.11.10'))],
      },
      publisher
    );
    expect(read.definitions.map((d) => d.definition.version)).toEqual(['2026.11.10']);
    expect(read.rejected).toHaveLength(1);
  });

  it('yields nothing for the wrong format or publisher', () => {
    const base = { publisher, siteDefinitions: [siteDef(definition('2026.11.1'))] };
    expect(readRegistrySnapshot({ ...base, format: 'x' }, publisher).definitions).toEqual([]);
    const wrong = readRegistrySnapshot(
      { ...base, format: REGISTRY_SNAPSHOT_FORMAT },
      'f'.repeat(64)
    );
    expect(wrong.definitions).toEqual([]);
    expect(wrong.rejected).toEqual([{ path: 'publisher', reason: 'not the pinned key' }]);
  });
});

describe('registry events', () => {
  it('verifies a site definition and keeps unknown keys in its JSON', () => {
    const parsed = parseRegistrySiteDefinition(siteDef(definition('2026.11.1')), {
      publisherPubkey: publisher,
    });
    expect(parsed.ok && parsed.value.json.fields).toEqual(definition('2026.11.1').fields);
    expect(parsed.ok && parsed.value.definition.fields[0]).not.toHaveProperty('future');
  });

  it('refuses tampered content, the wrong author and a re-signed copy', () => {
    const opts = { publisherPubkey: publisher };
    const event = siteDef(definition('2026.11.1'));
    const tampered = { ...event, content: event.content.replace('280', '500') };
    expect(parseRegistrySiteDefinition(tampered, opts)).toMatchObject({
      ok: false,
      error: { code: 'bad_signature' },
    });
    expect(
      parseRegistrySiteDefinition(siteDef(definition('2026.11.1'), otherKey), opts)
    ).toMatchObject({ ok: false, error: { code: 'wrong_author' } });
    const resigned = { ...event, sig: siteDef(definition('2026.11.1'), otherKey).sig };
    expect(parseRegistrySiteDefinition(resigned, opts)).toMatchObject({
      ok: false,
      error: { code: 'bad_signature' },
    });
  });

  it('reads a relay list and its write relays', () => {
    const parsed = parseRegistryRelayList(
      relayList([['wss://a.example'], ['wss://b.example', 'read'], ['wss://c.example', 'write']]),
      { publisherPubkey: publisher }
    );
    expect(parsed.ok && parsed.value.writeRelays).toEqual(['wss://a.example', 'wss://c.example']);
    expect(
      parseRegistryRelayList(relayList([['https://a.example']]), { publisherPubkey: publisher }).ok
    ).toBe(false);
    expect(parseRegistryRelayList(relayList([]), { publisherPubkey: publisher }).ok).toBe(false);
  });

  it('replaces a definition only with a newer version', () => {
    const at = (version: string) => ({ definition: { version } }) as never;
    expect(isNewerSiteDefinition(at('2026.11.10'), at('2026.11.9'))).toBe(true);
    expect(isNewerSiteDefinition(at('2026.11.1'), at('2026.11.1'))).toBe(false);
    expect(isNewerSiteDefinition(at('2026.10.5'), at('2026.11.1'))).toBe(false);
    expect(isNewerSiteDefinition(at('2026.10.5'), undefined)).toBe(true);
  });
});

describe('fetchRegistry', () => {
  const BOOT = 'wss://boot.example';
  const WRITE = 'wss://write.example';

  async function seed(net: FakeRelayNetwork, url: string, events: NostrEvent[]): Promise<void> {
    const connection = await RelayConnection.open(url, { socket: net.socket });
    for (const event of events) await connection.publish(event);
    connection.close();
  }

  it('reads the relay list from the bootstrap relays, then definitions from its write relays', async () => {
    const net = new FakeRelayNetwork();
    net.add(BOOT);
    net.add(WRITE);
    await seed(net, BOOT, [
      relayList(
        [
          [WRITE, 'write'],
          [BOOT, 'read'],
        ],
        publisherKey,
        1_793_836_900
      ),
      // On the bootstrap relay only: not fetched, since it is no write relay.
      siteDef(definition('2026.12.1', 'boot-only')),
    ]);
    await seed(net, WRITE, [
      siteDef(definition('2026.11.1')),
      siteDef(definition('2026.11.2', 'second')),
      siteDef(definition('2026.11.3', 'foreign'), otherKey),
    ]);

    const result = await fetchRegistry({
      publisherPubkey: publisher,
      bootstrapRelays: [BOOT],
      socket: net.socket,
      timeoutMs: 500,
    });
    expect(result.relayList?.writeRelays).toEqual([WRITE]);
    expect(result.definitions.map((d) => d.definition.id).sort()).toEqual(['example', 'second']);
    expect(result.reached.sort()).toEqual([BOOT, WRITE]);
  });

  it('keeps the known relay list over an older fetched one', async () => {
    const net = new FakeRelayNetwork();
    net.add(BOOT);
    await seed(net, BOOT, [
      relayList([['wss://old.example']], publisherKey, 1_000),
      siteDef(definition('2026.11.1')),
    ]);
    const known = parseRegistryRelayList(relayList([[BOOT]], publisherKey, 2_000), {
      publisherPubkey: publisher,
    });
    if (!known.ok) throw new Error(known.error.message);
    const result = await fetchRegistry({
      publisherPubkey: publisher,
      bootstrapRelays: [BOOT],
      knownRelayList: known.value,
      socket: net.socket,
      timeoutMs: 500,
    });
    expect(result.relayList?.event.id).toBe(known.value.event.id);
    expect(result.definitions).toHaveLength(1);
  });

  it('reports no relay reached when none answers', async () => {
    const net = new FakeRelayNetwork();
    const result = await fetchRegistry({
      publisherPubkey: publisher,
      bootstrapRelays: [BOOT],
      socket: net.socket,
      timeoutMs: 200,
    });
    expect(result).toEqual({ definitions: [], rejected: 0, reached: [] });
  });
});
