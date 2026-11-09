/**
 * Editing, dismissing and restoring a draft from the popup (spec 7.1, 11.5). Each one republishes
 * the draft's wrap with the same `d`, rebuilt from the newest version on the storage relays rather
 * than from the popup's cache, so `inserted` tags, reserved tags and tags a newer build wrote all
 * survive (7, "Unknown fields"). Like the destination flows (`agents/queue.ts`), a change needs
 * every storage relay to answer the read and accept the new wrap, since republishing from a
 * partial read could undo an edit another device made. While the queue is locked nothing is read
 * or written.
 */
import {
  buildDraftWrap,
  type DraftWrap,
  FIELD_VALUE_MAX_BYTES,
  type FieldValue,
  type FieldValueStatus,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  newestFirst,
  parseDraftWrap,
  RelayError,
  utf8Length,
  validateFieldValue,
  validationTagJson,
} from '@qusme/nostr';
import {
  type AgentDeps,
  after,
  publishOrThrow,
  type QueueSession,
  withQueue,
} from '../agents/queue.ts';
import { arm, disarm, readArmed } from '../insertion/armed.ts';
import { definitionForDraft, type SiteDefinitionSource } from '../insertion/definitions.ts';
import { SetupError } from '../setup/deps.ts';
import { type CachedDraft, readDraftCache, writeDraftCache } from '../sync/state.ts';

/** The newest version of draft `d` across every storage relay; throws if any relay fails. */
async function readDraft(session: QueueSession, d: string): Promise<DraftWrap> {
  const filter = { kinds: [KIND_DRAFT_WRAP], authors: [session.pubkey], '#d': [d] };
  const results = await Promise.allSettled(session.connections.map((c) => c.query([filter])));
  const byId = new Map<string, NostrEvent>();
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof RelayError ? result.reason.reason : String(result.reason);
      throw new SetupError(`${session.connections[i]?.url} did not answer: ${reason}`);
    }
    for (const event of result.value)
      if (event.pubkey === session.pubkey) byId.set(event.id, event);
  });
  for (const event of [...byId.values()].sort(newestFirst)) {
    const parsed = await parseDraftWrap(event, session.queue);
    if (!parsed.ok) continue;
    if (parsed.value.deleted) throw new SetupError('That draft was deleted on another device.');
    return parsed.value;
  }
  throw new SetupError("That draft isn't on the storage relays any more.");
}

/**
 * Republishes draft `d` with `change` applied to its field value, then updates this device's
 * session cache so the list, the badge and the context menu follow at once.
 */
async function republish(
  d: string,
  deps: AgentDeps,
  change: (value: FieldValue) => FieldValue
): Promise<CachedDraft | undefined> {
  const { pubkey, value, updatedAt } = await withQueue(deps, async (session) => {
    const wrap = await readDraft(session, d);
    if (wrap.draft.type !== 'field_value') {
      throw new SetupError('That draft is not a field value, so qus.me cannot change it.');
    }
    const value = change(wrap.draft.value);
    const event = await buildDraftWrap(session.queue, {
      d,
      draft: { type: 'field_value', value },
      createdAt: after(session.now, wrap.createdAt),
    });
    await publishOrThrow(session, event, 'draft');
    return { pubkey: session.pubkey, value, updatedAt: event.created_at };
  });
  return updateCache(deps, pubkey, d, value, updatedAt);
}

async function updateCache(
  deps: AgentDeps,
  pubkey: string,
  d: string,
  value: FieldValue,
  updatedAt: number
): Promise<CachedDraft | undefined> {
  const cache = await readDraftCache(deps.store.session);
  if (cache === undefined || cache.queuePubkey !== pubkey) return undefined;
  let updated: CachedDraft | undefined;
  const drafts = cache.drafts.map((draft) => {
    if (draft.d !== d) return draft;
    updated = { ...draft, status: value.status, content: value.content, updatedAt };
    return updated;
  });
  await writeDraftCache(deps.store.session, { ...cache, drafts });
  return updated;
}

/**
 * The `validation` tag for edited text: recomputed against the draft's field when the effective
 * definition has it, so the tag describes the text it sits next to, and dropped otherwise rather
 * than left describing the agent's old text.
 */
function revalidated(
  value: FieldValue,
  content: string,
  source: SiteDefinitionSource | undefined,
  destinations: Parameters<typeof definitionForDraft>[2]
): FieldValue {
  const next: FieldValue = { ...value, content };
  delete next.validation;
  if (value.validation === undefined || source === undefined) return next;
  const { field } = definitionForDraft(source, value, destinations);
  if (field === undefined) return next;
  try {
    next.validation = validationTagJson(validateFieldValue(content, field));
  } catch {
    // A constraint this build does not know: leave the tag out instead of guessing.
  }
  return next;
}

/**
 * Replaces a draft's text (7.1: editing republishes the wrap with the same `d`). Refuses empty text
 * and text over the 32 KiB cap. Its status, `inserted` tags and everything else stay as they are;
 * the armed copy follows when this draft is the armed one.
 */
export async function editDraft(
  d: string,
  content: string,
  deps: AgentDeps,
  source?: SiteDefinitionSource
): Promise<CachedDraft | undefined> {
  if (content.trim() === '') throw new SetupError('A draft needs some text; dismiss it instead.');
  const bytes = utf8Length(content);
  if (bytes > FIELD_VALUE_MAX_BYTES) {
    throw new SetupError(
      `A draft holds at most ${FIELD_VALUE_MAX_BYTES} bytes; this one is ${bytes}.`
    );
  }
  const destinations = (await readDraftCache(deps.store.session))?.destinations ?? [];
  const updated = await republish(d, deps, (value) =>
    revalidated(value, content, source, destinations)
  );
  const armed = await readArmed(deps.store.session);
  if (armed?.d === d && updated !== undefined)
    await arm(deps.store.session, updated, armed.armedAt);
  return updated;
}

function withStatus(
  value: FieldValue,
  from: (s: FieldValueStatus) => boolean,
  to: FieldValueStatus
) {
  if (!from(value.status)) {
    throw new SetupError(
      value.status === 'active'
        ? 'That draft is already active; another device may have restored it.'
        : 'That draft is already archived; another device may have handled it.'
    );
  }
  return { ...value, status: to };
}

/** Archives an active draft as `archived:dismissed` (7.1) and disarms it if it was armed. */
export async function dismissDraft(d: string, deps: AgentDeps): Promise<CachedDraft | undefined> {
  const updated = await republish(d, deps, (value) =>
    withStatus(value, (s) => s === 'active', 'archived:dismissed')
  );
  await disarm(deps.store.session, d);
  return updated;
}

/**
 * Restores an archived draft (dismissed or inserted) to `active`, keeping its `inserted` tags
 * (7.1).
 */
export async function restoreDraft(d: string, deps: AgentDeps): Promise<CachedDraft | undefined> {
  return republish(d, deps, (value) => withStatus(value, (s) => s !== 'active', 'active'));
}
