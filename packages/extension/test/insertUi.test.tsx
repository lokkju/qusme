import type { Destination } from '@qusme/nostr';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { definitionSource } from '../src/insertion/definitions.ts';
import { draftsForPage, type PageDraft } from '../src/insertion/matching.ts';
import type { CachedDraft, SyncSummary } from '../src/sync/state.ts';
import {
  InsertView,
  insertDetail,
  insertMessage,
  pageChip,
  pendingCards,
} from '../src/ui/insert.tsx';

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
    expect(html).toContain('x.com · &lt;i>acct&lt;/i>');
    expect(html).toContain('showing drafts for every account');
    expect(html).toContain('Set for right-click:');
    expect(html).toContain('>Insert<');
  });

  it('groups one list into For this page and Elsewhere, with Insert only on rows for this page', () => {
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
    expect(html).toContain('>2 drafts<');
    expect(html).toContain('>1 for this page<');
    const here = html.indexOf('>for this page<');
    const away = html.indexOf('for the blog');
    expect(here).toBeGreaterThan(thisPage);
    expect(here).toBeLessThan(elsewhere);
    expect(away).toBeGreaterThan(elsewhere);
    expect(html).not.toContain('from qusme');
    expect(html).toContain('1 draft for other accounts hidden.');
    expect(html).not.toContain('archived text');
    // Collapsed rows: Insert on the row for this page only; the Elsewhere row has no button
    // until it is expanded, and nothing offers Edit, Dismiss or the context menu until then.
    expect(html.match(/>Insert</g)).toHaveLength(1);
    expect(html).not.toContain('Insert here anyway');
    expect(html).not.toContain('Set for right-click');
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
    expect(html).toContain('>1 draft<');
    expect(html).toContain('hello');
    expect(html).not.toContain('>Insert<');
  });

  it('says when nothing is synced yet, and names the loop when nothing is waiting', () => {
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
    expect(view(true)).toContain('Nothing waiting. Ask your agent to draft something');
    expect(view(true)).toContain('>No drafts<');
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
        status="Inserted. Check it, then post."
        statusDetails={['<i>relay</i> said no']}
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
    // The detected account is in the toolbar's chip, so this page's row doesn't repeat it.
    expect(html).not.toContain('x.com · lokkju');
    expect(html).toContain('2 drafts for other accounts hidden.');
    expect(html).toContain('mastodon · lokkju');
    expect(html).toContain("1 inserted draft couldn't be marked done");
    expect(html).toContain('&lt;i>relay&lt;/i> said no');
    expect(html).toContain('1 new from agents');
    expect(html).toContain('4 junk discarded');
    expect(html).toContain('2 waiting for the next sync');
    expect(html).toContain('revoke it under Agents');
    expect(html).toContain('rotated to a new key');
    expect(html).toContain("Couldn't check every server for new drafts (1 problem).");
    expect(html).toContain('<summary>Details</summary>');
    expect(html).toContain('&lt;b>relay&lt;/b> refused');
  });

  it('shows the sync line only when the last sync brought or broke something', () => {
    const view = (last: Partial<SyncSummary>) =>
      renderToString(
        <InsertView
          url={undefined}
          page={{ matching: [], otherAccounts: 0, detected: {}, elsewhere: [entry({})] }}
          undetected={[]}
          armed={undefined}
          status={undefined}
          unrecorded={0}
          busy={false}
          last={{
            at: 1,
            ingested: 0,
            skipped: 0,
            deferred: 0,
            discarded: {},
            deletionsRequested: 0,
            cappedStreak: 0,
            errors: [],
            ...last,
          }}
          {...handlers}
        />
      );
    expect(view({})).not.toContain('new from agents');
    expect(view({ ingested: 2 })).toContain('2 new from agents.');
  });

  it('puts the context chip together from the tab and the detected account', () => {
    expect(pageChip('https://www.linkedin.com/feed/', { linkedin: 'Lantern Works' })).toBe(
      'linkedin.com · Lantern Works'
    );
    expect(pageChip('https://x.com/home', { x: '@lokkju' })).toBe('x.com · lokkju');
    expect(pageChip('https://x.com/home', {})).toBe('x.com');
    expect(pageChip(undefined, {})).toBeUndefined();
    expect(pageChip('chrome://extensions', {})).toBeUndefined();
  });

  it('shows who, when and the count against the limit on each row, red when over', () => {
    const now = 10_000;
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        now={now}
        page={{
          matching: [
            entry({ d: 'short', content: 'fits', updatedAt: now - 7200 }),
            entry({ d: 'long', content: 'a'.repeat(300), updatedAt: now - 30 }),
          ],
          otherAccounts: 0,
          detected: { x: 'lokkju' },
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
    expect(html).toContain('2 h ago');
    expect(html).toContain('just now');
    expect(html).toContain('4 / 280');
    expect(html).toMatch(/text-danger[^>]*>300 \/ 280/);
    expect(html).toContain('(over the limit)');
  });

  it('clamps the text to three lines and shows the agent label as text', () => {
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
    // Collapsed rows clamp at three lines; the whole text comes with "Show all".
    expect(html).toContain('line-clamp-3');
    expect(html).toContain('Show all');
    expect(html).toContain('&lt;b>Bot&lt;/b>');
  });

  it('points at the picker shortcut in a dismissible tip, or at binding one', () => {
    const view = (pickerShortcut: string | undefined, tip = true) =>
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
          tip={tip}
          {...handlers}
        />
      );
    expect(view('Alt+Q')).toContain('<kbd class="kbd">Alt+Q</kbd> to pick a draft');
    expect(view('Alt+Q')).toContain('aria-label="Hide this tip"');
    expect(view('Alt+Q', false)).not.toContain('to pick a draft');
    expect(view('')).toContain('keyboard shortcut in your browser');
    expect(view(undefined)).not.toContain('text field');
  });

  it('puts an account an agent proposed at the top, with Allow and Reject', () => {
    const source = definitionSource();
    const pending: Destination = {
      id: 'p1',
      site: 'x',
      account: '<b>bot</b>',
      label: 'X / <b>bot</b>',
      status: 'pending',
      override: null,
    };
    const cards = pendingCards(
      [
        draft({
          d: 'w',
          destination: 'p1',
          source: { wrapId: 'w', submitter: 's', label: '<i>Claude</i>' },
        }),
      ],
      [pending],
      source
    );
    expect(cards).toEqual([
      { destination: pending, label: 'x.com · <b>bot</b>', agent: '<i>Claude</i>', drafts: 1 },
    ]);
    const html = renderToString(
      <InsertView
        url="https://x.com/home"
        page={{ matching: [entry({})], otherAccounts: 0, detected: {}, elsewhere: [] }}
        pending={cards}
        undetected={[]}
        armed={undefined}
        status={undefined}
        unrecorded={0}
        busy={false}
        {...handlers}
      />
    );
    expect(html).not.toMatch(/<(b|i)>/);
    expect(html).toContain('&lt;i>Claude&lt;/i> wants to draft for');
    expect(html).toContain('x.com · &lt;b>bot&lt;/b>');
    expect(html).toContain('1 draft waiting.');
    expect(html).toContain('>Allow<');
    expect(html.indexOf('wants to draft')).toBeLessThan(html.indexOf('For this page'));
  });

  it('writes each outcome for the user', () => {
    expect(insertMessage({ state: 'inserted', strategy: 'paste', recorded: true })).toBe(
      'Inserted. Check it, then post.'
    );
    const unrecorded = {
      state: 'inserted',
      strategy: 'native',
      recorded: false,
      message: 'No storage relay answered.',
    } as const;
    expect(insertMessage(unrecorded)).toBe(
      "Inserted. Check it, then post. It couldn't be marked done yet, so it may show again on your other devices."
    );
    expect(insertDetail(unrecorded)).toBe('No storage relay answered.');
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
