/**
 * Destinations added, edited and removed by hand (spec 7.2, 10.2, 11.8) against the fake storage
 * relays, and the Destinations screen's markup.
 */
import {
  buildDraftWrap,
  type Destination,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  parseDraftWrap,
} from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { defaultChoices } from '../src/agents/approve.ts';
import {
  addDestination,
  editDestination,
  loadDestinations,
  removeDestination,
} from '../src/agents/destinations.ts';
import type { AuthorizationRequest } from '../src/agents/service.ts';
import { loadShareableDestinations } from '../src/agents/view.ts';
import { definitionSource } from '../src/insertion/definitions.ts';
import type { QueueRecord } from '../src/keyStore.ts';
import { readDraftCache, writeDraftCache } from '../src/sync/state.ts';
import { GrantForm } from '../src/ui/agents.tsx';
import {
  AddDestinationForm,
  addInput,
  DestinationList,
  detectionMessage,
  EditDestinationForm,
  emptyAdd,
  siteChoices,
} from '../src/ui/destinations.tsx';
import { InsertView } from '../src/ui/insert.tsx';
import { destinationsQueue, STORAGE } from './helpers.ts';

/** The bundled registry snapshot's definitions: X today. */
const source = definitionSource();

type Queue = Awaited<ReturnType<typeof destinationsQueue>>;

/** Every relay holds the same list, and the unknown keys survived the write. */
async function listOnRelays(q: Queue): Promise<Destination[]> {
  const lists = await q.onRelays();
  expect(lists).toHaveLength(STORAGE.length);
  for (const list of lists) {
    expect(list.content.extra).toEqual({ sort: 'label' });
    expect(list.extraTags).toEqual([['future', 'kept']]);
    expect(list.content.destinations).toEqual(lists[0]?.content.destinations);
  }
  return lists[0]?.content.destinations ?? [];
}

const ALT_EXTRA = { color: 'teal' };

describe('adding destinations', { timeout: 30_000 }, () => {
  it('adds a registry site with the default label, keeping unknown fields', async () => {
    const q = await destinationsQueue();
    const added = await addDestination(
      { site: 'x', account: '@lokkju', override: null },
      source,
      q.deps
    );
    expect(added).toMatchObject({
      site: 'x',
      account: 'lokkju',
      label: 'X / lokkju',
      status: 'confirmed',
      override: null,
    });
    expect(added.id).toMatch(/^[0-9a-f]{32}$/);
    const list = await listOnRelays(q);
    expect(list.map((d) => [d.account, d.label, d.extra])).toEqual([
      ['alt', 'X / alt', ALT_EXTRA],
      ['lokkju', 'X / lokkju', undefined],
    ]);
    // The same site and account again, in any case or with an @, is refused.
    await expect(
      addDestination({ site: 'x', account: 'LOKKJU', override: null }, source, q.deps)
    ).rejects.toThrow('X / lokkju is already a destination.');
    q.close();
  });

  it('adds a custom destination with its match patterns, and refuses one without', async () => {
    const q = await destinationsQueue();
    await expect(
      addDestination({ site: 'myblog', account: 'me', override: null }, source, q.deps)
    ).rejects.toThrow(/override doesn't work/);
    await expect(
      addDestination(
        { site: 'myblog', account: 'me', override: { match: ['blog.example'] } },
        source,
        q.deps
      )
    ).rejects.toThrow(/not a match pattern/);
    await expect(
      addDestination(
        { site: 'My Blog', account: 'me', override: { match: ['https://blog.example/*'] } },
        source,
        q.deps
      )
    ).rejects.toThrow(/site id/);
    const added = await addDestination(
      {
        site: 'myblog',
        account: 'me',
        label: 'Blog',
        override: { match: ['https://blog.example/*'] },
      },
      source,
      q.deps
    );
    expect(added).toMatchObject({ site: 'myblog', label: 'Blog' });
    const list = await listOnRelays(q);
    expect(list.at(-1)).toMatchObject({
      site: 'myblog',
      account: 'me',
      label: 'Blog',
      status: 'confirmed',
      override: { match: ['https://blog.example/*'] },
    });
    expect(list[0]?.extra).toEqual(ALT_EXTRA);
    q.close();
  });

  it('points a pending duplicate at the Agents screen', async () => {
    const q = await destinationsQueue({
      destinations: [
        {
          id: 'p'.repeat(32),
          site: 'x',
          account: 'newcomer',
          label: 'x / newcomer',
          status: 'pending',
          override: null,
        },
      ],
    });
    await expect(
      addDestination({ site: 'x', account: 'newcomer', override: null }, source, q.deps)
    ).rejects.toThrow(/waiting for you under Agents/);
    q.close();
  });

  it('puts the new list into the session cache for the insert panel', async () => {
    const q = await destinationsQueue();
    await writeDraftCache(q.session, { queuePubkey: q.pubkey, syncedAt: 1, drafts: [] });
    await addDestination({ site: 'x', account: 'lokkju', override: null }, source, q.deps);
    const cache = await readDraftCache(q.session);
    expect(cache?.destinations?.map((d) => d.account)).toEqual(['alt', 'lokkju']);
    q.close();
  });

  it('is listed on the approval screen once added', async () => {
    const q = await destinationsQueue({ destinations: [] });
    expect(await loadShareableDestinations(q.deps)).toEqual([]);
    await addDestination({ site: 'x', account: 'lokkju', override: null }, source, q.deps);
    const shareable = await loadShareableDestinations(q.deps);
    expect(shareable.map((d) => d.label)).toEqual(['X / lokkju']);
    const request: AuthorizationRequest = {
      code: 'ABCD-1234',
      agentPubkey: 'a'.repeat(64),
      clientId: 'https://client.example/meta.json',
      clientHost: 'client.example',
      clientName: 'Client',
      scopes: ['drafts:submit'],
      expiresAt: 0,
    };
    const html = renderToString(
      <GrantForm destinations={shareable} choices={defaultChoices(request)} onChange={() => {}} />
    );
    expect(html).toContain('X / lokkju');
    expect(html).not.toContain('no confirmed destinations yet');
    q.close();
  });
});

describe('editing destinations', { timeout: 30_000 }, () => {
  it('changes the label and override, keeping the rest and unknown fields', async () => {
    const q = await destinationsQueue();
    const edited = await editDestination(
      'dest-x-alt',
      { label: 'Alt account', override: { match: ['https://x.com/alt/*'] } },
      source,
      q.deps
    );
    expect(edited).toEqual({
      id: 'dest-x-alt',
      site: 'x',
      account: 'alt',
      label: 'Alt account',
      status: 'confirmed',
      override: { match: ['https://x.com/alt/*'] },
      extra: ALT_EXTRA,
    });
    expect(await listOnRelays(q)).toEqual([edited]);
    q.close();
  });

  it('refuses an override the parser rejects, and publishes nothing', async () => {
    const q = await destinationsQueue();
    const before = q.net.get(STORAGE[0] as string).events.length;
    await expect(
      editDestination(
        'dest-x-alt',
        { label: 'Alt', override: { fields: [{ name: 'text', inject: ['clipboard', 'paste'] }] } },
        source,
        q.deps
      )
    ).rejects.toThrow(/clipboard must be last/);
    await expect(
      editDestination('dest-x-alt', { label: '  ', override: null }, source, q.deps)
    ).rejects.toThrow('Enter a label.');
    await expect(
      editDestination('gone', { label: 'x', override: null }, source, q.deps)
    ).rejects.toThrow(/gone/);
    expect(q.net.get(STORAGE[0] as string).events.length).toBe(before);
    q.close();
  });
});

describe('removing destinations', { timeout: 30_000 }, () => {
  async function draft(q: Queue, d: string, account: string, destination?: string) {
    const event = await buildDraftWrap(q.queue, {
      d,
      draft: {
        type: 'field_value',
        value: {
          createdAt: 1_700_000_000,
          site: 'x',
          account,
          field: 'text',
          ...(destination !== undefined && { destination }),
          status: 'active',
          inserted: [],
          content: `draft ${d}`,
          reserved: [],
        },
      },
      createdAt: 1_700_000_000,
    });
    await q.publish(event);
  }

  async function statuses(q: Queue) {
    const latest = new Map<string, NostrEvent>();
    for (const e of q.net
      .get(STORAGE[1] as string)
      .events.filter((e) => e.kind === KIND_DRAFT_WRAP)) {
      const d = e.tags.find((t) => t[0] === 'd')?.[1] as string;
      const prev = latest.get(d);
      if (prev === undefined || e.created_at > prev.created_at) latest.set(d, e);
    }
    const out: Record<string, string> = {};
    for (const [d, e] of latest) {
      const parsed = await parseDraftWrap(e, q.queue);
      if (!parsed.ok || parsed.value.deleted) continue;
      if (parsed.value.draft.type === 'field_value') out[d] = parsed.value.draft.value.status;
    }
    return out;
  }

  it('dismisses its active drafts, then removes it, keeping unknown fields', async () => {
    const q = await destinationsQueue();
    await addDestination({ site: 'x', account: 'lokkju', override: null }, source, q.deps);
    await draft(q, 'by-id', 'someone', 'dest-x-alt');
    await draft(q, 'by-account', 'alt');
    await draft(q, 'other', 'lokkju');
    await writeDraftCache(q.session, {
      queuePubkey: q.pubkey,
      syncedAt: 1,
      drafts: [
        {
          d: 'by-account',
          updatedAt: 1,
          site: 'x',
          account: 'alt',
          field: 'text',
          status: 'active',
          content: 'draft by-account',
        },
      ],
    });
    expect(await removeDestination('dest-x-alt', q.deps)).toEqual({ dismissed: 2 });
    expect(await statuses(q)).toEqual({
      'by-id': 'archived:dismissed',
      'by-account': 'archived:dismissed',
      other: 'active',
    });
    const list = await listOnRelays(q);
    expect(list.map((d) => d.account)).toEqual(['lokkju']);
    const cache = await readDraftCache(q.session);
    expect(cache?.drafts[0]?.status).toBe('archived:dismissed');
    expect(cache?.destinations?.map((d) => d.account)).toEqual(['lokkju']);
    await expect(removeDestination('dest-x-alt', q.deps)).rejects.toThrow(/gone/);
    q.close();
  });

  it('leaves the destination when a draft cannot be dismissed', async () => {
    const q = await destinationsQueue();
    await draft(q, 'by-account', 'alt');
    q.net.get(STORAGE[1] as string).options.refuseKinds = [KIND_DRAFT_WRAP];
    await expect(removeDestination('dest-x-alt', q.deps)).rejects.toThrow(/so it stays/);
    expect((await listOnRelays(q)).map((d) => d.id)).toEqual(['dest-x-alt']);
    q.close();
  });
});

describe('while locked', { timeout: 30_000 }, () => {
  it('refuses every write and publishes nothing', async () => {
    const q = await destinationsQueue();
    await q.store.lock();
    const before = q.net.get(STORAGE[0] as string).events.length;
    const locked = 'Unlock the queue first.';
    await expect(
      addDestination({ site: 'x', account: 'lokkju', override: null }, source, q.deps)
    ).rejects.toThrow(locked);
    await expect(
      editDestination('dest-x-alt', { label: 'New', override: null }, source, q.deps)
    ).rejects.toThrow(locked);
    await expect(removeDestination('dest-x-alt', q.deps)).rejects.toThrow(locked);
    await expect(loadDestinations(q.deps)).rejects.toThrow(locked);
    expect(q.net.get(STORAGE[0] as string).events.length).toBe(before);
    expect((await q.store.record()) as QueueRecord).toBeDefined();
    q.close();
  });
});

describe('destinations screen', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const evilSource = definitionSource([
    {
      id: 'evil',
      version: '2026.10.1',
      name: `<b>Evil</b>`,
      match: [],
      fields: [],
    },
  ]);

  it('renders labels, accounts and site names as text', () => {
    const html = renderToString(
      <DestinationList
        destinations={[
          {
            id: 'a',
            site: 'evil',
            account: '<i>acct</i>',
            label: evil,
            status: 'pending',
            override: { match: ['https://evil.example/*'] },
          },
          {
            id: 'b',
            site: 'custom<script>',
            account: 'me',
            label: 'Mine',
            status: 'confirmed',
            override: null,
          },
        ]}
        source={evilSource}
        busy={false}
        confirmingId="a"
        onEdit={() => {}}
        onAskRemove={() => {}}
        onRemove={() => {}}
      />
    );
    expect(html).not.toMatch(/<(img|i|b|script)[ >]/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;b>Evil&lt;/b>');
    expect(html).toContain('&lt;i>acct&lt;/i>');
    expect(html).toContain('custom&lt;script> (custom)');
    expect(html).toContain('confirm or reject it under Agents');
    expect(html).toContain('Remove and dismiss its drafts');
    // Confirmed first.
    expect(html.indexOf('Mine')).toBeLessThan(html.indexOf('&lt;img'));
  });

  it('offers the registry sites and Custom, asking for match patterns where needed', () => {
    const choices = siteChoices(evilSource);
    expect(choices).toEqual([{ id: 'evil', name: '<b>Evil</b>', needsMatch: true }]);
    const values = { ...emptyAdd(choices), account: evil };
    const html = renderToString(
      <AddDestinationForm
        choices={choices}
        source={evilSource}
        values={values}
        canDetect={true}
        busy={undefined}
        detectNote={`This tab isn't on ${evil}.`}
        error={undefined}
        onChange={() => {}}
        onDetect={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).not.toMatch(/<(img|b)[ >]/);
    expect(html).toContain('>&lt;b>Evil&lt;/b></option>');
    expect(html).toContain('Custom…');
    expect(html).toContain('Detect from this tab');
    expect(html).toContain('Match patterns');
    expect(html).toContain('placeholder="&lt;b>Evil&lt;/b> / &lt;img src=x onerror=alert(1)>"');
    expect(
      addInput({ ...values, patterns: 'https://a.example/*\nhttps://b.example/*' }, choices)
    ).toMatchObject({
      site: 'evil',
      custom: false,
      override: { match: ['https://a.example/*', 'https://b.example/*'] },
    });
    // X has fixed hosts: no patterns field, no override unless typed.
    const x = siteChoices(source);
    expect(addInput({ ...emptyAdd(x), account: 'me' }, x)).toMatchObject({
      site: 'x',
      needsMatch: false,
      override: null,
    });
    expect(
      addInput({ ...emptyAdd(x), choice: '', customSite: ' myblog ', patterns: '' }, x)
    ).toMatchObject({ site: 'myblog', custom: true, override: { match: [] } });
  });

  it('shows the override as text in the edit form', () => {
    const html = renderToString(
      <EditDestinationForm
        destination={{
          id: 'a',
          site: 'x',
          account: 'alt',
          label: evil,
          status: 'confirmed',
          override: null,
        }}
        label={evil}
        override={'{"name": "</textarea><script>alert(1)</script>"}'}
        busy={undefined}
        error={undefined}
        onLabel={() => {}}
        onOverride={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).not.toMatch(/<(img|script)[ >]/);
    expect(html).toContain('Edit &lt;img src=x onerror=alert(1)>');
  });

  it('offers to add a detected account in the insert panel, as text', () => {
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        page={{ matching: [], otherAccounts: 0, detected: { x: evil }, elsewhere: [] }}
        undetected={[]}
        armed={undefined}
        showElsewhere={false}
        status={undefined}
        unrecorded={0}
        busy={false}
        offers={[{ site: 'x', siteName: '<u>X</u>', account: evil }]}
        onAddOffer={() => {}}
        onArm={() => {}}
        onDisarm={() => {}}
        onInsert={() => {}}
        onRetry={() => {}}
        onToggleElsewhere={() => {}}
      />
    );
    expect(html).not.toMatch(/<(img|u)[ >]/);
    expect(html).toContain(
      'Add &lt;img src=x onerror=alert(1)> on &lt;u>X&lt;/u> as a destination'
    );
  });

  it('says why detection found nothing', () => {
    expect(detectionMessage({ state: 'detected', account: 'a' }, 'X')).toBeUndefined();
    expect(detectionMessage({ state: 'other_site' }, 'X')).toBe("This tab isn't on X.");
    expect(detectionMessage({ state: 'undetected' }, 'X')).toMatch(/Couldn't tell/);
    expect(detectionMessage({ state: 'no_locator' }, 'X')).toMatch(/type it/);
    expect(detectionMessage({ state: 'no_tab' }, 'X')).toMatch(/can't read this tab/);
  });
});
