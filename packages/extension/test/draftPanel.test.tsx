// @vitest-environment happy-dom
/**
 * The home screen's draft list driven in happy-dom: one click inserts a row's draft without
 * arming it, a failure leaves nothing armed, expanding shows the whole text and offers arming for
 * the context menu.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { readArmed } from '../src/insertion/armed.ts';
import { definitionSource } from '../src/insertion/definitions.ts';
import type { InsertResponse } from '../src/insertion/service.ts';
import { type CachedDraft, writeDraftCache } from '../src/sync/state.ts';
import { type InsertionUiDeps, InsertPanel } from '../src/ui/insert.tsx';
import { createdDevice, network, until } from './helpers.ts';

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  document.body.innerHTML = '';
});

function mount(node: preact.ComponentChild) {
  root = document.createElement('div');
  document.body.append(root);
  render(node, root);
}

const buttons = (text: string): HTMLButtonElement[] =>
  [...root.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text);
const rowOf = (d: string): HTMLElement => {
  const row = root.querySelector<HTMLElement>(`[data-draft="${d}"]`);
  if (row === null) throw new Error(`no row ${d}`);
  return row;
};
const buttonIn = (el: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
};

const draft = (over: Partial<CachedDraft>): CachedDraft => ({
  d: 'd1',
  updatedAt: 2,
  site: 'x',
  account: 'lokkju',
  field: 'text',
  status: 'active',
  content: 'First line for X\nsecond line, shown on expand',
  ...over,
});

async function setup(response: InsertResponse) {
  const a = await createdDevice(network());
  await writeDraftCache(a.store.session, {
    queuePubkey: a.pubkey,
    syncedAt: 1,
    drafts: [draft({}), draft({ d: 'd2', site: 'blog', content: 'For the blog', updatedAt: 1 })],
    destinations: [],
  });
  const inserts: [number, string][] = [];
  const deps: InsertionUiDeps = {
    definitions: definitionSource(),
    activeTab: async () => ({ id: 7, url: 'https://x.com/home' }),
    detectAccounts: async () => ['lokkju'],
    insert: async (tabId, d) => {
      inserts.push([tabId, d]);
      return response;
    },
    retryRecord: async () => ({ remaining: 0, messages: [] }),
    writeClipboard: async () => true,
  };
  return { a, deps, inserts };
}

describe('draft list in the popup', { timeout: 30_000 }, () => {
  it('inserts a row in one click with its draft id, arming nothing', async () => {
    const { a, deps, inserts } = await setup({
      state: 'inserted',
      strategy: 'paste',
      recorded: true,
    });
    mount(<InsertPanel store={a.store} deps={deps} />);
    await until(() => root.querySelector('[data-draft="d1"]') !== null);
    expect(root.textContent).toContain('For this page');
    expect(root.textContent).toContain('Elsewhere');
    expect(root.textContent).toContain('Signed in to x as lokkju.');
    buttonIn(rowOf('d1'), 'Insert').click();
    await until(() => root.querySelector('[role="status"]') !== null);
    expect(inserts).toEqual([[7, 'd1']]);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Inserted');
    expect(await readArmed(a.store.session)).toBeUndefined();
  });

  it('leaves nothing armed when the insertion fails', async () => {
    const { a, deps, inserts } = await setup({ state: 'failed', reason: 'exhausted' });
    mount(<InsertPanel store={a.store} deps={deps} />);
    await until(() => root.querySelector('[data-draft="d2"]') !== null);
    buttonIn(rowOf('d2'), 'Insert').click();
    await until(() => root.querySelector('[role="status"]') !== null);
    expect(inserts).toEqual([[7, 'd2']]);
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      "This field didn't take the draft."
    );
    expect(await readArmed(a.store.session)).toBeUndefined();
    expect(root.textContent).not.toContain('Armed for right-click');
  });

  it('expands a row to its full text and arms it for the context menu on request', async () => {
    const { a, deps } = await setup({ state: 'failed', reason: 'exhausted' });
    mount(<InsertPanel store={a.store} deps={deps} />);
    await until(() => root.querySelector('[data-draft="d1"]') !== null);
    expect(rowOf('d1').textContent).not.toContain('second line');
    buttonIn(rowOf('d1'), 'Show all').click();
    await until(() => rowOf('d1').textContent?.includes('second line') === true);
    buttonIn(rowOf('d1'), 'Arm for right-click').click();
    await until(() => root.textContent?.includes('Armed for right-click:') === true);
    expect((await readArmed(a.store.session))?.d).toBe('d1');
    buttons('Disarm')[0]?.click();
    await until(() => !root.textContent?.includes('Armed for right-click:'));
    expect(await readArmed(a.store.session)).toBeUndefined();
  });
});
