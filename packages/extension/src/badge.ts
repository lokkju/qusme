/**
 * The toolbar badge (spec 11.4): the number of active drafts, in the accent colour, or in the
 * attention colour when something needs the user: a pending destination an agent proposed, a
 * revocation qus.me hasn't confirmed, or an insertion not yet recorded on the storage relays.
 * Cleared while locked, since nothing can be read without the key. Counts only; no draft text.
 */
import { readPendingRevocations } from './agents/pendingRevocations.ts';
import { readInsertionState } from './insertion/armed.ts';
import {
  type KeyStore,
  LOCAL_PENDING_REVOCATIONS,
  SESSION_DRAFTS,
  SESSION_INSERTION,
  SESSION_UNLOCKED,
} from './keyStore.ts';
import { readDraftCache } from './sync/state.ts';

/** The popup's accent and danger colours (`entrypoints/popup/style.css`) as hex for the API. */
export const BADGE_COLOR = '#1F6FEB';
export const BADGE_ATTENTION_COLOR = '#C4320A';

export interface BadgeInput {
  unlocked: boolean;
  activeDrafts: number;
  pendingDestinations: number;
  pendingRevocations: number;
  unrecordedInsertions: number;
}

export interface Badge {
  text: string;
  color: string;
  /** For the action's title, so the badge is not the only place the reason shows. */
  title: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function badgeFor(input: BadgeInput): Badge {
  if (!input.unlocked) return { text: '', color: BADGE_COLOR, title: 'qus.me (locked)' };
  const reasons: string[] = [];
  if (input.pendingDestinations > 0)
    reasons.push(plural(input.pendingDestinations, 'new destination', 'new destinations'));
  if (input.pendingRevocations > 0)
    reasons.push(`${plural(input.pendingRevocations, 'revocation', 'revocations')} unfinished`);
  if (input.unrecordedInsertions > 0)
    reasons.push(`${plural(input.unrecordedInsertions, 'insertion', 'insertions')} not recorded`);
  const needsYou = reasons.length > 0;
  const count = input.activeDrafts;
  const text = count > 99 ? '99+' : count > 0 ? String(count) : needsYou ? '!' : '';
  const drafts = plural(count, 'draft', 'drafts');
  return {
    text,
    color: needsYou ? BADGE_ATTENTION_COLOR : BADGE_COLOR,
    title: needsYou ? `qus.me: ${drafts}; ${reasons.join(', ')}` : `qus.me: ${drafts}`,
  };
}

/** Reads what the badge counts from the extension's storage. */
export async function readBadgeInput(
  store: Pick<KeyStore, 'status' | 'local' | 'session'>
): Promise<BadgeInput> {
  const status = await store.status();
  if (status.state !== 'unlocked') {
    return {
      unlocked: false,
      activeDrafts: 0,
      pendingDestinations: 0,
      pendingRevocations: 0,
      unrecordedInsertions: 0,
    };
  }
  const [cache, insertion, revocations] = await Promise.all([
    readDraftCache(store.session),
    readInsertionState(store.session),
    readPendingRevocations(store, status.pubkey),
  ]);
  return {
    unlocked: true,
    activeDrafts: (cache?.drafts ?? []).filter((d) => d.status === 'active').length,
    pendingDestinations: (cache?.destinations ?? []).filter((d) => d.status === 'pending').length,
    pendingRevocations: revocations.length,
    unrecordedInsertions: insertion.unrecorded.length,
  };
}

/** The storage keys whose changes can change the badge. */
export const BADGE_KEYS = {
  session: [SESSION_UNLOCKED, SESSION_DRAFTS, SESSION_INSERTION],
  local: [LOCAL_PENDING_REVOCATIONS],
} as const;

export function changesBadge(changes: Record<string, unknown>, area: string): boolean {
  const keys: readonly string[] =
    area === 'session' ? BADGE_KEYS.session : area === 'local' ? BADGE_KEYS.local : [];
  return keys.some((k) => k in changes);
}

/** The part of `browser.action` the badge uses. */
export interface BadgeAction {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setTitle(details: { title: string }): Promise<void>;
}

/** Sets the badge from storage, one update at a time so a slow read can't overwrite a newer one. */
export function badgeUpdater(
  store: Pick<KeyStore, 'status' | 'local' | 'session'>,
  action: BadgeAction
): () => Promise<void> {
  let queue = Promise.resolve();
  return () => {
    queue = queue
      .then(async () => {
        const badge = badgeFor(await readBadgeInput(store));
        await action.setBadgeBackgroundColor({ color: badge.color });
        await action.setBadgeText({ text: badge.text });
        await action.setTitle({ title: badge.title });
      })
      .catch(() => undefined);
    return queue;
  };
}
