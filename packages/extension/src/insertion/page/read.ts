/**
 * Saving a field as a draft (spec 11.7), the page's half: find the field the user means, tell
 * which of the definition's fields it is by the same locators insertion uses (10.2), and read its
 * text. Reads only; nothing in the page changes and nothing is marked.
 */
import type { PageReadField, PageReadRequest, PageReadResult } from '../protocol.ts';
import { findByLocator } from './accessible.ts';
import { type EditableTarget, editableOf, focusedEditable, isTextControl } from './target.ts';

/**
 * The zero-width placeholders rich editors insert, never part of what was typed. The joiners
 * (U+200C, U+200D) stay: they are part of emoji sequences and some scripts.
 */
const ZERO_WIDTH = /\u200b|\u2060|\ufeff/g;

/** The editable elements a locator finds: each match itself, or the editable inside it. */
function editablesFor(doc: Document, field: PageReadField): EditableTarget[] {
  const found: EditableTarget[] = [];
  for (const locator of field.locators) {
    for (const element of findByLocator(doc, locator)) {
      const editable =
        editableOf(element) ??
        editableOf(element.querySelector('textarea, input, [contenteditable]'));
      if (editable !== undefined) found.push(editable);
    }
  }
  return found;
}

/**
 * The text a user typed into `target`: a control's value, or a rich editor's rendered text, where
 * `innerText` keeps the line breaks that paragraph elements stand for and `textContent` loses
 * them. Zero-width placeholders and non-breaking spaces editors use for plain spaces are cleaned,
 * and the ends trimmed.
 */
export function fieldText(target: EditableTarget): string {
  let raw: string;
  if (isTextControl(target)) raw = target.value;
  else {
    // biome-ignore lint/performance/useDomNodeTextContent: the rendered line breaks are the point.
    const rendered = target.innerText;
    raw = typeof rendered === 'string' ? rendered : (target.textContent ?? '');
  }
  return raw
    .replace(ZERO_WIDTH, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * The field to save: the focused editable element when one of the definition's fields finds it,
 * else, with nothing editable focused, the first field whose locators find one. A focused field
 * no locator finds (a search box, a direct message) is refused rather than guessed at.
 */
export function readField(doc: Document, request: PageReadRequest): PageReadResult {
  const focused = focusedEditable(doc);
  if (focused !== undefined) {
    const field = request.fields.find((f) => editablesFor(doc, f).includes(focused));
    if (field === undefined) return { state: 'no_field' };
    return { state: 'read', field: field.name, value: fieldText(focused) };
  }
  for (const field of request.fields) {
    const [target] = editablesFor(doc, field);
    if (target !== undefined) return { state: 'read', field: field.name, value: fieldText(target) };
  }
  return { state: 'no_target' };
}
