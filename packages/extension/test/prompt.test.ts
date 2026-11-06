// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptShown, showPrompt } from '../src/insertion/page/prompt.ts';
import { createPageApi } from '../src/insertion/page/run.ts';

/** Every element directly under <html> other than <head> and <body>. */
const hosts = () =>
  [...document.documentElement.children].filter(
    (el) => el !== document.head && el !== document.body
  );

beforeEach(() => {
  document.body.replaceChildren();
  for (const el of hosts()) el.remove();
});
afterEach(() => vi.restoreAllMocks());

describe('in-page notice', () => {
  it('mounts in a closed shadow root on a neutral host', () => {
    const p = showPrompt(document, 'qus.me: click into the field where the draft should go.');
    const host = p.host;
    expect(host.parentElement).toBe(document.documentElement);
    expect(hosts()).toEqual([host]);
    // The page's scripts get nothing back from the host.
    expect(host.shadowRoot).toBeNull();
    expect(host.localName).toBe('div');
    expect(host.getAttributeNames()).toEqual(['style']);
    expect(host.id).toBe('');
    expect(host.className).toBe('');
    expect(host.outerHTML).not.toMatch(/qus/i);
    expect(document.querySelector('[data-qusme-prompt]')).toBeNull();
    // The host's box is pinned against page rules; the message is inside the closed root only.
    expect(host.getAttribute('style')).toContain('all:initial !important');
    expect(host.getAttribute('style')).toContain('position:fixed !important');
    expect(p.root.mode).toBe('closed');
    expect(p.root.querySelector('style')?.textContent).toContain(':host');
    expect(p.root.querySelector('[role="status"]')?.textContent).toContain('click into the field');
    expect(document.documentElement.textContent).not.toContain('click into the field');
    expect(promptShown(document)).toBe(true);
  });

  it('updates its text in place', () => {
    const p = showPrompt(document, 'first');
    p.update('second');
    expect(p.root.querySelector('span')?.textContent).toBe('second');
    expect(hosts()).toEqual([p.host]);
  });

  it('replaces the notice it holds, without querying the page', () => {
    const first = showPrompt(document, 'first');
    const second = showPrompt(document, 'second');
    expect(first.host.isConnected).toBe(false);
    expect(hosts()).toEqual([second.host]);
    // Removing the old handle again leaves the current notice alone.
    first.remove();
    expect(second.host.isConnected).toBe(true);
    expect(promptShown(document)).toBe(true);
  });

  it('leaves a page element shaped like the host alone', () => {
    const lookalike = document.createElement('div');
    lookalike.setAttribute('style', 'all:initial');
    document.documentElement.append(lookalike);
    const p = showPrompt(document, 'first');
    showPrompt(document, 'second');
    expect(lookalike.isConnected).toBe(true);
    expect(p.host.isConnected).toBe(false);
  });

  it('removes the host when closed and calls back', () => {
    const onClose = vi.fn();
    const p = showPrompt(document, 'qus.me: press Ctrl+V to paste.', onClose);
    p.root.querySelector('button')?.click();
    expect(p.host.isConnected).toBe(false);
    expect(hosts()).toEqual([]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(promptShown(document)).toBe(false);
  });

  it('removes the host on remove()', () => {
    const p = showPrompt(document, 'qus.me: something went wrong.');
    p.remove();
    expect(p.host.isConnected).toBe(false);
    expect(hosts()).toEqual([]);
    expect(promptShown(document)).toBe(false);
  });

  it("removes a failure notice once the page script's timeout runs", async () => {
    const field = document.createElement('textarea');
    field.setAttribute('aria-label', 'Post text');
    document.body.append(field);
    const timers: { fn: () => void; ms: number }[] = [];
    const view = document.defaultView as Window;
    const realSetTimeout = view.setTimeout.bind(view);
    vi.spyOn(view, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      timers.push({ fn, ms: ms ?? 0 });
      return realSetTimeout(() => undefined, 0);
    }) as typeof view.setTimeout);

    const outcome = await createPageApi({
      document,
      notify: () => undefined,
      writeClipboard: async () => false,
    }).insert({
      token: 'tok',
      value: 'Shipping the insertion today.',
      method: 'extension_context_menu',
      clipboardFallback: false,
      field: {
        locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
        inject: ['clipboard'],
      },
    });
    expect(outcome).toMatchObject({ state: 'failed', reason: 'clipboard_denied' });
    expect(promptShown(document)).toBe(true);
    const [host] = hosts();
    expect(host?.getAttributeNames()).toEqual(['style']);
    expect(host?.shadowRoot).toBeNull();

    const removals = timers.filter((t) => t.ms === 8000);
    expect(removals.length).toBeGreaterThan(0);
    for (const t of removals) t.fn();
    expect(promptShown(document)).toBe(false);
    expect(hosts()).toEqual([]);
  });
});
