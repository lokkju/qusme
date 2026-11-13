/**
 * A browser profile with the extension loaded, the popup opened as a page, and the real toolbar
 * popup opened over a tab.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, expect, type Page, type Worker } from '@playwright/test';
import { DEFAULT_RELAY_STANDINS, HARNESS_ENV, type HarnessPorts } from '../harness/constants.ts';
import { EXTENSION_ENV } from '../harness/extension.ts';

export function harness(): HarnessPorts {
  const value = process.env[HARNESS_ENV];
  if (value === undefined) throw new Error(`${HARNESS_ENV} is unset: run through playwright test`);
  return JSON.parse(value) as HarnessPorts;
}

export interface Profile {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  /** Opens the popup page in a tab of its own, where Playwright's locators reach it. */
  popup(): Promise<Page>;
  /** Opens the toolbar popup over `tab`, as clicking the qus.me button would. */
  toolbarPopup(tab: Page): Promise<ToolbarPopup>;
  close(): Promise<void>;
}

/**
 * The toolbar popup. Playwright doesn't attach to it (it isn't a tab), so the tests reach it over
 * a DevTools session and run functions in it. It is the popup a user gets: it has no tab of its
 * own, its active tab is the page under it, and its messages reach the background as the popup's.
 */
export interface ToolbarPopup {
  /** Runs `fn(arg)` in the popup and returns the result, which must be JSON. */
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** Polls `fn(arg)` in the popup until it returns a truthy value, and returns that. */
  waitFor<A, R>(fn: (arg: A) => R | Promise<R>, arg: A, message: string): Promise<R>;
  close(): Promise<void>;
}

/**
 * A fresh profile in headless Chromium with the extension installed. `*.e2e.test`, `app.qus.me`
 * and the default relays' hosts resolve to the harness's TLS port; every other name fails to
 * resolve, so nothing leaves the machine, and 127.0.0.1 is reached directly.
 */
export async function launchProfile(): Promise<Profile> {
  const extension = process.env[EXTENSION_ENV];
  if (extension === undefined) throw new Error(`${EXTENSION_ENV} is unset`);
  const { tls } = harness();
  const mapped = [
    '*.e2e.test',
    'app.qus.me',
    ...DEFAULT_RELAY_STANDINS.map((u) => new URL(u).host),
  ];
  const rules = [...mapped.map((host) => `MAP ${host} 127.0.0.1:${tls}`), 'MAP * ~NOTFOUND'];
  const dir = mkdtempSync(join(tmpdir(), 'qusme-e2e-profile-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    colorScheme: 'light',
    viewport: { width: 400, height: 600 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=${[...rules, 'EXCLUDE 127.0.0.1'].join(', ')}`,
      '--ignore-certificate-errors',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  return {
    context,
    worker,
    extensionId,
    async popup() {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(page.locator('#app > *').first()).toBeVisible();
      return page;
    },
    toolbarPopup: (tab) => openToolbarPopup(context, worker, tab),
    close: () => context.close(),
  };
}

async function openToolbarPopup(
  context: BrowserContext,
  worker: Worker,
  tab: Page
): Promise<ToolbarPopup> {
  await tab.bringToFront();
  const cdp = await context.newCDPSession(tab);
  const isPopup = (t: { type: string; url: string }) =>
    t.type === 'page' && t.url.endsWith('/popup.html');
  const before = new Set(
    (await cdp.send('Target.getTargets')).targetInfos.filter(isPopup).map((t) => t.targetId)
  );
  await worker.evaluate(() => chrome.action.openPopup());
  let targetId = '';
  await expect
    .poll(
      async () => {
        const found = (await cdp.send('Target.getTargets')).targetInfos.find(
          (t) => isPopup(t) && !before.has(t.targetId)
        );
        targetId = found?.targetId ?? '';
        return targetId;
      },
      { message: 'the toolbar popup did not open' }
    )
    .not.toBe('');

  // A non-flattened session: its messages travel inside this page session's Target events.
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let serial = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  cdp.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message) as Record<string, unknown>;
    pending.get(message.id as number)?.(message);
  });
  const send = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++serial;
      pending.set(id, (message) => {
        pending.delete(id);
        resolve(message);
      });
      void cdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    });

  const evaluate = async <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
    const reply = await send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = reply.result as
      | {
          result?: { value?: unknown };
          exceptionDetails?: { exception?: { description?: string } };
        }
      | undefined;
    if (result?.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result?.result?.value as R;
  };

  return {
    evaluate,
    async waitFor(fn, arg, message) {
      let value: Awaited<ReturnType<typeof fn>> | undefined;
      await expect
        .poll(
          async () => {
            value = await evaluate(fn, arg);
            return Boolean(value);
          },
          { message }
        )
        .toBe(true);
      return value as Awaited<ReturnType<typeof fn>>;
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}
