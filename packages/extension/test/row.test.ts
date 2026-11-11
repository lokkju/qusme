/**
 * The row model the popup and the picker share (src/drafts/row.ts, rowFormat.ts): one destination
 * format, relative times, the count against the field's limit, and the segment order.
 */
import { describe, expect, it } from 'vitest';
import { destinationLabel, rowData } from '../src/drafts/row.ts';
import { metaText, relativeTime, rowSegments } from '../src/drafts/rowFormat.ts';
import { definitionSource } from '../src/insertion/definitions.ts';
import type { CachedDraft } from '../src/sync/state.ts';

const source = definitionSource();
const draft = (over: Partial<CachedDraft>): CachedDraft => ({
  d: 'd1',
  updatedAt: 1000,
  site: 'x',
  account: 'lokkju',
  field: 'text',
  status: 'active',
  content: 'hello',
  ...over,
});

describe('row model', () => {
  it('writes every destination one way: a label the user gave it, else host · account', () => {
    expect(destinationLabel(source, 'x', '@lokkju')).toBe('x.com · lokkju');
    expect(destinationLabel(source, 'x', 'lokkju', { label: 'X / lokkju', override: null })).toBe(
      'x.com · lokkju'
    );
    expect(destinationLabel(source, 'x', 'lokkju', { label: 'Work', override: null })).toBe('Work');
    expect(destinationLabel(source, 'linkedin', 'Lantern Works')).toBe(
      'linkedin.com · Lantern Works'
    );
    expect(destinationLabel(source, 'mastodon', 'me@mastodon.social')).toBe('mastodon.social · me');
    expect(destinationLabel(source, 'blog', 'me')).toBe('blog · me');
  });

  it('says how long ago in a few words', () => {
    expect(relativeTime(100, 130)).toBe('just now');
    expect(relativeTime(0, 300)).toBe('5 min ago');
    expect(relativeTime(0, 7300)).toBe('2 h ago');
    expect(relativeTime(0, 86_400 + 10)).toBe('yesterday');
    expect(relativeTime(0, 3 * 86_400)).toBe('3 days ago');
  });

  it('builds the meta line: who, where only when asked, when, and the count', () => {
    const agent = rowData(
      draft({
        content: 'a'.repeat(281),
        source: { wrapId: 'w', submitter: 's', label: 'Claude' },
      }),
      { source, destinations: [], now: 1000 + 7200, showDestination: true }
    );
    expect(rowSegments(agent.meta).map((s) => s.key)).toEqual(['who', 'destination', 'when']);
    expect(agent.meta.count).toEqual({ length: 281, max: 280, over: true });
    expect(metaText(agent.meta)).toBe('Claude · x.com · lokkju · 2 h ago · 281 / 280');
    const mine = rowData(draft({}), {
      source,
      destinations: [],
      now: 1000,
      showDestination: false,
    });
    expect(metaText(mine.meta)).toBe('You · just now · 5 / 280');
    // No field name while the site has one field.
    expect(mine.meta.field).toBeUndefined();
  });
});
