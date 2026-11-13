/**
 * What the local server remembers between runs, in `state.json` (mode 0600): the queue it is
 * approved for, where its inbox and storage relays are, and the approval request it is waiting
 * on. Nothing secret: the agent key is in its own file.
 */
import { join } from 'node:path';
import { readJson, writeJson } from './files.ts';

export const STATE_FILE = 'state.json';

export interface PendingRequest {
  /** Canonical code, 8 Crockford base32 characters. */
  code: string;
  expires_at: number;
  client_name: string;
  /** When the request went to the inbox relay; absent until it has. */
  published_at?: number;
}

export interface LocalState {
  version: 1;
  queue_pubkey: string;
  inbox_relays: string[];
  /** The queue's storage relays, from the approval's answer and then from each newer grant. */
  storage_relays?: string[];
  /** The `created_at` of the grant whose `storage` the relays last moved to, or null. */
  storage_grant_at?: number | null;
  request?: PendingRequest;
  /** When the user last denied this agent's request. */
  denied_at?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The state in `dir`, or undefined if there is none or it is not one this build reads. */
export function readState(dir: string): LocalState | undefined {
  const value = readJson(join(dir, STATE_FILE)) as Partial<LocalState> | undefined;
  if (value === undefined || value.version !== 1) return undefined;
  if (typeof value.queue_pubkey !== 'string' || !HEX64.test(value.queue_pubkey)) return undefined;
  if (!isStrings(value.inbox_relays)) return undefined;
  const state: LocalState = {
    version: 1,
    queue_pubkey: value.queue_pubkey,
    inbox_relays: value.inbox_relays,
  };
  if (isStrings(value.storage_relays) && value.storage_relays.length > 0) {
    state.storage_relays = value.storage_relays;
    state.storage_grant_at =
      typeof value.storage_grant_at === 'number' ? value.storage_grant_at : null;
  }
  const r = value.request;
  if (
    r !== undefined &&
    typeof r.code === 'string' &&
    typeof r.expires_at === 'number' &&
    typeof r.client_name === 'string'
  ) {
    state.request = { code: r.code, expires_at: r.expires_at, client_name: r.client_name };
    if (typeof r.published_at === 'number') state.request.published_at = r.published_at;
  }
  if (typeof value.denied_at === 'number') state.denied_at = value.denied_at;
  return state;
}

export function writeState(dir: string, state: LocalState): void {
  writeJson(join(dir, STATE_FILE), state);
}
