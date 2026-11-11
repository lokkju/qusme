import { browser } from 'wxt/browser';
import { approvalCodeFromTab, readCodeOnPage } from '../agents/tabCode.ts';
import { KeyStore } from '../keyStore.ts';
import { OPTIONAL_HOST_PERMISSIONS, SERVICE_ORIGIN } from '../permissions.ts';
import type { SetupDeps } from '../setup/deps.ts';
import { SYNC_MESSAGE } from '../sync/messages.ts';

/** The setup flows' dependencies in the real extension. */
export function browserDeps(): SetupDeps {
  return {
    store: new KeyStore({ local: browser.storage.local, session: browser.storage.session }),
    serviceOrigin: SERVICE_ORIGIN,
    fetch: (input, init) => fetch(input, init),
    // Called first in the click handler's flow: Firefox grants it only inside the user's gesture.
    requestServicePermission: () =>
      browser.permissions.request({ origins: [...OPTIONAL_HOST_PERMISSIONS] }),
    hasServicePermission: () =>
      browser.permissions.contains({ origins: [...OPTIONAL_HOST_PERMISSIONS] }),
    requestSync: () => browser.runtime.sendMessage({ type: SYNC_MESSAGE }),
  };
}

/** Opens the popup page in a tab, which stays open while the user goes to the other device. */
export function openInTab(): void {
  void browser.tabs.create({ url: browser.runtime.getURL('/popup.html') });
}

/**
 * The approval code on the active tab's qus.me sign-in page, read under the activeTab grant the
 * popup's click gave (critique A1); undefined on any other tab or when the read fails.
 */
export function tabApprovalCode(): Promise<string | undefined> {
  return approvalCodeFromTab({
    serviceOrigin: SERVICE_ORIGIN,
    activeTab: async () => {
      // tabs.query needs no `tabs` permission; the URL is there because activeTab granted it.
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined || tab.url === undefined) return undefined;
      return { id: tab.id, url: tab.url };
    },
    readPage: async (tabId) => {
      const [result] = await browser.scripting.executeScript({
        target: { tabId },
        func: readCodeOnPage,
      });
      const value = result?.result;
      return typeof value === 'string' ? value : undefined;
    },
  }).catch(() => undefined);
}
