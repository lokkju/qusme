import { bytesToHex } from '@noble/hashes/utils.js';
import {
  buildDraftWrap,
  compareSiteVersions,
  createLocalSigner,
  type Destination,
  type FieldValue,
  type JsonObject,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  parseDraftWrap,
  publishToAll,
  RelayConnection,
  sameAccount,
} from '@qusme/nostr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { arm, disarm, menuTitle, readArmed, readInsertionState } from '../src/insertion/armed.ts';
import {
  definitionForDraft,
  definitionSource,
  effectiveDefinition,
} from '../src/insertion/definitions.ts';
import {
  accountLocators,
  documentUrlPatterns,
  draftsForPage,
  matchesPattern,
} from '../src/insertion/matching.ts';
import { MENU_CHOOSE, MENU_INSERT, menuItem } from '../src/insertion/menu.ts';
import { PickerService, pickerText, readPickMessage } from '../src/insertion/picker.ts';
import type { PageInsertRequest, PageOutcome, PickerView } from '../src/insertion/protocol.ts';
import { InsertionService, readPageDone } from '../src/insertion/service.ts';
import {
  KeyStore,
  LOCAL_QUEUE,
  type QueueRecord,
  SESSION_ARMED,
  SESSION_INSERTION,
  SESSION_UNLOCKED,
} from '../src/keyStore.ts';
import { MemoryStorageArea } from '../src/storage.ts';
import { type CachedDraft, readDraftCache, writeDraftCache } from '../src/sync/state.ts';
import { network, STORAGE } from './helpers.ts';

/** X's definition in the shape of spec 10.1; the real one comes from the registry (#22). */
const X_DEFINITION: JsonObject = {
  id: 'x',
  version: '2026.10.1',
  name: 'X',
  match: ['https://x.com/*', 'https://twitter.com/*'],
  account: {
    locator: { role: 'button', name: { en: ['Account menu'] } },
    extract: '@([A-Za-z0-9_]{1,15})',
  },
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
      inject: ['paste', 'insertText', 'clipboard'],
      constraints: { maxLength: 280, counter: 'twitter-text' },
    },
  ],
};

/** Mastodon has no fixed hosts (10.1): each destination names its instance in the override. */
const MASTODON_DEFINITION: JsonObject = {
  id: 'mastodon',
  version: '2026.10.1',
  name: 'Mastodon',
  match: [],
  fields: [
    {
      name: 'text',
      label: 'Post',
      locators: [{ role: 'textbox', name: { en: ["What's on your mind?"] } }],
      inject: ['native', 'insertText', 'clipboard'],
    },
  ],
};

const source = definitionSource([X_DEFINITION, MASTODON_DEFINITION]);

const destination = (over: Partial<Destination>): Destination => ({
  id: 'dest-x',
  site: 'x',
  account: 'lokkju',
  label: 'X / lokkju',
  status: 'confirmed',
  override: null,
  ...over,
});

const DESTINATIONS: Destination[] = [
  destination({}),
  destination({ id: 'dest-x2', account: 'qusme', label: 'X / qusme' }),
  destination({
    id: 'dest-masto',
    site: 'mastodon',
    account: 'lokkju@mastodon.social',
    label: 'Mastodon',
    override: { match: ['https://mastodon.social/*'] },
  }),
  destination({
    id: 'dest-pending',
    site: 'bsky',
    account: 'a',
    status: 'pending',
    override: { match: ['https://bsky.app/*'] },
  }),
  destination({
    id: 'dest-custom',
    site: 'blog',
    account: 'me',
    override: { match: ['https://blog.example:8443/*'] },
  }),
];

const draft = (over: Partial<CachedDraft>): CachedDraft => ({
  d: 'd1',
  updatedAt: 1,
  site: 'x',
  account: 'lokkju',
  field: 'text',
  status: 'active',
  destination: 'dest-x',
  content: 'Hello from the queue',
  ...over,
});

describe('match patterns', () => {
  it.each([
    ['https://x.com/*', 'https://x.com/home', true],
    ['https://x.com/*', 'https://x.com/', true],
    ['https://x.com/*', 'http://x.com/home', false],
    ['https://x.com/*', 'https://api.x.com/home', false],
    ['*://x.com/*', 'http://x.com/a', true],
    ['https://*.example.com/*', 'https://example.com/a', true],
    ['https://*.example.com/*', 'https://a.b.example.com/a', true],
    ['https://*.example.com/*', 'https://badexample.com/a', false],
    ['https://*/*', 'https://anything.test/x', true],
    ['https://x.com/compose/*', 'https://x.com/compose/post?text=1', true],
    ['https://x.com/compose/*', 'https://x.com/home', false],
    ['https://x.com/*', 'not a url', false],
    ['nonsense', 'https://x.com/', false],
  ])('%s against %s is %s', (pattern, url, expected) => {
    expect(matchesPattern(pattern, url)).toBe(expected);
  });

  it('compares accounts without @ and case-blind', () => {
    expect(sameAccount('x', '@Lokkju', 'lokkju')).toBe(true);
    expect(sameAccount('x', 'lokkju', 'other')).toBe(false);
  });
});

describe('effective definitions (10.2)', () => {
  it('uses the official definition, the override merged over it, or neither', () => {
    expect(effectiveDefinition(source, 'x', null)?.fields[0]?.inject).toEqual([
      'paste',
      'insertText',
      'clipboard',
    ]);
    const overridden = effectiveDefinition(source, 'x', {
      fields: [{ name: 'text', inject: ['insertText', 'clipboard'] }],
    });
    expect(overridden?.fields[0]?.inject).toEqual(['insertText', 'clipboard']);
    expect(overridden?.fields[0]?.locators).toHaveLength(1);
    expect(
      effectiveDefinition(source, 'mastodon', { match: ['https://mastodon.social/*'] })?.match
    ).toEqual(['https://mastodon.social/*']);
    expect(effectiveDefinition(source, 'unknown', null)).toBeUndefined();
    // A custom destination's bare override is not a whole definition: the caller falls back.
    expect(
      effectiveDefinition(source, 'blog', { match: ['https://blog.example/*'] })
    ).toBeUndefined();
  });

  it('holds the X definition in the bundled snapshot', () => {
    const x = definitionSource().official('x');
    expect(x).toMatchObject({
      id: 'x',
      match: ['https://x.com/*', 'https://twitter.com/*'],
      fields: [{ name: 'text', constraints: { maxLength: 280, counter: 'twitter-text' } }],
    });
    const { version, fields } = x as { version: string; fields: { inject: string[] }[] };
    expect(compareSiteVersions(version, '2026.11.2')).toBeGreaterThanOrEqual(0);
    expect(fields[0]?.inject[0]).toBe('insertText');
    expect(definitionSource().official('mastodon')).toBeUndefined();
  });

  it('finds the draft field through its destination, by id or by site and account', () => {
    const byId = definitionForDraft(source, draft({}), DESTINATIONS);
    expect(byId.field?.name).toBe('text');
    expect(byId.definition?.account?.extract).toBe('@([A-Za-z0-9_]{1,15})');
    const bySite = definitionForDraft(
      source,
      draft({ site: 'mastodon', account: 'lokkju@mastodon.social', destination: undefined }),
      DESTINATIONS
    );
    expect(bySite.definition?.match).toEqual(['https://mastodon.social/*']);
    expect(
      definitionForDraft(source, draft({ field: 'nope' }), DESTINATIONS).field
    ).toBeUndefined();
    expect(
      definitionForDraft(source, draft({ site: 'blog', destination: 'dest-custom' }), DESTINATIONS)
    ).toEqual({});
  });
});

describe('drafts for the page (11.5 step 3)', () => {
  const drafts = [
    draft({ d: 'mine', updatedAt: 5 }),
    draft({ d: 'theirs', account: 'qusme', destination: 'dest-x2', updatedAt: 9 }),
    draft({ d: 'old', status: 'archived:inserted' }),
    draft({
      d: 'masto',
      site: 'mastodon',
      account: 'lokkju@mastodon.social',
      destination: 'dest-masto',
    }),
  ];

  it('keeps the detected account’s drafts and counts the others', () => {
    const page = draftsForPage({
      drafts,
      destinations: DESTINATIONS,
      source,
      url: 'https://x.com/home',
      detected: { x: '@Lokkju' },
    });
    expect(page.matching.map((p) => p.draft.d)).toEqual(['mine']);
    expect(page.otherAccounts).toBe(1);
    expect(page.elsewhere.map((p) => p.draft.d)).toEqual(['masto']);
    expect(page.matching[0]?.match).toEqual(['https://x.com/*', 'https://twitter.com/*']);
  });

  it('matches " @Lokkju " to lokkju, and tells case apart on a case-sensitive site', () => {
    const loose = draftsForPage({
      drafts: [draft({ d: 'mine' })],
      destinations: DESTINATIONS,
      source,
      url: 'https://x.com/home',
      detected: { x: ' @LOKKJU ' },
    });
    expect(loose.matching.map((p) => p.draft.d)).toEqual(['mine']);
    const strict = DESTINATIONS.map((d) =>
      d.id === 'dest-x' ? { ...d, override: { account: { caseSensitive: true } } } : d
    );
    const page = draftsForPage({
      drafts: [draft({ d: 'mine' })],
      destinations: strict,
      source,
      url: 'https://x.com/home',
      detected: { x: '@Lokkju' },
    });
    expect(page.matching).toEqual([]);
    expect(page.otherAccounts).toBe(1);
    const exact = draftsForPage({
      drafts: [draft({ d: 'mine' })],
      destinations: strict,
      source,
      url: 'https://x.com/home',
      detected: { x: '@lokkju' },
    });
    expect(exact.matching.map((p) => p.draft.d)).toEqual(['mine']);
  });

  it('finds a draft without a destination id by its normalized account', () => {
    const found = definitionForDraft(
      source,
      draft({ account: '@LOKKJU', destination: undefined }),
      [destination({ override: { name: 'X (mine)' } })]
    );
    expect(found.definition?.name).toBe('X (mine)');
  });

  it('shows every account at the site, newest first, when detection fails', () => {
    const page = draftsForPage({
      drafts,
      destinations: DESTINATIONS,
      source,
      url: 'https://x.com/home',
      detected: {},
    });
    expect(page.matching.map((p) => p.draft.d)).toEqual(['theirs', 'mine']);
    expect(page.otherAccounts).toBe(0);
  });

  it('matches a site with no fixed hosts through the destination override', () => {
    const page = draftsForPage({
      drafts,
      destinations: DESTINATIONS,
      source,
      url: 'https://mastodon.social/home',
      detected: {},
    });
    expect(page.matching.map((p) => p.draft.d)).toEqual(['masto']);
  });

  it('runs one account locator per matching site that has one', () => {
    const locators = accountLocators(drafts, DESTINATIONS, source, 'https://x.com/home');
    expect([...locators.keys()]).toEqual(['x']);
    expect(accountLocators(drafts, DESTINATIONS, source, 'https://mastodon.social/').size).toBe(0);
  });
});

describe('context menu (11.5 steps 4, 5)', () => {
  it('limits documentUrlPatterns to confirmed destinations, deduplicated, ports left out', () => {
    expect(documentUrlPatterns(DESTINATIONS, source)).toEqual([
      'https://mastodon.social/*',
      'https://twitter.com/*',
      'https://x.com/*',
    ]);
    expect(documentUrlPatterns([], source)).toEqual([]);
  });

  it('titles the item with the first 40 characters of the armed draft', () => {
    expect(menuTitle({ content: 'Short one' })).toBe('Insert: Short one');
    expect(menuTitle({ content: `${'a'.repeat(39)}\n\nbcdef` })).toBe(
      `Insert: ${'a'.repeat(39)} …`
    );
    expect(menuTitle({ content: '😀'.repeat(41) })).toBe(`Insert: ${'😀'.repeat(40)}…`);
    expect(menuTitle({ content: 'R&D at 50%s' }, { accessKeys: true })).toBe(
      'Insert: R&&D at 50%​s'
    );
    expect(menuTitle({ content: 'R&D' })).toBe('Insert: R&D');
    expect(menuTitle(undefined)).toBe('qus.me: choose a draft to insert…');
  });

  it('builds the insert item when armed, the choose item when not, and none without destinations', async () => {
    const session = new MemoryStorageArea();
    const armed = await arm(session, draft({}), 10);
    expect(menuItem({ armed, destinations: DESTINATIONS, definitions: source })).toEqual({
      id: MENU_INSERT,
      title: 'Insert: Hello from the queue',
      contexts: ['editable'],
      documentUrlPatterns: [
        'https://mastodon.social/*',
        'https://twitter.com/*',
        'https://x.com/*',
      ],
    });
    expect(
      menuItem({ armed: undefined, destinations: DESTINATIONS, definitions: source })?.id
    ).toBe(MENU_CHOOSE);
    expect(menuItem({ armed, destinations: [], definitions: source })).toBeUndefined();
  });
});

describe('arming (11.5 step 4)', () => {
  it('holds one armed draft in storage.session', async () => {
    const session = new MemoryStorageArea();
    expect(await readArmed(session)).toBeUndefined();
    await arm(session, draft({ d: 'a', content: 'first' }), 1);
    await arm(session, draft({ d: 'b', content: 'second' }), 2);
    expect(await readArmed(session)).toEqual({
      d: 'b',
      site: 'x',
      account: 'lokkju',
      field: 'text',
      destination: 'dest-x',
      content: 'second',
      armedAt: 2,
    });
    await disarm(session, 'a');
    expect((await readArmed(session))?.d).toBe('b');
    await disarm(session, 'b');
    expect(await readArmed(session)).toBeUndefined();
  });

  it('is deleted with the keys on lock', async () => {
    const local = new MemoryStorageArea();
    const session = new MemoryStorageArea();
    const store = new KeyStore({ local, session });
    await arm(session, draft({}), 1);
    await session.set({ [SESSION_INSERTION]: { unrecorded: [] } });
    await store.lock();
    expect(session.data.has(SESSION_ARMED)).toBe(false);
    expect(session.data.has(SESSION_INSERTION)).toBe(false);
  });
});

describe('page messages', () => {
  it('accepts only well-formed outcomes', () => {
    const inserted = {
      state: 'inserted',
      strategy: 'paste',
      resolution: 'locator',
      url: 'https://x.com/home',
      accessibleName: 'Post text',
      detectedAccount: 'lokkju',
    };
    expect(
      readPageDone({ type: 'qusme.insertion.done', token: 't', outcome: inserted })?.outcome
    ).toEqual(inserted);
    expect(
      readPageDone({
        type: 'qusme.insertion.done',
        token: 't',
        outcome: { ...inserted, strategy: 'evil' },
      })
    ).toBeUndefined();
    expect(
      readPageDone({
        type: 'qusme.insertion.done',
        token: 't',
        outcome: { state: 'failed', reason: 'timeout', tried: ['paste', 7] },
      })?.outcome
    ).toEqual({ state: 'failed', reason: 'timeout', tried: ['paste'] });
    expect(readPageDone({ type: 'other', token: 't', outcome: inserted })).toBeUndefined();
    expect(readPageDone(null)).toBeUndefined();
  });
});

/** An unlocked install with a draft on the storage relays and in its session cache. */
async function setup() {
  const net = network();
  const secretKey = generateSecretKey();
  const queue = createLocalSigner(secretKey);
  const pubkey = getPublicKey(secretKey);
  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const record: QueueRecord = {
    version: 1,
    pubkey,
    ncryptsec: 'ncryptsec1unused',
    storageRelays: STORAGE,
  };
  await local.set({ [LOCAL_QUEUE]: record });
  await session.set({ [SESSION_UNLOCKED]: { queue: bytesToHex(secretKey) } });
  const store = new KeyStore({ local, session });

  const value: FieldValue = {
    createdAt: 1761400000,
    site: 'x',
    account: 'lokkju',
    field: 'text',
    destination: 'dest-x',
    status: 'active',
    inserted: [
      {
        at: 1761300000,
        url: 'https://x.com/old',
        strategy: 'paste',
        method: 'pwa_copy',
        accessibleName: '',
        detectedAccount: '',
      },
    ],
    validation: { counter: 'twitter-text', length: 20, max: 280, ok: true },
    content: 'Hello from the queue',
    reserved: [],
    extraTags: [['newer-build', 'kept']],
  };
  const wrap = await buildDraftWrap(queue, {
    d: 'd1',
    draft: { type: 'field_value', value },
    createdAt: 1761400000,
  });
  const connections = await Promise.all(
    STORAGE.map((url) => RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 }))
  );
  await publishToAll(connections, wrap);
  for (const c of connections) c.close();
  await writeDraftCache(session, {
    queuePubkey: pubkey,
    syncedAt: 1,
    drafts: [draft({})],
    destinations: DESTINATIONS,
  });

  const requests: PageInsertRequest[] = [];
  let nextOutcome: PageOutcome = {
    state: 'inserted',
    strategy: 'paste',
    resolution: 'locator',
    accessibleName: 'Post text',
    detectedAccount: 'lokkju',
    url: 'https://x.com/home',
  };
  const service = new InsertionService({
    store,
    definitions: source,
    socket: net.socket,
    relayTimeoutMs: 500,
    now: () => 1761500000,
    token: () => 'token-1',
    page: {
      insert: async (_target, request) => {
        requests.push(request);
        return nextOutcome;
      },
    },
  });
  const latest = async (url = STORAGE[0] as string) => {
    const events = net.get(url).events.filter((e: NostrEvent) => e.kind === KIND_DRAFT_WRAP);
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    const parsed = await parseDraftWrap(newest, queue);
    if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value')
      throw new Error('no draft');
    return parsed.value;
  };
  return {
    net,
    store,
    session,
    service,
    requests,
    latest,
    setOutcome: (o: PageOutcome) => {
      nextOutcome = o;
    },
  };
}

describe('insertion service (11.5 steps 5, 6)', () => {
  it('sends only the armed value and the field to the page, then records, archives and disarms', async () => {
    const t = await setup();
    await arm(t.session, draft({}), 1);
    const result = await t.service.insert({ tabId: 7, method: 'extension_popup' });
    expect(result).toEqual({ state: 'inserted', strategy: 'paste', recorded: true });
    expect(t.requests).toEqual([
      {
        token: 'token-1',
        value: 'Hello from the queue',
        method: 'extension_popup',
        clipboardFallback: true,
        field: {
          locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
          inject: ['paste', 'insertText', 'clipboard'],
        },
        account: {
          locator: { role: 'button', name: { en: ['Account menu'] } },
          extract: '@([A-Za-z0-9_]{1,15})',
        },
      },
    ]);
    for (const url of STORAGE) {
      const wrap = await t.latest(url);
      expect(wrap.createdAt).toBe(1761500000);
      if (wrap.draft.type !== 'field_value') throw new Error('not a field value');
      const v = wrap.draft.value;
      expect(v.status).toBe('archived:inserted');
      expect(v.inserted).toEqual([
        {
          at: 1761300000,
          url: 'https://x.com/old',
          strategy: 'paste',
          method: 'pwa_copy',
          accessibleName: '',
          detectedAccount: '',
        },
        {
          at: 1761500000,
          url: 'https://x.com/home',
          strategy: 'paste',
          method: 'extension_popup',
          accessibleName: 'Post text',
          detectedAccount: 'lokkju',
        },
      ]);
      expect(v.validation).toEqual({ counter: 'twitter-text', length: 20, max: 280, ok: true });
      expect(v.extraTags).toEqual([['newer-build', 'kept']]);
      expect(v.content).toBe('Hello from the queue');
    }
    expect(await readArmed(t.session)).toBeUndefined();
    expect((await readDraftCache(t.session))?.drafts[0]?.status).toBe('archived:inserted');
    expect((await readInsertionState(t.session)).pending).toBeUndefined();
  });

  it('passes no field for a destination without a definition, and the context menu gets no clipboard fallback', async () => {
    const t = await setup();
    await arm(t.session, draft({ site: 'blog', destination: 'dest-custom' }), 1);
    await t.service.insert({ tabId: 7, frameId: 3, method: 'extension_context_menu' });
    expect(t.requests[0]?.field).toBeUndefined();
    expect(t.requests[0]?.account).toBeUndefined();
    expect(t.requests[0]?.clipboardFallback).toBe(false);
  });

  it('finishes a waiting insertion only on the pending token from the same tab', async () => {
    const t = await setup();
    await arm(t.session, draft({}), 1);
    t.setOutcome({ state: 'waiting', reason: 'paste', clipboardWritten: false });
    expect(await t.service.insert({ tabId: 7, method: 'extension_popup' })).toEqual({
      state: 'waiting',
      reason: 'paste',
      clipboardWritten: false,
    });
    expect((await readInsertionState(t.session)).pending).toMatchObject({
      token: 'token-1',
      tabId: 7,
      d: 'd1',
    });
    const outcome = {
      state: 'inserted' as const,
      strategy: 'clipboard' as const,
      resolution: 'locator' as const,
      accessibleName: 'Post text',
      detectedAccount: '',
      url: 'https://x.com/home',
    };
    expect(
      await t.service.pageDone(8, { type: 'qusme.insertion.done', token: 'token-1', outcome })
    ).toBeUndefined();
    expect(
      await t.service.pageDone(7, { type: 'qusme.insertion.done', token: 'other', outcome })
    ).toBeUndefined();
    expect(await readArmed(t.session)).toBeDefined();
    expect(
      await t.service.pageDone(7, { type: 'qusme.insertion.done', token: 'token-1', outcome })
    ).toEqual({
      state: 'inserted',
      strategy: 'clipboard',
      recorded: true,
    });
    const wrap = await t.latest();
    if (wrap.draft.type !== 'field_value') throw new Error('not a field value');
    expect(wrap.draft.value.inserted.at(-1)).toMatchObject({
      strategy: 'clipboard',
      method: 'extension_popup',
    });
    expect(await readArmed(t.session)).toBeUndefined();
  });

  it('keeps the draft armed when the page fails', async () => {
    const t = await setup();
    await arm(t.session, draft({}), 1);
    t.setOutcome({ state: 'failed', reason: 'exhausted', tried: ['paste', 'insertText'] });
    expect(await t.service.insert({ tabId: 7, method: 'extension_popup' })).toEqual({
      state: 'failed',
      reason: 'exhausted',
    });
    expect(await readArmed(t.session)).toBeDefined();
    expect((await t.latest()).draft).toMatchObject({ value: { status: 'active' } });
  });

  it('reports injection errors, nothing armed, and a locked queue', async () => {
    const t = await setup();
    expect(await t.service.insert({ tabId: 7, method: 'extension_popup' })).toEqual({
      state: 'not_armed',
    });
    await arm(t.session, draft({}), 1);
    const failing = new InsertionService({
      ...t.service.deps,
      page: { insert: async () => Promise.reject(new Error('Cannot access contents of the page')) },
    });
    expect(await failing.insert({ tabId: 7, method: 'extension_popup' })).toMatchObject({
      state: 'failed',
      reason: 'injection',
      message: 'qus.me could not run in this page: Cannot access contents of the page',
    });
    await t.store.lock();
    expect(await t.service.insert({ tabId: 7, method: 'extension_popup' })).toEqual({
      state: 'locked',
    });
  });

  it('keeps an insertion it could not publish and records it on retry', async () => {
    const t = await setup();
    await arm(t.session, draft({}), 1);
    for (const url of STORAGE) t.net.get(url).options.refuseKinds = [KIND_DRAFT_WRAP];
    const result = await t.service.insert({ tabId: 7, method: 'extension_context_menu' });
    expect(result).toMatchObject({ state: 'inserted', recorded: false });
    expect(await readArmed(t.session)).toBeUndefined();
    expect((await readInsertionState(t.session)).unrecorded).toHaveLength(1);
    expect((await t.latest()).draft).toMatchObject({ value: { status: 'active' } });

    for (const url of STORAGE) t.net.get(url).options.refuseKinds = [];
    expect(await t.service.retryUnrecorded()).toEqual({ remaining: 0, messages: [] });
    expect((await readInsertionState(t.session)).unrecorded).toEqual([]);
    const wrap = await t.latest();
    if (wrap.draft.type !== 'field_value') throw new Error('not a field value');
    expect(wrap.draft.value.status).toBe('archived:inserted');
    expect(wrap.draft.value.inserted.at(-1)?.method).toBe('extension_context_menu');
  });
});

describe('popup one-click insert (11.5)', () => {
  it('inserts the chosen draft without arming it and records the popup method', async () => {
    const t = await setup();
    const result = await t.service.insertChosen(7, 'd1');
    expect(result).toEqual({ state: 'inserted', strategy: 'paste', recorded: true });
    expect(t.requests[0]).toMatchObject({
      value: 'Hello from the queue',
      method: 'extension_popup',
      clipboardFallback: true,
    });
    const wrap = await t.latest();
    if (wrap.draft.type !== 'field_value') throw new Error('not a field value');
    expect(wrap.draft.value.status).toBe('archived:inserted');
    expect(wrap.draft.value.inserted.at(-1)?.method).toBe('extension_popup');
    expect(await readArmed(t.session)).toBeUndefined();
  });

  it('arms nothing when the page fails, and leaves another armed draft armed', async () => {
    const t = await setup();
    t.setOutcome({ state: 'failed', reason: 'exhausted', tried: ['paste'] });
    expect(await t.service.insertChosen(7, 'd1')).toEqual({ state: 'failed', reason: 'exhausted' });
    expect(await readArmed(t.session)).toBeUndefined();
    await arm(t.session, draft({ d: 'other', content: 'armed for right-click' }), 1);
    expect(await t.service.insertChosen(7, 'd1')).toMatchObject({ state: 'failed' });
    expect((await readArmed(t.session))?.d).toBe('other');
    expect((await t.latest()).draft).toMatchObject({ value: { status: 'active' } });
  });

  it('finishes a waiting popup insertion on its own draft without touching the armed one', async () => {
    const t = await setup();
    await arm(t.session, draft({ d: 'other', content: 'armed for right-click' }), 1);
    t.setOutcome({ state: 'waiting', reason: 'focus' });
    expect(await t.service.insertChosen(7, 'd1')).toEqual({ state: 'waiting', reason: 'focus' });
    expect(
      await t.service.pageDone(7, {
        type: 'qusme.insertion.done',
        token: 'token-1',
        outcome: {
          state: 'inserted',
          strategy: 'paste',
          resolution: 'focus_placement',
          accessibleName: 'Post text',
          detectedAccount: '',
          url: 'https://x.com/home',
        },
      })
    ).toMatchObject({ state: 'inserted', recorded: true });
    const wrap = await t.latest();
    if (wrap.draft.type !== 'field_value') throw new Error('not a field value');
    expect(wrap.draft.value.inserted.at(-1)?.method).toBe('extension_popup');
    expect((await readArmed(t.session))?.d).toBe('other');
  });

  it('refuses a draft that is gone, and a locked queue', async () => {
    const t = await setup();
    expect(await t.service.insertChosen(7, 'missing')).toEqual({ state: 'not_found' });
    expect(t.requests).toEqual([]);
    await t.store.lock();
    expect(await t.service.insertChosen(7, 'd1')).toEqual({ state: 'locked' });
  });
});

describe('keyboard picker (11.5)', () => {
  async function pickerSetup(options: { detected?: string } = {}) {
    const t = await setup();
    await writeDraftCache(t.session, {
      queuePubkey: 'unused',
      syncedAt: 1,
      drafts: [
        draft({}),
        draft({ d: 'd2', account: 'qusme', destination: 'dest-x2', content: 'Other account' }),
        draft({
          d: 'd3',
          site: 'mastodon',
          account: 'lokkju@mastodon.social',
          destination: 'dest-masto',
          content: 'For Mastodon',
          updatedAt: 5,
          source: { wrapId: 'w', submitter: 'abcdef0123456789', label: 'Claude' },
        }),
        draft({ d: 'd4', status: 'archived:inserted', content: 'Already posted' }),
      ],
      destinations: DESTINATIONS,
    });
    const opened: PickerView[] = [];
    const detections: number[] = [];
    const picker = new PickerService({
      store: t.store,
      definitions: source,
      insertion: t.service,
      token: () => 'pick-token',
      page: {
        detectAccounts: async (tabId, locators) => {
          detections.push(tabId);
          return locators.map(() => options.detected);
        },
        open: async (_tabId, view) => {
          opened.push(view);
        },
      },
    });
    return { ...t, picker, opened, detections };
  }

  it('lists this page’s drafts for the detected account first, then the rest, as text only', async () => {
    const t = await pickerSetup({ detected: '@lokkju' });
    expect(await t.picker.open({ id: 7, url: 'https://x.com/home' })).toBe('ready');
    expect(t.detections).toEqual([7]);
    expect(t.opened).toEqual([
      {
        token: 'pick-token',
        state: 'ready',
        here: [{ d: 'd1', text: 'Hello from the queue', meta: 'X · text' }],
        others: [
          {
            d: 'd3',
            text: 'For Mastodon',
            meta: 'Mastodon as lokkju@mastodon.social · text · from Claude',
          },
        ],
        context: 'X as lokkju',
      },
    ]);
  });

  it('labels each account when detection finds none', async () => {
    const t = await pickerSetup();
    await t.picker.open({ id: 7, url: 'https://x.com/home' });
    expect(t.opened[0]?.here.map((i) => [i.d, i.meta])).toEqual([
      ['d1', 'X as lokkju · text'],
      ['d2', 'X as qusme · text'],
    ]);
    expect(t.opened[0]?.context).toBe('');
  });

  it('inserts the picked draft through the pipeline with method extension_shortcut', async () => {
    const t = await pickerSetup({ detected: 'lokkju' });
    await arm(t.session, draft({ d: 'd2', account: 'qusme', destination: 'dest-x2' }), 1);
    await t.picker.open({ id: 7, url: 'https://x.com/home' });
    const result = await t.picker.pick(7, 0, {
      type: 'qusme.picker.pick',
      token: 'pick-token',
      d: 'd1',
    });
    expect(result).toEqual({ state: 'inserted', strategy: 'paste', recorded: true });
    expect(t.requests).toEqual([
      expect.objectContaining({
        value: 'Hello from the queue',
        method: 'extension_shortcut',
        clipboardFallback: false,
      }),
    ]);
    const wrap = await t.latest();
    if (wrap.draft.type !== 'field_value') throw new Error('not a field value');
    expect(wrap.draft.value.status).toBe('archived:inserted');
    expect(wrap.draft.value.inserted.at(-1)).toMatchObject({
      method: 'extension_shortcut',
      strategy: 'paste',
    });
    // The draft armed in the popup stays armed; the picker never armed its own.
    expect((await readArmed(t.session))?.d).toBe('d2');
  });

  it('refuses a stale token, another tab, an unlisted or gone draft, and a replayed pick', async () => {
    const t = await pickerSetup({ detected: 'lokkju' });
    await t.picker.open({ id: 7, url: 'https://x.com/home' });
    const pick = (d: string, token = 'pick-token') =>
      ({ type: 'qusme.picker.pick', token, d }) as const;
    expect(await t.picker.pick(7, 0, pick('d1', 'old'))).toEqual({ state: 'expired' });
    expect(await t.picker.pick(8, 0, pick('d1'))).toEqual({ state: 'expired' });
    expect(await t.picker.pick(7, 0, pick('d4'))).toEqual({ state: 'expired' });
    expect(t.requests).toEqual([]);

    const cache = await readDraftCache(t.session);
    if (cache === undefined) throw new Error('no cache');
    await writeDraftCache(t.session, {
      ...cache,
      drafts: cache.drafts.filter((d) => d.d !== 'd1'),
    });
    expect(await t.picker.pick(7, 0, pick('d1'))).toEqual({ state: 'not_found' });
    expect(await t.picker.pick(7, 0, pick('d1'))).toEqual({ state: 'expired' });
    expect(t.requests).toEqual([]);
  });

  it('opens in the locked state without reading drafts, and says when there is no queue', async () => {
    const t = await pickerSetup();
    await t.store.lock();
    expect(await t.picker.open({ id: 7, url: 'https://x.com/home' })).toBe('locked');
    expect(t.opened[0]).toEqual({
      token: 'pick-token',
      state: 'locked',
      here: [],
      others: [],
      context: '',
    });
    expect(t.detections).toEqual([]);

    const empty = new PickerService({
      ...t.picker.deps,
      store: new KeyStore({ local: new MemoryStorageArea(), session: new MemoryStorageArea() }),
    });
    expect((await empty.view({ id: 7, url: 'https://x.com/home' })).state).toBe('setup');
  });

  it('reads only well-formed pick messages and cuts long drafts', () => {
    expect(readPickMessage({ type: 'qusme.picker.pick', token: 't', d: 'd1' })).toEqual({
      type: 'qusme.picker.pick',
      token: 't',
      d: 'd1',
    });
    expect(readPickMessage({ type: 'qusme.picker.pick', token: 't' })).toBeUndefined();
    expect(readPickMessage('qusme.picker.pick')).toBeUndefined();
    expect(pickerText('a  b\tc')).toBe('a b c');
    expect([...pickerText('x'.repeat(400))]).toHaveLength(281);
  });
});
