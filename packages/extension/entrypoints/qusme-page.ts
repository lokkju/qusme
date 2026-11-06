import { browser } from 'wxt/browser';
import { createPageApi } from '../src/insertion/page/run.ts';
import {
  PAGE_API_GLOBAL,
  type PageApi,
  PICKER_PICK_MESSAGE,
  PICKER_POPUP_MESSAGE,
  type PickerPickMessage,
} from '../src/insertion/protocol.ts';

/**
 * The insertion script (spec 11.5), injected with `scripting.executeScript` under activeTab only
 * after the user opens the popup, picks the context menu item or presses the picker shortcut
 * (which opens the picker here, `src/insertion/page/picker.ts`). It installs the page API on the
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
    pick: (token, d) => {
      const message: PickerPickMessage = { type: PICKER_PICK_MESSAGE, token, d };
      return browser.runtime.sendMessage(message);
    },
    openPopup: async () => {
      try {
        const answer = (await browser.runtime.sendMessage({ type: PICKER_POPUP_MESSAGE })) as {
          opened?: unknown;
        } | null;
        return answer?.opened === true;
      } catch {
        return false;
      }
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
