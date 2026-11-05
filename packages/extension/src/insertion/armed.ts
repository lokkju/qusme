/**
 * The armed draft and the insertion bookkeeping, in `storage.session` only (spec 11.5): one
 * armed draft at a time; insertions that answered `waiting` until the page reports back; and
 * insertions that went into the page but could not yet be recorded on the storage relays. Lock
 * deletes all of it with the keys.
 */
import type { Insertion } from '@qusme/nostr';
import { SESSION_ARMED, SESSION_INSERTION } from '../keyStore.ts';
import type { StorageArea } from '../storage.ts';
import type { CachedDraft } from '../sync/state.ts';
import type { InsertMethod } from './protocol.ts';

export interface ArmedDraft {
  d: string;
  site: string;
  account: string;
  field: string;
  destination?: string;
  /** The value as it was when armed; this exact text is what goes into the page. */
  content: string;
  /** Unix seconds. */
  armedAt: number;
}

export interface PendingInsertion {
  token: string;
  tabId: number;
  d: string;
  method: InsertMethod;
  /** Unix seconds. */
  startedAt: number;
}

export interface UnrecordedInsertion {
  d: string;
  insertion: Insertion;
}

export interface InsertionState {
  pending?: PendingInsertion;
  unrecorded: UnrecordedInsertion[];
}

export async function readArmed(session: StorageArea): Promise<ArmedDraft | undefined> {
  const value = (await session.get([SESSION_ARMED]))[SESSION_ARMED];
  if (typeof value !== 'object' || value === null) return undefined;
  const armed = value as ArmedDraft;
  return typeof armed.d === 'string' && typeof armed.content === 'string' ? armed : undefined;
}

/** Arms `draft`, replacing whatever was armed. */
export async function arm(
  session: StorageArea,
  draft: CachedDraft,
  now: number
): Promise<ArmedDraft> {
  const armed: ArmedDraft = {
    d: draft.d,
    site: draft.site,
    account: draft.account,
    field: draft.field,
    content: draft.content,
    armedAt: now,
  };
  if (draft.destination !== undefined) armed.destination = draft.destination;
  await session.set({ [SESSION_ARMED]: armed });
  return armed;
}

/** Disarms; with `d`, only if that draft is still the armed one. */
export async function disarm(session: StorageArea, d?: string): Promise<void> {
  if (d !== undefined && (await readArmed(session))?.d !== d) return;
  await session.remove([SESSION_ARMED]);
}

export async function readInsertionState(session: StorageArea): Promise<InsertionState> {
  const value = (await session.get([SESSION_INSERTION]))[SESSION_INSERTION];
  if (typeof value !== 'object' || value === null) return { unrecorded: [] };
  const state = value as InsertionState;
  return Array.isArray(state.unrecorded) ? state : { ...state, unrecorded: [] };
}

export async function writeInsertionState(
  session: StorageArea,
  state: InsertionState
): Promise<void> {
  await session.set({ [SESSION_INSERTION]: state });
}

const TITLE_CHARS = 40;

/**
 * The context menu title (step 4): "Insert: " and the draft's first 40 characters (code points,
 * whitespace collapsed), with "…" when cut. `%s` would be replaced by the selection, so it is
 * broken with a zero-width space; `&` marks an access key in Firefox's menus (`accessKeys`), so
 * there it is doubled.
 */
export function menuTitle(
  armed: Pick<ArmedDraft, 'content'> | undefined,
  options: { accessKeys?: boolean } = {}
): string {
  if (armed === undefined) return 'qus.me: choose a draft to insert…';
  const text = armed.content.replace(/\s+/g, ' ').trim();
  const chars = [...text];
  const head = chars.slice(0, TITLE_CHARS).join('');
  const shown = chars.length > TITLE_CHARS ? `${head}…` : head;
  const safe = shown.replace(/%s/g, '%\u200bs');
  return `Insert: ${options.accessKeys ? safe.replace(/&/g, '&&') : safe}`;
}
