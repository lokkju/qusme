import { browser } from 'wxt/browser';
import { createPageApi } from '../src/insertion/page/run.ts';
import { PAGE_API_GLOBAL, type PageApi } from '../src/insertion/protocol.ts';

/**
 * The insertion script (spec 11.5), injected with `scripting.executeScript` under activeTab only
 * after the user opens the popup or picks the context menu item. It installs the page API on the
 * extension's isolated world, which the page's own scripts cannot see; the extension then calls
 * it with a second `executeScript`. Installing again (a second insertion in the same tab) keeps
 * the first API, so a waiting insertion is superseded rather than orphaned.
 */
export default defineUnlistedScript(() => {
  const scope = globalThis as unknown as Record<string, PageApi | undefined>;
  scope[PAGE_API_GLOBAL] ??= createPageApi({
    document,
    notify: (done) => {
      void browser.runtime.sendMessage(done).catch(() => undefined);
    },
    writeClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
  });
});
