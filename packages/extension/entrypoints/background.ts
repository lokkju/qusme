import { browser } from 'wxt/browser';
import { installInsertion } from '../src/insertion/browser.ts';
import { RegistryDefinitionSource } from '../src/insertion/registry.ts';
import { KeyStore, SESSION_UNLOCKED } from '../src/keyStore.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import { SYNC_ALARM, SYNC_MESSAGE, SYNC_PERIOD_MINUTES } from '../src/sync/messages.ts';

/**
 * Sync and ingestion (spec 11.4): on popup open (the popup sends {@link SYNC_MESSAGE}) and on an
 * alarm that exists only while the queue is unlocked. Each sync also refreshes the site registry
 * from the publisher's relays, at most every few hours (10.3). Arming and inserting (11.5): the
 * context menu and the insertion messages, in `src/insertion/browser.ts`.
 */
export default defineBackground(() => {
  const store = new KeyStore({ local: browser.storage.local, session: browser.storage.session });
  const definitions = new RegistryDefinitionSource({ local: browser.storage.local });
  const engine = new SyncEngine({ store, definitions });
  definitions.load().catch(() => undefined);
  installInsertion(store, definitions);
  const sync = () => {
    void definitions.refresh();
    return engine.sync();
  };

  // The alarm follows the lock: created on unlock, cleared on lock, so nothing wakes while locked.
  const followLock = async (): Promise<void> => {
    const status = await store.status();
    if (status.state === 'unlocked') {
      const existing = await browser.alarms.get(SYNC_ALARM);
      if (existing === undefined) {
        await browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
        void sync();
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
    if (alarm.name === SYNC_ALARM) void sync();
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    if ((message as { type?: unknown } | null)?.type !== SYNC_MESSAGE) return false;
    sync().then(sendResponse, (error: unknown) =>
      sendResponse({ state: 'error', message: (error as Error).message })
    );
    return true;
  });
});
