/**
 * The recovery sheet (spec 6.1, 11.3): what a user needs to restore the queue on a new device,
 * saved at setup as plain text and as a printable HTML page. It holds the recovery code in both
 * forms, the queue npub (the "Queue ID"), the storage relays ("Storage servers"), the inbox relay,
 * the date and short instructions. It never holds the queue key in any form, plain or encrypted:
 * the code opens the backup published on the storage relays, and the sheet only says where.
 *
 * Recovery accepts the sheet's text pasted into one box; {@link parseRecoverySheet} reads the
 * code, the npub and the storage relays back out of it, or out of anything else typed there.
 */
import { parseRecoveryCode, RECOVERY_WORDLIST } from '@qusme/nostr';
import { cleanRelayUrl } from './deps.ts';
import { readQueuePubkey } from './recover.ts';

export interface RecoverySheet {
  words: readonly string[];
  /** The base32 form as shown, `ABCD-EFGH-...`. */
  base32: string;
  npub: string;
  storageRelays: readonly string[];
  inboxRelays: readonly string[];
  createdAt: Date;
}

const HEADING_CODE_WORDS = 'Recovery code (12 words):';
const HEADING_CODE_BASE32 = 'Recovery code (the same code, for printing):';
const HEADING_NPUB = 'Queue ID (npub):';
const HEADING_STORAGE = 'Storage servers (relays):';
const HEADING_INBOX = 'Inbox relay:';

/** The date as YYYY-MM-DD in UTC. */
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const INSTRUCTIONS = [
  'Install the qus.me extension on the new device and open it.',
  'Choose "Recover with the recovery code".',
  'Paste this whole sheet into the box, or type the Queue ID and the recovery code.',
  'Choose a passphrase for the new device.',
];

const WARNING =
  'Keep this sheet somewhere other than this computer, such as on paper or in a password manager. Anyone who has it can open your drafts queue. If you forget your passphrase, or lose every device, this sheet is the only way back in.';

export const recoverySheetFilename = (date: Date, ext: 'txt' | 'html'): string =>
  `qusme-recovery-sheet-${isoDate(date)}.${ext}`;

/** The 12 words numbered, three to a line. */
function wordLines(words: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 3) {
    lines.push(
      words
        .slice(i, i + 3)
        .map((w, j) => `${String(i + j + 1).padStart(2, ' ')}. ${w.padEnd(10, ' ')}`)
        .join(' ')
        .trimEnd()
    );
  }
  return lines;
}

/** The sheet as plain text. */
export function recoverySheetText(sheet: RecoverySheet): string {
  return [
    'qus.me recovery sheet',
    `Made ${isoDate(sheet.createdAt)}`,
    '',
    WARNING,
    '',
    HEADING_CODE_WORDS,
    ...wordLines(sheet.words),
    '',
    HEADING_CODE_BASE32,
    sheet.base32,
    '',
    HEADING_NPUB,
    sheet.npub,
    '',
    HEADING_STORAGE,
    ...sheet.storageRelays,
    '',
    HEADING_INBOX,
    ...sheet.inboxRelays,
    '',
    'To recover:',
    ...INSTRUCTIONS.map((line, i) => `${i + 1}) ${line}`),
    '',
  ].join('\n');
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );

/** The sheet as a self-contained HTML page laid out for printing on one page. */
export function recoverySheetHtml(sheet: RecoverySheet): string {
  const e = escapeHtml;
  const list = (items: readonly string[]) => items.map((i) => `<li>${e(i)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qus.me recovery sheet, ${e(isoDate(sheet.createdAt))}</title>
<style>
body{font-family:system-ui,sans-serif;color:#111;background:#fff;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
h1{font-size:1.4rem;margin:0}h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;margin:1.4rem 0 .4rem}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.words{display:grid;grid-template-columns:repeat(3,1fr);gap:.3rem 1rem;padding-left:1.8rem;margin:0}
.warn{border:2px solid #111;padding:.6rem .8rem;border-radius:6px}
ul{margin:0;padding-left:1.2rem}
@media print{body{margin:0}}
</style>
</head>
<body>
<h1>qus.me recovery sheet</h1>
<p>Made ${e(isoDate(sheet.createdAt))}</p>
<p class="warn">${e(WARNING)}</p>
<h2>${e(HEADING_CODE_WORDS.replace(/:$/, ''))}</h2>
<ol class="words mono">${list(sheet.words)}</ol>
<h2>${e(HEADING_CODE_BASE32.replace(/:$/, ''))}</h2>
<p class="mono">${e(sheet.base32)}</p>
<h2>${e(HEADING_NPUB.replace(/:$/, ''))}</h2>
<p class="mono">${e(sheet.npub)}</p>
<h2>${e(HEADING_STORAGE.replace(/:$/, ''))}</h2>
<ul class="mono">${list(sheet.storageRelays)}</ul>
<h2>${e(HEADING_INBOX.replace(/:$/, ''))}</h2>
<ul class="mono">${list(sheet.inboxRelays)}</ul>
<h2>To recover</h2>
<ol>${list(INSTRUCTIONS)}</ol>
</body>
</html>
`;
}

/** What {@link parseRecoverySheet} found. Each part is absent when the text has none. */
export interface ParsedRecoveryInput {
  /** The queue npub as written. */
  npub?: string;
  /** The recovery code as text {@link parseRecoveryCode} accepts. */
  code?: string;
  /** Storage relays named outside the inbox section, cleaned. */
  storageRelays: string[];
  /** Set when the text holds two different recovery codes. */
  conflict?: string;
}

const WORDS = new Set(RECOVERY_WORDLIST);
const NPUB = /npub1[02-9ac-hj-np-z]{20,}/gi;
const RELAY = /\bwss?:\/\/[^\s<>"',;]+/gi;

/**
 * A base32 code as written: 26 Crockford characters, plain or in hyphenated groups. Groups split
 * by spaces are left to the whole-text fallback, since a line of words would match them too.
 */
const BASE32 =
  /(?<![0-9a-z-])(?:[0-9a-z]{1,8}-){2,12}[0-9a-z]{1,8}(?![0-9a-z-])|(?<![0-9a-z])[0-9a-z]{26}(?![0-9a-z])/gi;

/** The code's 16 bytes as a comparable string, or undefined when `text` is not a code. */
function codeKey(text: string): string | undefined {
  const bytes = parseRecoveryCode(text);
  if (bytes === undefined) return undefined;
  const key = [...bytes].join(',');
  bytes.fill(0);
  return key;
}

function findBase32(text: string): string | undefined {
  for (const match of text.matchAll(BASE32)) {
    const candidate = match[0].trim();
    if (codeKey(candidate) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * The 12 words: the BIP-39 words of every line made only of list words (and their numbers), then
 * every run of 12 among them whose checksum holds, in order.
 */
function findWords(lines: readonly string[]): string[] {
  const words: string[] = [];
  for (const line of lines) {
    const tokens = line
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((t) => t !== '' && !/^\d+[.):]?$/.test(t));
    if (tokens.length > 0 && tokens.every((t) => WORDS.has(t))) words.push(...tokens);
  }
  const found: string[] = [];
  for (let i = 0; i + 12 <= words.length; i += 1) {
    const candidate = words.slice(i, i + 12).join(' ');
    if (codeKey(candidate) !== undefined) found.push(candidate);
  }
  return found;
}

/**
 * Reads a pasted recovery sheet, or anything else typed into the recovery box: the npub, the
 * recovery code (either form), and the relays. Relays under an "Inbox relay" heading are left out,
 * since the backup is on the storage relays; relays with no heading count as storage relays.
 */
export function parseRecoverySheet(text: string): ParsedRecoveryInput {
  const result: ParsedRecoveryInput = { storageRelays: [] };
  const input = text.slice(0, 20_000);
  for (const match of input.matchAll(NPUB)) {
    const npub = match[0].toLowerCase();
    if (readQueuePubkey(npub) !== undefined) {
      result.npub = npub;
      break;
    }
  }

  let section: 'storage' | 'inbox' | 'other' = 'other';
  const plainLines: string[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    const relays = [...line.matchAll(RELAY)].map((m) => m[0]);
    if (relays.length === 0 && /[a-z].*:$/i.test(line)) {
      section = /inbox/i.test(line)
        ? 'inbox'
        : /storage|relay|server/i.test(line)
          ? 'storage'
          : 'other';
      continue;
    }
    if (relays.length > 0 && section !== 'inbox') {
      for (const url of relays) {
        const clean = cleanRelayUrl(url);
        if (clean !== undefined && !result.storageRelays.includes(clean)) {
          result.storageRelays.push(clean);
        }
      }
    }
    plainLines.push(line.replace(RELAY, ' ').replace(NPUB, ' '));
  }

  const plain = plainLines.join('\n');
  const base32 = findBase32(plain);
  const words = findWords(plainLines);
  if (base32 !== undefined && words.length > 0) {
    // A run of 12 words that is not the code can pass the 4-bit checksum; any run matching the
    // base32 form settles it, and only when none does are the two forms different codes.
    const key = codeKey(base32);
    if (!words.some((w) => codeKey(w) === key)) {
      result.conflict =
        'The 12 words and the 26-character code are different codes. Check the sheet.';
    }
  }
  const code = base32 ?? words[0] ?? (codeKey(plain) !== undefined ? plain.trim() : undefined);
  if (code !== undefined) result.code = code;
  return result;
}
