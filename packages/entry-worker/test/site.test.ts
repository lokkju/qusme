/// <reference types="node" />
// The landing site (site/ at the repo root) and the Worker's routing by Host.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import worker, { type Env, SITE_HEADERS } from '../src/index.ts';

const SITE_DIR = resolve(import.meta.dirname, '../../../site');
const read = (name: string) => readFileSync(join(SITE_DIR, name), 'utf8');
const PAGES = readdirSync(SITE_DIR).filter((f) => f.endsWith('.html'));

/**
 * The assets binding as wrangler.jsonc configures it (auto-trailing-slash, 404-page), over the
 * real site/ directory, recording what it was asked for.
 */
function assets() {
  const calls: string[] = [];
  const fetcher = {
    calls,
    async fetch(input: Request | string | URL) {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.pathname);
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const candidates = [path, `${path}.html`];
      for (const name of candidates) {
        if (name && !name.includes('..') && existsSync(join(SITE_DIR, name))) {
          return new Response(readFileSync(join(SITE_DIR, name)), {
            headers: { 'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/plain' },
          });
        }
      }
      return new Response(read('404.html'), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  };
  return fetcher;
}

function setup() {
  const binding = assets();
  const env = {
    DB: {} as D1Database,
    QUSME_AGENT_KEY_SECRET: btoa('w'.repeat(32)),
    QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
    QUSME_SITE_ORIGIN: 'https://qus.me',
    ASSETS: binding as unknown as Fetcher,
  } satisfies Env;
  const get = (url: string) => worker.fetch(new Request(url), env, {} as ExecutionContext);
  return { binding, get };
}

describe('routing by Host', () => {
  it('serves the landing page on qus.me with the site headers', async () => {
    const { get } = setup();
    const res = await get('https://qus.me/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Drafts wait in line. You post them.');
    for (const [name, value] of Object.entries(SITE_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it('sends a CSP that allows nothing inline and nothing from other origins', async () => {
    const { get } = setup();
    const csp = (await get('https://qus.me/privacy')).headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:/);
  });

  it('serves the privacy policy and a 404 page on qus.me', async () => {
    const { get } = setup();
    const privacy = await get('https://qus.me/privacy');
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain('<h1>Privacy policy</h1>');
    const missing = await get('https://qus.me/no-such-page');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Page not found');
    expect(missing.headers.get('Content-Security-Policy')).toBe(
      SITE_HEADERS['Content-Security-Policy']
    );
  });

  it('keeps the API off qus.me', async () => {
    const { get } = setup();
    const res = await get('https://qus.me/healthz');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
  });

  it('serves the API on app.qus.me and never the site', async () => {
    const { binding, get } = setup();
    const health = await get('https://app.qus.me/healthz');
    expect(health.status).toBe(200);
    expect(health.headers.get('Content-Security-Policy')).toBeNull();
    const root = await get('https://app.qus.me/');
    expect(await root.text()).not.toContain('Drafts wait in line');
    const privacy = await get('https://app.qus.me/privacy');
    expect(await privacy.text()).not.toContain('Privacy policy');
    expect(binding.calls).toEqual([]);
  });

  it('redirects www.qus.me to qus.me, keeping the path and query', async () => {
    const { binding, get } = setup();
    const res = await get('https://www.qus.me/privacy?from=x');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://qus.me/privacy?from=x');
    expect(binding.calls).toEqual([]);
  });

  it('answers any other host with a 404 and touches neither the site nor the API', async () => {
    const { binding, get } = setup();
    for (const url of [
      'https://example.com/',
      'https://example.com/healthz',
      'https://qus.me.example.com/',
      'https://app.qus.me:8443/healthz',
    ]) {
      const res = await get(url);
      expect(res.status, url).toBe(404);
      expect(await res.text()).toBe('Not found\n');
    }
    expect(binding.calls).toEqual([]);
  });

  it('serves no site when QUSME_SITE_ORIGIN is unset', async () => {
    const binding = assets();
    const env = {
      DB: {} as D1Database,
      QUSME_AGENT_KEY_SECRET: btoa('w'.repeat(32)),
      QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
      ASSETS: binding as unknown as Fetcher,
    } satisfies Env;
    const res = await worker.fetch(new Request('https://qus.me/'), env, {} as ExecutionContext);
    expect(res.status).toBe(404);
    expect(binding.calls).toEqual([]);
  });
});

/** Every href and src in a page. */
const refs = (html: string) =>
  [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1] ?? '');
const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

// Known placeholders, kept until the store listings exist; listed here so they can't multiply.
const PLACEHOLDERS = new Set(['[Chrome Web Store link]', '[Firefox Add-ons link]']);
const EXTERNAL = new Set(['https://github.com/lokkju/qusme', 'mailto:info@qus.me']);

/** The file a same-origin path is served from (html_handling auto-trailing-slash). */
function fileFor(path: string): string | undefined {
  const clean = path === '/' ? 'index.html' : path.replace(/^\//, '');
  for (const name of [clean, `${clean}.html`]) {
    if (existsSync(join(SITE_DIR, name))) return name;
  }
  return undefined;
}

describe('site pages', () => {
  it('has the pages the Worker serves', () => {
    expect(PAGES.sort()).toEqual(['404.html', 'index.html', 'privacy.html']);
  });

  it.each(PAGES)('%s: every link and asset resolves', (page) => {
    const html = read(page);
    for (const ref of refs(html)) {
      if (PLACEHOLDERS.has(ref) || EXTERNAL.has(ref)) continue;
      if (ref.startsWith('#')) {
        expect(ids(html).has(ref.slice(1)), `${page}: ${ref}`).toBe(true);
        continue;
      }
      expect(ref, `${page}: ${ref} must be a same-origin absolute path`).toMatch(/^\/(?!\/)/u);
      const [path = '', fragment] = ref.split('#');
      const target = fileFor(path === '' ? '/' : path);
      expect(target, `${page}: ${ref}`).toBeDefined();
      if (fragment && target) expect(ids(read(target)).has(fragment), `${page}: ${ref}`).toBe(true);
    }
  });

  it.each(PAGES)('%s: nothing the CSP would block', (page) => {
    const html = read(page);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toMatch(/javascript:/i);
    // Every <script> is an external same-origin file.
    for (const tag of html.match(/<script[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc="\/[^"]+"/);
    expect(html).not.toMatch(/https?:\/\/(?!app\.qus\.me|github\.com\/lokkju\/qusme)/);
  });

  it.each(PAGES)('%s: a language, a title, a viewport and one h1', (page) => {
    const html = read(page);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain('name="viewport"');
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('the stylesheet loads fonts only from the site itself', () => {
    const css = read('style.css');
    const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^\/fonts\/[a-z-]+\.woff2$/);
      expect(existsSync(join(SITE_DIR, url)), url).toBe(true);
    }
  });

  it('the privacy policy names the contact address and its date, and no draft marker', () => {
    const html = read('privacy.html');
    expect(html).toContain('mailto:info@qus.me');
    expect(html).toContain('datetime="2026-11-07"');
    expect(html).not.toMatch(/\[draft|to be reviewed/i);
  });
});
