import { browser } from 'wxt/browser';
import { KeyStore, SESSION_UNLOCKED } from '../src/keyStore.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import { SYNC_ALARM, SYNC_MESSAGE, SYNC_PERIOD_MINUTES } from '../src/sync/messages.ts';

/**
 * Sync and ingestion (spec 11.4): on popup open (the popup sends {@link SYNC_MESSAGE}) and on an
 * alarm that exists only while the queue is unlocked. The context menu (11.5) lands here later.
 */
export default defineBackground(() => {
  const store = new KeyStore({ local: browser.storage.local, session: browser.storage.session });
  const engine = new SyncEngine({ store });

  // The alarm follows the lock: created on unlock, cleared on lock, so nothing wakes while locked.
  const followLock = async (): Promise<void> => {
    const status = await store.status();
    if (status.state === 'unlocked') {
      const existing = await browser.alarms.get(SYNC_ALARM);
      if (existing === undefined) {
        await browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
        void engine.sync();
      }
    } else {
      await browser.alarms.clear(SYNC_ALARM);
    }
  };

  browser.runtime.onInstalled.addListener(() => void followLock());
  browser.runtime.onStartup.addListener(() => void followLock());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && SESSION_UNLOCKED in changes) void followLock();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void engine.sync();
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    if ((message as { type?: unknown } | null)?.type !== SYNC_MESSAGE) return false;
    engine
      .sync()
      .then(sendResponse, (error: unknown) =>
        sendResponse({ state: 'error', message: (error as Error).message })
      );
    return true;
  });
});
