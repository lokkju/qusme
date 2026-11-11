/**
 * ARIA roles and accessible names for locators (spec 10.1, 10.2), computed in the page. A
 * simplified accessible name computation: `aria-labelledby`, `aria-label`, associated labels,
 * name from content for the roles that take it, then `title` and `placeholder`. It covers how
 * composers and account buttons are labelled, not the whole of accname 1.2. Locators search the
 * light DOM first and, only when it has no match, open shadow roots within fixed limits.
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
  if (tag === 'nav') return 'navigation';
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
  // IDs are scoped to the tree the element is in: its shadow root, or the document.
  const root = element.getRootNode() as Document | ShadowRoot;
  const scope = typeof root.getElementById === 'function' ? root : element.ownerDocument;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => scope.getElementById(id))
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

/** The parent element, or the shadow host when `element` is at the top of a shadow root. */
function parentOrHost(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement;
  const parent = element.parentNode;
  return parent !== null && parent.nodeType === 11 ? ((parent as ShadowRoot).host ?? null) : null;
}

/**
 * True when nothing hides the element: no `hidden`, `aria-hidden`, `inert`, or display none,
 * on it or an ancestor, shadow hosts included.
 */
export function isShown(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let e: Element | null = element; e !== null; e = parentOrHost(e)) {
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
  navigation: 'nav',
};

/** At most this many `[data-placeholder]` descendants are read per candidate element. */
const MAX_PLACEHOLDER_DESCENDANTS = 16;

/**
 * Placeholder texts of an element, whitespace collapsed: its own `placeholder`,
 * `aria-placeholder` and `data-placeholder`, then the `data-placeholder` of descendants
 * (TipTap and ProseMirror editors put the prompt on the empty paragraph inside the editor). Only
 * the candidate's own subtree is read, so text elsewhere on the page never matches.
 */
export function placeholdersOf(element: Element): string[] {
  const texts: string[] = [];
  for (const attribute of ['placeholder', 'aria-placeholder', 'data-placeholder']) {
    const value = element.getAttribute(attribute);
    if (value !== null && collapse(value) !== '') texts.push(collapse(value));
  }
  const inside = element.querySelectorAll('[data-placeholder]');
  for (let i = 0; i < inside.length && i < MAX_PLACEHOLDER_DESCENDANTS; i++) {
    const value = inside[i]?.getAttribute('data-placeholder');
    if (value !== null && value !== undefined && collapse(value) !== '') {
      texts.push(collapse(value));
    }
  }
  return texts;
}

/** How deep shadow roots nest before the search stops descending. */
export const MAX_SHADOW_DEPTH = 4;
/** The most open shadow roots one search reads. */
export const MAX_SHADOW_ROOTS = 64;
/** The most elements one search walks looking for shadow hosts, across every tree. */
export const MAX_SHADOW_SCAN = 20_000;

/**
 * Open shadow roots under `root`, breadth first: those of the document's elements, then roots
 * nested in those, down to {@link MAX_SHADOW_DEPTH} levels. Stops at {@link MAX_SHADOW_ROOTS}
 * roots or after walking {@link MAX_SHADOW_SCAN} elements, so a large page costs a bounded walk.
 * Closed roots are not reachable and are not searched.
 */
export function openShadowRoots(root: Document): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  let scanned = 0;
  let level: (Document | ShadowRoot)[] = [root];
  for (let depth = 1; depth <= MAX_SHADOW_DEPTH && level.length > 0; depth++) {
    const next: ShadowRoot[] = [];
    for (const tree of level) {
      const walker = root.createTreeWalker(tree, 1);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (++scanned > MAX_SHADOW_SCAN) return found;
        const shadow = (node as Element).shadowRoot;
        if (shadow === null || shadow === undefined) continue;
        found.push(shadow);
        next.push(shadow);
        if (found.length >= MAX_SHADOW_ROOTS) return found;
      }
    }
    level = next;
  }
  return found;
}

/** Matches of a locator in one tree (the document or a shadow root), in tree order. */
function findIn(tree: Document | ShadowRoot, locator: Locator, names: Set<string>): Element[] {
  const role = locator.role.toLowerCase();
  const implicit = IMPLICIT_SELECTORS[role];
  const selector = implicit === undefined ? '[role]' : `[role], ${implicit}`;
  const found: Element[] = [];
  for (const element of tree.querySelectorAll(selector)) {
    if (roleOf(element) !== role) continue;
    const matches =
      locator.by === 'placeholder'
        ? placeholdersOf(element).some((text) => names.has(text))
        : names.has(accessibleName(element));
    if (matches && isShown(element)) found.push(element);
  }
  return found;
}

/**
 * Shown elements whose role is the locator's and whose accessible name (or, for `by:
 * "placeholder"`, placeholder text) is one of the names for the page's language. Names compare
 * with whitespace collapsed. The light DOM's matches come in document order; only when it has none
 * are open shadow roots searched ({@link openShadowRoots}), and their matches returned.
 */
export function findByLocator(doc: Document, locator: Locator): Element[] {
  const lang = doc.documentElement.getAttribute('lang') ?? '';
  const names = new Set(namesFor(locator, lang).map(collapse));
  const light = findIn(doc, locator, names);
  if (light.length > 0) return light;
  return openShadowRoots(doc).flatMap((root) => findIn(root, locator, names));
}
