/**
 * The archive's retention (spec 7.2, 9.2) against the fake storage relays: sync blanks and
 * requests deletion of archived drafts past `archive_retention_days` and drops them from the
 * cache, keeps active and recent ones, records its progress so it does not republish every sync,
 * and Restore refuses a draft past retention. Settings left unset keep drafts 90 days, after a
 * week's grace from this device's first sync with the default (D30); `null` keeps them; Settings
 * changes the value on every storage relay without dropping the settings' other fields, and a
 * second device adopts it on sync.
 */
import {
  buildDraftWrap,
  buildSettings,
  D_SETTINGS,
  type FieldValue,
  KIND_APP_DATA,
  KIND_DELETION,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  newestFirst,
  parseDraftWrap,
  parseSettings,
  publishToAll,
  RelayConnection,
  type Settings,
  type SocketFactory,
} from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { restoreDraft } from '../src/drafts/manage.ts';
import { RETENTION_GRACE_SECONDS, SECONDS_PER_DAY } from '../src/drafts/retention.ts';
import { saveArchiveRetention } from '../src/setup/settings.ts';
import { type SyncResult, syncOnce } from '../src/sync/engine.ts';
import { type CachedDraft, readDraftCache, readSyncState } from '../src/sync/state.ts';
import { ArchiveList, retentionNote } from '../src/ui/archive.tsx';
import { RetentionControl } from '../src/ui/retention.tsx';
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

  it('keeps every archived draft when the settings turn retention off (null)', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: null } });
    await seed(q, 'ancient', NOW - 400 * SECONDS_PER_DAY);
    const summary = synced(await syncOnce(syncDeps(q, new Set(), NOW + RETENTION_GRACE_SECONDS)));
    expect(summary.archiveDeleted).toBeUndefined();
    for (const url of STORAGE) expect(await stateOn(q, url, 'ancient')).toBe('archived:inserted');
    expect(await cachedDs(q)).toEqual(['ancient']);
    const cache = await readDraftCache(q.session);
    expect(cache?.retentionDays).toBeNull();
    expect(cache?.retentionChosen).toBe(true);
    expect(cache?.retentionGraceUntil).toBeUndefined();
    q.close();
  });
});

describe('the 90-day default (D30)', { timeout: 30_000 }, () => {
  const DAY = SECONDS_PER_DAY;
  const GRACE_END = NOW + RETENTION_GRACE_SECONDS;

  it('applies when the settings leave retention unset, after a week from the first sync', async () => {
    const q = await destinationsQueue();
    await seed(q, 'ancient', NOW - 100 * DAY);
    await seed(q, 'recent', NOW - 40 * DAY);

    // First sync on this version: nothing goes, the grace period starts and is recorded.
    const first = synced(await syncOnce(syncDeps(q)));
    expect(first.archiveDeleted).toBeUndefined();
    expect((await readSyncState(q.store.local)).retentionGraceFrom).toBe(NOW);
    for (const url of STORAGE) expect(await stateOn(q, url, 'ancient')).toBe('archived:inserted');
    const cache = await readDraftCache(q.session);
    expect(cache?.retentionDays).toBe(90);
    expect(cache?.retentionChosen).toBe(false);
    expect(cache?.retentionGraceUntil).toBe(GRACE_END);
    expect(await cachedDs(q)).toEqual(['ancient', 'recent']);

    // Inside the week, a later sync keeps the first sync's start and still deletes nothing.
    synced(await syncOnce(syncDeps(q, new Set(), GRACE_END - 60)));
    expect((await readSyncState(q.store.local)).retentionGraceFrom).toBe(NOW);
    for (const url of STORAGE) expect(await stateOn(q, url, 'ancient')).toBe('archived:inserted');
    // Restore still works on it during the grace period.
    await expect(
      restoreDraft('ancient', { ...q.deps, now: () => GRACE_END - 30 })
    ).resolves.toBeDefined();
    for (const url of STORAGE) expect(await stateOn(q, url, 'ancient')).toBe('active');
    q.close();
  });

  it('deletes drafts past 90 days once the grace period is over', async () => {
    const q = await destinationsQueue();
    await seed(q, 'ancient', NOW - 100 * DAY);
    await seed(q, 'recent', NOW - 40 * DAY);
    synced(await syncOnce(syncDeps(q)));

    const after = synced(await syncOnce(syncDeps(q, new Set(), GRACE_END)));
    expect(after.archiveDeleted).toBe(1);
    for (const url of STORAGE) {
      expect(await stateOn(q, url, 'ancient')).toBe('gone');
      expect(await stateOn(q, url, 'recent')).toBe('archived:inserted');
    }
    expect(await cachedDs(q)).toEqual(['recent']);
    await expect(restoreDraft('recent', { ...q.deps, now: () => NOW + 60 * DAY })).rejects.toThrow(
      /more than 90 days/
    );
    q.close();
  });

  it('gives no grace to a queue that chose a value', async () => {
    const q = await destinationsQueue({ settings: { archive_retention_days: 90 } });
    await seed(q, 'ancient', NOW - 100 * DAY);
    const summary = synced(await syncOnce(syncDeps(q)));
    expect(summary.archiveDeleted).toBe(1);
    expect((await readDraftCache(q.session))?.retentionGraceUntil).toBeUndefined();
    q.close();
  });

  it('deletes nothing by default while a storage relay does not answer', async () => {
    const q = await destinationsQueue();
    await seed(q, 'ancient', NOW - 100 * DAY);
    synced(await syncOnce(syncDeps(q)));
    const summary = synced(await syncOnce(syncDeps(q, new Set([RELAY_B]), GRACE_END)));
    expect(summary.archiveDeleted).toBeUndefined();
    expect(await stateOn(q, RELAY_A, 'ancient')).toBe('archived:inserted');
    q.close();
  });
});

/** The newest settings on `url`, decrypted. */
async function settingsOn(q: Queue, url: string) {
  const event = q.net
    .get(url)
    .events.filter(
      (e) => e.kind === KIND_APP_DATA && e.tags.some((t) => t[0] === 'd' && t[1] === D_SETTINGS)
    )
    .sort(newestFirst)[0];
  const parsed = await parseSettings(event, q.queue);
  if (!parsed.ok) throw new Error(`no settings on ${url}`);
  return parsed.value;
}

/** Publishes `event` to `url` alone. */
async function publishTo(q: Queue, url: string, event: NostrEvent) {
  const c = await RelayConnection.open(url, { socket: q.net.socket, timeoutMs: 500 });
  await publishToAll([c], event);
  c.close();
}

describe('changing retention in Settings (D30)', { timeout: 30_000 }, () => {
  it('merges into the newest settings from every relay, keeping the other fields', async () => {
    const q = await destinationsQueue();
    const before = await settingsOn(q, RELAY_A);
    // A newer settings event that only RELAY_B has, with counts, a retired key, a key this version
    // does not know and an extra tag.
    const agent = 'a'.repeat(64);
    const newer: Settings = {
      ...before.content,
      retired_inbox_keys: [{ key: 'b'.repeat(64), retired_at: NOW - DAYS }],
      quota_counts: { [agent]: { period_start: NOW, accepted: ['c'.repeat(64)], discarded: [] } },
      extra: { theme: 'dark' },
    };
    await publishTo(
      q,
      RELAY_B,
      await buildSettings(q.queue, newer, {
        createdAt: before.createdAt + 10,
        extraTags: [['future', 'kept']],
      })
    );

    await saveArchiveRetention(180, { ...q.deps, now: () => before.createdAt + 20 });
    for (const url of STORAGE) {
      const saved = await settingsOn(q, url);
      expect(saved.content).toEqual({ ...newer, archive_retention_days: 180 });
      expect(saved.extraTags).toEqual([['future', 'kept']]);
      expect(saved.createdAt).toBe(before.createdAt + 20);
    }
    // This device's copy and the archive's cache follow at once.
    const record = await q.store.record();
    const kept = await parseSettings(record?.settings, q.queue);
    expect(kept.ok && kept.value.content.archive_retention_days).toBe(180);
    q.close();
  });

  it('refuses and publishes nothing unless every storage relay answers', async () => {
    const q = await destinationsQueue();
    const before = await settingsOn(q, RELAY_A);
    const socket: SocketFactory = (url) =>
      q.net.socket(url === RELAY_B ? 'wss://down.invalid' : url);
    await expect(saveArchiveRetention(30, { ...q.deps, socket })).rejects.toThrow(
      /Every storage relay must be reachable/
    );
    expect((await settingsOn(q, RELAY_A)).id).toBe(before.id);
    q.close();
  });

  it('turns retention off with null, and a second device adopts the change on sync', async () => {
    const q = await destinationsQueue();
    const other = await q.secondDevice();
    await seed(q, 'ancient', NOW - 400 * SECONDS_PER_DAY);
    // The other device has synced with the default before the change.
    synced(await syncOnce({ ...syncDeps(q), store: other.store }));
    expect((await readDraftCache(other.session))?.retentionDays).toBe(90);

    await saveArchiveRetention(null, { ...q.deps, now: () => NOW + 60 });
    for (const url of STORAGE) {
      expect((await settingsOn(q, url)).content.archive_retention_days).toBeNull();
    }

    // Long after the grace period, the other device keeps the draft: it read the new value.
    const later = NOW + 30 * SECONDS_PER_DAY;
    const summary = synced(
      await syncOnce({ ...syncDeps(q, new Set(), later), store: other.store })
    );
    expect(summary.archiveDeleted).toBeUndefined();
    const cache = await readDraftCache(other.session);
    expect(cache?.retentionDays).toBeNull();
    expect(cache?.retentionChosen).toBe(true);
    expect(cache?.drafts.map((d) => d.d)).toEqual(['ancient']);
    const record = await other.store.record();
    const kept = await parseSettings(record?.settings, q.queue);
    expect(kept.ok && kept.value.content.archive_retention_days).toBeNull();

    // And back to 30 days: the other device adopts it and deletes the draft on its next sync.
    await saveArchiveRetention(30, { ...q.deps, now: () => later + 60 });
    const again = synced(
      await syncOnce({ ...syncDeps(q, new Set(), later + 120), store: other.store })
    );
    expect(again.archiveDeleted).toBe(1);
    expect((await readDraftCache(other.session))?.retentionDays).toBe(30);
    q.close();
  });

  it('refuses a value that is not a whole number of days', async () => {
    const q = await destinationsQueue();
    await expect(saveArchiveRetention(0, q.deps)).rejects.toThrow(/at least 1/);
    await expect(saveArchiveRetention(1.5, q.deps)).rejects.toThrow(/whole number/);
    q.close();
  });
});

describe('retention in the popup (D30)', () => {
  it('says how long archived drafts are kept, and that Settings changes it', () => {
    expect(retentionNote({ retentionDays: 90 })).toBe(
      'Archived drafts are kept 90 days (change in Settings).'
    );
    expect(retentionNote({ retentionDays: null })).toBe(
      'Archived drafts are never deleted (change in Settings).'
    );
    expect(retentionNote(undefined)).toBe('');
  });

  it('keeps Restore on a draft the grace period spares and says when it goes', () => {
    const row: CachedDraft = {
      d: 'ancient',
      updatedAt: NOW - 100 * SECONDS_PER_DAY,
      site: 'x',
      account: 'alt',
      field: 'text',
      status: 'archived:dismissed',
      content: 'old text',
    };
    const html = renderToString(
      <ArchiveList
        drafts={[row]}
        busy={false}
        retentionDays={90}
        graceUntil={NOW + RETENTION_GRACE_SECONDS}
        now={NOW}
        onRestore={() => undefined}
      />
    );
    expect(html).toMatch(/Restore/);
    expect(html).toMatch(/deleted after .* unless restored/);
    expect(html).not.toMatch(/Past retention/);
  });

  it('offers 30, 90 (default), 180 and 365 days and never, and a value set elsewhere', () => {
    const render = (current: number | null) =>
      renderToString(
        <RetentionControl
          current={current}
          selected={current}
          busy={false}
          onSelect={() => undefined}
          onSave={() => undefined}
        />
      );
    const html = render(90);
    for (const label of [
      '30 days',
      '90 days (default)',
      '180 days',
      '365 days',
      'Never delete archived drafts',
    ]) {
      expect(html).toContain(`>${label}</option>`);
    }
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save/);
    expect(render(45)).toContain('>45 days</option>');
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
