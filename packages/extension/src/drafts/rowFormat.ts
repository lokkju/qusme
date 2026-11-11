/**
 * One draft row's shape and formatting, shared by the popup's list (`ui/draftRow.tsx`) and the
 * in-page picker (`insertion/page/picker.ts`), so both show the same meta line in the same order:
 * who wrote it, where it goes (when the page doesn't already say), the field (only when the site
 * has more than one), how long ago, and the length against the field's limit. The picker renders
 * in a closed shadow root with no framework, so the two share this model and the segment keys,
 * not markup. No imports: the page script bundles this file. `row.ts` builds the data.
 *
 * Every string here may come from an agent or a relay; renderers set it as text.
 */

/** The length against the field's `maxLength`, counted with the field's counter. */
export interface RowCount {
  length: number;
  max: number;
  over: boolean;
}

export interface RowMeta {
  /** The agent's label, or "You" for a draft written on a device. */
  who: string;
  /** Relative time of the last change ("2 h ago"). */
  when: string;
  /** Where the draft goes, in the one format (see {@link destinationLabel}); absent when implied. */
  destination?: string;
  /** The field's label, only when the site's definition has more than one field. */
  field?: string;
  count?: RowCount;
}

export interface RowData {
  d: string;
  text: string;
  meta: RowMeta;
}

/** One meta segment, keyed the same in both renderers. */
export interface RowSegment {
  key: 'who' | 'destination' | 'field' | 'when';
  text: string;
}

/** The meta line's segments in display order; the count is rendered apart, at the end. */
export function rowSegments(meta: RowMeta): RowSegment[] {
  const segments: RowSegment[] = [{ key: 'who', text: meta.who }];
  if (meta.destination !== undefined) segments.push({ key: 'destination', text: meta.destination });
  if (meta.field !== undefined) segments.push({ key: 'field', text: meta.field });
  segments.push({ key: 'when', text: meta.when });
  return segments;
}

/** "212 / 280". */
export const countText = (count: RowCount): string => `${count.length} / ${count.max}`;

/** The whole meta line as one string, for filtering and for screen readers. */
export function metaText(meta: RowMeta): string {
  const parts = rowSegments(meta).map((s) => s.text);
  if (meta.count !== undefined) parts.push(countText(meta.count));
  return parts.join(' · ');
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", then the date. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, now - at);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
