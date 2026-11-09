import {
  buildHttpAuth,
  createLocalSigner,
  encodeNcryptsec,
  httpAuthHeader,
  PairingSource,
  PairingTarget,
  parsePairingUri,
} from '@qusme/nostr';
import type { QusmeDb } from '@qusme/store-sql';
import { createStore } from '@qusme/store-sql';
import { Hono } from 'hono';
import { getPublicKey } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Nip98Env,
  nip98Auth,
  PAIRING_CODE_TTL_SECONDS,
  PAIRING_LOOKUP_WINDOW_SECONDS,
  PAIRING_LOOKUPS_PER_WINDOW,
  PAIRING_MAX_LIVE_PER_QUEUE,
  pairingRoutes,
} from '../src/index.ts';

const ORIGIN = 'https://app.qus.me';
const INTERNAL = 'http://10.42.0.17:8787';
const NOW = 1_800_000_000;
const queueKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const queue = createLocalSigner(queueKey);
const queuePubkey = getPublicKey(queueKey);
const RELAYS = ['wss://nos.lol', 'wss://relay.ditto.pub'];

/** The rendezvous mounted the way createApp mounts it, with a clock the test moves. */
function rendezvous(db: QusmeDb, random?: (n: number) => Uint8Array) {
  const clock = { now: NOW };
  const store = createStore(db);
  const app = new Hono<Nip98Env>();
  const requireNip98 = nip98Auth({
    publicOrigin: ORIGIN,
    replays: store.nip98Replays,
    now: () => clock.now,
  });
  app.route(
    '/pair',
    pairingRoutes({ sessions: store.pairingSessions, requireNip98, now: () => clock.now, random })
  );
  return { app, clock, store };
}

async function post(
  app: Hono<Nip98Env>,
  body: unknown,
  options: { now?: number; signer?: typeof queue; auth?: false } = {}
): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== false) {
    const event = await buildHttpAuth(
      options.signer ?? queue,
      { url: `${ORIGIN}/pair`, method: 'POST', body: text },
      { now: options.now ?? NOW }
    );
    headers.Authorization = httpAuthHeader(event);
  }
  return app.request(`${INTERNAL}/pair`, { method: 'POST', headers, body: text });
}

async function get(app: Hono<Nip98Env>, code: string, client = '198.51.100.7'): Promise<Response> {
  return app.request(`${INTERNAL}/pair/${encodeURIComponent(code)}`, {
    headers: { 'CF-Connecting-IP': client },
  });
}

const freshUri = () => new PairingSource(RELAYS, { now: NOW * 1000 }).uri;

/** The typed-code rendezvous against a real store, run once per driver. */
export function pairingSuite(driver: string, setup: () => { fresh(): Promise<QusmeDb> }) {
  describe(`typed-code pairing rendezvous on ${driver}`, () => {
    const { fresh } = setup();
    let db: QusmeDb;
    beforeEach(async () => {
      db = await fresh();
    });

    // Two scrypt runs at log_n 16 to build the payload; slow on a busy CI runner.
    it('runs the whole sequence: code, lookup, NIP-AB with the recovery backup', {
      timeout: 30_000,
    }, async () => {
      const { app, store } = rendezvous(db);
      const source = new PairingSource(RELAYS, { now: NOW * 1000 });
      source.markTypedCode();
      const created = await post(app, { uri: source.uri });
      expect(created.status).toBe(201);
      expect(created.headers.get('Cache-Control')).toBe('no-store');
      const { code, expires_at } = (await created.json()) as { code: string; expires_at: number };
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(expires_at).toBe(NOW + PAIRING_CODE_TTL_SECONDS);

      // Only the queue pubkey, the code, the URI and times are stored.
      const row = await store.pairingSessions.get(code, NOW);
      expect(row).toEqual({
        code,
        queuePubkey,
        uri: source.uri,
        createdAt: NOW,
        expiresAt: NOW + PAIRING_CODE_TTL_SECONDS,
      });

      // The user types it in lower case with the hyphen the device shows.
      const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
      const fetched = await get(app, typed);
      expect(fetched.status).toBe(200);
      const body = (await fetched.json()) as { uri: string; expires_at: number };
      expect(body).toEqual({ uri: source.uri, expires_at });

      const uri = parsePairingUri(body.uri);
      if (!uri.ok) throw new Error(uri.error.message);
      const target = new PairingTarget(uri.value, 'typed-code', {
        now: NOW * 1000,
        deadline: body.expires_at * 1000,
      });
      expect(source.receive(target.offer, NOW * 1000).notice).toEqual({
        type: 'sas',
        sas: target.sas,
      });
      target.confirmSas(NOW * 1000);
      const recoveryBackup = encodeNcryptsec(queueKey, '00'.repeat(16), { logN: 16 });
      const passphraseCopy = encodeNcryptsec(queueKey, 'passphrase', { logN: 16 });
      const notices = source
        .confirmSas({ passphraseCopy, recoveryBackup, relays: RELAYS, queuePubkey }, NOW * 1000)
        .publish.map((e) => target.receive(e, NOW * 1000).notice);
      expect(notices[1]).toEqual({
        type: 'payload',
        payload: {
          ncryptsec: recoveryBackup,
          logN: 16,
          unlockWith: 'recovery-code',
          relays: RELAYS,
          queuePubkey,
        },
      });
    });

    it('answers a code once', async () => {
      const { app } = rendezvous(db);
      const { code } = (await (await post(app, { uri: freshUri() })).json()) as { code: string };
      expect((await get(app, code)).status).toBe(200);
      const again = await get(app, code);
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({ error: 'unknown or expired code' });
    });

    it('answers 404 for a wrong code and 400 for something that is not a code', async () => {
      const { app } = rendezvous(db);
      await post(app, { uri: freshUri() });
      expect((await get(app, '00000000')).status).toBe(404);
      expect((await get(app, 'ABCDEFGU')).status).toBe(400);
      expect((await get(app, 'ABC')).status).toBe(400);
    });

    it('expires a code with the session, or earlier when the device says so', async () => {
      const { app, clock } = rendezvous(db);
      const a = (await (await post(app, { uri: freshUri() })).json()) as { code: string };
      const b = (await (
        await post(app, { uri: freshUri(), expires_at: NOW + 30 }, { now: NOW + 1 })
      ).json()) as { code: string; expires_at: number };
      expect(b.expires_at).toBe(NOW + 30);
      clock.now = NOW + 30;
      expect((await get(app, b.code)).status).toBe(404);
      clock.now = NOW + PAIRING_CODE_TTL_SECONDS;
      expect((await get(app, a.code)).status).toBe(404);

      // A later expires_at never extends the 120 s.
      clock.now = NOW + 200;
      const c = (await (
        await post(app, { uri: freshUri(), expires_at: NOW + 10_000 }, { now: NOW + 200 })
      ).json()) as { expires_at: number };
      expect(c.expires_at).toBe(NOW + 200 + PAIRING_CODE_TTL_SECONDS);
      const late = await post(app, { uri: freshUri(), expires_at: NOW + 200 }, { now: NOW + 200 });
      expect(late.status).toBe(400);
    });

    it('limits lookups per client', async () => {
      const { app, clock } = rendezvous(db);
      const { code } = (await (await post(app, { uri: freshUri() })).json()) as { code: string };
      for (let i = 0; i < PAIRING_LOOKUPS_PER_WINDOW; i++) {
        expect((await get(app, '00000000', '203.0.113.9')).status).toBe(404);
      }
      const limited = await get(app, code, '203.0.113.9');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBe(PAIRING_LOOKUP_WINDOW_SECONDS);
      // The guesser did not burn the code, and another client still gets it.
      expect((await get(app, code, '198.51.100.7')).status).toBe(200);
      clock.now = NOW + PAIRING_LOOKUP_WINDOW_SECONDS;
      expect((await get(app, '00000000', '203.0.113.9')).status).toBe(404);
    });

    it('caps the live codes one queue key holds', async () => {
      const { app } = rendezvous(db);
      for (let i = 0; i < PAIRING_MAX_LIVE_PER_QUEUE; i++) {
        expect((await post(app, { uri: freshUri() }, { now: NOW + i })).status).toBe(201);
      }
      const over = await post(app, { uri: freshUri() }, { now: NOW + 5 });
      expect(over.status).toBe(429);
      const other = createLocalSigner(Uint8Array.from({ length: 32 }, () => 9));
      expect((await post(app, { uri: freshUri() }, { now: NOW + 6, signer: other })).status).toBe(
        201
      );
    });

    it('requires NIP-98 and a valid nostrpair:// URI', async () => {
      const { app } = rendezvous(db);
      expect((await post(app, { uri: freshUri() }, { auth: false })).status).toBe(401);
      for (const [body, status] of [
        ['not json', 400],
        [[freshUri()], 400],
        [{}, 400],
        [{ uri: 'nostrconnect://x' }, 400],
        [{ uri: freshUri().replace('&v=1', '&v=2') }, 400],
        [{ uri: freshUri(), expires_at: '1800000100' }, 400],
        [JSON.stringify({ uri: freshUri(), pad: 'x'.repeat(5000) }), 413],
      ] as const) {
        const res = await post(app, body);
        expect({ body, status: res.status }).toEqual({ body, status });
      }
    });

    it('draws another code when one is taken, and gives up after five', async () => {
      const draws = [0, 0, 1].map((b) => new Uint8Array(8).fill(b));
      const { app } = rendezvous(db, () => draws.shift() ?? new Uint8Array(8));
      const first = (await (await post(app, { uri: freshUri() })).json()) as { code: string };
      expect(first.code).toBe('00000000');
      const second = (await (await post(app, { uri: freshUri() }, { now: NOW + 1 })).json()) as {
        code: string;
      };
      expect(second.code).toBe('11111111');
      // Every further draw is 00000000, which is held.
      expect((await post(app, { uri: freshUri() }, { now: NOW + 2 })).status).toBe(503);
    });
  });
}
