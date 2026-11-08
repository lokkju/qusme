/**
 * Demo queue events for the store screenshots (scripts/store-screenshots/capture.py): a settings
 * event and a destinations event, signed and encrypted with a fixed demo queue key by the same
 * builders the extension uses. Prints JSON on stdout; capture.py serves the events from a local
 * relay and seeds the extension's storage with the keys.
 *
 * Run: node scripts/store-screenshots/seed.ts ws://127.0.0.1:PORT
 */
import { sha256 } from '../../packages/nostr/node_modules/@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '../../packages/nostr/node_modules/@noble/hashes/utils.js';
import { getPublicKey } from '../../packages/nostr/node_modules/nostr-tools/lib/esm/pure.js';
import {
  buildDestinations,
  buildSettings,
  createLocalSigner,
  type Destination,
} from '../../packages/nostr/src/index.ts';

const relay = process.argv[2] ?? 'ws://127.0.0.1:7777';
// Fixed demo keys, so a rerun produces the same queue. Not used anywhere but these screenshots.
const queueKey = sha256(utf8ToBytes('qus.me store screenshots: queue key'));
const inboxKey = sha256(utf8ToBytes('qus.me store screenshots: inbox key'));
const queue = createLocalSigner(queueKey);

export const DESTINATIONS: Destination[] = [
  {
    id: 'dest-x',
    site: 'x',
    account: 'lanternworks',
    label: 'X / @lanternworks',
    status: 'confirmed',
    override: null,
  },
  {
    id: 'dest-linkedin',
    site: 'linkedin.com',
    account: 'Lantern Works',
    label: 'LinkedIn / Lantern Works',
    status: 'confirmed',
    override: null,
  },
  {
    id: 'dest-mastodon',
    site: 'mastodon.social',
    account: 'lanternworks',
    label: 'Mastodon / @lanternworks',
    status: 'confirmed',
    override: null,
  },
];

const settings = await buildSettings(queue, {
  inbox_key: bytesToHex(inboxKey),
  inbox_relays: [relay],
  quota_counts: {},
});
const destinations = await buildDestinations(queue, { destinations: DESTINATIONS });

process.stdout.write(
  JSON.stringify({
    queueKey: bytesToHex(queueKey),
    inboxKey: bytesToHex(inboxKey),
    pubkey: getPublicKey(queueKey),
    settings,
    destinations,
    destinationList: DESTINATIONS,
  })
);
