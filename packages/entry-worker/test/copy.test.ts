/// <reference types="node" />
// site/copy.js, the landing page's one script, run against the real index.html in happy-dom.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SITE_DIR = resolve(import.meta.dirname, '../../../site');
const html = readFileSync(resolve(SITE_DIR, 'index.html'), 'utf8');
const script = readFileSync(resolve(SITE_DIR, 'copy.js'), 'utf8');

let window: Window;

beforeEach(() => {
  vi.useFakeTimers();
  window = new Window({ url: 'https://qus.me/' });
  window.document.write(html);
});

afterEach(async () => {
  vi.useRealTimers();
  await window.happyDOM.close();
});

/** Runs copy.js with the page's globals, as the browser would with `defer`. */
function run(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true });
  const execCommand = vi.fn(() => true);
  (window.document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
  new Function('navigator', 'document', 'HTMLInputElement', 'Node', script)(
    window.navigator,
    window.document,
    window.HTMLInputElement,
    window.Node
  );
  return { execCommand };
}

const button = (target: string) => {
  const el = window.document.querySelector(`button[data-copy="${target}"]`);
  if (!el) throw new Error(`no copy button for ${target}`);
  return el as unknown as { click(): void; textContent: string | null };
};
const status = () => window.document.querySelector('[data-copy-status]')?.textContent;
const settle = () => vi.advanceTimersByTimeAsync(0);

it('copies the MCP server URL, says so, and resets after two seconds', async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  run({ writeText });
  const copy = button('mcp-url');
  expect(copy.textContent).toBe('MCP server URL: Copy');
  copy.click();
  await settle();
  expect(writeText).toHaveBeenCalledWith('https://app.qus.me/mcp');
  expect(copy.textContent).toBe('MCP server URL: Copied');
  expect(status()).toBe('Copied to the clipboard.');
  await vi.advanceTimersByTimeAsync(2000);
  expect(copy.textContent).toBe('MCP server URL: Copy');
  expect(status()).toBe('');
});

it('copies the Claude Code command and the .mcp.json block as shown', async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  run({ writeText });
  button('snippet-cli').click();
  await settle();
  expect(writeText).toHaveBeenLastCalledWith(
    'claude mcp add --transport http qusme https://app.qus.me/mcp'
  );
  button('snippet-json').click();
  await settle();
  const json = JSON.parse(writeText.mock.lastCall?.[0] ?? '');
  expect(json).toEqual({ mcpServers: { qusme: { type: 'http', url: 'https://app.qus.me/mcp' } } });
});

it('falls back to selecting the input when the Clipboard API is missing or refuses', async () => {
  const { execCommand } = run(undefined);
  button('mcp-url').click();
  await settle();
  expect(execCommand).toHaveBeenCalledWith('copy');
  expect(button('mcp-url').textContent).toBe('MCP server URL: Copied');

  const refusing = vi.fn(async () => {
    throw new Error('denied');
  });
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: refusing },
    configurable: true,
  });
  button('mcp-url').click();
  await settle();
  expect(refusing).toHaveBeenCalled();
  expect(execCommand).toHaveBeenCalledTimes(2);
});

it('tells the user to copy by hand when nothing works', async () => {
  run({
    writeText: async () => {
      throw new Error('denied');
    },
  });
  const copy = button('snippet-cli');
  copy.click();
  await settle();
  expect(copy.textContent).toBe('Claude Code command: Not copied');
  expect(status()).toBe('Copy failed; select the text and copy it.');
});
