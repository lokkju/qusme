// @vitest-environment happy-dom
/**
 * Account detection for destinations (spec 10.1, 11.5 step 2) with the insertion script's own
 * `detectAccount` standing in for `scripting.executeScript`, against a page in happy-dom: the
 * Destinations screen's "Detect from this tab" and the insert panel's add-destination shortcut.
 */
import type { SiteAccount } from '@qusme/nostr';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { definitionSource } from '../src/insertion/definitions.ts';
import { type DetectDeps, detectForSite, registrySitesOn } from '../src/insertion/detect.ts';
import { detectAccount } from '../src/insertion/page/run.ts';
import { writeDraftCache } from '../src/sync/state.ts';
import { DestinationsScreen } from '../src/ui/destinations.tsx';
import { type InsertionUiDeps, InsertPanel } from '../src/ui/insert.tsx';
import { destinationsQueue, until } from './helpers.ts';

const source = definitionSource();
const TAB = 7;

/** The page script's detection, as `scripting.executeScript` would run it in the tab. */
function fakePage(url: string | undefined): DetectDeps & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    definitions: source,
    activeTab: async () => (url === undefined ? undefined : { id: TAB, url }),
    detectAccounts: async (tabId: number, locators: readonly SiteAccount[]) => {
      calls.push(tabId);
      return locators.map((l) => detectAccount(document, l).account);
    },
  };
}

function signedInAs(handle: string) {
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Account menu');
  button.textContent = `Someone @${handle}`;
  document.body.append(button);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('detect from this tab', () => {
  it("finds the signed-in account with the site's locator", async () => {
    signedInAs('lokkju');
    const page = fakePage('https://x.com/home');
    expect(await detectForSite(page, 'x', null)).toEqual({ state: 'detected', account: 'lokkju' });
    expect(page.calls).toEqual([TAB]);
  });

  it('says so when the tab is elsewhere, unreadable, or signed out', async () => {
    signedInAs('lokkju');
    const elsewhere = fakePage('https://example.com/');
    expect(await detectForSite(elsewhere, 'x', null)).toEqual({ state: 'other_site' });
    expect(elsewhere.calls).toEqual([]);
    expect(await detectForSite(fakePage(undefined), 'x', null)).toEqual({ state: 'no_tab' });
    // An override's match patterns decide where the destination's pages are.
    expect(
      await detectForSite(fakePage('https://x.com/home'), 'x', { match: ['https://x.com/alt/*'] })
    ).toEqual({ state: 'other_site' });
    document.body.innerHTML = '';
    expect(await detectForSite(fakePage('https://x.com/home'), 'x', null)).toEqual({
      state: 'undetected',
    });
  });

  it('knows which registry sites a page is on', () => {
    expect(registrySitesOn(source, 'https://twitter.com/home').map((s) => s.id)).toEqual(['x']);
    expect(registrySitesOn(source, 'https://example.com/')).toEqual([]);
  });
});

describe('insert panel shortcut', { timeout: 30_000 }, () => {
  it('offers the detected account, adds it on click, and stops offering it', async () => {
    signedInAs('lokkju');
    const q = await destinationsQueue();
    await writeDraftCache(q.session, {
      queuePubkey: q.pubkey,
      syncedAt: 1,
      drafts: [],
      destinations: (await q.onRelays())[0]?.content.destinations ?? [],
    });
    const page = fakePage('https://x.com/home');
    const deps: InsertionUiDeps = {
      ...page,
      insert: async () => ({ state: 'not_armed' }),
      retryRecord: async () => ({ remaining: 0, messages: [] }),
      writeClipboard: async () => true,
    };
    const root = document.createElement('div');
    document.body.append(root);
    render(<InsertPanel store={q.store} deps={deps} setup={q.deps} />, root);

    const offer = () =>
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent === 'Add lokkju on X as a destination'
      );
    await until(() => offer() !== undefined);
    offer()?.click();
    await until(() => root.textContent?.includes('Added X / lokkju.') === true);
    const list = (await q.onRelays())[0]?.content.destinations ?? [];
    expect(list.map((d) => [d.site, d.account, d.label, d.status])).toEqual([
      ['x', 'alt', 'X / alt', 'confirmed'],
      ['x', 'lokkju', 'X / lokkju', 'confirmed'],
    ]);
    expect(list[0]?.extra).toEqual({ color: 'teal' });
    await until(() => offer() === undefined);
    expect(q.syncRequests()).toBe(1);
    render(null, root);
    q.close();
  });

  it('offers nothing for an account that already has a destination', async () => {
    signedInAs('alt');
    const q = await destinationsQueue();
    await writeDraftCache(q.session, {
      queuePubkey: q.pubkey,
      syncedAt: 1,
      drafts: [],
      destinations: (await q.onRelays())[0]?.content.destinations ?? [],
    });
    const page = fakePage('https://x.com/home');
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <InsertPanel
        store={q.store}
        deps={{
          ...page,
          insert: async () => ({ state: 'not_armed' }),
          retryRecord: async () => ({ remaining: 0, messages: [] }),
          writeClipboard: async () => true,
        }}
        setup={q.deps}
      />,
      root
    );
    await until(() => root.textContent?.includes('Signed in to x as alt.') === true);
    expect(root.textContent).not.toContain('as a destination');
    render(null, root);
    q.close();
  });
});

describe('destinations screen', { timeout: 30_000 }, () => {
  const button = (root: HTMLElement, text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === text);

  it('adds a destination with the account detected from the tab', async () => {
    signedInAs('lokkju');
    const q = await destinationsQueue();
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <DestinationsScreen
        deps={q.deps}
        definitions={source}
        detect={fakePage('https://x.com/home')}
        onBack={() => {}}
      />,
      root
    );
    await until(() => root.textContent?.includes('X / alt') === true);
    button(root, 'Add a destination')?.click();
    await until(() => button(root, 'Detect from this tab') !== undefined);
    button(root, 'Detect from this tab')?.click();
    const account = () => root.querySelector<HTMLInputElement>('#destination-account');
    await until(() => account()?.value === 'lokkju');
    expect(root.querySelector<HTMLInputElement>('#destination-label')?.placeholder).toBe(
      'X / lokkju'
    );
    button(root, 'Add')?.click();
    await until(() => root.textContent?.includes('Added X / lokkju.') === true);
    const list = (await q.onRelays())[0]?.content.destinations ?? [];
    expect(list.map((d) => d.label)).toEqual(['X / alt', 'X / lokkju']);
    expect(root.textContent).toContain('X / lokkju');
    render(null, root);
    q.close();
  });

  it("shows the parser's error for a bad override and saves nothing", async () => {
    const q = await destinationsQueue();
    const root = document.createElement('div');
    document.body.append(root);
    render(<DestinationsScreen deps={q.deps} definitions={source} onBack={() => {}} />, root);
    await until(() => button(root, 'Edit') !== undefined);
    expect(button(root, 'Detect from this tab')).toBeUndefined();
    button(root, 'Edit')?.click();
    const area = () => root.querySelector<HTMLTextAreaElement>('#edit-destination-override');
    await until(() => area() !== null);
    const textarea = area() as HTMLTextAreaElement;
    textarea.value = '{"match": ["x.com"]}';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    // Let Preact render the typed text before the click reads it, as a person's pause would.
    await new Promise((r) => setTimeout(r, 20));
    button(root, 'Save')?.click();
    await until(() => root.querySelector('[role="alert"]') !== null);
    expect(root.querySelector('[role="alert"]')?.textContent).toMatch(/not a match pattern/);
    const list = (await q.onRelays())[0]?.content.destinations ?? [];
    expect(list[0]?.override).toBeNull();
    render(null, root);
    q.close();
  });
});
