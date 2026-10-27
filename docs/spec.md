# qus.me: Specification

*Draft v0.3, 2026-10-27. Supersedes v0.2.*

## 1. Summary

qus.me is a queue of values waiting to be placed into fields on web pages. Humans and agents submit drafts; each draft names a destination (a site and an account) and a field. A browser extension lets the user pick a draft and insert it into the matching field on the live page. The user always performs the final action on the site (clicking Post, Submit, Send); qus.me never does.

The launch use case is social composers (X, Facebook, LinkedIn, Bluesky, Mastodon, Nostr), where APIs are restricted, expensive, or absent (Facebook personal profiles have no posting API at all). Nothing in the architecture is specific to social posting: any site with an editable field is a destination, and agents can submit drafts for sites and fields the project has never described.

Storage, sync, and encryption are Nostr. Drafts are NIP-37 draft wraps on a private, authenticated relay, encrypted to a per-user queue key that only the user's own devices hold. Agents submit drafts as NIP-59 gift wraps and cannot read the queue. A central service (the qus.me service) provides the MCP endpoint, holds agent keys, and brokers device pairing and agent authorization, without ever holding the queue key.

### 1.1 Changes from v0.1

The HTTP broker and its SQL draft store are gone; drafts live on a Nostr relay. End-to-end encryption moves from post-v1 to the baseline. The REST API is dropped for v1 (Nostr is the raw API; MCP serves agents). Clerk/OIDC is no longer needed for user identity, which is the queue key, presented to the service via NIP-98. MCP agents become write-only. Server-side validation survives for agent submissions, since the service sees agent plaintext at write time.

### 1.2 Changes from v0.2

- Device pairing is NIP-AB, with the service as an optional rendezvous for a typed code; the passphrase is still required on the new device (8.3, 2.2, 16).
- Relay access rules (9.1) gain exact exceptions: the recovery backup is readable before the device holds the queue key; an agent reads its own grant and the submitters list it appears on; kind 1059 is readable only by its recipient; NIP-AB pairing messages pass through without storage.
- The hosted relay serves only queues bound to the hosted service, with stated retention (9.2).
- Agent grants carry `allow_new_destinations` (default false) and `submission_expiration_days` (default 30, refused above 90); quota periods are UTC calendar periods (7.4, 7.5).
- Kind numbers are chosen from the registry before v1 instead of migrating from placeholders (2.2).
- The agent key is minted when a device fetches the pending authorization and destroyed on deny or expiry; MCP clients register with Client ID Metadata Documents (8.2).
- Service state lists submission receipts and pending authorizations (8.5).
- Rotation rebinding needs signatures from the old and the new key, and the queue publishes a rotation marker (6.1).
- Ingestion defines the deterministic `d` derivation and where devices keep quota counts (11.4).
- Override merge rules for arrays, a `graphemes` counting strategy, sites without a fixed `match` (Mastodon), and how devices find the registry's relays (10).
- The PWA archives a draft after a "Posted?" confirmation instead of on tap (12).
- Stale references to `mcp.qus.me` and `relay.qus.me` removed; decided questions kept in section 17 under "Decided".

## 2. NIPs

### 2.1 Existing NIPs used

| NIP    | Used for                                                                                            |
|--------|-----------------------------------------------------------------------------------------------------|
| NIP-01 | Event model; replaceable and addressable events; relay protocol                                     |
| NIP-09 | Deletion requests for dismissed or purged drafts (best effort on third-party relays)                |
| NIP-11 | Relay information document; checking a relay supports NIP-42 before using it as private storage     |
| NIP-19 | bech32 encodings for display and transfer (`npub`, `ncryptsec`)                                     |
| NIP-37 | Draft wraps (kind 31234) holding every draft; private storage relay list (kind 10013)               |
| NIP-40 | Expiration tags on submission gift wraps                                                            |
| NIP-42 | Relay authentication; read restriction to the queue key; write restriction to authorized submitters |
| NIP-44 | Encryption for draft wraps, app data, agent grants, and key transfer                                |
| NIP-49 | Passphrase encryption of the queue key at rest on devices and in the recovery backup                |
| NIP-59 | Gift wraps for agent draft submissions                                                              |
| NIP-65 | Relay list of the registry publisher key, from which devices refresh site definitions (10.3)        |
| NIP-78 | App-specific data (kind 30078): the user's destinations and settings, encrypted to the queue key    |
| NIP-98 | HTTP auth: devices authenticate to the qus.me service by signing requests with the queue key        |
| NIP-AB | Device pairing (draft, [nostr-protocol/nips#2328](https://github.com/nostr-protocol/nips/pull/2328)): transferring the `ncryptsec` to a new device (8.3) |

Optional, not required for v1: NIP-07 and NIP-46 (users who want the queue key in an existing signer or bunker; slower, see 6.3), NIP-55 (Android signer apps).

### 2.2 Proposed new NIPs

These are the specification's contributions to Nostr. The kind numbers below were picked on 2026-10-27 from numbers unused in the kind registry in the nips README, in nostr-protocol/registry-of-kinds, and in the open nips PRs; v1 uses them and the NIPs are submitted with them. They share the suffix 1235 across the regular, replaceable and addressable ranges and sit next to NIP-37's 31234. The constants are `KIND_FIELD_VALUE` and so on in `packages/nostr/src/kinds.ts`, the one place a number is written. Parsers in the `nostr` package accept a list of former numbers for each kind, so a number that review forces to change migrates without losing data. Search open PRs in nostr-protocol/nips for overlapping proposals (draft inboxes) before writing each one.

| Working name                   | Defines                                                                                                                                                                                                                                                                                                                                                                                          | Kinds                                                             |
|--------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| **Web Field Values**           | An unsigned event kind carrying a value destined for a named field at a web destination (site, account, field, optional target URL), plus state tags used when it sits inside a draft wrap (status, insertion records, source). Never published bare; always inside a NIP-37 wrap or a NIP-59 gift wrap.                                                                                         | `KIND_FIELD_VALUE` = 1235 (regular)                               |
| **Draft Inbox**                | Delivery of draft submissions as NIP-59 gift wraps to a queue key; an authorized-submitters list (replaceable, public `p` tags so relays can enforce it, encrypted labels); per-submitter agent grants (destinations shared with an agent, encrypted to its key); ingestion rules (deterministic `d` tags, lookback window, dedupe). Applies to any NIP-37-eligible kind, not only field values. | `KIND_SUBMITTERS` = 11235 (replaceable), `KIND_AGENT_GRANT` = 31235 (addressable) |
| **Site and Field Definitions** | Addressable events, signed by a registry publisher key, describing a website's editable fields: URL match patterns, account detection, accessible-name locators, injection strategies, constraints.                                                                                                                                                                                              | `KIND_SITE_DEF` = 31236 (addressable)                             |

Drafts for Nostr itself need no new kind: a draft note is a NIP-37 wrap of an unsigned kind 1 event, interoperable with any client that reads NIP-37 drafts from the same key.

Device linking, a candidate in v0.2, is not proposed: pairing adopts NIP-AB (8.3). Where 8.3 needs more than NIP-AB defines, qus.me comments on the NIP-AB PR rather than writing a separate NIP.

## 3. Goals and non-goals

v1 goals:

- End-to-end encrypted draft storage on any NIP-42 relay, self-hosted or not.
- A qus.me service deployable unchanged to Cloudflare Workers or to Docker/Node, providing MCP, agent key custody, pairing, and agent authorization.
- A single-codebase browser extension for Chrome and Firefox (Manifest V3) that inserts a user-selected draft into a page field with no standing access to any site.
- A mobile PWA that is a full paired device.
- A maintained, separately licensed registry of site definitions, published as signed Nostr events.
- Per-user destinations layered over the registry.

v1 non-goals: automatic posting of any kind; observing page network traffic; scheduling and reminders; multi-field drafts; media; teams and shared queues; a REST API.

## 4. Concepts

**Queue key.** A Nostr keypair dedicated to one user's qus.me queue, generated on the user's first device. It signs and decrypts everything in the queue. It is distinct from any public Nostr identity the user has, since the relay sees event timing and volume under this pubkey. Only the user's paired devices hold it.

**Device.** An extension install, a PWA install, or any other client holding the queue key.

**Agent key.** A Nostr keypair minted and held by the qus.me service for one MCP client. Agent keys can submit drafts to queues that authorize them and can read only the agent grant addressed to them and the submitters lists that name them.

**Site definition.** A signed document describing one site: URL match patterns, account detection, and fields. Each field has a name, accessible-name locators, an ordered list of injection strategies, and constraints. Site definitions are data, never code.

**Field.** A named input on a site (`text` on X's composer). In v1 every draft targets exactly one field.

**Destination.** A (site, account) pair the user posts to, such as X as `lokkju` and X as `Sinistre`. Destinations belong to the user, can extend or override the official site definition, and are stored encrypted (NIP-78). A destination whose site is not in the registry is a custom destination.

**Draft.** A field value at a destination, stored as a NIP-37 wrap. Drafts are active or archived.

**Submission.** A draft delivered by an agent as a gift wrap, not yet ingested into the queue.

**Insertion.** Placing a draft's value into a page field. Insertion archives the draft. qus.me records that the value was inserted, not that it was published.

## 5. Architecture

```text
  MCP clients                         Devices (hold queue key)
  (Claude, etc.)                      extension | PWA
       |                                 |   ^
       | OAuth + MCP                     |   | NIP-98 (pairing, approvals)
       v                                 v   |
  +-----------------------------------------------+
  |               qus.me service                  |
  |  MCP /mcp   OAuth AS   pairing rendezvous     |
  |  agent key custody   validation   registry    |
  +-----------------------------------------------+
       |  gift wraps (NIP-59),                ^
       |  signed by agent keys                |
       v                                      |
  +-----------------------------------------------+
  |        Private relay (NIP-42 authed)          |
  |  read: queue key, with the exceptions in 9.1  |
  |  write: queue key events; kind 1059 from      |
  |         authorized submitters; NIP-AB pairing |
  |         messages, passed on, never stored     |
  +-----------------------------------------------+
       ^   REQ / EVENT (websocket)
       |
  Devices: decrypt locally, ingest submissions, manage drafts
                       |
                       |  activeTab-scoped script injection
                       v
               the user's tab (x.com, facebook.com, ...)
```

The relay is the source of truth for drafts, destinations, and state. The service is never in the read path for the queue. Devices talk to the relay directly.

## 6. Keys

### 6.1 Queue key lifecycle

**Generation.** On first setup, the device generates the queue key locally. The service is not involved.

**At rest on devices.** Stored NIP-49-encrypted (`ncryptsec`) in `storage.local` (extension) or IndexedDB (PWA), at scrypt cost `log_n` 18 (256 MiB per unlock). A device can raise the cost later by re-encrypting the key and republishing the recovery backup; decoders refuse an `ncryptsec` above `log_n` 20. Unlocked per session with the user's passphrase; the unlocked key lives in `storage.session` (extension) or memory (PWA). Devices may offer a "stay unlocked on this device" option that stores the key unencrypted locally; off by default.

**Recovery backup.** The same `ncryptsec` is published to the private relay as an addressable NIP-78 event (`d` = `qus.me/recovery`). Recovery on a new device needs only the relay URL, the queue npub, and the passphrase. The recovering device authenticates to the relay with a throwaway key, since it does not yet hold the queue key, and the relay serves this one event to any authenticated connection (9.1). Anyone who knows the relay URL and the queue npub can therefore fetch the `ncryptsec` and try passphrases offline; the setup UI checks passphrase strength for that reason. A forgotten passphrase with no paired device remaining loses the queue; this is stated in the UI at setup.

**Rotation.** If a device is lost or compromised, a remaining device rotates: generate a new queue key; re-wrap every draft and the destinations and settings under it, keeping each `d`; publish a new submitters list, agent grants (same content), 10013, and recovery backup; rebind agent authorizations at the service; publish a rotation marker under the old key; delete the old key's other events (blanked wraps and NIP-09) once the service confirms the rebind; re-pair remaining devices. On the hosted relay the rebind comes before the first publish under the new key, since the rebind also makes the new key eligible there (9.2). Each step is idempotent, so a rotation interrupted at any point finishes on the next run. Rotation is the only revocation for a device, since every device holds the same key.

The rebind is `POST /rotate`, NIP-98 signed by the old key, with a body holding an event signed by the new key that names the old pubkey. The service rebinds every binding from the old queue pubkey to the new one only when both signatures verify, so the new key named in a rebind is always one the requester controls. This does not cover an attacker who holds the old key and rotates first to a key of their own: the service then binds the user's agents to the attacker's queue, and the agents' later submissions go there. The user's remedy is to revoke those authorizations in the MCP clients and authorize the clients again under the user's new key.

The rotation marker is a NIP-78 event under the old key, `d` = `qus.me/rotated`, content NIP-44-encrypted to the old key, holding the new npub as `{ "npub": "<new npub>" }`. A device that unlocks and finds it tells the user the queue has rotated and offers pairing (8.3) with a device that holds the new key. A device never switches keys on the marker alone, since anyone holding the old key can publish one.

### 6.2 Agent keys

Minted by the service when a device fetches a pending OAuth authorization (section 8.2, step 3), and destroyed if the user denies it or it expires before approval. Stored by the service, encrypted at rest with a service secret. One agent key per MCP client authorization, so revocation is per client.

### 6.3 External signers

A user who prefers to keep the queue key in a NIP-46 bunker or NIP-07 extension can do so; devices then call the signer for every signature and decryption. Opening the popup over N drafts costs N remote `nip44_decrypt` round trips with a bunker. Supported, documented as slower, not the default.

## 7. Events

All queue-key events go only to the private relay listed in the user's kind 10013.

### 7.1 Draft (NIP-37 wrap of a field value)

```json
{
  "kind": 31234,
  "pubkey": "<queue key>",
  "tags": [
    ["d", "<draft id>"],
    ["k", "<KIND_FIELD_VALUE>"]
  ],
  "content": "nip44Encrypt(JSON.stringify(<field value rumor>))"
}
```

The field value rumor (unsigned):

```json
{
  "kind": "<KIND_FIELD_VALUE>",
  "created_at": 1761400000,
  "tags": [
    ["site", "x"],
    ["account", "lokkju"],
    ["field", "text"],
    ["destination", "<destination id>"],
    ["status", "active"],
    ["source", "<submission gift wrap id>", "<submitter pubkey>"],
    ["inserted", "<unix ts>", "<page url>", "<strategy>", "<method>", "<accessible name>", "<detected account>"],
    ["validation", "<json>"]
  ],
  "content": "<the value>"
}
```

`status` is `active`, `archived:inserted`, or `archived:dismissed`. `inserted` tags accumulate; restoring a draft sets `status` back to `active` and keeps them. `source` is present only for agent submissions. Because the whole rumor is encrypted, site, account, field, and status are invisible to the relay.

Reserved for post-v1: `target` (reply or quote URL), `sequence` and `position` (threads).

Editing a draft republishes the wrap with the same `d`. Deleting it publishes a blanked wrap per NIP-37 and a NIP-09 deletion request; the user's own relay hard-deletes.

### 7.2 Destinations and settings (NIP-78)

Addressable kind 30078, `d` = `qus.me/destinations`, content NIP-44-encrypted to the queue key:

```json
{
  "destinations": [
    { "id": "01J...", "site": "x", "account": "lokkju", "label": "X / lokkju",
      "status": "confirmed", "override": null }
  ]
}
```

`status` is `confirmed` or `pending` (created by an agent submission naming an unknown destination). `override` is a partial site definition merged over the official one (10.2). Settings use `d` = `qus.me/settings`, encrypted the same way:

```json
{
  "archive_retention_days": 90,
  "quota_counts": {
    "<agent pubkey>": { "period_start": 1761350400, "accepted": ["<gift wrap id>"], "discarded": ["<gift wrap id>"] }
  }
}
```

`archive_retention_days` is how long devices keep archived drafts before deleting them; `null` keeps them indefinitely. It defaults to 90 for a queue on the hosted relay and to `null` elsewhere (9.2). `quota_counts` is the devices' shared record of ingestion against each agent's quota (11.4).

### 7.3 Submitters list (proposed, Draft Inbox NIP)

Replaceable `KIND_SUBMITTERS`, signed by the queue key:

```json
{
  "kind": "<KIND_SUBMITTERS>",
  "tags": [
    ["p", "<agent pubkey>"],
    ["p", "<agent pubkey>"]
  ],
  "content": "nip44Encrypt(JSON.stringify({ \"<agent pubkey>\": { \"label\": \"Claude Desktop\", \"authorized_at\": 1761400000 } }))"
}
```

`p` tags are public so the relay can enforce writes; labels are encrypted. The list is signed by the queue key, which the service never holds, so a compromised service cannot authorize a new submitter.

### 7.4 Agent grant (proposed, Draft Inbox NIP)

Addressable `KIND_AGENT_GRANT`, `d` = agent pubkey, signed by the queue key, content NIP-44-encrypted to the agent pubkey:

```json
{
  "inbox": ["wss://relay.example/"],
  "destinations": [
    { "site": "x", "account": "lokkju", "fields": ["text"] }
  ],
  "allow_new_destinations": false,
  "submission_expiration_days": 30,
  "quota": { "max_submissions": 50, "period": "day" },
  "expires_at": null
}
```

`quota` and `expires_at` follow the per-connection budget model of NIP-47 (Nostr Wallet Connect): each agent gets a scoped, expiring, revocable allowance rather than open access. The service enforces the quota before publishing and devices enforce it again at ingestion (11.4). `period` is `day`, `week`, or `month`, each a calendar period in UTC: days start at 00:00 UTC, weeks on Monday at 00:00 UTC, months on the first at 00:00 UTC.

`allow_new_destinations` lets the agent submit drafts for destinations not in `destinations`; devices create those as `pending` (7.2, 8.4). It defaults to false when absent. The approval screen offers it as a visible toggle with a one-line explanation (11.8), so a user who wants an agent to propose new places turns it on per agent.

`submission_expiration_days` sets the NIP-40 expiration on this agent's submissions (7.5). It defaults to 30 when absent. Devices do not publish a grant with a value above 90, and the service refuses to submit under one. A user whose inbox is a third-party relay can shorten it per agent.

This is how an agent learns where it may draft for the user: the subset of destinations the user chose to share with that agent, and the relay to deliver submissions to. The service reads it from the relay authenticated as the agent key (9.1) and decrypts it with that key; it is the agent's view, scoped by the user.

### 7.5 Submission (NIP-59 gift wrap)

The agent's rumor is a field value event with `site`, `account`, `field`, and content. It is sealed (kind 13) with the agent key and gift-wrapped (kind 1059) with an ephemeral key, `p`-tagged to the queue pubkey, with a NIP-40 `expiration` set from the grant's `submission_expiration_days` (default 30 days, at most 90). Once a device ingests a submission, the resulting draft wrap has no expiration.

### 7.6 Site definition (proposed, Site and Field Definitions NIP)

Addressable `KIND_SITE_DEF`, `d` = site id, signed by the registry publisher key, content is the definition JSON (section 10.1). Published to public relays and bundled with the service and extension builds.

## 8. qus.me service

### 8.1 Responsibilities

MCP endpoint; OAuth 2.1 authorization server for MCP clients; agent key custody and gift-wrapping; validation of agent submissions against site definitions; device pairing rendezvous; registry serving and publishing; optionally, a bundled relay.

It does not hold queue keys, read drafts, sign as the user, or authorize submitters.

### 8.2 Agent authorization flow

1.  An MCP client starts OAuth (authorization code with PKCE, `S256` only) against the service.
2.  The service's authorize page shows a short code and QR and waits.
3.  The user opens the extension or PWA and enters or scans the code. The device fetches the pending request from the service (NIP-98 authenticated). The service mints the agent key at this fetch and returns its pubkey with the client name and requested scopes. The device shows "Claude Desktop wants to submit drafts," with a destination picker and the `allow_new_destinations` toggle.
4.  On approval, the device publishes an updated submitters list including the agent pubkey, publishes an agent grant for it, and posts a NIP-98-signed approval to the service. On denial, the device posts a NIP-98-signed denial and the service destroys the agent key.
5.  The service, authenticated to the relay as the agent key, checks that the queue's current submitters list names the agent pubkey (9.1), then completes OAuth and binds the MCP client's tokens to that agent key and queue pubkey. The relay is the authority on authorization (7.3), so an approval without a matching submitters list fails.

A pending authorization expires if no device approves it in time; the service then destroys any agent key minted for it. No live agent key exists without an approval.

**Client registration.** MCP clients identify themselves with OAuth Client ID Metadata Documents: the `client_id` is an HTTPS URL serving the client's metadata, and the service advertises `client_id_metadata_document_supported` in its authorization server metadata. The MCP authorization specification (revision 2025-11-25) makes this the recommended approach for clients and servers with no prior relationship, and lists Dynamic Client Registration only as an optional fallback. It also fits this service: there is no open registration endpoint that anyone can fill with client rows, and the client name on the approval screen comes from a document at a URL the client's publisher controls, whose host the approval screen shows next to the name. Clients that support only Dynamic Client Registration cannot connect until the service adds it.

Revocation: the user removes the agent from the submitters list on any device (effective at the relay immediately, regardless of the service), then optionally tells the service to destroy the key.

### 8.3 Device pairing flow

Pairing is NIP-AB ([nostr-protocol/nips#2328](https://github.com/nostr-protocol/nips/pull/2328)). The existing device is NIP-AB's source and the new device its target. Messages are NIP-AB's kind 24134 events between ephemeral keys, carried by the queue's private relay under the exception in 9.1.

1.  On an unlocked existing device, the user starts pairing. The device generates NIP-AB's ephemeral keypair and session secret and builds the `nostrpair://` URI, listing the first relay of the queue's kind 10013. It shows the URI as a QR code.
2.  The device also posts the URI to the service (`POST /pair`, NIP-98 signed by the queue key) and shows the short code the service returns beside the QR. The code is 8 Crockford base32 characters, single use, and expires with the NIP-AB session (120 seconds).
3.  The new device scans the QR or, without a camera, takes the typed code and fetches the URI from the service (`GET /pair/:code`, unauthenticated and rate-limited per client and per code). The service deletes the row on the first successful fetch.
4.  The devices run NIP-AB from the offer through SAS verification. The new device authenticates to the relay (NIP-42) as its ephemeral key. Both screens show the 6-digit SAS, and the user confirms on both.
5.  The existing device sends NIP-AB's `payload` message. Its `payload` field is the queue key's `ncryptsec`, never an `nsec`. The same decrypted message also carries `qusme_relays` (the queue's kind 10013 relay list) and `qusme_npub` (the queue npub). NIP-AB requires implementations to ignore unknown fields, so these do not break a plain NIP-AB peer.
6.  The new device stores the `ncryptsec`, unlocks it with the passphrase, checks that the key's pubkey equals `qusme_npub`, and sends `complete`.

Pairing never transfers an unencrypted queue key; the passphrase is still needed on the new device. The QR path does not touch the service. On the typed-code path the service sees the queue pubkey, the code, and the URI, which includes the source's ephemeral pubkey and the session secret. A compromised service could use the session secret to send its own offer first; the source then locks to the service's key, the SAS codes on the two screens differ, and the user denies. The SAS comparison is the defense on both paths, as NIP-AB intends.

What 8.3 needs that NIP-AB does not define, and which qus.me raises on the NIP-AB PR rather than in a separate NIP:

- A typed-code rendezvous for a new device without a camera (a desktop browser extension). NIP-AB has only the QR.
- Relay list and npub alongside the key. NIP-AB's `payload` message has one field; qus.me adds `qusme_relays` and `qusme_npub` and proposes a defined optional field for them.
- A requirement that the payload be an `ncryptsec`. NIP-AB prefers it but allows an `nsec`.
- Storage: NIP-AB requires platform-secure storage (a keychain or keystore). The extension's `storage.local` is not one; the NIP-49 encryption protects the key at rest there.
- Authenticated relays. NIP-AB assumes ordinary relay routing; a NIP-42 relay that restricts reads and writes has to let ephemeral keys exchange kind 24134 (9.1).

### 8.4 MCP tools

Streamable HTTP at `/mcp`, stateless, official MCP TypeScript SDK on Hono.

| Tool                | Description                                                                                                                                                                                                         |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `list_destinations` | Destinations from this agent's grant: site, account, fields, constraints                                                                                                                                            |
| `get_definition`    | Effective site definition for a granted destination                                                                                                                                                                 |
| `list_registry`     | All officially supported sites                                                                                                                                                                                      |
| `create_draft`      | Validate against constraints (422-equivalent error on violation unless `lenient`), seal with the agent key, gift-wrap to the queue, publish to the grant's inbox relay. Returns a receipt (gift wrap id, timestamp) |
| `list_submissions`  | Receipts for this agent's submissions. No content and no status, since the service retains no plaintext and cannot read the queue                                                                                   |

A draft for a destination not in the grant is accepted only if the grant's `allow_new_destinations` is true (7.4); the user's devices then create it as `pending`.

The service retains no submission plaintext after publishing. For each published submission it stores a receipt (8.5) holding the agent key id, the queue pubkey, the gift wrap id, and the time; `list_submissions` returns these, and the service counts them against the grant's quota for the current period (7.4) before publishing.

### 8.5 Portability

The service is a `createApp(deps)` Hono factory using only Web-standard APIs, with thin Workers and Node entrypoints, as in v0.1. Its own state is small:

- OAuth clients (cached Client ID Metadata Documents), authorization codes and tokens (hashed, with expiry);
- pending authorizations (8.2: short code, client id, PKCE challenge, scopes, minted agent key id, `expires_at`);
- agent keys (encrypted, with a key version so the service secret can rotate);
- bindings of agent keys to queue pubkeys;
- submission receipts (agent key id, queue pubkey, gift wrap id, created at; no content), for `list_submissions` and quota (8.4);
- pairing sessions (8.3: code, `nostrpair://` URI, queue pubkey, attempt count, `expires_at`);
- recently seen NIP-98 event ids, for replay protection;
- queues registered for the hosted relay (9.2).

SQLite on both targets (D1 on Workers, a SQLite file on Node). Rows with a TTL carry an `expires_at` column, every read filters on it, and a sweep deletes expired rows. Nothing lives in KV: KV's free-tier write limit is account-wide and small, and every pairing step is a write. Nostr publishing uses outbound websockets, available on both runtimes.

```text
packages/
  core/          Hono app, MCP tools, OAuth, pairing, validation
  nostr/         Event builders and parsers for the kinds in section 7; NIP-44/49/59 helpers
  store-sql/     Drizzle schema for service state; D1 and SQLite drivers
  entry-worker/  Workers entrypoint
  entry-node/    Node entrypoint; Dockerfile; optional bundled relay in compose
  extension/     WXT project
  pwa/           Mobile client
registry/        Site definitions (separate repo, separate license)
```

The `nostr` package is shared by the service, extension, and PWA, so every client builds and parses events identically.

## 9. Relay

### 9.1 Requirements

"AUTH pubkey" below is the pubkey a connection authenticated as under NIP-42. The relay applies read rules to every event it would return, not only to the filter in a REQ, and silently omits events a rule does not allow.

1.  **Authentication.** NIP-42 AUTH is required before any REQ or EVENT. NIP-59 itself recommends relays require it before accepting gift wraps.
2.  **Queue reads.** Kinds 31234, 30078, 10013, `KIND_SUBMITTERS`, and `KIND_AGENT_GRANT` are readable by their author, with three exceptions:
    - kind 30078 with `d` = `qus.me/recovery` is readable by any authenticated connection, so a recovering device can authenticate with a throwaway key and fetch the backup (6.1);
    - `KIND_AGENT_GRANT` is also readable by the AUTH pubkey equal to its `d` tag, the agent it is addressed to (7.4);
    - `KIND_SUBMITTERS` is also readable by any AUTH pubkey listed in its `p` tags, so the service can confirm an approval as the agent key (8.2). An agent learns the pubkeys of the other agents on the list, not their labels.
3.  **Gift wraps.** A kind 1059 event must carry exactly one `p` tag. It is accepted only from a connection whose AUTH pubkey is in the current `KIND_SUBMITTERS` of the `p`-tagged pubkey, and readable only by the AUTH pubkey equal to that `p` tag.
4.  **Pairing messages.** A kind 24134 event (NIP-AB, 8.3) is accepted from a connection whose AUTH pubkey equals the event's pubkey, if it carries exactly one `p` tag and content within NIP-AB's size bounds. The relay never stores it, delivers it only to subscriptions on connections whose AUTH pubkey equals that `p` tag, and rate-limits it per connection.
5.  **Other writes.** Any other event is accepted only when the AUTH pubkey equals the event's pubkey and the relay serves that pubkey (one queue, a configured list, or the queues registered with the hosted service, 9.2).
6.  **Expiration and deletion.** NIP-40 expiration is honored. The relay hard-deletes the author's own events, and gift wraps at the request of their `p`-tagged recipient, and refuses to store a deleted gift wrap id again.

The gift wrap write check authenticates the connection, not the event: a gift wrap is signed by an ephemeral key, so the relay checks the AUTH pubkey of the submitting connection against the list. This tells the relay operator which agent submitted each wrap, acceptable on a user's own or service-bundled relay and a reason not to use a third-party relay for the inbox.

### 9.2 Deployment

Docker: strfry or nostr-rs-relay with a write-policy plugin implementing 9.1, bundled in the service's compose file. Workers: a Workers or Durable Objects relay implementation if one meets 9.1 (to be evaluated). Users may also point at any relay meeting 9.1.

**Hosted relay.** The hosted service runs a relay for users who do not run their own, open only to queues bound to the hosted service. A queue pubkey becomes eligible when it authorizes its first agent (8.2), starts a typed-code pairing (8.3), or registers at setup when the user picks the hosted relay (a NIP-98 request to the service, 11.3). A rotation rebind (6.1) moves eligibility to the new key. Retention:

- active drafts and NIP-78 data are kept indefinitely;
- archived drafts are deleted after the settings' `archive_retention_days` (default 90, 7.2). The relay cannot see a draft's status, since it is inside the encrypted rumor, so devices do this: on sync, a device blanks and requests deletion of each archived draft whose wrap `created_at` (the time it was last republished, which archiving does) is older than the setting;
- gift wraps are bounded by their NIP-40 expiration and deleted on ingestion;
- each queue pubkey has an event count and byte cap, set in the relay's configuration; writes over the cap are refused with a NIP-01 `OK` false message naming the cap.

The relay software for the hosted relay depends on the Workers relay evaluation above.

## 10. Site registry

### 10.1 Definition format

Values below illustrate the shape; locator strings for real sites must be verified against live pages.

```json
{
  "id": "x",
  "version": "2026.10.1",
  "name": "X",
  "match": ["https://x.com/*", "https://twitter.com/*"],
  "account": {
    "locator": { "role": "button", "name": { "en": ["Account menu"] } },
    "extract": "@([A-Za-z0-9_]{1,15})"
  },
  "intents": { "compose": "https://x.com/intent/post?text={text}" },
  "fields": [
    {
      "name": "text",
      "label": "Post text",
      "locators": [ { "role": "textbox", "name": { "en": ["Post text"] } } ],
      "inject": ["paste", "insertText", "clipboard"],
      "constraints": { "maxLength": 280, "counter": "twitter-text" }
    }
  ]
}
```

Locators match ARIA role and accessible name, keyed by `document.documentElement.lang`, with `en` as fallback. `constraints.counter` names a counting strategy implemented in the `nostr`/core packages (`default`: code points; `graphemes`: extended grapheme clusters per Unicode UAX #29, as `Intl.Segmenter` with `granularity: "grapheme"` counts them, for Bluesky's 300-grapheme limit; `twitter-text`: X's weighting). Strategies are a closed set in code; definitions only reference them, and a definition naming an unknown strategy fails to load.

A definition may leave `match` empty (`[]`) when the site has no fixed hosts. Every destination for such a site must supply `match` in its override, and devices refuse to save the destination without it. Mastodon is the case: one `mastodon` definition with `match: []` and a 500-character `maxLength`, and a destination per account whose override names that account's instance (`{ "match": ["https://mastodon.social/*"] }`), with `account` in `user@instance` form. Intent templates may use `{origin}`, replaced with the origin of the effective definition's first `match` pattern (`"compose": "{origin}/share?text={text}"`). An instance with a different post limit overrides `constraints` as well.

### 10.2 Resolution

Effective definition = official definition with the destination's `override` merged over it. Custom destinations have only the override, which may be as little as `{ "match": [...] }`.

Merge rules: objects merge key by key, recursively; a scalar in the override replaces the official value; `null` in the override removes the key. Arrays replace the official array whole, including `match`, `locators`, and `inject`, so an override that adds a locator lists the official ones it keeps. `fields` is the one exception: its entries merge by `name`, an override entry with an existing `name` merging over that field by these same rules and an entry with a new `name` being appended. At insertion time the extension targets the page's focused editable element first, then the field's locators, then asks the user to click into the target field (focus placement), which works on any site.

### 10.3 Distribution and licensing

Published as signed `KIND_SITE_DEF` events under a registry publisher key, and as JSON in its own repository under CC0 (proposed). Clients verify the publisher signature. Builds bundle a snapshot, the registry publisher pubkey, and a snapshot of that key's NIP-65 relay list (kind 10002). Devices refresh by fetching the publisher's current kind 10002 from the bundled relays, then `KIND_SITE_DEF` events from its write relays; a definition replaces the bundled one only if its signature verifies against the pinned pubkey and its `version` is newer. If no relay answers, devices keep the bundled snapshot.

## 11. Browser extension

### 11.1 Framework and targets

WXT, Chrome MV3 and Firefox MV3, one codebase, `browser` namespace throughout. Safari is out of scope for v1.

### 11.2 Permissions

Required: `activeTab`, `scripting`, `contextMenus`, `storage`.

Optional, requested at setup: host permission for the qus.me service origin. Relay websockets need no host permission.

No host permissions for any site the user posts to, and no `tabs` permission. Page access exists only after a user gesture, only for the current tab, and only until navigation.

### 11.3 Setup

Either create a new queue (generate key, choose passphrase, choose relay, publish 10013 and recovery backup) or pair with an existing device (section 8.3), or recover from backup (relay URL, npub, passphrase). Choosing the hosted relay registers the queue pubkey with the service (NIP-98) before the first publish (9.2).

### 11.4 Sync and ingestion

On popup open (and on an alarm while unlocked), the background connects to the private relay, authenticates as the queue key, and requests the user's 31234 drafts, the destinations and settings events, the rotation marker (6.1), and kind 1059 addressed to the queue pubkey.

Ingestion of submissions:

- Unwrap; verify the seal's pubkey is in the current submitters list; discard otherwise.
- Derive the draft's `d` tag deterministically from the gift wrap id, so two devices ingesting concurrently produce the same addressable event rather than duplicates: `d` is the lowercase hex SHA-256 of the UTF-8 string `qus.me/submission:` followed by the gift wrap id in lowercase hex. Drafts created on a device use other ids, which never take this 64-hex-character form.
- Skip any gift wrap whose derived `d` already exists.
- Create a pending destination if the submission names an unknown one.
- Query with a lookback of at least two days past the last sync, since NIP-59 randomizes gift wrap `created_at` into the past.
- After the draft wrap is published, request deletion of the ingested gift wrap (NIP-59 permits the recipient to do this). A second device that fetched the wrap before deletion derives the same `d` and skips it.
- Enforce the grant's quota (7.4) at ingestion as well as at the service; over-quota submissions are discarded and counted. A submission counts in the period containing its rumor's `created_at`, the one timestamp NIP-59 does not randomize. Counts live in the settings event's `quota_counts` (7.2) so devices agree: per agent, the current `period_start` and the gift wrap ids `accepted` and `discarded` in that period. Before republishing settings, a device fetches the latest settings and merges by union of the id lists, keeping the later `period_start` and clearing the lists when the period advances. Two devices ingesting at once can together accept more than the quota; the service's count is the exact one, and the device check is a backstop against a compromised service.

### 11.5 Arming and inserting

1.  The user opens the popup; `activeTab` grants access to the current tab.
2.  The popup reads the tab URL and injects a read-only script resolving the site's account locator.
3.  Decrypted drafts are filtered locally by destination match and detected account. If detection fails, drafts for every account at that site are shown, labeled.
4.  The user picks a draft; it becomes the armed draft (one at a time, in `storage.session`); the background rebuilds the context menu title ("Insert: first 40 characters…").
5.  The user inserts via the popup's Insert button (targets the page's still-focused element) or the context menu item on `editable` contexts, restricted by `documentUrlPatterns` to the user's destinations. Either grants `activeTab`; the insertion script resolves the target (10.2) and runs the field's injection chain.
6.  On success the device appends an `inserted` tag, sets `status` to `archived:inserted`, republishes the wrap, and disarms.

If nothing is armed, the context menu item opens the popup.

Draft selection happens entirely in extension origin; no draft other than the inserted one enters the page. Draft text is rendered with `textContent`, never as HTML, since agent-supplied content is untrusted.

### 11.6 Injection strategies

| Strategy     | Mechanism                                                                          | Notes                                                  |
|--------------|------------------------------------------------------------------------------------|--------------------------------------------------------|
| `paste`      | Focus; dispatch a `paste` ClipboardEvent with a DataTransfer carrying `text/plain` | Default for rich editors (X, Facebook/Lexical)         |
| `insertText` | `document.execCommand('insertText', false, value)`                                 | Fallback for contenteditable                           |
| `native`     | Native value setter on the element prototype, then `input`                         | Plain `<input>` and `<textarea>` under framework state |
| `clipboard`  | Write to clipboard, focus, prompt the user to press Ctrl/Cmd+V                     | Unblockable (a real paste is trusted); always last     |

Success is judged by reading the element's value or text after injection.

### 11.7 Saving a field as a draft

A context menu item on editable contexts, "Save to qus.me," reads the focused element's value and creates a draft for the current destination (prompting if the page matches several or none).

### 11.8 Agent approvals

The extension and PWA are where the user approves agent authorizations (8.2) and pending destinations. Approval UIs show the agent label, the host of its client ID URL (8.2), and the requested destinations, offer the `allow_new_destinations` toggle (off by default) with a one-line explanation, and require the queue to be unlocked.

### 11.9 Distribution

WXT builds and zips both targets, including the sources archive AMO requires; `wxt submit` covers both stores.

## 12. Mobile PWA

A full paired device: holds the queue key (NIP-49 at rest), syncs and ingests from the relay directly, and approves agents. Tapping a draft either opens the site's `compose` intent with the value (`pwa_intent`) or copies the value and opens the site or app (`pwa_copy`; Facebook personal profiles land here). Neither archives the draft on tap, since the PWA cannot observe whether the user posted and an intent can fail (logged out, app not installed). When the PWA becomes visible again after an open, it asks "Posted?" for that draft: Yes archives it as `archived:inserted` with an `inserted` tag recording the method; Not yet, or dismissing the prompt, leaves it active. No external signer is needed, so this works on iOS.

Firefox for Android users can also run the extension.

## 13. Security and privacy

**The relay sees:** the queue pubkey, event kinds, `d` tags, sizes, and timestamps; that gift wraps arrive for the queue, and (on an enforcing relay) which agent pubkey submitted each. It does not see draft contents, destinations, sites, accounts, or status. It serves the recovery backup's `ncryptsec` to any authenticated connection (9.1), so the passphrase is the only protection against anyone who knows the relay URL and queue npub.

**The service sees:** agent submissions in plaintext at write time (not retained); contentless receipts of them; which queue pubkeys it serves; agent grants for agents it holds keys for, and the agent pubkeys on those queues' submitters lists; on a typed-code pairing, the NIP-AB URI including its session secret (8.3). It cannot read the queue, sign as the user, authorize a submitter, or approve a device. A compromised service can submit drafts as any agent key it holds, until the user revokes those agents at the relay.

**Devices see:** everything; they hold the queue key. Every device holds the same key, so revoking one device means rotating the queue key (6.1).

**The extension sees** nothing on any site until the user acts in that tab, and then only that tab until navigation. It does not observe network traffic.

**Sites see** the inserted value, as if pasted. Nothing else from the queue.

**Agents** can submit to destinations in their grant (or propose new ones if the grant allows) and read only their own grant and the pubkeys on the submitters list that names them. They cannot read, edit, or delete drafts. The human insertion step is the review gate.

**Spam** is blocked by the submitters list at the relay and again at ingestion.

**Deletion** is real on the user's own relay and best effort elsewhere. NIP-59 lets the `p`-tagged recipient delete a gift wrap, so devices delete each submission after ingesting it; NIP-40 expirations are the backstop for relays that ignore the request.

**Lost passphrase** with no remaining paired device loses the queue.

## 14. Licensing

- Service, extension, PWA, `nostr` package: PolyForm Shield 1.0.0 (proposed), described as source-available. No core contributions in v1; a CLA if that changes.
- Site registry: CC0 (proposed), open to contributions.
- Proposed NIPs: submitted to nostr-protocol/nips under that repository's terms. The NIPs are the open part; anyone can build a compatible client or service.

## 15. Post-v1

1.  Multi-field drafts, using recorded accessible names to refine locators; per-field insertion state.
2.  Threads (`sequence`, `position`) and reply/quote targets (`target`), surfaced when the user is viewing the thread.
3.  Media via Blossom servers with client-side encrypted blobs referenced from the field value; EXIF stripped before encryption; alt text as a field.
4.  Timing: due dates in the rumor, badge counts, notifications.
5.  Archive enrichment: manual "attach URL," then opt-in per-site DOM observation after an insertion.
6.  Per-device subkeys, so revoking a device doesn't require full rotation.
7.  Safari; teams and shared queues.

## 16. Prior art and related work

**NIP-47 (Nostr Wallet Connect)** is the closest Nostr analog to the agent-key model: a per-connection keypair, encrypted requests over a relay, per-connection permissions and budgets, and revocation of one connection without touching others. Its client-generated-secret variant, where the client shares only a pubkey for the user to authorize, is the same shape as section 8.2. The grant quota in 7.4 is borrowed from it.

**Safe proposers and delegates** are the closest crypto analog to the whole system: addresses authorized to propose transactions to a Safe's queue without the ability to sign or execute them, with owners approving. Safe documents an explicit pattern for AI agents proposing transactions for human signers. Differences: Safe's queue is a centralized off-chain service storing proposals in plaintext, and approval is a signature, where here approval is insertion and posting in the human's own session.

**Wallet request flows generally** (a dapp proposes, the user's wallet presents and signs) are the pattern qus.me applies to web forms. The extension occupies the wallet's position; insertion occupies the signature's.

**Human-in-the-loop approval gateways** (HumanLayer, Impri, Bonanza Approve, Delego, Preloop) queue agent actions for human approval, after which the agent executes, holding the credentials. qus.me inverts this: the human executes, in their own authenticated session, and the agent never holds credentials for the destination.

**Nostr agent tooling** such as nostr-merchant drafts replies for approve/edit/skip review and then publishes them itself, with the agent holding the posting key.

**Multi-device key transfer** has two open NIP drafts. NIP-4B, nsec Transfer ([nostr-protocol/nips#1768](https://github.com/nostr-protocol/nips/pull/1768)), transfers an nsec between apps. NIP-AB, Device Pairing ([nostr-protocol/nips#2328](https://github.com/nostr-protocol/nips/pull/2328)), builds on it with a QR bootstrap, ephemeral ECDH, and a short code compared on both screens before the key is sent; block/buzz uses it. qus.me adopts NIP-AB for pairing (8.3). Per-device keys linked to a master key ([nostr-protocol/nips#1810](https://github.com/nostr-protocol/nips/issues/1810)) and per-device encryption keys ([nostr-protocol/nips#1647](https://github.com/nostr-protocol/nips/pull/1647)) bear on the post-v1 per-device subkeys (15.6), not on v1.

**Gift wrap as a general primitive** was anticipated in the Nostr DM design discussions, which treated wrapping any kind ("nostr-in-nostr") as the intended generality of NIP-59. The Draft Inbox NIP is an application of that generality to a new kind of payload.

## 17. Open questions

- Workers relay viability against 9.1 ([#11](https://github.com/lokkju/qusme/issues/11)); the hosted relay's software depends on it (9.2).
- The hosted relay's hostname. v0.2 proposed `relay.qus.me`; nothing has settled it.
- The relays the registry publisher key lists in its NIP-65 relay list, and so the ones builds bundle (10.3).

### Decided

- 2026-10-27: the service runs at `app.qus.me` with MCP at `/mcp`. `mcp.qus.me` is not used by this service.
- 2026-10-27: pairing sessions live in D1 on Workers (and SQLite on Node) with an `expires_at` column, not KV (8.5).
- 2026-10-27: the hosted service bundles a relay, open only to queues bound to the hosted service, with retention as in 9.2 ([#27](https://github.com/lokkju/qusme/issues/27)).
- 2026-10-27: agent grants default to not allowing new destinations; the approval screen offers the toggle (7.4, 11.8; [#28](https://github.com/lokkju/qusme/issues/28)).
- 2026-10-27: a PWA intent or copy open archives the draft only after a "Posted?" confirmation (12; [#29](https://github.com/lokkju/qusme/issues/29)).
- 2026-10-27: submission expiration is a per-grant setting, default 30 days, refused above 90 (7.4, 7.5; [#30](https://github.com/lokkju/qusme/issues/30)).
- 2026-10-27: kind numbers are picked from unused ranges before v1 and used in v1, with parsers accepting former numbers (2.2; [#31](https://github.com/lokkju/qusme/issues/31)). The numbers: `KIND_FIELD_VALUE` 1235, `KIND_SUBMITTERS` 11235, `KIND_AGENT_GRANT` 31235, `KIND_SITE_DEF` 31236 ([#2](https://github.com/lokkju/qusme/issues/2)).
- 2026-10-27: device pairing adopts NIP-AB; there is no separate Device Linking NIP (8.3; [#26](https://github.com/lokkju/qusme/issues/26)).
- 2026-10-27: the queue key's `ncryptsec` uses NIP-49 `log_n` 18. The recovery backup is readable by anyone who knows the relay URL and queue npub (6.1, 9.1), so the cost sets how fast an attacker can guess passphrases offline, against how long unlocking takes on a phone. One unlock measured 1.28 s at 18 on a Node 24 server (0.32 s at 16, 5.2 s at 20); phones are slower, and a device unlocks once per session (6.1; [#40](https://github.com/lokkju/qusme/issues/40)).
