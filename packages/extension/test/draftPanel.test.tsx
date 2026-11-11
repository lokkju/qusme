// @vitest-environment happy-dom
/**
 * The home screen's draft list driven in happy-dom: one click inserts a row's draft without
 * arming it, a failure leaves nothing armed, expanding shows Edit, Dismiss and setting it for the
 * context menu, an Elsewhere row offers "Insert here anyway" only once expanded, the toolbar's
 * chip and menu (with the Agents count), and no npub until Settings asks for it.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { readArmed } from '../src/insertion/armed.ts';
import { definitionSource } from '../src/insertion/definitions.ts';
import type { InsertResponse } from '../src/insertion/service.ts';
import { type CachedDraft, readDraftCache, writeDraftCache } from '../src/sync/state.ts';
import { App } from '../src/ui/app.tsx';
import { DraftRow } from '../src/ui/draftRow.tsx';
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
const menuItem = (text: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.trim().startsWith(text)
  );
  if (found === undefined) throw new Error(`no menu item ${text}`);
  return found;
};
const menuButton = (): HTMLButtonElement => {
  const found = root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (found === null) throw new Error('no menu button');
  return found;
};
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
    buttonIn(rowOf('d2'), 'Show all').click();
    await until(() => [...rowOf('d2').querySelectorAll('button')].length > 1);
    buttonIn(rowOf('d2'), 'Insert here anyway').click();
    await until(() => root.querySelector('[role="status"]') !== null);
    expect(inserts).toEqual([[7, 'd2']]);
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      "This field didn't take the draft."
    );
    expect(await readArmed(a.store.session)).toBeUndefined();
    expect(root.textContent).not.toContain('Armed for right-click');
  });

  it('expands a row to its actions and sets it for the context menu on request', async () => {
    const { a, deps } = await setup({ state: 'failed', reason: 'exhausted' });
    mount(<InsertPanel store={a.store} deps={deps} />);
    await until(() => root.querySelector('[data-draft="d1"]') !== null);
    const text = () => rowOf('d1').querySelector('p.text-sm');
    expect(text()?.className).toContain('line-clamp-3');
    expect(buttons('Edit')).toHaveLength(0);
    const toggle = buttonIn(rowOf('d1'), 'Show all');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await until(() => text()?.className.includes('whitespace-pre-wrap') === true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    buttonIn(rowOf('d1'), 'Set for right-click').click();
    await until(() => root.textContent?.includes('Set for right-click:') === true);
    expect((await readArmed(a.store.session))?.d).toBe('d1');
    buttons('Clear')[0]?.click();
    await until(() => !root.textContent?.includes('Set for right-click:'));
    expect(await readArmed(a.store.session)).toBeUndefined();
  });

  it('offers Edit and Dismiss on an expanded row, only when drafts can be changed', async () => {
    const row = {
      d: 'r1',
      text: 'Draft text',
      meta: { who: 'You', when: 'just now' },
    };
    const dismissed: string[] = [];
    mount(
      <ul>
        <DraftRow
          row={row}
          elsewhere={false}
          insertable={true}
          armed={false}
          busy={false}
          onInsert={() => undefined}
          onArm={() => undefined}
          onEdit={async () => true}
          onDismiss={() => dismissed.push('r1')}
        />
        <DraftRow
          row={{ ...row, d: 'r2' }}
          elsewhere={false}
          insertable={true}
          armed={false}
          busy={false}
          onInsert={() => undefined}
          onArm={() => undefined}
        />
      </ul>
    );
    for (const d of ['r1', 'r2']) buttonIn(rowOf(d), 'Show all').click();
    await until(() => rowOf('r2').textContent?.includes('Set for right-click') === true);
    buttonIn(rowOf('r1'), 'Dismiss').click();
    expect(dismissed).toEqual(['r1']);
    buttonIn(rowOf('r1'), 'Edit').click();
    await until(() => rowOf('r1').querySelector('textarea') !== null);
    expect(() => buttonIn(rowOf('r2'), 'Edit')).toThrow();
    expect(() => buttonIn(rowOf('r2'), 'Dismiss')).toThrow();
  });

  it('offers a draft for another site only once expanded, as "Insert here anyway"', async () => {
    const { a, deps, inserts } = await setup({ state: 'not_found' });
    mount(<InsertPanel store={a.store} deps={deps} />);
    await until(() => root.querySelector('[data-draft="d2"]') !== null);
    expect(rowOf('d2').querySelectorAll('button')).toHaveLength(1);
    // The row's text is the mouse's expand target.
    rowOf('d2').querySelector<HTMLElement>('p.text-sm')?.click();
    await until(() => [...rowOf('d2').querySelectorAll('button')].length > 1);
    expect(() => buttonIn(rowOf('d2'), 'Insert')).toThrow();
    const anyway = buttonIn(rowOf('d2'), 'Insert here anyway');
    expect(anyway.className).not.toContain('bg-accent');
    anyway.click();
    await until(() => inserts.length === 1);
    expect(inserts).toEqual([[7, 'd2']]);
  });

  it('shows the tab in the chip and counts waiting accounts beside Agents in the menu', async () => {
    const { a, deps } = await setup({ state: 'not_found' });
    const cache = await readDraftCache(a.store.session);
    await writeDraftCache(a.store.session, {
      ...(cache as NonNullable<typeof cache>),
      destinations: [
        {
          id: 'p1',
          site: 'x',
          account: 'other',
          label: 'X / other',
          status: 'pending',
          override: null,
        },
      ],
    });
    mount(<App deps={a.deps} insertion={deps} />);
    await until(() => root.textContent?.includes('x.com · lokkju') === true);
    await until(() => root.textContent?.includes('wants to draft for') === true);
    expect(menuButton().getAttribute('aria-label')).toBe('Menu, 1 waiting');
    expect(root.querySelector('[role="menu"]')).toBeNull();
    menuButton().click();
    await until(() => root.querySelector('[role="menu"]') !== null);
    expect(menuItem('Agents').textContent).toBe('Agents1 waiting');
    expect(
      [...root.querySelectorAll('[role="menuitem"]')].map((b) => b.firstChild?.textContent)
    ).toEqual(['Agents', 'Accounts', 'Archive', 'Pair a device', 'Settings', 'Lock']);
    menuItem('Agents').click();
    await until(() => buttons('Approve an agent').length === 1);
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps the npub off the home screen until Settings shows it', async () => {
    const { a, deps } = await setup({ state: 'not_found' });
    mount(<App deps={a.deps} insertion={deps} />);
    await until(() => root.textContent?.includes('For this page') === true);
    expect(root.textContent).not.toContain('npub1');
    expect(root.textContent).not.toContain(a.npub);
    expect(buttons('Approve an agent')).toHaveLength(0);
    menuButton().click();
    await until(() => root.querySelector('[role="menu"]') !== null);
    menuItem('Settings').click();
    await until(() => buttons('Show Queue ID').length === 1);
    buttons('Show Queue ID')[0]?.click();
    await until(() => root.textContent?.includes(a.npub) === true);
  });
});
