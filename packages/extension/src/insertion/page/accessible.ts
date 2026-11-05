/**
 * ARIA roles and accessible names for locators (spec 10.1, 10.2), computed in the page. A
 * simplified accessible name computation: `aria-labelledby`, `aria-label`, associated labels,
 * name from content for the roles that take it, then `title` and `placeholder`. It covers how
 * composers and account buttons are labelled, not the whole of accname 1.2.
 */
import type { Locator } from '@qusme/nostr';

/** Collapses whitespace runs, NBSP included, to one space and trims. */
export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url']);

/** Roles whose accessible name comes from their content when nothing else names them. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/** The element's role: the first token of `role`, else the implicit role of its tag. */
export function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  const tag = element.localName;
  if (tag === 'textarea') return 'textbox';
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if (TEXT_INPUT_TYPES.has(type)) return 'textbox';
    if (type === 'search') return 'searchbox';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
      return 'button';
    }
    if (type === 'checkbox' || type === 'radio') return type;
  }
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return undefined;
}

/** Text of a subtree for a name, skipping `aria-hidden` and hidden descendants. */
function contentText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) return '';
  const label = element.getAttribute('aria-label');
  if (label !== null && collapse(label) !== '') return ` ${label} `;
  let text = '';
  for (const child of element.childNodes) text += contentText(child);
  const display = element.localName;
  return /^(div|p|li|br|h[1-6]|section|article)$/.test(display) ? ` ${text} ` : text;
}

function labelsOf(element: Element): string {
  const labels = (element as HTMLInputElement).labels;
  if (labels === undefined || labels === null) return '';
  return [...labels].map((l) => collapse(contentText(l))).join(' ');
}

/** The element's accessible name, whitespace collapsed. */
export function accessibleName(element: Element): string {
  const doc = element.ownerDocument;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((e): e is HTMLElement => e !== null)
      .map((e) => collapse(contentText(e)))
      .join(' ');
    if (collapse(text) !== '') return collapse(text);
  }
  const label = element.getAttribute('aria-label');
  if (label !== null && collapse(label) !== '') return collapse(label);
  const tag = element.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const fromLabels = labelsOf(element);
    if (fromLabels !== '') return collapse(fromLabels);
  }
  const role = roleOf(element);
  if (role !== undefined && NAME_FROM_CONTENT.has(role)) {
    const text = collapse(contentText(element));
    if (text !== '') return text;
  }
  const title = element.getAttribute('title');
  if (title !== null && collapse(title) !== '') return collapse(title);
  const placeholder =
    element.getAttribute('placeholder') ?? element.getAttribute('aria-placeholder');
  return placeholder === null ? '' : collapse(placeholder);
}

/**
 * The names a locator accepts on a page in `lang` (`document.documentElement.lang`): the names
 * for the exact tag, else for its primary subtag, else `en` (10.1). Tags compare case-blind.
 */
export function namesFor(locator: Locator, lang: string): string[] {
  const keys = Object.keys(locator.name);
  const find = (tag: string) => keys.find((k) => k.toLowerCase() === tag.toLowerCase());
  const wanted = lang.trim();
  const exact = wanted === '' ? undefined : find(wanted);
  const primary = wanted === '' ? undefined : find(wanted.split('-')[0] as string);
  const key = exact ?? primary ?? 'en';
  return locator.name[key] ?? locator.name.en ?? [];
}

/** True when nothing hides the element: no `hidden`, `aria-hidden`, `inert`, or display none. */
export function isShown(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let e: Element | null = element; e !== null; e = e.parentElement) {
    if (e.hasAttribute('hidden') || e.hasAttribute('inert')) return false;
    if (e.getAttribute('aria-hidden') === 'true') return false;
    const style = view?.getComputedStyle(e);
    if (style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) {
      return false;
    }
  }
  return true;
}

const IMPLICIT_SELECTORS: Record<string, string> = {
  textbox:
    'textarea, input:not([type]), input[type=""], input[type=text], input[type=email], input[type=tel], input[type=url]',
  searchbox: 'input[type=search]',
  button: 'button, input[type=button], input[type=submit], input[type=reset], input[type=image]',
  link: 'a[href]',
  heading: 'h1, h2, h3, h4, h5, h6',
};

/**
 * Shown elements whose role is the locator's and whose accessible name is one of the names for
 * the page's language, in document order. Names compare with whitespace collapsed.
 */
export function findByLocator(doc: Document, locator: Locator): Element[] {
  const lang = doc.documentElement.getAttribute('lang') ?? '';
  const names = new Set(namesFor(locator, lang).map(collapse));
  const role = locator.role.toLowerCase();
  const implicit = IMPLICIT_SELECTORS[role];
  const selector = implicit === undefined ? '[role]' : `[role], ${implicit}`;
  const found: Element[] = [];
  for (const element of doc.querySelectorAll(selector)) {
    if (roleOf(element) !== role) continue;
    if (!names.has(accessibleName(element))) continue;
    if (isShown(element)) found.push(element);
  }
  return found;
}
