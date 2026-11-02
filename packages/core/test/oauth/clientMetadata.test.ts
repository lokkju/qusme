import { describe, expect, it } from 'vitest';
import {
  CLIENT_METADATA_MAX_BYTES,
  ClientMetadataError,
  checkClientIdUrl,
  checkRedirectUri,
  fetchClientMetadata,
  isBlockedHost,
  matchRedirectUri,
} from '../../src/oauth/clientMetadata.ts';

const ID = 'https://client.example/oauth/metadata.json';
const doc = (extra: Record<string, unknown> = {}) => ({
  client_id: ID,
  client_name: 'Example',
  redirect_uris: ['https://client.example/cb'],
  ...extra,
});

function respond(body: BodyInit | null, init: ResponseInit = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, reqInit?: RequestInit) => {
    calls.push({ url, init: reqInit });
    return new Response(body, {
      status: 200,
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as object) },
    });
  };
  return { fetch, calls };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ClientMetadataError);
    return (err as Error).message;
  }
  throw new Error('expected a ClientMetadataError');
}

describe('client_id URLs', () => {
  it('accepts an https URL with a path', () => {
    expect(checkClientIdUrl(ID).host).toBe('client.example');
  });

  it.each([
    ['http://client.example/m.json', /https/],
    ['https://client.example/', /path/],
    ['https://client.example', /path/],
    ['https://client.example/m.json#x', /fragment/],
    ['https://u:p@client.example/m.json', /credentials/],
    ['https://client.example/a/../m.json', /dot segments/],
    ['https://client.example/./m.json', /dot segments/],
    ['https://Client.Example/m.json', /canonical/],
    ['https://127.0.0.1/m.json', /host/],
    ['https://[::1]/m.json', /host/],
    ['https://localhost/m.json', /host/],
    ['https://metadata.google.internal/m.json', /host/],
    ['https://printer.local/m.json', /host/],
    ['https://0x7f000001/m.json', /host/],
    ['not a url', /https/],
  ])('refuses %s', (url, why) => {
    expect(() => checkClientIdUrl(url)).toThrow(why);
  });

  it('blocks addresses and local names but not public names', () => {
    for (const host of ['10.0.0.1', '169.254.169.254', '[fd00::1]', 'intranet', 'x.home.arpa']) {
      expect(isBlockedHost(host)).toBe(true);
    }
    for (const host of ['claude.ai', 'vscode.dev', 'relay.damus.io']) {
      expect(isBlockedHost(host)).toBe(false);
    }
  });
});

describe('redirect URIs', () => {
  it.each([
    'https://client.example/cb',
    'http://127.0.0.1/callback',
    'http://localhost:8080/cb',
    'http://[::1]/cb',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
    'com.example.app:/oauth2redirect',
  ])('allows %s', (uri) => {
    expect(() => checkRedirectUri(uri)).not.toThrow();
  });

  it.each([
    'http://client.example/cb',
    'http://192.168.1.2/cb',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'https://client.example/cb#frag',
    '/relative',
  ])('refuses %s', (uri) => {
    expect(() => checkRedirectUri(uri)).toThrow(ClientMetadataError);
  });

  it('matches exactly, except the port of a loopback http URI', () => {
    const registered = ['https://client.example/cb', 'http://127.0.0.1/callback'];
    expect(matchRedirectUri(registered, 'https://client.example/cb')).toBe(true);
    expect(matchRedirectUri(registered, 'https://client.example/cb/')).toBe(false);
    expect(matchRedirectUri(registered, 'https://client.example/cb?x=1')).toBe(false);
    expect(matchRedirectUri(registered, 'https://client.example:8443/cb')).toBe(false);
    expect(matchRedirectUri(registered, 'http://127.0.0.1:49152/callback')).toBe(true);
    expect(matchRedirectUri(registered, 'http://127.0.0.1:49152/other')).toBe(false);
    expect(matchRedirectUri(registered, 'http://localhost:49152/callback')).toBe(false);
    expect(matchRedirectUri(registered, 'http://127.0.0.1:49152/callback#x')).toBe(false);
  });
});

describe('fetching a metadata document', () => {
  it('fetches without following redirects, with a timeout, and validates it', async () => {
    const net = respond(JSON.stringify(doc()));
    const meta = await fetchClientMetadata(ID, { fetch: net.fetch });
    expect(meta).toMatchObject({
      clientId: ID,
      clientName: 'Example',
      redirectUris: ['https://client.example/cb'],
    });
    expect(net.calls[0]?.init?.redirect).toBe('manual');
    expect(net.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a blocked client_id before fetching', async () => {
    const net = respond(JSON.stringify(doc()));
    expect(await reason(fetchClientMetadata('https://10.0.0.1/m.json', net))).toMatch(/host/);
    expect(net.calls).toEqual([]);
  });

  it('refuses redirects, errors and non-JSON', async () => {
    const redirect = respond(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } });
    expect(await reason(fetchClientMetadata(ID, redirect))).toMatch(/redirect/);
    expect(await reason(fetchClientMetadata(ID, respond('x', { status: 500 })))).toMatch(/500/);
    const html = respond('<html>', { headers: { 'Content-Type': 'text/html' } });
    expect(await reason(fetchClientMetadata(ID, html))).toMatch(/not JSON/);
    expect(await reason(fetchClientMetadata(ID, respond('{nope')))).toMatch(/valid JSON/);
    const failing = { fetch: async () => Promise.reject(new TypeError('network')) };
    expect(await reason(fetchClientMetadata(ID, failing))).toMatch(/could not be fetched/);
  });

  it('refuses a document over the size limit, declared or streamed', async () => {
    const big = JSON.stringify(doc({ pad: 'x'.repeat(CLIENT_METADATA_MAX_BYTES) }));
    expect(await reason(fetchClientMetadata(ID, respond(big)))).toMatch(/too large/);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(1024).fill(32));
        controller.close();
      },
    });
    expect(await reason(fetchClientMetadata(ID, respond(stream)))).toMatch(/too large/);
  });

  it('gives up after the timeout', async () => {
    const hanging = {
      fetch: (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      timeoutMs: 20,
    };
    expect(await reason(fetchClientMetadata(ID, hanging))).toMatch(/could not be fetched/);
  });

  it.each([
    [doc({ client_id: 'https://client.example/other.json' }), /does not match/],
    [doc({ redirect_uris: [] }), /no redirect_uris/],
    [doc({ redirect_uris: ['http://evil.example/cb'] }), /loopback/],
    [doc({ client_secret: 's' }), /secret/],
    [doc({ token_endpoint_auth_method: 'private_key_jwt' }), /public clients/],
    [doc({ grant_types: ['client_credentials'] }), /grant_types/],
    [doc({ response_types: ['token'] }), /response_types/],
    [[1, 2], /JSON object/],
  ])('refuses an unusable document (%#)', async (body, why) => {
    expect(await reason(fetchClientMetadata(ID, respond(JSON.stringify(body))))).toMatch(why);
  });

  it('cleans the client name and falls back to the host', async () => {
    const named = respond(
      JSON.stringify(doc({ client_name: ` Evil${String.fromCharCode(0x202e)}Name\n\tX ` }))
    );
    expect((await fetchClientMetadata(ID, named)).clientName).toBe('EvilName X');
    const unnamed = respond(JSON.stringify(doc({ client_name: undefined })));
    expect((await fetchClientMetadata(ID, unnamed)).clientName).toBe('client.example');
  });
});
