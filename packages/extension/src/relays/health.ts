/**
 * Whether each storage relay keeps what the queue writes to it (spec 9.1, "A storage relay that
 * accepts nothing"). nos.lol answered EVENTs with no OK, NOTICE or CLOSED while answering REQs
 * (2026-11-09, `docs/relays.md`), so a relay can look reachable and still keep nothing.
 *
 * The sync engine records, once per sync and per storage relay that answered its REQ, whether any
 * EVENT it sent there got `OK` true. A sync where the relay answered the REQ but every EVENT went
 * unanswered or was refused is one failure; one `OK` true clears the count. A relay that could not
 * be reached, or whose connection dropped, is offline for that sync and counts neither way.
 *
 * Kept in the sync state (`storage.local` `qusme.sync`), so it is per device: urls, times and
 * counts only.
 */
import type { PublishReport } from '@qusme/nostr';

export interface RelayHealth {
  /** Unix seconds of the last EVENT the relay answered with `OK` true. */
  lastOkAt?: number;
  /** Syncs in a row where the relay answered REQs and accepted none of the EVENTs sent to it. */
  failures: number;
  /** When the current run of failures started. */
  firstFailureAt?: number;
  /** When the last failure was seen. */
  lastFailureAt?: number;
  /** The relay's answer to the last failed EVENT, or the timeout. */
  lastReason?: string;
}

export type RelayHealthMap = Record<string, RelayHealth>;

/** A storage relay that has accepted none of the queue's writes for a while (spec 9.1). */
export interface DeadRelay {
  url: string;
  /** Syncs in a row with no write accepted. */
  failures: number;
  /** Unix seconds of the first of them. */
  since: number;
  lastReason?: string;
}

/** Failed syncs in a row before a relay counts as accepting nothing. */
export const DEAD_RELAY_FAILURES = 3;
/** And the first and the latest of them at least this far apart, so a brief outage is not it. */
export const DEAD_RELAY_MIN_SPAN_SECONDS = 60 * 60;
/**
 * A sync that wrote nothing to a relay for this long re-sends the queue's current kind 10013 to
 * it, so an idle queue still finds out whether the relay keeps writes.
 */
export const WRITE_CHECK_INTERVAL_SECONDS = 60 * 60;

/** Reasons that mean the connection went away, which is being offline, not refusing. */
const OFFLINE_REASONS = ['connection closed', 'connection error', 'closed by client'];

/** What one sync saw on each storage relay. */
export class WriteLog {
  readonly #accepted = new Set<string>();
  readonly #refused = new Map<string, string>();
  readonly #offline = new Set<string>();

  add(report: PublishReport): void {
    for (const url of report.accepted) this.#accepted.add(url);
    for (const { url, reason } of report.refused) {
      if (OFFLINE_REASONS.includes(reason)) this.#offline.add(url);
      else this.#refused.set(url, reason);
    }
  }

  /** Whether anything was sent to `url` in this sync. */
  wrote(url: string): boolean {
    return this.#accepted.has(url) || this.#refused.has(url) || this.#offline.has(url);
  }

  /**
   * The next health map. `answered` are the relays whose REQ this sync got an answer from: only
   * they can fail, since a relay that never answered anything is offline.
   */
  apply(
    previous: RelayHealthMap,
    relays: readonly string[],
    answered: ReadonlySet<string>,
    now: number
  ): RelayHealthMap {
    const next: RelayHealthMap = {};
    for (const url of relays) {
      const health: RelayHealth = { ...(previous[url] ?? { failures: 0 }) };
      if (this.#accepted.has(url)) {
        next[url] = { lastOkAt: now, failures: 0 };
        continue;
      }
      const reason = this.#refused.get(url);
      if (reason !== undefined && answered.has(url) && !this.#offline.has(url)) {
        health.failures += 1;
        health.firstFailureAt ??= now;
        health.lastFailureAt = now;
        health.lastReason = reason;
      }
      next[url] = health;
    }
    return next;
  }
}

/** The relays a sync should send the write check to (see {@link WRITE_CHECK_INTERVAL_SECONDS}). */
export function needsWriteCheck(health: RelayHealth | undefined, now: number): boolean {
  if (health === undefined) return true;
  const last = Math.max(health.lastOkAt ?? 0, health.lastFailureAt ?? 0);
  return now - last >= WRITE_CHECK_INTERVAL_SECONDS;
}

/**
 * The storage relays that accept nothing: {@link DEAD_RELAY_FAILURES} failed syncs in a row at
 * least {@link DEAD_RELAY_MIN_SPAN_SECONDS} apart, while another storage relay of the queue
 * accepted a write after the run began. Without that other relay the trouble is more likely this
 * device's own, and there would be nowhere to copy the queue from.
 */
export function deadRelays(health: RelayHealthMap, relays: readonly string[]): DeadRelay[] {
  const dead: DeadRelay[] = [];
  for (const url of relays) {
    const h = health[url];
    if (h === undefined || h.failures < DEAD_RELAY_FAILURES) continue;
    const since = h.firstFailureAt ?? 0;
    if ((h.lastFailureAt ?? 0) - since < DEAD_RELAY_MIN_SPAN_SECONDS) continue;
    const othersWork = relays.some(
      (other) => other !== url && (health[other]?.lastOkAt ?? -1) >= since
    );
    if (!othersWork) continue;
    const entry: DeadRelay = { url, failures: h.failures, since };
    if (h.lastReason !== undefined) entry.lastReason = h.lastReason;
    dead.push(entry);
  }
  return dead;
}
