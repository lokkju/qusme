import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type AgentGrantInput,
  buildAgentGrant,
  buildSubmittersList,
  createLocalSigner,
  KIND_SUBMITTERS,
  openSubmission,
  powOf,
  type Signer,
} from '@qusme/nostr';
import { hashSecret, type QusmeDb, type Store, schema } from '@qusme/store-sql';
import { generateSecretKey } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';
import { renameTable } from '../../../store-sql/test/harness.ts';
import {
  createAgentKeyCustody,
  createAgentKeyRing,
  createApp,
  DEFAULT_MAX_POW,
  type LimitsOptions,
  type McpNotice,
  type McpOverrides,
  POW_BYTES_PER_HASH,
  type RateClassName,
  type RateLimiter,
  TIERS,
} from '../../src/index.ts';
import { fakeStorage, recordingPublisher } from './fakes.ts';

/** A fresh, migrated, empty store on one driver. */
export interface Harness {
  store: Store;
  db: QusmeDb;
}

const ORIGIN = 'https://app.qus.me';
const CLIENT_ID = 'https://client.example/oauth/client-metadata.json';
const STORAGE = ['wss://storage.example/', 'wss://storage2.example/'];
const INBOX = ['wss://inbox.example/'];
const DAY = 86_400;
// 2026-10-28T15:30:00Z, a Wednesday.
const T0 = Date.UTC(2026, 9, 28, 15, 30) / 1000;
const ring = createAgentKeyRing({ secret: btoa('m'.repeat(32)) });

const locator = (name: string) => [{ role: 'textbox', name: { en: [name] } }];
export const REGISTRY = [
  {
    id: 'x',
    version: '2026.10.1',
    name: 'X',
    match: ['https://x.com/*'],
    fields: [
      {
        name: 'text',
        label: 'Post text',
        locators: locator('Post text'),
        inject: ['paste', 'clipboard'],
        constraints: { maxLength: 280, counter: 'twitter-text' },
      },
    ],
  },
  {
    id: 'mastodon',
    version: '2026.10.1',
    name: 'Mastodon',
    match: [],
    fields: [
      {
        name: 'text',
        label: 'Post text',
        locators: locator('Post text'),
        inject: ['paste'],
        constraints: { maxLength: 500 },
      },
      {
        name: 'poll',
        label: 'Poll',
        locators: locator('Poll'),
        inject: ['telepathy'],
      },
    ],
  },
];

type Structured = Record<string, unknown> & { error?: string };
interface CallResult {
  isError?: boolean;
  structuredContent?: Structured;
  content?: { type: string; text?: string }[];
}

export function mcpToolsSuite(driver: string, setup: () => { fresh(): Promise<Harness> }) {
  describe(`MCP tools on ${driver}`, { timeout: 30_000 }, () => {
    const { fresh } = setup();
    let h: Harness;
    let clock: number;
    let storage: ReturnType<typeof fakeStorage>;
    let inbox: ReturnType<typeof recordingPublisher>;
    let queue: Signer;
    let queuePubkey: string;
    let inboxKey: Signer;
    let inboxPubkey: string;
    let app: ReturnType<typeof createApp>;

    const makeApp = (overrides: McpOverrides = {}, limits?: LimitsOptions) =>
      createApp({
        version: 'test',
        db: h.db,
        agentKeys: ring,
        publicOrigin: ORIGIN,
        ...(limits && { limits }),
        mcp: {
          registry: REGISTRY,
          relayReader: storage.reader,
          relayPublisher: inbox.publisher,
          now: () => clock,
          grantCacheSeconds: 0,
          ...overrides,
        },
      });

    beforeEach(async () => {
      h = await fresh();
      clock = T0;
      storage = fakeStorage();
      inbox = recordingPublisher();
      queue = createLocalSigner(generateSecretKey());
      queuePubkey = await queue.getPublicKey();
      inboxKey = createLocalSigner(generateSecretKey());
      inboxPubkey = await inboxKey.getPublicKey();
      app = makeApp();
    });

    /** An agent key bound to the queue with a live access token, as an approval leaves it. */
    async function bindAgent(boundQueue = queuePubkey) {
      const now = Math.floor(Date.now() / 1000);
      await h.store.oauthClients.upsert({
        clientId: CLIENT_ID,
        metadata: {},
        clientName: 'Example Agent',
        redirectUris: [],
        registrationSource: 'metadata_document',
        fetchedAt: now,
        createdAt: now,
      });
      const key = await createAgentKeyCustody(h.store, ring).mint({ clientId: CLIENT_ID, now });
      await h.store.bindings.create({
        agentKeyId: key.id,
        queuePubkey: boundQueue,
        clientLabel: 'Example Agent',
        storageRelays: STORAGE,
        createdAt: now,
        updatedAt: now,
      });
      const token = `qat_${crypto.randomUUID()}`;
      await h.store.oauthTokens.create({
        tokenHash: await hashSecret(token),
        kind: 'access',
        clientId: CLIENT_ID,
        agentKeyId: key.id,
        scopes: 'drafts:submit',
        createdAt: now,
        expiresAt: now + 3600,
      });
      return { key, token };
    }

    const baseGrant = (): AgentGrantInput => ({
      inbox: INBOX,
      inbox_pubkey: inboxPubkey,
      destinations: [
        { site: 'x', account: 'lokkju', fields: ['text'] },
        {
          site: 'mastodon',
          account: 'lokkju@mastodon.social',
          fields: ['text', 'poll'],
          override: {
            match: ['https://mastodon.social/*'],
            fields: [{ name: 'text', constraints: { maxLength: 1000 } }],
          },
        },
        {
          site: 'blog',
          account: 'me',
          fields: ['body'],
          override: { match: ['https://blog.example/*'] },
        },
      ],
      quota: { max_submissions: 3, period: 'day' },
    });

    async function grant(agentPubkey: string, input: Partial<AgentGrantInput> = {}, at = clock) {
      const event = await buildAgentGrant(
        queue,
        agentPubkey,
        { ...baseGrant(), ...input },
        { createdAt: at }
      );
      storage.publish(event, STORAGE);
      return event;
    }

    async function connect(token: string, target = app) {
      const client = new Client({ name: 'test-agent', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: async (url, init) => target.request(String(url), init),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      return client;
    }

    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallResult;
    }

    async function granted(input: Partial<AgentGrantInput> = {}) {
      const agent = await bindAgent();
      await grant(agent.key.pubkey, input);
      return { ...agent, client: await connect(agent.token) };
    }

    const draft = (value: string, extra: Record<string, unknown> = {}) => ({
      site: 'x',
      account: 'lokkju',
      field: 'text',
      value,
      ...extra,
    });

    it('lists the five tools with their input schemas', async () => {
      const { client } = await granted();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'create_draft',
        'get_definition',
        'list_destinations',
        'list_registry',
        'list_submissions',
      ]);
      const create = tools.find((t) => t.name === 'create_draft');
      expect(create?.inputSchema.required).toEqual(['site', 'account', 'field', 'value']);
      expect(Object.keys(create?.inputSchema.properties ?? {})).toContain('lenient');
      expect(create?.outputSchema).toBeDefined();
    });

    it('lists the registry without a grant', async () => {
      const agent = await bindAgent();
      const client = await connect(agent.token);
      const res = await call(client, 'list_registry');
      expect(res.isError).toBeFalsy();
      const sites = res.structuredContent?.sites as { id: string; fields: unknown[] }[];
      expect(sites.map((s) => s.id)).toEqual(['x', 'mastodon']);
      expect(sites[0]?.fields).toEqual([
        {
          name: 'text',
          label: 'Post text',
          constraints: { maxLength: 280, counter: 'twitter-text' },
        },
      ]);
      // The field naming an unknown injection strategy is left out, as devices leave it out.
      expect(sites[1]?.fields).toHaveLength(1);
    });

    it('denies every other tool without a grant, or with an expired one', async () => {
      const agent = await bindAgent();
      const client = await connect(agent.token);
      for (const [name, args] of [
        ['list_destinations', {}],
        ['get_definition', { site: 'x', account: 'lokkju' }],
        ['create_draft', draft('hi')],
        ['list_submissions', {}],
      ] as const) {
        const res = await call(client, name, args);
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.error).toBe('grant_not_found');
      }
      await grant(agent.key.pubkey, { expires_at: clock });
      const expired = await call(client, 'list_destinations');
      expect(expired.structuredContent).toMatchObject({
        error: 'grant_expired',
        expires_at: clock,
      });
      expect(inbox.published).toHaveLength(0);
    });

    it('reads the grant as the agent key and ignores one not signed by the bound queue', async () => {
      const agent = await bindAgent();
      const stranger = createLocalSigner(generateSecretKey());
      storage.publish(
        await buildAgentGrant(stranger, agent.key.pubkey, {
          ...baseGrant(),
          allow_new_destinations: true,
        }),
        STORAGE
      );
      const client = await connect(agent.token);
      expect((await call(client, 'list_destinations')).structuredContent?.error).toBe(
        'grant_not_found'
      );
      // The newest of the queue's grants wins.
      await grant(agent.key.pubkey, { quota: { max_submissions: 1, period: 'week' } }, clock - 10);
      await grant(agent.key.pubkey, {}, clock - 5);
      const res = await call(client, 'list_destinations');
      expect(res.structuredContent?.quota).toMatchObject({ max_submissions: 3, period: 'day' });
      expect(res.structuredContent?.allow_new_destinations).toBe(false);
      const last = storage.queries.findLast((q) => q.query.filter['#d'] !== undefined);
      expect(last?.authPubkey).toBe(agent.key.pubkey);
      expect(last?.query.relays).toEqual(STORAGE);
      expect(last?.query.filter).toMatchObject({
        authors: [queuePubkey],
        '#d': [agent.key.pubkey],
      });
    });

    it('lists destinations with effective constraints and the quota left', async () => {
      const { client } = await granted();
      const res = await call(client, 'list_destinations');
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual({
        destinations: [
          {
            site: 'x',
            account: 'lokkju',
            fields: [
              {
                name: 'text',
                label: 'Post text',
                constraints: { maxLength: 280, counter: 'twitter-text' },
              },
            ],
          },
          {
            site: 'mastodon',
            account: 'lokkju@mastodon.social',
            fields: [
              { name: 'text', label: 'Post text', constraints: { maxLength: 1000 } },
              { name: 'poll', constraints: null },
            ],
          },
          { site: 'blog', account: 'me', fields: [{ name: 'body', constraints: null }] },
        ],
        allow_new_destinations: false,
        submission_expiration_days: 30,
        expires_at: null,
        quota: {
          max_submissions: 3,
          period: 'day',
          used: 0,
          remaining: 3,
          period_start: Date.UTC(2026, 9, 28) / 1000,
          resets_at: Date.UTC(2026, 9, 29) / 1000,
        },
      });
    });

    it('returns effective definitions: override merged, official for a new destination', async () => {
      const { client } = await granted();
      const mastodon = await call(client, 'get_definition', {
        site: 'mastodon',
        account: 'lokkju@mastodon.social',
      });
      expect(mastodon.structuredContent).toMatchObject({ granted: true });
      const def = mastodon.structuredContent?.definition as {
        match: string[];
        fields: { name: string; constraints: unknown }[];
      };
      expect(def.match).toEqual(['https://mastodon.social/*']);
      expect(def.fields[0]?.constraints).toEqual({ maxLength: 1000 });

      const custom = await call(client, 'get_definition', { site: 'blog', account: 'me' });
      expect(custom.structuredContent).toMatchObject({ granted: true, definition: null });

      const outside = await call(client, 'get_definition', { site: 'x', account: 'someone' });
      expect(outside.structuredContent).toMatchObject({
        error: 'destination_not_granted',
        site: 'x',
        account: 'someone',
      });

      await grant((await bindAgent()).key.pubkey);
      const open = await granted({ allow_new_destinations: true });
      const official = await call(open.client, 'get_definition', { site: 'x', account: 'other' });
      expect(official.structuredContent).toMatchObject({ granted: false });
      expect(official.structuredContent?.definition).toMatchObject({ id: 'x' });
      const unknown = await call(open.client, 'get_definition', { site: 'nope', account: 'a' });
      expect(unknown.structuredContent).toMatchObject({ granted: false, definition: null });
    });

    it('creates a draft: a gift wrap to the inbox key, sealed by the agent, and a receipt', async () => {
      const { client, key } = await granted();
      const res = await call(client, 'create_draft', draft('hello from an agent'));
      expect(res.isError).toBeFalsy();
      const receipt = res.structuredContent ?? {};
      expect(receipt).toMatchObject({
        created_at: clock,
        expires_at: clock + 30 * DAY,
        relays: INBOX,
        validation: { counter: 'twitter-text', length: 19, max: 280, ok: true },
        pending_destination: false,
      });

      expect(inbox.published).toHaveLength(1);
      const sent = inbox.published[0];
      expect(sent?.relay).toBe(INBOX[0]);
      const wrap = sent?.event;
      expect(wrap?.id).toBe(receipt.gift_wrap_id);
      expect(wrap?.tags).toContainEqual(['p', inboxPubkey]);
      expect(wrap?.tags).toContainEqual(['expiration', String(clock + 30 * DAY)]);
      // The connection authenticates as a key of its own first, the agent key only as fallback.
      expect(sent?.authPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(sent?.authPubkey).not.toBe(key.pubkey);
      expect(sent?.fallbackPubkey).toBe(key.pubkey);
      // The agent key's signer is closed once the call has returned.
      await expect(sent?.request.fallbackAuth?.getPublicKey()).rejects.toThrow(/after its call/);

      const opened = await openSubmission(wrap, inboxKey);
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.submitter).toBe(key.pubkey);
      expect(opened.value.wrapId).toBe(wrap?.id);
      expect(opened.value.value).toMatchObject({
        site: 'x',
        account: 'lokkju',
        field: 'text',
        content: 'hello from an agent',
        createdAt: clock,
        validation: { counter: 'twitter-text', length: 19, max: 280, ok: true },
      });
      // Queue key cannot open it: it is addressed to the inbox key.
      expect((await openSubmission(wrap, queue)).ok).toBe(false);

      const row = await h.store.submissionReceipts.get(String(receipt.gift_wrap_id), clock);
      expect(row).toEqual({
        giftWrapId: receipt.gift_wrap_id,
        agentKeyId: key.id,
        queuePubkey,
        createdAt: clock,
        expiresAt: clock + 30 * DAY,
      });
    });

    it('keeps no plaintext in any table after publishing', async () => {
      const { client } = await granted();
      const value = `secret plan ${crypto.randomUUID()}`;
      expect((await call(client, 'create_draft', draft(value))).isError).toBeFalsy();
      const tables = [
        schema.oauthClients,
        schema.agentKeys,
        schema.pendingAuthorizations,
        schema.oauthCodes,
        schema.oauthTokens,
        schema.bindings,
        schema.submissionReceipts,
        schema.pairingSessions,
        schema.nip98Replays,
        schema.hostedQueues,
      ];
      let rows = 0;
      for (const table of tables) {
        const all = await h.db.select().from(table).all();
        rows += all.length;
        expect(JSON.stringify(all)).not.toContain(value);
      }
      expect(rows).toBeGreaterThan(3);
    });

    it('sets the receipt to outlive the wrap or the quota period, whichever is later', async () => {
      const { client } = await granted({
        submission_expiration_days: 1,
        quota: { max_submissions: 5, period: 'month' },
      });
      const res = await call(client, 'create_draft', draft('short-lived'));
      expect(res.structuredContent?.expires_at).toBe(clock + DAY);
      const row = await h.store.submissionReceipts.get(
        String(res.structuredContent?.gift_wrap_id),
        clock
      );
      expect(row?.expiresAt).toBe(Date.UTC(2026, 10, 1) / 1000);
    });

    it('refuses a constraint violation, accepts it when lenient, never past 32 KiB', async () => {
      const { client } = await granted();
      const long = 'a'.repeat(281);
      const strict = await call(client, 'create_draft', draft(long));
      expect(strict.isError).toBe(true);
      expect(strict.structuredContent).toMatchObject({
        error: 'constraint_violation',
        lenient_allowed: true,
        violations: [
          {
            field: 'text',
            constraint: 'maxLength',
            limit: 280,
            actual: 281,
            counter: 'twitter-text',
          },
        ],
      });
      expect(inbox.published).toHaveLength(0);
      expect(
        await h.store.submissionReceipts.countSince(
          (await h.store.bindings.listByQueue(queuePubkey))[0]?.agentKeyId ?? '',
          0
        )
      ).toBe(0);

      const lenient = await call(client, 'create_draft', draft(long, { lenient: true }));
      expect(lenient.isError).toBeFalsy();
      expect(lenient.structuredContent?.validation).toEqual({
        counter: 'twitter-text',
        length: 281,
        max: 280,
        ok: false,
        lenient: true,
        violations: [{ constraint: 'maxLength', limit: 280, actual: 281, counter: 'twitter-text' }],
      });
      const opened = await openSubmission(inbox.published[0]?.event, inboxKey);
      expect(opened.ok && opened.value.value.validation).toMatchObject({
        ok: false,
        lenient: true,
      });

      // A custom destination has no definition, so only the cap applies, lenient or not.
      const huge = 'é'.repeat(16_385);
      for (const lenientFlag of [false, true]) {
        const capped = await call(client, 'create_draft', {
          site: 'blog',
          account: 'me',
          field: 'body',
          value: huge,
          lenient: lenientFlag,
        });
        expect(capped.structuredContent).toMatchObject({
          error: 'constraint_violation',
          lenient_allowed: false,
          violations: [{ field: 'body', constraint: 'maxBytes', limit: 32_768, actual: 32_770 }],
        });
      }
      expect(inbox.published).toHaveLength(1);
    });

    it('validates against the override merged over the official definition', async () => {
      const { client } = await granted();
      const res = await call(client, 'create_draft', {
        site: 'mastodon',
        account: 'lokkju@mastodon.social',
        field: 'text',
        value: 'b'.repeat(800),
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.validation).toEqual({
        counter: 'default',
        length: 800,
        max: 1000,
        ok: true,
      });
    });

    it('refuses a field outside the grant, unknown to the definition, or unusable', async () => {
      const { client } = await granted({
        destinations: [
          { site: 'x', account: 'lokkju', fields: ['text', 'title'] },
          { site: 'mastodon', account: 'a@b.social', fields: ['text', 'poll'] },
        ],
      });
      const notGranted = await call(client, 'create_draft', draft('hi', { field: 'bio' }));
      expect(notGranted.structuredContent).toMatchObject({
        error: 'field_not_granted',
        fields: ['text', 'title'],
      });
      const unknown = await call(client, 'create_draft', draft('hi', { field: 'title' }));
      expect(unknown.structuredContent).toMatchObject({ error: 'unknown_field', fields: ['text'] });
      const unusable = await call(client, 'create_draft', {
        site: 'mastodon',
        account: 'a@b.social',
        field: 'poll',
        value: 'hi',
      });
      expect(unusable.structuredContent).toMatchObject({
        error: 'field_unusable',
        reason: 'unknown injection strategy telepathy',
      });
      expect(inbox.published).toHaveLength(0);
    });

    it('refuses a destination outside the grant unless the grant allows new ones', async () => {
      const closed = await granted();
      const refused = await call(closed.client, 'create_draft', draft('hi', { account: 'other' }));
      expect(refused.structuredContent).toMatchObject({
        error: 'destination_not_granted',
        site: 'x',
        account: 'other',
      });
      expect(inbox.published).toHaveLength(0);

      const open = await granted({ allow_new_destinations: true });
      const accepted = await call(open.client, 'create_draft', draft('hi', { account: 'other' }));
      expect(accepted.isError).toBeFalsy();
      expect(accepted.structuredContent?.pending_destination).toBe(true);
      // A new destination on a known site still gets that site's constraints.
      const tooLong = await call(
        open.client,
        'create_draft',
        draft('a'.repeat(300), { account: 'other' })
      );
      expect(tooLong.structuredContent?.error).toBe('constraint_violation');
      const newSite = await call(open.client, 'create_draft', {
        site: 'forum',
        account: 'me',
        field: 'reply',
        value: 'anything',
      });
      expect(newSite.structuredContent).toMatchObject({
        pending_destination: true,
        validation: { counter: 'default', length: 8, ok: true },
      });
      expect(inbox.published).toHaveLength(2);
    });

    it('matches "@Handle", "handle" and " handle " to a grant for handle', async () => {
      const { client } = await granted({
        destinations: [{ site: 'x', account: 'handle', fields: ['text'] }],
        quota: { max_submissions: 10, period: 'day' },
      });
      for (const account of ['@Handle', 'handle', ' handle ']) {
        const res = await call(client, 'create_draft', draft('hi', { account }));
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent?.pending_destination).toBe(false);
      }
      // The rumor names the grant's spelling, so devices file it under that destination.
      const opened = await openSubmission(inbox.published[0]?.event, inboxKey);
      expect(opened.ok && opened.value.value.account).toBe('handle');
      const definition = await call(client, 'get_definition', { site: 'x', account: '@HANDLE' });
      expect(definition.structuredContent).toMatchObject({ account: 'handle', granted: true });
      const listed = await call(client, 'list_destinations');
      expect(listed.structuredContent?.destinations).toMatchObject([{ account: 'handle' }]);
    });

    it('tells accounts apart by case where the definition says they are case-sensitive', async () => {
      const { client } = await granted({
        destinations: [
          {
            site: 'x',
            account: 'Handle',
            fields: ['text'],
            // The test registry's X has no account locator, so the override gives a whole one.
            override: {
              account: {
                locator: { role: 'button', name: { en: ['Account menu'] } },
                extract: '@(\\w+)',
                caseSensitive: true,
              },
            },
          },
        ],
      });
      const refused = await call(client, 'create_draft', draft('hi', { account: 'handle' }));
      expect(refused.structuredContent).toMatchObject({ error: 'destination_not_granted' });
      const accepted = await call(client, 'create_draft', draft('hi', { account: ' @Handle' }));
      expect(accepted.isError).toBeFalsy();
      expect(inbox.published).toHaveLength(1);
    });

    it('enforces the quota before publishing and rolls over with the period', async () => {
      const { client, key } = await granted({ quota: { max_submissions: 2, period: 'day' } });
      // One receipt from the day before does not count toward today.
      await h.store.submissionReceipts.create({
        giftWrapId: 'f'.repeat(64),
        agentKeyId: key.id,
        queuePubkey,
        createdAt: Date.UTC(2026, 9, 27, 23, 59) / 1000,
        expiresAt: clock + 30 * DAY,
      });
      for (const n of [1, 2]) {
        expect((await call(client, 'create_draft', draft(`draft ${n}`))).isError).toBeFalsy();
      }
      const over = await call(client, 'create_draft', draft('draft 3'));
      expect(over.structuredContent).toMatchObject({
        error: 'quota_exhausted',
        max_submissions: 2,
        period: 'day',
        used: 2,
        remaining: 0,
        resets_at: Date.UTC(2026, 9, 29) / 1000,
      });
      expect(inbox.published).toHaveLength(2);
      const listed = await call(client, 'list_destinations');
      expect(listed.structuredContent?.quota).toMatchObject({ used: 2, remaining: 0 });

      clock = Date.UTC(2026, 9, 29) / 1000;
      const next = await call(client, 'create_draft', draft('draft 3'));
      expect(next.isError).toBeFalsy();
      expect(inbox.published).toHaveLength(3);
    });

    it('counts weekly quotas from Monday', async () => {
      const { client } = await granted({ quota: { max_submissions: 1, period: 'week' } });
      clock = Date.UTC(2026, 9, 26, 0, 0, 1) / 1000; // Monday
      expect((await call(client, 'create_draft', draft('monday'))).isError).toBeFalsy();
      clock = Date.UTC(2026, 10, 1, 23, 59) / 1000; // Sunday
      expect((await call(client, 'create_draft', draft('sunday'))).structuredContent?.error).toBe(
        'quota_exhausted'
      );
      clock = Date.UTC(2026, 10, 2) / 1000; // next Monday
      expect((await call(client, 'create_draft', draft('monday again'))).isError).toBeFalsy();
    });

    it('leaves no receipt when no inbox relay accepts the wrap', async () => {
      const { client, key } = await granted({ quota: { max_submissions: 1, period: 'day' } });
      inbox.failing.add(INBOX[0] as string);
      const res = await call(client, 'create_draft', draft('lost'));
      expect(res.structuredContent).toMatchObject({
        error: 'publish_failed',
        relays: [{ relay: INBOX[0], message: 'error: down' }],
      });
      expect(await h.store.submissionReceipts.countSince(key.id, 0)).toBe(0);
      // A failed publish uses none of the quota.
      inbox.failing.clear();
      expect((await call(client, 'create_draft', draft('found'))).isError).toBeFalsy();
    });

    it('records a receipt when at least one of several inbox relays accepts', async () => {
      const relays = ['wss://inbox.example/', 'wss://inbox2.example/'];
      const { client } = await granted({ inbox: relays });
      inbox.failing.add('wss://inbox.example/');
      const res = await call(client, 'create_draft', draft('half'));
      expect(res.structuredContent?.relays).toEqual(['wss://inbox2.example/']);
    });

    it('mines the proof of work the grant asks for, and refuses more than it allows', async () => {
      const { client } = await granted({ min_pow: DEFAULT_MAX_POW });
      const res = await call(client, 'create_draft', draft('worked'));
      expect(res.isError).toBeFalsy();
      const wrap = inbox.published[0]?.event;
      expect(powOf(wrap?.id ?? '')).toBeGreaterThanOrEqual(DEFAULT_MAX_POW);
      expect(wrap?.tags.find((t) => t[0] === 'nonce')?.[2]).toBe(String(DEFAULT_MAX_POW));

      const greedy = await granted({ min_pow: 20 });
      const refused = await call(greedy.client, 'create_draft', draft('too much'));
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: 'grant_unusable',
        min_pow: 20,
        max_pow: DEFAULT_MAX_POW,
      });
      const message = refused.content?.[0]?.text ?? '';
      expect(message).toContain('20 bits');
      expect(message).toContain(`at most ${DEFAULT_MAX_POW} bits`);
      expect(message).toContain('Nothing was submitted');
      expect(inbox.published).toHaveLength(1);
    });

    it('mines more when the deployment raises maxPow', async () => {
      app = makeApp({ maxPow: 8 });
      const { client } = await granted({ min_pow: 8 });
      const res = await call(client, 'create_draft', draft('worked harder'));
      expect(res.isError).toBeFalsy();
      expect(powOf(inbox.published[0]?.event.id ?? '')).toBeGreaterThanOrEqual(8);
    });

    it('refuses a wrap too large to mine within the budget, and gives back the reservation', async () => {
      // A lenient value far over the field's length makes a wrap of about 18 KB: 2^5 hashes of it
      // exceed the 2^5 × 8 KiB budget, so nothing is mined, published or counted.
      const { client } = await granted({ min_pow: DEFAULT_MAX_POW });
      const big = draft('y'.repeat(10_000), { lenient: true });
      const refused = await call(client, 'create_draft', big);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: 'pow_budget_exceeded',
        min_pow: DEFAULT_MAX_POW,
        max_pow: DEFAULT_MAX_POW,
        budget_bytes: 2 ** DEFAULT_MAX_POW * POW_BYTES_PER_HASH,
        hashes: 0,
      });
      expect(Number(refused.structuredContent?.wrap_bytes)).toBeGreaterThan(10_000);
      expect(refused.content?.[0]?.text).toContain('A shorter value needs less work');
      expect(inbox.published).toHaveLength(0);
      const res = await call(client, 'create_draft', draft('short'));
      expect(res.isError).toBeFalsy();
      const listed = await call(client, 'list_submissions', {});
      expect(listed.structuredContent?.submissions).toHaveLength(1);
    });

    it('refuses to start with a maxPow outside 0 to 256', () => {
      expect(() => makeApp({ maxPow: 257 })).toThrow(/QUSME_MAX_POW/);
      expect(() => makeApp({ maxPow: 1.5 })).toThrow(/QUSME_MAX_POW/);
    });

    it('refuses inbox relays the service will not connect to', async () => {
      const { client } = await granted({ inbox: ['ws://10.0.0.1/'] });
      const res = await call(client, 'create_draft', draft('hi'));
      expect(res.structuredContent?.error).toBe('grant_unusable');
      expect(inbox.published).toHaveLength(0);
    });

    it('lists receipts only, newest first, in pages', async () => {
      const { client, key } = await granted({ quota: { max_submissions: 50, period: 'day' } });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await call(client, 'create_draft', draft(`n${i}`));
        ids.push(String(res.structuredContent?.gift_wrap_id));
        clock += 1;
      }
      // Two receipts in the same second, to page across a tie.
      for (const id of ['1'.repeat(64), '2'.repeat(64)]) {
        await h.store.submissionReceipts.create({
          giftWrapId: id,
          agentKeyId: key.id,
          queuePubkey,
          createdAt: clock,
          expiresAt: clock + DAY,
        });
        ids.push(id);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await call(client, 'list_submissions', {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(res.isError).toBeFalsy();
        const page = res.structuredContent as {
          submissions: Record<string, unknown>[];
          next_cursor?: string;
        };
        for (const s of page.submissions) {
          expect(Object.keys(s).sort()).toEqual(['created_at', 'expires_at', 'gift_wrap_id']);
          seen.push(String(s.gift_wrap_id));
        }
        cursor = page.next_cursor;
        pages++;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toEqual(['2'.repeat(64), '1'.repeat(64), ids[2], ids[1], ids[0]]);

      const bad = await call(client, 'list_submissions', { cursor: 'nope' });
      expect(bad.structuredContent?.error).toBe('invalid_cursor');
    });

    /** Storage reads of one kind of event so far. */
    const reads = (kind: 'grant' | 'submitters') =>
      storage.queries.filter((q) =>
        kind === 'submitters'
          ? q.query.filter.kinds?.includes(KIND_SUBMITTERS)
          : q.query.filter['#d'] !== undefined
      ).length;

    it('caches a found grant briefly and never a missing one', async () => {
      const cached = makeApp({ grantCacheSeconds: 30 });
      const agent = await bindAgent();
      const client = await connect(agent.token, cached);
      const grantReads = () => reads('grant');
      const before = grantReads();
      expect((await call(client, 'list_destinations')).structuredContent?.error).toBe(
        'grant_not_found'
      );
      expect((await call(client, 'list_destinations')).structuredContent?.error).toBe(
        'grant_not_found'
      );
      expect(grantReads()).toBe(before + 2);
      await grant(agent.key.pubkey);
      expect((await call(client, 'list_destinations')).isError).toBeFalsy();
      expect((await call(client, 'list_submissions')).isError).toBeFalsy();
      expect(grantReads()).toBe(before + 3);
      clock += 31;
      expect((await call(client, 'list_destinations')).isError).toBeFalsy();
      expect(grantReads()).toBe(before + 4);
    });

    /** Publishes a submitters list naming `agents`, signed by the queue key. */
    async function listSubmitters(agents: string[], at = clock) {
      const labels = Object.fromEntries(
        agents.map((a) => [a, { label: 'Example Agent', authorized_at: at }])
      );
      storage.publish(await buildSubmittersList(queue, labels, { createdAt: at }), STORAGE);
    }

    it('refuses with grant_revoked once the submitters list drops the agent, grant or not', async () => {
      const agent = await bindAgent();
      await grant(agent.key.pubkey);
      await listSubmitters([agent.key.pubkey], clock - 20);
      const client = await connect(agent.token);
      expect((await call(client, 'create_draft', draft('before'))).isError).toBeFalsy();
      expect(inbox.published).toHaveLength(1);

      // Revoked on a device: a newer list without the agent. The relays ignored the grant's
      // deletion, so the grant is still there.
      await listSubmitters([], clock - 10);
      for (const [name, args] of [
        ['create_draft', draft('after')],
        ['list_destinations', {}],
        ['get_definition', { site: 'x', account: 'lokkju' }],
        ['list_submissions', {}],
      ] as const) {
        const res = await call(client, name, args);
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.error).toBe('grant_revoked');
        expect(res.structuredContent?.message).toMatch(/revoked/);
        expect(res.structuredContent?.message).toMatch(/authorized again/);
      }
      expect(inbox.published).toHaveLength(1);
      expect(await h.store.submissionReceipts.countSince(agent.key.id, 0)).toBe(1);
      // Read as the agent key, from the bound queue's storage relays.
      const last = storage.queries.filter((q) => q.query.filter.kinds?.includes(KIND_SUBMITTERS));
      expect(last.at(-1)?.authPubkey).toBe(agent.key.pubkey);
      expect(last.at(-1)?.query.filter).toMatchObject({ authors: [queuePubkey] });
      expect(last.at(-1)?.query.relays).toEqual(STORAGE);
    });

    it('ignores a submitters list not signed by the bound queue', async () => {
      const agent = await bindAgent();
      await grant(agent.key.pubkey);
      await listSubmitters([agent.key.pubkey], clock - 20);
      const stranger = createLocalSigner(generateSecretKey());
      storage.publish(await buildSubmittersList(stranger, {}, { createdAt: clock }), STORAGE);
      const client = await connect(agent.token);
      expect((await call(client, 'create_draft', draft('hi'))).isError).toBeFalsy();
    });

    it('goes ahead on the grant when no submitters list is found, and says so', async () => {
      const notices: McpNotice[] = [];
      const noticing = makeApp({ notice: (n) => notices.push(n) });
      const agent = await bindAgent();
      const client = await connect(agent.token, noticing);
      // Neither the list nor the grant: grant_not_found, as before, and nothing to report.
      expect((await call(client, 'create_draft', draft('hi'))).structuredContent?.error).toBe(
        'grant_not_found'
      );
      expect(notices).toEqual([]);
      await grant(agent.key.pubkey);
      expect((await call(client, 'create_draft', draft('hi'))).isError).toBeFalsy();
      expect(notices).toEqual([
        {
          event: 'submitters_list_unavailable',
          agentPubkey: agent.key.pubkey,
          queuePubkey,
        },
      ]);
    });

    it('caches the submitters list briefly, so a revocation lands within the cache time', async () => {
      const cached = makeApp({ grantCacheSeconds: 30 });
      const agent = await bindAgent();
      await grant(agent.key.pubkey);
      await listSubmitters([agent.key.pubkey], clock - 20);
      const client = await connect(agent.token, cached);
      expect((await call(client, 'create_draft', draft('one'))).isError).toBeFalsy();
      const before = reads('submitters');
      await listSubmitters([], clock - 10);
      // Within the cache time the list read before the revocation still answers.
      clock += 10;
      expect((await call(client, 'list_destinations')).isError).toBeFalsy();
      expect(reads('submitters')).toBe(before);
      clock += 21;
      const res = await call(client, 'create_draft', draft('two'));
      expect(res.structuredContent?.error).toBe('grant_revoked');
      expect(reads('submitters')).toBe(before + 1);
      expect(inbox.published).toHaveLength(1);
    });

    describe('storage relays carried in the grant (7.4, 8.4)', () => {
      const MOVED = ['wss://storage.example/', 'wss://storage3.example/'];
      const OTHER = ['wss://storage4.example/'];

      /** Publishes a grant signed by `signer` (the queue by default) to `relays` only. */
      async function grantOn(
        relays: string[],
        agentPubkey: string,
        input: Partial<AgentGrantInput>,
        at: number,
        signer: Signer = queue
      ) {
        const event = await buildAgentGrant(
          signer,
          agentPubkey,
          { ...baseGrant(), ...input },
          { createdAt: at }
        );
        storage.publish(event, relays);
        return event;
      }

      async function listOn(relays: string[], agents: string[], at: number) {
        const labels = Object.fromEntries(
          agents.map((a) => [a, { label: 'Example Agent', authorized_at: at }])
        );
        storage.publish(await buildSubmittersList(queue, labels, { createdAt: at }), relays);
      }

      const lastRead = (kind: 'grant' | 'submitters') =>
        storage.queries.findLast((q) =>
          kind === 'grant'
            ? q.query.filter['#d'] !== undefined
            : q.query.filter.kinds?.includes(KIND_SUBMITTERS)
        );

      it('moves the binding to a newer grant’s storage relays and reads there from then on', async () => {
        const notices: McpNotice[] = [];
        const noticing = makeApp({ notice: (n) => notices.push(n) });
        const agent = await bindAgent();
        await listOn([...STORAGE, ...MOVED], [agent.key.pubkey], clock - 30);
        // The swap's republished grant: newer, naming the new list, on the surviving relay too.
        await grantOn([...STORAGE, ...MOVED], agent.key.pubkey, { storage: MOVED }, clock - 5);
        const client = await connect(agent.token, noticing);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect(lastRead('grant')?.query.relays).toEqual(STORAGE);
        const binding = await h.store.bindings.get(agent.key.id);
        expect(binding?.storageRelays).toEqual(MOVED);
        expect(binding?.storageGrantAt).toBe(clock - 5);
        expect(notices).toEqual([
          { event: 'storage_relays_moved', agentPubkey: agent.key.pubkey, queuePubkey },
        ]);

        expect((await call(client, 'create_draft', draft('after the swap'))).isError).toBeFalsy();
        expect(lastRead('grant')?.query.relays).toEqual(MOVED);
        expect(lastRead('submitters')?.query.relays).toEqual(MOVED);
        expect(notices).toHaveLength(1);
      });

      it('ignores an older grant, a forged one, and one naming relays it would not connect to', async () => {
        const agent = await bindAgent();
        await listOn([...STORAGE, ...MOVED, ...OTHER], [agent.key.pubkey], clock - 30);
        await grantOn(STORAGE, agent.key.pubkey, { storage: MOVED }, clock - 5);
        const client = await connect(agent.token);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect((await h.store.bindings.get(agent.key.id))?.storageRelays).toEqual(MOVED);

        // MOVED kept only an older grant, naming other relays: it does not move the binding back.
        await grantOn(MOVED, agent.key.pubkey, { storage: OTHER }, clock - 10);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect(await h.store.bindings.get(agent.key.id)).toMatchObject({
          storageRelays: MOVED,
          storageGrantAt: clock - 5,
        });

        // A newer grant signed by another key is not the queue's.
        const stranger = createLocalSigner(generateSecretKey());
        await grantOn(MOVED, agent.key.pubkey, { storage: OTHER }, clock + 100, stranger);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect((await h.store.bindings.get(agent.key.id))?.storageRelays).toEqual(MOVED);

        // A newer queue grant naming a host the service refuses to connect to moves nothing.
        await grantOn(MOVED, agent.key.pubkey, { storage: ['wss://relay.internal'] }, clock - 1);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect(await h.store.bindings.get(agent.key.id)).toMatchObject({
          storageRelays: MOVED,
          storageGrantAt: clock - 5,
        });
      });

      it('keeps the binding for a grant without storage, and for a revoked agent', async () => {
        const agent = await bindAgent();
        await listOn(STORAGE, [agent.key.pubkey], clock - 30);
        await grant(agent.key.pubkey, {}, clock - 5);
        const client = await connect(agent.token);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect(await h.store.bindings.get(agent.key.id)).toMatchObject({
          storageRelays: STORAGE,
          storageGrantAt: null,
        });
        // The same relays in another order are the same list.
        await grant(agent.key.pubkey, { storage: [...STORAGE].reverse() }, clock - 4);
        expect((await call(client, 'list_destinations')).isError).toBeFalsy();
        expect((await h.store.bindings.get(agent.key.id))?.storageGrantAt).toBeNull();

        await listOn(STORAGE, [], clock - 3);
        await grant(agent.key.pubkey, { storage: MOVED }, clock - 2);
        expect((await call(client, 'list_destinations')).structuredContent?.error).toBe(
          'grant_revoked'
        );
        expect((await h.store.bindings.get(agent.key.id))?.storageRelays).toEqual(STORAGE);
      });
    });

    it('answers a 2025-era client over the stateless fallback', async () => {
      const agent = await bindAgent();
      await grant(agent.key.pubkey);
      const post = (body: unknown) =>
        app.request('/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${agent.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
          },
          body: JSON.stringify(body),
        });
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      });
      expect(init.status).toBe(200);
      expect(init.headers.get('Mcp-Session-Id')).toBeNull();
      const called = await post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_draft', arguments: draft('from 2025') },
      });
      expect(called.status).toBe(200);
      const text = await called.text();
      expect(text).toContain('gift_wrap_id');
      expect(inbox.published).toHaveLength(1);
      expect(
        (
          await app.request('/mcp', {
            method: 'GET',
            headers: { Authorization: `Bearer ${agent.token}`, Accept: 'text/event-stream' },
          })
        ).status
      ).toBe(405);
    });

    it('rejects a revoked agent at the bearer check', async () => {
      const { client, key } = await granted();
      await createAgentKeyCustody(h.store, ring).revoke(key.id, Math.floor(Date.now() / 1000));
      await expect(call(client, 'list_destinations')).rejects.toThrow();
    });

    describe('limits', () => {
      const midnight = Date.UTC(2026, 9, 29) / 1000;

      /** A grant on this queue, connected to an app with these limits. */
      async function limited(limits: LimitsOptions, input: Partial<AgentGrantInput> = {}) {
        app = makeApp({}, limits);
        return granted({ quota: { max_submissions: 50, period: 'day' }, ...input });
      }

      it('caps create_draft per queue per day across its agents, on top of the grant quota', async () => {
        const limits = { tiers: { free: { ...TIERS.free, draftsPerDay: 2 } } };
        const first = await limited(limits);
        expect((await call(first.client, 'create_draft', draft('one'))).isError).toBeFalsy();
        const second = await granted({ quota: { max_submissions: 50, period: 'day' } });
        expect((await call(second.client, 'create_draft', draft('two'))).isError).toBeFalsy();
        const over = await call(second.client, 'create_draft', draft('three'));
        expect(over.isError).toBe(true);
        expect(over.structuredContent).toMatchObject({
          error: 'quota_exhausted',
          scope: 'queue',
          max_submissions: 2,
          used: 2,
          resets_at: midnight,
          retry_after: midnight - T0,
        });
        expect(String(over.structuredContent?.message)).toContain(
          `Retry after ${midnight - T0} seconds`
        );
        expect(inbox.published).toHaveLength(2);
        clock = midnight;
        expect((await call(first.client, 'create_draft', draft('next day'))).isError).toBeFalsy();
      });

      it('reports the grant quota with its scope and when to retry', async () => {
        const { client } = await limited({}, { quota: { max_submissions: 1, period: 'day' } });
        await call(client, 'create_draft', draft('one'));
        const over = await call(client, 'create_draft', draft('two'));
        expect(over.structuredContent).toMatchObject({
          error: 'quota_exhausted',
          scope: 'grant',
          retry_after: midnight - T0,
        });
      });

      it('holds the service-wide daily ceiling across queues, giving back failed publishes', async () => {
        const { client } = await limited({ config: { draftsPerDayCeiling: 1 } });
        inbox.failing.add(INBOX[0] as string);
        expect((await call(client, 'create_draft', draft('lost'))).structuredContent?.error).toBe(
          'publish_failed'
        );
        inbox.failing.clear();
        expect((await call(client, 'create_draft', draft('one'))).isError).toBeFalsy();

        const otherQueue = createLocalSigner(generateSecretKey());
        const agent = await bindAgent(await otherQueue.getPublicKey());
        storage.publish(
          await buildAgentGrant(otherQueue, agent.key.pubkey, baseGrant(), { createdAt: clock }),
          STORAGE
        );
        const other = await connect(agent.token);
        const over = await call(other, 'create_draft', draft('two'));
        expect(over.structuredContent).toMatchObject({
          error: 'quota_exhausted',
          scope: 'service',
          resets_at: midnight,
          retry_after: midnight - T0,
        });
        expect(inbox.published).toHaveLength(1);
        expect(await h.store.usageCounters.get('create_draft', midnight - DAY)).toBe(1);
      });

      it('fails closed: a ceiling of 0 refuses every draft', async () => {
        const { client } = await limited({ config: { draftsPerDayCeiling: 0 } });
        const res = await call(client, 'create_draft', draft('none'));
        expect(res.structuredContent).toMatchObject({ error: 'quota_exhausted', scope: 'service' });
        expect(inbox.published).toHaveLength(0);
      });

      it('fails closed: publishes nothing when the ceiling cannot be counted', async () => {
        const { client } = await limited({});
        await renameTable(h.db, 'usage_counters', 'usage_counters_off');
        try {
          const res = await call(client, 'create_draft', draft('uncounted'));
          expect(res.structuredContent?.error).toBe('internal_error');
          expect(inbox.published).toHaveLength(0);
        } finally {
          await renameTable(h.db, 'usage_counters_off', 'usage_counters');
        }
      });

      it('resolves a queue’s tier by pubkey and falls back to free for an unknown one', async () => {
        const tiers = {
          free: { ...TIERS.free, draftsPerDay: 1 },
          pro: { ...TIERS.free, draftsPerDay: 3 },
        };
        let tierName = 'pro';
        const seen: string[] = [];
        const { client } = await limited({
          tiers,
          tierLookup: (pk) => {
            seen.push(pk);
            return tierName;
          },
        });
        for (const v of ['a', 'b', 'c']) {
          expect((await call(client, 'create_draft', draft(v))).isError).toBeFalsy();
        }
        expect((await call(client, 'create_draft', draft('d'))).structuredContent).toMatchObject({
          scope: 'queue',
          max_submissions: 3,
        });
        expect(new Set(seen)).toEqual(new Set([queuePubkey]));
        tierName = 'gold';
        clock = midnight;
        expect((await call(client, 'create_draft', draft('e'))).isError).toBeFalsy();
        expect((await call(client, 'create_draft', draft('f'))).structuredContent).toMatchObject({
          scope: 'queue',
          max_submissions: 1,
        });
      });

      it('answers rate_limited with retry_after to a tool call, and 429 to anything else', async () => {
        const refused = new Set<RateClassName>();
        const calls: [RateClassName, string][] = [];
        const rateLimiter: RateLimiter = {
          async limit(rateClass, key) {
            calls.push([rateClass, key]);
            return refused.has(rateClass) ? { ok: false, retryAfter: 42 } : { ok: true };
          },
        };
        const { client, key, token } = await limited({ rateLimiter });
        expect(calls).toContainEqual(['mcp_agent_free', key.pubkey]);
        expect(calls).toContainEqual(['mcp_queue_free', queuePubkey]);

        for (const rateClass of ['mcp_agent_free', 'mcp_queue_free'] as const) {
          refused.clear();
          refused.add(rateClass);
          const res = await call(client, 'create_draft', draft('slow down'));
          expect(res.isError).toBe(true);
          expect(res.structuredContent).toMatchObject({ error: 'rate_limited', retry_after: 42 });
          expect(String(res.structuredContent?.message)).toContain('Wait 42 seconds');
          expect(inbox.published).toHaveLength(0);

          const list = await app.request('/mcp', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2025-11-25',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
          });
          expect(list.status).toBe(429);
          expect(list.headers.get('Retry-After')).toBe('42');
        }
        refused.clear();
        expect((await call(client, 'create_draft', draft('again'))).isError).toBeFalsy();
      });
    });
  });
}
