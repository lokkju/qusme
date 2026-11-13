/**
 * The archive's retention (spec 7.2, 9.2) against the fake storage relays: sync blanks and
 * requests deletion of archived drafts past `archive_retention_days` and drops them from the
 * cache, keeps active and recent ones, records its progress so it does not republish every sync,
 * and Restore refuses a draft past retention.
 */
import {
  buildDraftWrap,
  type FieldValue,
  KIND_DELETION,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  parseDraftWrap,
  type SocketFactory,
} from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { restoreDraft } from '../src/drafts/manage.ts';
import { SECONDS_PER_DAY } from '../src/drafts/retention.ts';
import { type SyncResult, syncOnce } from '../src/sync/engine.ts';
import { type CachedDraft, readDraftCache, readSyncState } from '../src/sync/state.ts';
import { ArchiveList } from '../src/ui/archive.tsx';
import { destinationsQueue, STORAGE } from './helpers.ts';

type Queue = Awaited<ReturnType<typeof destinationsQueue>>;

const NOW = 1_800_000_000;
const DAYS = 30;
const OLD = NOW - 40 * SECONDS_PER_DAY;
const RECENT = NOW - 5 * SECONDS_PER_DAY;
const [RELAY_A, RELAY_B] = STORAGE as [string, string];

const value = (over: Partial<FieldValue> = {}): FieldValue => ({
  createdAt: OLD,
  site: 'x',
  account: 'alt',
  field: 'text',
  status: 'archived:inserted',
  inserted: [],
  content: 'some text',
  reserved: [],
  extraTags: [],
  ...over,
});

async function seed(q: Queue, d: string, createdAt: number, over: Partial<FieldValue> = {}) {
  const event = await buildDraftWrap(q.queue, {
    d,
    draft: { type: 'field_value', value: value(over) },
    createdAt,
  });
  await q.publish(event);
}

/** The newest version of `d` on `url`: its status, `deleted` for a blank, or `gone`. */
async function stateOn(q: Queue, url: string, d: string): Promise<string> {
  let newest: NostrEvent | undefined;
  for (const e of q.net.get(url).events) {
    if (e.kind !== KIND_DRAFT_WRAP || !e.tags.some((t) => t[0] === 'd' && t[1] === d)) continue;
    if (newest === undefined || e.created_at > newest.created_at) newest = e;
  }
  if (newest === undefined) return 'gone';
  const parsed = await parseDraftWrap(newest, q.queue);
  if (!parsed.ok) throw new Error('unreadable wrap');
  if (parsed.value.deleted) return 'deleted';
  if (parsed.value.draft.type !== 'field_value') throw new Error('not a field value');
  return parsed.value.draft.value.status;
}

/** Sync deps at a fixed time, with the relays in `down` unreachable. */
function syncDeps(q: Queue, down: Set<string> = new Set(), now = NOW) {
  const socket: SocketFactory = (url) => q.net.socket(down.has(url) ? 'wss://down.invalid' : url);
  return { store: q.store, socket, relayTimeoutMs: 500, now: () => now };
}

function synced(result: SyncResult) {
  if (result.state !== 'synced') throw new Error(`sync ${result.state}`);
  return result.summary;
}

const writesFor = (q: Queue, url: string, d: string) =>
  q.net
    .get(url)
    .accepted.filter(
      (e) =>
        (e.kind === KIND_DRAFT_WRAP && e.tags.some((t) => t[0] === 'd' && t[1] === d)) ||
        (e.kind === KIND_DELETION && e.tags.some((t) => t[0] === 'a' && t[1]?.endsWith(`:${d}`)))
    ).length;

async function cachedDs(q: Queue) {
  return ((await readDraftCache(q.session))?.drafts ?? []).map((x) => x.d).sort();
}

describe('archive retention on sync', { timeout: 30_000 }, () => {
  it('deletes archived drafts past retention and drops them, keeping active and recent ones', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: DAYS } });
    await seed(q, 'old-inserted', OLD);
    await seed(q, 'old-dismissed', OLD, { status: 'archived:dismissed' });
    await seed(q, 'old-active', OLD, { status: 'active' });
    await seed(q, 'recent-dismissed', RECENT, { status: 'archived:dismissed' });

    const summary = synced(await syncOnce(syncDeps(q)));
    expect(summary.archiveDeleted).toBe(2);
    for (const url of STORAGE) {
      // The fake relays honor NIP-09, so the blank goes too.
      expect(await stateOn(q, url, 'old-inserted')).toBe('gone');
      expect(await stateOn(q, url, 'old-dismissed')).toBe('gone');
      expect(await stateOn(q, url, 'old-active')).toBe('active');
      expect(await stateOn(q, url, 'recent-dismissed')).toBe('archived:dismissed');
    }
    expect(await cachedDs(q)).toEqual(['old-active', 'recent-dismissed']);
    expect((await readDraftCache(q.session))?.retentionDays).toBe(DAYS);

    // Nothing is left to delete, so the next sync publishes nothing for them.
    const before = writesFor(q, RELAY_A, 'old-inserted');
    const again = synced(await syncOnce(syncDeps(q, new Set(), NOW + 60)));
    expect(again.archiveDeleted).toBeUndefined();
    expect(writesFor(q, RELAY_A, 'old-inserted')).toBe(before);
    expect((await readSyncState(q.store.local)).expired).toEqual({});
    q.close();
  });

  it('leaves a blank behind on a relay that ignores NIP-09, and stops there', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: DAYS } });
    for (const url of STORAGE) q.net.get(url).options.honorDeletion = false;
    await seed(q, 'old', OLD);
    synced(await syncOnce(syncDeps(q)));
    for (const url of STORAGE) expect(await stateOn(q, url, 'old')).toBe('deleted');
    expect(await cachedDs(q)).toEqual([]);

    const before = STORAGE.map((url) => writesFor(q, url, 'old'));
    synced(await syncOnce(syncDeps(q, new Set(), NOW + 60)));
    expect(STORAGE.map((url) => writesFor(q, url, 'old'))).toEqual(before);
    q.close();
  });

  it('asks a relay that missed the sync once it is back, and not the one that took it', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: DAYS } });
    await seed(q, 'old', OLD);

    synced(await syncOnce(syncDeps(q, new Set([RELAY_B]))));
    expect(await stateOn(q, RELAY_A, 'old')).toBe('gone');
    expect(await stateOn(q, RELAY_B, 'old')).toBe('archived:inserted');
    expect(await cachedDs(q)).toEqual([]);
    expect((await readSyncState(q.store.local)).expired?.old).toMatchObject({
      done: [RELAY_A],
      tries: 1,
    });

    // RELAY_B is back and still serves the archived version: only it gets the request.
    const aBefore = writesFor(q, RELAY_A, 'old');
    synced(await syncOnce(syncDeps(q, new Set(), NOW + 60)));
    expect(writesFor(q, RELAY_A, 'old')).toBe(aBefore);
    expect(await stateOn(q, RELAY_B, 'old')).toBe('gone');

    // Every relay answered and none serves it: the record is dropped, nothing more is sent.
    const after = STORAGE.map((url) => writesFor(q, url, 'old'));
    synced(await syncOnce(syncDeps(q, new Set(), NOW + 120)));
    expect(STORAGE.map((url) => writesFor(q, url, 'old'))).toEqual(after);
    expect((await readSyncState(q.store.local)).expired).toEqual({});
    q.close();
  });

  it('keeps every archived draft when the settings set no retention', async () => {
    const q = await destinationsQueue();
    await seed(q, 'old', OLD);
    const summary = synced(await syncOnce(syncDeps(q)));
    expect(summary.archiveDeleted).toBeUndefined();
    for (const url of STORAGE) expect(await stateOn(q, url, 'old')).toBe('archived:inserted');
    expect(await cachedDs(q)).toEqual(['old']);
    expect((await readDraftCache(q.session))?.retentionDays).toBeNull();
    q.close();
  });
});

describe('restoring past retention', { timeout: 30_000 }, () => {
  it('refuses a draft past retention and changes nothing', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: DAYS } });
    await seed(q, 'old', OLD);
    await expect(restoreDraft('old', { ...q.deps, now: () => NOW })).rejects.toThrow(
      /more than 30 days.*can't be restored/
    );
    for (const url of STORAGE) expect(await stateOn(q, url, 'old')).toBe('archived:inserted');
    q.close();
  });

  it('restores a draft inside retention, or any draft when there is no retention', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: DAYS } });
    await seed(q, 'recent', RECENT);
    await restoreDraft('recent', { ...q.deps, now: () => NOW });
    for (const url of STORAGE) expect(await stateOn(q, url, 'recent')).toBe('active');
    q.close();

    const keep = await destinationsQueue();
    await seed(keep, 'old', OLD);
    await restoreDraft('old', { ...keep.deps, now: () => NOW });
    for (const url of STORAGE) expect(await stateOn(keep, url, 'old')).toBe('active');
    keep.close();
  });

  it('shows a draft past retention without Restore in the archive view', () => {
    const row = (d: string, updatedAt: number): CachedDraft => ({
      d,
      updatedAt,
      site: 'x',
      account: 'alt',
      field: 'text',
      status: 'archived:dismissed',
      content: `text of ${d}`,
    });
    const html = renderToString(
      <ArchiveList
        drafts={[row('old', OLD), row('recent', RECENT)]}
        busy={false}
        retentionDays={DAYS}
        now={NOW}
        onRestore={() => undefined}
      />
    );
    const [recent, old] = html.split('data-draft="old"');
    expect(recent).toMatch(/Restore/);
    expect(old).toMatch(/Past retention; deleted on the next sync/);
    expect(old).not.toMatch(/Restore/);
  });
});
