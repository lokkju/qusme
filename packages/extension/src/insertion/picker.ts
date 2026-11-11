/**
 * The background's side of the keyboard picker (spec 11.5). The shortcut grants activeTab; the
 * background then runs the read-only account detection, builds the list the popup would show
 * (drafts for this page first, then the rest) and opens the picker in the page. When the user
 * chooses a draft there, the page sends {@link PICKER_PICK_MESSAGE} and the draft goes through
 * the same insertion as the popup's (strategies, read-back, `inserted` tag, republish), with the
 * method `extension_shortcut`.
 *
 * The list crosses into the page's isolated world and is rendered in a closed shadow root; the
 * full value crosses only for the draft inserted. Each picker carries a fresh token, kept in
 * `storage.session` with its tab, so only the latest picker in that tab can insert, and only a
 * draft it listed.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { displayAccount, type SiteAccount } from '@qusme/nostr';
import { rowData } from '../drafts/row.ts';
import type { KeyStore } from '../keyStore.ts';
import { SetupError } from '../setup/deps.ts';
import { readDraftCache } from '../sync/state.ts';
import { dismissPickerTip } from '../tips.ts';
import type { SiteDefinitionSource } from './definitions.ts';
import { accountLocators, draftsForPage, type PageDraft } from './matching.ts';
import {
  PICKER_PICK_MESSAGE,
  PICKER_TEXT_CHARS,
  PICKER_UNDO_MESSAGE,
  PICKER_UNDO_SECONDS,
  type PickerItem,
  type PickerPickMessage,
  type PickerUndoMessage,
  type PickerView,
} from './protocol.ts';
import type { InsertionService, InsertResponse } from './service.ts';

/** `storage.session` key for the open picker's token, tab and listed drafts. */
export const SESSION_PICKER = 'qusme.picker';
/** `storage.session` key for the last pick's Undo: a one-time token, its tab, draft and expiry. */
export const SESSION_PICKER_UNDO = 'qusme.pickerUndo';

interface PickerSession {
  token: string;
  tabId: number;
  drafts: string[];
}

interface PickerUndoSession {
  token: string;
  tabId: number;
  d: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** What the picker needs from the page: detection, and opening it. */
export interface PickerPage {
  detectAccounts(tabId: number, locators: readonly SiteAccount[]): Promise<(string | undefined)[]>;
  open(tabId: number, view: PickerView): Promise<void>;
}

export interface PickerDeps {
  store: KeyStore;
  definitions: SiteDefinitionSource;
  page: PickerPage;
  insertion: Pick<InsertionService, 'insert'>;
  /** A fresh token per picker; defaults to 16 random bytes in hex. */
  token?: () => string;
  /** Unix seconds, for the rows' relative times; defaults to the clock. */
  now?: () => number;
  /**
   * Restores draft `d` to `active` (7.1), for the success notice's Undo. Without it the notice
   * offers no Undo.
   */
  restore?: (d: string) => Promise<unknown>;
}

/** A pick's answer; `undo` is the token for the notice's Undo when the insertion was recorded. */
export type PickResponse =
  | (InsertResponse & { undo?: string })
  | { state: 'expired' }
  | { state: 'not_found' };

export type UndoResponse =
  | { state: 'restored' }
  | { state: 'expired' }
  | { state: 'failed'; message: string };

/** Validates a {@link PickerUndoMessage}; undefined if it is anything else. */
export function readUndoMessage(message: unknown): PickerUndoMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.type !== PICKER_UNDO_MESSAGE || typeof m.token !== 'string') return undefined;
  return { type: PICKER_UNDO_MESSAGE, token: m.token };
}

/** Validates a {@link PickerPickMessage}; undefined if it is anything else. */
export function readPickMessage(message: unknown): PickerPickMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.type !== PICKER_PICK_MESSAGE || typeof m.token !== 'string' || typeof m.d !== 'string')
    return undefined;
  return { type: PICKER_PICK_MESSAGE, token: m.token, d: m.d };
}

/** The draft's text, whitespace runs collapsed and cut to {@link PICKER_TEXT_CHARS} code points. */
export function pickerText(content: string): string {
  const text = content.replace(/[ \t]+/g, ' ').trim();
  const chars = [...text];
  return chars.length > PICKER_TEXT_CHARS ? `${chars.slice(0, PICKER_TEXT_CHARS).join('')}…` : text;
}

/** An account as the picker's head shows it: "@lanternworks", "@me@mastodon.social". */
export function handle(account: string): string {
  const shown = displayAccount(account);
  return shown.startsWith('@') || /\s/.test(shown) ? shown : `@${shown}`;
}

export class PickerService {
  readonly deps: PickerDeps;

  constructor(deps: PickerDeps) {
    this.deps = deps;
  }

  /** Builds the list for `url` and opens the picker in the tab. Returns the state it showed. */
  async open(tab: { id: number; url: string }): Promise<PickerView['state']> {
    const view = await this.view(tab);
    await this.deps.store.session.set({
      [SESSION_PICKER]: {
        token: view.token,
        tabId: tab.id,
        drafts: [...view.here, ...view.others].map((i) => i.d),
      } satisfies PickerSession,
    });
    await this.deps.page.open(tab.id, view);
    // The popup's Alt+Q tip has done its job once the picker opened with drafts to pick.
    if (view.state === 'ready') await dismissPickerTip(this.deps.store.local);
    return view.state;
  }

  /** The picker's contents for a tab: what the popup's insert panel would list (step 3). */
  async view(tab: { id: number; url: string }): Promise<PickerView> {
    const { store, definitions } = this.deps;
    const token = this.deps.token?.() ?? bytesToHex(randomBytes(16));
    const status = await store.status();
    const empty = { token, here: [], others: [], context: '' };
    if (status.state === 'empty') return { ...empty, state: 'setup' };
    if (status.state !== 'unlocked') return { ...empty, state: 'locked' };

    const cache = await readDraftCache(store.session);
    const drafts = cache?.drafts ?? [];
    const destinations = cache?.destinations ?? [];
    const locators = accountLocators(drafts, destinations, definitions, tab.url);
    const sites = [...locators.keys()];
    const results =
      sites.length === 0
        ? []
        : await this.deps.page
            .detectAccounts(tab.id, [...locators.values()])
            .catch(() => [] as (string | undefined)[]);
    const detected: Record<string, string> = {};
    for (const [i, site] of sites.entries()) {
      const account = results[i];
      if (typeof account === 'string' && account !== '') detected[site] = account;
    }
    const page = draftsForPage({
      drafts,
      destinations,
      source: definitions,
      url: tab.url,
      detected,
    });

    // The same row the popup shows (drafts/row.ts), with the text cut for the page.
    const now = this.deps.now?.() ?? Math.floor(Date.now() / 1000);
    const item = ({ draft }: PageDraft, showDestination: boolean): PickerItem =>
      rowData(draft, {
        source: definitions,
        destinations,
        now,
        showDestination,
        text: pickerText(draft.content),
      });
    // The account alone; the page already says which site it is (critique P4).
    const context = Object.values(detected).map(handle).join(', ');
    return {
      token,
      state: 'ready',
      here: page.matching.map((e) => item(e, detected[e.draft.site] === undefined)),
      others: page.elsewhere.map((e) => item(e, true)),
      context,
    };
  }

  /**
   * The user chose `d` in the picker in `tabId`. Inserts it unless the token is not the latest
   * picker's in that tab, or the picker didn't list it, or it is no longer an active draft.
   */
  async pick(
    tabId: number,
    frameId: number | undefined,
    message: PickerPickMessage
  ): Promise<PickResponse> {
    const { store } = this.deps;
    const session = (await store.session.get([SESSION_PICKER]))[SESSION_PICKER] as
      | PickerSession
      | undefined;
    if (
      session === undefined ||
      session.token !== message.token ||
      session.tabId !== tabId ||
      !session.drafts.includes(message.d)
    ) {
      return { state: 'expired' };
    }
    await store.session.remove([SESSION_PICKER]);
    if ((await store.status()).state !== 'unlocked') return { state: 'locked' };
    const draft = (await readDraftCache(store.session))?.drafts.find(
      (d) => d.d === message.d && d.status === 'active'
    );
    if (draft === undefined) return { state: 'not_found' };
    const response: PickResponse = await this.deps.insertion.insert({
      tabId,
      ...(frameId !== undefined && { frameId }),
      method: 'extension_shortcut',
      draft,
    });
    // A recorded insertion archived the draft; the page's notice may bring it back, once.
    if (response.state === 'inserted' && response.recorded && this.deps.restore !== undefined) {
      const undo: PickerUndoSession = {
        token: this.deps.token?.() ?? bytesToHex(randomBytes(16)),
        tabId,
        d: draft.d,
        expiresAt: this.#now() + PICKER_UNDO_SECONDS,
      };
      await store.session.set({ [SESSION_PICKER_UNDO]: undo });
      return { ...response, undo: undo.token };
    }
    return response;
  }

  /**
   * The success notice's Undo in `tabId`: restores the draft the last pick inserted, if the token
   * is that pick's, from the same tab, and not expired. The token works once.
   */
  async undo(tabId: number, message: PickerUndoMessage): Promise<UndoResponse> {
    const { store } = this.deps;
    const session = (await store.session.get([SESSION_PICKER_UNDO]))[SESSION_PICKER_UNDO] as
      | PickerUndoSession
      | undefined;
    if (
      session === undefined ||
      session.token !== message.token ||
      session.tabId !== tabId ||
      session.expiresAt < this.#now() ||
      this.deps.restore === undefined
    ) {
      return { state: 'expired' };
    }
    await store.session.remove([SESSION_PICKER_UNDO]);
    try {
      await this.deps.restore(session.d);
      return { state: 'restored' };
    } catch (error) {
      const text =
        error instanceof SetupError ? error.message : String((error as Error)?.message ?? error);
      return { state: 'failed', message: text };
    }
  }

  #now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }
}
