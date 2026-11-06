import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/index.ts';
import type { Harness } from './harness.ts';

/**
 * The store's behavior, run once per driver. Both drivers must pass it unchanged; a test that
 * needs a driver-specific branch is a bug in the store.
 */
export function storeSuite(driver: string, setup: () => { fresh(): Promise<Harness> }) {
  describe(`store on ${driver}`, () => {
    const { fresh } = setup();
    let h: Harness;
    beforeEach(async () => {
      h = await fresh();
    });

    const NOW = 1_800_000_000;
    const CLIENT = 'https://client.example/oauth/metadata.json';
    const pk = (n: number) => n.toString(16).padStart(64, '0');

    async function seedClient(clientId = CLIENT) {
      return h.store.oauthClients.upsert({
        clientId,
        metadata: { client_name: 'Example', redirect_uris: ['http://127.0.0.1:3000/cb'] },
        clientName: 'Example',
        redirectUris: ['http://127.0.0.1:3000/cb'],
        registrationSource: 'metadata_document',
        fetchedAt: NOW,
        createdAt: NOW,
      });
    }

    async function seedKey(id: string, n: number, keyVersion = 1) {
      return h.store.agentKeys.create({
        id,
        pubkey: pk(n),
        encryptedSecretKey: new Uint8Array([n, 0, 255, 128, 7]),
        keyVersion,
        clientId: CLIENT,
        createdAt: NOW,
      });
    }

    async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
      return (await h.db.all(query)) as T[];
    }

    describe('schema', () => {
      it('creates every service-state table', async () => {
        const names = await rows<{ name: string }>(
          sql`select name from sqlite_master where type = 'table' order by name`
        );
        expect(
          names
            .map((r) => r.name)
            .filter((n) => !n.startsWith('_') && !n.startsWith('sqlite_') && n !== 'd1_migrations')
        ).toEqual([
          'agent_keys',
          'bindings',
          'hosted_queues',
          'nip98_replays',
          'oauth_clients',
          'oauth_codes',
          'oauth_tokens',
          'pairing_sessions',
          'pending_authorizations',
          'submission_receipts',
          'usage_counters',
        ]);
      });

      it('indexes the access paths: token hash, agent pubkey, queue pubkey, expiry', async () => {
        const idx = await rows<{ name: string }>(
          sql`select name from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name`
        );
        expect(idx.map((r) => r.name)).toEqual([
          'agent_keys_client_idx',
          'agent_keys_key_version_idx',
          'agent_keys_pubkey_idx',
          'bindings_queue_idx',
          'nip98_replays_expires_idx',
          'oauth_codes_agent_key_idx',
          'oauth_codes_expires_idx',
          'oauth_tokens_agent_key_idx',
          'oauth_tokens_expires_idx',
          'pairing_sessions_expires_idx',
          'pending_authorizations_agent_key_idx',
          'pending_authorizations_client_ip_idx',
          'pending_authorizations_expires_idx',
          'pending_authorizations_user_code_idx',
          'submission_receipts_agent_created_idx',
          'submission_receipts_expires_idx',
          'submission_receipts_queue_created_idx',
          'usage_counters_expires_idx',
        ]);
      });

      it('has no column for submission content or a plaintext secret', async () => {
        const cols = await rows<{ tbl: string; name: string; type: string }>(
          sql`select m.name as tbl, p.name as name, p.type as type
              from sqlite_master m join pragma_table_info(m.name) p
              where m.type = 'table' and m.name not glob '_*' and m.name not glob 'sqlite_*'
                and m.name != 'd1_migrations'`
        );
        const names = cols.map((c) => `${c.tbl}.${c.name}`);
        for (const n of names) {
          expect(n).not.toMatch(
            /content|plaintext|nsec|rumor|body|(^|\.)(secret|token|code_verifier)$/
          );
        }
        expect(cols.filter((c) => c.tbl === 'submission_receipts').map((c) => c.name)).toEqual([
          'gift_wrap_id',
          'agent_key_id',
          'queue_pubkey',
          'created_at',
          'expires_at',
        ]);
        const secretCols = cols.filter((c) => /secret|token|code/.test(c.name));
        expect(secretCols.map((c) => `${c.tbl}.${c.name}:${c.type.toLowerCase()}`).sort()).toEqual([
          'agent_keys.encrypted_secret_key:blob',
          'oauth_codes.code_challenge:text',
          'oauth_codes.code_hash:text',
          'oauth_tokens.token_hash:text',
          'pairing_sessions.code:text',
          'pending_authorizations.code_challenge:text',
          'pending_authorizations.user_code:text',
        ]);
      });

      it('enforces foreign keys', async () => {
        await expect(seedKey('k1', 1)).rejects.toThrow();
      });
    });

    it('hashSecret is hex SHA-256', async () => {
      expect(await hashSecret('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });

    describe('oauthClients', () => {
      it('upserts, reads, updates and deletes, round-tripping JSON', async () => {
        const created = await seedClient();
        expect(created.redirectUris).toEqual(['http://127.0.0.1:3000/cb']);
        expect(await h.store.oauthClients.get(CLIENT)).toEqual(created);

        const refreshed = await h.store.oauthClients.upsert({
          ...created,
          clientName: 'Example 2',
          metadata: { client_name: 'Example 2' },
          fetchedAt: NOW + 10,
          createdAt: NOW + 10,
        });
        expect(refreshed.clientName).toBe('Example 2');
        expect(refreshed.metadata).toEqual({ client_name: 'Example 2' });
        expect(refreshed.createdAt).toBe(NOW);

        expect(
          (await h.store.oauthClients.update(CLIENT, { fetchedAt: NOW + 20 }))?.fetchedAt
        ).toBe(NOW + 20);
        expect(await h.store.oauthClients.update('https://nope.example/', { fetchedAt: 1 })).toBe(
          undefined
        );
        expect(await h.store.oauthClients.delete(CLIENT)).toBe(true);
        expect(await h.store.oauthClients.delete(CLIENT)).toBe(false);
        expect(await h.store.oauthClients.get(CLIENT)).toBeUndefined();
      });
    });

    describe('agentKeys', () => {
      beforeEach(() => seedClient().then(() => undefined));

      it('stores ciphertext as bytes and returns the same Uint8Array on both drivers', async () => {
        const blob = Uint8Array.from({ length: 256 }, (_, i) => i);
        await h.store.agentKeys.create({
          id: 'k1',
          pubkey: pk(1),
          encryptedSecretKey: blob,
          keyVersion: 1,
          clientId: CLIENT,
          createdAt: NOW,
        });
        const got = await h.store.agentKeys.get('k1');
        expect(got?.encryptedSecretKey).toBeInstanceOf(Uint8Array);
        expect(got?.encryptedSecretKey?.constructor).toBe(Uint8Array);
        expect(Array.from(got?.encryptedSecretKey ?? [])).toEqual(Array.from(blob));
        expect((await h.store.agentKeys.getByPubkey(pk(1)))?.id).toBe('k1');
        expect(await h.store.agentKeys.getByPubkey(pk(2))).toBeUndefined();
      });

      it('refuses a second key with the same pubkey', async () => {
        await seedKey('k1', 1);
        await expect(
          h.store.agentKeys.create({
            id: 'k2',
            pubkey: pk(1),
            encryptedSecretKey: new Uint8Array([1]),
            keyVersion: 1,
            clientId: CLIENT,
            createdAt: NOW,
          })
        ).rejects.toThrow();
      });

      it('lists keys under an old secret version and re-encrypts them', async () => {
        await seedKey('k1', 1, 1);
        await seedKey('k2', 2, 2);
        expect((await h.store.agentKeys.listBelowKeyVersion(2)).map((k) => k.id)).toEqual(['k1']);
        const re = await h.store.agentKeys.reencrypt('k1', new Uint8Array([9, 9]), 2);
        expect(re?.keyVersion).toBe(2);
        expect(Array.from(re?.encryptedSecretKey ?? [])).toEqual([9, 9]);
        expect(await h.store.agentKeys.listBelowKeyVersion(2)).toEqual([]);
      });

      it('revokes once, discarding the ciphertext', async () => {
        await seedKey('k1', 1);
        const revoked = await h.store.agentKeys.revoke('k1', NOW + 5);
        expect(revoked?.revokedAt).toBe(NOW + 5);
        expect(revoked?.encryptedSecretKey).toBeNull();
        expect(await h.store.agentKeys.revoke('k1', NOW + 6)).toBeUndefined();
        expect(await h.store.agentKeys.reencrypt('k1', new Uint8Array([1]), 2)).toBeUndefined();
        expect(await h.store.agentKeys.listBelowKeyVersion(9)).toEqual([]);
      });

      it('deletes with its codes, tokens, binding and receipts', async () => {
        await seedKey('k1', 1);
        await h.store.oauthTokens.create({
          tokenHash: 't1',
          kind: 'access',
          clientId: CLIENT,
          agentKeyId: 'k1',
          scopes: 'submit',
          createdAt: NOW,
          expiresAt: NOW + 3600,
        });
        await h.store.oauthCodes.create({
          codeHash: 'c1',
          clientId: CLIENT,
          agentKeyId: 'k1',
          redirectUri: 'http://127.0.0.1:3000/cb',
          codeChallenge: 'x',
          scopes: 'submit',
          createdAt: NOW,
          expiresAt: NOW + 60,
        });
        await h.store.bindings.create({
          agentKeyId: 'k1',
          queuePubkey: pk(100),
          clientLabel: 'Example',
          createdAt: NOW,
          updatedAt: NOW,
        });
        await h.store.submissionReceipts.create({
          giftWrapId: 'w1',
          agentKeyId: 'k1',
          queuePubkey: pk(100),
          createdAt: NOW,
          expiresAt: NOW + 86400,
        });
        expect(await h.store.agentKeys.delete('k1')).toBe(true);
        expect(await h.store.agentKeys.delete('k1')).toBe(false);
        expect(await h.store.oauthTokens.get('t1', NOW)).toBeUndefined();
        expect(await h.store.oauthCodes.get('c1', NOW)).toBeUndefined();
        expect(await h.store.bindings.get('k1')).toBeUndefined();
        expect(await h.store.submissionReceipts.get('w1', NOW)).toBeUndefined();
      });
    });

    describe('pendingAuthorizations', () => {
      beforeEach(() => seedClient().then(() => undefined));

      const pending = (id: string, userCode: string, expiresAt = NOW + 600) =>
        h.store.pendingAuthorizations.create({
          id,
          userCode,
          clientId: CLIENT,
          redirectUri: 'http://127.0.0.1:3000/cb',
          state: 'st',
          codeChallenge: 'challenge',
          scopes: 'submit',
          resource: 'https://app.qus.me/mcp',
          status: 'pending',
          createdAt: NOW,
          expiresAt,
        });

      it('reads by id and user code until it expires', async () => {
        await pending('p1', 'ABCD-1234');
        expect((await h.store.pendingAuthorizations.get('p1', NOW))?.state).toBe('st');
        expect((await h.store.pendingAuthorizations.getByUserCode('ABCD-1234', NOW))?.id).toBe(
          'p1'
        );
        expect(await h.store.pendingAuthorizations.get('p1', NOW + 600)).toBeUndefined();
        expect(
          await h.store.pendingAuthorizations.getByUserCode('ABCD-1234', NOW + 600)
        ).toBeUndefined();
      });

      it('counts open (undecided, live) authorizations, per client IP hash and in all', async () => {
        const open = (
          id: string,
          ip: string | null,
          status: 'pending' | 'fetched' | 'approved',
          expiresAt: number
        ) =>
          h.store.pendingAuthorizations.create({
            id,
            userCode: id,
            clientId: CLIENT,
            redirectUri: 'http://127.0.0.1:3000/cb',
            codeChallenge: 'c',
            scopes: 'submit',
            status,
            clientIpHash: ip,
            createdAt: NOW,
            expiresAt,
          });
        await open('a', 'ip1', 'pending', NOW + 300);
        await open('b', 'ip1', 'fetched', NOW + 100);
        await open('c', 'ip1', 'approved', NOW + 50);
        await open('d', 'ip1', 'pending', NOW);
        await open('e', 'ip2', 'pending', NOW + 600);
        await open('f', null, 'pending', NOW + 700);
        expect(await h.store.pendingAuthorizations.countOpen(NOW, 'ip1')).toEqual({
          count: 2,
          earliestExpiry: NOW + 100,
        });
        expect(await h.store.pendingAuthorizations.countOpen(NOW)).toEqual({
          count: 4,
          earliestExpiry: NOW + 100,
        });
        expect(await h.store.pendingAuthorizations.countOpen(NOW, 'ip3')).toEqual({
          count: 0,
          earliestExpiry: undefined,
        });
      });

      it('refuses a duplicate user code', async () => {
        await pending('p1', 'SAME');
        await expect(pending('p2', 'SAME')).rejects.toThrow();
      });

      it('is fetched once, then decided once', async () => {
        await pending('p1', 'C1');
        await seedKey('k1', 1);
        await seedKey('k2', 2);
        const fetched = await h.store.pendingAuthorizations.markFetched(
          'p1',
          { agentKeyId: 'k1', queuePubkey: pk(100) },
          NOW
        );
        expect(fetched).toMatchObject({
          status: 'fetched',
          agentKeyId: 'k1',
          queuePubkey: pk(100),
        });
        expect(
          await h.store.pendingAuthorizations.markFetched(
            'p1',
            { agentKeyId: 'k2', queuePubkey: pk(100) },
            NOW
          )
        ).toBeUndefined();
        expect((await h.store.pendingAuthorizations.decide('p1', 'approved', NOW))?.status).toBe(
          'approved'
        );
        expect(await h.store.pendingAuthorizations.decide('p1', 'denied', NOW)).toBeUndefined();
      });

      it('cannot be fetched or decided after expiry', async () => {
        await pending('p1', 'C1', NOW + 10);
        await seedKey('k1', 1);
        expect(
          await h.store.pendingAuthorizations.markFetched(
            'p1',
            { agentKeyId: 'k1', queuePubkey: pk(100) },
            NOW + 10
          )
        ).toBeUndefined();
        expect(await h.store.pendingAuthorizations.decide('p1', 'approved', NOW)).toBeUndefined();
      });

      it('loses its agent key reference when the key is deleted on denial', async () => {
        await pending('p1', 'C1');
        await seedKey('k1', 1);
        await h.store.pendingAuthorizations.markFetched(
          'p1',
          { agentKeyId: 'k1', queuePubkey: pk(100) },
          NOW
        );
        const denied = await h.store.pendingAuthorizations.decide('p1', 'denied', NOW);
        expect(denied?.agentKeyId).toBe('k1');
        await h.store.agentKeys.delete('k1');
        expect((await h.store.pendingAuthorizations.get('p1', NOW))?.agentKeyId).toBeNull();
      });

      it('updates and deletes', async () => {
        await pending('p1', 'C1');
        expect(
          (await h.store.pendingAuthorizations.update('p1', { expiresAt: NOW + 5 }))?.expiresAt
        ).toBe(NOW + 5);
        expect(await h.store.pendingAuthorizations.delete('p1')).toBe(true);
        expect(await h.store.pendingAuthorizations.get('p1', NOW)).toBeUndefined();
      });
    });

    describe('oauthCodes', () => {
      beforeEach(async () => {
        await seedClient();
        await seedKey('k1', 1);
      });

      const code = (codeHash: string, expiresAt: number) =>
        h.store.oauthCodes.create({
          codeHash,
          clientId: CLIENT,
          agentKeyId: 'k1',
          redirectUri: 'http://127.0.0.1:3000/cb',
          codeChallenge: 'challenge',
          scopes: 'submit',
          resource: null,
          createdAt: NOW,
          expiresAt,
        });

      it('redeems once', async () => {
        await code('c1', NOW + 60);
        expect((await h.store.oauthCodes.get('c1', NOW))?.agentKeyId).toBe('k1');
        expect((await h.store.oauthCodes.consume('c1', NOW))?.codeChallenge).toBe('challenge');
        expect(await h.store.oauthCodes.consume('c1', NOW)).toBeUndefined();
        expect(await h.store.oauthCodes.get('c1', NOW)).toBeUndefined();
      });

      it('does not redeem or show after expiry', async () => {
        await code('c1', NOW + 60);
        expect(await h.store.oauthCodes.get('c1', NOW + 60)).toBeUndefined();
        expect(await h.store.oauthCodes.consume('c1', NOW + 60)).toBeUndefined();
        expect(await h.store.oauthCodes.delete('c1')).toBe(true);
      });
    });

    describe('oauthTokens', () => {
      beforeEach(async () => {
        await seedClient();
        await seedKey('k1', 1);
      });

      const token = (tokenHash: string, expiresAt: number, kind: 'access' | 'refresh' = 'access') =>
        h.store.oauthTokens.create({
          tokenHash,
          kind,
          clientId: CLIENT,
          agentKeyId: 'k1',
          scopes: 'submit',
          createdAt: NOW,
          expiresAt,
        });

      it('reads a token by hash only while unexpired and unrevoked', async () => {
        await token('t1', NOW + 60);
        expect((await h.store.oauthTokens.get('t1', NOW))?.kind).toBe('access');
        expect(await h.store.oauthTokens.get('t1', NOW + 60)).toBeUndefined();
        expect((await h.store.oauthTokens.revoke('t1', NOW))?.revokedAt).toBe(NOW);
        expect(await h.store.oauthTokens.revoke('t1', NOW)).toBeUndefined();
        expect(await h.store.oauthTokens.get('t1', NOW)).toBeUndefined();
      });

      it('lists and revokes an agent key’s tokens', async () => {
        await token('t1', NOW + 60);
        await token('t2', NOW + 6000, 'refresh');
        await token('t3', NOW - 1);
        expect(
          (await h.store.oauthTokens.listByAgentKey('k1', NOW)).map((t) => t.tokenHash).sort()
        ).toEqual(['t1', 't2']);
        expect(await h.store.oauthTokens.revokeByAgentKey('k1', NOW)).toBe(3);
        expect(await h.store.oauthTokens.revokeByAgentKey('k1', NOW)).toBe(0);
        expect(await h.store.oauthTokens.listByAgentKey('k1', NOW)).toEqual([]);
        expect(await h.store.oauthTokens.delete('t1')).toBe(true);
      });
    });

    describe('bindings', () => {
      beforeEach(async () => {
        await seedClient();
        await seedKey('k1', 1);
        await seedKey('k2', 2);
        await seedKey('k3', 3);
      });

      const bind = (agentKeyId: string, queue: number) =>
        h.store.bindings.create({
          agentKeyId,
          queuePubkey: pk(queue),
          clientLabel: `label ${agentKeyId}`,
          createdAt: NOW,
          updatedAt: NOW,
        });

      it('lists a queue’s unrevoked bindings', async () => {
        await bind('k1', 100);
        await bind('k2', 100);
        await bind('k3', 200);
        await h.store.bindings.revoke('k2', NOW + 1);
        expect((await h.store.bindings.listByQueue(pk(100))).map((b) => b.agentKeyId)).toEqual([
          'k1',
        ]);
        expect((await h.store.bindings.get('k2'))?.revokedAt).toBe(NOW + 1);
        expect(await h.store.bindings.revoke('k2', NOW + 2)).toBeUndefined();
      });

      it('counts a queue’s unrevoked bindings, optionally leaving one out', async () => {
        await bind('k1', 100);
        await bind('k2', 100);
        await bind('k3', 200);
        expect(await h.store.bindings.countByQueue(pk(100))).toBe(2);
        expect(await h.store.bindings.countByQueue(pk(100), 'k1')).toBe(1);
        await h.store.bindings.revoke('k2', NOW + 1);
        expect(await h.store.bindings.countByQueue(pk(100))).toBe(1);
        expect(await h.store.bindings.countByQueue(pk(300))).toBe(0);
      });

      it('rebinds every unrevoked binding to the new queue key once', async () => {
        await bind('k1', 100);
        await bind('k2', 100);
        await bind('k3', 100);
        await h.store.bindings.revoke('k3', NOW);
        expect(await h.store.bindings.rebindQueue(pk(100), pk(101), NOW + 9)).toBe(2);
        expect(await h.store.bindings.rebindQueue(pk(100), pk(101), NOW + 9)).toBe(0);
        const moved = await h.store.bindings.get('k1');
        expect(moved).toMatchObject({ queuePubkey: pk(101), updatedAt: NOW + 9 });
        expect((await h.store.bindings.get('k3'))?.queuePubkey).toBe(pk(100));
      });

      it('updates and deletes', async () => {
        await bind('k1', 100);
        expect((await h.store.bindings.update('k1', { clientLabel: 'renamed' }))?.clientLabel).toBe(
          'renamed'
        );
        expect(await h.store.bindings.delete('k1')).toBe(true);
        expect(await h.store.bindings.get('k1')).toBeUndefined();
      });
    });

    describe('submissionReceipts', () => {
      beforeEach(async () => {
        await seedClient();
        await seedKey('k1', 1);
        await seedKey('k2', 2);
      });

      const receipt = (
        giftWrapId: string,
        agentKeyId: string,
        createdAt: number,
        expiresAt = NOW + 86_400
      ) =>
        h.store.submissionReceipts.create({
          giftWrapId,
          agentKeyId,
          queuePubkey: pk(100),
          createdAt,
          expiresAt,
        });

      it('lists an agent key’s receipts newest first, in pages', async () => {
        for (let i = 0; i < 5; i++) await receipt(`w${i}`, 'k1', NOW - 100 + i);
        await receipt('other', 'k2', NOW);
        const first = await h.store.submissionReceipts.listByAgentKey('k1', NOW, { limit: 2 });
        expect(first.map((r) => r.giftWrapId)).toEqual(['w4', 'w3']);
        const next = await h.store.submissionReceipts.listByAgentKey('k1', NOW, {
          limit: 2,
          before: first[1]?.createdAt,
        });
        expect(next.map((r) => r.giftWrapId)).toEqual(['w2', 'w1']);
      });

      it('pages through receipts that share a second with a gift wrap id cursor', async () => {
        for (const id of ['a', 'b', 'c', 'd']) await receipt(id, 'k1', NOW);
        await receipt('z', 'k1', NOW - 1);
        const first = await h.store.submissionReceipts.listByAgentKey('k1', NOW, { limit: 2 });
        expect(first.map((r) => r.giftWrapId)).toEqual(['d', 'c']);
        const next = await h.store.submissionReceipts.listByAgentKey('k1', NOW, {
          limit: 2,
          before: first[1]?.createdAt,
          beforeId: first[1]?.giftWrapId,
        });
        expect(next.map((r) => r.giftWrapId)).toEqual(['b', 'a']);
        const last = await h.store.submissionReceipts.listByAgentKey('k1', NOW, {
          limit: 2,
          before: next[1]?.createdAt,
          beforeId: next[1]?.giftWrapId,
        });
        expect(last.map((r) => r.giftWrapId)).toEqual(['z']);
      });

      it('counts submissions since the start of a quota period', async () => {
        await receipt('a', 'k1', NOW - 10);
        await receipt('b', 'k1', NOW);
        await receipt('c', 'k1', NOW + 10);
        await receipt('d', 'k2', NOW + 10);
        expect(await h.store.submissionReceipts.countSince('k1', NOW)).toBe(2);
        expect(await h.store.submissionReceipts.countSince('k1', 0)).toBe(3);
      });

      it('counts a queue’s submissions since a time, across its agent keys', async () => {
        await receipt('a', 'k1', NOW - 10);
        await receipt('b', 'k1', NOW);
        await receipt('c', 'k2', NOW + 10);
        await h.store.submissionReceipts.create({
          giftWrapId: 'other-queue',
          agentKeyId: 'k1',
          queuePubkey: pk(200),
          createdAt: NOW,
          expiresAt: NOW + 86_400,
        });
        expect(await h.store.submissionReceipts.countByQueueSince(pk(100), NOW)).toBe(2);
        expect(await h.store.submissionReceipts.countByQueueSince(pk(100), 0)).toBe(3);
        expect(await h.store.submissionReceipts.countByQueueSince(pk(300), 0)).toBe(0);
      });

      it('hides expired receipts and refuses a duplicate gift wrap id', async () => {
        await receipt('w1', 'k1', NOW, NOW + 5);
        expect(await h.store.submissionReceipts.get('w1', NOW)).toBeDefined();
        expect(await h.store.submissionReceipts.get('w1', NOW + 5)).toBeUndefined();
        expect(await h.store.submissionReceipts.listByAgentKey('k1', NOW + 5)).toEqual([]);
        await expect(receipt('w1', 'k1', NOW)).rejects.toThrow();
        expect(await h.store.submissionReceipts.delete('w1')).toBe(true);
      });
    });

    describe('pairingSessions', () => {
      const session = (code: string, expiresAt = NOW + 120) =>
        h.store.pairingSessions.create({
          code,
          queuePubkey: pk(100),
          uri: `nostrpair://${pk(7)}?relay=wss%3A%2F%2Frelay.example&secret=s`,
          createdAt: NOW,
          expiresAt,
        });

      it('counts attempts and is taken once', async () => {
        const created = await session('0123ABCD');
        expect(created.attempts).toBe(0);
        expect(await h.store.pairingSessions.recordAttempt('0123ABCD', NOW)).toBe(1);
        expect(await h.store.pairingSessions.recordAttempt('0123ABCD', NOW)).toBe(2);
        expect(await h.store.pairingSessions.recordAttempt('ZZZZZZZZ', NOW)).toBeUndefined();
        const taken = await h.store.pairingSessions.take('0123ABCD', NOW);
        expect(taken?.uri).toMatch(/^nostrpair:\/\//);
        expect(await h.store.pairingSessions.take('0123ABCD', NOW)).toBeUndefined();
        expect(await h.store.pairingSessions.get('0123ABCD', NOW)).toBeUndefined();
      });

      it('creates only over a free or expired code, and counts live sessions per queue', async () => {
        const row = {
          code: '0123ABCD',
          queuePubkey: pk(100),
          uri: 'nostrpair://a',
          createdAt: NOW,
          expiresAt: NOW + 120,
        };
        expect((await h.store.pairingSessions.createIfFree(row, NOW))?.uri).toBe('nostrpair://a');
        expect(
          await h.store.pairingSessions.createIfFree({ ...row, uri: 'nostrpair://b' }, NOW + 119)
        ).toBeUndefined();
        expect(await h.store.pairingSessions.countLive(pk(100), NOW)).toBe(1);
        expect(await h.store.pairingSessions.countLive(pk(101), NOW)).toBe(0);
        await session('ZZZZZZZZ');
        expect(await h.store.pairingSessions.countLive(pk(100), NOW)).toBe(2);
        expect(await h.store.pairingSessions.countLive(pk(100), NOW + 120)).toBe(0);
        const replaced = await h.store.pairingSessions.createIfFree(
          {
            ...row,
            queuePubkey: pk(101),
            uri: 'nostrpair://c',
            createdAt: NOW + 120,
            expiresAt: NOW + 240,
          },
          NOW + 120
        );
        expect(replaced).toMatchObject({ queuePubkey: pk(101), uri: 'nostrpair://c', attempts: 0 });
        expect((await h.store.pairingSessions.get('0123ABCD', NOW + 121))?.uri).toBe(
          'nostrpair://c'
        );
      });

      it('is invisible and untakeable once expired', async () => {
        await session('0123ABCD');
        expect(await h.store.pairingSessions.get('0123ABCD', NOW + 119)).toBeDefined();
        expect(await h.store.pairingSessions.get('0123ABCD', NOW + 120)).toBeUndefined();
        expect(await h.store.pairingSessions.take('0123ABCD', NOW + 120)).toBeUndefined();
        expect(await h.store.pairingSessions.recordAttempt('0123ABCD', NOW + 120)).toBeUndefined();
        expect(await h.store.pairingSessions.delete('0123ABCD')).toBe(true);
      });
    });

    describe('nip98Replays', () => {
      it('accepts an event id once until it expires', async () => {
        expect(await h.store.nip98Replays.remember('e1', NOW + 60, NOW)).toBe(true);
        expect(await h.store.nip98Replays.remember('e1', NOW + 60, NOW)).toBe(false);
        expect(await h.store.nip98Replays.has('e1', NOW)).toBe(true);
        expect(await h.store.nip98Replays.has('e1', NOW + 60)).toBe(false);
        // Expired but not yet swept: new again.
        expect(await h.store.nip98Replays.remember('e1', NOW + 200, NOW + 60)).toBe(true);
        expect(await h.store.nip98Replays.has('e1', NOW + 100)).toBe(true);
        expect(await h.store.nip98Replays.delete('e1')).toBe(true);
      });
    });

    describe('hostedQueues', () => {
      it('registers idempotently, keeping the first source', async () => {
        const a = await h.store.hostedQueues.register({
          queuePubkey: pk(100),
          source: 'setup',
          createdAt: NOW,
          updatedAt: NOW,
        });
        const b = await h.store.hostedQueues.register({
          queuePubkey: pk(100),
          source: 'pairing',
          createdAt: NOW + 1,
          updatedAt: NOW + 1,
        });
        expect(b).toEqual(a);
        expect(b.source).toBe('setup');
      });

      it('moves eligibility to the new key on rotation', async () => {
        await h.store.hostedQueues.register({
          queuePubkey: pk(100),
          source: 'setup',
          createdAt: NOW,
          updatedAt: NOW,
        });
        const moved = await h.store.hostedQueues.move(pk(100), pk(101), NOW + 5);
        expect(moved).toMatchObject({ queuePubkey: pk(101), source: 'rotation', createdAt: NOW });
        expect(await h.store.hostedQueues.get(pk(100))).toBeUndefined();
        expect(await h.store.hostedQueues.move(pk(100), pk(101), NOW + 6)).toBeUndefined();
      });

      it('drops the old key when the new one is already registered', async () => {
        for (const n of [100, 101]) {
          await h.store.hostedQueues.register({
            queuePubkey: pk(n),
            source: 'setup',
            createdAt: NOW,
            updatedAt: NOW,
          });
        }
        expect((await h.store.hostedQueues.move(pk(100), pk(101), NOW))?.queuePubkey).toBe(pk(101));
        expect(await h.store.hostedQueues.get(pk(100))).toBeUndefined();
        expect(await h.store.hostedQueues.delete(pk(101))).toBe(true);
      });
    });

    describe('usageCounters', () => {
      it('reserves up to the limit exactly, per scope and window, and releases', async () => {
        const r = (limit: number, window = NOW) =>
          h.store.usageCounters.reserve('create_draft', window, limit, window + 86_400);
        expect(await r(3)).toBe(1);
        expect(await r(3)).toBe(2);
        expect(await r(3)).toBe(3);
        expect(await r(3)).toBeUndefined();
        expect(await h.store.usageCounters.get('create_draft', NOW)).toBe(3);
        await h.store.usageCounters.release('create_draft', NOW);
        expect(await r(3)).toBe(3);
        expect(await r(3, NOW + 86_400)).toBe(1);
        expect(await h.store.usageCounters.reserve('other', NOW, 3, NOW + 1)).toBe(1);
        expect(await h.store.usageCounters.get('nothing', NOW)).toBe(0);
      });

      it('never reserves under a limit below 1, and never releases below 0', async () => {
        expect(await h.store.usageCounters.reserve('s', NOW, 0, NOW + 1)).toBeUndefined();
        expect(await h.store.usageCounters.get('s', NOW)).toBe(0);
        await h.store.usageCounters.reserve('s', NOW, 1, NOW + 1);
        await h.store.usageCounters.release('s', NOW);
        await h.store.usageCounters.release('s', NOW);
        expect(await h.store.usageCounters.get('s', NOW)).toBe(0);
      });

      it('holds the limit under concurrent reservations', async () => {
        const results = await Promise.all(
          Array.from({ length: 20 }, () => h.store.usageCounters.reserve('c', NOW, 7, NOW + 86_400))
        );
        expect(results.filter((n) => n !== undefined)).toHaveLength(7);
        expect(await h.store.usageCounters.get('c', NOW)).toBe(7);
      });
    });

    describe('sweepExpired', () => {
      it('deletes expired rows in every TTL table and the keys of unapproved expired authorizations', async () => {
        await seedClient();
        // k-denied, k-fetched: minted for authorizations that expired without approval.
        // k-approved: its authorization expired after approval. k-live: authorization still open.
        for (const [i, id] of ['k-denied', 'k-fetched', 'k-approved', 'k-live'].entries()) {
          await seedKey(id, i + 1);
        }
        const auth = async (
          id: string,
          agentKeyId: string,
          status: 'fetched' | 'approved' | 'denied',
          expiresAt: number
        ) => {
          await h.store.pendingAuthorizations.create({
            id,
            userCode: id,
            clientId: CLIENT,
            redirectUri: 'http://127.0.0.1:3000/cb',
            codeChallenge: 'c',
            scopes: 'submit',
            status,
            agentKeyId,
            createdAt: NOW - 600,
            expiresAt,
          });
        };
        await auth('a-denied', 'k-denied', 'denied', NOW);
        await auth('a-fetched', 'k-fetched', 'fetched', NOW - 1);
        await auth('a-approved', 'k-approved', 'approved', NOW - 1);
        await auth('a-live', 'k-live', 'fetched', NOW + 1);
        await h.store.pendingAuthorizations.create({
          id: 'a-unfetched',
          userCode: 'a-unfetched',
          clientId: CLIENT,
          redirectUri: 'http://127.0.0.1:3000/cb',
          codeChallenge: 'c',
          scopes: 'submit',
          status: 'pending',
          createdAt: NOW - 600,
          expiresAt: NOW - 1,
        });

        for (const [codeHash, expiresAt] of [
          ['c-old', NOW],
          ['c-new', NOW + 1],
        ] as const) {
          await h.store.oauthCodes.create({
            codeHash,
            clientId: CLIENT,
            agentKeyId: 'k-approved',
            redirectUri: 'http://127.0.0.1:3000/cb',
            codeChallenge: 'c',
            scopes: 'submit',
            createdAt: NOW - 60,
            expiresAt,
          });
        }
        for (const [tokenHash, expiresAt] of [
          ['t-old', NOW - 5],
          ['t-new', NOW + 5],
        ] as const) {
          await h.store.oauthTokens.create({
            tokenHash,
            kind: 'access',
            clientId: CLIENT,
            agentKeyId: 'k-approved',
            scopes: 'submit',
            createdAt: NOW - 60,
            expiresAt,
          });
        }
        for (const [giftWrapId, expiresAt] of [
          ['w-old', NOW],
          ['w-new', NOW + 86_400],
        ] as const) {
          await h.store.submissionReceipts.create({
            giftWrapId,
            agentKeyId: 'k-approved',
            queuePubkey: pk(100),
            createdAt: NOW - 60,
            expiresAt,
          });
        }
        for (const [code, expiresAt] of [
          ['OLDOLDOL', NOW],
          ['NEWNEWNE', NOW + 120],
        ] as const) {
          await h.store.pairingSessions.create({
            code,
            queuePubkey: pk(100),
            uri: 'nostrpair://x',
            createdAt: NOW - 120,
            expiresAt,
          });
        }
        await h.store.nip98Replays.remember('e-old', NOW - 1, NOW - 100);
        await h.store.nip98Replays.remember('e-new', NOW + 60, NOW - 100);
        await h.store.usageCounters.reserve('create_draft', NOW - 86_400, 10, NOW);
        await h.store.usageCounters.reserve('create_draft', NOW, 10, NOW + 1);

        expect(await h.store.sweepExpired(NOW)).toEqual({
          agentKeys: 2,
          pendingAuthorizations: 4,
          oauthCodes: 1,
          oauthTokens: 1,
          submissionReceipts: 1,
          pairingSessions: 1,
          nip98Replays: 1,
          usageCounters: 1,
        });

        expect(await h.store.agentKeys.get('k-denied')).toBeUndefined();
        expect(await h.store.agentKeys.get('k-fetched')).toBeUndefined();
        expect(await h.store.agentKeys.get('k-approved')).toBeDefined();
        expect(await h.store.agentKeys.get('k-live')).toBeDefined();
        expect((await h.store.pendingAuthorizations.get('a-live', NOW))?.agentKeyId).toBe('k-live');
        expect(await h.store.oauthCodes.get('c-new', NOW)).toBeDefined();
        expect(await h.store.oauthTokens.get('t-new', NOW)).toBeDefined();
        expect(await h.store.submissionReceipts.get('w-new', NOW)).toBeDefined();
        expect(await h.store.pairingSessions.get('NEWNEWNE', NOW)).toBeDefined();
        expect(await h.store.nip98Replays.has('e-new', NOW)).toBe(true);

        const remaining = await rows<{ n: number }>(
          sql`select (select count(*) from pending_authorizations) + (select count(*) from oauth_codes)
            + (select count(*) from oauth_tokens) + (select count(*) from submission_receipts)
            + (select count(*) from pairing_sessions) + (select count(*) from nip98_replays)
            + (select count(*) from usage_counters) as n`
        );
        expect(remaining[0]?.n).toBe(7);

        expect(await h.store.sweepExpired(NOW)).toEqual({
          agentKeys: 0,
          pendingAuthorizations: 0,
          oauthCodes: 0,
          oauthTokens: 0,
          submissionReceipts: 0,
          pairingSessions: 0,
          nip98Replays: 0,
          usageCounters: 0,
        });
      });
    });
  });
}
