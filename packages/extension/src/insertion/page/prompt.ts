/**
 * A small notice the insertion script shows in the page when it needs the user: click into the
 * field, press Ctrl/Cmd+V, why the insertion failed, or that a picked draft went in (with Undo).
 * It never shows draft text, and its text is set with `textContent`.
 *
 * Like the keyboard picker, it lives in a closed shadow root on a plain `<div>` with no qus.me id,
 * class or attribute, so the page's scripts can neither find it by name nor reach into it. The
 * host's own box is pinned with inline `!important` declarations, which outrank any page rule
 * that matches a `<div>`. The script finds its own notice through a reference it holds, never by
 * querying the page.
 */

import { pageScheme, SANS, schemeRules } from './scheme.ts';

export interface Prompt {
  update(message: string): void;
  remove(): void;
}

/** A button in the notice beside its text, such as Undo. */
export interface PromptAction {
  label: string;
  onClick(): void;
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
${schemeRules('.b')}
.b {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 22rem;
  padding: 10px 12px 10px 14px; border-radius: 10px; background: var(--surface); color: var(--fg);
  border: 1px solid var(--edge); border-left: 4px solid var(--accent);
  font: 14px/1.45 ${SANS}; box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 12px 32px -8px var(--shadow);
  display: flex; gap: 10px; align-items: flex-start; box-sizing: border-box;
  text-align: left; direction: ltr; letter-spacing: normal; text-transform: none;
}
.a { all: unset; cursor: pointer; flex: none; color: var(--accent); font-weight: 600; text-decoration: underline;
  text-underline-offset: 2px; }
.a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.x { all: unset; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 2px; color: var(--muted); }
.x:hover { color: var(--fg); }
.x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
`;

/** The notice currently shown in each document, held here rather than marked in the page. */
const current = new WeakMap<Document, PromptHandle>();

/**
 * Shows `message` at the bottom right of the page until removed or closed, with `action` as a
 * button beside it when given; a trusted click on the action removes the notice and runs it.
 */
export function showPrompt(
  doc: Document,
  message: string,
  onClose?: () => void,
  action?: PromptAction
): PromptHandle {
  current.get(doc)?.remove();
  const host = doc.createElement('div');
  host.setAttribute('style', HOST_STYLE);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const box = doc.createElement('div');
  const scheme = pageScheme(doc);
  box.className = scheme === undefined ? 'b' : `b ${scheme}`;
  box.setAttribute('role', 'status');
  const text = doc.createElement('span');
  text.textContent = message;
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'x';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  box.append(text);
  let actionButton: HTMLButtonElement | undefined;
  if (action !== undefined) {
    actionButton = doc.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'a';
    actionButton.textContent = action.label;
    box.append(actionButton);
  }
  box.append(close);
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
  actionButton?.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    prompt.remove();
    action?.onClick();
  });
  current.set(doc, prompt);
  doc.documentElement.append(host);
  return prompt;
}

/** Whether a qus.me prompt is on the page; for tests. */
export const promptShown = (doc: Document): boolean => current.get(doc)?.host.isConnected === true;
