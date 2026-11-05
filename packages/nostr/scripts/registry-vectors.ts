/**
 * Writes test/vectors/registry-snapshot.vectors.json: snapshots in the registry's
 * `qusme-registry-snapshot/1` format, signed with throwaway keys, and whether a consumer pinning
 * `publisher` must accept each. lokkju/qusme-registry's `verifySnapshot` and this package's
 * `verifyRegistrySnapshot` agree on every case; copy the file there to check that side.
 * Schnorr signatures are randomized, so rerunning changes every id and signature but no verdict.
 *   node scripts/registry-vectors.ts
 */
import { writeFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
  KIND_RELAY_LIST,
  KIND_SITE_DEF,
  type NostrEvent,
  REGISTRY_SNAPSHOT_FORMAT,
} from '../src/index.ts';

// Test-only keys, never used for anything real.
const PUBLISHER_KEY = hexToBytes(
  '5c1c4f0e2a7b3d9e8f6a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6'
);
const OTHER_KEY = hexToBytes('9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b');
const publisher = getPublicKey(PUBLISHER_KEY);
const CREATED_AT = 1_793_836_800; // 2026-11-05

const example = {
  id: 'example',
  version: '2026.11.1',
  name: 'Example (local test page)',
  match: ['http://localhost/*', 'http://127.0.0.1/*'],
  account: {
    locator: { role: 'status', name: { en: ['Signed in'] } },
    extract: 'Signed in as @([A-Za-z0-9_]{1,15})',
  },
  intents: { compose: '{origin}/test/fixtures/example/?text={text}' },
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'], de: ['Beitragstext'] } }],
      inject: ['paste', 'insertText', 'native', 'clipboard'],
      constraints: { maxLength: 280, counter: 'default' },
    },
  ],
};
const other = { ...example, id: 'other', name: 'Other', match: ['https://other.example/*'] };

const siteDef = (definition: typeof example, key = PUBLISHER_KEY): NostrEvent =>
  finalizeEvent(
    {
      kind: KIND_SITE_DEF,
      created_at: CREATED_AT,
      tags: [
        ['d', definition.id],
        ['alt', `qus.me site definition: ${definition.name} ${definition.version}`],
      ],
      content: JSON.stringify(definition),
    },
    key
  );
const relayList = (key = PUBLISHER_KEY): NostrEvent =>
  finalizeEvent(
    {
      kind: KIND_RELAY_LIST,
      created_at: CREATED_AT,
      tags: [
        ['r', 'wss://nos.lol'],
        ['r', 'wss://relay.ditto.pub'],
      ],
      content: '',
    },
    key
  );
const snapshot = (fields: Record<string, unknown> = {}) => ({
  format: REGISTRY_SNAPSHOT_FORMAT,
  publisher,
  relayList: relayList(),
  siteDefinitions: [siteDef(example), siteDef(other)],
  ...fields,
});

const good = snapshot();
const [first, second] = good.siteDefinitions as [NostrEvent, NostrEvent];
const otherPubkey = getPublicKey(OTHER_KEY);

const cases = [
  { name: 'good', valid: true, snapshot: good },
  { name: 'no definitions', valid: true, snapshot: snapshot({ siteDefinitions: [] }) },
  {
    name: 'tampered definition content',
    valid: false,
    snapshot: {
      ...good,
      siteDefinitions: [{ ...first, content: first.content.replace('280', '2800') }, second],
    },
  },
  {
    name: 'tampered definition tag',
    valid: false,
    snapshot: {
      ...good,
      siteDefinitions: [{ ...first, tags: [...first.tags, ['t', 'x']] }, second],
    },
  },
  {
    name: 'definition signed by another key',
    valid: false,
    snapshot: snapshot({ siteDefinitions: [siteDef(example, OTHER_KEY), second] }),
  },
  {
    name: 'definition with the pinned pubkey and another key signature',
    valid: false,
    snapshot: {
      ...good,
      siteDefinitions: [{ ...first, sig: siteDef(example, OTHER_KEY).sig }, second],
    },
  },
  {
    name: 'whole snapshot re-signed by another key',
    valid: false,
    snapshot: {
      format: REGISTRY_SNAPSHOT_FORMAT,
      publisher: otherPubkey,
      relayList: relayList(OTHER_KEY),
      siteDefinitions: [siteDef(example, OTHER_KEY), siteDef(other, OTHER_KEY)],
    },
  },
  {
    name: 'relay list signed by another key',
    valid: false,
    snapshot: snapshot({ relayList: relayList(OTHER_KEY) }),
  },
  {
    name: 'tampered relay list',
    valid: false,
    snapshot: {
      ...good,
      relayList: { ...good.relayList, tags: [['r', 'wss://evil.example']] },
    },
  },
  {
    name: 'wrong format',
    valid: false,
    snapshot: snapshot({ format: 'qusme-registry-snapshot/2' }),
  },
  { name: 'repeated site', valid: false, snapshot: snapshot({ siteDefinitions: [first, first] }) },
];

const out = {
  description:
    'qusme-registry-snapshot/1 vectors, written by packages/nostr/scripts/registry-vectors.ts in ' +
    'lokkju/qusme. Verify each snapshot against `publisher`; `valid` says whether it must pass.',
  publisher,
  cases,
};
writeFileSync(
  new URL('../test/vectors/registry-snapshot.vectors.json', import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`
);
