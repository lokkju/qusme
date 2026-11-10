import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { UnsignedEvent } from 'nostr-tools/core';
import { getEventHash, serializeEvent } from 'nostr-tools/pure';

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

/** What {@link minePow} may spend. */
export interface MineOptions {
  /**
   * Most bytes of serialized event to hash before giving up; unbounded when absent. Each attempt
   * hashes the whole event, so the work is about 2^difficulty times its size: an event whose
   * expected work alone exceeds the budget is refused before the first hash. A count of bytes,
   * not a clock, because workerd's clock stands still while a request computes.
   */
  maxBytes?: number;
}

/** {@link minePow} ran out of its budget, or would have on average, before reaching `difficulty`. */
export class PowBudgetExceeded extends Error {
  readonly difficulty: number;
  /** The event's serialized size, hashed once per attempt. */
  readonly eventBytes: number;
  readonly maxBytes: number;
  /** Attempts made; 0 when the expected work alone exceeded the budget. */
  readonly hashes: number;
  constructor(difficulty: number, eventBytes: number, maxBytes: number, hashes: number) {
    super(
      `${difficulty} bits of proof of work on a ${eventBytes}-byte event need about ` +
        `${2 ** difficulty * eventBytes} bytes hashed, against a budget of ${maxBytes}`
    );
    this.name = 'PowBudgetExceeded';
    this.difficulty = difficulty;
    this.eventBytes = eventBytes;
    this.maxBytes = maxBytes;
    this.hashes = hashes;
  }
}

/**
 * Adds a NIP-13 `nonce` tag to `event` and raises its counter until the event id has at least
 * `difficulty` leading zero bits. Returns a copy with the tag; `created_at` is left as it is,
 * unlike nostr-tools' `minePow`, which resets it to the clock and would undo NIP-59's randomized
 * timestamp. Synchronous: about 2^difficulty hashes on average, each over the whole serialized
 * event. With `maxBytes`, throws {@link PowBudgetExceeded} rather than hash more than that.
 */
export function minePow(
  event: UnsignedEvent,
  difficulty: number,
  options: MineOptions = {}
): UnsignedEvent {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new Error('difficulty must be an integer from 0 to 256');
  }
  const tag = ['nonce', '0', String(difficulty)];
  const mined: UnsignedEvent = { ...event, tags: [...event.tags, tag] };
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const eventBytes = utf8ToBytes(serializeEvent(mined)).length;
  if (2 ** difficulty * eventBytes > maxBytes) {
    throw new PowBudgetExceeded(difficulty, eventBytes, maxBytes, 0);
  }
  for (let nonce = 0; ; nonce++) {
    if ((nonce + 1) * eventBytes > maxBytes) {
      throw new PowBudgetExceeded(difficulty, eventBytes, maxBytes, nonce);
    }
    tag[1] = String(nonce);
    if (powOf(getEventHash(mined)) >= difficulty) return mined;
  }
}
