# qus.me: Specification

*Draft v0.2, 2026-10-25. Supersedes v0.1 (HTTP broker with plaintext storage).*

*Revised 2026-10-27: pairing sessions on Workers move from KV to D1 (8.5); the subdomain question in section 17 is decided.*

## 1. Summary

qus.me is a queue of values waiting to be placed into fields on web pages. Humans and agents submit drafts; each draft names a destination (a site and an account) and a field. A browser extension lets the user pick a draft and insert it into the matching field on the live page. The user always performs the final action on the site (clicking Post, Submit, Send); qus.me never does.

The launch use case is social composers (X, Facebook, LinkedIn, Bluesky, Mastodon, Nostr), where APIs are restricted, expensive, or absent (Facebook personal profiles have no posting API at all). Nothing in the architecture is specific to social posting: any site with an editable field is a destination, and agents can submit drafts for sites and fields the project has never described.

Storage, sync, and encryption are Nostr. Drafts are NIP-37 draft wraps on a private, authenticated relay, encrypted to a per-user queue key that only the user's own devices hold. Agents submit drafts as NIP-59 gift wraps and cannot read the queue. A central service (the qus.me service) provides the MCP endpoint, holds agent keys, and brokers device pairing and agent authorization, without ever holding the queue key.

### 1.1 Changes from v0.1

The HTTP broker and its SQL draft store are gone; drafts live on a Nostr relay. End-to-end encryption moves from post-v1 to the baseline. The REST API is dropped for v1 (Nostr is the raw API; MCP serves agents). Clerk/OIDC is no longer needed for user identity, which is the queue key, presented to the service via NIP-98. MCP agents become write-only. Server-side validation survives for agent submissions, since the service sees agent plaintext at write time.

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
| NIP-59 | Gift wraps for agent draft submissions and for device-linking key transfer                          |
| NIP-78 | App-specific data (kind 30078): the user's destinations and settings, encrypted to the queue key    |
| NIP-98 | HTTP auth: devices authenticate to the qus.me service by signing requests with the queue key        |

Optional, not required for v1: NIP-07 and NIP-46 (users who want the queue key in an existing signer or bunker; slower, see 6.3), NIP-55 (Android signer apps).

### 2.2 Proposed new NIPs

These are the specification's contributions to Nostr. Kind numbers below are placeholders; real numbers get chosen against the kind registry when the drafts are submitted. Search open PRs in nostr-protocol/nips for overlapping proposals (draft inboxes, device linking) before writing each one.

| Working name                   | Defines                                                                                                                                                                                                                                                                                                                                                                                          | Kinds (placeholder)                                               |
|--------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| **Web Field Values**           | An unsigned event kind carrying a value destined for a named field at a web destination (site, account, field, optional target URL), plus state tags used when it sits inside a draft wrap (status, insertion records, source). Never published bare; always inside a NIP-37 wrap or a NIP-59 gift wrap.                                                                                         | `KIND_FIELD_VALUE` (regular)                                      |
| **Draft Inbox**                | Delivery of draft submissions as NIP-59 gift wraps to a queue key; an authorized-submitters list (replaceable, public `p` tags so relays can enforce it, encrypted labels); per-submitter agent grants (destinations shared with an agent, encrypted to its key); ingestion rules (deterministic `d` tags, lookback window, dedupe). Applies to any NIP-37-eligible kind, not only field values. | `KIND_SUBMITTERS` (replaceable), `KIND_AGENT_GRANT` (addressable) |
| **Site and Field Definitions** | Addressable events, signed by a registry publisher key, describing a website's editable fields: URL match patterns, account detection, accessible-name locators, injection strategies, constraints.                                                                                                                                                                                              | `KIND_SITE_DEF` (addressable)                                     |
| **Device Linking** (candidate) | Transferring a private key to a newly paired device: ephemeral key on the new device, rendezvous code, key delivered as a gift wrap to the ephemeral pubkey. May already exist as a proposal; adopt one if it does.                                                                                                                                                                              | none beyond NIP-59                                                |

Drafts for Nostr itself need no new kind: a draft note is a NIP-37 wrap of an unsigned kind 1 event, interoperable with any client that reads NIP-37 drafts from the same key.

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

**Agent key.** A Nostr keypair minted and held by the qus.me service for one MCP client. Agent keys can submit drafts to queues that authorize them and can read only the agent grant addressed to them.

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
  |  read: queue key only                         |
  |  write: queue key events; kind 1059 from      |
  |         authorized submitters                 |
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

**At rest on devices.** Stored NIP-49-encrypted (`ncryptsec`) in `storage.local` (extension) or IndexedDB (PWA). Unlocked per session with the user's passphrase; the unlocked key lives in `storage.session` (extension) or memory (PWA). Devices may offer a "stay unlocked on this device" option that stores the key unencrypted locally; off by default.

**Recovery backup.** The same `ncryptsec` is published to the private relay as an addressable NIP-78 event (`d` = `qus.me/recovery`). Recovery on a new device needs only the relay URL, the queue npub, and the passphrase. A forgotten passphrase with no paired device remaining loses the queue; this is stated in the UI at setup.

**Rotation.** If a device is lost or compromised, a remaining device rotates: generate a new queue key; re-wrap every draft and the destinations under it; publish a new submitters list, agent grants, 10013, and recovery backup; notify the service via NIP-98 signed by the old key so it rebinds agent authorizations to the new pubkey; re-pair remaining devices. Rotation is the only revocation for a device, since every device holds the same key.

### 6.2 Agent keys

Minted by the service when an MCP client completes OAuth authorization (section 8.2). Stored by the service, encrypted at rest with a service secret. One agent key per MCP client authorization, so revocation is per client.

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

`status` is `confirmed` or `pending` (created by an agent submission naming an unknown destination). `override` is a partial site definition merged over the official one. Settings use `d` = `qus.me/settings`.

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
  "quota": { "max_submissions": 50, "period": "day" },
  "expires_at": null
}
```

`quota` and `expires_at` follow the per-connection budget model of NIP-47 (Nostr Wallet Connect): each agent gets a scoped, expiring, revocable allowance rather than open access. The service enforces the quota before publishing and devices enforce it again at ingestion.

This is how an agent learns where it may draft for the user: the subset of destinations the user chose to share with that agent, and the relay to deliver submissions to. The service can decrypt it (it holds the agent key); it is the agent's view, scoped by the user.

### 7.5 Submission (NIP-59 gift wrap)

The agent's rumor is a field value event with `site`, `account`, `field`, and content. It is sealed (kind 13) with the agent key and gift-wrapped (kind 1059) with an ephemeral key, `p`-tagged to the queue pubkey, with a NIP-40 `expiration` (default 30 days).

### 7.6 Site definition (proposed, Site and Field Definitions NIP)

Addressable `KIND_SITE_DEF`, `d` = site id, signed by the registry publisher key, content is the definition JSON (section 10.1). Published to public relays and bundled with the service and extension builds.

## 8. qus.me service

### 8.1 Responsibilities

MCP endpoint; OAuth 2.1 authorization server for MCP clients; agent key custody and gift-wrapping; validation of agent submissions against site definitions; device pairing rendezvous; registry serving and publishing; optionally, a bundled relay.

It does not hold queue keys, read drafts, sign as the user, or authorize submitters.

### 8.2 Agent authorization flow

1.  An MCP client starts OAuth (authorization code with PKCE) against the service.
2.  The service's authorize page shows a short code and QR and waits.
3.  The user opens the extension or PWA and enters or scans the code. The device fetches the pending request from the service (NIP-98 authenticated) and shows "Claude Desktop wants to submit drafts," with a destination picker.
4.  On approval, the device: receives the newly minted agent pubkey from the service; publishes an updated submitters list including it; publishes an agent grant for it; and posts a NIP-98-signed approval to the service.
5.  The service completes OAuth and binds the MCP client's tokens to that agent key and queue pubkey.

Revocation: the user removes the agent from the submitters list on any device (effective at the relay immediately, regardless of the service), then optionally tells the service to destroy the key.

### 8.3 Device pairing flow

1.  The new device generates an ephemeral keypair and requests a pairing session from the service, receiving a short code.
2.  The user enters the code on an existing device, which fetches the new device's ephemeral pubkey from the service (NIP-98 authenticated) and shows a confirmation with a short fingerprint of both keys, displayed on both screens.
3.  The existing device gift-wraps the `ncryptsec`, relay URL, and queue npub to the ephemeral pubkey and publishes it; the service relays the gift wrap id to the new device.
4.  The new device fetches and unwraps it, then unlocks with the passphrase.

The service sees only ephemeral pubkeys, a code, and an event id. Pairing never transfers an unencrypted queue key; the passphrase is still needed on the new device.

### 8.4 MCP tools

Streamable HTTP at `/mcp`, stateless, official MCP TypeScript SDK on Hono.

| Tool                | Description                                                                                                                                                                                                         |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `list_destinations` | Destinations from this agent's grant: site, account, fields, constraints                                                                                                                                            |
| `get_definition`    | Effective site definition for a granted destination                                                                                                                                                                 |
| `list_registry`     | All officially supported sites                                                                                                                                                                                      |
| `create_draft`      | Validate against constraints (422-equivalent error on violation unless `lenient`), seal with the agent key, gift-wrap to the queue, publish to the grant's inbox relay. Returns a receipt (gift wrap id, timestamp) |
| `list_submissions`  | Receipts for this agent's submissions. No content and no status, since the service retains no plaintext and cannot read the queue                                                                                   |

A draft for a destination not in the grant is accepted only if the grant allows new destinations (a per-grant flag); the user's devices then create it as `pending`.

The service retains no submission plaintext after publishing.

### 8.5 Portability

The service is a `createApp(deps)` Hono factory using only Web-standard APIs, with thin Workers and Node entrypoints, as in v0.1. Its own state is small: OAuth clients and tokens, agent keys (encrypted), queue-pubkey bindings, pairing sessions (TTL). SQLite on both targets (D1 on Workers, a SQLite file on Node). Pairing sessions live in the same SQL store on both targets, with an `expires_at` column, not in KV: KV's free-tier write limit is account-wide and small, and every pairing step is a write. Nostr publishing uses outbound websockets, available on both runtimes.

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

NIP-42 authentication, which NIP-59 itself recommends relays require before accepting gift wraps; reads of kind 31234, 30078, 10013, and the submitters and grant kinds restricted to their author; writes of kind 1059 accepted only from connections authenticated as a pubkey in the recipient's current submitters list; NIP-40 expiration honored; hard deletion of the author's own events, and of gift wraps by their `p`-tagged recipient, on request.

The write check authenticates the connection, not the event: a gift wrap is signed by an ephemeral key, so the relay checks the AUTH pubkey of the submitting connection against the list. This tells the relay operator which agent submitted each wrap, acceptable on a user's own or service-bundled relay and a reason not to use a third-party relay for the inbox.

### 9.2 Deployment

Docker: strfry or nostr-rs-relay with a write-policy plugin implementing 9.1, bundled in the service's compose file. Workers: a Workers or Durable Objects relay implementation if one meets 9.1 (to be evaluated). Users may also point at any relay meeting 9.1.

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

Locators match ARIA role and accessible name, keyed by `document.documentElement.lang`, with `en` as fallback. `constraints.counter` names a counting strategy implemented in the `nostr`/core packages (`default`: code points; `twitter-text`: X's weighting). Strategies are a closed set in code; definitions only reference them.

### 10.2 Resolution

Effective definition = official definition with the destination's `override` merged over it. Custom destinations have only the override, which may be as little as `{ "match": [...] }`. At insertion time the extension targets the page's focused editable element first, then the field's locators, then asks the user to click into the target field (focus placement), which works on any site.

### 10.3 Distribution and licensing

Published as signed `KIND_SITE_DEF` events under a registry publisher key, and as JSON in its own repository under CC0 (proposed). Clients verify the publisher signature. Builds bundle a snapshot; devices refresh from relays.

## 11. Browser extension

### 11.1 Framework and targets

WXT, Chrome MV3 and Firefox MV3, one codebase, `browser` namespace throughout. Safari is out of scope for v1.

### 11.2 Permissions

Required: `activeTab`, `scripting`, `contextMenus`, `storage`.

Optional, requested at setup: host permission for the qus.me service origin. Relay websockets need no host permission.

No host permissions for any site the user posts to, and no `tabs` permission. Page access exists only after a user gesture, only for the current tab, and only until navigation.

### 11.3 Setup

Either create a new queue (generate key, choose passphrase, choose relay, publish 10013 and recovery backup) or pair with an existing device (section 8.3), or recover from backup (relay URL, npub, passphrase).

### 11.4 Sync and ingestion

On popup open (and on an alarm while unlocked), the background connects to the private relay, authenticates as the queue key, and requests the user's 31234 drafts, the destinations event, and kind 1059 addressed to the queue pubkey.

Ingestion of submissions:

- Unwrap; verify the seal's pubkey is in the current submitters list; discard otherwise.
- Derive the draft's `d` tag deterministically from the gift wrap id (hash), so two devices ingesting concurrently produce the same addressable event rather than duplicates.
- Skip any gift wrap whose derived `d` already exists.
- Create a pending destination if the submission names an unknown one.
- Query with a lookback of at least two days past the last sync, since NIP-59 randomizes gift wrap `created_at` into the past.
- After the draft wrap is published, request deletion of the ingested gift wrap (NIP-59 permits the recipient to do this). A second device that fetched the wrap before deletion derives the same `d` and skips it.
- Enforce the grant's quota (7.4) at ingestion as well as at the service; over-quota submissions are discarded and counted.

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

The extension and PWA are where the user approves agent authorizations (8.2) and pending destinations. Approval UIs show the agent label and the requested destinations, and require the queue to be unlocked.

### 11.9 Distribution

WXT builds and zips both targets, including the sources archive AMO requires; `wxt submit` covers both stores.

## 12. Mobile PWA

A full paired device: holds the queue key (NIP-49 at rest), syncs and ingests from the relay directly, and approves agents. Tapping a draft either opens the site's `compose` intent with the value (`pwa_intent`) or copies the value and opens the site or app (`pwa_copy`; Facebook personal profiles land here). Either archives the draft, with undo. No external signer is needed, so this works on iOS.

Firefox for Android users can also run the extension.

## 13. Security and privacy

**The relay sees:** the queue pubkey, event kinds, `d` tags, sizes, and timestamps; that gift wraps arrive for the queue, and (on an enforcing relay) which agent pubkey submitted each. It does not see draft contents, destinations, sites, accounts, or status.

**The service sees:** agent submissions in plaintext at write time (not retained); which queue pubkeys it serves; agent grants for agents it holds keys for. It cannot read the queue, sign as the user, authorize a submitter, or approve a device. A compromised service can submit drafts as any agent key it holds, until the user revokes those agents at the relay.

**Devices see:** everything; they hold the queue key. Every device holds the same key, so revoking one device means rotating the queue key (6.1).

**The extension sees** nothing on any site until the user acts in that tab, and then only that tab until navigation. It does not observe network traffic.

**Sites see** the inserted value, as if pasted. Nothing else from the queue.

**Agents** can submit to destinations in their grant and read only their own grant. They cannot read, edit, or delete drafts. The human insertion step is the review gate.

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

**Multi-device key transfer** has no NIP as of this draft. Implementations exist outside the NIP process (for example, QR-initiated ECDH pairing with an encrypted relay backup), which supports specifying Device Linking rather than inventing a private scheme.

**Gift wrap as a general primitive** was anticipated in the Nostr DM design discussions, which treated wrapping any kind ("nostr-in-nostr") as the intended generality of NIP-59. The Draft Inbox NIP is an application of that generality to a new kind of payload.

## 17. Open questions

- Subdomain layout: `mcp.qus.me` currently hosts Lokkju Labs MCP services. Move them, or run this service at `app.qus.me` with MCP at `/mcp` and the bundled relay at `relay.qus.me`.
  - **Decided:** the service runs at `app.qus.me` with MCP at `/mcp`. `mcp.qus.me` is not used by this service.
- **Decided:** pairing sessions live in D1 on Workers (and SQLite on Node) with an `expires_at` column, not KV (8.5).
- Whether the hosted service bundles a relay for users who don't run one, and its retention policy.
- Workers relay viability against 9.1.
- Whether agent grants default to allowing new destinations.
- Whether a PWA intent open archives immediately or after confirmation.
- Default submission expiration (30 days proposed).
- Kind numbers for the proposed NIPs, and whether Device Linking duplicates an existing proposal.
