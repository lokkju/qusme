/**
 * The archive's retention (spec 7.2, 9.2, 11.5; D30): an archived draft whose wrap `created_at`
 * (the time it was last republished, which archiving does) is older than the settings'
 * `archive_retention_days` is blanked and its deletion requested on sync, and can no longer be
 * restored. A queue whose settings leave the value unset keeps archived drafts 90 days, and a
 * draft that was already past that when this device first synced with the default gets a grace
 * period from that sync ({@link RETENTION_GRACE_SECONDS}).
 */
import { archiveRetentionDays, type Settings } from '@qusme/nostr';

export const SECONDS_PER_DAY = 24 * 60 * 60;

/** How long the default spares drafts it would delete on its first sync (spec 11.5; D30). */
export const RETENTION_GRACE_SECONDS = 7 * SECONDS_PER_DAY;

/** The choices Settings offers; `null` is "Never delete archived drafts". */
export const RETENTION_CHOICES: readonly (number | null)[] = [30, 90, 180, 365, null];

/**
 * The effective retention in days, or `null` to keep archived drafts indefinitely: the settings'
 * `archive_retention_days`, or 90 when they leave it unset. Without settings at all (none could be
 * read) nothing is deleted, since a "never" chosen on another device could be among the missing.
 */
export function retentionDays(settings: Settings | undefined): number | null {
  if (settings === undefined) return null;
  return archiveRetentionDays(settings);
}

/** Whether the settings chose a retention (a number or `null`) rather than taking the default. */
export function retentionChosen(settings: Settings | undefined): boolean {
  return settings?.archive_retention_days !== undefined;
}

/**
 * When the default's grace period ends for this queue on this device, or `undefined` when the
 * queue chose a value (no grace) or this device has not synced with the default yet.
 */
export function graceUntil(
  settings: Settings | undefined,
  graceFrom: number | undefined
): number | undefined {
  if (settings === undefined || retentionChosen(settings) || graceFrom === undefined) {
    return undefined;
  }
  return graceFrom + RETENTION_GRACE_SECONDS;
}

/**
 * Whether an archived draft last published at `updatedAt` is past `days` at `now`. Before
 * `grace` (unix seconds), nothing is.
 */
export function pastRetention(
  draft: { status: string; updatedAt: number },
  days: number | null | undefined,
  now: number,
  grace?: number
): boolean {
  if (days === null || days === undefined || draft.status === 'active') return false;
  if (grace !== undefined && now < grace) return false;
  return draft.updatedAt < now - days * SECONDS_PER_DAY;
}

/** Whether the draft is past `days` but spared until `grace` ends. */
export function inGrace(
  draft: { status: string; updatedAt: number },
  days: number | null | undefined,
  now: number,
  grace: number | undefined
): boolean {
  return grace !== undefined && now < grace && pastRetention(draft, days, now);
}
