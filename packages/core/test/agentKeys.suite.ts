import {
  buildAgentGrant,
  buildSubmission,
  createLocalSigner,
  openSubmission,
  parseAgentGrant,
} from '@qusme/nostr';
import type { QusmeDb, Store } from '@qusme/store-sql';
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentKeyError, createAgentKeyCustody, createAgentKeyRing } from '../src/index.ts';

/** A fresh, migrated, empty store on one driver. */
export interface Harness {
  store: Store;
  db: QusmeDb;
}

const NOW = 1_800_000_000;
const CLIENT = 'https://client.example/oauth/metadata.json';
const S1 = btoa('a'.repeat(32));
const S2 = btoa('b'.repeat(32));
const ring1 = createAgentKeyRing({ secret: S1 });
const ring2 = createAgentKeyRing({ secret: S2, version: 2, previous: S1 });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentKeyError);
    return (err as AgentKeyError).code;
  }
  throw new Error('expected an AgentKeyError');
}

/** Agent key custody against a real store, run once per driver. */
export function custodySuite(driver: string, setup: () => { fresh(): Promise<Harness> }) {
  describe(`agent key custody on ${driver}`, () => {
    const { fresh } = setup();
    let h: Harness;
    async function ciphertext(id: string): Promise<Uint8Array> {
      const sealed = (await h.store.agentKeys.get(id))?.encryptedSecretKey;
      if (!sealed) throw new Error(`no ciphertext for ${id}`);
      return sealed;
    }
    beforeEach(async () => {
      h = await fresh();
      await h.store.oauthClients.upsert({
        clientId: CLIENT,
        metadata: { client_name: 'Example' },
        clientName: 'Example',
        redirectUris: ['http://127.0.0.1:3000/cb'],
        registrationSource: 'metadata_document',
        fetchedAt: NOW,
        createdAt: NOW,
      });
    });

    it('mints a key and stores only its ciphertext', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      const key = await custody.mint({ clientId: CLIENT, now: NOW });
      expect(key).toEqual({
        id: expect.any(String),
        pubkey: expect.stringMatching(/^[0-9a-f]{64}$/),
        clientId: CLIENT,
        keyVersion: 1,
        createdAt: NOW,
        revokedAt: null,
      });
      expect(Object.keys(key)).not.toContain('encryptedSecretKey');
      const row = await h.store.agentKeys.get(key.id);
      expect(row?.encryptedSecretKey).toBeInstanceOf(Uint8Array);
      expect(row?.encryptedSecretKey?.length).toBe(61);
      expect(await custody.get(key.id)).toEqual(key);
    });

    it('signs as the agent inside withAgentKey and disables the signer afterwards', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      const key = await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      let leaked: Awaited<Parameters<Parameters<typeof custody.withAgentKey>[1]>[0]> | undefined;
      const event = await custody.withAgentKey('k1', async (signer) => {
        leaked = signer;
        expect(await signer.getPublicKey()).toBe(key.pubkey);
        return signer.signEvent({ kind: 1, tags: [], content: 'hi', created_at: NOW });
      });
      expect(event.pubkey).toBe(key.pubkey);
      expect(verifyEvent(event)).toBe(true);
      expect(await code((leaked as NonNullable<typeof leaked>).signEvent(event))).toBe('closed');
    });

    it('builds a submission the queue opens, as the agent (spec 7.5)', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      const key = await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      const queue = createLocalSigner(generateSecretKey());
      const queuePubkey = await queue.getPublicKey();
      const value = { site: 'x', account: 'lokkju', field: 'text', content: 'from an agent' };
      const viaScope = await custody.withAgentKey('k1', (agent) =>
        buildSubmission(agent, queuePubkey, value, { now: NOW })
      );
      const viaSigner = await buildSubmission(custody.signer('k1'), queuePubkey, value, {
        now: NOW,
      });
      for (const wrap of [viaScope, viaSigner]) {
        const opened = await openSubmission(wrap, queue);
        expect(opened.ok && opened.value.submitter).toBe(key.pubkey);
        expect(opened.ok && opened.value.value.content).toBe('from an agent');
      }
    });

    it('decrypts the agent grant addressed to it (spec 7.4)', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      const key = await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      const queue = createLocalSigner(generateSecretKey());
      const grant = await buildAgentGrant(
        queue,
        key.pubkey,
        {
          inbox: ['wss://inbox.example/'],
          inbox_pubkey: await queue.getPublicKey(),
          destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
          quota: { max_submissions: 5, period: 'day' },
        },
        { createdAt: NOW }
      );
      const parsed = await parseAgentGrant(grant, custody.signer('k1'));
      expect(parsed.ok && parsed.value.grant.inbox).toEqual(['wss://inbox.example/']);
    });

    it('refuses a revoked key and discards its ciphertext', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      const signer = custody.signer('k1');
      expect(await custody.revoke('k1', NOW + 1)).toBe(true);
      expect(await custody.revoke('k1', NOW + 2)).toBe(false);
      expect((await h.store.agentKeys.get('k1'))?.encryptedSecretKey).toBeNull();
      expect((await custody.get('k1'))?.revokedAt).toBe(NOW + 1);
      const template = { kind: 1, tags: [], content: '', created_at: NOW };
      expect(await code(signer.signEvent(template))).toBe('revoked');
      expect(await code(signer.getPublicKey())).toBe('revoked');
      expect(await code(custody.withAgentKey('k1', async () => 1))).toBe('revoked');
    });

    it('destroys a key outright', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      expect(await custody.destroy('k1')).toBe(true);
      expect(await custody.destroy('k1')).toBe(false);
      expect(await custody.get('k1')).toBeUndefined();
      expect(await code(custody.withAgentKey('k1', async () => 1))).toBe('not_found');
    });

    it('refuses a ciphertext moved to another row', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      await custody.mint({ clientId: CLIENT, now: NOW, id: 'k2' });
      await h.store.agentKeys.reencrypt('k2', await ciphertext('k1'), 1);
      expect(await code(custody.withAgentKey('k2', async () => 1))).toBe('undecryptable');
    });

    it('refuses a key version changed in the database', async () => {
      const custody = createAgentKeyCustody(h.store, ring2);
      await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      await h.store.agentKeys.reencrypt('k1', await ciphertext('k1'), 1);
      expect(await code(custody.withAgentKey('k1', async () => 1))).toBe('undecryptable');
    });

    it('refuses to decrypt under the wrong secret', async () => {
      await createAgentKeyCustody(h.store, ring1).mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      const wrong = createAgentKeyCustody(h.store, createAgentKeyRing({ secret: S2 }));
      expect(await code(wrong.withAgentKey('k1', async () => 1))).toBe('undecryptable');
    });

    it('rotates many keys from version 1 to 2', async () => {
      const v1 = createAgentKeyCustody(h.store, ring1);
      const minted = [];
      for (let i = 0; i < 25; i++) {
        minted.push(await v1.mint({ clientId: CLIENT, now: NOW, id: `k${i}` }));
      }
      await v1.revoke('k3', NOW);
      const v2 = createAgentKeyCustody(h.store, ring2);

      // Version 2 is current; keys still under 1 keep working through the previous secret.
      const before = await v2.withAgentKey('k0', (s) => s.getPublicKey());
      expect(before).toBe(minted[0]?.pubkey);
      const fresh = await v2.mint({ clientId: CLIENT, now: NOW, id: 'fresh' });
      expect(fresh.keyVersion).toBe(2);

      const result = await v2.rotate({ batchSize: 7 });
      expect(result).toEqual({ reencrypted: 24, failed: [] });
      expect(await h.store.agentKeys.listBelowKeyVersion(2)).toEqual([]);
      expect((await v2.get('k3'))?.keyVersion).toBe(1);

      // Once moved, the keys need only the new secret.
      const only2 = createAgentKeyCustody(h.store, createAgentKeyRing({ secret: S2, version: 2 }));
      for (const key of minted) {
        if (key.id === 'k3') continue;
        const event = await only2.withAgentKey(key.id, (s) =>
          s.signEvent({ kind: 1, tags: [], content: '', created_at: NOW })
        );
        expect(event.pubkey).toBe(key.pubkey);
        expect((await only2.get(key.id))?.keyVersion).toBe(2);
      }
      expect(await code(only2.withAgentKey('k3', async () => 1))).toBe('revoked');
      expect(await v2.rotate()).toEqual({ reencrypted: 0, failed: [] });
    }, 60_000);

    it('reports keys it cannot move and stops instead of looping', async () => {
      const v1 = createAgentKeyCustody(h.store, ring1);
      for (let i = 0; i < 3; i++) await v1.mint({ clientId: CLIENT, now: NOW, id: `k${i}` });
      // Damage one ciphertext.
      const damaged = (await ciphertext('k1')).slice();
      damaged[30] = (damaged[30] as number) ^ 1;
      await h.store.agentKeys.reencrypt('k1', damaged, 1);

      const result = await createAgentKeyCustody(h.store, ring2).rotate({ batchSize: 2 });
      expect(result).toEqual({ reencrypted: 2, failed: [{ id: 'k1', code: 'undecryptable' }] });

      // Two versions on: version 1's secret is gone, so nothing moves.
      const ring3 = createAgentKeyRing({ secret: btoa('c'.repeat(32)), version: 3, previous: S2 });
      await createAgentKeyCustody(h.store, ring1).mint({ clientId: CLIENT, now: NOW, id: 'old' });
      const r3 = await createAgentKeyCustody(h.store, ring3).rotate();
      expect(r3.reencrypted).toBe(2);
      expect(r3.failed.map((f) => f.code).sort()).toEqual(['unknown_version', 'unknown_version']);
    });

    it('never hands back the secret key', async () => {
      const custody = createAgentKeyCustody(h.store, ring1);
      const key = await custody.mint({ clientId: CLIENT, now: NOW, id: 'k1' });
      const signer = custody.signer('k1');
      const seen = JSON.stringify([key, await custody.get('k1'), signer, Object.keys(custody)]);
      expect(seen).not.toMatch(/secret/i);
      expect(await signer.getPublicKey()).toBe(key.pubkey);
    });
  });
}
