import type { ProbeResult } from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { ProbeResults, Qr, Sas } from '../src/ui/components.tsx';
import { CreateScreen } from '../src/ui/create.tsx';
import { DraftList, firstLine } from '../src/ui/drafts.tsx';
import { device, network } from './helpers.ts';

describe('popup UI', () => {
  it('renders relay messages as text, never as HTML', () => {
    const results: ProbeResult[] = [
      {
        url: 'wss://evil.example',
        role: 'storage',
        ok: false,
        checks: [],
        failed: {
          name: 'accepts kind 31234 without AUTH',
          ok: false,
          detail: '<img src=x onerror=alert(1)>',
        },
      },
    ];
    const html = renderToString(<ProbeResults results={results} />);
    expect(html).toContain('&lt;img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('accepts kind 31234 without AUTH');
  });

  it('draws a QR code as SVG and the SAS for screen readers', () => {
    expect(renderToString(<Qr text="nostrpair://abc" label="Pairing QR code" />)).toMatch(
      /<svg[^>]*aria-label="Pairing QR code"[\s\S]*<path d="M/
    );
    expect(renderToString(<Sas code="123456" />)).toContain('Code 1 2 3 4 5 6');
  });

  it('opens setup on the passphrase step with the loss warning', () => {
    const d = device(network());
    const html = renderToString(<CreateScreen deps={d.deps} onDone={() => {}} onBack={() => {}} />);
    expect(html).toContain('Passphrase for this device');
    expect(html).toContain('no other paired device remains, the queue is lost');
  });

  it('lists active drafts as text, with the agent label and no junk content', () => {
    const base = { site: 'x', account: 'lokkju', field: 'text', updatedAt: 1 };
    const html = renderToString(
      <DraftList
        syncing={false}
        cache={{
          queuePubkey: 'a'.repeat(64),
          syncedAt: 1,
          drafts: [
            {
              ...base,
              d: '1',
              status: 'active',
              content: '\n<script>alert(1)</script> first\nsecond',
              source: { wrapId: 'b'.repeat(64), submitter: 'c'.repeat(64), label: '<b>Bot</b>' },
            },
            { ...base, d: '2', status: 'archived:dismissed', content: 'dismissed text' },
          ],
        }}
        last={{
          at: 1,
          ingested: 1,
          skipped: 0,
          deferred: 2,
          discarded: { unauthorized_submitter: 3, over_quota: 1 },
          deletionsRequested: 1,
          cappedStreak: 3,
          errors: [],
        }}
      />
    );
    expect(html).toContain('&lt;script>alert(1)&lt;/script> first');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('second');
    expect(html).toContain('from &lt;b>Bot&lt;/b>');
    expect(html).not.toContain('dismissed text');
    expect(html).toContain('4 junk discarded');
    expect(html).toContain('2 waiting for the next sync');
    expect(html).toContain('rotate the inbox key');
  });

  it('cuts a draft to its first line', () => {
    expect(firstLine('\n\n  hello\nworld')).toBe('  hello');
    expect(firstLine('y'.repeat(100))).toBe(`${'y'.repeat(79)}…`);
  });
});
