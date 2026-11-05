/**
 * Pending destinations (spec 7.2, 8.4, 11.8): ingestion creates one when an agent whose grant
 * allows new destinations names a site and account the queue does not have. The user confirms it,
 * which lets its drafts be used like any other, or rejects it, which removes it and dismisses the
 * drafts submitted for it.
 */
import {
  buildDestinations,
  buildDraftWrap,
  type Destination,
  type Destinations,
  type DraftWrap,
  type FieldValue,
} from '@qusme/nostr';
import { SetupError } from '../setup/deps.ts';
import {
  type AgentDeps,
  after,
  publishAll,
  publishOrThrow,
  type QueueSession,
  type QueueSnapshot,
  readQueue,
  withQueue,
} from './queue.ts';

function pendingOf(snapshot: QueueSnapshot, id: string): Destination {
  const found = snapshot.destinations?.content.destinations.find((d) => d.id === id);
  if (found === undefined || found.status !== 'pending') {
    throw new SetupError(
      'That destination is no longer pending; another device may have handled it.'
    );
  }
  return found;
}

async function publishDestinations(
  session: QueueSession,
  snapshot: QueueSnapshot,
  destinations: Destination[]
): Promise<void> {
  const latest = snapshot.destinations;
  const content: Destinations = { destinations };
  if (latest?.content.extra !== undefined) content.extra = latest.content.extra;
  const event = await buildDestinations(session.queue, content, {
    createdAt: after(session.now, latest?.createdAt),
    ...(latest?.extraTags && { extraTags: latest.extraTags }),
  });
  await publishOrThrow(session, event, 'destinations list');
}

/** Marks a pending destination confirmed. */
export async function confirmPendingDestination(id: string, deps: AgentDeps): Promise<void> {
  await withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    pendingOf(snapshot, id);
    const next = (snapshot.destinations?.content.destinations ?? []).map(
      (d): Destination => (d.id === id ? { ...d, status: 'confirmed' } : d)
    );
    await publishDestinations(session, snapshot, next);
  });
}

/** Whether an active draft was submitted for this destination. */
function belongsTo(wrap: DraftWrap, destination: Destination): FieldValue | undefined {
  if (wrap.draft.type !== 'field_value') return undefined;
  const value = wrap.draft.value;
  if (value.status !== 'active') return undefined;
  if (value.destination !== undefined)
    return value.destination === destination.id ? value : undefined;
  return value.site === destination.site && value.account === destination.account
    ? value
    : undefined;
}

/**
 * Rejects a pending destination: dismisses its active drafts (`archived:dismissed`, 7.1), then
 * removes it from the destinations list. The drafts go first, so a failure part way leaves the
 * destination pending and the user can reject it again. Resolves with the drafts dismissed.
 */
export async function rejectPendingDestination(
  id: string,
  deps: AgentDeps
): Promise<{ dismissed: number }> {
  return withQueue(deps, async (session) => {
    const snapshot = await readQueue(session, { drafts: true });
    const destination = pendingOf(snapshot, id);
    const refusals: string[] = [];
    let dismissed = 0;
    for (const wrap of snapshot.drafts) {
      const value = belongsTo(wrap, destination);
      if (value === undefined) continue;
      const event = await buildDraftWrap(session.queue, {
        d: wrap.d,
        draft: { type: 'field_value', value: { ...value, status: 'archived:dismissed' } },
        createdAt: after(session.now, wrap.createdAt),
      });
      const refused = await publishAll(session, event);
      if (refused.length > 0) refusals.push(...refused);
      else dismissed += 1;
    }
    if (refusals.length > 0) {
      throw new SetupError(
        `Some drafts for ${destination.label} could not be dismissed, so it stays pending: ${refusals.join('; ')}`
      );
    }
    const next = (snapshot.destinations?.content.destinations ?? []).filter((d) => d.id !== id);
    await publishDestinations(session, snapshot, next);
    return { dismissed };
  });
}
