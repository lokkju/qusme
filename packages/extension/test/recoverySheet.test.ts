import { bytesToHex } from '@noble/hashes/utils.js';
import { parseRecoveryCode } from '@qusme/nostr';
import { nsecEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import { startCreate, wipeDraft } from '../src/setup/create.ts';
import {
  parseRecoverySheet,
  type RecoverySheet,
  recoverySheetFilename,
  recoverySheetHtml,
  recoverySheetText,
} from '../src/setup/recoverySheet.ts';

const STORAGE = ['wss://nos.lol', 'wss://relay.ditto.pub'];
const INBOX = ['wss://auth.nostr1.com'];
const DATE = new Date('2026-11-06T12:00:00Z');

function sheetFor() {
  const draft = startCreate();
  const sheet: RecoverySheet = {
    words: [...draft.words],
    base32: draft.base32,
    npub: draft.npub,
    storageRelays: STORAGE,
    inboxRelays: INBOX,
    createdAt: DATE,
  };
  return { draft, sheet };
}

const sameCode = (a: string | undefined, b: string): boolean =>
  a !== undefined &&
  bytesToHex(parseRecoveryCode(a) as Uint8Array) === bytesToHex(parseRecoveryCode(b) as Uint8Array);

describe('recovery sheet (#71)', () => {
  it('holds the code in both forms, the Queue ID, the relays, the date and the steps', () => {
    const { draft, sheet } = sheetFor();
    for (const out of [recoverySheetText(sheet), recoverySheetHtml(sheet)]) {
      for (const word of draft.words) expect(out).toContain(word);
      expect(out).toContain(draft.base32);
      expect(out).toContain(draft.npub);
      for (const url of [...STORAGE, ...INBOX]) expect(out).toContain(url);
      expect(out).toContain('2026-11-06');
      expect(out).toContain('Queue ID');
      expect(out).toContain('Storage servers');
      expect(out).toContain('Recover with the recovery code');
    }
    expect(recoverySheetFilename(DATE, 'txt')).toBe('qusme-recovery-sheet-2026-11-06.txt');
    expect(recoverySheetHtml(sheet)).toMatch(/^<!doctype html>/);
    wipeDraft(draft);
  });

  it('never holds the queue key in any form', () => {
    for (let i = 0; i < 10; i += 1) {
      const { draft, sheet } = sheetFor();
      for (const out of [recoverySheetText(sheet), recoverySheetHtml(sheet)]) {
        expect(out).not.toMatch(/nsec1|ncryptsec/);
        expect(out).not.toContain(nsecEncode(draft.secretKey));
        expect(out).not.toContain(bytesToHex(draft.secretKey));
        expect(out).not.toContain(bytesToHex(draft.inboxKey));
      }
      wipeDraft(draft);
    }
  });

  it('escapes what it puts into the HTML page', () => {
    const { draft, sheet } = sheetFor();
    const html = recoverySheetHtml({ ...sheet, storageRelays: ['wss://x.example/<script>'] });
    expect(html).toContain('wss://x.example/&lt;script&gt;');
    expect(html).not.toContain('<script>');
    wipeDraft(draft);
  });
});

describe('pasting the sheet into recovery (#71)', () => {
  it('reads the code, the Queue ID and only the storage relays back from the text sheet', () => {
    for (let i = 0; i < 25; i += 1) {
      const { draft, sheet } = sheetFor();
      const parsed = parseRecoverySheet(recoverySheetText(sheet));
      expect(parsed.npub).toBe(draft.npub);
      expect(sameCode(parsed.code, draft.words.join(' '))).toBe(true);
      expect(parsed.storageRelays).toEqual(STORAGE);
      expect(parsed.conflict).toBeUndefined();
      wipeDraft(draft);
    }
  });

  it('reads a Queue ID with the 12 words or the code typed on their own', () => {
    const { draft } = sheetFor();
    const words = parseRecoverySheet(`${draft.npub}\n${draft.words.join(' ')}`);
    expect(words).toMatchObject({ npub: draft.npub, storageRelays: [] });
    expect(sameCode(words.code, draft.base32)).toBe(true);
    const numbered = parseRecoverySheet(
      `${draft.words.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\n  ${draft.npub}  `
    );
    expect(sameCode(numbered.code, draft.base32)).toBe(true);
    expect(numbered.npub).toBe(draft.npub);
    const base32 = parseRecoverySheet(`${draft.base32.toLowerCase()} ${draft.npub}`);
    expect(sameCode(base32.code, draft.base32)).toBe(true);
    const spaced = parseRecoverySheet(draft.base32.replace(/-/g, ' '));
    expect(sameCode(spaced.code, draft.base32)).toBe(true);
    expect(spaced.npub).toBeUndefined();
    wipeDraft(draft);
  });

  it('takes unlabelled relays as storage relays and adds wss:// to none', () => {
    const { draft } = sheetFor();
    const parsed = parseRecoverySheet(`${draft.npub} wss://Relay.Example/ ${draft.base32}`);
    expect(parsed.storageRelays).toEqual(['wss://relay.example']);
    wipeDraft(draft);
  });

  it('reports two different codes, and finds nothing in junk', () => {
    const a = sheetFor();
    const b = sheetFor();
    const mixed = recoverySheetText({ ...a.sheet, base32: b.sheet.base32 });
    expect(parseRecoverySheet(mixed).conflict).toMatch(/different codes/);
    expect(parseRecoverySheet('hello there npub1nope wss:/broken')).toEqual({ storageRelays: [] });
    wipeDraft(a.draft);
    wipeDraft(b.draft);
  });
});
