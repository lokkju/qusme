/**
 * The typed-code rendezvous on the qus.me service (spec 8.3 steps 2 and 3): `POST /pair`, NIP-98
 * signed by the queue key, and `GET /pair/:code`, unauthenticated. Both need the optional host
 * permission for the service origin (11.2), which the caller requests first.
 */
import {
  buildHttpAuth,
  httpAuthHeader,
  normalizePairingCode,
  type PairingUri,
  parsePairingUri,
  type Signer,
} from '@qusme/nostr';
import { type SetupDeps, SetupError } from './deps.ts';

type ServiceDeps = Pick<SetupDeps, 'serviceOrigin' | 'fetch'>;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Posts a pairing URI and returns the typed code and its expiry (unix seconds). */
export async function postPairingCode(
  signer: Signer,
  uri: string,
  expiresAt: number,
  deps: ServiceDeps
): Promise<{ code: string; expiresAt: number }> {
  const url = `${deps.serviceOrigin}/pair`;
  const body = JSON.stringify({ uri, expires_at: expiresAt });
  const auth = await buildHttpAuth(signer, { url, method: 'POST', body });
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: httpAuthHeader(auth) },
      body,
    });
  } catch {
    throw new SetupError('Could not reach the qus.me service.');
  }
  const json = await readJson(response);
  if (response.status === 429) {
    throw new SetupError('Too many open pairing codes; wait two minutes and try again.');
  }
  const code = normalizePairingCode(json.code);
  if (response.status !== 201 || code === undefined || typeof json.expires_at !== 'number') {
    throw new SetupError(`The service did not issue a code (${response.status}).`);
  }
  return { code, expiresAt: json.expires_at };
}

/** Fetches the URI behind a typed code. The service deletes it on this first fetch. */
export async function fetchPairingUri(
  code: string,
  deps: ServiceDeps
): Promise<{ uri: PairingUri; expiresAt: number }> {
  let response: Response;
  try {
    response = await deps.fetch(`${deps.serviceOrigin}/pair/${encodeURIComponent(code)}`, {
      method: 'GET',
    });
  } catch {
    throw new SetupError('Could not reach the qus.me service.');
  }
  if (response.status === 404) throw new SetupError('That code is unknown, used or expired.');
  if (response.status === 429) throw new SetupError('Too many attempts; wait a minute.');
  const json = await readJson(response);
  if (response.status !== 200) {
    throw new SetupError(`The service could not look up the code (${response.status}).`);
  }
  const parsed = parsePairingUri(json.uri);
  if (!parsed.ok || typeof json.expires_at !== 'number') {
    throw new SetupError('The service returned something that is not a pairing link.');
  }
  return { uri: parsed.value, expiresAt: json.expires_at };
}
