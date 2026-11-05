/**
 * The synchronous injection strategies (spec 11.6): `paste`, `insertText` and `native`. Each
 * reports whether it could run on the target; whether the draft took is judged afterwards by
 * reading the target back. `clipboard` needs the user and lives in `run.ts`.
 */
import { type EditableTarget, isTextControl } from './target.ts';

export type ImmediateStrategy = 'paste' | 'insertText' | 'native';

/** False when the strategy does not apply to this target or the page lacks the API. */
export type StrategyFn = (target: EditableTarget, value: string) => boolean;

/** Focus; dispatch a `paste` ClipboardEvent whose DataTransfer carries `text/plain`. */
export const paste: StrategyFn = (target, value) => {
  const view = target.ownerDocument.defaultView;
  if (view === null || typeof view.DataTransfer !== 'function') return false;
  target.focus();
  const data = new view.DataTransfer();
  data.setData('text/plain', value);
  const event = new view.ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return true;
};

/** `document.execCommand('insertText', false, value)` at the selection. */
export const insertText: StrategyFn = (target, value) => {
  const doc = target.ownerDocument;
  if (typeof doc.execCommand !== 'function') return false;
  target.focus();
  doc.execCommand('insertText', false, value);
  return true;
};

/**
 * The native value setter from the element's prototype, then `input`. Framework state (React's
 * value tracker) watches the instance property, so setting through the prototype is what makes the
 * framework see a change. Inserts at the selection, as typing would.
 */
export const native: StrategyFn = (target, value) => {
  if (!isTextControl(target)) return false;
  const view = target.ownerDocument.defaultView;
  if (view === null) return false;
  const proto =
    target.localName === 'textarea'
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const getter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
  if (setter === undefined || getter === undefined) return false;
  target.focus();
  const current = getter.call(target) as string;
  const start = target.selectionStart ?? current.length;
  const end = target.selectionEnd ?? current.length;
  setter.call(target, current.slice(0, start) + value + current.slice(end));
  const caret = start + value.length;
  try {
    target.setSelectionRange(caret, caret);
  } catch {
    // Some input types have no selection; the value is set either way.
  }
  target.dispatchEvent(
    new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
  );
  return true;
};

export const IMMEDIATE_STRATEGIES: Record<ImmediateStrategy, StrategyFn> = {
  paste,
  insertText,
  native,
};

/**
 * Puts the caret at the end of the target, for a target found by locator rather than already
 * focused by the user, so the draft goes after anything the field already holds.
 */
export function placeCaretAtEnd(target: EditableTarget): void {
  target.focus();
  if (isTextControl(target)) {
    const end = target.value.length;
    try {
      target.setSelectionRange(end, end);
    } catch {
      // No selection on this input type.
    }
    return;
  }
  const doc = target.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (selection === null || selection === undefined) return;
  const range = doc.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
