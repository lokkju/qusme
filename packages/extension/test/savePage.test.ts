// @vitest-environment happy-dom
import type { Locator } from '@qusme/nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { fieldText, readField } from '../src/insertion/page/read.ts';
import { createPageApi } from '../src/insertion/page/run.ts';
import type { PageReadRequest } from '../src/insertion/protocol.ts';

const POST_TEXT: Locator = { role: 'textbox', name: { en: ['Post text'] } };
const REQUEST: PageReadRequest = { fields: [{ name: 'text', locators: [POST_TEXT] }] };

/** A Draft.js-style composer: one block per line, with a zero-width placeholder. */
function composer(lines: string[]) {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-label', 'Post text');
  for (const line of lines) {
    const block = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = line === '' ? '\u200b' : line;
    block.append(span);
    editor.append(block);
  }
  document.body.append(editor);
  return editor;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('reading a field to save (11.7)', () => {
  it('reads the focused composer the definition’s locator finds, line breaks kept', () => {
    const editor = composer(['First line', 'Second\u00a0line']);
    editor.focus();
    const result = readField(document, REQUEST);
    expect(result.state).toBe('read');
    if (result.state !== 'read') return;
    expect(result.field).toBe('text');
    expect(result.value.split(/\n+/)).toEqual(['First line', 'Second line']);
  });

  it('reads a focused textarea by its value, trimmed, and tells fields apart by locator', () => {
    const title = document.createElement('input');
    title.setAttribute('aria-label', 'Title');
    const body = document.createElement('textarea');
    body.setAttribute('aria-label', 'Body');
    document.body.append(title, body);
    body.value = '  Typed into the body\n';
    body.focus();
    const request: PageReadRequest = {
      fields: [
        { name: 'title', locators: [{ role: 'textbox', name: { en: ['Title'] } }] },
        { name: 'body', locators: [{ role: 'textbox', name: { en: ['Body'] } }] },
      ],
    };
    expect(readField(document, request)).toEqual({
      state: 'read',
      field: 'body',
      value: 'Typed into the body',
    });
  });

  it('refuses a focused field no locator finds, such as a search box', () => {
    composer(['A draft']);
    const search = document.createElement('input');
    search.setAttribute('type', 'search');
    search.setAttribute('aria-label', 'Search');
    search.value = 'cats';
    document.body.append(search);
    search.focus();
    expect(readField(document, REQUEST)).toEqual({ state: 'no_field' });
  });

  it('falls back to the first field a locator finds when nothing is focused, else none', () => {
    composer(['Left in the box']);
    expect(readField(document, REQUEST)).toMatchObject({ state: 'read', field: 'text' });
    document.body.replaceChildren();
    expect(readField(document, REQUEST)).toEqual({ state: 'no_target' });
  });

  it('cleans the zero-width placeholders and non-breaking spaces editors insert', () => {
    const textarea = document.createElement('textarea');
    textarea.value = '\ufeffHello\u200b\u00a0world \u{1F469}\u200d\u{1F4BB}\r\n';
    // The joiner inside the emoji sequence stays.
    expect(fieldText(textarea)).toBe('Hello world \u{1F469}\u200d\u{1F4BB}');
  });

  it('changes nothing in the page while reading', () => {
    const editor = composer(['Untouched']);
    editor.focus();
    const before = document.body.innerHTML;
    readField(document, REQUEST);
    expect(document.body.innerHTML).toBe(before);
    expect(editor.attributes.length).toBe(3);
  });
});

describe('the save notice (11.7)', () => {
  it('shows the extension’s text through the page’s notice, success briefly and failure longer', async () => {
    const shown: string[] = [];
    let removed = 0;
    const api = createPageApi({
      document,
      notify: () => undefined,
      writeClipboard: async () => false,
      prompt: (message) => {
        shown.push(message);
        return { update: () => undefined, remove: () => removed++ };
      },
    });
    api.showNotice('qus.me: saved.', 'success');
    api.showNotice('qus.me: click into the post box, then save again.', 'failure');
    expect(shown).toEqual(['qus.me: saved.', 'qus.me: click into the post box, then save again.']);
    await new Promise((r) => setTimeout(r, 4100));
    expect(removed).toBe(1);
  });

  it('puts the real notice in a closed shadow root on an unmarked host', () => {
    const api = createPageApi({
      document,
      notify: () => undefined,
      writeClipboard: async () => false,
    });
    api.showNotice('qus.me: saved.', 'success');
    const host = document.documentElement.lastElementChild as HTMLElement;
    expect(host.localName).toBe('div');
    // Only its pinned inline style: no qus.me id, class or attribute.
    expect(host.getAttributeNames()).toEqual(['style']);
    expect(host.shadowRoot).toBeNull();
    expect(document.documentElement.textContent).not.toContain('qus.me');
    host.remove();
  });

  it('reads through the page API as the extension calls it', () => {
    const editor = composer(['Through the API']);
    editor.focus();
    const api = createPageApi({
      document,
      notify: () => undefined,
      writeClipboard: async () => false,
    });
    expect(api.readField(REQUEST)).toEqual({
      state: 'read',
      field: 'text',
      value: 'Through the API',
    });
  });
});
