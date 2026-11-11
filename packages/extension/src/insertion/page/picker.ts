/**
 * The keyboard picker (spec 11.5): a small list of drafts anchored at the focused field, opened
 * by the extension's shortcut. Type to filter, arrow keys to choose, Enter to insert, a digit 1 to
 * 9 to insert that row while the filter is empty, Tab to show or hide the drafts for other sites
 * when the page has drafts of its own, Escape to close. When nothing matches the page, the other
 * drafts list under their heading with no toggle (critique P1, P2).
 *
 * It lives in a closed shadow root on a plain `<div>` with no qus.me id, class or attribute, so
 * the page's scripts can neither find it by name nor reach into it, and its styles sit entirely
 * inside the root. The host's own box is pinned with inline `!important` declarations, which
 * outrank any page rule that matches a `<div>`. Every string is set with `textContent`. Key and
 * input events stop at the shadow root, so a page's single-key shortcuts don't fire while the
 * user types a filter. Only trusted events act. Closing removes the host and every listener the
 * picker added; nothing stays behind.
 */
import { countText, metaText, type RowSegment, rowSegments } from '../../drafts/rowFormat.ts';
import type { PickerItem, PickerView } from '../protocol.ts';
import { MONO, pageScheme, SANS, SERIF, schemeRules } from './scheme.ts';
import { type EditableTarget, isTextControl } from './target.ts';

export type PickerCloseReason = 'pick' | 'escape' | 'blur' | 'navigation' | 'replaced';

export interface PickerCallbacks {
  /** The user chose `d`. The picker has already been removed. */
  onPick(d: string): void;
  /** The picker closed without a pick. It has already been removed. */
  onClose(reason: Exclude<PickerCloseReason, 'pick'>): void;
  /** Asks the extension to open its popup; false when the browser refused. */
  onOpenPopup(): Promise<boolean>;
}

export interface PickerHandle {
  /** The element in the page's DOM; its shadow root is closed. */
  readonly host: HTMLElement;
  /** The closed shadow root, reachable only through this handle (for tests). */
  readonly root: ShadowRoot;
  close(reason: Exclude<PickerCloseReason, 'pick'>): void;
}

const WIDTH = 460;
const GAP = 6;
const MARGIN = 8;

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
${schemeRules('.p')}
.p {
  position: fixed; box-sizing: border-box; width: ${WIDTH}px; max-width: calc(100vw - ${2 * MARGIN}px);
  max-height: min(420px, calc(100vh - ${2 * MARGIN}px)); display: flex; flex-direction: column;
  overflow: hidden; background: var(--surface); color: var(--fg); border: 1px solid var(--edge);
  border-radius: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 18px 44px -10px var(--shadow);
  font: 14px/1.45 ${SANS};
  text-align: left; direction: ltr; letter-spacing: normal; text-transform: none;
}
.p *, .p *::before, .p *::after { box-sizing: border-box; }
.h { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.b { flex: none; display: flex; align-items: center; gap: 7px; color: var(--fg);
  font: 500 17px/1 ${SERIF}; }
.q { width: 22px; height: 22px; border-radius: 5px; background: #1f5f4a; color: #ffffff;
  display: flex; align-items: center; justify-content: center; font: 500 17px/1 ${SERIF}; padding-bottom: 3px; }
.f { flex: 1; min-width: 0; min-height: 40px; border: 0; outline: none; background: transparent; color: inherit;
  font: inherit; font-size: 15px; padding: 0 4px; margin: 0; }
.f::placeholder { color: var(--muted); opacity: 1; }
.c { flex: none; max-width: 45%; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.m { margin: 0; padding: 12px 14px 4px; color: var(--fg); }
.l { list-style: none; margin: 0; padding: 6px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.g { display: flex; align-items: baseline; gap: 8px; padding: 10px 10px 2px; font-size: 11px; font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.g.t2 { cursor: pointer; }
.g .r { margin-left: auto; font-weight: 400; letter-spacing: normal; text-transform: none; font-size: 12px; }
.o { padding: 9px 10px; border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.o[aria-selected="true"] { background: var(--tint); }
.t { white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3;
  -webkit-box-orient: vertical; overflow: hidden; }
.o .s { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 12px; color: var(--muted); }
.o .s > span { flex: none; white-space: nowrap; }
.o .s .d { flex: none; min-width: 16px; padding: 0 3px; border: 1px solid var(--edge); border-radius: 4px; text-align: center;
  font: 11px/15px ${MONO}; color: var(--fg); background: var(--surface); }
.o .s .w { color: var(--fg); font-weight: 500; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
.o .s .e { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.o .s .n { margin-left: auto; flex: none; font-variant-numeric: tabular-nums; }
.o .s .n.x { color: var(--danger); font-weight: 600; }
.o[aria-selected="true"] .s, .o[aria-selected="true"] .s .w { color: var(--accent); }
.a { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 14px 12px; }
.btn { all: unset; box-sizing: border-box; min-height: 34px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--edge);
  background: var(--surface); font: 500 13px/1 ${SANS}; cursor: pointer; display: inline-flex; align-items: center;
  color: var(--fg); }
.btn:hover { border-color: var(--fg); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.k { display: flex; flex-wrap: wrap; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--line); background: var(--band);
  font-size: 12px; color: var(--muted); }
kbd { font: 11px ${MONO}; border: 1px solid var(--edge); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px;
  background: var(--surface); color: var(--fg); }
[hidden] { display: none !important; }
`;

/** The popup's segment classes (ui/draftRow.tsx) in the picker's short names. */
const SEGMENT_CLASS: Record<RowSegment['key'], string | undefined> = {
  who: 'w',
  destination: 'e',
  field: undefined,
  when: undefined,
};

/** The caret's box in a contenteditable target, else the target's box. */
function anchorRect(target: EditableTarget): DOMRect {
  const doc = target.ownerDocument;
  if (!isTextControl(target)) {
    const selection = doc.defaultView?.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (target.contains(range.startContainer)) {
        const rect = range.getBoundingClientRect?.();
        if (rect && (rect.width > 0 || rect.height > 0)) return rect;
      }
    }
  }
  return target.getBoundingClientRect();
}

const matches = (item: PickerItem, words: string[]): boolean => {
  const hay = `${item.text}\n${metaText(item.meta)}`.toLocaleLowerCase();
  return words.every((w) => hay.includes(w));
};

/** Mounts the picker on `doc` for `view`, at `anchor` or the top of the viewport. */
export function mountPicker(
  doc: Document,
  view: PickerView,
  anchor: EditableTarget | undefined,
  callbacks: PickerCallbacks
): PickerHandle {
  const win = doc.defaultView as Window;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls !== undefined) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const host = doc.createElement('div');
  host.setAttribute('style', HOST_STYLE);
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = STYLE;

  // The page's own scheme where it can be read, so a dark site gets a dark picker (scheme.ts).
  const scheme = pageScheme(doc);
  const panel = el('div', scheme === undefined ? 'p' : `p ${scheme}`);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'qus.me drafts');

  const head = el('div', 'h');
  const badge = el('span', 'b');
  const mark = el('span', 'q', 'q');
  mark.setAttribute('aria-hidden', 'true');
  badge.append(mark, doc.createTextNode('qus.me'));
  const filter = el('input', 'f');
  filter.type = 'text';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filter.placeholder = 'Type to filter drafts';
  filter.setAttribute('aria-label', 'Filter drafts');
  filter.setAttribute('role', 'combobox');
  filter.setAttribute('aria-controls', 'l');
  filter.setAttribute('aria-expanded', 'true');
  const context = el('span', 'c');
  head.append(badge, filter, context);

  const message = el('p', 'm');
  message.setAttribute('role', 'status');
  const list = el('ul', 'l');
  list.id = 'l';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Drafts');
  const actions = el('div', 'a');
  const openPopup = el('button', 'btn');
  openPopup.type = 'button';
  actions.append(openPopup);

  const keys = el('div', 'k');
  const keyHints = (hints: readonly (readonly [string, string])[]) => {
    keys.replaceChildren();
    for (const [k, label] of hints) {
      const span = el('span');
      span.append(el('kbd', undefined, k), doc.createTextNode(` ${label}`));
      keys.append(span);
    }
  };

  panel.append(head, message, list, actions, keys);
  root.append(style, panel);

  // The other sites' drafts sit behind Tab only while the page has drafts of its own.
  const canToggle = view.state === 'ready' && view.here.length > 0 && view.others.length > 0;
  let showOthers = view.here.length === 0;
  let visible: PickerItem[] = [];
  let selected = 0;
  let closed = false;

  const toggleOthers = () => {
    showOthers = !showOthers;
    if (!showOthers && selected >= view.here.length) selected = 0;
    render();
    position();
  };

  const render = () => {
    const words = filter.value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const here = view.here.filter((i) => matches(i, words));
    const others = showOthers ? view.others.filter((i) => matches(i, words)) : [];
    visible = [...here, ...others];
    // Digits pick only while the filter is empty, so they label rows only then.
    const digits = words.length === 0 && filter.value === '';
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);

    list.replaceChildren();
    const option = (item: PickerItem, index: number) => {
      const li = el('li', 'o');
      li.id = `o${index}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(index === selected));
      li.dataset.i = String(index);
      // The popup's row meta (ui/draftRow.tsx), from the same segments: who, where, when, count.
      const meta = el('span', 's');
      if (digits && index < 9) {
        const digit = el('span', 'd', String(index + 1));
        digit.setAttribute('aria-hidden', 'true');
        meta.append(digit);
      }
      rowSegments(item.meta).forEach((segment, i) => {
        if (i > 0) meta.append(doc.createTextNode('·'));
        meta.append(el('span', SEGMENT_CLASS[segment.key], segment.text));
      });
      if (item.meta.count !== undefined) {
        meta.append(el('span', item.meta.count.over ? 'n x' : 'n', countText(item.meta.count)));
      }
      li.append(el('span', 't', item.text), meta);
      return li;
    };
    here.forEach((item, i) => {
      list.append(option(item, i));
    });
    if (view.state === 'ready' && (others.length > 0 || (canToggle && !showOthers))) {
      // The group's heading; while the page has drafts of its own it also says how to toggle it,
      // and a click on it does the same for the mouse.
      const label = el('li', canToggle ? 'g t2' : 'g');
      label.setAttribute('role', 'presentation');
      label.append(
        doc.createTextNode(showOthers ? 'Other sites' : `Other sites (${view.others.length})`)
      );
      if (canToggle) {
        const hint = el('span', 'r');
        hint.append(
          el('kbd', undefined, 'Tab'),
          doc.createTextNode(showOthers ? ' to hide' : ' to show')
        );
        label.append(hint);
        label.dataset.toggle = '';
      }
      list.append(label);
      others.forEach((item, i) => {
        list.append(option(item, here.length + i));
      });
    }
    if (visible.length > 0) filter.setAttribute('aria-activedescendant', `o${selected}`);
    else filter.removeAttribute('aria-activedescendant');
    root.getElementById?.(`o${selected}`)?.scrollIntoView?.({ block: 'nearest' });

    const total = view.here.length + (showOthers ? view.others.length : 0);
    list.hidden = list.childElementCount === 0;
    context.textContent =
      words.length > 0
        ? `${view.context ? `${view.context} · ` : ''}${visible.length} of ${total}`
        : view.context;

    let text = '';
    if (view.state === 'locked') text = 'Your qus.me queue is locked.';
    else if (view.state === 'setup') text = "qus.me isn't set up in this browser yet.";
    else if (visible.length === 0 && words.length > 0) text = 'No drafts match.';
    else if (view.here.length === 0) text = 'No drafts for this page.';
    message.textContent = text;
    message.hidden = text === '';

    openPopup.hidden = !(view.state !== 'ready' || view.here.length === 0);
    openPopup.textContent = view.state === 'locked' ? 'Open qus.me to unlock' : 'Open qus.me';
    actions.hidden = openPopup.hidden;

    const hints: [string, string][] = [];
    if (view.state === 'ready' && visible.length > 0) {
      hints.push(['Enter', 'insert'], ['↑ ↓', 'choose']);
      if (digits)
        hints.push([visible.length > 1 ? `1–${Math.min(9, visible.length)}` : '1', 'pick']);
    }
    if (canToggle) hints.push(['Tab', showOthers ? 'hide other sites' : 'other sites']);
    hints.push(['Esc', 'close']);
    keyHints(hints);
  };

  const select = (index: number) => {
    if (visible.length === 0) return;
    selected = (index + visible.length) % visible.length;
    render();
  };

  // Every listener the picker adds, so close() can take each one off again.
  const added: [EventTarget, string, EventListener, boolean][] = [];
  const listen = (target: EventTarget, type: string, fn: EventListener, capture = false) => {
    target.addEventListener(type, fn, capture);
    added.push([target, type, fn, capture]);
  };

  const remove = () => {
    closed = true;
    for (const [target, type, fn, capture] of added) target.removeEventListener(type, fn, capture);
    added.length = 0;
    host.remove();
  };

  const close = (reason: Exclude<PickerCloseReason, 'pick'>) => {
    if (closed) return;
    remove();
    callbacks.onClose(reason);
  };

  function pick(index: number) {
    const item = visible[index];
    if (closed || item === undefined) return;
    remove();
    callbacks.onPick(item.d);
  }

  const position = () => {
    if (closed) return;
    const vw = win.innerWidth || doc.documentElement.clientWidth;
    const vh = win.innerHeight || doc.documentElement.clientHeight;
    const width = Math.min(WIDTH, vw - 2 * MARGIN);
    const height = panel.offsetHeight || 0;
    let left = (vw - width) / 2;
    let top = MARGIN * 6;
    if (anchor?.isConnected) {
      const rect = anchorRect(anchor);
      left = rect.left;
      top = rect.bottom + GAP;
      if (top + height > vh - MARGIN && rect.top - GAP - height >= MARGIN) {
        top = rect.top - GAP - height;
      }
    }
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };

  // Keys and text input stay inside: the page sees no keystroke typed into the filter.
  const contain: EventListener = (event) => event.stopPropagation();
  for (const type of [
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'paste',
    'copy',
    'cut',
  ]) {
    listen(root, type, contain);
  }

  listen(root, 'keydown', (event) => {
    const key = event as KeyboardEvent;
    if (!key.isTrusted || closed) return;
    const fromFilter = key.composedPath()[0] === filter;
    if (key.key === 'Escape') {
      key.preventDefault();
      close('escape');
    } else if (key.key === 'ArrowDown' && view.state === 'ready') {
      key.preventDefault();
      select(selected + 1);
    } else if (key.key === 'ArrowUp' && view.state === 'ready') {
      key.preventDefault();
      select(selected - 1);
    } else if (key.key === 'Enter' && fromFilter && !key.isComposing && view.state === 'ready') {
      key.preventDefault();
      pick(selected);
    } else if (
      key.key === 'Tab' &&
      fromFilter &&
      !key.isComposing &&
      !key.altKey &&
      !key.ctrlKey &&
      !key.metaKey &&
      canToggle
    ) {
      key.preventDefault();
      toggleOthers();
    } else if (
      /^[1-9]$/.test(key.key) &&
      fromFilter &&
      !key.isComposing &&
      !key.altKey &&
      !key.ctrlKey &&
      !key.metaKey &&
      view.state === 'ready' &&
      filter.value === ''
    ) {
      // A digit alone is never a useful filter, so on an empty filter it picks that row (P2).
      const index = Number(key.key) - 1;
      if (index < visible.length) {
        key.preventDefault();
        pick(index);
      }
    }
  });
  listen(list, 'click', (event) => {
    if (!event.isTrusted) return;
    if ((event.target as Element | null)?.closest?.('[data-toggle]')) {
      toggleOthers();
      filter.focus();
      return;
    }
    const option = (event.target as Element | null)?.closest?.('[role="option"]');
    const index = Number((option as HTMLElement | null | undefined)?.dataset.i);
    if (Number.isInteger(index)) pick(index);
  });
  listen(filter, 'input', (event) => {
    if (!event.isTrusted) return;
    selected = 0;
    render();
  });
  listen(openPopup, 'click', (event) => {
    if (!event.isTrusted) return;
    void callbacks.onOpenPopup().then((opened) => {
      if (!opened && !closed) {
        message.textContent = 'Click the qus.me button in the browser toolbar.';
        message.hidden = false;
      }
    });
  });
  // A click on the panel's chrome keeps focus in the filter, so it doesn't count as leaving.
  listen(panel, 'mousedown', (event) => {
    const target = event.composedPath()[0];
    if (target !== filter) event.preventDefault();
  });
  listen(root, 'focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next !== null && root.contains(next)) return;
    close('blur');
  });
  listen(win, 'blur', () => close('blur'));
  for (const type of ['pagehide', 'popstate', 'hashchange']) {
    listen(win, type, () => close('navigation'));
  }
  listen(win, 'resize', position);
  listen(doc, 'scroll', position, true);

  render();
  doc.documentElement.append(host);
  position();
  if (view.state === 'ready') filter.focus();
  else {
    filter.hidden = true;
    openPopup.focus();
  }

  return { host, root, close };
}
