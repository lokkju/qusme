/**
 * What crosses between the extension and the insertion script it injects into the page (spec
 * 11.5, 11.6). Only the armed draft's value ever goes to the page, and only in
 * {@link PageInsertRequest}; account detection sends the account locator and nothing else.
 */
import type { InjectionStrategy, Locator, SiteAccount } from '@qusme/nostr';

/** How the user asked for the insertion; recorded as the `inserted` tag's method (7.1). */
export const INSERT_METHODS = ['extension_popup', 'extension_context_menu'] as const;
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
}

/** The isolated-world global the page script installs {@link PageApi} on. */
export const PAGE_API_GLOBAL = '__qusmeInsertion';

/** The bundled insertion script, as `scripting.executeScript` names it. */
export const PAGE_SCRIPT_FILE = '/qusme-page.js';
