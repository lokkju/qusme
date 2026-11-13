import { bytesToHex } from '@noble/hashes/utils.js';
import {
  createLocalSigner,
  type Destination,
  type JsonObject,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  parseDraftWrap,
} from '@qusme/nostr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { rowData } from '../src/drafts/row.ts';
import { definitionSource } from '../src/insertion/definitions.ts';
import { MENU_SAVE, SAVE_TITLE, saveMenuItem } from '../src/insertion/menu.ts';
import type { NoticeKind, PageReadRequest, PageReadResult } from '../src/insertion/protocol.ts';
import { type SavePage, SaveService, saveFromMenu, saveNotice } from '../src/insertion/save.ts';
import { KeyStore, LOCAL_QUEUE, type QueueRecord, SESSION_UNLOCKED } from '../src/keyStore.ts';
import { MemoryStorageArea } from '../src/storage.ts';
import { type CachedDraft, readDraftCache, writeDraftCache } from '../src/sync/state.ts';
import { network, STORAGE } from './helpers.ts';

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

/** LinkedIn has no account locator. */
const LINKEDIN_DEFINITION: JsonObject = {
  id: 'linkedin',
  version: '2026.10.1',
  name: 'LinkedIn',
  match: ['https://www.linkedin.com/*'],
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Text editor for creating content'] } }],
      inject: ['insertText', 'paste', 'clipboard'],
      constraints: { maxLength: 3000, counter: 'default' },
    },
  ],
};

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

const source = definitionSource([X_DEFINITION, LINKEDIN_DEFINITION, MASTODON_DEFINITION]);

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
    site: 'linkedin',
    account: 'someone',
    status: 'pending',
  }),
];

const X_LOCATORS = (X_DEFINITION.fields as JsonObject[])[0]?.locators;

interface Call {
  kind: 'detect' | 'read' | 'notice';
  target?: { tabId: number; frameId?: number };
  request?: PageReadRequest;
  text?: string;
  noticeKind?: NoticeKind;
}

/** An unlocked install with destinations in its session cache and a scripted page. */
async function setup(
  options: {
    destinations?: Destination[];
    detected?: (string | undefined)[];
    read?: PageReadResult;
    locked?: boolean;
    empty?: boolean;
    drafts?: CachedDraft[];
  } = {}
) {
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
  if (!options.empty) await local.set({ [LOCAL_QUEUE]: record });
  if (!options.locked && !options.empty)
    await session.set({ [SESSION_UNLOCKED]: { queue: bytesToHex(secretKey) } });
  const store = new KeyStore({ local, session });
  if (!options.locked && !options.empty) {
    await writeDraftCache(session, {
      queuePubkey: pubkey,
      syncedAt: 1,
      drafts: options.drafts ?? [],
      destinations: options.destinations ?? DESTINATIONS,
    });
  }

  const calls: Call[] = [];
  const page: SavePage = {
    detectAccounts: async (tabId) => {
      calls.push({ kind: 'detect', target: { tabId } });
      return options.detected ?? [];
    },
    readField: async (target, request) => {
      calls.push({ kind: 'read', target, request });
      return options.read ?? { state: 'read', field: 'text', value: 'Saved from the composer' };
    },
    notice: async (target, text, kind) => {
      calls.push({ kind: 'notice', target, text, noticeKind: kind });
    },
  };
  const service = new SaveService({
    store,
    definitions: source,
    socket: net.socket,
    relayTimeoutMs: 500,
    now: () => 1761600000,
    draftId: () => 'aaaabbbbccccddddeeeeffff00001111',
    page,
  });
  const wraps = (url = STORAGE[0] as string) =>
    net.get(url).events.filter((e: NostrEvent) => e.kind === KIND_DRAFT_WRAP);
  const notices = () => calls.filter((c) => c.kind === 'notice').map((c) => c.text);
  return { net, queue, pubkey, store, session, service, calls, wraps, notices };
}

describe('saving a field as a draft (11.7)', () => {
  it('publishes an active draft wrap for the destination to every storage relay, attributed to You', async () => {
    const t = await setup({ detected: ['lokkju'] });
    const result = await t.service.save({ tabId: 3, url: 'https://x.com/home' });
    expect(result).toEqual({
      state: 'saved',
      d: 'aaaabbbbccccddddeeeeffff00001111',
      destination: 'dest-x',
      field: 'text',
      over: false,
    });
    for (const url of STORAGE) {
      const [wrap] = t.wraps(url);
      if (wrap === undefined) throw new Error(`no draft on ${url}`);
      expect(wrap.created_at).toBe(1761600000);
      const parsed = await parseDraftWrap(wrap, t.queue);
      if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value')
        throw new Error('not a field value');
      expect(parsed.value.d).toBe('aaaabbbbccccddddeeeeffff00001111');
      const v = parsed.value.draft.value;
      expect(v).toMatchObject({
        site: 'x',
        account: 'lokkju',
        field: 'text',
        destination: 'dest-x',
        status: 'active',
        inserted: [],
        content: 'Saved from the composer',
      });
      expect(v.source).toBeUndefined();
      expect(v.validation).toEqual({ counter: 'twitter-text', length: 23, max: 280, ok: true });
      // Encrypted: nothing about the destination or the text is visible to the relay.
      expect(wrap.content).not.toContain('Saved from the composer');
      expect(wrap.content).not.toContain('lokkju');
    }
    const cached = (await readDraftCache(t.session))?.drafts;
    expect(cached).toEqual([
      {
        d: 'aaaabbbbccccddddeeeeffff00001111',
        updatedAt: 1761600000,
        site: 'x',
        account: 'lokkju',
        field: 'text',
        status: 'active',
        destination: 'dest-x',
        content: 'Saved from the composer',
      },
    ]);
    const row = rowData(cached?.[0] as CachedDraft, {
      source,
      destinations: DESTINATIONS,
      now: 1761600000,
      showDestination: false,
      text: 'Saved from the composer',
    });
    expect(row.meta.who).toBe('You');
    expect(t.notices()).toEqual(['qus.me: saved.']);
  });

  it('sends the page only the definition’s field locators, and never the text back', async () => {
    const t = await setup({ detected: ['qusme'] });
    await t.service.save({ tabId: 3, frameId: 5, url: 'https://x.com/compose/post' });
    const read = t.calls.find((c) => c.kind === 'read');
    expect(read?.target).toEqual({ tabId: 3, frameId: 5 });
    expect(read?.request).toEqual({ fields: [{ name: 'text', locators: X_LOCATORS }] });
    const notice = t.calls.find((c) => c.kind === 'notice');
    expect(notice?.target).toEqual({ tabId: 3, frameId: 5 });
    expect(notice?.text).not.toContain('Saved from the composer');
    const [wrap] = t.wraps();
    const parsed = await parseDraftWrap(wrap as NostrEvent, t.queue);
    if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value')
      throw new Error('not a field value');
    expect(parsed.value.draft.value.destination).toBe('dest-x2');
  });

  it('records a length over the field’s maxLength in the validation tag and says so', async () => {
    const long = 'a'.repeat(300);
    const t = await setup({
      detected: ['lokkju'],
      read: { state: 'read', field: 'text', value: long },
    });
    const result = await t.service.save({ tabId: 3, url: 'https://x.com/home' });
    expect(result).toMatchObject({ state: 'saved', over: true });
    const parsed = await parseDraftWrap(t.wraps()[0] as NostrEvent, t.queue);
    if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value')
      throw new Error('not a field value');
    expect(parsed.value.draft.value.validation).toMatchObject({
      counter: 'twitter-text',
      length: 300,
      max: 280,
      ok: false,
    });
    expect(t.notices()).toEqual([
      "qus.me: saved. It's over this field's limit; edit it before posting.",
    ]);
  });

  it('uses the one destination on a page without an account locator, and on a page where detection fails', async () => {
    const masto = await setup();
    const result = await masto.service.save({ tabId: 1, url: 'https://mastodon.social/home' });
    expect(result).toMatchObject({ state: 'saved', destination: 'dest-masto' });
    const parsed = await parseDraftWrap(masto.wraps()[0] as NostrEvent, masto.queue);
    if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value')
      throw new Error('not a field value');
    // No constraints on the field: an empty constraint set still describes the text.
    expect(parsed.value.draft.value.validation).toEqual({
      counter: 'default',
      length: 23,
      ok: true,
    });

    const single = await setup({ destinations: [destination({})] });
    expect(await single.service.save({ tabId: 1, url: 'https://x.com/home' })).toMatchObject({
      state: 'saved',
      destination: 'dest-x',
    });
  });

  it('refuses a page with several matching destinations it cannot tell apart', async () => {
    const t = await setup({ detected: [undefined] });
    expect(await t.service.save({ tabId: 1, url: 'https://x.com/home' })).toEqual({
      state: 'refused',
      reason: 'ambiguous',
    });
    expect(t.wraps()).toEqual([]);
    expect(t.calls.some((c) => c.kind === 'read')).toBe(false);
    expect(t.notices()).toEqual([
      "qus.me couldn't tell which of your accounts this page is signed in to. Nothing was saved.",
    ]);
  });

  it('refuses a page signed in as an account that is not a destination', async () => {
    const t = await setup({ detected: ['@someoneelse'] });
    expect(await t.service.save({ tabId: 1, url: 'https://x.com/home' })).toEqual({
      state: 'refused',
      reason: 'other_account',
      account: 'someoneelse',
    });
    expect(t.notices()).toEqual([
      "qus.me: this page is signed in as @someoneelse, which isn't one of your destinations.",
    ]);
    expect(t.wraps()).toEqual([]);
  });

  it('refuses a supported site with no confirmed destination, and a page no definition matches', async () => {
    const t = await setup();
    // LinkedIn's only destination is still pending.
    expect(await t.service.save({ tabId: 1, url: 'https://www.linkedin.com/feed/' })).toEqual({
      state: 'refused',
      reason: 'no_destination',
    });
    expect(await t.service.save({ tabId: 1, url: 'https://blog.example/new' })).toEqual({
      state: 'refused',
      reason: 'no_definition',
    });
    expect(t.notices()).toEqual([
      "qus.me: this page isn't one of your destinations. Add it in qus.me, then save again.",
      "qus.me doesn't know this site's fields, so it can't save from here.",
    ]);
    expect(t.wraps()).toEqual([]);
  });

  it('refuses a field the definition does not name, no field at all, empty text and text over 32 KiB', async () => {
    const cases: [PageReadResult, string, string][] = [
      [
        { state: 'no_field' },
        'no_field',
        "qus.me: this isn't a field qus.me knows on this site. Click into the post box and save again.",
      ],
      [{ state: 'no_target' }, 'no_target', 'qus.me: click into the post box, then save again.'],
      [
        { state: 'read', field: 'text', value: '   ' },
        'empty',
        'qus.me: the field is empty. Nothing was saved.',
      ],
      [
        { state: 'read', field: 'text', value: 'é'.repeat(16_385) },
        'too_long',
        'qus.me: a draft holds at most 32768 bytes, and this field has more.',
      ],
    ];
    for (const [read, reason, notice] of cases) {
      const t = await setup({ detected: ['lokkju'], read });
      expect(await t.service.save({ tabId: 1, url: 'https://x.com/home' })).toEqual({
        state: 'refused',
        reason,
      });
      expect(t.notices()).toEqual([notice]);
      expect(t.wraps()).toEqual([]);
    }
  });

  it('says when the queue is locked or not set up, without reading the page', async () => {
    const locked = await setup({ locked: true });
    expect(await locked.service.save({ tabId: 1, url: 'https://x.com/home' })).toEqual({
      state: 'locked',
    });
    expect(locked.calls.map((c) => c.kind)).toEqual(['notice']);
    expect(locked.notices()).toEqual([
      'qus.me is locked. Open qus.me to unlock it, then save again.',
    ]);
    const empty = await setup({ empty: true });
    expect(await empty.service.save({ tabId: 1, url: 'https://x.com/home' })).toEqual({
      state: 'setup',
    });
    expect(empty.calls.map((c) => c.kind)).toEqual(['notice']);
  });

  it('reports a storage relay that refuses the draft, and keeps it out of the cache', async () => {
    const t = await setup({ detected: ['lokkju'] });
    t.net.get(STORAGE[1] as string).options.refuseKinds = [KIND_DRAFT_WRAP];
    const result = await t.service.save({ tabId: 1, url: 'https://x.com/home' });
    expect(result.state).toBe('failed');
    expect(t.notices()[0]).toMatch(/^qus\.me couldn't save the draft: The draft was not saved/);
    expect((await readDraftCache(t.session))?.drafts).toEqual([]);
  });

  it('gives every outcome a notice', () => {
    expect(saveNotice({ state: 'failed', message: 'x' })).toEqual({
      text: "qus.me couldn't save the draft: x",
      kind: 'failure',
    });
    expect(
      saveNotice({ state: 'saved', d: 'd', destination: 'x', field: 'text', over: false })
    ).toEqual({ text: 'qus.me: saved.', kind: 'success' });
  });
});

describe('the Save to qus.me menu item (11.7)', () => {
  it('appears on editable fields on destination pages and every registry site, even with no destinations', () => {
    expect(saveMenuItem({ destinations: DESTINATIONS, definitions: source })).toEqual({
      id: MENU_SAVE,
      title: SAVE_TITLE,
      contexts: ['editable'],
      documentUrlPatterns: [
        'https://mastodon.social/*',
        'https://twitter.com/*',
        'https://www.linkedin.com/*',
        'https://x.com/*',
      ],
    });
    expect(saveMenuItem({ destinations: [], definitions: source })?.documentUrlPatterns).toEqual([
      'https://twitter.com/*',
      'https://www.linkedin.com/*',
      'https://x.com/*',
    ]);
    expect(saveMenuItem({ destinations: [], definitions: definitionSource([]) })).toBeUndefined();
  });

  it('saves from the clicked tab and frame, with the tab URL or the menu’s pageUrl', async () => {
    const seen: unknown[] = [];
    const saver = {
      save: async (input: unknown) => {
        seen.push(input);
        return { state: 'locked' } as const;
      },
    };
    await saveFromMenu(saver, { frameId: 2, pageUrl: 'https://x.com/a' }, { id: 9 });
    await saveFromMenu(saver, { frameId: 0 }, { id: 9, url: 'https://x.com/b' });
    expect(saveFromMenu(saver, {}, undefined)).toBeUndefined();
    expect(saveFromMenu(saver, {}, { id: 9, url: 'chrome://extensions' })).toBeUndefined();
    expect(seen).toEqual([
      { tabId: 9, frameId: 2, url: 'https://x.com/a' },
      { tabId: 9, frameId: 0, url: 'https://x.com/b' },
    ]);
  });

  it('runs through the service end to end from a menu click', async () => {
    const t = await setup({ detected: ['lokkju'] });
    const result = await saveFromMenu(
      t.service,
      { frameId: 0 },
      { id: 4, url: 'https://x.com/home' }
    );
    expect(result).toMatchObject({ state: 'saved', destination: 'dest-x' });
    expect(t.wraps()).toHaveLength(1);
    expect(t.notices()).toEqual(['qus.me: saved.']);
  });
});
