import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { definitionSource } from '../src/insertion/definitions.ts';
import { draftsForPage, type PageDraft } from '../src/insertion/matching.ts';
import type { CachedDraft } from '../src/sync/state.ts';
import { InsertView, insertMessage } from '../src/ui/insert.tsx';

const draft = (over: Partial<CachedDraft>): CachedDraft => ({
  d: 'd1',
  updatedAt: 1,
  site: 'x',
  account: 'lokkju',
  field: 'text',
  status: 'active',
  content: 'hello',
  ...over,
});
const entry = (over: Partial<CachedDraft>): PageDraft => ({
  draft: draft(over),
  match: ['https://x.com/*'],
});

const noop = () => undefined;
const handlers = {
  onInsert: noop,
  onArm: noop,
  onDisarm: noop,
  onRetry: noop,
};

describe('draft list (11.5)', () => {
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
    expect(html).toContain('Armed for right-click:');
    expect(html).toContain('>Insert<');
  });

  it('groups one list into For this page and Elsewhere, each row with Insert', () => {
    const source = definitionSource();
    const page = draftsForPage({
      drafts: [
        draft({ d: 'here', content: 'for this page' }),
        draft({ d: 'other', account: 'qusme', content: 'from qusme' }),
        draft({ d: 'away', site: 'blog', content: 'for the blog' }),
        draft({ d: 'gone', status: 'archived:inserted', content: 'archived text' }),
      ],
      destinations: [],
      source,
      url: 'https://x.com/home',
      detected: { x: 'lokkju' },
    });
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        page={page}
        synced={true}
        undetected={[]}
        armed={undefined}
        status={undefined}
        unrecorded={0}
        busy={false}
        {...handlers}
      />
    );
    const thisPage = html.indexOf('For this page');
    const elsewhere = html.indexOf('Elsewhere');
    expect(thisPage).toBeGreaterThanOrEqual(0);
    expect(elsewhere).toBeGreaterThan(thisPage);
    const here = html.indexOf('for this page<');
    const away = html.indexOf('for the blog');
    expect(here).toBeGreaterThan(thisPage);
    expect(here).toBeLessThan(elsewhere);
    expect(away).toBeGreaterThan(elsewhere);
    expect(html).not.toContain('from qusme');
    expect(html).toContain('1 draft for other accounts hidden.');
    expect(html).not.toContain('archived text');
    expect(html.match(/>Insert</g)).toHaveLength(2);
    // Arming is no longer the main path: nothing offers it until a row is expanded.
    expect(html).not.toContain('Arm for right-click');
    expect(html).not.toContain('drafts for other sites');
  });

  it('hides For this page on a tab qus.me cannot use and offers no Insert there', () => {
    const html = renderToString(
      <InsertView
        url={undefined}
        page={{ matching: [], otherAccounts: 0, detected: {}, elsewhere: [entry({})] }}
        synced={true}
        undetected={[]}
        armed={undefined}
        status={undefined}
        unrecorded={0}
        busy={false}
        {...handlers}
      />
    );
    expect(html).not.toContain('For this page');
    expect(html).toContain('>Drafts<');
    expect(html).toContain('hello');
    expect(html).not.toContain('>Insert<');
  });

  it('says when nothing is synced yet, and when nothing is active', () => {
    const view = (synced: boolean) =>
      renderToString(
        <InsertView
          url={undefined}
          page={{ matching: [], otherAccounts: 0, detected: {}, elsewhere: [] }}
          synced={synced}
          undetected={[]}
          armed={undefined}
          status={undefined}
          unrecorded={0}
          busy={false}
          {...handlers}
        />
      );
    expect(view(false)).toContain('Not synced yet.');
    expect(view(true)).toContain('No active drafts.');
  });

  it('counts drafts for other accounts, the unrecorded insertions and the last sync', () => {
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
        status="Inserted (paste). The draft is archived."
        unrecorded={1}
        busy={false}
        last={{
          at: 1,
          ingested: 1,
          skipped: 0,
          deferred: 2,
          discarded: { unauthorized_submitter: 3, over_quota: 1 },
          deletionsRequested: 1,
          cappedStreak: 3,
          errors: ['<b>relay</b> refused'],
          rotatedTo: 'f'.repeat(64),
        }}
        {...handlers}
      />
    );
    expect(html).toContain('Signed in to x as lokkju.');
    expect(html).not.toContain('x / lokkju');
    expect(html).toContain('2 drafts for other accounts hidden.');
    expect(html).toContain('mastodon / lokkju');
    expect(html).toContain('1 insertion not recorded on the relays yet.');
    expect(html).toContain('4 junk discarded');
    expect(html).toContain('2 waiting for the next sync');
    expect(html).toContain('rotate the inbox key');
    expect(html).toContain('rotated to a new key');
    expect(html).toContain('&lt;b>relay&lt;/b> refused');
  });

  it('shows the first line and the agent label as text', () => {
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        page={{
          matching: [
            entry({
              content: '\n<script>alert(1)</script> first\nsecond',
              source: { wrapId: 'b'.repeat(64), submitter: 'c'.repeat(64), label: '<b>Bot</b>' },
            }),
          ],
          otherAccounts: 0,
          detected: {},
          elsewhere: [],
        }}
        undetected={[]}
        armed={undefined}
        status={undefined}
        unrecorded={0}
        busy={false}
        {...handlers}
      />
    );
    expect(html).toContain('&lt;script>alert(1)&lt;/script> first');
    expect(html).not.toContain('<script');
    // Collapsed rows show the first line; the rest comes with "Show all".
    expect(html).not.toContain('second');
    expect(html).toContain('Show all');
    expect(html).toContain('from &lt;b>Bot&lt;/b>');
  });

  it('points at the picker shortcut, or at binding one when the browser has none', () => {
    const view = (pickerShortcut: string | undefined) =>
      renderToString(
        <InsertView
          url="https://x.com/home"
          page={undefined}
          undetected={[]}
          armed={undefined}
          status={undefined}
          unrecorded={0}
          busy={false}
          pickerShortcut={pickerShortcut}
          {...handlers}
        />
      );
    expect(view('Alt+Q')).toContain('Press Alt+Q in any text field to pick a draft there.');
    expect(view('')).toContain('keyboard shortcut in your browser');
    expect(view(undefined)).not.toContain('text field');
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
    expect(insertMessage({ state: 'not_found' })).toContain("isn't in the queue");
  });
});
