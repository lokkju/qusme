import { browser } from 'wxt/browser';
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
    requestSync: () => browser.runtime.sendMessage({ type: SYNC_MESSAGE }),
  };
}

/** Opens the popup page in a tab, which stays open while the user goes to the other device. */
export function openInTab(): void {
  void browser.tabs.create({ url: browser.runtime.getURL('/popup.html') });
}
