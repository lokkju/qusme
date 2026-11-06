/**
 * A small notice the insertion script shows in the page when it needs the user: click into the
 * field, press Ctrl/Cmd+V, or why the insertion failed. It never shows draft text, and its text is
 * set with `textContent`.
 *
 * Like the keyboard picker, it lives in a closed shadow root on a plain `<div>` with no qus.me id,
 * class or attribute, so the page's scripts can neither find it by name nor reach into it. The
 * host's own box is pinned with inline `!important` declarations, which outrank any page rule
 * that matches a `<div>`. The script finds its own notice through a reference it holds, never by
 * querying the page.
 */

export interface Prompt {
  update(message: string): void;
  remove(): void;
}

/** What {@link showPrompt} returns: a {@link Prompt} plus the elements it made. */
export interface PromptHandle extends Prompt {
  /** The element in the page's DOM; its shadow root is closed. */
  readonly host: HTMLElement;
  /** The closed shadow root, reachable only through this handle (for tests). */
  readonly root: ShadowRoot;
}

const HOST_STYLE = [
  'all:initial',
  'display:block',
  'position:fixed',
  'left:0',
  'top:0',
  'width:0',
  'height:0',
  'margin:0',
  'padding:0',
  'border:0',
  'overflow:visible',
  'z-index:2147483647',
]
  .map((d) => `${d} !important`)
  .join(';');

const STYLE = `
:host { all: initial; }
.b {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 22rem;
  padding: 10px 12px; border-radius: 6px; background: #1c1917; color: #fafaf9;
  font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.3);
  display: flex; gap: 8px; align-items: flex-start; box-sizing: border-box;
}
.x { all: unset; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 2px; color: inherit; }
.x:focus-visible { outline: 2px solid #fafaf9; outline-offset: 2px; }
`;

/** The notice currently shown in each document, held here rather than marked in the page. */
const current = new WeakMap<Document, PromptHandle>();

/** Shows `message` at the bottom right of the page until removed or closed. */
export function showPrompt(doc: Document, message: string, onClose?: () => void): PromptHandle {
  current.get(doc)?.remove();
  const host = doc.createElement('div');
  host.setAttribute('style', HOST_STYLE);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const box = doc.createElement('div');
  box.className = 'b';
  box.setAttribute('role', 'status');
  const text = doc.createElement('span');
  text.textContent = message;
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'x';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  box.append(text, close);
  root.append(style, box);

  const prompt: PromptHandle = {
    host,
    root,
    update: (next) => {
      text.textContent = next;
    },
    remove: () => {
      host.remove();
      if (current.get(doc) === prompt) current.delete(doc);
    },
  };
  close.addEventListener('click', () => {
    prompt.remove();
    onClose?.();
  });
  current.set(doc, prompt);
  doc.documentElement.append(host);
  return prompt;
}

/** Whether a qus.me prompt is on the page; for tests. */
export const promptShown = (doc: Document): boolean => current.get(doc)?.host.isConnected === true;
