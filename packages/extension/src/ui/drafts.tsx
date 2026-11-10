/**
 * Pieces of the popup's draft list (spec 11.4, 11.5) shared by the panel in `insert.tsx`: the
 * one-line preview and the note on the last sync. Draft text, relay errors and agent labels come
 * from agents and relays, so every one is a JSX text child, which Preact sets as text.
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
 * The rotation notice, the counts from the last sync and its relay errors. Each warning offers
 * the action it asks for: pairing with a device that holds the rotated key (6.1), replacing a
 * storage relay that accepts nothing (9.1), and the agents screen for a flood, since inbox key rotation (6.4) is not built yet (UX audit 5.8, 5.9).
 */
export function SyncNote(props: {
  summary: SyncSummary;
  onPair?: (() => void) | undefined;
  onAgents?: (() => void) | undefined;
  onReplaceRelay?: ((url: string) => void) | undefined;
}) {
  const { summary } = props;
  const discarded = discardedTotal(summary);
  return (
    <div class="mt-3 text-ink/70 text-xs">
      {summary.rotatedTo !== undefined && (
        <div role="alert" class="mb-2 rounded border border-danger/50 p-2 text-danger text-sm">
          <p>This queue has been rotated to a new key. Pair this device with one that holds it.</p>
          {props.onPair !== undefined && (
            <Button class="mt-2 px-2 py-1 text-sm" onClick={props.onPair}>
              Pair this device
            </Button>
          )}
        </div>
      )}
      {summary.deadRelays !== undefined && (
        <DeadRelayNotice relays={summary.deadRelays} onReplace={props.onReplaceRelay} />
      )}
      <p>
        Last sync: {summary.ingested} new from agents
        {discarded > 0 && `, ${discarded} junk discarded`}
        {summary.deferred > 0 && `, ${summary.deferred} waiting for the next sync`}.
      </p>
      {summary.cappedStreak >= CAP_STREAK_WARNING && (
        <div role="alert" class="mt-1 text-danger">
          <p>
            The inbox has had more submissions than one sync opens for {summary.cappedStreak} syncs
            in a row. An agent may be sending too many drafts; revoke it under Agents.
          </p>
          {props.onAgents !== undefined && (
            <Button variant="plain" class="mt-1 px-2 py-1 text-xs" onClick={props.onAgents}>
              Open Agents
            </Button>
          )}
        </div>
      )}
      {summary.errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  );
}
