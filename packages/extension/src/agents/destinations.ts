/**
 * The destinations list (spec 7.2): pending destinations an agent proposed (8.4, 11.8), which the
 * user confirms or rejects, and destinations the user adds, edits and removes by hand. Every write
 * re-reads the latest list from every storage relay, changes only the destination it is about,
 * keeps every key this version does not know (spec 7, "Unknown fields"), and needs every storage
 * relay to accept the new list. While the queue is locked nothing is read or written.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
  buildDestinations,
  buildDraftWrap,
  checkDestinationOverride,
  type Destination,
  type Destinations,
  type DraftWrap,
  type FieldValue,
  type JsonObject,
} from '@qusme/nostr';
import type { SiteDefinitionSource } from '../insertion/definitions.ts';
import { sameAccount } from '../insertion/matching.ts';
import { SetupError } from '../setup/deps.ts';
import { readDraftCache, writeDraftCache } from '../sync/state.ts';
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

/** Longest label a device writes; labels are for the user's own screens. */
export const LABEL_MAX = 100;
/** A site id, as definitions spell them (10.1); a custom destination's site takes the same form. */
export const SITE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const listOf = (snapshot: QueueSnapshot): Destination[] =>
  snapshot.destinations?.content.destinations ?? [];

function pendingOf(snapshot: QueueSnapshot, id: string): Destination {
  const found = listOf(snapshot).find((d) => d.id === id);
  if (found === undefined || found.status !== 'pending') {
    throw new SetupError(
      'That destination is no longer pending; another device may have handled it.'
    );
  }
  return found;
}

function existingOf(snapshot: QueueSnapshot, id: string): Destination {
  const found = listOf(snapshot).find((d) => d.id === id);
  if (found === undefined) {
    throw new SetupError('That destination is gone; another device may have removed it.');
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

/**
 * Puts the published list into this device's session cache, so the insert panel and the context
 * menu follow at once instead of at the next sync. Drafts dismissed with a destination leave the
 * cache's active ones too.
 */
async function updateCache(
  deps: AgentDeps,
  pubkey: string,
  destinations: Destination[],
  dismissed: readonly string[] = []
): Promise<void> {
  const cache = await readDraftCache(deps.store.session);
  if (cache === undefined || cache.queuePubkey !== pubkey) return;
  const gone = new Set(dismissed);
  await writeDraftCache(deps.store.session, {
    ...cache,
    destinations,
    drafts: cache.drafts.map((d) => (gone.has(d.d) ? { ...d, status: 'archived:dismissed' } : d)),
  });
}

/** Marks a pending destination confirmed. */
export async function confirmPendingDestination(id: string, deps: AgentDeps): Promise<void> {
  const { pubkey, next } = await withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    pendingOf(snapshot, id);
    const next = listOf(snapshot).map(
      (d): Destination => (d.id === id ? { ...d, status: 'confirmed' } : d)
    );
    await publishDestinations(session, snapshot, next);
    return { pubkey: session.pubkey, next };
  });
  await updateCache(deps, pubkey, next);
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
 * Republishes each active draft for `destination` as `archived:dismissed` (7.1) and returns the
 * `d` of each. Throws, naming the refusals, if any draft was not saved on every storage relay;
 * the caller then leaves the destination where it is, so the user can try again.
 */
async function dismissDraftsFor(
  session: QueueSession,
  snapshot: QueueSnapshot,
  destination: Destination,
  failure: string
): Promise<string[]> {
  const refusals: string[] = [];
  const dismissed: string[] = [];
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
    else dismissed.push(wrap.d);
  }
  if (refusals.length > 0) throw new SetupError(`${failure}: ${refusals.join('; ')}`);
  return dismissed;
}

/**
 * Removes a destination after dismissing its active drafts. The drafts go first, so a failure
 * part way leaves the destination in the list and the user can remove it again.
 */
async function dismissAndRemove(
  id: string,
  deps: AgentDeps,
  find: (snapshot: QueueSnapshot) => Destination,
  failure: (destination: Destination) => string
): Promise<{ dismissed: number }> {
  const { pubkey, next, dismissed } = await withQueue(deps, async (session) => {
    const snapshot = await readQueue(session, { drafts: true });
    const destination = find(snapshot);
    const dismissed = await dismissDraftsFor(session, snapshot, destination, failure(destination));
    const next = listOf(snapshot).filter((d) => d.id !== id);
    await publishDestinations(session, snapshot, next);
    return { pubkey: session.pubkey, next, dismissed };
  });
  await updateCache(deps, pubkey, next, dismissed);
  return { dismissed: dismissed.length };
}

/**
 * Rejects a pending destination: dismisses its active drafts (`archived:dismissed`, 7.1), then
 * removes it from the destinations list. Resolves with the drafts dismissed.
 */
export function rejectPendingDestination(
  id: string,
  deps: AgentDeps
): Promise<{ dismissed: number }> {
  return dismissAndRemove(
    id,
    deps,
    (snapshot) => pendingOf(snapshot, id),
    (d) => `Some drafts for ${d.label} could not be dismissed, so it stays pending`
  );
}

/**
 * Removes any destination, confirmed or pending, the way a rejection does: its active drafts are
 * dismissed first, then it leaves the list. Resolves with the drafts dismissed.
 */
export function removeDestination(id: string, deps: AgentDeps): Promise<{ dismissed: number }> {
  return dismissAndRemove(
    id,
    deps,
    (snapshot) => existingOf(snapshot, id),
    (d) => `Some drafts for ${d.label} could not be dismissed, so it stays`
  );
}

/** Spec 10.1 and 10.2's checks on an override, as a user-facing error. */
function checkedOverride(
  source: SiteDefinitionSource,
  site: string,
  override: JsonObject | null
): JsonObject | null {
  const checked = checkDestinationOverride(source.official(site), override);
  if (!checked.ok) throw new SetupError(`The override doesn't work: ${checked.error.message}`);
  return checked.value.override;
}

function cleanLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length > LABEL_MAX) {
    throw new SetupError(`Keep the label to ${LABEL_MAX} characters.`);
  }
  return trimmed;
}

/** The account as devices store it: trimmed, without the leading `@` handles are shown with. */
export const cleanAccount = (account: string): string => account.trim().replace(/^@/, '');

/** The site's name from its official definition, else its id. */
export function siteName(source: SiteDefinitionSource, site: string): string {
  const name = source.official(site)?.name;
  return typeof name === 'string' && name.trim() !== '' ? name : site;
}

/** The label a new destination gets when the user leaves it empty: `<site name> / <account>`. */
export const defaultLabel = (source: SiteDefinitionSource, site: string, account: string): string =>
  `${siteName(source, site)} / ${cleanAccount(account)}`.slice(0, LABEL_MAX);

export interface NewDestination {
  site: string;
  account: string;
  /** Empty or absent: {@link defaultLabel}. */
  label?: string;
  /** A partial definition merged over the official one (10.2); for a custom site, the whole. */
  override: JsonObject | null;
}

/**
 * Adds a confirmed destination. A site in the registry takes its official definition, with the
 * override over it; any other site is a custom destination, whose override must give at least
 * its `match` patterns (10.2). Refuses a site and account the list already has.
 */
export async function addDestination(
  input: NewDestination,
  source: SiteDefinitionSource,
  deps: AgentDeps
): Promise<Destination> {
  const site = input.site.trim();
  const account = cleanAccount(input.account);
  if (!SITE_ID.test(site)) {
    throw new SetupError(
      'A site id is lowercase letters and digits, with ".", "_" or "-" between them.'
    );
  }
  if (account === '') throw new SetupError('Enter the account.');
  const override = checkedOverride(source, site, input.override);
  const label = cleanLabel(input.label ?? '') || defaultLabel(source, site, account);
  const { pubkey, next, added } = await withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    const current = listOf(snapshot);
    const same = current.find((d) => d.site === site && sameAccount(d.account, account));
    if (same !== undefined) {
      throw new SetupError(
        same.status === 'pending'
          ? `${same.label} is already waiting for you under Agents; confirm it there.`
          : `${same.label} is already a destination.`
      );
    }
    let id = bytesToHex(randomBytes(16));
    while (current.some((d) => d.id === id)) id = bytesToHex(randomBytes(16));
    const added: Destination = { id, site, account, label, status: 'confirmed', override };
    const next = [...current, added];
    await publishDestinations(session, snapshot, next);
    return { pubkey: session.pubkey, next, added };
  });
  await updateCache(deps, pubkey, next);
  return added;
}

/**
 * Changes a destination's label and override; its site, account, status, id and any keys this
 * version does not know stay as they are.
 */
export async function editDestination(
  id: string,
  patch: { label: string; override: JsonObject | null },
  source: SiteDefinitionSource,
  deps: AgentDeps
): Promise<Destination> {
  const label = cleanLabel(patch.label);
  if (label === '') throw new SetupError('Enter a label.');
  const { pubkey, next, edited } = await withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    const existing = existingOf(snapshot, id);
    const override = checkedOverride(source, existing.site, patch.override);
    const edited: Destination = { ...existing, label, override };
    const next = listOf(snapshot).map((d) => (d.id === id ? edited : d));
    await publishDestinations(session, snapshot, next);
    return { pubkey: session.pubkey, next, edited };
  });
  await updateCache(deps, pubkey, next);
  return edited;
}

/** Every destination, confirmed and pending, read fresh from the storage relays. */
export async function loadDestinations(deps: AgentDeps): Promise<Destination[]> {
  return withQueue(deps, async (session) => listOf(await readQueue(session)));
}
