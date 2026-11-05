// Spec 7, "Unknown fields": devices on different builds share one queue, so data a device reads
// and republishes keeps what it does not know; agent input and site definitions do not.
import { npubEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import {
  buildAgentGrant,
  buildDestinations,
  buildDraftWrap,
  buildRecoveryBackup,
  buildRotationMarker,
  buildSettings,
  buildSubmittersList,
  D_DESTINATIONS,
  D_RECOVERY,
  D_ROTATED,
  D_SETTINGS,
  encodeNcryptsec,
  fieldValueFromSubmission,
  fieldValueRumor,
  giftWrap,
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  KIND_FIELD_VALUE,
  KIND_SITE_DEF,
  KIND_SUBMITTERS,
  nip44Decrypt,
  nip44Encrypt,
  openSubmission,
  parseAgentGrant,
  parseDestinations,
  parseDraftWrap,
  parseFieldValue,
  parseRecoveryBackup,
  parseRotationMarker,
  parseSettings,
  parseSiteDefinition,
  parseSiteDefinitionEvent,
  parseSubmittersList,
} from '../src/index.ts';
import {
  agent,
  agentPubkey,
  DAY,
  exampleValue,
  expectError,
  expectOk,
  NOW,
  otherKey,
  otherPubkey,
  queue,
  queueKey,
  queuePubkey,
  sign,
  WRAP_ID,
} from './helpers.ts';

const toQueue = (plaintext: string) => nip44Encrypt(queueKey, queuePubkey, plaintext);
const fromQueue = (payload: string) => nip44Decrypt(queueKey, queuePubkey, payload);
const appData = (d: string, plaintext: string, extraTags: string[][] = []) =>
  sign({
    kind: KIND_APP_DATA,
    created_at: NOW,
    tags: [['d', d], ...extraTags],
    content: toQueue(plaintext),
  });

// Unknown keys written after the known ones, which is the order builders write: the rebuilt
// content is then byte-identical. Known keys always come back in spec order, so a source with
// unknown keys interleaved round-trips equal as JSON but not byte for byte.
const destinationsJson =
  '{"destinations":[{"id":"01JA","site":"x","account":"lokkju","label":"X","status":"confirmed","override":null,"colour":"blue","pinned":{"at":[1,2]}}],"sort":"label"}';
const settingsJson = `{"archive_retention_days":30,"quota_counts":{"${agentPubkey}":{"period_start":0,"accepted":[],"discarded":[],"rejected":["${WRAP_ID}"]}},"theme":"dark"}`;

describe('data devices republish keeps unknown fields', () => {
  it('field value rumor: unknown tags and inserted strategies survive a rebuild', async () => {
    // A newer build's strategy in an inserted tag, and tags this build does not know.
    const known = fieldValueRumor({
      ...exampleValue,
      inserted: [
        ...exampleValue.inserted,
        {
          at: 1_761_400_300,
          url: 'https://x.com/',
          strategy: 'dragAndDrop',
          method: 'popup',
          accessibleName: '',
          detectedAccount: '',
        },
      ],
    });
    const rumor = {
      ...known,
      tags: [...known.tags, ['client', 'qus.me', '2.0'], ['lang', 'en']],
    };
    const parsed = expectOk(parseFieldValue(rumor));
    expect(parsed.extraTags).toEqual([
      ['client', 'qus.me', '2.0'],
      ['lang', 'en'],
    ]);
    expect(parsed.inserted.at(-1)?.strategy).toBe('dragAndDrop');
    expect(fieldValueRumor(parsed)).toEqual(rumor);

    const plaintext = JSON.stringify(rumor);
    const wrap = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: [
        ['d', 'x'],
        ['k', String(KIND_FIELD_VALUE)],
      ],
      content: toQueue(plaintext),
    });
    const opened = expectOk(await parseDraftWrap(wrap, queue));
    if (opened.deleted) throw new Error('unexpected deletion');
    const rebuilt = await buildDraftWrap(queue, { d: 'x', draft: opened.draft });
    expect(fromQueue(rebuilt.content)).toBe(plaintext);
  });

  it('field value rumor: extra tags may not shadow known or reserved tags', () => {
    expect(() => fieldValueRumor({ ...exampleValue, extraTags: [['status', 'active']] })).toThrow();
    expect(() => fieldValueRumor({ ...exampleValue, extraTags: [['target', 'x']] })).toThrow();
  });

  it('destinations: unknown keys at every level come back byte-identical', async () => {
    const tags = [['client', 'qus.me']];
    const parsed = expectOk(
      await parseDestinations(appData(D_DESTINATIONS, destinationsJson, tags), queue)
    );
    expect(parsed.content.extra).toEqual({ sort: 'label' });
    expect(parsed.content.destinations[0]?.extra).toEqual({
      colour: 'blue',
      pinned: { at: [1, 2] },
    });
    expect(parsed.extraTags).toEqual(tags);
    const rebuilt = await buildDestinations(queue, parsed.content, { extraTags: parsed.extraTags });
    expect(fromQueue(rebuilt.content)).toBe(destinationsJson);
    expect(rebuilt.tags).toEqual([['d', D_DESTINATIONS], ...tags]);
  });

  it('settings: unknown keys at every level come back byte-identical', async () => {
    const parsed = expectOk(await parseSettings(appData(D_SETTINGS, settingsJson), queue));
    expect(parsed.content.extra).toEqual({ theme: 'dark' });
    expect(parsed.content.quota_counts[agentPubkey]?.extra).toEqual({ rejected: [WRAP_ID] });
    expect(fromQueue((await buildSettings(queue, parsed.content)).content)).toBe(settingsJson);
  });

  it('keeps the prototype and depth guards on unknown keys', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    for (const plaintext of [
      '{"destinations":[],"x":{"__proto__":{"admin":true}}}',
      `{"destinations":[],"x":${JSON.stringify(deep)}}`,
    ]) {
      expectError(
        await parseDestinations(appData(D_DESTINATIONS, plaintext), queue),
        'invalid_content'
      );
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    await expect(
      buildSettings(queue, { quota_counts: {}, extra: { theme: 'dark', quota_counts: 1 } })
    ).rejects.toThrow(/reserved/);
  });

  it('recovery backup: extra tags survive a rebuild', async () => {
    const ncryptsec = encodeNcryptsec(queueKey, 'pw', { logN: 16 });
    const tags = [['alt', 'qus.me recovery']];
    const event = sign({
      kind: KIND_APP_DATA,
      created_at: NOW,
      tags: [['d', D_RECOVERY], ...tags],
      content: ncryptsec,
    });
    const parsed = expectOk(parseRecoveryBackup(event));
    expect(parsed.extraTags).toEqual(tags);
    const rebuilt = await buildRecoveryBackup(queue, parsed.ncryptsec, {
      extraTags: parsed.extraTags,
    });
    expect(rebuilt.tags).toEqual(event.tags);
    await expect(
      buildRecoveryBackup(queue, ncryptsec, { extraTags: [['d', 'other']] })
    ).rejects.toThrow();
  });

  it('rotation marker: unknown keys come back byte-identical', async () => {
    const plaintext = `{"npub":"${npubEncode(otherPubkey)}","reason":"lost phone"}`;
    const parsed = expectOk(await parseRotationMarker(appData(D_ROTATED, plaintext), queue));
    expect(parsed.extra).toEqual({ reason: 'lost phone' });
    const rebuilt = await buildRotationMarker(queue, parsed.newPubkey, { extra: parsed.extra });
    expect(fromQueue(rebuilt.content)).toBe(plaintext);
  });

  it('submitters labels: unknown keys come back byte-identical, extra tags kept', async () => {
    const plaintext = `{"${agentPubkey}":{"label":"Claude","authorized_at":1,"client_id":"https://c.example/"},"version":2}`;
    const event = sign({
      kind: KIND_SUBMITTERS,
      created_at: NOW,
      tags: [
        ['p', agentPubkey],
        ['alt', 'submitters'],
      ],
      content: toQueue(plaintext),
    });
    const parsed = expectOk(await parseSubmittersList(event, queue));
    expect(parsed.extra).toEqual({ version: 2 });
    expect(parsed.labels[agentPubkey]?.extra).toEqual({ client_id: 'https://c.example/' });
    const rebuilt = await buildSubmittersList(queue, parsed.labels, {
      extra: parsed.extra,
      extraTags: parsed.extraTags,
    });
    expect(fromQueue(rebuilt.content)).toBe(plaintext);
    expect(rebuilt.tags).toEqual(event.tags);
    await expect(buildSubmittersList(queue, {}, { extra: { [agentPubkey]: 1 } })).rejects.toThrow();
  });
});

describe('agent grants: kept on the queue side, ignored on the agent side', () => {
  const plaintext = `{"inbox":["wss://relay.example/"],"inbox_pubkey":"${otherPubkey}","min_pow":0,"destinations":[{"site":"x","account":"lokkju","fields":["text"],"note":"main"}],"allow_new_destinations":false,"submission_expiration_days":30,"quota":{"max_submissions":5,"period":"day","burst":2},"expires_at":null,"scopes":["drafts"]}`;
  const event = sign({
    kind: KIND_AGENT_GRANT,
    created_at: NOW,
    tags: [
      ['d', agentPubkey],
      ['alt', 'grant'],
    ],
    content: nip44Encrypt(queueKey, agentPubkey, plaintext),
  });

  it('queue side keeps unknown keys and tags and rebuilds byte-identical', async () => {
    const parsed = expectOk(await parseAgentGrant(event, queue));
    expect(parsed.grant.extra).toEqual({ scopes: ['drafts'] });
    expect(parsed.grant.quota.extra).toEqual({ burst: 2 });
    expect(parsed.grant.destinations[0]?.extra).toEqual({ note: 'main' });
    const rebuilt = await buildAgentGrant(queue, agentPubkey, parsed.grant, {
      extraTags: parsed.extraTags,
    });
    expect(nip44Decrypt(queueKey, agentPubkey, rebuilt.content)).toBe(plaintext);
    expect(rebuilt.tags).toEqual(event.tags);
  });

  it('agent side reads the known fields and drops the rest', async () => {
    const parsed = expectOk(await parseAgentGrant(event, agent));
    expect(parsed.grant).not.toHaveProperty('extra');
    expect(parsed.grant.quota).toEqual({ max_submissions: 5, period: 'day' });
    expect(parsed.grant.destinations).toEqual([{ site: 'x', account: 'lokkju', fields: ['text'] }]);
    expect(parsed).not.toHaveProperty('extraTags');
  });
});

describe('agent submissions stay strict', () => {
  const submit = (tags: string[][]) =>
    giftWrap(
      {
        kind: KIND_FIELD_VALUE,
        created_at: NOW,
        content: 'x',
        tags: [['site', 'x'], ['account', 'lokkju'], ['field', 'text'], ...tags],
      },
      agent,
      queuePubkey,
      { now: NOW, expiration: NOW + DAY }
    );

  it('drops unknown tags and reports them', async () => {
    const opened = expectOk(
      await openSubmission(
        await submit([
          ['client', 'agent'],
          ['target', 'u'],
        ]),
        queue
      )
    );
    expect(opened.ignoredTags).toEqual([['client', 'agent']]);
    expect(opened.value.reserved).toEqual([['target', 'u']]);
    const draft = fieldValueFromSubmission(opened);
    expect(draft).not.toHaveProperty('extraTags');
    expect(fieldValueRumor(draft).tags).not.toContainEqual(['client', 'agent']);
  });

  it('still refuses draft state tags', async () => {
    for (const tag of [
      ['status', 'active'],
      ['source', WRAP_ID, agentPubkey],
      ['inserted', '1', '', 'paste', 'popup', '', ''],
      ['destination', '01JA'],
    ]) {
      expectError(await openSubmission(await submit([tag]), queue), 'invalid_tags');
    }
  });

  it('builders never produce ignored tags', async () => {
    expect(() => fieldValueRumor({ ...exampleValue, reserved: [['client', 'x']] })).toThrow();
  });
});

describe('site definitions ignore unknown keys', () => {
  const field = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    label: name,
    locators: [{ role: 'textbox', name: { en: [name] }, nth: 0 }],
    inject: ['paste', 'clipboard'],
    constraints: { maxLength: 10, minLength: 1 },
    hint: 'newer key',
    ...extra,
  });
  const definition = {
    id: 'example',
    version: '2027.1.1',
    name: 'Example',
    match: ['https://example.com/*'],
    account: {
      locator: { role: 'link', name: { en: ['Profile'] } },
      extract: '(.+)',
      fallback: 'x',
    },
    fields: [
      field('text'),
      field('title', { inject: ['paste', 'shadowDom', 'clipboard'] }),
      field('bio', { constraints: { counter: 'words' } }),
    ],
    icon: 'https://example.com/icon.svg',
  };

  it('ignores unknown keys and sets aside fields naming unknown strategies or counters', () => {
    const parsed = expectOk(parseSiteDefinition(definition));
    expect(parsed).not.toHaveProperty('icon');
    expect(parsed.account).toEqual({
      locator: { role: 'link', name: { en: ['Profile'] } },
      extract: '(.+)',
    });
    expect(parsed.fields).toEqual([
      {
        name: 'text',
        label: 'text',
        locators: [{ role: 'textbox', name: { en: ['text'] } }],
        inject: ['paste', 'clipboard'],
        constraints: { maxLength: 10 },
      },
    ]);
    expect(parsed.unusableFields).toEqual([
      { name: 'title', reason: 'unknown injection strategy shadowDom' },
      { name: 'bio', reason: 'unknown counter words' },
    ]);
  });

  it('parses the same from a signed event', () => {
    const event = sign(
      {
        kind: KIND_SITE_DEF,
        created_at: NOW,
        tags: [['d', 'example']],
        content: JSON.stringify(definition),
      },
      otherKey
    );
    const parsed = expectOk(parseSiteDefinitionEvent(event, { publisherPubkey: otherPubkey }));
    expect(parsed.definition.fields.map((f) => f.name)).toEqual(['text']);
  });

  it('keeps the strict checks on known fields', () => {
    expectError(parseSiteDefinition({ ...definition, version: 'next' }), 'invalid_content');
    expectError(
      parseSiteDefinition({
        ...definition,
        fields: [field('a', { inject: ['clipboard', 'paste'] })],
      }),
      'invalid_content'
    );
    expectError(parseSiteDefinition(JSON.parse('{"__proto__":{"evil":1}}')), 'invalid_content');
  });
});
