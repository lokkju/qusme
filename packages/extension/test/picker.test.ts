// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPicker, type PickerHandle } from '../src/insertion/page/picker.ts';
import { createPageApi, type PageEnv } from '../src/insertion/page/run.ts';
import type { PickerView } from '../src/insertion/protocol.ts';

const view = (over: Partial<PickerView> = {}): PickerView => ({
  token: 'tok-1',
  state: 'ready',
  here: [
    { d: 'd1', text: 'Shipped: drafts land in your composer.', meta: 'X · text · from Claude' },
    { d: 'd2', text: 'Thread (1/4): what shipping a queue taught us', meta: 'X · text' },
    { d: 'd3', text: 'Lunch is at noon', meta: 'X · text' },
  ],
  others: [{ d: 'd9', text: 'A post for Mastodon', meta: 'Mastodon as @me · text' }],
  context: 'X as @lokkju',
  ...over,
});

/** Marks a synthetic event as a user's, as the browser would for real input. */
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

const key = (k: string) =>
  trusted(
    new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true })
  );

interface Harness {
  env: PageEnv;
  picks: [string, string][];
  prompts: string[];
  popups: number;
  handle(): PickerHandle;
}

function harness(options: { pickAnswer?: unknown; popupOpens?: boolean } = {}): Harness {
  let last: PickerHandle | undefined;
  const h: Harness = {
    picks: [],
    prompts: [],
    popups: 0,
    handle: () => {
      if (last === undefined) throw new Error('no picker');
      return last;
    },
    env: {
      document,
      notify: () => undefined,
      writeClipboard: async () => true,
      prompt: (message) => {
        h.prompts.push(message);
        return { update: () => undefined, remove: () => undefined };
      },
      pick: async (token, d) => {
        h.picks.push([token, d]);
        return options.pickAnswer ?? { state: 'inserted', strategy: 'insertText', recorded: true };
      },
      openPopup: async () => {
        h.popups++;
        return options.popupOpens ?? false;
      },
      mountPicker: (...args) => {
        last = mountPicker(...args);
        return last;
      },
    },
  };
  return h;
}

const textarea = () => {
  const ta = document.createElement('textarea');
  ta.setAttribute('aria-label', 'Post text');
  document.body.append(ta);
  return ta;
};

const filterOf = (h: PickerHandle) => h.root.querySelector('input') as HTMLInputElement;
const options = (h: PickerHandle) =>
  [...h.root.querySelectorAll('[role="option"]')].map((o) => ({
    text: o.querySelector('.t')?.textContent,
    selected: o.getAttribute('aria-selected') === 'true',
  }));
const typeFilter = (h: PickerHandle, text: string) => {
  const input = filterOf(h);
  input.value = text;
  input.dispatchEvent(trusted(new Event('input', { bubbles: true, composed: true })));
};
const buttonNamed = (h: PickerHandle, name: RegExp) =>
  [...h.root.querySelectorAll('button')].find((b) => !b.hidden && name.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
const messageOf = (h: PickerHandle) => {
  const m = h.root.querySelector('[role="status"]') as HTMLElement;
  return m.hidden ? '' : m.textContent;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.replaceChildren();
  for (const node of [...document.documentElement.children]) {
    if (node !== document.head && node !== document.body) node.remove();
  }
});
afterEach(() => vi.restoreAllMocks());

describe('keyboard picker in the page', () => {
  it('mounts in a closed shadow root on a neutral host, anchored at the focused field', () => {
    const ta = textarea();
    ta.focus();
    const h = harness();
    const opened = createPageApi(h.env).openPicker(view());
    expect(opened).toEqual({ anchored: true });

    const host = h.handle().host;
    expect(host.parentElement).toBe(document.documentElement);
    // The page's scripts get nothing back from the host.
    expect(host.shadowRoot).toBeNull();
    expect(host.localName).toBe('div');
    expect(host.getAttributeNames()).toEqual(['style']);
    expect(host.outerHTML).not.toMatch(/qus/i);
    // The drafts are inside the closed root only, not in the page's DOM.
    expect(document.documentElement.outerHTML).not.toContain('Shipped');
    expect(h.handle().root.textContent).toContain('Shipped');
    // Its styles are inside the root, and the host's box is pinned against page rules.
    expect(h.handle().root.querySelector('style')?.textContent).toContain(':host');
    expect(document.head.querySelector('style')).toBeNull();
    expect(host.getAttribute('style')).toContain('all:initial !important');
    expect(h.handle().root.activeElement).toBe(filterOf(h.handle()));
  });

  it('filters as the user types and moves the selection with the arrow keys', () => {
    textarea().focus();
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    expect(options(p).map((o) => o.selected)).toEqual([true, false, false]);

    p.root.querySelector('input')?.dispatchEvent(key('ArrowDown'));
    expect(options(p).map((o) => o.selected)).toEqual([false, true, false]);
    p.root.querySelector('input')?.dispatchEvent(key('ArrowUp'));
    p.root.querySelector('input')?.dispatchEvent(key('ArrowUp'));
    expect(options(p).map((o) => o.selected)).toEqual([false, false, true]);

    typeFilter(p, 'SHIP');
    expect(options(p).map((o) => o.text)).toEqual([
      'Shipped: drafts land in your composer.',
      'Thread (1/4): what shipping a queue taught us',
    ]);
    expect(options(p)[0]?.selected).toBe(true);
    expect(p.root.textContent).toContain('X as @lokkju · 2 of 3');

    typeFilter(p, 'claude ship');
    expect(options(p).map((o) => o.text)).toEqual(['Shipped: drafts land in your composer.']);
    typeFilter(p, 'nothing like this');
    expect(options(p)).toEqual([]);
    expect(messageOf(p)).toBe('No drafts match.');
  });

  it('inserts the chosen draft on Enter: removes the host, refocuses the field, sends the pick', async () => {
    const ta = textarea();
    ta.value = 'Hello ';
    ta.focus();
    ta.setSelectionRange(6, 6);
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    expect(document.activeElement).toBe(p.host);
    filterOf(p).dispatchEvent(key('ArrowDown'));
    filterOf(p).dispatchEvent(key('Enter'));

    expect(p.host.isConnected).toBe(false);
    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe(6);
    expect(h.picks).toEqual([['tok-1', 'd2']]);
    await tick();
    // The insertion reports its own outcome; an inserted draft needs no notice.
    expect(h.prompts).toEqual([]);
  });

  it('inserts a draft the user clicks', () => {
    textarea().focus();
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    const third = p.root.querySelectorAll('[role="option"]')[2] as HTMLElement;
    third.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })));
    expect(h.picks).toEqual([['tok-1', 'd3']]);
    expect(p.host.isConnected).toBe(false);
  });

  it('ignores untrusted events, so the page cannot drive it', () => {
    textarea().focus();
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    filterOf(p).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
    );
    (p.root.querySelector('[role="option"]') as HTMLElement).click();
    expect(h.picks).toEqual([]);
    expect(p.host.isConnected).toBe(true);
    p.close('escape');
  });

  it('keeps keystrokes typed into the filter from reaching the page', () => {
    textarea().focus();
    const seen: string[] = [];
    const onKey = (event: Event) => seen.push(event.type);
    for (const type of ['keydown', 'keyup', 'input']) document.addEventListener(type, onKey);
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    filterOf(p).dispatchEvent(key('n'));
    filterOf(p).dispatchEvent(
      trusted(new KeyboardEvent('keyup', { key: 'n', bubbles: true, composed: true }))
    );
    typeFilter(p, 'n');
    expect(seen).toEqual([]);
    p.close('escape');
    for (const type of ['keydown', 'keyup', 'input']) document.removeEventListener(type, onKey);
  });

  it('closes on Escape, returning focus to the field, without inserting', () => {
    const ta = textarea();
    ta.focus();
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    filterOf(p).dispatchEvent(key('Escape'));
    expect(p.host.isConnected).toBe(false);
    expect(document.activeElement).toBe(ta);
    expect(h.picks).toEqual([]);
  });

  it('closes when the focus leaves it, when the window loses focus, and on navigation', () => {
    const ta = textarea();
    const other = textarea();
    ta.focus();
    const h = harness();
    const api = createPageApi(h.env);

    api.openPicker(view());
    const first = h.handle();
    other.focus();
    expect(first.host.isConnected).toBe(false);

    ta.focus();
    api.openPicker(view());
    const second = h.handle();
    window.dispatchEvent(new Event('blur'));
    expect(second.host.isConnected).toBe(false);

    ta.focus();
    api.openPicker(view());
    const third = h.handle();
    window.dispatchEvent(new Event('pagehide'));
    expect(third.host.isConnected).toBe(false);
    expect(h.picks).toEqual([]);
  });

  it('removes every listener it added when it closes', () => {
    const live = new Set<string>();
    const ids = new WeakMap<object, number>();
    let next = 0;
    const id = (o: object) => {
      if (!ids.has(o)) ids.set(o, next++);
      return ids.get(o);
    };
    const keyOf = (
      t: EventTarget,
      type: string,
      fn: unknown,
      o?: boolean | AddEventListenerOptions
    ) =>
      `${id(t)}:${type}:${id(fn as object)}:${typeof o === 'boolean' ? o : (o?.capture ?? false)}`;
    // happy-dom defines the methods on more than one prototype (Window's, EventTarget's): wrap
    // each one that the window, the document, a shadow root or an element uses.
    const owners = new Set<object>();
    const probe = document.createElement('div');
    for (const target of [window, document, probe, probe.attachShadow({ mode: 'open' })]) {
      for (const method of ['addEventListener', 'removeEventListener'] as const) {
        let proto: object | null = target;
        while (proto !== null && !Object.hasOwn(proto, method))
          proto = Object.getPrototypeOf(proto);
        if (proto !== null) owners.add(proto);
      }
    }
    for (const proto of owners) {
      const p = proto as EventTarget;
      if (Object.hasOwn(proto, 'addEventListener')) {
        const add = p.addEventListener;
        vi.spyOn(p, 'addEventListener').mockImplementation(function (
          this: EventTarget,
          type,
          fn,
          o
        ) {
          live.add(keyOf(this, type, fn, o));
          add.call(this, type, fn, o);
        });
      }
      if (Object.hasOwn(proto, 'removeEventListener')) {
        const remove = p.removeEventListener;
        vi.spyOn(p, 'removeEventListener').mockImplementation(function (
          this: EventTarget,
          type,
          fn,
          o
        ) {
          live.delete(keyOf(this, type, fn, o));
          remove.call(this, type, fn, o);
        });
      }
    }

    for (const close of ['escape', 'enter', 'blur'] as const) {
      const ta = textarea();
      ta.focus();
      const h = harness();
      createPageApi(h.env).openPicker(view());
      expect(live.size).toBeGreaterThan(0);
      const p = h.handle();
      if (close === 'escape') filterOf(p).dispatchEvent(key('Escape'));
      else if (close === 'enter') filterOf(p).dispatchEvent(key('Enter'));
      else window.dispatchEvent(new Event('blur'));
      expect(p.host.isConnected).toBe(false);
      expect([...live]).toEqual([]);
    }
  });

  it('says when the queue is locked and offers the popup to unlock', async () => {
    textarea().focus();
    const h = harness({ popupOpens: false });
    createPageApi(h.env).openPicker(view({ state: 'locked', here: [], others: [], context: '' }));
    const p = h.handle();
    expect(messageOf(p)).toBe('Your qus.me queue is locked.');
    expect(options(p)).toEqual([]);
    expect(filterOf(p).hidden).toBe(true);
    const open = buttonNamed(p, /unlock/);
    expect(open?.textContent).toBe('Open qus.me to unlock');
    expect(p.root.activeElement).toBe(open);
    open?.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })));
    await tick();
    expect(h.popups).toBe(1);
    // Firefox refuses openPopup from a page: point at the toolbar button instead.
    expect(messageOf(p)).toBe('Click the qus.me button in the browser toolbar.');
    p.close('escape');
  });

  it('with nothing for this page, says so, offers the popup and the other drafts', () => {
    textarea().focus();
    const h = harness();
    createPageApi(h.env).openPicker(view({ here: [], context: '' }));
    const p = h.handle();
    expect(messageOf(p)).toBe('No drafts for this page.');
    expect(buttonNamed(p, /^Open qus\.me$/)).toBeDefined();
    const toggle = buttonNamed(p, /other sites/);
    expect(toggle?.textContent).toBe('Show drafts for other sites (1)');
    toggle?.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })));
    expect(options(p)).toEqual([{ text: 'A post for Mastodon', selected: true }]);
    expect(messageOf(p)).toBe('');
    filterOf(p).dispatchEvent(key('Enter'));
    expect(h.picks).toEqual([['tok-1', 'd9']]);
  });

  it('lists drafts for other sites after the page’s own, behind the toggle', () => {
    textarea().focus();
    const h = harness();
    createPageApi(h.env).openPicker(view());
    const p = h.handle();
    expect(options(p)).toHaveLength(3);
    buttonNamed(p, /other sites/)?.dispatchEvent(
      trusted(new MouseEvent('click', { bubbles: true }))
    );
    expect(options(p).map((o) => o.text)).toEqual([
      'Shipped: drafts land in your composer.',
      'Thread (1/4): what shipping a queue taught us',
      'Lunch is at noon',
      'A post for Mastodon',
    ]);
    expect(buttonNamed(p, /other sites/)?.textContent).toBe('Hide drafts for other sites (1)');
    p.close('escape');
  });

  it('tells the user when the pick could not run', async () => {
    textarea().focus();
    const h = harness({ pickAnswer: { state: 'locked' } });
    createPageApi(h.env).openPicker(view());
    filterOf(h.handle()).dispatchEvent(key('Enter'));
    await tick();
    expect(h.prompts).toEqual([
      'qus.me is locked. Open qus.me to unlock it, then press the shortcut again.',
    ]);
  });

  it('replaces an open picker, and remembers the field when the focus is no longer on it', () => {
    const ta = textarea();
    ta.focus();
    const h = harness();
    const api = createPageApi(h.env);
    api.openPicker(view());
    const first = h.handle();
    // Pressed again while the picker has the focus: the field it opened at is still the target.
    expect(api.openPicker(view({ token: 'tok-2' }))).toEqual({ anchored: true });
    const second = h.handle();
    expect(first.host.isConnected).toBe(false);
    expect(second.host.isConnected).toBe(true);
    expect(document.querySelectorAll('html > div')).toHaveLength(1);
    filterOf(second).dispatchEvent(key('Enter'));
    expect(document.activeElement).toBe(ta);
    expect(h.picks).toEqual([['tok-2', 'd1']]);
  });

  it('opens at the top of the viewport when no field has the focus', () => {
    const h = harness();
    expect(createPageApi(h.env).openPicker(view())).toEqual({ anchored: false });
    expect(h.handle().host.isConnected).toBe(true);
    h.handle().close('escape');
  });
});
