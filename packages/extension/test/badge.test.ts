import { bytesToHex } from '@noble/hashes/utils.js';
import type { Destination } from '@qusme/nostr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { addPendingRevocation } from '../src/agents/pendingRevocations.ts';
import {
  BADGE_ATTENTION_COLOR,
  BADGE_COLOR,
  badgeFor,
  badgeUpdater,
  changesBadge,
  readBadgeInput,
} from '../src/badge.ts';
import { writeInsertionState } from '../src/insertion/armed.ts';
import {
  KeyStore,
  LOCAL_PENDING_REVOCATIONS,
  LOCAL_QUEUE,
  type QueueRecord,
  SESSION_DRAFTS,
  SESSION_UNLOCKED,
} from '../src/keyStore.ts';
import { MemoryStorageArea } from '../src/storage.ts';
import { type CachedDraft, writeDraftCache } from '../src/sync/state.ts';

const none = {
  unlocked: true,
  activeDrafts: 0,
  pendingDestinations: 0,
  pendingRevocations: 0,
  unrecordedInsertions: 0,
};

describe('toolbar badge', () => {
  it('counts active drafts in the accent colour', () => {
    expect(badgeFor({ ...none, activeDrafts: 3 })).toEqual({
      text: '3',
      color: BADGE_COLOR,
      title: 'qus.me: 3 drafts',
    });
    expect(badgeFor({ ...none, activeDrafts: 120 }).text).toBe('99+');
    expect(badgeFor(none)).toMatchObject({ text: '', color: BADGE_COLOR });
  });

  it('turns the attention colour when something needs the user, with ! and no drafts', () => {
    for (const reason of [
      { pendingDestinations: 1 },
      { pendingRevocations: 1 },
      { unrecordedInsertions: 2 },
    ]) {
      expect(badgeFor({ ...none, activeDrafts: 2, ...reason })).toMatchObject({
        text: '2',
        color: BADGE_ATTENTION_COLOR,
      });
      expect(badgeFor({ ...none, ...reason })).toMatchObject({
        text: '!',
        color: BADGE_ATTENTION_COLOR,
      });
    }
    expect(badgeFor({ ...none, activeDrafts: 1, pendingDestinations: 2 }).title).toBe(
      'qus.me: 1 draft; 2 accounts waiting for your OK'
    );
  });

  it('is cleared while locked, whatever is waiting', () => {
    expect(
      badgeFor({ ...none, unlocked: false, activeDrafts: 4, pendingDestinations: 1 })
    ).toMatchObject({ text: '' });
  });

  it('reads its counts from storage and follows the lock', async () => {
    const local = new MemoryStorageArea();
    const session = new MemoryStorageArea();
    const store = new KeyStore({ local, session });
    const secretKey = generateSecretKey();
    const record: QueueRecord = {
      version: 1,
      pubkey: getPublicKey(secretKey),
      ncryptsec: 'ncryptsec1unused',
      storageRelays: ['wss://storage.example'],
    };
    await local.set({ [LOCAL_QUEUE]: record });
    await session.set({ [SESSION_UNLOCKED]: { queue: bytesToHex(secretKey) } });
    const status = await store.status();
    if (status.state !== 'unlocked') throw new Error(`expected unlocked, got ${status.state}`);
    const draft = (d: string, s: CachedDraft['status']): CachedDraft => ({
      d,
      updatedAt: 1,
      site: 'x',
      account: 'lokkju',
      field: 'text',
      status: s,
      content: 'hello',
    });
    const destination = (id: string, s: Destination['status']) =>
      ({ id, site: 'x', account: id, label: id, status: s, override: null }) as Destination;
    await writeDraftCache(session, {
      queuePubkey: status.pubkey,
      syncedAt: 1,
      drafts: [draft('1', 'active'), draft('2', 'active'), draft('3', 'archived:inserted')],
      destinations: [destination('a', 'confirmed'), destination('b', 'pending')],
    });
    await writeInsertionState(session, {
      unrecorded: [
        {
          d: '3',
          insertion: {
            at: 1,
            url: 'https://x.com/',
            strategy: 'paste',
            method: 'extension_popup',
            accessibleName: '',
            detectedAccount: '',
          },
        },
      ],
    });
    await addPendingRevocation(store, {
      queuePubkey: status.pubkey,
      agentPubkey: 'b'.repeat(64),
      since: 1,
    });
    await addPendingRevocation(store, {
      queuePubkey: 'c'.repeat(64),
      agentPubkey: 'b'.repeat(64),
      since: 1,
    });
    expect(await readBadgeInput(store)).toEqual({
      unlocked: true,
      activeDrafts: 2,
      pendingDestinations: 1,
      pendingRevocations: 1,
      unrecordedInsertions: 1,
    });

    const calls: [string, string][] = [];
    const update = badgeUpdater(store, {
      setBadgeText: async ({ text }) => void calls.push(['text', text]),
      setBadgeBackgroundColor: async ({ color }) => void calls.push(['color', color]),
      setTitle: async () => undefined,
    });
    await update();
    expect(calls).toEqual([
      ['color', BADGE_ATTENTION_COLOR],
      ['text', '2'],
    ]);
    await store.lock();
    calls.length = 0;
    await update();
    expect(calls).toContainEqual(['text', '']);
  });

  it('updates on the storage keys that change it', () => {
    expect(changesBadge({ [SESSION_DRAFTS]: {} }, 'session')).toBe(true);
    expect(changesBadge({ [SESSION_UNLOCKED]: {} }, 'session')).toBe(true);
    expect(changesBadge({ [LOCAL_PENDING_REVOCATIONS]: {} }, 'local')).toBe(true);
    expect(changesBadge({ [SESSION_DRAFTS]: {} }, 'local')).toBe(false);
    expect(changesBadge({ 'qusme.picker': {} }, 'session')).toBe(false);
  });
});
