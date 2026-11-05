import type { UnsignedEvent } from 'nostr-tools/core';
import { getEventHash } from 'nostr-tools/pure';

/** NIP-13 difficulty of an event id: its leading zero bits. */
export function powOf(id: string): number {
  let bits = 0;
  for (const char of id) {
    const nibble = Number.parseInt(char, 16);
    if (Number.isNaN(nibble)) return bits;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    return bits + Math.clz32(nibble) - 28;
  }
  return bits;
}

/**
 * Adds a NIP-13 `nonce` tag to `event` and raises its counter until the event id has at least
 * `difficulty` leading zero bits. Returns a copy with the tag; `created_at` is left as it is,
 * unlike nostr-tools' `minePow`, which resets it to the clock and would undo NIP-59's randomized
 * timestamp. Synchronous: about 2^difficulty hashes on average.
 */
export function minePow(event: UnsignedEvent, difficulty: number): UnsignedEvent {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new Error('difficulty must be an integer from 0 to 256');
  }
  const tag = ['nonce', '0', String(difficulty)];
  const mined: UnsignedEvent = { ...event, tags: [...event.tags, tag] };
  for (let nonce = 0; ; nonce++) {
    tag[1] = String(nonce);
    if (powOf(getEventHash(mined)) >= difficulty) return mined;
  }
}
