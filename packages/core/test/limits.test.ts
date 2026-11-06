import { readFileSync } from 'node:fs';
import type { QusmeDb } from '@qusme/store-sql';
import { describe, expect, it } from 'vitest';
import {
  BODY_LIMITS,
  bodyLimitFor,
  createAgentKeyRing,
  createApp,
  createBindingRateLimiter,
  createMemoryRateLimiter,
  createServiceLimits,
  DEFAULT_LIMITS,
  limitFromEnv,
  MAX_URL_BYTES,
  RATE_CLASSES,
  TIERS,
  utcDay,
} from '../src/index.ts';

describe('the memory rate limiter', () => {
  it('allows the limit per window and key, then answers the seconds left in the window', async () => {
    let now = 1_000;
    const limiter = createMemoryRateLimiter({ now: () => now });
    const { limit, period } = RATE_CLASSES.ip_pair;
    for (let i = 0; i < limit; i++) {
      expect(await limiter.limit('ip_pair', 'a')).toEqual({ ok: true });
    }
    now += 20;
    expect(await limiter.limit('ip_pair', 'a')).toEqual({ ok: false, retryAfter: period - 20 });
    expect(await limiter.limit('ip_pair', 'b')).toEqual({ ok: true });
    expect(await limiter.limit('ip_token', 'a')).toEqual({ ok: true });
    now += period - 20;
    expect(await limiter.limit('ip_pair', 'a')).toEqual({ ok: true });
  });

  it('refuses an unknown class', async () => {
    const limiter = createMemoryRateLimiter();
    await expect(limiter.limit('nope' as 'ip_pair', 'a')).rejects.toThrow('unknown rate class');
  });
});

describe('the Workers binding rate limiter', () => {
  const bindings = (success: (cls: string) => boolean | Error) =>
    Object.fromEntries(
      Object.values(RATE_CLASSES).map((c) => [
        c.binding,
        {
          async limit({ key }: { key: string }) {
            const r = success(`${c.binding}:${key}`);
            if (r instanceof Error) throw r;
            return { success: r };
          },
        },
      ])
    );

  it('needs a binding for every class', () => {
    const env = bindings(() => true);
    delete env.RL_IP_TOKEN;
    expect(() => createBindingRateLimiter(env)).toThrow('RL_IP_TOKEN is missing');
  });

  it('answers the class period as Retry-After when the binding refuses', async () => {
    const seen: string[] = [];
    const limiter = createBindingRateLimiter(
      bindings((k) => {
        seen.push(k);
        return !k.startsWith('RL_IP_POLL');
      })
    );
    expect(await limiter.limit('ip_token', '198.51.100.1')).toEqual({ ok: true });
    expect(await limiter.limit('ip_poll', '198.51.100.1')).toEqual({
      ok: false,
      retryAfter: RATE_CLASSES.ip_poll.period,
    });
    expect(seen).toEqual(['RL_IP_TOKEN:198.51.100.1', 'RL_IP_POLL:198.51.100.1']);
  });

  it('lets a request through when the binding itself fails', async () => {
    const limiter = createBindingRateLimiter(bindings(() => new Error('down')));
    expect(await limiter.limit('mcp_agent_free', 'x')).toEqual({ ok: true });
  });
});

describe('tiers and config', () => {
  it('maps every tier’s rates to defined classes', () => {
    for (const tier of Object.values(TIERS)) {
      for (const cls of [tier.mcpAgentRate, tier.mcpQueueRate, tier.deviceRate]) {
        expect(RATE_CLASSES).toHaveProperty(cls);
      }
    }
  });

  it('resolves free by default, a named tier, and free for an unknown name', async () => {
    expect(await createServiceLimits().tierFor('q')).toEqual(TIERS.free);
    const pro = { ...TIERS.free, maxAgents: 50 };
    const limits = createServiceLimits({
      tiers: { free: TIERS.free, pro },
      tierLookup: async (q) => (q === 'paid' ? 'pro' : q === 'odd' ? 'toString' : 'gold'),
    });
    expect(await limits.tierFor('paid')).toEqual(pro);
    expect(await limits.tierFor('other')).toEqual(TIERS.free);
    expect(await limits.tierFor('odd')).toEqual(TIERS.free);
  });

  it('merges config over the defaults', () => {
    expect(createServiceLimits({ config: { draftsPerDayCeiling: 7 } }).config).toEqual({
      ...DEFAULT_LIMITS,
      draftsPerDayCeiling: 7,
    });
  });

  it('reads a limit from the environment, refusing anything but a whole number', () => {
    expect(limitFromEnv(undefined, 'X', 5)).toBe(5);
    expect(limitFromEnv('', 'X', 5)).toBe(5);
    expect(limitFromEnv(' 120 ', 'X', 5)).toBe(120);
    expect(limitFromEnv('0', 'X', 5)).toBe(0);
    for (const bad of ['-1', '1.5', 'ten', '1e3']) {
      expect(() => limitFromEnv(bad, 'X', 5)).toThrow('X must be a whole number');
    }
  });

  it('computes the UTC day and the seconds to its end', () => {
    const noon = Date.UTC(2026, 10, 6, 12) / 1000;
    expect(utcDay(noon)).toEqual({
      start: noon - 43_200,
      end: noon + 43_200,
      retryAfter: 43_200,
    });
  });
});

describe('request size caps', () => {
  const app = createApp({
    version: 'v',
    // Every request here is refused before a route touches the database.
    db: {} as QusmeDb,
    agentKeys: createAgentKeyRing({ secret: btoa('s'.repeat(32)) }),
    publicOrigin: 'https://app.qus.me',
  });

  it('picks a cap per route family', () => {
    expect(bodyLimitFor('/mcp')).toBe(BODY_LIMITS.mcp);
    expect(bodyLimitFor('/token')).toBe(BODY_LIMITS.oauthForm);
    expect(bodyLimitFor('/revoke')).toBe(BODY_LIMITS.oauthForm);
    expect(bodyLimitFor('/pair')).toBe(BODY_LIMITS.default);
    expect(bodyLimitFor('/device/authorizations/X/approve')).toBe(BODY_LIMITS.default);
  });

  it('refuses an oversized body with 413 before the route sees it', async () => {
    for (const [path, size] of [
      ['/token', BODY_LIMITS.oauthForm + 1],
      ['/revoke', BODY_LIMITS.oauthForm + 1],
      ['/pair', BODY_LIMITS.default + 1],
      ['/device/authorizations/ABCD1234/approve', BODY_LIMITS.default + 1],
      ['/rotate', BODY_LIMITS.default + 1],
      ['/mcp', BODY_LIMITS.mcp + 1],
    ] as const) {
      const res = await app.request(path, { method: 'POST', body: 'x'.repeat(size) });
      expect(res.status, path).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
    }
  });

  it('refuses an oversized streamed body without a Content-Length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 16) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await app.request(
      new Request('https://app.qus.me/token', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit)
    );
    expect(res.status).toBe(413);
  });

  it('lets a body within the cap through to the route', async () => {
    // Reaches the NIP-98 check, which refuses the unsigned request.
    const res = await app.request('/pair', {
      method: 'POST',
      body: 'x'.repeat(BODY_LIMITS.default),
    });
    expect(res.status).toBe(401);
  });

  it('refuses an overlong URL with 414', async () => {
    const res = await app.request(`/authorize?state=${'s'.repeat(MAX_URL_BYTES)}`);
    expect(res.status).toBe(414);
  });
});

describe('the Workers configuration', () => {
  /** wrangler.jsonc without its comments. */
  function wranglerConfig() {
    const text = readFileSync(
      new URL('../../entry-worker/wrangler.jsonc', import.meta.url),
      'utf8'
    );
    const stripped = text.replace(
      /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
      (_m: string, str: string | undefined) => str ?? ''
    );
    return JSON.parse(stripped) as {
      vars: Record<string, string>;
      ratelimits: {
        name: string;
        namespace_id: string;
        simple: { limit: number; period: number };
      }[];
    };
  }

  it('declares one rate limiting binding per rate class, with the same limit and period', () => {
    const { ratelimits } = wranglerConfig();
    const declared = Object.fromEntries(ratelimits.map((r) => [r.name, r.simple]));
    const expected = Object.fromEntries(
      Object.values(RATE_CLASSES).map((c) => [c.binding, { limit: c.limit, period: c.period }])
    );
    expect(declared).toEqual(expected);
    const ids = ratelimits.map((r) => r.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[1-9]\d*$/);
  });

  it('configures the daily draft ceiling as a whole number', () => {
    expect(wranglerConfig().vars.QUSME_DAILY_DRAFT_CEILING).toMatch(/^\d+$/);
  });
});
