/**
 * The Queue ID the user passes once with `--queue`: the queue's npub, as the extension shows it,
 * or an nprofile whose relay hints name the inbox relay (the extension's "Approve an agent"
 * screen offers that form, ready to paste). The local server can't learn the inbox relay from
 * the queue itself: the queue's relays live in its kind 10013 and settings, both encrypted to the
 * queue key (7.2, 9.1), and nothing the queue publishes names them in the clear.
 */
import { decode } from 'nostr-tools/nip19';

/** The inbox relay a queue gets when setup isn't told otherwise (the extension's default, 9.1). */
export const DEFAULT_INBOX_RELAYS: readonly string[] = ['wss://auth.nostr1.com'];

export interface QueueId {
  pubkey: string;
  /** Relay hints from an nprofile; empty for an npub or hex. */
  relays: string[];
}

/** Reads `--queue`: npub, nprofile or 64 hex characters. Throws with a message for the user. */
export function parseQueueId(input: string): QueueId {
  const text = input.trim().replace(/^nostr:/, '');
  if (/^[0-9a-f]{64}$/.test(text)) return { pubkey: text, relays: [] };
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(text);
  } catch {
    throw new Error('--queue must be your Queue ID: the npub1… the qus.me extension shows');
  }
  if (decoded.type === 'npub') return { pubkey: decoded.data, relays: [] };
  if (decoded.type === 'nprofile') {
    const relays = (decoded.data.relays ?? []).filter((r) => /^wss:\/\//.test(r));
    return { pubkey: decoded.data.pubkey, relays };
  }
  throw new Error('--queue must be an npub1… or nprofile1… Queue ID, not an nsec or other key');
}
