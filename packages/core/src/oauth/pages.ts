/**
 * The authorize page (spec 8.2 step 2): a short code and its QR, and a script that polls until a
 * paired device decides. The page is read-only: it has no form and takes no input, since approval
 * is a NIP-98 request from the device. Everything interpolated is escaped, and the page runs under
 * a CSP that allows only its own nonce'd script and style.
 */
import { renderSVG } from 'uqr';
import { randomToken } from './secrets.ts';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface Page {
  html: string;
  headers: Record<string, string>;
}

function securityHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

const STYLE = `
:root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #555; --line: #ddd; }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --muted: #aaa; --line: #333; } }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 28rem; margin: 3rem auto; padding: 0 1rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
.client { color: var(--muted); margin: 0 0 1.5rem; overflow-wrap: anywhere; }
.code { font: 600 2.25rem/1.2 ui-monospace, monospace; letter-spacing: 0.15em; margin: 1rem 0; }
.qr { width: 12rem; height: 12rem; margin: 0 auto; padding: 0.5rem; background: #fff; border-radius: 0.5rem; }
.qr svg { width: 100%; height: 100%; display: block; }
.status { color: var(--muted); margin-top: 1.5rem; min-height: 1.5em; }
`;

function layout(title: string, body: string, nonce: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
${extraHead}
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface AuthorizePageInput {
  /** The formatted code, `XXXX-XXXX`. */
  userCode: string;
  /** What the QR encodes: a URL a device can open with the code in it. */
  qrUrl: string;
  clientName: string;
  /** The host of the client's `client_id`, shown next to the name. */
  clientHost: string;
  /** Path of the JSON status endpoint this page polls. */
  statusPath: string;
  /** Unix seconds. */
  expiresAt: number;
}

export function authorizePage(input: AuthorizePageInput): Page {
  const nonce = randomToken(16);
  const qr = renderSVG(input.qrUrl, { ecc: 'M', border: 2 });
  const script = `
(() => {
  const status = document.getElementById('status');
  const url = ${JSON.stringify(input.statusPath)};
  const tick = async () => {
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      const body = await res.json();
      if (body.status === 'redirect' && typeof body.redirect === 'string') {
        status.textContent = 'Approved. Returning to the app\\u2026';
        location.replace(body.redirect);
        return;
      }
      if (body.status === 'expired') {
        status.textContent = 'This request expired. Start again from the app.';
        return;
      }
      if (body.status === 'fetched') status.textContent = 'Waiting for approval on your device\\u2026';
    } catch (e) {}
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
})();`;
  const body = `
<h1>Approve on a qus.me device</h1>
<p class="client"><strong>${escapeHtml(input.clientName)}</strong> (${escapeHtml(input.clientHost)}) wants to submit drafts to your queue.</p>
<p>Open qus.me on a paired device and enter this code, or scan it.</p>
<div class="code" aria-label="Code">${escapeHtml(input.userCode)}</div>
<div class="qr" role="img" aria-label="QR code for ${escapeHtml(input.userCode)}">${qr}</div>
<p class="status" id="status" aria-live="polite">Waiting for your device…</p>
<noscript><p>This page checks for approval automatically; with scripts off, reload it after approving.</p></noscript>
<script nonce="${nonce}">${script}</script>`;
  return {
    html: layout('Approve on a qus.me device', body, nonce),
    headers: securityHeaders(nonce),
  };
}

/** A terminal page: an expired request, or an error that cannot go back to the client. */
export function messagePage(title: string, message: string): Page {
  const nonce = randomToken(16);
  const body = `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`;
  return { html: layout(title, body, nonce), headers: securityHeaders(nonce) };
}

/** The page the QR opens in a browser that is not a qus.me device. */
export function approveHelpPage(userCode: string | undefined): Page {
  const nonce = randomToken(16);
  const code = userCode
    ? `<div class="code">${escapeHtml(userCode)}</div>`
    : '<p>No code in this link.</p>';
  const body = `<h1>Approve in qus.me</h1>
<p>Open the qus.me extension or app on a device paired with your queue, choose to approve an agent, and enter this code.</p>
${code}`;
  return { html: layout('Approve in qus.me', body, nonce), headers: securityHeaders(nonce) };
}
