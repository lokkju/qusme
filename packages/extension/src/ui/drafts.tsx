/**
 * Pieces of the popup's draft list (spec 11.4, 11.5) shared by the panel in `insert.tsx` and the
 * archive: the one-line preview and the note on the last sync. Draft text, relay errors and agent
 * labels come from agents and relays, so every one is a JSX text child, which Preact sets as text.
 */
import { CAP_STREAK_WARNING, type SyncSummary } from '../sync/state.ts';
import { Button } from './components.tsx';
import { DeadRelayNotice } from './relays.tsx';

const FIRST_LINE_MAX = 80;

/** The draft's first non-empty line, cut to 80 characters. */
export function firstLine(content: string): string {
  const line = content.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

const discardedTotal = (summary: SyncSummary): number =>
  Object.values(summary.discarded).reduce((sum, n) => sum + (n ?? 0), 0);

/**
 * The rotation notice, what the last sync brought and its problems. Each warning offers the
 * action it asks for: pairing with a device that holds the rotated key (6.1), replacing a storage
 * server that accepts nothing (9.1), and the agents screen for a flood, since inbox key rotation
 * (6.4) is not built yet (UX audit 5.8, 5.9). The counts show only when something arrived (H4);
 * server errors are one sentence with the raw messages under Details (S3).
 */
export function SyncNote(props: {
  summary: SyncSummary;
  onPair?: (() => void) | undefined;
  onAgents?: (() => void) | undefined;
  onReplaceRelay?: ((url: string) => void) | undefined;
  /** Runs the sync again, for the error line. */
  onRetry?: (() => void) | undefined;
}) {
  const { summary } = props;
  const discarded = discardedTotal(summary);
  const news = summary.ingested > 0 || discarded > 0 || summary.deferred > 0;
  const problems = summary.errors.length;
  if (
    summary.rotatedTo === undefined &&
    summary.deadRelays === undefined &&
    !news &&
    summary.cappedStreak < CAP_STREAK_WARNING &&
    problems === 0
  ) {
    return null;
  }
  return (
    <div class="mt-3 text-muted text-xs">
      {summary.rotatedTo !== undefined && (
        <div role="alert" class="mb-2 card-danger p-3 text-danger text-sm">
          <p>This queue has been rotated to a new key. Pair this device with one that holds it.</p>
          {props.onPair !== undefined && (
            <Button size="sm" class="mt-2" onClick={props.onPair}>
              Pair this device
            </Button>
          )}
        </div>
      )}
      {summary.deadRelays !== undefined && (
        <DeadRelayNotice relays={summary.deadRelays} onReplace={props.onReplaceRelay} />
      )}
      {news && (
        <p>
          {summary.ingested} new from agents
          {discarded > 0 && `, ${discarded} junk discarded`}
          {summary.deferred > 0 && `, ${summary.deferred} waiting for the next sync`}.
        </p>
      )}
      {summary.cappedStreak >= CAP_STREAK_WARNING && (
        <div role="alert" class="mt-1 text-danger">
          <p>
            The inbox has had more submissions than one sync opens for {summary.cappedStreak} syncs
            in a row. An agent may be sending too many drafts; revoke it under Agents.
          </p>
          {props.onAgents !== undefined && (
            <Button variant="plain" size="xs" class="mt-1" onClick={props.onAgents}>
              Open Agents
            </Button>
          )}
        </div>
      )}
      {problems > 0 && (
        <div class="mt-1">
          <p>
            Couldn't check every server for new drafts ({problems} problem
            {problems === 1 ? '' : 's'}).
            {props.onRetry !== undefined && (
              <>
                {' '}
                <button type="button" class="link" onClick={props.onRetry}>
                  Retry
                </button>
              </>
            )}
          </p>
          <details class="mt-1">
            <summary>Details</summary>
            {summary.errors.map((error) => (
              <p key={error} class="break-words">
                {error}
              </p>
            ))}
          </details>
        </div>
      )}
    </div>
  );
}
