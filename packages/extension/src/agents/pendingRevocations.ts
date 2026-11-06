/**
 * Revocations the service has not confirmed yet (spec 11.8). A revocation takes effect on the
 * user's devices once the submitters list without the agent is out, but until the service revokes
 * the binding the agent's client still holds a working token; on a relay that ignored the grant's
 * deletion, the service would then keep accepting its drafts for devices to discard. So a
 * revocation is recorded here, in `storage.local` under {@link LOCAL_PENDING_REVOCATIONS}, as soon
 * as the list is out, and cleared only when the service answers `DELETE /device/bindings` with
 * revoked or not bound. Each sync retries what is left (11.4).
 *
 * Pubkeys, the label from the submitters list and the last error only; no key material.
 */
import { createLocalSigner } from '@qusme/nostr';
import { type KeyStore, LOCAL_PENDING_REVOCATIONS } from '../keyStore.ts';
import { SetupError } from '../setup/deps.ts';
import { deleteBinding, type ServiceDeps } from './service.ts';

export interface PendingRevocation {
  queuePubkey: string;
  agentPubkey: string;
  /** The agent's label from the submitters list, so the row can still be named. */
  label?: string;
  /** Unix seconds, when the device revoked it. */
  since: number;
  /** Why the last attempt to tell the service failed, written for the user. */
  lastError?: string;
}

type Store = Pick<KeyStore, 'local'>;
type FinishDeps = ServiceDeps & { store: Pick<KeyStore, 'local' | 'unlocked'> };

const HEX64 = /^[0-9a-f]{64}$/;

function readItem(value: unknown): PendingRevocation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.queuePubkey !== 'string' || !HEX64.test(v.queuePubkey)) return undefined;
  if (typeof v.agentPubkey !== 'string' || !HEX64.test(v.agentPubkey)) return undefined;
  if (typeof v.since !== 'number') return undefined;
  const item: PendingRevocation = {
    queuePubkey: v.queuePubkey,
    agentPubkey: v.agentPubkey,
    since: v.since,
  };
  if (typeof v.label === 'string') item.label = v.label;
  if (typeof v.lastError === 'string') item.lastError = v.lastError;
  return item;
}

/** Every pending revocation, or only the queue's. */
export async function readPendingRevocations(
  store: Store,
  queuePubkey?: string
): Promise<PendingRevocation[]> {
  const value = (await store.local.get([LOCAL_PENDING_REVOCATIONS]))[LOCAL_PENDING_REVOCATIONS];
  const items = Array.isArray(value) ? value.map(readItem) : [];
  return items.filter(
    (i): i is PendingRevocation =>
      i !== undefined && (queuePubkey === undefined || i.queuePubkey === queuePubkey)
  );
}

async function write(store: Store, items: PendingRevocation[]): Promise<void> {
  if (items.length === 0) await store.local.remove([LOCAL_PENDING_REVOCATIONS]);
  else await store.local.set({ [LOCAL_PENDING_REVOCATIONS]: items });
}

const same = (a: PendingRevocation, queuePubkey: string, agentPubkey: string) =>
  a.queuePubkey === queuePubkey && a.agentPubkey === agentPubkey;

/** Records a revocation as pending, replacing an earlier record of the same agent. */
export async function addPendingRevocation(store: Store, item: PendingRevocation): Promise<void> {
  const items = await readPendingRevocations(store);
  const kept = items.filter((i) => !same(i, item.queuePubkey, item.agentPubkey));
  await write(store, [...kept, item]);
}

export async function removePendingRevocation(
  store: Store,
  queuePubkey: string,
  agentPubkey: string
): Promise<void> {
  const items = await readPendingRevocations(store);
  const kept = items.filter((i) => !same(i, queuePubkey, agentPubkey));
  if (kept.length !== items.length) await write(store, kept);
}

async function noteFailure(store: Store, queuePubkey: string, agentPubkey: string, error: string) {
  const items = await readPendingRevocations(store);
  const item = items.find((i) => same(i, queuePubkey, agentPubkey));
  if (item === undefined) return;
  item.lastError = error;
  await write(store, items);
}

/**
 * Tells the service to revoke the agent, NIP-98 signed by the unlocked queue key, and clears the
 * pending record when it answers revoked or not bound. Otherwise keeps the record with the error
 * and throws {@link SetupError}.
 */
export async function finishRevocation(
  agentPubkey: string,
  deps: FinishDeps
): Promise<'revoked' | 'not_bound'> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
  const queuePubkey = unlocked.record.pubkey;
  try {
    const answer = await deleteBinding(createLocalSigner(unlocked.queueKey), agentPubkey, deps);
    await removePendingRevocation(deps.store, queuePubkey, agentPubkey);
    return answer;
  } catch (error) {
    const message =
      error instanceof SetupError ? error.message : 'Could not reach the qus.me service.';
    await noteFailure(deps.store, queuePubkey, agentPubkey, message);
    throw new SetupError(message);
  }
}

/**
 * Retries every pending revocation of the unlocked queue; the sync runs it (11.4). Never throws.
 * Returns how many the service confirmed and how many are left.
 */
export async function finishPendingRevocations(
  deps: FinishDeps
): Promise<{ finished: number; remaining: number }> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) return { finished: 0, remaining: 0 };
  const items = await readPendingRevocations(deps.store, unlocked.record.pubkey);
  let finished = 0;
  for (const item of items) {
    try {
      await finishRevocation(item.agentPubkey, deps);
      finished += 1;
    } catch {}
  }
  return { finished, remaining: items.length - finished };
}
