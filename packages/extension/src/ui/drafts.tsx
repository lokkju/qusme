/**
 * Pieces of the popup's draft list (spec 11.4, 11.5) shared by the panel in `insert.tsx`: the
 * one-line preview and the note on the last sync. Draft text, relay errors and agent labels come
 * from agents and relays, so every one is a JSX text child, which Preact sets as text.
 */
import { CAP_STREAK_WARNING, type SyncSummary } from '../sync/state.ts';

const FIRST_LINE_MAX = 80;

/** The draft's first non-empty line, cut to 80 characters. */
export function firstLine(content: string): string {
  const line = content.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

const discardedTotal = (summary: SyncSummary): number =>
  Object.values(summary.discarded).reduce((sum, n) => sum + (n ?? 0), 0);

/** The rotation notice, the counts from the last sync and its relay errors. */
export function SyncNote(props: { summary: SyncSummary }) {
  const { summary } = props;
  const discarded = discardedTotal(summary);
  return (
    <div class="mt-3 text-ink/70 text-xs">
      {summary.rotatedTo !== undefined && (
        <p role="alert" class="mb-1 text-danger text-sm">
          This queue has been rotated to a new key. Pair this device with one that holds it.
        </p>
      )}
      <p>
        Last sync: {summary.ingested} new from agents
        {discarded > 0 && `, ${discarded} junk discarded`}
        {summary.deferred > 0 && `, ${summary.deferred} waiting for the next sync`}.
      </p>
      {summary.cappedStreak >= CAP_STREAK_WARNING && (
        <p role="alert" class="mt-1 text-danger">
          The inbox has had more submissions than one sync opens for {summary.cappedStreak} syncs in
          a row. If you didn't expect that many, rotate the inbox key.
        </p>
      )}
      {summary.errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  );
}
