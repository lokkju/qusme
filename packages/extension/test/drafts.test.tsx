/**
 * Editing, dismissing and restoring drafts (spec 7.1, 11.5) against the fake storage relays, the
 * archive view and the draft list's controls, and the agents view's per-agent counts (11.4).
 */
import {
  buildDraftWrap,
  type FieldValue,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  parseDraftWrap,
} from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { countsInPeriod } from '../src/agents/view.ts';
import { dismissDraft, editDraft, restoreDraft } from '../src/drafts/manage.ts';
import { arm, readArmed } from '../src/insertion/armed.ts';
import { definitionSource } from '../src/insertion/definitions.ts';
import type { QueueRecord } from '../src/keyStore.ts';
import { type CachedDraft, readDraftCache, writeDraftCache } from '../src/sync/state.ts';
import { ArchiveList, archivedDrafts } from '../src/ui/archive.tsx';
import { SyncNote } from '../src/ui/drafts.tsx';
import { InsertView } from '../src/ui/insert.tsx';
import { destinationsQueue, STORAGE } from './helpers.ts';

type Queue = Awaited<ReturnType<typeof destinationsQueue>>;

const INSERTION = {
  at: 1_700_000_100,
  url: 'https://x.com/home',
  strategy: 'insertText',
  method: 'extension_popup',
  accessibleName: 'Post text',
  detectedAccount: 'alt',
};

const value = (over: Partial<FieldValue> = {}): FieldValue => ({
  createdAt: 1_700_000_000,
  site: 'x',
  account: 'alt',
  field: 'text',
  status: 'active',
  inserted: [],
  content: 'the original text',
  reserved: [['target', 'https://x.com/a/status/1']],
  extraTags: [['future', 'kept']],
  ...over,
});

/** Publishes a draft wrap and caches it as the sync would. */
async function seed(q: Queue, d: string, over: Partial<FieldValue> = {}) {
  const v = value(over);
  const event = await buildDraftWrap(q.queue, {
    d,
    draft: { type: 'field_value', value: v },
    createdAt: 1_700_000_000,
  });
  await q.publish(event);
  const cache = (await readDraftCache(q.session)) ?? {
    queuePubkey: q.pubkey,
    syncedAt: 1,
    drafts: [],
  };
  const cached: CachedDraft = {
    d,
    updatedAt: event.created_at,
    site: v.site,
    account: v.account,
    field: v.field,
    status: v.status,
    content: v.content,
  };
  await writeDraftCache(q.session, { ...cache, drafts: [...cache.drafts, cached] });
  return cached;
}

/** The newest version of `d` on each storage relay, decrypted. */
async function onRelays(q: Queue, d: string): Promise<FieldValue[]> {
  const out: FieldValue[] = [];
  for (const url of STORAGE) {
    let newest: NostrEvent | undefined;
    for (const e of q.net.get(url).events) {
      if (e.kind !== KIND_DRAFT_WRAP || !e.tags.some((t) => t[0] === 'd' && t[1] === d)) continue;
      if (newest === undefined || e.created_at > newest.created_at) newest = e;
    }
    const parsed = await parseDraftWrap(newest, q.queue);
    if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value') {
      throw new Error(`no draft ${d} on ${url}`);
    }
    out.push(parsed.value.draft.value);
  }
  return out;
}

async function cachedOf(q: Queue, d: string) {
  return (await readDraftCache(q.session))?.drafts.find((x) => x.d === d);
}

describe('editing a draft', { timeout: 30_000 }, () => {
  it('republishes the same d with the new text, keeping every other tag', async () => {
    const q = await destinationsQueue();
    await seed(q, 'd1', {
      inserted: [INSERTION],
      validation: { counter: 'twitter-text', length: 17, max: 280, ok: true },
    });
    await editDraft('d1', 'new text', q.deps, definitionSource());
    for (const v of await onRelays(q, 'd1')) {
      expect(v.content).toBe('new text');
      expect(v.status).toBe('active');
      expect(v.inserted).toEqual([INSERTION]);
      expect(v.reserved).toEqual([['target', 'https://x.com/a/status/1']]);
      expect(v.extraTags).toEqual([['future', 'kept']]);
      // The validation tag describes the new text, under the site's definition.
      expect(v.validation).toEqual({ counter: 'twitter-text', length: 8, max: 280, ok: true });
    }
    expect((await cachedOf(q, 'd1'))?.content).toBe('new text');
    q.close();
  });

  it('drops a validation tag it cannot recompute', async () => {
    const q = await destinationsQueue();
    await seed(q, 'd1', { site: 'myblog', validation: { ok: true } });
    await editDraft('d1', 'new text', q.deps, definitionSource());
    for (const v of await onRelays(q, 'd1')) expect(v.validation).toBeUndefined();
    q.close();
  });

  it('updates the armed copy when the armed draft is edited', async () => {
    const q = await destinationsQueue();
    const cached = await seed(q, 'd1');
    await arm(q.session, cached, 5);
    await editDraft('d1', 'armed and edited', q.deps);
    expect(await readArmed(q.session)).toMatchObject({
      d: 'd1',
      content: 'armed and edited',
      armedAt: 5,
    });
    q.close();
  });

  it('refuses empty text and text over 32 KiB, publishing nothing', async () => {
    const q = await destinationsQueue();
    await seed(q, 'd1');
    const before = q.net.get(STORAGE[0] as string).events.length;
    await expect(editDraft('d1', '  \n', q.deps)).rejects.toThrow(/needs some text/);
    await expect(editDraft('d1', 'é'.repeat(16_385), q.deps)).rejects.toThrow(/32768 bytes/);
    expect(q.net.get(STORAGE[0] as string).events.length).toBe(before);
    q.close();
  });

  it('refuses when a storage relay is unreachable, a draft is gone, or the queue is locked', async () => {
    const q = await destinationsQueue();
    await seed(q, 'd1');
    await expect(editDraft('missing', 'text', q.deps)).rejects.toThrow(/isn't on the storage/);
    const record = (await q.store.record()) as QueueRecord;
    await q.store.update({ storageRelays: [...record.storageRelays, 'wss://gone.example'] });
    await expect(dismissDraft('d1', q.deps)).rejects.toThrow(/gone\.example/);
    await q.store.update({ storageRelays: record.storageRelays });
    await q.store.lock();
    await expect(editDraft('d1', 'text', q.deps)).rejects.toThrow('Unlock the queue first.');
    expect((await onRelays(q, 'd1'))[0]?.content).toBe('the original text');
    q.close();
  });
});

describe('dismissing and restoring', { timeout: 30_000 }, () => {
  it('dismisses an active draft on every relay, disarms it and updates the cache', async () => {
    const q = await destinationsQueue();
    const cached = await seed(q, 'd1');
    await arm(q.session, cached, 5);
    await dismissDraft('d1', q.deps);
    for (const v of await onRelays(q, 'd1')) expect(v.status).toBe('archived:dismissed');
    expect((await cachedOf(q, 'd1'))?.status).toBe('archived:dismissed');
    expect(await readArmed(q.session)).toBeUndefined();
    await expect(dismissDraft('d1', q.deps)).rejects.toThrow(/already archived/);
    q.close();
  });

  it('restores an inserted draft to active and keeps its inserted tags', async () => {
    const q = await destinationsQueue();
    await seed(q, 'd1', { status: 'archived:inserted', inserted: [INSERTION] });
    await restoreDraft('d1', q.deps);
    for (const v of await onRelays(q, 'd1')) {
      expect(v.status).toBe('active');
      expect(v.inserted).toEqual([INSERTION]);
      expect(v.extraTags).toEqual([['future', 'kept']]);
    }
    expect((await cachedOf(q, 'd1'))?.status).toBe('active');
    await expect(restoreDraft('d1', q.deps)).rejects.toThrow(/already active/);
    q.close();
  });

  it('leaves the cache alone when a relay refuses the dismissal', async () => {
    const q = await destinationsQueue();
    await seed(q, 'd1');
    q.net.get(STORAGE[1] as string).options.refuseKinds = [KIND_DRAFT_WRAP];
    await expect(dismissDraft('d1', q.deps)).rejects.toThrow(/not saved on every storage relay/);
    expect((await cachedOf(q, 'd1'))?.status).toBe('active');
    q.close();
  });
});

const cached = (over: Partial<CachedDraft>): CachedDraft => ({
  d: 'd1',
  updatedAt: 1_700_000_000,
  site: 'x',
  account: 'lokkju',
  field: 'text',
  status: 'active',
  content: 'hello',
  ...over,
});

describe('archive view', () => {
  it('lists archived drafts newest first, as text, with Restore', () => {
    const drafts = [
      cached({ d: 'a', status: 'active', content: 'still active' }),
      cached({ d: 'b', status: 'archived:inserted', updatedAt: 10, content: 'older' }),
      cached({
        d: 'c',
        status: 'archived:dismissed',
        updatedAt: 20,
        content: '<img src=x onerror=alert(1)>',
        source: { wrapId: 'e'.repeat(64), submitter: 'f'.repeat(64), label: '<b>Bot</b>' },
      }),
    ];
    expect(archivedDrafts(drafts).map((d) => d.d)).toEqual(['c', 'b']);
    const html = renderToString(
      <ArchiveList drafts={drafts} busy={false} onRestore={() => undefined} />
    );
    expect(html).not.toContain('still active');
    expect(html).toContain('Dismissed');
    expect(html).toContain('Inserted');
    expect(html).toContain('&lt;img src=x onerror=alert(1)>');
    expect(html).toContain('from &lt;b>Bot&lt;/b>');
    expect(html.indexOf('data-draft="c"')).toBeLessThan(html.indexOf('data-draft="b"'));
    expect(html.match(/Restore/g)).toHaveLength(2);
  });

  it('says when nothing is archived or nothing has synced', () => {
    const none = renderToString(
      <ArchiveList drafts={[cached({})]} busy={false} onRestore={() => undefined} />
    );
    expect(none).toContain('No archived drafts.');
    const unsynced = renderToString(
      <ArchiveList drafts={undefined} busy={false} onRestore={() => undefined} />
    );
    expect(unsynced).toContain('Not synced yet.');
  });
});

describe('draft list controls', () => {
  const noop = () => undefined;
  const base = {
    url: 'https://x.com/home',
    page: {
      matching: [{ draft: cached({}), match: ['https://x.com/*'] }],
      otherAccounts: 0,
      detected: {},
      elsewhere: [],
    },
    undetected: [],
    armed: undefined,
    unrecorded: 0,
    busy: false,
    onInsert: noop,
    onArm: noop,
    onDisarm: noop,
    onRetry: noop,
  };

  it('offers Edit and Dismiss on each row only when drafts can be changed', () => {
    const plain = renderToString(<InsertView {...base} status={undefined} />);
    expect(plain).not.toContain('>Edit<');
    expect(plain).not.toContain('>Dismiss<');
    const html = renderToString(
      <InsertView {...base} status={undefined} onEdit={async () => true} onDismiss={noop} />
    );
    expect(html).toContain('>Edit<');
    expect(html).toContain('>Dismiss<');
  });

  it('puts Undo in the status line after a dismissal', () => {
    const html = renderToString(
      <InsertView {...base} status="Dismissed. It is in Archived drafts." onUndo={noop} />
    );
    expect(html).toMatch(/Dismissed\. It is in Archived drafts\.[\s\S]*Undo/);
  });

  it('offers pairing on the rotation notice and the agents screen on a flood', () => {
    const summary = {
      at: 1,
      ingested: 0,
      skipped: 0,
      deferred: 0,
      discarded: {},
      deletionsRequested: 0,
      cappedStreak: 3,
      errors: [],
      rotatedTo: 'f'.repeat(64),
    };
    const html = renderToString(<SyncNote summary={summary} onPair={noop} onAgents={noop} />);
    expect(html).toContain('Pair this device');
    expect(html).toContain('Open Agents');
    const bare = renderToString(<SyncNote summary={summary} />);
    expect(bare).not.toContain('<button');
  });
});

describe('per-agent counts', () => {
  const day = { quota: { max_submissions: 5, period: 'day' as const } };
  const now = 1_761_400_000; // 2025-10-25 13:46:40 UTC
  const today = 1_761_350_400;

  it('counts the current period and nothing from an earlier one', () => {
    const count = { period_start: today, accepted: ['a', 'b'], discarded: ['c'] };
    expect(countsInPeriod(count, day, now)).toEqual({ accepted: 2, discarded: 1 });
    expect(countsInPeriod({ ...count, period_start: today - 86_400 }, day, now)).toEqual({
      accepted: 0,
      discarded: 0,
    });
    expect(countsInPeriod(undefined, day, now)).toEqual({ accepted: 0, discarded: 0 });
  });
});
