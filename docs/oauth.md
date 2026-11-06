# OAuth for MCP clients

The service is the OAuth 2.1 authorization server for its own MCP endpoint (spec 8.2), following the MCP authorization specification, revision 2025-11-25. The code is `packages/core/src/oauth/`; the flow test that drives it end to end on both store drivers is `packages/core/test/oauth/flow.suite.ts`.

## Endpoints

| Method | Path | Who calls it |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) | MCP client: RFC 9728 metadata for `https://app.qus.me/mcp` |
| GET | `/.well-known/oauth-authorization-server` | MCP client: RFC 8414 metadata, issuer `https://app.qus.me` |
| GET | `/authorize` | MCP client, in the browser: starts an authorization, redirects to the waiting page |
| GET | `/authorize/:id` | Browser: the waiting page with the code and its QR |
| GET | `/authorize/:id/status` | The waiting page's poll: `pending`, `fetched`, `redirect` (with the URL) or `expired` |
| GET | `/approve?code=` | What the QR opens in a plain browser: tells the person to enter the code in qus.me |
| POST | `/token` | MCP client: `authorization_code` and `refresh_token` grants |
| POST | `/revoke` | MCP client: RFC 7009 revocation |
| GET | `/device/authorizations/:code` | Device, NIP-98: fetches the request and mints the agent key |
| POST | `/device/authorizations/:code/approve` | Device, NIP-98: body `{"relays": ["wss://..."]}`, the queue's storage relays |
| POST | `/device/authorizations/:code/deny` | Device, NIP-98: destroys the agent key |
| GET | `/device/bindings` | Device, NIP-98: the agents bound to the signing queue |
| DELETE | `/device/bindings/:agentPubkey` | Device, NIP-98: revokes the binding, its tokens and the agent key |
| POST | `/mcp` | MCP client, bearer token: the tools of spec 8.4 over stateless streamable HTTP (GET and DELETE answer 405) |

A request to `/mcp` without a valid token gets 401 with `WWW-Authenticate: Bearer resource_metadata="https://app.qus.me/.well-known/oauth-protected-resource/mcp", scope="drafts:submit"`, which is where an MCP client starts. The metadata, token, revocation and `/mcp` endpoints answer CORS from any origin, so browser-based clients such as MCP Inspector can use them; none of them uses cookies.

## The flow

1. The client fetches the protected resource metadata, then the authorization server metadata, and sends the browser to `/authorize` with `client_id` (its metadata document's URL), `redirect_uri`, `code_challenge` and `code_challenge_method=S256`, `state`, `resource=https://app.qus.me/mcp` and `scope=drafts:submit`.
2. The service fetches and caches the client's metadata document, checks the request, creates a pending authorization with an 8-character code, and redirects to the waiting page. The page shows the client's name and the host of its `client_id`, the code as `XXXX-XXXX`, and a QR of `https://app.qus.me/approve?code=XXXX-XXXX`. It has no form; it polls.
3. A paired device fetches the request by code with NIP-98 signed by the queue key. The service mints the agent key at this fetch (spec 6.2, 8.2 step 3) and returns its pubkey with the client name, the `client_id` and its host, the redirect URI's host (`redirect_host`; a native app's private-use scheme, such as `com.example.app:`, when it has no host) and the scopes. Fetching again from the same queue returns the same key; another queue gets 404 once one has fetched it.
4. The device publishes the submitters list naming the agent pubkey and the agent's grant, then posts the approval naming the queue's storage relays.
5. The service reads the queue's submitters list from those relays, authenticating as the agent key where a relay asks for NIP-42 AUTH, takes the newest one signed by the queue key, and approves only if its `p` tags name the agent pubkey (spec 7.3, 8.2 step 5). Otherwise the approval fails with 409 `submitters_list_not_found` or `agent_not_in_submitters_list` and the request stays open, so the device can retry once its publish has reached the relays. On success the service records the binding of the agent key to the queue pubkey and the relays.
6. The waiting page's next poll gets the redirect to `redirect_uri` with `code`, `state` and `iss`. The code is issued once: the pending row is deleted in the same statement that hands it out.
7. The client redeems the code at `/token` with the PKCE verifier and gets an access token and a refresh token.

A denial destroys the agent key and the page redirects with `error=access_denied`. A request that expires before approval has its agent key deleted by the sweep (`sweepExpired`, every 5 minutes on Node, the cron on Workers).

## Choices the spec leaves open

**Client registration.** Client ID Metadata Documents only, as spec 8.2 decides; there is no registration endpoint and the metadata does not advertise one. Only public clients are supported: a document must have `token_endpoint_auth_method` absent or `none` and no client secret, so `private_key_jwt` clients are refused.

**Fetching metadata documents.** `client_id` must be an `https` URL with a path, no fragment, credentials or dot segments, in canonical form, and on a host that is not an IP literal, a single label or under a local suffix (`.local`, `.internal`, `.lan`, `.home.arpa` and similar). The fetch does not follow redirects at all, gives up after 5 s, and refuses a document over 5 KiB or not served as JSON. The document's `client_id` must equal its URL. A cached document is used for an hour, then fetched again; if that fetch fails the authorization fails. The same host rules apply to the storage relays an approval names, which must be 1 to 5 `wss://` URLs.

**Redirect URIs.** A document may register `https` URIs, `http` URIs on `127.0.0.1`, `[::1]` or `localhost`, and private-use schemes for native apps; never `javascript:`, `data:`, `file:` and the like, and never a fragment. Matching is exact string comparison, with the one exception OAuth 2.1 and RFC 8252 require: a registered loopback `http` URI matches the same host, path and query on any port. An unregistered or missing `redirect_uri` gets an error page, never a redirect.

**PKCE.** `code_challenge_method` must be `S256`. A missing method (which OAuth defaults to `plain`) and `plain` are both refused, as is a challenge that is not 43 base64url characters and a verifier outside RFC 7636's 43 to 128 unreserved characters.

**Scope.** One scope, `drafts:submit`. An authorization without `scope` gets it; any other scope is `invalid_scope`.

**Resource indicators.** The service protects one resource, `https://app.qus.me/mcp`. A `resource` parameter at `/authorize` or `/token` must equal it exactly, or the request fails with `invalid_target`; one left out means that resource, since there is no other. Every token is for it, so tokens carry no audience column.

**Lifetimes.** Pending authorization 10 minutes, authorization code 60 s, access token 1 hour, refresh token 30 days. Each refresh rotates the refresh token. A rotated-out refresh token presented again revokes every token of that agent key (OAuth 2.1 4.3.1), and so does revoking a refresh token at `/revoke`. A redeemed code is deleted, so a second redemption fails; tokens from the first are not revoked, since nothing is left to link them to the code.

**Secrets.** Codes and tokens are 256-bit random values; only their SHA-256 hashes are stored, and lookups are by hash. PKCE challenges and client ids are compared in constant time. The OAuth modules make no logging call, which `test/noSecretLogging.test.ts` checks.

**The authorize page.** Read-only, under `default-src 'none'` with a nonce for its one script and style, `form-action 'none'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (its URL carries the pending authorization's id) and `Cache-Control: no-store`. With scripts off it asks the person to reload after approving.

**Revocation from a device.** `DELETE /device/bindings/:agentPubkey` revokes the binding and every token, and revokes the agent key, which discards its ciphertext but keeps its submission receipts. Removing the agent from the submitters list is the device's job (spec 8.2, "Revocation"); the device calls this endpoint after it, keeps the revocation pending until the service answers 200 or 404, and retries on each sync (spec 11.8). A 404 counts as done: the binding is already gone.

**Between the list and the DELETE.** The agent's tokens stay valid until the `DELETE` arrives, but the MCP tools re-read the queue's submitters list on each call, cached for 30 seconds alongside the grant, and answer `grant_revoked` once the list no longer names the agent (spec 8.4). So a device that cannot reach the service still stops the agent at the service within the cache time, even on relays that ignore the grant's deletion. If no storage relay returns a list, the tools decide on the grant alone and the entrypoints log `submitters_list_unavailable` with the agent and queue pubkeys.

**An approval nobody collects.** If the device approves but the browser never polls again, the code is never issued and the agent key stays, bound but with no token that could use it, until a device revokes it. The sweep keeps approved authorizations' keys, as the store was designed to.

## Network egress

On Workers, `fetch` and outbound WebSockets need nothing configured. On the homelab, the pod needs outbound TCP 443 to arbitrary public hosts, plus DNS, for two things: HTTPS fetches of client metadata documents (the hosts are whatever clients use as `client_id`, such as `claude.ai` or `vscode.dev`) and WebSocket (`wss://`) connections to each approving queue's storage relays, which are relays the user chose. Relays are almost all on 443, but a relay URL may name another port, and the service connects to whatever port it names. Neither set of hosts is known in advance, so a hostname allowlist would break authorizations.
