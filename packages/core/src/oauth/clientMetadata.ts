/**
 * OAuth Client ID Metadata Documents (spec 8.2, "Client registration";
 * draft-ietf-oauth-client-id-metadata-document, as the MCP authorization specification of
 * 2025-11-25 uses it). The `client_id` is an HTTPS URL; the service fetches the JSON document
 * there and caches it in `oauth_clients`.
 *
 * The fetch is the service reaching a URL that anyone starting an authorization chooses, so it is
 * fenced: HTTPS only, no IP-literal or obviously internal hosts, no redirects at all, a byte limit
 * and a timeout. The fetch function is injected, so tests fake it and the runtime's own fetch is
 * used on Workers and Node alike.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** The document as fetched, for the `oauth_clients` cache. */
  document: Record<string, unknown>;
}

export interface FetchClientMetadataOptions {
  fetch: FetchLike;
  /** Abort the fetch after this long. */
  timeoutMs?: number;
  /** Refuse a document larger than this. */
  maxBytes?: number;
}

export const CLIENT_METADATA_TIMEOUT_MS = 5_000;
/** The draft suggests servers may limit documents to 5 KB; real ones are well under 2 KB. */
export const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
const MAX_CLIENT_ID_LENGTH = 2048;
const MAX_REDIRECT_URIS = 20;
const MAX_CLIENT_NAME = 100;

/** Why a client could not be used; `message` is safe to show the person and the client. */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMetadataError';
  }
}

const fail = (message: string): never => {
  throw new ClientMetadataError(message);
};

/**
 * Hosts the service never fetches from or connects to: IP literals (a public service has no reason
 * to be named by address, and this closes every private range at once), single-label names, and
 * names under suffixes reserved for local networks. DNS can still point a public name at a private
 * address; on Workers fetch cannot reach private addresses, and elsewhere only an egress policy
 * stops that.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host.startsWith('[') || host.includes(':')) return true;
  if (/^[0-9.]+$/.test(host)) return true;
  // Hex, octal or dotless numeric forms of an IPv4 address also parse as addresses in URLs.
  if (/^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/.test(host)) return true;
  if (!host.includes('.')) return true;
  return /\.(localhost|local|internal|lan|home|corp|intranet|private|home\.arpa)$/.test(host);
}

/**
 * Checks `client_id` against the draft's rules: an `https` URL with a path, no fragment, no
 * credentials, no dot segments, and a host that {@link isBlockedHost} allows.
 */
export function checkClientIdUrl(clientId: string): URL {
  if (clientId.length > MAX_CLIENT_ID_LENGTH) fail('client_id is too long');
  if (!/^https:\/\//i.test(clientId)) fail('client_id must be an https URL');
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return fail('client_id is not a URL');
  }
  if (url.protocol !== 'https:') fail('client_id must be an https URL');
  if (url.hash !== '' || clientId.includes('#')) fail('client_id must not have a fragment');
  if (url.username !== '' || url.password !== '') fail('client_id must not have credentials');
  if (url.pathname === '/' || url.pathname === '') fail('client_id must have a path');
  // URL() resolves dot segments, so compare against the raw text.
  if (/\/\.\.?(\/|$|\?)/.test(clientId.replace(/^https:\/\/[^/]+/i, ''))) {
    fail('client_id must not have dot segments');
  }
  if (isBlockedHost(url.hostname)) fail('client_id host is not allowed');
  if (url.href !== clientId) fail('client_id is not in canonical form');
  return url;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** Schemes that would run code or read local data if a browser followed them. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
]);

/**
 * Which redirect URIs a client may register (OAuth 2.1 section 2.3, RFC 8252): `https`, `http` to
 * a loopback host, or a private-use scheme for a native app. Never a fragment.
 */
export function checkRedirectUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new ClientMetadataError(`redirect_uri is not an absolute URL: ${uri}`);
  }
  if (url.hash !== '' || uri.includes('#')) fail('redirect_uri must not have a fragment');
  if (FORBIDDEN_SCHEMES.has(url.protocol)) fail(`redirect_uri scheme not allowed: ${url.protocol}`);
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail('an http redirect_uri must be a loopback address');
  }
  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.username + url.password) {
    fail('redirect_uri must not have credentials');
  }
}

/**
 * Whether `requested` matches a registered redirect URI. Exact string comparison, with the one
 * exception OAuth 2.1 (section 8.4.2) and RFC 8252 (7.3) require: for `http` to a loopback IP
 * literal or `localhost`, the port may differ, since native apps bind an ephemeral port.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== 'http:' || !LOOPBACK_HOSTS.has(req.hostname) || req.hash !== '') {
    return false;
  }
  return registered.some((r) => {
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return (
      reg.protocol === 'http:' &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search &&
      reg.username === '' &&
      req.username === '' &&
      req.password === ''
    );
  });
}

/** Reads at most `max` bytes of the body; throws if there are more. */
async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) fail('client metadata document is too large');
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      fail('client metadata document is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return fail('client metadata document is not UTF-8');
  }
}

/**
 * Validates a fetched document against its URL: `client_id` equal to the URL, `redirect_uris`
 * usable, no client secret, and a public client (token endpoint auth `none`), since the service
 * supports no other client authentication.
 */
export function parseClientMetadata(clientId: string, document: unknown): ClientMetadata {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    fail('client metadata document is not a JSON object');
  }
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) fail('client metadata client_id does not match its URL');
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) {
    fail('client metadata must not contain a client secret');
  }
  const auth = doc.token_endpoint_auth_method;
  if (auth !== undefined && auth !== 'none') {
    fail('only public clients (token_endpoint_auth_method "none") are supported');
  }
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) fail('client metadata has no redirect_uris');
  const redirectUris = uris as unknown[];
  if (redirectUris.length > MAX_REDIRECT_URIS) fail('client metadata has too many redirect_uris');
  for (const uri of redirectUris) {
    if (typeof uri !== 'string') fail('redirect_uris must be strings');
    checkRedirectUri(uri as string);
  }
  const grants = doc.grant_types;
  if (grants !== undefined) {
    if (!Array.isArray(grants) || !grants.includes('authorization_code')) {
      fail('client metadata grant_types must include authorization_code');
    }
  }
  const responseTypes = doc.response_types;
  if (responseTypes !== undefined) {
    if (!Array.isArray(responseTypes) || !responseTypes.includes('code')) {
      fail('client metadata response_types must include code');
    }
  }
  const name = typeof doc.client_name === 'string' ? cleanName(doc.client_name) : '';
  return {
    clientId,
    // Without a name the approval screen shows the host, which it shows next to the name anyway.
    clientName: name === '' ? new URL(clientId).host : name,
    redirectUris: redirectUris as string[],
    document: doc,
  };
}

/**
 * Control, zero-width and bidi-override characters (which can make a name read as another)
 * dropped, whitespace collapsed, length capped.
 */
function cleanName(name: string): string {
  const invisible = (cp: number) =>
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069);
  let out = '';
  for (const ch of name.replace(/\s+/g, ' ')) {
    if (!invisible(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim().slice(0, MAX_CLIENT_NAME);
}

/** Fetches and validates the metadata document at `clientId`. */
export async function fetchClientMetadata(
  clientId: string,
  options: FetchClientMetadataOptions
): Promise<ClientMetadata> {
  checkClientIdUrl(clientId);
  let res: Response;
  try {
    res = await options.fetch(clientId, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? CLIENT_METADATA_TIMEOUT_MS),
    });
  } catch {
    return fail('client metadata document could not be fetched');
  }
  // A browser-style fetch reports a manual redirect as an opaque response with status 0.
  if ((res.type as string) === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    fail('client metadata document redirects; redirects are not followed');
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    fail(`client metadata document answered ${res.status}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/^application\/([a-z0-9.+-]*\+)?json\b/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    fail('client metadata document is not JSON');
  }
  let text: string;
  try {
    text = await readLimited(res, options.maxBytes ?? CLIENT_METADATA_MAX_BYTES);
  } catch (err) {
    if (err instanceof ClientMetadataError) throw err;
    return fail('client metadata document could not be read');
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail('client metadata document is not valid JSON');
  }
  return parseClientMetadata(clientId, document);
}
