// @vitest-environment happy-dom
import type { Locator, SiteAccount } from '@qusme/nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accessibleName,
  findByLocator,
  namesFor,
  roleOf,
} from '../src/insertion/page/accessible.ts';
import {
  createPageApi,
  defaultChain,
  detectAccount,
  type PageEnv,
} from '../src/insertion/page/run.ts';
import { insertText, native, paste } from '../src/insertion/page/strategies.ts';
import {
  editableOf,
  focusedEditable,
  normalizeText,
  readBack,
  resolveTarget,
  verifyInserted,
} from '../src/insertion/page/target.ts';
import type { PageDone, PageInsertRequest, PageOutcome } from '../src/insertion/protocol.ts';

const POST_TEXT: Locator = { role: 'textbox', name: { en: ['Post text'], de: ['Beitragstext'] } };
const X_ACCOUNT: SiteAccount = {
  locator: { role: 'button', name: { en: ['Account menu'], de: ['Kontomenü'] } },
  extract: '@([A-Za-z0-9_]{1,15})',
};

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') as {
  get(this: HTMLTextAreaElement): string;
  set(this: HTMLTextAreaElement, v: string): void;
};

/**
 * A rich editor in the style of X's Draft.js composer: it handles `paste` itself, prevents the
 * default and renders the text into its own spans on a later task, as a React state update does.
 * `ignorePaste` makes it ignore synthetic pastes, so the chain has to fall through.
 */
function xComposer(options: { ignorePaste?: boolean; garble?: boolean } = {}) {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-label', 'Post text');
  editor.innerHTML = '<div data-contents="true"><div><span data-text="true"></span></div></div>';
  editor.addEventListener('paste', (event) => {
    if (options.ignorePaste) return;
    event.preventDefault();
    const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    setTimeout(() => {
      const span = editor.querySelector('[data-text]') as HTMLElement;
      span.textContent = (span.textContent ?? '') + (options.garble ? text.slice(0, 3) : text);
    }, 10);
  });
  document.body.append(editor);
  return editor;
}

/**
 * A Lexical-style editor (Facebook's composer): a model string re-rendered as one paragraph per
 * line in a microtask after each paste, with the zero-width and `<br>` placeholders Lexical uses.
 */
function lexicalComposer(label: string) {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-label', label);
  editor.setAttribute('data-lexical-editor', 'true');
  let model = '';
  const render = () => {
    editor.replaceChildren();
    for (const line of model.split('\n')) {
      const p = document.createElement('p');
      if (line === '') p.append(document.createElement('br'));
      else {
        const span = document.createElement('span');
        span.setAttribute('data-lexical-text', 'true');
        span.textContent = line;
        p.append(span);
      }
      editor.append(p);
    }
  };
  render();
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    model += (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    queueMicrotask(render);
  });
  document.body.append(editor);
  return { editor, model: () => model };
}

/**
 * A `<textarea>` controlled by React state: React's value tracker shadows `value` on the
 * instance, and on `input` the component re-renders the textarea from its state. Only a change the
 * tracker didn't see (one made through the prototype's setter) reaches the state.
 */
function reactTextarea(label: string) {
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', label);
  let tracked = '';
  let state = '';
  Object.defineProperty(textarea, 'value', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return valueProp.get.call(this);
    },
    set(this: HTMLTextAreaElement, v: string) {
      tracked = String(v);
      valueProp.set.call(this, String(v));
    },
  });
  textarea.addEventListener('input', () => {
    const actual = valueProp.get.call(textarea);
    if (actual !== tracked) state = actual;
    textarea.value = state;
  });
  document.body.append(textarea);
  return { textarea, state: () => state };
}

/** `document.execCommand('insertText')` as browsers do it: at the selection or caret. */
function installExecCommand() {
  (
    document as unknown as { execCommand: (c: string, u: boolean, v: string) => boolean }
  ).execCommand = (command, _ui, value) => {
    if (command !== 'insertText') return false;
    const active = document.activeElement as HTMLElement | null;
    if (active === null) return false;
    if (active.localName === 'textarea') {
      const ta = active as HTMLTextAreaElement;
      const current = valueProp.get.call(ta);
      const start = ta.selectionStart ?? current.length;
      valueProp.set.call(
        ta,
        current.slice(0, start) + value + current.slice(ta.selectionEnd ?? start)
      );
      ta.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
      );
      return true;
    }
    if (!active.isContentEditable) return false;
    const range = window.getSelection()?.rangeCount
      ? window.getSelection()?.getRangeAt(0)
      : undefined;
    const node = document.createTextNode(value);
    if (range !== undefined && active.contains(range.startContainer)) {
      range.deleteContents();
      range.insertNode(node);
    } else {
      active.append(node);
    }
    return true;
  };
}

function removeExecCommand() {
  delete (document as unknown as { execCommand?: unknown }).execCommand;
}

interface Harness {
  env: PageEnv;
  prompts: string[];
  done: PageDone[];
  clipboard: string[];
  nextDone(): Promise<PageDone>;
}

function harness(options: { clipboard?: boolean } = {}): Harness {
  const prompts: string[] = [];
  const done: PageDone[] = [];
  const clipboard: string[] = [];
  let waiter: ((d: PageDone) => void) | undefined;
  const env: PageEnv = {
    document,
    notify: (d) => {
      done.push(d);
      waiter?.(d);
    },
    writeClipboard: async (text) => {
      if (options.clipboard === false) return false;
      clipboard.push(text);
      return true;
    },
    prompt: (message) => {
      prompts.push(message);
      return { update: (m) => prompts.push(m), remove: () => undefined };
    },
    settleMs: 100,
    pollMs: 5,
  };
  return {
    env,
    prompts,
    done,
    clipboard,
    nextDone: () =>
      new Promise((resolve) => {
        const existing = done.at(-1);
        if (existing !== undefined) resolve(existing);
        else waiter = resolve;
      }),
  };
}

const request = (over: Partial<PageInsertRequest> = {}): PageInsertRequest => ({
  token: 'tok',
  value: 'Shipping the insertion today.\nSecond line.',
  method: 'extension_popup',
  clipboardFallback: true,
  ...over,
});

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('lang');
  removeExecCommand();
});
afterEach(() => removeExecCommand());

describe('roles and accessible names', () => {
  it('reads explicit and implicit roles', () => {
    document.body.innerHTML =
      '<div id="a" role="textbox button"></div><textarea id="b"></textarea><input id="c" type="search"><a id="d" href="/">x</a><button id="e">Go</button>';
    const role = (id: string) => roleOf(document.getElementById(id) as Element);
    expect([role('a'), role('b'), role('c'), role('d'), role('e')]).toEqual([
      'textbox',
      'textbox',
      'searchbox',
      'link',
      'button',
    ]);
  });

  it('names from aria-labelledby, aria-label, labels, content, then title and placeholder', () => {
    document.body.innerHTML = `
      <span id="l1">Post</span><span id="l2">text</span>
      <div id="a" role="textbox" aria-labelledby="l1 l2" aria-label="ignored"></div>
      <div id="b" role="textbox" aria-label="  Post   text "></div>
      <label for="c">Your bio</label><textarea id="c"></textarea>
      <button id="d"><span aria-hidden="true">✕</span> Account <b>menu</b></button>
      <textarea id="e" placeholder="Write something"></textarea>`;
    const name = (id: string) => accessibleName(document.getElementById(id) as Element);
    expect(name('a')).toBe('Post text');
    expect(name('b')).toBe('Post text');
    expect(name('c')).toBe('Your bio');
    expect(name('d')).toBe('Account menu');
    expect(name('e')).toBe('Write something');
  });

  it('keys locator names by the document language, falling back to en', () => {
    expect(namesFor(POST_TEXT, 'de')).toEqual(['Beitragstext']);
    expect(namesFor(POST_TEXT, 'de-AT')).toEqual(['Beitragstext']);
    expect(namesFor(POST_TEXT, 'DE')).toEqual(['Beitragstext']);
    expect(namesFor(POST_TEXT, 'fr')).toEqual(['Post text']);
    expect(namesFor(POST_TEXT, '')).toEqual(['Post text']);
  });

  it('finds shown elements by role and name in the page language', () => {
    document.documentElement.lang = 'de-DE';
    document.body.innerHTML = `
      <div role="textbox" aria-label="Post text" contenteditable="true"></div>
      <div role="textbox" aria-label="Beitragstext" contenteditable="true" hidden></div>
      <div role="textbox" aria-label="Beitragstext" contenteditable="true" id="shown"></div>`;
    expect(findByLocator(document, POST_TEXT).map((e) => e.id)).toEqual(['shown']);
    document.documentElement.lang = 'fr';
    expect(findByLocator(document, POST_TEXT)).toHaveLength(1);
    expect(accessibleName(findByLocator(document, POST_TEXT)[0] as Element)).toBe('Post text');
  });
});

describe('account detection', () => {
  const accountButton = (label: string) => {
    document.body.innerHTML = `<nav><button aria-label="${label}"><span>Loki</span><span>@lokkju</span></button></nav>`;
  };

  it('extracts the account from the account locator', () => {
    accountButton('Account menu');
    expect(detectAccount(document, X_ACCOUNT)).toEqual({ account: 'lokkju' });
  });

  it('uses the names for the page language, and en when the language has none', () => {
    document.documentElement.lang = 'de';
    accountButton('Kontomenü');
    expect(detectAccount(document, X_ACCOUNT)).toEqual({ account: 'lokkju' });
    document.documentElement.lang = 'pt-BR';
    accountButton('Account menu');
    expect(detectAccount(document, X_ACCOUNT)).toEqual({ account: 'lokkju' });
    document.documentElement.lang = 'de';
    expect(detectAccount(document, X_ACCOUNT)).toEqual({});
  });

  it('finds nothing without the element, a match or a valid pattern', () => {
    expect(detectAccount(document, X_ACCOUNT)).toEqual({});
    document.body.innerHTML = '<button aria-label="Account menu">Loki</button>';
    expect(detectAccount(document, X_ACCOUNT)).toEqual({});
    expect(detectAccount(document, { ...X_ACCOUNT, extract: '(' })).toEqual({});
  });
});

describe('target resolution (10.2)', () => {
  it('takes the focused editable element first, even over a locator match', () => {
    const composer = xComposer();
    const other = document.createElement('textarea');
    document.body.append(other);
    other.focus();
    expect(resolveTarget(document, [POST_TEXT])).toEqual({ target: other, resolution: 'focused' });
    expect(composer).toBeDefined();
  });

  it('resolves a focused element inside a rich editor to its editing host', () => {
    const composer = xComposer();
    const inner = composer.querySelector('[data-text]') as HTMLElement;
    expect(editableOf(inner)).toBe(composer);
  });

  it('falls back to the locators, then to nothing', () => {
    const composer = xComposer();
    expect(resolveTarget(document, [POST_TEXT])).toEqual({
      target: composer,
      resolution: 'locator',
    });
    expect(resolveTarget(document, [])).toEqual({ target: undefined, resolution: 'none' });
  });

  it('skips disabled and read-only controls and the body', () => {
    document.body.innerHTML = '<textarea id="r" readonly></textarea><input id="d" disabled>';
    (document.getElementById('r') as HTMLElement).focus();
    expect(focusedEditable(document)).toBeUndefined();
    expect(editableOf(document.getElementById('d'))).toBeUndefined();
    expect(focusedEditable(document)).toBeUndefined();
  });

  it('reaches through a locator match to the editable inside it', () => {
    document.body.innerHTML =
      '<div role="textbox" aria-label="Post text"><div id="inner" contenteditable="true"></div></div>';
    expect(resolveTarget(document, [POST_TEXT]).target?.id).toBe('inner');
  });
});

describe('read-back check', () => {
  it('passes only when the value appears one more time than before', () => {
    expect(verifyInserted('', 'hello world', 'hello world')).toBe(true);
    expect(verifyInserted('hello world', 'hello world', 'hello world')).toBe(false);
    expect(verifyInserted('hello world', 'hello worldhello world', 'hello world')).toBe(true);
    expect(verifyInserted('', 'hello', 'hello world')).toBe(false);
  });

  it('ignores line structure, spacing and zero-width characters editors add', () => {
    expect(normalizeText('a​ b\n\nc d')).toBe('abcd');
    expect(verifyInserted('', 'line one​line two', 'line one\nline two')).toBe(true);
  });

  it('reads controls by value and rich editors by text', () => {
    const { editor } = lexicalComposer('x');
    editor.innerHTML = '<p><span>one</span></p><p><span>two</span></p>';
    expect(readBack(editor)).toBe('onetwo');
    const ta = document.createElement('textarea');
    ta.value = 'v';
    expect(readBack(ta)).toBe('v');
  });
});

describe('strategies (11.6)', () => {
  it('paste: a Lexical-style editor takes the DataTransfer text', async () => {
    const { editor, model } = lexicalComposer("What's on your mind?");
    expect(paste(editor, 'first\nsecond')).toBe(true);
    await tick();
    expect(model()).toBe('first\nsecond');
    expect(editor.querySelectorAll('p')).toHaveLength(2);
  });

  it('paste: a plain textarea ignores a synthetic paste', () => {
    const ta = document.createElement('textarea');
    document.body.append(ta);
    expect(paste(ta, 'x')).toBe(true);
    expect(ta.value).toBe('');
  });

  it('insertText: runs execCommand at the caret, and does not apply without it', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.append(editor);
    expect(insertText(editor, 'x')).toBe(false);
    installExecCommand();
    expect(insertText(editor, 'hello')).toBe(true);
    expect(editor.textContent).toBe('hello');
  });

  it('native: a React-controlled textarea keeps the value, where a plain assignment is reverted', () => {
    const naive = reactTextarea('Naive');
    naive.textarea.value = 'lost';
    naive.textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(naive.textarea.value).toBe('');

    const { textarea, state } = reactTextarea('Message');
    valueProp.set.call(textarea, 'Hi ');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    textarea.setSelectionRange(3, 3);
    expect(native(textarea, 'there')).toBe(true);
    expect(state()).toBe('Hi there');
    expect(textarea.value).toBe('Hi there');
    expect(textarea.selectionStart).toBe(8);
  });

  it('native: does not apply to a contenteditable', () => {
    expect(native(xComposer(), 'x')).toBe(false);
  });

  it('picks a default chain by element when the destination has no definition, trusted input first', () => {
    // execCommand's beforeinput and input are trusted; a synthetic paste or input event is not.
    expect(defaultChain(document.createElement('textarea'))).toEqual([
      'insertText',
      'native',
      'clipboard',
    ]);
    expect(defaultChain(xComposer())).toEqual(['insertText', 'paste', 'clipboard']);
  });

  it('inserts with insertText before dispatching a synthetic paste when there is no definition', async () => {
    installExecCommand();
    const composer = xComposer();
    const pastes: boolean[] = [];
    composer.addEventListener('paste', (event) => pastes.push(event.isTrusted));
    composer.focus();
    const outcome = await createPageApi(harness().env).insert(request({ value: 'Trusted path' }));
    expect(outcome).toMatchObject({ state: 'inserted', strategy: 'insertText' });
    expect(pastes).toEqual([]);
  });
});

describe('insertion', () => {
  const field = { locators: [POST_TEXT], inject: ['paste', 'insertText', 'clipboard'] as const };
  const xField = { locators: [...field.locators], inject: [...field.inject] };

  it('inserts into the X composer by locator with paste and reports what it did', async () => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<button aria-label="Account menu"><span>@lokkju</span></button>'
    );
    const composer = xComposer();
    const h = harness();
    const api = createPageApi(h.env);
    const outcome = await api.insert(request({ field: xField, account: X_ACCOUNT }));
    expect(outcome).toEqual({
      state: 'inserted',
      strategy: 'paste',
      resolution: 'locator',
      accessibleName: 'Post text',
      detectedAccount: 'lokkju',
      url: document.location.href,
    });
    expect(composer.textContent).toBe('Shipping the insertion today.\nSecond line.');
    expect(h.prompts).toEqual([]);
  });

  it('inserts into a focused Lexical composer without a definition', async () => {
    const { editor, model } = lexicalComposer("What's on your mind, Loki?");
    editor.focus();
    const api = createPageApi(harness().env);
    const outcome = (await api.insert(request())) as PageOutcome & { state: 'inserted' };
    expect(outcome.state).toBe('inserted');
    expect(outcome.strategy).toBe('paste');
    expect(outcome.resolution).toBe('focused');
    expect(outcome.accessibleName).toBe("What's on your mind, Loki?");
    expect(outcome.detectedAccount).toBe('');
    expect(model()).toBe('Shipping the insertion today.\nSecond line.');
  });

  it('inserts into a React-controlled textarea with native', async () => {
    const { textarea, state } = reactTextarea('Message');
    textarea.focus();
    const outcome = await createPageApi(harness().env).insert(
      request({ field: { locators: [], inject: ['paste', 'native', 'clipboard'] } })
    );
    expect(outcome).toMatchObject({ state: 'inserted', strategy: 'native', resolution: 'focused' });
    expect(state()).toBe('Shipping the insertion today.\nSecond line.');
  });

  it('falls through to insertText when the editor ignores the synthetic paste', async () => {
    installExecCommand();
    const composer = xComposer({ ignorePaste: true });
    const outcome = await createPageApi(harness().env).insert(request({ field: xField }));
    expect(outcome).toMatchObject({
      state: 'inserted',
      strategy: 'insertText',
      resolution: 'locator',
    });
    expect(normalizeText(composer.textContent ?? '')).toBe(
      normalizeText('Shipping the insertion today.\nSecond line.')
    );
  });

  it('places the caret after existing text when the target came from a locator', async () => {
    installExecCommand();
    const composer = xComposer({ ignorePaste: true });
    (composer.querySelector('[data-text]') as HTMLElement).textContent = 'Already here. ';
    await createPageApi(harness().env).insert(request({ field: xField, value: 'New text' }));
    expect(composer.textContent).toBe('Already here. New text');
  });

  it('stops the chain when the field changed without taking the draft', async () => {
    installExecCommand();
    const composer = xComposer({ garble: true });
    const h = harness();
    const outcome = await createPageApi(h.env).insert(
      request({ field: xField, method: 'extension_context_menu' })
    );
    expect(outcome).toEqual({ state: 'failed', reason: 'partial', tried: ['paste'] });
    expect(composer.textContent).toBe('Shi');
    expect(h.prompts[0]).toContain("doesn't match the draft");
  });

  it('reports exhausted when nothing takes and the chain has no clipboard', async () => {
    xComposer({ ignorePaste: true });
    const outcome = await createPageApi(harness().env).insert(
      request({ field: { locators: [POST_TEXT], inject: ['paste', 'native', 'insertText'] } })
    );
    expect(outcome).toEqual({ state: 'failed', reason: 'exhausted', tried: ['paste'] });
  });

  it('refuses an empty draft', async () => {
    xComposer();
    expect(await createPageApi(harness().env).insert(request({ value: ' \n ' }))).toEqual({
      state: 'failed',
      reason: 'empty',
      tried: [],
    });
  });

  describe('clipboard', () => {
    it('copies, prompts for Ctrl+V and reports once the paste lands', async () => {
      const composer = xComposer({ ignorePaste: true });
      const h = harness();
      const outcome = await createPageApi(h.env).insert(request({ field: xField }));
      expect(outcome).toEqual({ state: 'waiting', reason: 'paste', clipboardWritten: true });
      expect(h.clipboard).toEqual(['Shipping the insertion today.\nSecond line.']);
      expect(h.prompts.at(-1)).toMatch(/Press (Ctrl\+V|⌘V) to paste/);
      expect(h.prompts.join('\n')).not.toContain('Shipping');
      expect(h.done).toEqual([]);
      // The user's real paste: the editor takes it as typed text.
      (composer.querySelector('[data-text]') as HTMLElement).textContent =
        'Shipping the insertion today. Second line.';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
      const done = await h.nextDone();
      expect(done).toEqual({
        type: 'qusme.insertion.done',
        token: 'tok',
        outcome: {
          state: 'inserted',
          strategy: 'clipboard',
          resolution: 'locator',
          accessibleName: 'Post text',
          detectedAccount: '',
          url: document.location.href,
        },
      });
    });

    it('accepts the paste in another field the user clicked into', async () => {
      xComposer({ ignorePaste: true });
      const other = document.createElement('textarea');
      other.setAttribute('aria-label', 'Reply');
      document.body.append(other);
      const h = harness();
      await createPageApi(h.env).insert(request({ field: xField }));
      other.focus();
      other.value = 'Shipping the insertion today.\nSecond line.';
      other.dispatchEvent(new InputEvent('input', { bubbles: true }));
      const done = await h.nextDone();
      expect(done.outcome).toMatchObject({
        state: 'inserted',
        strategy: 'clipboard',
        resolution: 'focus_placement',
        accessibleName: 'Reply',
      });
    });

    it('leaves the clipboard to the popup when the page may not write it', async () => {
      xComposer({ ignorePaste: true });
      const h = harness({ clipboard: false });
      expect(await createPageApi(h.env).insert(request({ field: xField }))).toEqual({
        state: 'waiting',
        reason: 'paste',
        clipboardWritten: false,
      });
    });

    it('gives up from the context menu when the clipboard cannot be written', async () => {
      xComposer({ ignorePaste: true });
      const h = harness({ clipboard: false });
      const outcome = await createPageApi(h.env).insert(
        request({ field: xField, method: 'extension_context_menu', clipboardFallback: false })
      );
      expect(outcome).toEqual({
        state: 'failed',
        reason: 'clipboard_denied',
        tried: ['paste', 'clipboard'],
      });
      expect(h.prompts.at(-1)).toContain("couldn't insert the draft or copy it");
    });

    it('times out when nobody pastes', async () => {
      xComposer({ ignorePaste: true });
      const h = harness();
      await createPageApi(h.env).insert(request({ field: xField, waitMs: 30 }));
      const done = await h.nextDone();
      expect(done.outcome).toEqual({
        state: 'failed',
        reason: 'timeout',
        tried: ['paste', 'clipboard'],
      });
    });

    it('is superseded by a newer insertion', async () => {
      xComposer({ ignorePaste: true });
      const h = harness();
      const api = createPageApi(h.env);
      await api.insert(request({ field: xField, token: 'first' }));
      await api.insert(request({ field: xField, token: 'second' }));
      expect(h.done[0]).toMatchObject({ token: 'first', outcome: { reason: 'superseded' } });
    });
  });

  it('asks the user to click into the field when nothing resolves, then inserts there', async () => {
    const { editor, model } = lexicalComposer('Write a post');
    const h = harness();
    const outcome = await createPageApi(h.env).insert(request({ field: xField }));
    expect(outcome).toEqual({ state: 'waiting', reason: 'focus' });
    expect(h.prompts.at(-1)).toContain('click into the field');
    editor.focus();
    const done = await h.nextDone();
    expect(done.outcome).toMatchObject({
      state: 'inserted',
      strategy: 'paste',
      resolution: 'focus_placement',
      accessibleName: 'Write a post',
    });
    expect(model()).toBe('Shipping the insertion today.\nSecond line.');
  });

  it('stops waiting for the click after the timeout', async () => {
    const h = harness();
    await createPageApi(h.env).insert(request({ waitMs: 20 }));
    expect((await h.nextDone()).outcome).toEqual({ state: 'failed', reason: 'timeout', tried: [] });
  });
});
