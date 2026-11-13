/**
 * The e2e harness: the qus.me service, three local relays and a neutral compose page, in one Node
 * process that Playwright's global setup starts (`global-setup.ts`). It prints one JSON line with
 * its ports and runs until it gets SIGTERM.
 *
 * - The relays are `@qusme/nostr/testing`'s FakeRelay behind real WebSocket servers: two storage
 *   relays, an inbox relay that, like auth.nostr1.com, serves gift wraps only to their recipient
 *   and refuses draft wraps, and empty stand-ins for the public default relays. Each keeps its
 *   events in memory for the whole run.
 * - The TLS listener is what the browser reaches: Chromium maps `*.e2e.test`, `app.qus.me` and the
 *   default relays' hosts to it (`--host-resolver-rules`), so the extension talks to
 *   `wss://storage-a.e2e.test` and to `https://app.qus.me` unchanged. Upgrades go to the relay named by the Host header, other
 *   requests to the service. The certificate is self-signed; Chromium runs with
 *   `--ignore-certificate-errors`.
 * - The plain listener is what Node reaches: the service's relay reader and publisher, which open
 *   `ws://127.0.0.1:<plain>/relay/<host>` for a relay URL, and the MCP client in the tests.
 * - The page listener serves `compose.html` on its own origin, the page the insertion test types
 *   into. Nothing about it is known to the extension except through a destination the test adds.
 *
 * The service is `@qusme/core`'s app on in-memory SQLite, with the production publicOrigin
 * (`https://app.qus.me`, which the extension signs NIP-98 for) and the bundled registry. The one
 * OAuth client it knows is the test agent's metadata document, served from memory: the service
 * never fetches anything off this machine.
 *
 * Run: node e2e/harness/server.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import {
  bundledRegistry,
  createAgentKeyRing,
  createApp,
  createWebSocketRelayPublisher,
  createWebSocketRelayReader,
} from '@qusme/core';
import { KIND_DRAFT_WRAP } from '@qusme/nostr';
import { FakeRelay } from '@qusme/nostr/testing';
import { openSqlite } from '@qusme/store-sql/sqlite';
import { type WebSocket, WebSocketServer } from 'ws';
import snapshot from '../../registry/snapshot.json' with { type: 'json' };
import {
  AGENT_CLIENT_ID,
  AGENT_CLIENT_NAME,
  AGENT_REDIRECT,
  DEFAULT_RELAY_STANDINS,
  INBOX_RELAYS,
  SERVICE_ORIGIN,
  STORAGE_RELAYS,
} from './constants.ts';

const here = new URL('.', import.meta.url).pathname;

/** A self-signed certificate for every name the browser maps here. */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'qusme-e2e-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=e2e.test',
      '-addext',
      'subjectAltName=DNS:*.e2e.test,DNS:app.qus.me',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' }
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// The relays, by host. Their URLs are exactly what the extension is given, since NIP-42 AUTH
// events name the relay URL and FakeRelay compares it as a string.
const relays = new Map<string, FakeRelay>();
for (const url of [...STORAGE_RELAYS, ...DEFAULT_RELAY_STANDINS]) {
  relays.set(new URL(url).host, new FakeRelay(url));
}
for (const url of INBOX_RELAYS) {
  relays.set(
    new URL(url).host,
    new FakeRelay(url, { restrictGiftWraps: true, refuseKinds: [KIND_DRAFT_WRAP] })
  );
}

/** Joins a WebSocket to a FakeRelay connection, message for message. */
function bridge(ws: WebSocket, relay: FakeRelay): void {
  const socket = relay.connect();
  socket.onmessage = (event) => {
    if (ws.readyState === ws.OPEN) ws.send(String(event.data));
  };
  socket.onclose = () => ws.close();
  ws.on('message', (data) => {
    try {
      socket.send(data.toString());
    } catch {
      ws.close();
    }
  });
  ws.on('close', () => socket.close());
  ws.on('error', () => socket.close());
}

const wss = new WebSocketServer({ noServer: true });
function upgradeTo(relay: FakeRelay | undefined) {
  return (request: IncomingMessage, stream: Duplex, head: Buffer) => {
    if (relay === undefined) {
      stream.destroy();
      return;
    }
    wss.handleUpgrade(request, stream, head, (ws) => bridge(ws, relay));
  };
}

const plain = createHttpServer();
const tls = createHttpsServer(certificate());
const page = createHttpServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(readFileSync(join(here, 'compose.html')));
});

function listen(server: typeof plain | typeof tls): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

const plainPort = await listen(plain);

/** The service's WebSocket: a relay URL becomes the plain listener's path for that relay. */
class LocalRelaySocket extends globalThis.WebSocket {
  constructor(url: string) {
    super(`ws://127.0.0.1:${plainPort}/relay/${encodeURIComponent(new URL(url).host)}`);
  }
}

const relayOptions = { WebSocket: LocalRelaySocket, timeoutMs: 3_000 };
const app = createApp({
  version: 'e2e',
  db: openSqlite(':memory:'),
  agentKeys: createAgentKeyRing({ secret: btoa('e2e-only-agent-key-secret-0000!!') }),
  publicOrigin: SERVICE_ORIGIN,
  oauth: {
    relayReader: createWebSocketRelayReader(relayOptions),
    fetch: async (input: string) =>
      input === AGENT_CLIENT_ID
        ? Response.json({
            client_id: AGENT_CLIENT_ID,
            client_name: AGENT_CLIENT_NAME,
            redirect_uris: [AGENT_REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          })
        : new Response('not found', { status: 404 }),
  },
  mcp: {
    registry: bundledRegistry(snapshot),
    relayPublisher: createWebSocketRelayPublisher(relayOptions),
    // Read grants fresh on every call: the tests approve and draft within seconds.
    grantCacheSeconds: 0,
  },
});
const serve = getRequestListener(app.fetch);

plain.on('request', serve);
plain.on('upgrade', (request: IncomingMessage, stream: Duplex, head: Buffer) => {
  const match = /^\/relay\/([^/?]+)$/.exec(request.url ?? '');
  upgradeTo(match ? relays.get(decodeURIComponent(match[1] as string)) : undefined)(
    request,
    stream,
    head
  );
});
tls.on('request', serve);
tls.on('upgrade', (request: IncomingMessage, stream: Duplex, head: Buffer) => {
  upgradeTo(relays.get(request.headers.host ?? ''))(request, stream, head);
});

const ports = { plain: plainPort, tls: await listen(tls), page: await listen(page) };
process.stdout.write(`${JSON.stringify(ports)}\n`);

const stop = () => {
  for (const server of [plain, tls, page]) {
    server.closeAllConnections();
    server.close();
  }
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
