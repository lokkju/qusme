/**
 * A small notice the insertion script shows in the page when it needs the user: click into the
 * field, press Ctrl/Cmd+V, or why the insertion failed. It lives in a closed shadow root so the
 * page's styles and scripts don't reach into it, and its text is set with `textContent`. It never
 * shows draft text.
 */

export interface Prompt {
  update(message: string): void;
  remove(): void;
}

const HOST_ATTRIBUTE = 'data-qusme-prompt';

/** Shows `message` at the bottom right of the page until removed or closed. */
export function showPrompt(doc: Document, message: string, onClose?: () => void): Prompt {
  doc.querySelector(`[${HOST_ATTRIBUTE}]`)?.remove();
  const host = doc.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');
  const root = host.attachShadow({ mode: 'closed' });
  const box = doc.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute(
    'style',
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:22rem;padding:10px 12px;' +
      'border-radius:6px;background:#1c1917;color:#fafaf9;font:14px/1.4 system-ui,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:8px;align-items:flex-start'
  );
  const text = doc.createElement('span');
  text.textContent = message;
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.setAttribute(
    'style',
    'all:unset;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;color:inherit'
  );
  close.addEventListener('click', () => {
    host.remove();
    onClose?.();
  });
  box.append(text, close);
  root.append(box);
  doc.documentElement.append(host);
  return {
    update: (next) => {
      text.textContent = next;
    },
    remove: () => host.remove(),
  };
}

/** Whether a qus.me prompt is on the page; for tests. */
export const promptShown = (doc: Document): boolean =>
  doc.querySelector(`[${HOST_ATTRIBUTE}]`) !== null;
