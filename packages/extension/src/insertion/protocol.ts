/**
 * What crosses between the extension and the insertion script it injects into the page (spec
 * 11.5, 11.6). Only the armed draft's value ever goes to the page, and only in
 * {@link PageInsertRequest}; account detection sends the account locator and nothing else.
 */
import type { InjectionStrategy, Locator, SiteAccount } from '@qusme/nostr';
import type { RowData } from '../drafts/rowFormat.ts';

/** How the user asked for the insertion; recorded as the `inserted` tag's method (7.1). */
export const INSERT_METHODS = [
  'extension_popup',
  'extension_context_menu',
  'extension_shortcut',
] as const;
export type InsertMethod = (typeof INSERT_METHODS)[number];

/** How the target was found (10.2): the focused element, a field locator, or the user's click. */
export type Resolution = 'focused' | 'locator' | 'focus_placement';

export interface PageField {
  locators: Locator[];
  inject: InjectionStrategy[];
}

export interface PageInsertRequest {
  /** Names this insertion in the result message a waiting script sends later. */
  token: string;
  /** The armed draft's value: the only draft text that enters the page. */
  value: string;
  /** The field from the effective definition; absent when the destination has none. */
  field?: PageField;
  /** The effective definition's account locator, for the `inserted` tag's detected account. */
  account?: SiteAccount;
  method: InsertMethod;
  /**
   * True when the caller can write the clipboard itself if the page cannot (the popup, which has
   * the user's click). Without it, a page that cannot write the clipboard gives up.
   */
  clipboardFallback: boolean;
  /** How long to wait for the user's click or paste, in milliseconds. */
  waitMs?: number;
}

export type PageFailure =
  /** The field changed but does not hold the draft, so trying another strategy could double it. */
  | 'partial'
  /** Every strategy in the chain ran and the field did not take the draft. */
  | 'exhausted'
  /** Nobody clicked into a field, or pasted, before the wait ran out. */
  | 'timeout'
  /** Neither the page nor the caller could write the clipboard. */
  | 'clipboard_denied'
  /** A newer insertion in the same tab replaced this one while it waited. */
  | 'superseded'
  /** The user closed the notice that asked them to click or paste. */
  | 'cancelled'
  /** The draft is empty or only whitespace. */
  | 'empty';

export interface PageInserted {
  state: 'inserted';
  strategy: InjectionStrategy;
  resolution: Resolution;
  /** The target's accessible name, as computed for locators. */
  accessibleName: string;
  /** The account the page shows, or the empty string. */
  detectedAccount: string;
  /** The frame's URL at the moment of insertion. */
  url: string;
}

export interface PageFailed {
  state: 'failed';
  reason: PageFailure;
  /** The strategies that ran, in order. */
  tried: InjectionStrategy[];
}

export interface PageWaiting {
  state: 'waiting';
  /** `focus`: asked the user to click into the field. `paste`: asked them to press Ctrl/Cmd+V. */
  reason: 'focus' | 'paste';
  /** For `paste`: whether the page put the value on the clipboard. */
  clipboardWritten?: boolean;
}

/** What `insert` returns at once. A waiting script sends a {@link PageDone} later. */
export type PageOutcome = PageInserted | PageFailed | PageWaiting;

/** The final outcome of an insertion that waited, sent by the page with `runtime.sendMessage`. */
export const PAGE_DONE_MESSAGE = 'qusme.insertion.done';
export interface PageDone {
  type: typeof PAGE_DONE_MESSAGE;
  token: string;
  outcome: PageInserted | PageFailed;
}

export interface PageAccountResult {
  /** The account the page shows, or undefined when the locator or extraction found nothing. */
  account?: string;
}

/** The functions the injected script installs on its isolated world's global. */
export interface PageApi {
  detectAccount(account: SiteAccount): PageAccountResult;
  insert(request: PageInsertRequest): Promise<PageOutcome>;
  /** Opens the keyboard picker at the focused (or last-focused) field, replacing any open one. */
  openPicker(view: PickerView): PickerOpened;
}

/** The isolated-world global the page script installs {@link PageApi} on. */
export const PAGE_API_GLOBAL = '__qusmeInsertion';

/** The bundled insertion script, as `scripting.executeScript` names it. */
export const PAGE_SCRIPT_FILE = '/qusme-page.js';

/**
 * One draft in the keyboard picker. The picker renders it inside a closed shadow root in the
 * extension's isolated world, so the page's scripts can't read it; the full value still crosses
 * only for the draft the user inserts, in {@link PageInsertRequest}.
 */
export interface PickerItem extends RowData {
  /** The draft's text, cut to {@link PICKER_TEXT_CHARS} code points, for display and filtering. */
  text: string;
}

/** How much of each draft the picker shows. */
export const PICKER_TEXT_CHARS = 280;

export interface PickerView {
  /** Names this picker in the pick message, so a stale picker can't insert. */
  token: string;
  /** `ready`: drafts listed. `locked`: the queue is locked. `setup`: no queue on this device. */
  state: 'ready' | 'locked' | 'setup';
  /** Drafts whose destination matches the page, after the account filter. */
  here: PickerItem[];
  /** Every other active draft, behind a toggle. */
  others: PickerItem[];
  /** The detected accounts, as "@lokkju" (the page says which site). */
  context: string;
}

export interface PickerOpened {
  /** Whether the picker anchored at an editable field (else at the top of the viewport). */
  anchored: boolean;
}

/** The page script's picker asks the background to insert the chosen draft. */
export const PICKER_PICK_MESSAGE = 'qusme.picker.pick';
export interface PickerPickMessage {
  type: typeof PICKER_PICK_MESSAGE;
  token: string;
  d: string;
}

/**
 * The page script's success notice asks the background to undo a picked insertion: restore the
 * draft to `active` (7.1). `token` is the one-time token the pick's answer carried (`undo`), good
 * for that draft in that tab only and for {@link PICKER_UNDO_SECONDS}.
 */
export const PICKER_UNDO_MESSAGE = 'qusme.picker.undo';
export interface PickerUndoMessage {
  type: typeof PICKER_UNDO_MESSAGE;
  token: string;
}

/** How long a pick's Undo stays good in the background; the notice shows for less. */
export const PICKER_UNDO_SECONDS = 60;

/** The page script's picker asks the background to open the popup (to unlock, say). */
export const PICKER_POPUP_MESSAGE = 'qusme.picker.popup';
