/**
 * The insertion pipeline wired to the real browser APIs: `scripting.executeScript` under
 * activeTab, the context menu, and the background's message handlers (spec 11.5).
 */
import type { SiteAccount } from '@qusme/nostr';
import { browser } from 'wxt/browser';
import { badgeUpdater, changesBadge } from '../badge.ts';
import { PICKER_COMMAND } from '../commands.ts';
import { restoreDraft } from '../drafts/manage.ts';
import { type KeyStore, SESSION_ARMED, SESSION_DRAFTS, SESSION_INSERTION } from '../keyStore.ts';
import { readDraftCache } from '../sync/state.ts';
import type { InsertionUiDeps } from '../ui/insert.tsx';
import { readArmed } from './armed.ts';
import type { SiteDefinitionSource } from './definitions.ts';
import { MENU_CHOOSE, MENU_INSERT, MENU_SAVE, menuItem, saveMenuItem } from './menu.ts';
import { INSERT_MESSAGE, RETRY_RECORD_MESSAGE } from './messages.ts';
import { type PickerPage, PickerService, readPickMessage, readUndoMessage } from './picker.ts';
import {
  type NoticeKind,
  PAGE_API_GLOBAL,
  PAGE_SCRIPT_FILE,
  type PageAccountResult,
  type PageInsertRequest,
  type PageOutcome,
  type PageReadRequest,
  type PageReadResult,
  PICKER_POPUP_MESSAGE,
  type PickerView,
} from './protocol.ts';
import { type SavePage, SaveService, saveFromMenu } from './save.ts';
import { InsertionService, type InsertResponse, type PageRunner, readPageDone } from './service.ts';

type Target = { tabId: number; frameId?: number };

const scriptTarget = (target: Target) =>
  target.frameId === undefined
    ? { tabId: target.tabId }
    : { tabId: target.tabId, frameIds: [target.frameId] };

/** Injects the insertion script, which installs its API once per frame. */
async function injectPageScript(target: Target): Promise<void> {
  await browser.scripting.executeScript({
    target: scriptTarget(target),
    files: [PAGE_SCRIPT_FILE],
  });
}

/** The page runner over `scripting.executeScript`. */
export const scriptingPageRunner: PageRunner = {
  async insert(target, request) {
    await injectPageScript(target);
    const [result] = await browser.scripting.executeScript({
      target: scriptTarget(target),
      // Serialized into the page's isolated world: it may use only its arguments and globals.
      func: (req: PageInsertRequest, name: string) =>
        (
          globalThis as unknown as Record<
            string,
            { insert(r: PageInsertRequest): Promise<PageOutcome> }
          >
        )[name]?.insert(req),
      args: [request, PAGE_API_GLOBAL],
    });
    const outcome = result?.result as PageOutcome | undefined;
    if (outcome === undefined || outcome === null)
      throw new Error('the insertion script did not answer');
    return outcome;
  },
};

/** Runs the read-only account detection for each locator in the tab's main frame (step 2). */
export async function detectAccounts(
  tabId: number,
  locators: readonly SiteAccount[]
): Promise<(string | undefined)[]> {
  if (locators.length === 0) return [];
  await injectPageScript({ tabId });
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: (accounts: SiteAccount[], name: string) =>
      accounts.map(
        (a) =>
          (
            globalThis as unknown as Record<
              string,
              { detectAccount(a: SiteAccount): PageAccountResult }
            >
          )[name]?.detectAccount(a).account
      ),
    args: [[...locators], PAGE_API_GLOBAL],
  });
  return (result?.result as (string | undefined)[] | undefined) ?? [];
}

/** Opens the keyboard picker in the tab's main frame. */
export const scriptingPicker: PickerPage = {
  detectAccounts,
  async open(tabId, view) {
    await injectPageScript({ tabId });
    await browser.scripting.executeScript({
      target: { tabId },
      func: (v: PickerView, name: string) =>
        (globalThis as unknown as Record<string, { openPicker(v: PickerView): unknown }>)[
          name
        ]?.openPicker(v),
      args: [view, PAGE_API_GLOBAL],
    });
  },
};

/** Reads the field and shows the notice for "Save to qus.me" (spec 11.7), in the clicked frame. */
export const scriptingSavePage: SavePage = {
  detectAccounts,
  async readField(target, request) {
    await injectPageScript(target);
    const [result] = await browser.scripting.executeScript({
      target: scriptTarget(target),
      func: (req: PageReadRequest, name: string) =>
        (
          globalThis as unknown as Record<string, { readField(r: PageReadRequest): PageReadResult }>
        )[name]?.readField(req),
      args: [request, PAGE_API_GLOBAL],
    });
    const read = result?.result as PageReadResult | undefined;
    if (read === undefined || read === null) throw new Error('the page script did not answer');
    return read;
  },
  async notice(target, text, kind) {
    await injectPageScript(target);
    await browser.scripting.executeScript({
      target: scriptTarget(target),
      func: (t: string, k: NoticeKind, name: string) =>
        (globalThis as unknown as Record<string, { showNotice(t: string, k: NoticeKind): void }>)[
          name
        ]?.showNotice(t, k),
      args: [text, kind, PAGE_API_GLOBAL],
    });
  },
};

/**
 * Sets up the context menu, its click handler, the picker shortcut and the insertion messages in
 * the background.
 */
export function installInsertion(
  store: KeyStore,
  definitions: SiteDefinitionSource
): InsertionService {
  const service = new InsertionService({ store, definitions, page: scriptingPageRunner });
  const saver = new SaveService({ store, definitions, page: scriptingSavePage });
  const accessKeys = import.meta.env.FIREFOX === true;

  // The badge follows the drafts, the insertion bookkeeping, pending revocations and the lock:
  // every sync, insert, dismissal, lock and unlock writes one of them (spec 11.4).
  const updateBadge = badgeUpdater(store, browser.action);
  browser.storage.onChanged.addListener((changes, area) => {
    if (changesBadge(changes, area)) void updateBadge();
  });
  browser.runtime.onStartup.addListener(() => void updateBadge());
  browser.runtime.onInstalled.addListener(() => void updateBadge());
  void updateBadge();

  let rebuilding = Promise.resolve();
  const rebuildMenu = () => {
    rebuilding = rebuilding
      .then(async () => {
        const [armed, cache] = await Promise.all([
          readArmed(store.session),
          readDraftCache(store.session),
        ]);
        const destinations = cache?.destinations ?? [];
        const item = menuItem({ armed, destinations, definitions, accessKeys });
        const save = saveMenuItem({ destinations, definitions });
        await browser.contextMenus.removeAll();
        if (item !== undefined) browser.contextMenus.create(item);
        if (save !== undefined) browser.contextMenus.create(save);
      })
      .catch(() => undefined);
  };

  browser.runtime.onInstalled.addListener(rebuildMenu);
  browser.runtime.onStartup.addListener(rebuildMenu);
  // A registry refresh can bring new match patterns.
  definitions.subscribe?.(rebuildMenu);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (SESSION_ARMED in changes || SESSION_DRAFTS in changes))
      rebuildMenu();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_CHOOSE) {
      // Synchronously, inside the click: Firefox refuses openPopup anywhere else.
      void browser.action.openPopup().catch(() => undefined);
      return;
    }
    if (info.menuItemId === MENU_SAVE) {
      // activeTab, granted by this click, makes the tab's URL readable until it navigates.
      void saveFromMenu(saver, info, tab)?.catch(() => undefined);
      return;
    }
    if (info.menuItemId !== MENU_INSERT || tab?.id === undefined) return;
    const tabId = tab.id;
    void (async () => {
      const result = await service.insert({
        tabId,
        ...(info.frameId !== undefined && { frameId: info.frameId }),
        method: 'extension_context_menu',
      });
      // Disarmed or locked since the menu was built: let the user choose in the popup.
      if (result.state === 'not_armed' || result.state === 'locked') {
        await browser.action.openPopup().catch(() => undefined);
      }
      await updateBadge();
    })();
  });

  const picker = new PickerService({
    store,
    definitions,
    page: scriptingPicker,
    insertion: service,
    restore: (d) => restoreDraft(d, { store }),
  });
  // The shortcut grants activeTab on the tab it was pressed in (spec 11.2); the tab's URL is
  // readable from then until it navigates.
  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== PICKER_COMMAND) return;
    void (async () => {
      const [active] =
        tab?.id === undefined
          ? await browser.tabs.query({ active: true, currentWindow: true })
          : [tab];
      if (active?.id === undefined) return;
      const url = active.url ?? (await browser.tabs.get(active.id)).url;
      if (url === undefined || !/^https?:/.test(url)) return;
      await picker.open({ id: active.id, url });
    })().catch(() => undefined);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    const type = (message as { type?: unknown } | null)?.type;
    let work: Promise<unknown> | undefined;
    const pick = sender.tab?.id === undefined ? undefined : readPickMessage(message);
    const undo = sender.tab?.id === undefined ? undefined : readUndoMessage(message);
    if (sender.tab === undefined && type === INSERT_MESSAGE) {
      const { tabId, d } = message as { tabId?: unknown; d?: unknown };
      if (typeof tabId !== 'number' || typeof d !== 'string') return false;
      work = service.insertChosen(tabId, d);
    } else if (sender.tab === undefined && type === RETRY_RECORD_MESSAGE) {
      work = service.retryUnrecorded();
    } else if (sender.tab?.id !== undefined && pick !== undefined) {
      // The user chose a draft in the picker.
      work = picker.pick(sender.tab.id, sender.frameId, pick);
    } else if (sender.tab?.id !== undefined && undo !== undefined) {
      // The success notice's Undo after a pick.
      work = picker.undo(sender.tab.id, undo);
    } else if (sender.tab?.id !== undefined && type === PICKER_POPUP_MESSAGE) {
      // The picker's "Open qus.me". Firefox refuses openPopup outside a user action, and the
      // page then tells the user to click the toolbar button.
      work = browser.action.openPopup().then(
        () => ({ opened: true }),
        () => ({ opened: false })
      );
    } else if (sender.tab?.id !== undefined) {
      // The page script reporting an insertion that waited for the user's click or paste.
      const done = readPageDone(message);
      if (done === undefined) return false;
      work = service.pageDone(sender.tab.id, done);
    }
    if (work === undefined) return false;
    work
      .then(async (result) => {
        await updateBadge();
        sendResponse(result);
      })
      .catch((error: unknown) =>
        sendResponse({ state: 'failed', reason: 'injection', message: String(error) })
      );
    return true;
  });

  return service;
}

/** The popup's insertion panel over the real browser APIs. */
export function browserInsertionUiDeps(definitions: SiteDefinitionSource): InsertionUiDeps {
  return {
    definitions,
    activeTab: async () => {
      // tabs.query needs no `tabs` permission; the URL is there because activeTab granted it.
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined || tab.url === undefined) return undefined;
      if (!/^https?:/.test(tab.url)) return undefined;
      return { id: tab.id, url: tab.url };
    },
    detectAccounts,
    insert: (tabId, d) =>
      browser.runtime.sendMessage({ type: INSERT_MESSAGE, tabId, d }) as Promise<InsertResponse>,
    retryRecord: () =>
      browser.runtime.sendMessage({ type: RETRY_RECORD_MESSAGE }) as Promise<{
        remaining: number;
        messages: string[];
      }>,
    writeClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    onSessionChange: (callback) => {
      const listener = (changes: Record<string, unknown>, area: string) => {
        if (area !== 'session') return;
        if (SESSION_ARMED in changes || SESSION_DRAFTS in changes || SESSION_INSERTION in changes) {
          callback();
        }
      };
      browser.storage.onChanged.addListener(listener);
      return () => browser.storage.onChanged.removeListener(listener);
    },
    pasteShortcut: /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘V' : 'Ctrl+V',
    pickerShortcut: async () => {
      const commands = await browser.commands.getAll();
      return commands.find((c) => c.name === PICKER_COMMAND)?.shortcut ?? '';
    },
  };
}
