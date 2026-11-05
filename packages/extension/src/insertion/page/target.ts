/**
 * Target resolution (spec 10.2) and reading a target back (11.6). The page's focused editable
 * element first, then the field's locators; when neither finds one, the caller asks the user to
 * click into the field.
 */
import type { Locator } from '@qusme/nostr';
import { findByLocator } from './accessible.ts';

/** An `<input>` or `<textarea>` that takes typed text, or a contenteditable editing host. */
export type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url']);

/** True for a value-holding control: `<textarea>` or a text-like `<input>`. */
export function isTextControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.localName === 'textarea') return true;
  if (element.localName !== 'input') return false;
  return TEXT_INPUT_TYPES.has((element.getAttribute('type') ?? '').toLowerCase());
}

/**
 * The editable element `element` belongs to: the control itself, or the outermost contenteditable
 * ancestor (the editing host) of an element inside a rich editor. Undefined when it is not
 * editable, or is a disabled or read-only control.
 */
export function editableOf(element: Element | null): EditableTarget | undefined {
  if (element === null) return undefined;
  if (isTextControl(element)) {
    return element.disabled || element.readOnly ? undefined : element;
  }
  const html = element as HTMLElement;
  if (!html.isContentEditable) return undefined;
  let host = html;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

/** The focused element, descending into open shadow roots. */
export function deepActiveElement(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** The focused editable element, if any. `<body>` in design mode does not count. */
export function focusedEditable(doc: Document): EditableTarget | undefined {
  const active = deepActiveElement(doc);
  if (active === null || active === doc.body || active === doc.documentElement) return undefined;
  return editableOf(active);
}

/** The first locator, in order, that finds an editable element (or one inside a match). */
export function locate(doc: Document, locators: readonly Locator[]): EditableTarget | undefined {
  for (const locator of locators) {
    for (const element of findByLocator(doc, locator)) {
      const editable =
        editableOf(element) ??
        editableOf(element.querySelector('textarea, input, [contenteditable]'));
      if (editable !== undefined) return editable;
    }
  }
  return undefined;
}

export type Resolved =
  | { target: EditableTarget; resolution: 'focused' | 'locator' }
  | { target: undefined; resolution: 'none' };

/** Spec 10.2 in order: the focused editable element, then the field's locators. */
export function resolveTarget(doc: Document, locators: readonly Locator[] = []): Resolved {
  const focused = focusedEditable(doc);
  if (focused !== undefined) return { target: focused, resolution: 'focused' };
  const located = locate(doc, locators);
  if (located !== undefined) return { target: located, resolution: 'locator' };
  return { target: undefined, resolution: 'none' };
}

/** The target's value (controls) or text content (rich editors). */
export function readBack(target: EditableTarget): string {
  if (isTextControl(target)) return target.value;
  return target.textContent ?? '';
}

/**
 * Text normalized for comparison: the zero-width characters editors insert and all whitespace
 * removed. Rich editors render line breaks as paragraph elements, whose text content has no
 * newline between them, so neither line structure nor spacing is compared.
 */
export const normalizeText = (text: string): string =>
  text.replace(/\u200b|\u200c|\u200d|\u2060|\ufeff|\s/g, '');

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count++;
  }
  return count;
}

/**
 * Whether an injection took (11.6): the target, read back, holds the value one more time than it
 * did before, compared after {@link normalizeText}. Counting keeps a field that already held the
 * same text from passing a strategy that did nothing.
 */
export function verifyInserted(before: string, after: string, value: string): boolean {
  const needle = normalizeText(value);
  return occurrences(normalizeText(after), needle) > occurrences(normalizeText(before), needle);
}
