/**
 * Probes public Nostr relays for what a qus.me queue needs (docs/relays.md, issue #38).
 *
 *   pnpm -C packages/nostr relay-probe [--out results.json] [--no-burst] [wss://relay ...]
 *
 * Every run generates throwaway keys: a queue key Q, an agent key A, an unrelated key S, a junk
 * submitter J and two NIP-AB ephemeral keys. Payloads are small, every event published is deleted
 * at the end (NIP-09 by its author, NIP-59 gift wraps by their recipient), and the burst is 30
 * events. Results go to stdout as a table and, with --out, as JSON.
 */
import { writeFileSync } from 'node:fs';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  createLocalSigner,
  encodeNcryptsec,
  giftWrap,
  KIND_DRAFT_WRAP,
  KIND_GIFT_WRAP,
  nip44Encrypt,
} from '../src/index.ts';

const DEFAULT_RELAYS = [
  'wss://auth.nostr1.com',
  'wss://relay.0xchat.com',
  'wss://inbox.nostr.wine',
  'wss://nostr.wine',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
];

/** Placeholder kinds from the spec's ranges (2.2): replaceable and addressable. */
const KIND_SUBMITTERS = 13234;
const KIND_AGENT_GRANT = 33234;
const KIND_APP_DATA = 30078;
const KIND_PAIRING = 24134;
const KIND_DELETION = 5;

const now = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand = (): string => Math.random().toString(36).slice(2, 10);

type Msg = [string, ...unknown[]];

interface OkResult {
  ok: boolean;
  message: string;
}

interface QueryResult {
  events: NostrEvent[];
  eose: boolean;
  closed?: string;
}

/** A minimal NIP-01/NIP-42 client that records exactly what the relay says. */
class Conn {
  readonly url: string;
  readonly key: Uint8Array | undefined;
  challenge: string | undefined;
  authedAs: string | undefined;
  authResult: string | undefined;
  private ws: WebSocket;
  private listeners = new Set<(m: Msg) => void>();
  closedReason: string | undefined;

  private constructor(url: string, ws: WebSocket, key: Uint8Array | undefined) {
    this.url = url;
    this.ws = ws;
    this.key = key;
    ws.addEventListener('message', (e) => {
      let m: Msg;
      try {
        m = JSON.parse(String(e.data)) as Msg;
      } catch {
        return;
      }
      if (m[0] === 'AUTH' && typeof m[1] === 'string') this.challenge = m[1];
      for (const l of [...this.listeners]) l(m);
    });
    ws.addEventListener('close', (e) => {
      this.closedReason = `socket closed ${e.code} ${e.reason}`;
    });
  }

  /** Opens a connection; with a key, authenticates as soon as the relay sends a challenge. */
  static async open(url: string, key?: Uint8Array): Promise<Conn> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('connect error'));
      });
    });
    const conn = new Conn(url, ws, key);
    await conn.waitFor((m) => m[0] === 'AUTH', 1500);
    if (key && conn.challenge) await conn.auth();
    return conn;
  }

  private waitFor(pred: (m: Msg) => boolean, ms: number): Promise<Msg | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.listeners.delete(l);
        resolve(undefined);
      }, ms);
      const l = (m: Msg): void => {
        if (pred(m)) {
          clearTimeout(t);
          this.listeners.delete(l);
          resolve(m);
        }
      };
      this.listeners.add(l);
    });
  }

  private send(m: unknown[]): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  async auth(): Promise<string> {
    if (!this.key) return 'no key';
    if (this.authedAs) return 'ok';
    if (!this.challenge) await this.waitFor((m) => m[0] === 'AUTH', 2000);
    if (!this.challenge) {
      this.authResult = 'no challenge';
      return this.authResult;
    }
    const ev = finalizeEvent(
      {
        kind: 22242,
        created_at: now(),
        tags: [
          ['relay', this.url],
          ['challenge', this.challenge],
        ],
        content: '',
      },
      this.key
    );
    const okp = this.waitFor((m) => m[0] === 'OK' && m[1] === ev.id, 8000);
    this.send(['AUTH', ev]);
    const ok = await okp;
    if (!ok) this.authResult = 'no OK';
    else if (ok[2] === true) {
      this.authedAs = ev.pubkey;
      this.authResult = 'ok';
    } else this.authResult = `refused: ${String(ok[3])}`;
    return this.authResult;
  }

  /** Publishes; authenticates and retries once on `auth-required` when the connection has a key. */
  async publish(ev: NostrEvent, retried = false): Promise<OkResult> {
    const okp = this.waitFor((m) => m[0] === 'OK' && m[1] === ev.id, 10_000);
    this.send(['EVENT', ev]);
    const ok = await okp;
    if (!ok) return { ok: false, message: this.closedReason ?? 'no OK (timeout)' };
    const message = String(ok[3] ?? '');
    if (ok[2] !== true && message.includes('auth-required') && this.key && !retried) {
      await this.auth();
      if (this.authedAs) return this.publish(ev, true);
    }
    return { ok: ok[2] === true, message };
  }

  /** Stored events for the filter, until EOSE or CLOSED; retries once after AUTH like publish. */
  async query(filter: Record<string, unknown>, retried = false): Promise<QueryResult> {
    const sub = rand();
    const events: NostrEvent[] = [];
    const collect = (m: Msg): void => {
      if (m[0] === 'EVENT' && m[1] === sub) events.push(m[2] as NostrEvent);
    };
    this.listeners.add(collect);
    const end = this.waitFor((m) => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === sub, 8000);
    this.send(['REQ', sub, filter]);
    const m = await end;
    this.listeners.delete(collect);
    if (m?.[0] !== 'CLOSED') this.send(['CLOSE', sub]);
    if (m?.[0] === 'CLOSED') {
      const reason = String(m[2] ?? '');
      if (reason.includes('auth-required') && this.key && !retried) {
        await this.auth();
        if (this.authedAs) return this.query(filter, true);
      }
      return { events, eose: false, closed: reason };
    }
    return { events, eose: m !== undefined };
  }

  /** A live subscription; returns the events received so far and a stop function. */
  subscribe(filter: Record<string, unknown>): {
    events: NostrEvent[];
    state: { eose: boolean; closed?: string };
    stop: () => void;
  } {
    const sub = rand();
    const events: NostrEvent[] = [];
    const state: { eose: boolean; closed?: string } = { eose: false };
    const l = (m: Msg): void => {
      if (m[1] !== sub) return;
      if (m[0] === 'EVENT') events.push(m[2] as NostrEvent);
      else if (m[0] === 'EOSE') state.eose = true;
      else if (m[0] === 'CLOSED') state.closed = String(m[2] ?? '');
    };
    this.listeners.add(l);
    this.send(['REQ', sub, filter]);
    return {
      events,
      state,
      stop: () => {
        this.listeners.delete(l);
        this.send(['CLOSE', sub]);
      },
    };
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const sign = (t: Omit<EventTemplate, 'created_at'> & { created_at?: number }, key: Uint8Array) =>
  finalizeEvent({ created_at: now(), ...t }, key);

const short = (s: string): string => (s.length > 140 ? `${s.slice(0, 137)}...` : s);
const pub = (r: OkResult): string => (r.ok ? 'accepted' : `refused (${short(r.message)})`);
const seen = (r: QueryResult, id: string): string => {
  if (r.events.some((e) => e.id === id)) return 'yes';
  if (r.closed !== undefined) return `closed (${short(r.closed)})`;
  return r.eose ? 'no' : 'no (no EOSE)';
};

async function nip11(url: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(url.replace(/^ws/, 'http'), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(10_000),
    });
    const doc = (await res.json()) as Record<string, unknown>;
    return {
      software: doc.software,
      version: doc.version,
      supported_nips: doc.supported_nips,
      limitation: doc.limitation,
      fees: doc.fees,
      retention: doc.retention,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

type Results = Record<string, unknown>;

async function probe(url: string, burst: boolean): Promise<Results> {
  const r: Results = { relay: url, nip11: await nip11(url) };
  const qKey = generateSecretKey();
  const aKey = generateSecretKey();
  const sKey = generateSecretKey();
  const jKey = generateSecretKey();
  const p1Key = generateSecretKey();
  const p2Key = generateSecretKey();
  const Q = getPublicKey(qKey);
  const A = getPublicKey(aKey);
  const P2 = getPublicKey(p2Key);
  const qSigner = createLocalSigner(qKey);
  const published: NostrEvent[] = [];
  const wraps: NostrEvent[] = [];

  let author: Conn;
  let agent: Conn;
  let stranger: Conn;
  let anon: Conn;
  try {
    author = await Conn.open(url, qKey);
    agent = await Conn.open(url, aKey);
    stranger = await Conn.open(url, sKey);
    anon = await Conn.open(url);
  } catch (e) {
    r.error = String(e);
    return r;
  }
  const authState = (): Record<string, unknown> => ({
    challenge_on_connect: author.challenge !== undefined,
    author: author.authResult ?? 'not attempted',
    agent: agent.authResult ?? 'not attempted',
    other: stranger.authResult ?? 'not attempted',
  });

  const pubAs = async (conn: Conn, ev: NostrEvent): Promise<OkResult> => {
    const res = await conn.publish(ev);
    if (res.ok) published.push(ev);
    return res;
  };
  const reads = async (filter: Record<string, unknown>, id: string, also?: [string, Conn]) => {
    await sleep(800);
    const out: Record<string, string> = {
      author: seen(await author.query(filter), id),
      other_authed: seen(await stranger.query(filter), id),
      unauthed: seen(await anon.query(filter), id),
    };
    if (also) out[also[0]] = seen(await also[1].query(filter), id);
    return out;
  };

  // NIP-40, published first so the wait overlaps the other checks.
  const expiresAt = now() + 20;
  const expiring = sign(
    {
      kind: KIND_DRAFT_WRAP,
      tags: [
        ['d', `probe-exp-${rand()}`],
        ['k', '1'],
        ['expiration', String(expiresAt)],
      ],
      content: await qSigner.nip44Encrypt(Q, 'expiring'),
    },
    qKey
  );
  const expiredAlready = sign(
    {
      kind: KIND_DRAFT_WRAP,
      tags: [
        ['d', `probe-expd-${rand()}`],
        ['k', '1'],
        ['expiration', String(now() - 60)],
      ],
      content: await qSigner.nip44Encrypt(Q, 'expired'),
    },
    qKey
  );
  const expPub = await pubAs(author, expiring);
  const expiredPub = await pubAs(author, expiredAlready);
  // The same for a gift wrap, since an inbox relay may refuse every other kind.
  const expiringWrap = await giftWrap(
    { kind: 31235, tags: [['site', 'x']], content: 'expiring submission' },
    createLocalSigner(aKey),
    Q,
    { expiration: expiresAt }
  );
  const expWrapPub = await agent.publish(expiringWrap);

  // Kind 31234: a NIP-37 draft wrap.
  const draftD = `probe-${rand()}`;
  const draft = sign(
    {
      kind: KIND_DRAFT_WRAP,
      tags: [
        ['d', draftD],
        ['k', '1'],
      ],
      content: await qSigner.nip44Encrypt(Q, JSON.stringify({ kind: 1, content: 'probe draft' })),
    },
    qKey
  );
  r.draft_31234 = {
    write: pub(await pubAs(author, draft)),
    read: await reads({ kinds: [KIND_DRAFT_WRAP], authors: [Q], '#d': [draftD] }, draft.id),
  };

  // Kind 30078: the recovery backup (an ncryptsec) and the encrypted destinations.
  const recovery = sign(
    {
      kind: KIND_APP_DATA,
      tags: [['d', 'qus.me/recovery']],
      content: encodeNcryptsec(qKey, `probe ${rand()} ${rand()}`, { logN: 16 }),
    },
    qKey
  );
  r.recovery_30078 = {
    write: pub(await pubAs(author, recovery)),
    read: await reads(
      { kinds: [KIND_APP_DATA], authors: [Q], '#d': ['qus.me/recovery'] },
      recovery.id
    ),
  };
  const destinations = sign(
    {
      kind: KIND_APP_DATA,
      tags: [['d', 'qus.me/destinations']],
      content: await qSigner.nip44Encrypt(Q, JSON.stringify({ destinations: [] })),
    },
    qKey
  );
  r.destinations_30078 = {
    write: pub(await pubAs(author, destinations)),
    read: await reads(
      { kinds: [KIND_APP_DATA], authors: [Q], '#d': ['qus.me/destinations'] },
      destinations.id
    ),
  };

  // Submitters list (replaceable placeholder) and agent grant (addressable placeholder).
  const submitters = sign(
    {
      kind: KIND_SUBMITTERS,
      tags: [['p', A]],
      content: await qSigner.nip44Encrypt(Q, JSON.stringify({ [A]: { label: 'probe' } })),
    },
    qKey
  );
  r.submitters_13234 = {
    write: pub(await pubAs(author, submitters)),
    read: await reads({ kinds: [KIND_SUBMITTERS], '#p': [A] }, submitters.id, ['agent', agent]),
  };
  const grant = sign(
    {
      kind: KIND_AGENT_GRANT,
      tags: [['d', A]],
      content: await qSigner.nip44Encrypt(A, JSON.stringify({ destinations: [] })),
    },
    qKey
  );
  r.grant_33234 = {
    write: pub(await pubAs(author, grant)),
    read: await reads({ kinds: [KIND_AGENT_GRANT], authors: [Q], '#d': [A] }, grant.id, [
      'agent',
      agent,
    ]),
  };

  // Kind 1059: a submission from the agent over its authed connection, and a junk wrap from an
  // unknown key over an unauthenticated connection.
  // Two hours, not a queue's 30 days, so a wrap a relay won't delete is gone soon anyway.
  const wrapExpiration = now() + 2 * 3600;
  const wrapA = await giftWrap(
    { kind: 31235, tags: [['site', 'x']], content: 'probe submission' },
    createLocalSigner(aKey),
    Q,
    { expiration: wrapExpiration }
  );
  const wrapJ = await giftWrap(
    { kind: 31235, tags: [['site', 'x']], content: 'junk' },
    createLocalSigner(jKey),
    Q,
    { expiration: wrapExpiration }
  );
  const wA = await agent.publish(wrapA);
  const wJ = await anon.publish(wrapJ);
  if (wA.ok) wraps.push(wrapA);
  if (wJ.ok) wraps.push(wrapJ);
  const wrapFilter = { kinds: [KIND_GIFT_WRAP], '#p': [Q], since: now() - 3 * 24 * 3600 };
  await sleep(800);
  const qRead = await author.query(wrapFilter);
  const sRead = await stranger.query(wrapFilter);
  const uRead = await anon.query(wrapFilter);
  r.giftwrap_1059 = {
    write_agent_authed: pub(wA),
    write_unknown_unauthed: pub(wJ),
    read_by_recipient: seen(qRead, wrapA.id),
    read_by_other_authed: seen(sRead, wrapA.id),
    read_unauthed: seen(uRead, wrapA.id),
  };

  // Kind 24134: NIP-AB pairing between two ephemeral keys.
  let source: Conn | undefined;
  let target: Conn | undefined;
  try {
    source = await Conn.open(url, p1Key);
    target = await Conn.open(url, p2Key);
    const pairFilter = { kinds: [KIND_PAIRING], '#p': [P2] };
    const liveTarget = target.subscribe(pairFilter);
    const liveOther = stranger.subscribe(pairFilter);
    const liveAnon = anon.subscribe(pairFilter);
    await sleep(1500);
    const pairing = sign(
      {
        kind: KIND_PAIRING,
        tags: [['p', P2]],
        content: nip44Encrypt(p1Key, P2, JSON.stringify({ type: 'offer', version: 1 })),
      },
      p1Key
    );
    const pw = await source.publish(pairing);
    await sleep(3000);
    const has = (l: { events: NostrEvent[]; state: { closed?: string } }): string =>
      l.events.some((e) => e.id === pairing.id)
        ? 'yes'
        : l.state.closed
          ? `closed (${short(l.state.closed)})`
          : 'no';
    r.pairing_24134 = {
      write: pub(pw),
      live_to_recipient: has(liveTarget),
      live_to_other_authed: has(liveOther),
      live_unauthed: has(liveAnon),
      stored: seen(await anon.query({ kinds: [KIND_PAIRING], ids: [pairing.id] }), pairing.id),
    };
    for (const l of [liveTarget, liveOther, liveAnon]) l.stop();
  } catch (e) {
    r.pairing_24134 = { error: String(e) };
  } finally {
    source?.close();
    target?.close();
  }

  // Sizes: 10 KB and 64 KB of base64-like content in a draft wrap.
  const sized = async (bytes: number): Promise<string> => {
    const content = Buffer.alloc(Math.ceil((bytes * 3) / 4), 7)
      .toString('base64')
      .slice(0, bytes);
    return pub(
      await pubAs(
        author,
        sign({ kind: KIND_DRAFT_WRAP, tags: [['d', `probe-size-${rand()}`]], content }, qKey)
      )
    );
  };
  r.size = { '10KB': await sized(10 * 1024), '64KB': await sized(64 * 1024) };

  // NIP-09: author deletes the draft wrap.
  const delDraft = sign(
    {
      kind: KIND_DELETION,
      tags: [
        ['e', draft.id],
        ['a', `${KIND_DRAFT_WRAP}:${Q}:${draftD}`],
        ['k', String(KIND_DRAFT_WRAP)],
      ],
      content: '',
    },
    qKey
  );
  const dd = await pubAs(author, delDraft);
  await sleep(800);
  r.delete_author = {
    write: pub(dd),
    still_served: seen(await author.query({ ids: [draft.id] }), draft.id),
  };

  // NIP-59 / nips#2350: the recipient deletes the agent's gift wrap, then the agent republishes it.
  if (wA.ok) {
    const delWrap = sign(
      {
        kind: KIND_DELETION,
        tags: [
          ['e', wrapA.id],
          ['k', String(KIND_GIFT_WRAP)],
        ],
        content: '',
      },
      qKey
    );
    const dw = await pubAs(author, delWrap);
    await sleep(800);
    const after = seen(await author.query({ ids: [wrapA.id] }), wrapA.id);
    const again = await agent.publish(wrapA);
    await sleep(800);
    r.delete_recipient_1059 = {
      write: pub(dw),
      still_served: after,
      republish: pub(again),
      served_after_republish: seen(await author.query({ ids: [wrapA.id] }), wrapA.id),
    };
  } else r.delete_recipient_1059 = { skipped: 'gift wrap not stored' };

  // Burst: 30 small draft wraps sent without waiting between them.
  if (burst) {
    const evs = Array.from({ length: 30 }, (_, i) =>
      sign(
        { kind: KIND_DRAFT_WRAP, tags: [['d', `probe-burst-${i}-${rand()}`]], content: 'x' },
        qKey
      )
    );
    const t0 = Date.now();
    const oks = await Promise.all(evs.map((e) => author.publish(e)));
    evs.forEach((e, i) => {
      if (oks[i]?.ok) published.push(e);
    });
    const refused = oks.filter((o) => !o.ok).map((o) => short(o.message));
    r.burst_30 = {
      accepted: oks.filter((o) => o.ok).length,
      ms: Date.now() - t0,
      refusals: [...new Set(refused)],
    };
  }

  // NIP-40: was the expiring event served before and after its expiration?
  const wait = expiresAt + 5 - now();
  if (wait > 0) await sleep(wait * 1000);
  r.expiration = {
    write: pub(expPub),
    already_expired_write: pub(expiredPub),
    served_after_expiry: seen(await author.query({ ids: [expiring.id] }), expiring.id),
    wrap_write: pub(expWrapPub),
    wrap_served_after_expiry: expWrapPub.ok
      ? seen(
          await author.query({ kinds: [KIND_GIFT_WRAP], '#p': [Q], ids: [expiringWrap.id] }),
          expiringWrap.id
        )
      : 'not stored',
  };
  if (expWrapPub.ok) wraps.push(expiringWrap);

  // Cleanup: one deletion per 100 of the author's events, the recipient's for the junk wrap.
  const mine = published.filter((e) => e.pubkey === Q && e.kind !== KIND_DELETION);
  for (let i = 0; i < mine.length; i += 100) {
    const chunk = mine.slice(i, i + 100);
    const tags: string[][] = [];
    for (const e of chunk) {
      tags.push(['e', e.id]);
      const d = e.tags.find((t) => t[0] === 'd')?.[1];
      if (e.kind >= 30000 && e.kind < 40000 && d !== undefined) {
        tags.push(['a', `${e.kind}:${Q}:${d}`]);
      }
    }
    for (const k of new Set(chunk.map((e) => e.kind))) tags.push(['k', String(k)]);
    await author.publish(sign({ kind: KIND_DELETION, tags, content: '' }, qKey));
  }
  for (const w of wraps) {
    await author.publish(
      sign(
        {
          kind: KIND_DELETION,
          tags: [
            ['e', w.id],
            ['k', String(KIND_GIFT_WRAP)],
          ],
          content: '',
        },
        qKey
      )
    );
  }
  // Replaceable events: blank them too, since some relays ignore deletion of a replaceable.
  await author.publish(sign({ kind: KIND_SUBMITTERS, tags: [], content: '' }, qKey));

  // Whether each keyed connection ended up authenticated (on connect, or on auth-required).
  r.auth = authState();
  for (const c of [author, agent, stranger, anon]) c.close();
  return r;
}

function flatten(r: Results): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, v: unknown): void => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x);
    } else out[prefix] = Array.isArray(v) ? v.join('; ') : String(v);
  };
  walk('', r);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let outFile: string | undefined;
  let burst = true;
  const relays: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--out') outFile = args[++i];
    else if (a === '--no-burst') burst = false;
    else if (a !== '--') relays.push(a);
  }
  const results: Results[] = [];
  for (const url of relays.length > 0 ? relays : DEFAULT_RELAYS) {
    process.stderr.write(`probing ${url}\n`);
    try {
      results.push(await probe(url, burst));
    } catch (e) {
      results.push({ relay: url, error: String(e) });
    }
  }
  for (const r of results) {
    process.stdout.write(`\n## ${String(r.relay)}\n`);
    for (const [k, v] of Object.entries(flatten(r))) {
      if (k !== 'relay') process.stdout.write(`${k}: ${v}\n`);
    }
  }
  if (outFile) {
    writeFileSync(
      outFile,
      `${JSON.stringify({ run_at: new Date().toISOString(), results }, null, 2)}\n`
    );
  }
  process.exit(0);
}

await main();
