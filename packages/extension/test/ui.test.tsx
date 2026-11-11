import type { ProbeResult } from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { ProbeResults, Qr, Sas } from '../src/ui/components.tsx';
import { CreateScreen } from '../src/ui/create.tsx';
import { firstLine } from '../src/ui/drafts.tsx';
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
    // Both statements spec 6.1 requires, in two lines (critique F5).
    expect(html).toContain('Forget the passphrase: the recovery code restores the queue.');
    expect(html).toContain('Lose the code too, with no other device paired: the queue is gone.');
  });

  it('cuts a draft to its first line', () => {
    expect(firstLine('\n\n  hello\nworld')).toBe('  hello');
    expect(firstLine('y'.repeat(100))).toBe(`${'y'.repeat(79)}…`);
  });
});
