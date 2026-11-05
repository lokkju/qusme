/**
 * The relay checks of spec 9.1, run before a device saves a relay in either role. Each probe uses
 * throwaway keys only, so nothing it publishes is linked to the queue, and it cleans up after
 * itself (NIP-09 deletion; the gift wrap also carries a short NIP-40 expiration, since the one
 * free inbox relay ignores a recipient's deletion).
 *
 * The result names every check and the first that failed, so the UI can refuse the relay with the
 * failing check named.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'nostr-tools/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DELETION,
  KIND_DRAFT_WRAP,
  KIND_FIELD_VALUE,
  KIND_GIFT_WRAP,
  KIND_PRIVATE_RELAYS,
  KIND_SUBMITTERS,
} from './kinds.ts';
import { giftWrap } from './nip59.ts';
import { type RelayClientOptions, RelayConnection, RelayError } from './relayClient.ts';
import { createLocalSigner } from './signer.ts';

declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** The kinds a storage relay must take without AUTH (spec 9.1). */
export const STORAGE_KINDS: readonly number[] = [
  KIND_DRAFT_WRAP,
  KIND_APP_DATA,
  KIND_PRIVATE_RELAYS,
  KIND_SUBMITTERS,
  KIND_AGENT_GRANT,
];

/**
 * The size of the large event a storage relay must accept, as event JSON bytes. Spec 9.1 says
 * events up to 64 KiB; strfry's default `maxEventSize` is 65536 for the whole event, so the probe
 * stays a little under it.
 */
export const PROBE_LARGE_EVENT_BYTES = 65_000;

export type RelayRole = 'storage' | 'inbox';

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProbeResult {
  url: string;
  role: RelayRole;
  ok: boolean;
  checks: ProbeCheck[];
  /** The first check that failed. */
  failed?: ProbeCheck;
}

export interface ProbeOptions extends Omit<RelayClientOptions, 'autoAuth'> {
  /** Milliseconds to wait between a write and the read that checks it; default 500. */
  settleMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const reasonOf = (error: unknown): string =>
  error instanceof RelayError ? error.reason : (error as Error).message;

class Checks {
  readonly list: ProbeCheck[] = [];
  pass(name: string): void {
    this.list.push({ name, ok: true });
  }
  fail(name: string, detail: string): void {
    this.list.push({ name, ok: false, detail });
  }
  result(url: string, role: RelayRole): ProbeResult {
    const failed = this.list.find((c) => !c.ok);
    const result: ProbeResult = { url, role, ok: failed === undefined, checks: this.list };
    if (failed !== undefined) result.failed = failed;
    return result;
  }
}

function probeTag(): string {
  return `qus.me/probe-${bytesToHex(randomBytes(6))}`;
}

/** A kind 31234 event from `key` whose JSON is exactly `bytes` long. */
async function largeEvent(
  signer: ReturnType<typeof createLocalSigner>,
  bytes: number
): Promise<NostrEvent> {
  const template = (content: string) => ({
    kind: KIND_DRAFT_WRAP,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', probeTag()],
      ['k', String(KIND_FIELD_VALUE)],
    ],
    content,
  });
  const empty = await signer.signEvent(template(''));
  const padding = Math.max(0, bytes - JSON.stringify(empty).length);
  return signer.signEvent(template('x'.repeat(padding)));
}

/**
 * Checks a storage relay (spec 9.1): publishes each queue kind and a 64 KiB event without AUTH,
 * reads each back, deletes them with NIP-09 and checks the deletion was honored.
 */
export async function probeStorageRelay(
  url: string,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const checks = new Checks();
  const key = generateSecretKey();
  const signer = createLocalSigner(key);
  key.fill(0);
  let connection: RelayConnection;
  try {
    connection = await RelayConnection.open(url, options);
    checks.pass('connects');
  } catch (error) {
    checks.fail('connects', reasonOf(error));
    return checks.result(url, 'storage');
  }
  try {
    const published: NostrEvent[] = [];
    for (const kind of STORAGE_KINDS) {
      const event = await signer.signEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', probeTag()]],
        content: 'qus.me relay probe',
      });
      try {
        await connection.publish(event);
        published.push(event);
        checks.pass(`accepts kind ${kind} without AUTH`);
      } catch (error) {
        checks.fail(`accepts kind ${kind} without AUTH`, reasonOf(error));
      }
    }
    const large = await largeEvent(signer, PROBE_LARGE_EVENT_BYTES);
    try {
      await connection.publish(large);
      published.push(large);
      checks.pass('accepts a 64 KiB event');
    } catch (error) {
      checks.fail('accepts a 64 KiB event', reasonOf(error));
    }
    if (published.length === 0) return checks.result(url, 'storage');

    await sleep(options.settleMs ?? 500);
    const ids = published.map((e) => e.id);
    try {
      const found = new Set((await connection.query([{ ids }])).map((e) => e.id));
      for (const event of published) {
        const name =
          event === large ? 'serves the 64 KiB event back' : `serves kind ${event.kind} back`;
        if (found.has(event.id)) checks.pass(name);
        else checks.fail(name, 'not returned by a read');
      }
    } catch (error) {
      checks.fail('serves the events back', reasonOf(error));
    }

    const deletion = await signer.signEvent({
      kind: KIND_DELETION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...ids.map((id) => ['e', id]),
        ...[...new Set(published.map((e) => e.kind))].map((k) => ['k', String(k)]),
      ],
      content: '',
    });
    try {
      await connection.publish(deletion);
      checks.pass('accepts a NIP-09 deletion');
      await sleep(options.settleMs ?? 500);
      const left = await connection.query([{ ids }]);
      if (left.length === 0) checks.pass('honors NIP-09 deletion');
      else checks.fail('honors NIP-09 deletion', `${left.length} deleted events still served`);
    } catch (error) {
      checks.fail('honors NIP-09 deletion', reasonOf(error));
    }
    return checks.result(url, 'storage');
  } finally {
    connection.close();
  }
}

/**
 * Checks an inbox relay (spec 9.1): publishes a gift wrap to a throwaway recipient and confirms
 * that an unauthenticated read and a read authenticated as another throwaway key return nothing,
 * and that a read authenticated as the recipient returns it.
 */
export async function probeInboxRelay(
  url: string,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const checks = new Checks();
  const keys = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
  const [sender, recipient, other] = keys.map((k) => createLocalSigner(k)) as [
    ReturnType<typeof createLocalSigner>,
    ReturnType<typeof createLocalSigner>,
    ReturnType<typeof createLocalSigner>,
  ];
  const recipientPubkey = getPublicKey(keys[1] as Uint8Array);
  for (const k of keys) k.fill(0);
  const connections: RelayConnection[] = [];
  const open = async (auth?: typeof sender): Promise<RelayConnection> => {
    const connection = await RelayConnection.open(url, {
      ...options,
      ...(auth && { autoAuth: (t) => auth.signEvent(t) }),
    });
    connections.push(connection);
    return connection;
  };
  try {
    let writer: RelayConnection;
    try {
      writer = await open(sender);
      checks.pass('connects');
    } catch (error) {
      checks.fail('connects', reasonOf(error));
      return checks.result(url, 'inbox');
    }
    const now = Math.floor(Date.now() / 1000);
    const wrap = await giftWrap(
      { kind: KIND_FIELD_VALUE, content: 'qus.me relay probe' },
      sender,
      recipientPubkey,
      { expiration: now + 600 }
    );
    try {
      await writer.publish(wrap);
      checks.pass('accepts a gift wrap');
    } catch (error) {
      checks.fail('accepts a gift wrap', reasonOf(error));
      return checks.result(url, 'inbox');
    }
    await sleep(options.settleMs ?? 500);
    const filter = { kinds: [KIND_GIFT_WRAP], '#p': [recipientPubkey] };

    try {
      const anonymous = await open();
      const events = await anonymous.query([filter]).catch(() => [] as NostrEvent[]);
      if (events.some((e) => e.id === wrap.id)) {
        checks.fail('hides gift wraps from unauthenticated reads', 'returned the wrap');
      } else checks.pass('hides gift wraps from unauthenticated reads');
    } catch (error) {
      checks.fail('hides gift wraps from unauthenticated reads', reasonOf(error));
    }

    try {
      const stranger = await open();
      await stranger.authenticate((t) => other.signEvent(t));
      checks.pass('supports NIP-42 AUTH');
      const events = await stranger.query([filter]).catch(() => [] as NostrEvent[]);
      if (events.some((e) => e.id === wrap.id)) {
        checks.fail('hides gift wraps from other authenticated keys', 'returned the wrap');
      } else checks.pass('hides gift wraps from other authenticated keys');
    } catch (error) {
      checks.fail('supports NIP-42 AUTH', reasonOf(error));
      return checks.result(url, 'inbox');
    }

    try {
      const reader = await open(recipient);
      await reader.authenticate((t) => recipient.signEvent(t));
      const events = await reader.query([filter]);
      if (events.some((e) => e.id === wrap.id))
        checks.pass('serves the gift wrap to its recipient');
      else checks.fail('serves the gift wrap to its recipient', 'not returned');
      // Best effort: the NIP-40 expiration removes it where the relay ignores this (NIP-17).
      const deletion = await recipient.signEvent({
        kind: KIND_DELETION,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', wrap.id],
          ['k', String(KIND_GIFT_WRAP)],
        ],
        content: '',
      });
      await reader.publish(deletion).catch(() => undefined);
    } catch (error) {
      checks.fail('serves the gift wrap to its recipient', reasonOf(error));
    }
    return checks.result(url, 'inbox');
  } finally {
    for (const connection of connections) connection.close();
  }
}

/** Runs the probe for a role. */
export function probeRelay(
  url: string,
  role: RelayRole,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  return role === 'storage' ? probeStorageRelay(url, options) : probeInboxRelay(url, options);
}
