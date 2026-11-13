/**
 * The archive's retention (spec 7.2, 9.2): an archived draft whose wrap `created_at` (the time it
 * was last republished, which archiving does) is older than the settings' `archive_retention_days`
 * is blanked and its deletion requested on sync, and can no longer be restored.
 */
import { archiveRetentionDays, type Settings } from '@qusme/nostr';

export const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The effective retention in days, or `null` to keep archived drafts indefinitely. The spec's
 * default is 90 days on the hosted relay and `null` elsewhere; the hosted relay ([#39]) does not
 * exist yet, so no storage relay counts as hosted and only an explicit setting deletes anything.
 *
 * [#39]: https://github.com/lokkju/qusme/issues/39
 */
export function retentionDays(settings: Settings | undefined): number | null {
  if (settings === undefined) return null;
  return archiveRetentionDays(settings, false);
}

/** Whether an archived draft last published at `updatedAt` is past `days` at `now`. */
export function pastRetention(
  draft: { status: string; updatedAt: number },
  days: number | null | undefined,
  now: number
): boolean {
  if (days === null || days === undefined || draft.status === 'active') return false;
  return draft.updatedAt < now - days * SECONDS_PER_DAY;
}
