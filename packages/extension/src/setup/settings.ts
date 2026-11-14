/**
 * Changing the queue's settings from Settings (spec 7.2, 11.5; D30): today only
 * `archive_retention_days`. Like an approval (11.8), the change re-reads the newest settings from
 * every storage relay, refuses to go on unless all of them answer, merges the one field into that
 * version (quota counts, inbox keys and keys this version does not know stay as they are) and needs
 * every storage relay to accept the result. Other devices adopt it on their next sync.
 */
import { buildSettings, type Settings } from '@qusme/nostr';
import { after, publishOrThrow, type QueueDeps, readQueue, withQueue } from '../agents/queue.ts';
import { readDraftCache, writeDraftCache } from '../sync/state.ts';
import { SetupError } from './deps.ts';

/**
 * Sets `archive_retention_days` to `days`, or to `null` to keep archived drafts indefinitely, and
 * returns the settings as published.
 */
export async function saveArchiveRetention(
  days: number | null,
  deps: QueueDeps
): Promise<Settings> {
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new SetupError('Choose a whole number of days, at least 1.');
  }
  const { event, content } = await withQueue(deps, async (session) => {
    const latest = (await readQueue(session)).settings;
    if (latest === undefined) {
      throw new SetupError(
        "The queue's settings were not found on the storage relays, so this can't be changed here."
      );
    }
    const content: Settings = { ...latest.content, archive_retention_days: days };
    const event = await buildSettings(session.queue, content, {
      createdAt: after(session.now, latest.createdAt),
      ...(latest.extraTags && { extraTags: latest.extraTags }),
    });
    await publishOrThrow(session, event, 'setting');
    return { event, content };
  });
  await deps.store.update({ settings: event });
  // The archive view reads the cache; the next sync rewrites it the same way.
  const cache = await readDraftCache(deps.store.session);
  if (cache !== undefined) {
    const { retentionGraceUntil: _, ...rest } = cache;
    await writeDraftCache(deps.store.session, {
      ...rest,
      retentionDays: days,
      retentionChosen: true,
    });
  }
  return content;
}
