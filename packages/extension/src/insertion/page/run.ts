/**
 * The insertion script's two jobs in the page (spec 11.5): detect the signed-in account from the
 * site's account locator, and insert the armed draft. Insertion resolves the target (10.2), runs
 * the field's injection chain (11.6) and judges each strategy by reading the target back. When it
 * needs the user (a click into the field, or a paste for `clipboard`) it answers `waiting` at once
 * and sends the final outcome later through {@link PageEnv.notify}.
 */
import type { InjectionStrategy, SiteAccount } from '@qusme/nostr';
import type {
  PageAccountResult,
  PageApi,
  PageDone,
  PageFailed,
  PageFailure,
  PageInserted,
  PageInsertRequest,
  PageOutcome,
  PickerOpened,
  PickerView,
  Resolution,
} from '../protocol.ts';
import { PAGE_DONE_MESSAGE } from '../protocol.ts';
import { accessibleName, collapse, findByLocator } from './accessible.ts';
import { mountPicker, type PickerHandle } from './picker.ts';
import { type Prompt, showPrompt } from './prompt.ts';
import { IMMEDIATE_STRATEGIES, placeCaretAtEnd } from './strategies.ts';
import {
  type EditableTarget,
  editableOf,
  focusedEditable,
  isTextControl,
  normalizeText,
  readBack,
  resolveTarget,
  verifyInserted,
} from './target.ts';

export interface PageEnv {
  document: Document;
  /** Sends the final outcome of an insertion that answered `waiting`. */
  notify(done: PageDone): void;
  /** Writes text to the clipboard; false when the page may not. */
  writeClipboard(text: string): Promise<boolean>;
  /** Shows a notice in the page; defaults to {@link showPrompt}. */
  prompt?(message: string, onClose?: () => void): Prompt;
  /** How long a strategy's effect may take to show, in milliseconds. Defaults to 400. */
  settleMs?: number;
  /** How often to read the target back while waiting, in milliseconds. Defaults to 25. */
  pollMs?: number;
  /**
   * Asks the extension to insert the draft the user chose in the picker; resolves with the
   * background's answer, which for an insertion that ran is reported by that insertion itself.
   */
  pick?(token: string, d: string): Promise<unknown>;
  /** Asks the extension to open its popup; false when the browser refused. */
  openPopup?(): Promise<boolean>;
  /** Mounts the picker; defaults to {@link mountPicker}. Tests use it to reach the closed root. */
  mountPicker?: typeof mountPicker;
}

/** How long to wait for the user's click or paste unless the request says otherwise. */
export const DEFAULT_WAIT_MS = 120_000;
/** How long a failure notice stays up. */
const FAILURE_NOTICE_MS = 8000;

const FAILURE_TEXT: Record<PageFailure, string> = {
  partial: "qus.me: the field changed but doesn't match the draft. Check the field before posting.",
  exhausted: "qus.me couldn't insert the draft into this field.",
  timeout: 'qus.me stopped waiting. Insert the draft again when you are ready.',
  clipboard_denied:
    "qus.me couldn't insert the draft or copy it. Open qus.me and press Insert to try again.",
  superseded: 'qus.me started a newer insertion.',
  cancelled: 'qus.me insertion cancelled.',
  empty: 'qus.me: this draft is empty.',
};

/**
 * Finds the account element by the definition's locator and applies `extract` to its text, then
 * its accessible name, `title` and `href`; the first capture group of the first match is the
 * account. Reads only.
 */
export function detectAccount(doc: Document, account: SiteAccount): PageAccountResult {
  let pattern: RegExp;
  try {
    pattern = new RegExp(account.extract);
  } catch {
    return {};
  }
  for (const element of findByLocator(doc, account.locator)) {
    const candidates = [
      collapse(element.textContent ?? ''),
      accessibleName(element),
      element.getAttribute('title') ?? '',
      element.getAttribute('href') ?? '',
    ];
    for (const text of candidates) {
      const found = pattern.exec(text)?.[1];
      if (found) return { account: found };
    }
  }
  return {};
}

/**
 * The chain for a target when the destination has no definition: by what kind of element it is.
 * `insertText` goes first on both, because `execCommand` makes the browser fire trusted
 * `beforeinput` and `input` events, while `paste` and `native` dispatch events with `isTrusted`
 * false, which a page can detect and ignore (spec 11.6). A site definition orders its own chain.
 */
export function defaultChain(target: EditableTarget): InjectionStrategy[] {
  return isTextControl(target)
    ? ['insertText', 'native', 'clipboard']
    : ['insertText', 'paste', 'clipboard'];
}

const shortcut = (doc: Document): string =>
  /Mac|iPhone|iPad/.test(doc.defaultView?.navigator.userAgent ?? '') ? '⌘V' : 'Ctrl+V';

/** Creates the page API. One insertion waits at a time; a new one supersedes it. */
export function createPageApi(env: PageEnv): PageApi {
  const doc = env.document;
  const view = doc.defaultView as Window;
  const settleMs = env.settleMs ?? 400;
  const pollMs = env.pollMs ?? 25;
  const prompt =
    env.prompt ?? ((message: string, onClose?: () => void) => showPrompt(doc, message, onClose));
  let cancelWaiting: ((reason: PageFailure) => void) | undefined;

  const sleep = (ms: number) => new Promise<void>((resolve) => view.setTimeout(resolve, ms));

  /** Polls `check` until it passes or `ms` runs out. */
  const settle = async (check: () => boolean, ms: number): Promise<boolean> => {
    if (check()) return true;
    for (let waited = 0; waited < ms; waited += pollMs) {
      await sleep(pollMs);
      if (check()) return true;
    }
    return false;
  };

  const showFailure = (reason: PageFailure) => {
    const notice = prompt(FAILURE_TEXT[reason]);
    view.setTimeout(() => notice.remove(), FAILURE_NOTICE_MS);
  };

  const insert = async (request: PageInsertRequest): Promise<PageOutcome> => {
    const { value } = request;
    const waitMs = request.waitMs ?? DEFAULT_WAIT_MS;
    cancelWaiting?.('superseded');
    cancelWaiting = undefined;

    const failed = (reason: PageFailure, tried: InjectionStrategy[] = []): PageFailed => ({
      state: 'failed',
      reason,
      tried,
    });
    const inserted = (
      strategy: InjectionStrategy,
      resolution: Resolution,
      target: EditableTarget
    ): PageInserted => ({
      state: 'inserted',
      strategy,
      resolution,
      accessibleName: accessibleName(target),
      detectedAccount: request.account ? (detectAccount(doc, request.account).account ?? '') : '',
      url: doc.location?.href ?? '',
    });
    /** Ends an insertion that answered `waiting`: tells the extension and, on failure, the user. */
    const finish = (outcome: PageInserted | PageFailed) => {
      if (outcome.state === 'failed' && outcome.reason !== 'superseded')
        showFailure(outcome.reason);
      env.notify({ type: PAGE_DONE_MESSAGE, token: request.token, outcome });
    };

    if (normalizeText(value) === '') return failed('empty');

    /** Writes the clipboard, asks for Ctrl/Cmd+V, and waits for the value to show up. */
    const clipboard = async (
      target: EditableTarget,
      resolution: Resolution,
      tried: InjectionStrategy[]
    ): Promise<PageOutcome> => {
      const ran = [...tried, 'clipboard' as const];
      const written = await env.writeClipboard(value);
      if (!written && !request.clipboardFallback) {
        showFailure('clipboard_denied');
        return failed('clipboard_denied', ran);
      }
      // The user may paste into another field than the one resolved; each field is judged
      // against what it held when it took focus.
      const before = new Map<EditableTarget, string>([[target, readBack(target)]]);
      const onFocus = (event: Event) => {
        const editable = editableOf((event.composedPath()[0] as Element | undefined) ?? null);
        if (editable !== undefined && !before.has(editable))
          before.set(editable, readBack(editable));
      };
      doc.addEventListener('focusin', onFocus, true);
      target.focus();
      let done = false;
      let timer: number | undefined;
      let interval: number | undefined;
      const cleanup = () => {
        done = true;
        doc.removeEventListener('focusin', onFocus, true);
        doc.removeEventListener('input', check, true);
        doc.removeEventListener('paste', deferredCheck, true);
        if (timer !== undefined) view.clearTimeout(timer);
        if (interval !== undefined) view.clearInterval(interval);
        notice.remove();
        if (cancelWaiting === cancel) cancelWaiting = undefined;
      };
      const cancel = (reason: PageFailure) => {
        if (done) return;
        cleanup();
        finish(failed(reason, ran));
      };
      function check() {
        if (done) return;
        for (const [element, text] of before) {
          if (verifyInserted(text, readBack(element), value)) {
            cleanup();
            finish(
              inserted('clipboard', element === target ? resolution : 'focus_placement', element)
            );
            return;
          }
        }
      }
      function deferredCheck() {
        view.setTimeout(check, 0);
      }
      const notice = prompt(
        `qus.me copied the draft. Press ${shortcut(doc)} to paste it into the field.`,
        () => cancel('cancelled')
      );
      doc.addEventListener('input', check, true);
      doc.addEventListener('paste', deferredCheck, true);
      interval = view.setInterval(check, 250);
      timer = view.setTimeout(() => cancel('timeout'), waitMs);
      cancelWaiting = cancel;
      return { state: 'waiting', reason: 'paste', clipboardWritten: written };
    };

    /** Runs the chain on `target`, judging each strategy by reading the target back. */
    const runChain = async (
      target: EditableTarget,
      resolution: Resolution
    ): Promise<PageOutcome> => {
      const chain = request.field?.inject ?? defaultChain(target);
      const tried: InjectionStrategy[] = [];
      for (const strategy of chain) {
        if (strategy === 'clipboard') return clipboard(target, resolution, tried);
        const before = readBack(target);
        if (!IMMEDIATE_STRATEGIES[strategy](target, value)) continue;
        tried.push(strategy);
        if (await settle(() => verifyInserted(before, readBack(target), value), settleMs)) {
          return inserted(strategy, resolution, target);
        }
        // A field that changed without taking the draft could end up with it twice if the next
        // strategy also lands, so the chain stops here and the user checks the field.
        if (normalizeText(readBack(target)) !== normalizeText(before))
          return failed('partial', tried);
      }
      return failed('exhausted', tried);
    };

    const resolved = resolveTarget(doc, request.field?.locators);
    if (resolved.target !== undefined) {
      if (resolved.resolution === 'locator') placeCaretAtEnd(resolved.target);
      const outcome = await runChain(resolved.target, resolved.resolution);
      // The popup shows its own outcome; the context menu and the shortcut have only the page.
      if (outcome.state === 'failed' && request.method !== 'extension_popup') {
        showFailure(outcome.reason);
      }
      return outcome;
    }

    // Focus placement (10.2): ask the user to click into the field, then run the chain there.
    let done = false;
    const cleanup = () => {
      done = true;
      doc.removeEventListener('focusin', onFocus, true);
      view.clearTimeout(timer);
      notice.remove();
      if (cancelWaiting === cancel) cancelWaiting = undefined;
    };
    const cancel = (reason: PageFailure) => {
      if (done) return;
      cleanup();
      finish(failed(reason));
    };
    const onFocus = (event: Event) => {
      const target = editableOf((event.composedPath()[0] as Element | undefined) ?? null);
      if (target === undefined || done) return;
      cleanup();
      void runChain(target, 'focus_placement').then((outcome) => {
        // A clipboard step reports for itself when the paste lands.
        if (outcome.state !== 'waiting') finish(outcome);
      });
    };
    const notice = prompt('qus.me: click into the field where the draft should go.', () =>
      cancel('cancelled')
    );
    doc.addEventListener('focusin', onFocus, true);
    const timer = view.setTimeout(() => cancel('timeout'), waitMs);
    cancelWaiting = cancel;
    return { state: 'waiting', reason: 'focus' };
  };

  /** What a pick answered when no insertion ran to report for itself. */
  const PICK_TEXT: Record<string, string> = {
    locked: 'qus.me is locked. Open qus.me to unlock it, then press the shortcut again.',
    not_found: "qus.me: that draft isn't in the queue any more.",
    expired: 'qus.me: this list was out of date. Press the shortcut again.',
  };
  const reportPick = (response: unknown) => {
    const r = (typeof response === 'object' && response !== null ? response : {}) as {
      state?: unknown;
      reason?: unknown;
      message?: unknown;
    };
    let text: string | undefined;
    if (typeof r.state === 'string') text = PICK_TEXT[r.state];
    if (r.state === 'failed' && r.reason === 'injection')
      text = typeof r.message === 'string' ? r.message : FAILURE_TEXT.exhausted;
    if (text === undefined) return;
    const notice = prompt(text);
    view.setTimeout(() => notice.remove(), FAILURE_NOTICE_MS);
  };

  let picker: PickerHandle | undefined;
  // The field the last picker opened at, so pressing the shortcut again after the focus moved off
  // it (to the page, or to the picker itself) still finds it. Held weakly; no listener tracks it.
  let lastTarget: WeakRef<EditableTarget> | undefined;

  const openPicker = (pickerView: PickerView): PickerOpened => {
    picker?.close('replaced');
    picker = undefined;
    const remembered = lastTarget?.deref();
    const target =
      focusedEditable(doc) ?? (remembered?.isConnected === true ? remembered : undefined);
    lastTarget = target === undefined ? undefined : new WeakRef(target);
    const restore = saveSelection(target);
    const mount = env.mountPicker ?? mountPicker;
    const handle = mount(doc, pickerView, target, {
      onPick: (d) => {
        if (picker === handle) picker = undefined;
        // Back into the field, caret where it was, so the insertion resolves it as focused.
        restore();
        const sent = env.pick?.(pickerView.token, d);
        void sent?.then(reportPick, () => reportPick({ state: 'expired' }));
      },
      onClose: (reason) => {
        if (picker === handle) picker = undefined;
        if (reason === 'escape') restore();
      },
      onOpenPopup: () => env.openPopup?.() ?? Promise.resolve(false),
    });
    picker = handle;
    return { anchored: target !== undefined };
  };

  return { detectAccount: (account) => detectAccount(doc, account), insert, openPicker };
}

/**
 * Remembers the caret or selection in `target` and returns a function that focuses the target
 * and puts it back. A rich editor's selection is a DOM range; a control's is its offsets.
 */
function saveSelection(target: EditableTarget | undefined): () => void {
  if (target === undefined) return () => undefined;
  if (isTextControl(target)) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    return () => {
      if (!target.isConnected) return;
      target.focus();
      if (start === null || end === null) return;
      try {
        target.setSelectionRange(start, end);
      } catch {
        // No selection on this input type.
      }
    };
  }
  const selection = target.ownerDocument.defaultView?.getSelection();
  const range =
    selection && selection.rangeCount > 0 && target.contains(selection.getRangeAt(0).startContainer)
      ? selection.getRangeAt(0).cloneRange()
      : undefined;
  return () => {
    if (!target.isConnected) return;
    target.focus();
    if (range === undefined) return;
    const current = target.ownerDocument.defaultView?.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
  };
}
