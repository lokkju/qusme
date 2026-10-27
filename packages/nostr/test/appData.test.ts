import { npubEncode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  archiveRetentionDays,
  buildDestinations,
  buildRecoveryBackup,
  buildRotationMarker,
  buildSettings,
  D_DESTINATIONS,
  D_RECOVERY,
  D_ROTATED,
  D_SETTINGS,
  type Destinations,
  encodeNcryptsec,
  KIND_APP_DATA,
  nip44Encrypt,
  parseDestinations,
  parseRecoveryBackup,
  parseRotationMarker,
  parseSettings,
  type Settings,
} from '../src/index.ts';
import {
  agentPubkey,
  expectError,
  expectOk,
  NOW,
  other,
  otherPubkey,
  queue,
  queueKey,
  queuePubkey,
  sign,
  tamper,
  WRAP_ID,
} from './helpers.ts';

const destinations: Destinations = {
  destinations: [
    {
      id: '01JA',
      site: 'x',
      account: 'lokkju',
      label: 'X / lokkju',
      status: 'confirmed',
      override: null,
    },
    {
      id: '01JB',
      site: 'mastodon',
      account: 'lokkju@mastodon.social',
      label: '',
      status: 'pending',
      override: {
        match: ['https://mastodon.social/*'],
        fields: [{ name: 'text', constraints: { maxLength: 500 } }],
      },
    },
  ],
};

const settings: Settings = {
  archive_retention_days: 90,
  quota_counts: {
    [agentPubkey]: {
      period_start: 1_761_350_400,
      accepted: [WRAP_ID],
      discarded: ['b'.repeat(64)],
    },
  },
};

// An app data event with arbitrary content encrypted to the queue key.
const appData = (d: string, content: unknown) =>
  sign({
    kind: KIND_APP_DATA,
    created_at: NOW,
    tags: [['d', d]],
    content: nip44Encrypt(
      queueKey,
      queuePubkey,
      typeof content === 'string' ? content : JSON.stringify(content)
    ),
  });

describe('destinations (NIP-78)', () => {
  it('round-trips, encrypted to the queue key', async () => {
    const event = await buildDestinations(queue, destinations, { createdAt: NOW });
    expect(event.kind).toBe(KIND_APP_DATA);
    expect(event.tags).toEqual([['d', D_DESTINATIONS]]);
    expect(event.content).not.toContain('lokkju');
    expect(verifyEvent({ ...event })).toBe(true);
    const parsed = expectOk(await parseDestinations(event, queue));
    expect(parsed).toEqual({
      id: event.id,
      pubkey: queuePubkey,
      createdAt: NOW,
      content: destinations,
    });
  });

  it('rejects malformed destinations', async () => {
    const one = destinations.destinations[0];
    const cases: unknown[] = [
      {},
      { destinations: {} },
      { destinations: [{ ...one, status: 'maybe' }] },
      { destinations: [{ ...one, id: '' }] },
      { destinations: [one, one] },
      { destinations: [{ ...one, override: [] }] },
      { destinations: [{ ...one, override: JSON.parse('{"__proto__":{"admin":true}}') }] },
    ];
    for (const content of cases) {
      expectError(
        await parseDestinations(appData(D_DESTINATIONS, content), queue),
        'invalid_content'
      );
    }
    expectError(
      await parseDestinations(appData(D_DESTINATIONS, '[not json'), queue),
      'invalid_json'
    );
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('rejects the wrong d, wrong author and a tampered event', async () => {
    const event = await buildDestinations(queue, destinations);
    expectError(await parseDestinations(appData(D_SETTINGS, destinations), queue), 'invalid_tags');
    expectError(await parseDestinations(event, other), 'wrong_author');
    expectError(await parseDestinations(tamper(event, { created_at: 1 }), queue), 'bad_signature');
  });

  it('refuses to build invalid destinations', async () => {
    await expect(
      buildDestinations(queue, {
        destinations: [{ ...destinations.destinations[0], site: '' }],
      } as Destinations)
    ).rejects.toThrow(/invalid destinations/);
  });
});

describe('settings (NIP-78)', () => {
  it('round-trips archive_retention_days and quota_counts', async () => {
    const event = await buildSettings(queue, settings, { createdAt: NOW });
    expect(event.tags).toEqual([['d', D_SETTINGS]]);
    expect(expectOk(await parseSettings(event, queue)).content).toEqual(settings);
  });

  it('keeps null and absent retention apart and resolves the default per relay', async () => {
    const kept = expectOk(
      await parseSettings(
        await buildSettings(queue, { archive_retention_days: null, quota_counts: {} }),
        queue
      )
    );
    expect(kept.content.archive_retention_days).toBeNull();
    expect(archiveRetentionDays(kept.content, true)).toBeNull();
    const unset = expectOk(await parseSettings(appData(D_SETTINGS, {}), queue));
    expect(unset.content).toEqual({ quota_counts: {} });
    expect(archiveRetentionDays(unset.content, true)).toBe(90);
    expect(archiveRetentionDays(unset.content, false)).toBeNull();
    expect(archiveRetentionDays(settings, false)).toBe(90);
  });

  it('rejects malformed settings', async () => {
    const count = settings.quota_counts[agentPubkey];
    const cases: unknown[] = [
      { archive_retention_days: 0 },
      { archive_retention_days: '90' },
      { archive_retention_days: 1.5 },
      { quota_counts: { notapubkey: count } },
      { quota_counts: { [agentPubkey]: { ...count, accepted: ['short'] } } },
      { quota_counts: { [agentPubkey]: { ...count, period_start: -1 } } },
      { quota_counts: { [agentPubkey]: { period_start: 0, accepted: [] } } },
      { quota_counts: JSON.parse('{"__proto__":{}}') },
      [],
    ];
    for (const content of cases) {
      expectError(await parseSettings(appData(D_SETTINGS, content), queue), 'invalid_content');
    }
  });
});

describe('recovery backup (spec 6.1)', () => {
  const ncryptsec = encodeNcryptsec(queueKey, 'correct horse', { logN: 16 });

  it('round-trips the ncryptsec in the clear', async () => {
    const event = await buildRecoveryBackup(queue, ncryptsec, { createdAt: NOW });
    expect(event.tags).toEqual([['d', D_RECOVERY]]);
    expect(event.content).toBe(ncryptsec);
    expect(verifyEvent({ ...event })).toBe(true);
    expect(expectOk(parseRecoveryBackup(event, { queuePubkey }))).toEqual({
      id: event.id,
      pubkey: queuePubkey,
      createdAt: NOW,
      ncryptsec,
      params: { logN: 16, keySecurity: 2 },
    });
  });

  it('rejects another signer, a non-ncryptsec, and the wrong d', async () => {
    const event = await buildRecoveryBackup(queue, ncryptsec);
    expectError(parseRecoveryBackup(event, { queuePubkey: otherPubkey }), 'wrong_author');
    const bad = sign({
      kind: KIND_APP_DATA,
      created_at: NOW,
      tags: [['d', D_RECOVERY]],
      content: 'nsec1abc',
    });
    expectError(parseRecoveryBackup(bad), 'invalid_content');
    const wrongD = sign({
      kind: KIND_APP_DATA,
      created_at: NOW,
      tags: [['d', D_SETTINGS]],
      content: ncryptsec,
    });
    expectError(parseRecoveryBackup(wrongD), 'invalid_tags');
    await expect(buildRecoveryBackup(queue, 'ncryptsec1nope')).rejects.toThrow(/invalid ncryptsec/);
  });
});

describe('rotation marker (spec 6.1)', () => {
  it('round-trips the new npub, encrypted to the old key', async () => {
    const event = await buildRotationMarker(queue, otherPubkey, { createdAt: NOW });
    expect(event.tags).toEqual([['d', D_ROTATED]]);
    expect(event.content).not.toContain('npub');
    expect(expectOk(await parseRotationMarker(event, queue))).toEqual({
      id: event.id,
      pubkey: queuePubkey,
      createdAt: NOW,
      newPubkey: otherPubkey,
    });
  });

  it('rejects content that is not an npub', async () => {
    for (const content of [
      { npub: 'npub1xyz' },
      { npub: 42 },
      {},
      { npub: npubEncode(otherPubkey).slice(0, -1) },
    ]) {
      expectError(await parseRotationMarker(appData(D_ROTATED, content), queue), 'invalid_content');
    }
  });
});
