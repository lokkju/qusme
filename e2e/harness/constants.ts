/** Names the harness and the tests share. */

/** The service origin the extension is built with; Chromium maps it to the harness. */
export const SERVICE_ORIGIN = 'https://app.qus.me';

/** The queue's relays: hosts under `.e2e.test`, which Chromium maps to the harness. */
export const STORAGE_RELAYS = ['wss://storage-a.e2e.test', 'wss://storage-b.e2e.test'];
export const INBOX_RELAYS = ['wss://inbox.e2e.test'];

/**
 * Empty stand-ins for the public relays the extension asks by default (its storage defaults now
 * and before 2026-11-09). Recovery always asks them too; here they answer and hold nothing, as
 * they would for a queue kept on other servers, and nothing reaches the real ones.
 */
export const DEFAULT_RELAY_STANDINS = [
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://nos.lol',
];

/** The test agent's OAuth client: a Client ID Metadata Document the harness serves from memory. */
export const AGENT_CLIENT_ID = 'https://agent.e2e.test/oauth/client-metadata.json';
export const AGENT_CLIENT_NAME = 'E2E Agent';
export const AGENT_REDIRECT = 'https://agent.e2e.test/oauth/callback';

/** The ports the harness prints, passed to the tests in this environment variable. */
export const HARNESS_ENV = 'QUSME_E2E_HARNESS';

export interface HarnessPorts {
  /** Service and relays over plain HTTP, for Node. */
  plain: number;
  /** Service and relays over TLS, for the browser. */
  tls: number;
  /** The compose page. */
  page: number;
}
