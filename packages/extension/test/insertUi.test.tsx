import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import type { PageDraft } from '../src/insertion/matching.ts';
import type { CachedDraft } from '../src/sync/state.ts';
import { InsertView, insertMessage } from '../src/ui/insert.tsx';

const entry = (over: Partial<CachedDraft>): PageDraft => ({
  draft: {
    d: 'd1',
    updatedAt: 1,
    site: 'x',
    account: 'lokkju',
    field: 'text',
    status: 'active',
    content: 'hello',
    ...over,
  },
  match: ['https://x.com/*'],
});

const noop = () => undefined;
const handlers = {
  onArm: noop,
  onDisarm: noop,
  onInsert: noop,
  onRetry: noop,
  onToggleElsewhere: noop,
};

describe('insert panel', () => {
  it('renders draft text, accounts and the armed draft as text, never as HTML', () => {
    const evil = entry({
      d: 'e',
      account: '<i>acct</i>',
      content: '<img src=x onerror=alert(1)> post',
    });
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        page={{ matching: [evil], otherAccounts: 0, detected: {}, elsewhere: [] }}
        undetected={['x']}
        armed={{ ...evil.draft, armedAt: 1 }}
        showElsewhere={false}
        status={undefined}
        unrecorded={0}
        busy={false}
        {...handlers}
      />
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)> post');
    expect(html).toContain('x / &lt;i>acct&lt;/i>');
    expect(html).toContain('showing drafts for every account');
    expect(html).toContain('Armed:');
    expect(html).toContain('>Insert<');
  });

  it('hides the account label once detected and counts drafts for other accounts', () => {
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        page={{
          matching: [entry({})],
          otherAccounts: 2,
          detected: { x: 'lokkju' },
          elsewhere: [entry({ d: 'm', site: 'mastodon' })],
        }}
        undetected={[]}
        armed={undefined}
        showElsewhere={false}
        status="Inserted (paste). The draft is archived."
        unrecorded={1}
        busy={false}
        {...handlers}
      />
    );
    expect(html).toContain('Signed in to x as lokkju.');
    expect(html).not.toContain('x / lokkju');
    expect(html).toContain('2 drafts for other accounts hidden.');
    expect(html).toContain('Show drafts for other sites (1)');
    expect(html).toContain('1 insertion not recorded on the relays yet.');
    expect(html).not.toContain('>Insert<');
  });

  it('says a tab it cannot use takes no drafts', () => {
    const html = renderToString(
      <InsertView
        url={undefined}
        page={undefined}
        undetected={[]}
        armed={undefined}
        showElsewhere={false}
        status={undefined}
        unrecorded={0}
        busy={false}
        {...handlers}
      />
    );
    expect(html).toContain("This tab can't take drafts.");
  });

  it('writes each outcome for the user', () => {
    expect(insertMessage({ state: 'inserted', strategy: 'paste', recorded: true })).toBe(
      'Inserted (paste). The draft is archived.'
    );
    expect(
      insertMessage({
        state: 'inserted',
        strategy: 'native',
        recorded: false,
        message: 'No storage relay answered.',
      })
    ).toBe('Inserted (native), but not recorded yet: No storage relay answered.');
    expect(insertMessage({ state: 'waiting', reason: 'paste' }, '⌘V')).toBe(
      'The draft is on the clipboard. Click into the field and press ⌘V.'
    );
    expect(insertMessage({ state: 'waiting', reason: 'focus' })).toBe(
      'Click into the field where the draft should go.'
    );
    expect(insertMessage({ state: 'failed', reason: 'partial' })).toContain("doesn't match");
    expect(insertMessage({ state: 'not_armed' })).toBe('Pick a draft first.');
  });
});
