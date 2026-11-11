/**
 * The approval code read off the sign-in page in the active tab (critique A1), so nobody copies a
 * code from one page into another. The popup was opened by a click, which grants activeTab on
 * that tab (spec 11.2), so it may read the URL and run one read-only script there. Only the
 * service's own authorize page (`/authorize/<id>`, `packages/core/src/oauth/pages.ts`) and the
 * page its QR opens (`/approve?code=`) are read; the code then goes through the same parser as a
 * typed one, so nothing the page says becomes anything but a well-formed code.
 */
import { parseApprovalCode } from './code.ts';

/**
 * Runs in the tab's isolated world (serialized by `scripting.executeScript`, so it may use only
 * globals). Prefers the page's `data-approval-code`, then the code box's text, then the QR's label.
 */
export function readCodeOnPage(): string | undefined {
  const marked = document.querySelector('[data-approval-code]');
  const value = marked?.getAttribute('data-approval-code');
  if (value) return value;
  const box = document.querySelector('.code[aria-label="Code"]') ?? document.querySelector('.code');
  const text = box?.textContent?.trim();
  if (text) return text;
  const qr = document.querySelector('[aria-label^="QR code for "]')?.getAttribute('aria-label');
  return qr?.slice('QR code for '.length).trim() || undefined;
}

/** Whether `url` is the service's authorize page or the page its QR opens. */
export function isApprovalPage(url: string, serviceOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== serviceOrigin) return false;
  return /^\/authorize\/[^/]+\/?$/.test(parsed.pathname) || parsed.pathname === '/approve';
}

export interface TabCodeDeps {
  serviceOrigin: string;
  /** The active tab, readable because the popup opened under activeTab. */
  activeTab(): Promise<{ id: number; url: string } | undefined>;
  /** Runs {@link readCodeOnPage} in the tab and returns what it found. */
  readPage(tabId: number): Promise<string | undefined>;
}

/** The code on the active tab's sign-in page as `XXXX-XXXX`, or undefined for any other tab. */
export async function approvalCodeFromTab(deps: TabCodeDeps): Promise<string | undefined> {
  const tab = await deps.activeTab();
  if (tab === undefined || !isApprovalPage(tab.url, deps.serviceOrigin)) return undefined;
  const url = new URL(tab.url);
  if (url.pathname === '/approve') {
    const fromLink = parseApprovalCode(`${url.origin}/approve${url.search}`, deps.serviceOrigin);
    if (fromLink !== undefined) return fromLink;
  }
  const text = await deps.readPage(tab.id);
  return text === undefined ? undefined : parseApprovalCode(text, deps.serviceOrigin);
}
