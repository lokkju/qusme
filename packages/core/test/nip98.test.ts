import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHttpAuth, createLocalSigner, httpAuthHeader, type NostrEvent } from '@qusme/nostr';
import { createStore, type QusmeDb } from '@qusme/store-sql';
import { openD1 } from '@qusme/store-sql/d1';
import { migrationsFolder, openSqlite } from '@qusme/store-sql/sqlite';
import { Hono } from 'hono';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Nip98Env, nip98Auth, parsePublicOrigin, signedUrl } from '../src/index.ts';

const key = Uint8Array.from(
  Buffer.from('e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45', 'hex')
);
const signer = createLocalSigner(key);
const NOW = 1_761_400_000;
const ORIGIN = 'https://app.qus.me';
// What a Node server behind a reverse proxy sees: its own address, not app.qus.me.
const INTERNAL = 'http://10.42.0.17:8787';
const BODY = JSON.stringify({ uri: 'nostrpair://example' });

/** An app with one authenticated route that echoes the pubkey and the body it can still read. */
function appWith(db: QusmeDb, now: () => number = () => NOW) {
  const app = new Hono<Nip98Env>();
  const auth = nip98Auth({ publicOrigin: ORIGIN, replays: createStore(db).nip98Replays, now });
  app.on(['GET', 'POST', 'PUT'], '/pair', auth, async (c) => {
    // Either reader must still see the whole body; each consumes the request, so one per call.
    let body: unknown = null;
    if (c.req.method !== 'GET') {
      body = c.req.header('X-Read') === 'raw' ? await c.req.raw.text() : await c.req.json();
    }
    return c.json({ pubkey: c.var.pubkey, eventId: c.var.nip98.eventId, body });
  });
  return app;
}

async function header(
  facts: { url?: string; method?: string; body?: string },
  createdAt = NOW
): Promise<string> {
  const event = await buildHttpAuth(
    signer,
    { url: facts.url ?? `${ORIGIN}/pair?x=1`, method: facts.method ?? 'POST', body: facts.body },
    { now: createdAt }
  );
  return httpAuthHeader(event);
}

function post(app: Hono<Nip98Env>, auth: string | undefined, body = BODY, path = '/pair?x=1') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== undefined) headers.Authorization = auth;
  return app.request(`${INTERNAL}${path}`, { method: 'POST', headers, body });
}

async function expect401(res: Response, reason: RegExp) {
  expect(res.status).toBe(401);
  expect(res.headers.get('WWW-Authenticate')).toBe('Nostr');
  const out = (await res.json()) as { error: string; reason: string };
  expect(out.error).toBe('unauthorized');
  expect(out.reason).toMatch(reason);
}

describe('nip98Auth', () => {
  it('accepts a signed POST, exposes the pubkey and leaves the body readable', async () => {
    const app = appWith(openSqlite(':memory:'));
    const res = await post(app, await header({ body: BODY }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.pubkey).toBe(await signer.getPublicKey());
    expect(out.body).toEqual(JSON.parse(BODY));

    const raw = await app.request(`${INTERNAL}/pair?x=1`, {
      method: 'POST',
      headers: { Authorization: await header({ body: BODY }, NOW + 1), 'X-Read': 'raw' },
      body: BODY,
    });
    expect(((await raw.json()) as Record<string, unknown>).body).toBe(BODY);
  });

  it('accepts a signed GET with no payload tag', async () => {
    const app = appWith(openSqlite(':memory:'));
    const auth = await header({ url: `${ORIGIN}/pair`, method: 'GET' });
    const res = await app.request(`${INTERNAL}/pair`, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
  });

  it('builds the signed URL from the public origin, not the request or forwarded headers', async () => {
    const app = appWith(openSqlite(':memory:'));
    const res = await app.request(`${INTERNAL}/pair?x=1`, {
      method: 'POST',
      headers: {
        Authorization: await header({ url: 'https://evil.example/pair?x=1', body: BODY }),
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'https',
      },
      body: BODY,
    });
    await expect401(res, /u is not the request URL/);
  });

  it('refuses a missing header', async () => {
    await expect401(await post(appWith(openSqlite(':memory:')), undefined), /missing/);
  });

  it('refuses a header that is not a Nostr event', async () => {
    const app = appWith(openSqlite(':memory:'));
    await expect401(await post(app, 'Bearer abc'), /Nostr authorization/);
    await expect401(await post(app, 'Nostr !!!'), /base64/);
  });

  it('refuses a bad signature', async () => {
    const app = appWith(openSqlite(':memory:'));
    const event = await buildHttpAuth(
      signer,
      { url: `${ORIGIN}/pair?x=1`, method: 'POST', body: BODY },
      { now: NOW }
    );
    const forged: NostrEvent = {
      ...event,
      sig: event.sig.replace(/^./, (ch) => (ch === '0' ? '1' : '0')),
    };
    const res = await post(app, httpAuthHeader(forged));
    expect(res.status).toBe(401);
  });

  it('refuses an expired event', async () => {
    const app = appWith(openSqlite(':memory:'));
    await expect401(await post(app, await header({ body: BODY }, NOW - 61)), /60 s/);
    expect((await post(app, await header({ body: BODY }, NOW - 60))).status).toBe(200);
  });

  it('refuses an event dated beyond the window in the future', async () => {
    const app = appWith(openSqlite(':memory:'));
    await expect401(await post(app, await header({ body: BODY }, NOW + 61)), /60 s/);
    expect((await post(app, await header({ body: BODY }, NOW + 60))).status).toBe(200);
  });

  it.each([
    ['host', 'https://qus.me/pair?x=1'],
    ['scheme', 'http://app.qus.me/pair?x=1'],
    ['path', `${ORIGIN}/pair/x?x=1`],
    ['query', `${ORIGIN}/pair?x=2`],
    ['missing query', `${ORIGIN}/pair`],
  ])('refuses a wrong URL (%s)', async (_what, url) => {
    const app = appWith(openSqlite(':memory:'));
    await expect401(await post(app, await header({ url, body: BODY })), /u is not the request URL/);
  });

  it('refuses a wrong method', async () => {
    const app = appWith(openSqlite(':memory:'));
    const res = await app.request(`${INTERNAL}/pair?x=1`, {
      method: 'PUT',
      headers: { Authorization: await header({ body: BODY }) },
      body: BODY,
    });
    await expect401(res, /method/);
  });

  it('refuses a payload hash that is not the body', async () => {
    const app = appWith(openSqlite(':memory:'));
    await expect401(await post(app, await header({ body: `${BODY} ` })), /payload/);
  });

  it('refuses a body the event has no payload tag for', async () => {
    const app = appWith(openSqlite(':memory:'));
    await expect401(await post(app, await header({})), /payload/);
  });

  it('refuses a replay', async () => {
    const app = appWith(openSqlite(':memory:'));
    const auth = await header({ body: BODY });
    expect((await post(app, auth)).status).toBe(200);
    await expect401(await post(app, auth), /already used/);
  });
});

describe('parsePublicOrigin and signedUrl', () => {
  it('accepts a bare origin, with or without a trailing slash', () => {
    expect(parsePublicOrigin('https://app.qus.me')).toBe(ORIGIN);
    expect(parsePublicOrigin('https://app.qus.me/')).toBe(ORIGIN);
    expect(parsePublicOrigin('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('refuses anything but scheme and host', () => {
    expect(() => parsePublicOrigin('app.qus.me')).toThrow(/not a URL/);
    expect(() => parsePublicOrigin('ftp://app.qus.me')).toThrow(/http or https/);
    expect(() => parsePublicOrigin('https://app.qus.me/api')).toThrow(/scheme and host only/);
    expect(() => parsePublicOrigin('https://app.qus.me?x')).toThrow(/scheme and host only/);
    expect(() =>
      nip98Auth({ publicOrigin: 'https://app.qus.me/x', replays: {} as never })
    ).toThrow();
  });

  it('keeps the path and query as served and swaps the origin', () => {
    expect(signedUrl(ORIGIN, 'http://10.0.0.1:8787/a/b?c=d&e')).toBe(`${ORIGIN}/a/b?c=d&e`);
    expect(signedUrl(ORIGIN, 'http://10.0.0.1:8787')).toBe(`${ORIGIN}/`);
  });
});

/** Migrations as wrangler applies them to D1, statement by statement. */
function migrationStatements(): string[][] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) =>
    readFileSync(join(migrationsFolder, `${e.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

let mf: Miniflare;
let d1Db: QusmeDb;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'nip98',
          compatibilityDate: '2026-10-20',
          modules: [
            {
              type: 'ESModule',
              path: 'nip98.mjs',
              contents:
                'export default { fetch() { return new Response(null, { status: 204 }); } };',
            },
          ],
          d1Databases: { DB: 'nip98-test' },
        },
      ],
    })
  );
  const d1 = await mf.getD1Database('DB');
  for (const statements of migrationStatements()) {
    await d1.batch(statements.map((s) => d1.prepare(s)));
  }
  // Miniflare's D1 proxy and drizzle's D1 type are the same API declared twice.
  d1Db = openD1(d1 as unknown as Parameters<typeof openD1>[0]);
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe.each([
  ['better-sqlite3', () => openSqlite(':memory:') as QusmeDb],
  ['D1 (Miniflare)', () => d1Db],
])('replay storage on %s', (_driver, open) => {
  it('refuses a replay within the window and forgets the id once it has passed', async () => {
    const db = open();
    let now = NOW;
    const app = appWith(db, () => now);
    const auth = await header({ body: BODY });

    expect((await post(app, auth)).status).toBe(200);
    now = NOW + 60;
    await expect401(await post(app, auth), /already used/);

    const replays = createStore(db).nip98Replays;
    const eventId = JSON.parse(Buffer.from(auth.slice('Nostr '.length), 'base64').toString('utf8'))
      .id as string;
    expect(await replays.has(eventId, NOW + 60)).toBe(true);
    // Held one second past the last moment the event verifies, then swept.
    expect(await replays.has(eventId, NOW + 61)).toBe(false);
    expect((await createStore(db).sweepExpired(NOW + 61)).nip98Replays).toBeGreaterThanOrEqual(1);
    expect(await replays.has(eventId, NOW)).toBe(false);

    // By then the event itself is stale, so the header is still refused.
    now = NOW + 61;
    await expect401(await post(app, auth), /60 s/);
  });
});
