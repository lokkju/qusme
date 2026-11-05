/**
 * The device side of the service's OAuth approval API (spec 8.2, `docs/oauth.md`): every request
 * NIP-98 signed by the queue key. Everything the service returns about a client came from the
 * client's own metadata document, so it is untrusted: the extension checks its shape here, and
 * derives the host it shows from `client_id` itself rather than taking the service's word for it.
 */
import { buildHttpAuth, httpAuthHeader, type Signer } from '@qusme/nostr';
import { type SetupDeps, SetupError } from '../setup/deps.ts';

export type ServiceDeps = Pick<SetupDeps, 'serviceOrigin' | 'fetch'>;

/** A pending authorization as the device shows it (spec 8.2 step 3). */
export interface AuthorizationRequest {
  /** `XXXX-XXXX`. */
  code: string;
  /** The minted agent key's pubkey. */
  agentPubkey: string;
  /** The client's metadata document URL. */
  clientId: string;
  /** The host of {@link clientId}, computed here. */
  clientHost: string;
  /** The name the client's document gives itself; anyone can claim any name. */
  clientName: string;
  /** The redirect URI's host, or a native app's scheme; absent from a service that omits it. */
  redirectHost?: string;
  scopes: string[];
  /** Unix seconds. */
  expiresAt: number;
}

/** An agent the service holds a key and binding for, on this queue. */
export interface Binding {
  agentPubkey: string;
  clientId: string;
  clientHost: string;
  clientName: string;
  relays: string[];
  createdAt: number;
}

/** What `POST .../approve` answered. */
export type ApprovalAnswer =
  | { ok: true }
  | { ok: false; status: number; error: string; description: string };

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_TEXT = 200;

/** Untrusted text cut to a length the popup can show. */
const clip = (value: string): string =>
  value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;

/** The host of an `https` client id, or undefined if it is not one. */
export function clientIdHost(clientId: string): string | undefined {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.host !== '' ? url.host : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * A `created_at` for a NIP-98 event, one second after the last one for the same request when
 * that would otherwise repeat it. The service refuses a repeated event id as a replay (spec 8.5),
 * and two identical requests signed in the same second, such as an approval retried quickly,
 * would be the same event.
 */
const lastAuthAt = new Map<string, number>();
function authTime(key: string): number {
  const now = Math.floor(Date.now() / 1000);
  const at = Math.max(now, (lastAuthAt.get(key) ?? 0) + 1);
  if (lastAuthAt.size > 100) lastAuthAt.clear();
  lastAuthAt.set(key, at);
  return at;
}

async function request(
  signer: Signer,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  deps: ServiceDeps,
  body?: unknown
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const url = deps.serviceOrigin + path;
  const text = body === undefined ? undefined : JSON.stringify(body);
  const auth = await buildHttpAuth(
    signer,
    { url, method, ...(text !== undefined && { body: text }) },
    { now: authTime(`${method} ${url} ${text ?? ''}`) }
  );
  const headers: Record<string, string> = { Authorization: httpAuthHeader(auth) };
  if (text !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method,
      headers,
      ...(text !== undefined && { body: text }),
    });
  } catch {
    throw new SetupError('Could not reach the qus.me service.');
  }
  return { response, json: await readJson(response) };
}

const codePath = (code: string) => `/device/authorizations/${encodeURIComponent(code)}`;

/**
 * Fetches the pending request behind a code. The service mints the agent key at this fetch, and
 * fetching again from the same queue returns the same key.
 */
export async function fetchAuthorization(
  signer: Signer,
  code: string,
  deps: ServiceDeps
): Promise<AuthorizationRequest> {
  const { response, json } = await request(signer, 'GET', codePath(code), deps);
  if (response.status === 404) {
    throw new SetupError('That code is unknown or expired, or another queue already used it.');
  }
  if (response.status === 409) throw new SetupError('That request was already approved or denied.');
  if (response.status !== 200) {
    throw new SetupError(`The service could not look up the code (${response.status}).`);
  }
  const agentPubkey = str(json.agent_pubkey);
  const clientId = str(json.client_id);
  const clientHost = clientId === undefined ? undefined : clientIdHost(clientId);
  const scopes = Array.isArray(json.scopes) ? json.scopes.filter((s) => typeof s === 'string') : [];
  if (
    agentPubkey === undefined ||
    !HEX64.test(agentPubkey) ||
    clientId === undefined ||
    clientHost === undefined ||
    typeof json.expires_at !== 'number'
  ) {
    throw new SetupError('The service returned something that is not an authorization request.');
  }
  const result: AuthorizationRequest = {
    code,
    agentPubkey,
    clientId: clip(clientId),
    clientHost: clip(clientHost),
    clientName: clip(str(json.client_name)?.trim() || clientHost),
    scopes: scopes.map(clip),
    expiresAt: json.expires_at,
  };
  const redirectHost = str(json.redirect_host);
  if (redirectHost !== undefined && redirectHost !== '') result.redirectHost = clip(redirectHost);
  return result;
}

/**
 * Posts the approval naming the queue's storage relays (8.2 step 4). The service then reads the
 * submitters list from those relays (step 5); a 409 means it did not find the agent there yet.
 */
export async function postApproval(
  signer: Signer,
  code: string,
  relays: readonly string[],
  deps: ServiceDeps
): Promise<ApprovalAnswer> {
  const { response, json } = await request(signer, 'POST', `${codePath(code)}/approve`, deps, {
    relays,
  });
  if (response.status === 200) return { ok: true };
  return {
    ok: false,
    status: response.status,
    error: str(json.error) ?? 'unknown',
    description: clip(str(json.error_description) ?? ''),
  };
}

/** Posts the denial; the service destroys the agent key (8.2 step 4). */
export async function postDenial(signer: Signer, code: string, deps: ServiceDeps): Promise<void> {
  const { response } = await request(signer, 'POST', `${codePath(code)}/deny`, deps);
  if (response.status === 200) return;
  if (response.status === 404) throw new SetupError('That request has expired.');
  if (response.status === 409) throw new SetupError('That request was already approved or denied.');
  throw new SetupError(`The service did not record the denial (${response.status}).`);
}

/** The agents the service has bound to this queue. */
export async function listBindings(signer: Signer, deps: ServiceDeps): Promise<Binding[]> {
  const { response, json } = await request(signer, 'GET', '/device/bindings', deps);
  if (response.status !== 200) {
    throw new SetupError(`The service did not list the agents (${response.status}).`);
  }
  const rows = Array.isArray(json.bindings) ? json.bindings : [];
  const out: Binding[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const agentPubkey = str(r.agent_pubkey);
    const clientId = str(r.client_id);
    const host = clientId === undefined ? undefined : clientIdHost(clientId);
    if (agentPubkey === undefined || !HEX64.test(agentPubkey) || !clientId || !host) continue;
    out.push({
      agentPubkey,
      clientId: clip(clientId),
      clientHost: clip(host),
      clientName: clip(str(r.client_name)?.trim() || host),
      relays: Array.isArray(r.relays) ? r.relays.filter((x) => typeof x === 'string') : [],
      createdAt: typeof r.created_at === 'number' ? r.created_at : 0,
    });
  }
  return out;
}

/**
 * Asks the service to revoke the binding, its tokens and the agent key. `not_bound` when the
 * service has no binding of that agent for this queue (already revoked, or never approved).
 */
export async function deleteBinding(
  signer: Signer,
  agentPubkey: string,
  deps: ServiceDeps
): Promise<'revoked' | 'not_bound'> {
  const { response } = await request(
    signer,
    'DELETE',
    `/device/bindings/${encodeURIComponent(agentPubkey)}`,
    deps
  );
  if (response.status === 200) return 'revoked';
  if (response.status === 404) return 'not_bound';
  throw new SetupError(`The service did not revoke the agent (${response.status}).`);
}
