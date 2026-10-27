# qus.me: Specification

*Draft v0.4, 2026-10-27. Supersedes v0.3.*

## 1. Summary

qus.me is a queue of values waiting to be placed into fields on web pages. Humans and agents submit drafts; each draft names a destination (a site and an account) and a field. A browser extension lets the user pick a draft and insert it into the matching field on the live page. The user always performs the final action on the site (clicking Post, Submit, Send); qus.me never does.

The launch use case is social composers (X, Facebook, LinkedIn, Bluesky, Mastodon, Nostr), where APIs are restricted, expensive, or absent (Facebook personal profiles have no posting API at all). Nothing in the architecture is specific to social posting: any site with an editable field is a destination, and agents can submit drafts for sites and fields the project has never described.

Storage, sync, and encryption are Nostr. Drafts are NIP-37 draft wraps on ordinary Nostr relays the user chooses, encrypted to a per-user queue key that only the user's own devices hold. Agents submit drafts as NIP-59 gift wraps to a separate inbox key and cannot read the queue. An optional relay profile, met by a paid hosted relay, also hides the queue's metadata (9.2). A central service (the qus.me service) provides the MCP endpoint, holds agent keys, and brokers device pairing and agent authorization, without ever holding the queue key.

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

### 1.3 Changes from v0.3

- v1 runs on ordinary relays. A new baseline profile (9.1) has two roles: storage relays (the queue kinds, NIP-09 and NIP-40, events up to 64 KiB, no AUTH) and an inbox relay (NIP-42, kind 1059 readable only by the `p`-tagged pubkey). Devices check relays by probing, not from NIP-11 alone. v0.3's relay rules become the optional qus.me relay profile (9.2), met by the paid, account-gated hosted relay ([#39](https://github.com/lokkju/qusme/issues/39)). Section 5's diagram, section 7's opening, and 2.1 change to match ([#38](https://github.com/lokkju/qusme/issues/38), `docs/relays.md`).
- Section 13 says what ordinary relays expose (the queue pubkey, timing and volume, agent pubkeys, the encrypted recovery backup) and that the qus.me relay profile is what hides it. Spam and deletion are restated per profile.
- A separate inbox key (6.4): gift wraps `p`-tag an inbox pubkey distinct from the queue pubkey, given to agents in their grants, held by devices in the encrypted settings, and rotatable alone. Grants gain `inbox_pubkey` and an optional NIP-13 `min_pow` (7.4); settings gain the inbox key and relays (7.2).
- The published recovery backup is encrypted with a device-generated 128-bit recovery code, shown once at setup and confirmed; the passphrase protects only the local copy. Recovery needs the relay URL, npub, and recovery code; rotation issues a new code (6.1, 11.3). On the qus.me relay profile a passphrase-only backup is optional (9.2).
- Ingestion is ordered by cost: dedupe by derived `d`, proof of work, a cap of 100 wraps opened per sync, and the seal's pubkey checked against the submitters list before the seal is verified or the rumor decrypted (11.4).
- Recipient deletion of gift wraps cites NIP-17 and [nostr-protocol/nips#2350](https://github.com/nostr-protocol/nips/pull/2350), not NIP-59, with the observed behavior (11.4, 13).
- A field value is capped at 32 KiB of plaintext (7.1, 8.4).
- The `qus.me/` `d`-tag prefix is recorded as a deliberate choice (7.2).
- Pairing (8.3) corrected after the NIP-AB review ([#26](https://github.com/lokkju/qusme/issues/26)): the claim that mismatched SAS codes stop a compromised service is replaced with the real property; the URI lists up to three storage relays; `complete` is sent once the key is stored, before the passphrase prompt; the payload is buffered until the transcript hash checks and the user confirms the SAS; `qusme_relays` is checked against the queue's kind 10013; the pairing connection authenticates as the ephemeral key; `payload_type` `"nsec"` is sent and a raw `nsec` refused; the ephemeral-event retention of ordinary relays is noted. A typed-code session sends the recovery backup as the payload.
- The service runs on the homelab through the Node entrypoint for development, at `app.qus.me`; Workers remains supported at the same hostname (8.5, 9.3).

## 2. NIPs

### 2.1 Existing NIPs used

| NIP    | Used for                                                                                            |
|--------|-----------------------------------------------------------------------------------------------------|
| NIP-01 | Event model; replaceable and addressable events; relay protocol                                     |
| NIP-09 | Deletion requests for dismissed or purged drafts (best effort on third-party relays)                |
| NIP-11 | Relay information document; read alongside the probe that checks a relay before a device uses it (9.1), never instead of it |
| NIP-13 | Optional proof of work on submission gift wraps, set per agent grant (7.4) and checked before any decryption (11.4) |
| NIP-17 | A recipient's deletion of gift wraps addressed to it (11.4); inbox relays that restrict kind 1059 reads to the recipient (9.1) |
| NIP-19 | bech32 encodings for display and transfer (`npub`, `ncryptsec`)                                     |
| NIP-37 | Draft wraps (kind 31234) holding every draft; private storage relay list (kind 10013)               |
| NIP-40 | Expiration tags on submission gift wraps                                                            |
| NIP-42 | Relay authentication: inbox relays restrict kind 1059 reads to the recipient (9.1); the qus.me relay profile also restricts queue reads and gift wrap writes (9.2) |
| NIP-44 | Encryption for draft wraps, app data, agent grants, and key transfer                                |
| NIP-49 | Encryption of the queue key at rest on devices (passphrase) and in the recovery backup (recovery code, 6.1) |
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
| **Draft Inbox**                | Delivery of draft submissions as NIP-59 gift wraps to an inbox key distinct from the queue key; an authorized-submitters list (replaceable, public `p` tags so a relay can enforce it, encrypted labels); per-submitter agent grants (destinations shared with an agent, encrypted to its key); ingestion rules (deterministic `d` tags, lookback window, dedupe). Applies to any NIP-37-eligible kind, not only field values. | `KIND_SUBMITTERS` = 11235 (replaceable), `KIND_AGENT_GRANT` = 31235 (addressable) |
| **Site and Field Definitions** | Addressable events, signed by a registry publisher key, describing a website's editable fields: URL match patterns, account detection, accessible-name locators, injection strategies, constraints.                                                                                                                                                                                              | `KIND_SITE_DEF` = 31236 (addressable)                             |

Drafts for Nostr itself need no new kind: a draft note is a NIP-37 wrap of an unsigned kind 1 event, interoperable with any client that reads NIP-37 drafts from the same key.

Device linking, a candidate in v0.2, is not proposed: pairing adopts NIP-AB (8.3). Where 8.3 needs more than NIP-AB defines, qus.me comments on the NIP-AB PR rather than writing a separate NIP.

## 3. Goals and non-goals

v1 goals:

- End-to-end encrypted draft storage on ordinary Nostr relays (9.1), with an optional relay profile that also hides the queue's metadata (9.2).
- A qus.me service deployable unchanged to Cloudflare Workers or to Docker/Node, providing MCP, agent key custody, pairing, and agent authorization.
- A single-codebase browser extension for Chrome and Firefox (Manifest V3) that inserts a user-selected draft into a page field with no standing access to any site.
- A mobile PWA that is a full paired device.
- A maintained, separately licensed registry of site definitions, published as signed Nostr events.
- Per-user destinations layered over the registry.

v1 non-goals: automatic posting of any kind; observing page network traffic; scheduling and reminders; multi-field drafts; media; teams and shared queues; a REST API.

## 4. Concepts

**Queue key.** A Nostr keypair dedicated to one user's qus.me queue, generated on the user's first device. It signs and decrypts everything in the queue. It is distinct from any public Nostr identity the user has, since anyone who can read the storage relays sees event timing and volume under this pubkey. Only the user's paired devices hold it.

**Inbox key.** A second keypair per queue, the one agent submissions are addressed to (6.4). Agents learn its pubkey from their grants; devices hold its secret in the encrypted settings. Nothing public links it to the queue key.

**Recovery code.** A 128-bit code a device generates at setup and the user stores. It encrypts the published recovery backup of the queue key (6.1).

**Storage relays and inbox relay.** The queue's events live on its storage relays, listed in its kind 10013; submissions arrive on its inbox relay, named in each agent grant (9.1).

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
  MCP clients                         Devices (hold queue key and inbox key)
  (Claude, etc.)                      extension | PWA
       |                                 |   ^
       | OAuth + MCP                     |   | NIP-98 (pairing, approvals)
       v                                 v   |
  +-----------------------------------------------+
  |               qus.me service                  |
  |  MCP /mcp   OAuth AS   pairing rendezvous     |
  |  agent key custody   validation   registry    |
  +-----------------------------------------------+
       |  gift wraps (NIP-59) to the       |  reads grants and
       |  inbox key, sealed by agent keys  |  submitters lists
       v                                   v
  +----------------------+   +----------------------------+
  |  Inbox relay         |   |  Storage relays (10013)    |
  |  NIP-42; kind 1059   |   |  drafts, destinations,     |
  |  readable only by    |   |  settings, submitters,     |
  |  the p-tagged key    |   |  grants, recovery backup;  |
  |                      |   |  NIP-AB pairing messages   |
  +----------------------+   +----------------------------+
       ^   REQ (AUTH as inbox key)         ^   REQ / EVENT
       |                                   |
  Devices: decrypt locally, ingest submissions, manage drafts
                       |
                       |  activeTab-scoped script injection
                       v
               the user's tab (x.com, facebook.com, ...)
```

The relays are ordinary Nostr relays meeting the baseline profile (9.1); one relay meeting the qus.me relay profile (9.2) can fill both roles and also hides the queue's metadata. The storage relays are the source of truth for drafts, destinations, and state. The service is never in the read path for the queue. Devices talk to the relays directly.

## 6. Keys

### 6.1 Queue key lifecycle

**Generation.** On first setup, the device generates the queue key locally. The service is not involved.

**At rest on devices.** Stored NIP-49-encrypted (`ncryptsec`) in `storage.local` (extension) or IndexedDB (PWA), at scrypt cost `log_n` 18 (256 MiB per unlock). A device can raise the cost later by re-encrypting its local copy; decoders refuse an `ncryptsec` above `log_n` 20. The passphrase protects only this local copy, never a published one. Unlocked per session with the user's passphrase; the unlocked key lives in `storage.session` (extension) or memory (PWA). Devices may offer a "stay unlocked on this device" option that stores the key unencrypted locally; off by default.

**Recovery code.** At setup the device generates a recovery code: 16 random bytes, shown to the user as 12 words from the BIP-39 English list and offered as a 26-character Crockford base32 string for printing. Devices accept either form and parse it back to the 16 bytes. Setup shows the code once and asks the user to confirm it was saved before it publishes anything. Devices do not keep the code.

**Recovery backup.** The device encrypts the queue key with NIP-49 at `log_n` 18, using as the password the 32-character lowercase hex of the recovery code's bytes, and publishes that `ncryptsec` to the storage relays as an addressable NIP-78 event (`d` = `qus.me/recovery`). Devices keep a copy of the published event, since a typed-code pairing sends it (8.3). Recovery on a new device needs the relay URL, the queue npub, and the recovery code; the device then asks for the passphrase and encrypts its local copy under it. On an ordinary relay the backup is readable by anyone, and a single filter on its `d` tag returns the backup of every queue on that relay (13). A copy fetched once can be attacked offline indefinitely, which is why the published copy is encrypted with a 128-bit random code and not with a passphrase. On a relay meeting the qus.me relay profile the backup is served to any authenticated connection, so a recovering device can fetch it with a throwaway key (9.2).

A user who has lost the code but still has an unlocked device can issue a new one: the device generates a new code, shows it as at setup, and republishes the backup under it. Copies of the old backup that a relay or anyone else kept still open with the old code. A lost recovery code with no paired device remaining loses the queue, and a forgotten passphrase is recovered with the recovery code; the setup UI states both.

On the qus.me relay profile only, a user may choose to publish the backup encrypted with the passphrase instead of a recovery code, since that profile serves the backup only to authenticated connections and the relay can rate-limit them (optional, 9.2).

**Rotation.** If a device is lost or compromised, a remaining device rotates: generate a new queue key; re-wrap every draft and the destinations and settings under it, keeping each `d`; generate a new inbox key (6.4), since the lost device held the old one; publish a new submitters list, agent grants (same content apart from the new `inbox_pubkey`), 10013, settings, and a recovery backup under a new recovery code (shown to the user as at setup); rebind agent authorizations at the service; publish a rotation marker under the old key; delete the old key's other events (blanked wraps and NIP-09) once the service confirms the rebind; re-pair remaining devices. On the hosted relay the new key is bound to the user's account before the first publish under it, since the relay admits only bound keys (9.2). Each step is idempotent, so a rotation interrupted at any point finishes on the next run. Rotation is the only revocation for a device, since every device holds the same key.

The rebind is `POST /rotate`, NIP-98 signed by the old key, with a body holding an event signed by the new key that names the old pubkey. The service rebinds every binding from the old queue pubkey to the new one only when both signatures verify, so the new key named in a rebind is always one the requester controls. This does not cover an attacker who holds the old key and rotates first to a key of their own: the service then binds the user's agents to the attacker's queue, and the agents' later submissions go there. The user's remedy is to revoke those authorizations in the MCP clients and authorize the clients again under the user's new key.

The rotation marker is a NIP-78 event under the old key, `d` = `qus.me/rotated`, content NIP-44-encrypted to the old key, holding the new npub as `{ "npub": "<new npub>" }`. A device that unlocks and finds it tells the user the queue has rotated and offers pairing (8.3) with a device that holds the new key. A device never switches keys on the marker alone, since anyone holding the old key can publish one.

### 6.2 Agent keys

Minted by the service when a device fetches a pending OAuth authorization (section 8.2, step 3), and destroyed if the user denies it or it expires before approval. Stored by the service, encrypted at rest with a service secret. One agent key per MCP client authorization, so revocation is per client.

### 6.3 External signers

A user who prefers to keep the queue key in a NIP-46 bunker or NIP-07 extension can do so; devices then call the signer for every signature and decryption. Opening the popup over N drafts costs N remote `nip44_decrypt` round trips with a bunker. Supported, documented as slower, not the default.

### 6.4 Inbox key

Gift wraps from agents `p`-tag the inbox key's pubkey, not the queue pubkey (7.5). The first device generates the inbox key with the queue key and keeps its secret in the settings event (7.2), so every device holds it. Each agent grant carries the inbox pubkey (7.4), encrypted to the agent, so nothing on a storage relay links the inbox to the queue: a stranger who learns the queue pubkey cannot address a gift wrap to it, and the storage relays do not show submission timing for the queue pubkey. On the inbox relay, devices authenticate as the inbox key (NIP-42 allows several AUTH pubkeys on one connection) to read and delete its gift wraps.

The inbox key rotates without the queue key. If an agent's grant leaks the inbox pubkey or the inbox is flooded, a device generates a new inbox key, writes it to the settings, and republishes every grant with the new `inbox_pubkey`. The old key moves to the settings' `retired_inbox_keys` with the time it was retired, and devices keep draining gift wraps addressed to it, under the same limits as current ones (11.4), until the longest `submission_expiration_days` among the grants at that time has passed, then drop it. A queue key rotation (6.1) also rotates the inbox key.

## 7. Events

Queue-key events go to the storage relays listed in the queue's kind 10013, every one of them; devices read from all of them and keep the latest version of each replaceable or addressable event. Gift wraps go to the inbox relay named in each agent grant (7.4).

**Unknown fields.** Devices on different builds share one queue, since extension-store and PWA updates arrive at different times. Data that devices read and republish (field value rumor tags, destinations, settings, the recovery backup, the rotation marker, agent grants as the queue reads them, submitters labels) is parsed strictly for the fields a build knows, and unknown tags and keys are kept and written back unchanged, after the known ones, when the device republishes. Agent submissions stay strict: draft state tags (`status`, `source`, `inserted`, `destination`) are refused and other unknown tags are dropped and logged. Site definitions and agent grants as the agent reads them ignore unknown keys, and a site field naming an injection strategy or counter the build does not know is unusable, not fatal to the definition.

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

A field value's content is at most 32 KiB (32,768 bytes of UTF-8), which keeps its draft wrap, tags and NIP-44 padding included, under the 64 KiB event size that default strfry relays accept (9.1). The service's validation (8.4) and devices, when saving a draft or ingesting a submission, both enforce it.

`status` is `active`, `archived:inserted`, or `archived:dismissed`. `inserted` tags accumulate; restoring a draft sets `status` back to `active` and keeps them. `source` is present only for agent submissions. Because the whole rumor is encrypted, site, account, field, and status are invisible to the relays.

Reserved for post-v1: `target` (reply or quote URL), `sequence` and `position` (threads).

Editing a draft republishes the wrap with the same `d`. Deleting it publishes a blanked wrap per NIP-37 and a NIP-09 deletion request. A relay meeting the qus.me relay profile hard-deletes; an ordinary relay may honor the request, and copies other relays or archivers made may remain (13).

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
  "inbox_key": "<inbox secret key, hex>",
  "inbox_relays": ["wss://auth.nostr1.com/"],
  "retired_inbox_keys": [ { "key": "<hex>", "retired_at": 1761400000 } ],
  "quota_counts": {
    "<agent pubkey>": { "period_start": 1761350400, "accepted": ["<gift wrap id>"], "discarded": ["<gift wrap id>"] }
  }
}
```

`archive_retention_days` is how long devices keep archived drafts before deleting them; `null` keeps them indefinitely. It defaults to 90 for a queue on the hosted relay and to `null` elsewhere (9.2). `inbox_key`, `inbox_relays`, and `retired_inbox_keys` are the inbox key and the relays devices read it on (6.4, 9.1). `quota_counts` is the devices' shared record of ingestion against each agent's quota (11.4).

The `qus.me/` prefix on these `d` tags, and on the recovery backup's and the rotation marker's, identifies a pubkey as a qus.me queue to anyone who can read the storage relays. NIP-78 expects an application identifier in the `d` tag, and qus.me keeps the prefix by choice: the event kinds of 7.3 and 7.4 identify a queue as well, and the inbox key (6.4) already removes the link between a queue and its submissions.

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

`p` tags are public so the service can confirm an approval (8.2) and a relay meeting the qus.me relay profile can enforce writes (9.2); on ordinary relays anyone can read them (13). Labels are encrypted. The list is signed by the queue key, which the service never holds, so a compromised service cannot authorize a new submitter.

When the inbox relay meets the qus.me relay profile, devices also publish the same list signed by the inbox key, to that relay only, so the relay can gate gift wraps addressed to the inbox pubkey (9.2, rule 3). They never publish that copy to an ordinary relay, where its agent `p` tags would link the inbox key to the queue.

### 7.4 Agent grant (proposed, Draft Inbox NIP)

Addressable `KIND_AGENT_GRANT`, `d` = agent pubkey, signed by the queue key, content NIP-44-encrypted to the agent pubkey:

```json
{
  "inbox": ["wss://auth.nostr1.com/"],
  "inbox_pubkey": "<inbox pubkey, hex>",
  "min_pow": 0,
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

`inbox` lists the inbox relays and `inbox_pubkey` the inbox key (6.4) the agent addresses its submissions to. `min_pow`, when present and above 0, is the NIP-13 difficulty the agent's gift wrap ids must have; devices check it before any decryption (11.4). The service mines it for each submission. Mining 20 bits takes about a million SHA-256 hashes, more than the Workers free plan's CPU limit allows per request, so devices leave it absent unless the user turns it on for an agent, typically after rotating a flooded inbox (6.4).

This is how an agent learns where it may draft for the user: the subset of destinations the user chose to share with that agent, and the relay and key to deliver submissions to. The service reads it from the queue's storage relays, authenticating as the agent key where a relay asks for NIP-42 AUTH (9.2), and decrypts it with that key; it is the agent's view, scoped by the user.

### 7.5 Submission (NIP-59 gift wrap)

The agent's rumor is a field value event with `site`, `account`, `field`, and content. It is sealed (kind 13) with the agent key and gift-wrapped (kind 1059) with an ephemeral key, `p`-tagged to the grant's `inbox_pubkey`, with a NIP-40 `expiration` set from the grant's `submission_expiration_days` (default 30 days, at most 90) and NIP-13 work on its id if the grant sets `min_pow`. Once a device ingests a submission, the resulting draft wrap has no expiration.

On an inbox relay meeting the qus.me relay profile, the service authenticates as the agent key, which that relay checks against the submitters list (9.2). On any other inbox relay that asks for AUTH, it authenticates with a key generated for that connection, so the relay does not learn which agent sent each gift wrap.

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
4.  On approval, the device publishes an updated submitters list including the agent pubkey, publishes an agent grant for it, and posts a NIP-98-signed approval to the service naming the queue's storage relays. On denial, the device posts a NIP-98-signed denial and the service destroys the agent key.
5.  The service reads the queue's current submitters list from those storage relays, authenticating as the agent key where a relay asks (9.2), and checks that it names the agent pubkey. It then completes OAuth and binds the MCP client's tokens to that agent key, the queue pubkey, and the storage relays. The submitters list signed by the queue key is the authority on authorization (7.3), so an approval without a matching submitters list fails.

A pending authorization expires if no device approves it in time; the service then destroys any agent key minted for it. No live agent key exists without an approval.

**Client registration.** MCP clients identify themselves with OAuth Client ID Metadata Documents: the `client_id` is an HTTPS URL serving the client's metadata, and the service advertises `client_id_metadata_document_supported` in its authorization server metadata. The MCP authorization specification (revision 2025-11-25) makes this the recommended approach for clients and servers with no prior relationship, and lists Dynamic Client Registration only as an optional fallback. It also fits this service: there is no open registration endpoint that anyone can fill with client rows, and the client name on the approval screen comes from a document at a URL the client's publisher controls, whose host the approval screen shows next to the name. Clients that support only Dynamic Client Registration cannot connect until the service adds it.

Revocation: the user removes the agent from the submitters list on any device, then optionally tells the service to destroy the key. Regardless of the service, devices discard the agent's submissions at ingestion from then on, and a relay meeting the qus.me relay profile refuses them at once. On the baseline profile the agent still knows the inbox pubkey, so the user may also rotate the inbox key (6.4).

### 8.3 Device pairing flow

Pairing is NIP-AB ([nostr-protocol/nips#2328](https://github.com/nostr-protocol/nips/pull/2328)). The existing device is NIP-AB's source and the new device its target. Messages are NIP-AB's kind 24134 events between ephemeral keys, carried by the queue's storage relays.

1.  On an unlocked existing device, the user starts pairing. The device generates NIP-AB's ephemeral keypair and session secret and builds the `nostrpair://` URI, listing up to three of the queue's storage relays (its kind 10013) and never the inbox relay, which may refuse kind 24134. It shows the URI as a QR code.
2.  If the new device has no camera, the user asks the existing device for a typed code. The device posts the URI to the service (`POST /pair`, NIP-98 signed by the queue key) and shows the short code the service returns beside the QR. The code is 8 Crockford base32 characters, single use, and expires with the NIP-AB session (120 seconds). A session that issued a code is a typed-code session from then on (step 5).
3.  The new device scans the QR or, without a camera, takes the typed code and fetches the URI from the service (`GET /pair/:code`, unauthenticated and rate-limited per client and per code). The service deletes the row on the first successful fetch.
4.  Each device opens a relay connection for the pairing session alone. Where a relay asks for NIP-42 AUTH, each authenticates on it as its session ephemeral key, never as the queue key or the inbox key. The devices run NIP-AB from the offer through SAS verification. Both screens show the 6-digit SAS, and the user confirms on both.
5.  The existing device sends NIP-AB's `payload` message with `payload_type` `"nsec"`, which block/buzz's parser requires, and a `payload` that is always an `ncryptsec`, never an `nsec`. On a QR session it is the device's passphrase-encrypted local copy (6.1). On a typed-code session it is the published recovery backup, encrypted with the recovery code. The same decrypted message also carries `qusme_relays` (the queue's storage relays) and `qusme_npub` (the queue npub). NIP-AB requires implementations to ignore unknown fields, so these do not break a plain NIP-AB peer.
6.  The new device buffers a `payload` message that arrives early and reads it only once the transcript hash verifies and the user has confirmed the SAS on that device. If `payload` is not an `ncryptsec`, it discards it, sends `complete` with `success: false`, and tells the user. Otherwise it stores the `ncryptsec` and sends `complete` at once, before asking the user for anything, since NIP-AB's source waits only 30 seconds for it.
7.  The new device asks for the passphrase (QR session) or the recovery code (typed-code session, after which it asks for the passphrase and encrypts its local copy under it), unlocks the key, and checks that its pubkey equals `qusme_npub`; on a mismatch it discards the key and tells the user. It then fetches and decrypts the queue's kind 10013, which the queue key signs and which is the authority on the storage relays. If it differs from `qusme_relays`, or none is found on them, the device tells the user and asks for a relay URL.

Pairing never transfers an unencrypted queue key. The QR path does not touch the service, and a party that only sees the QR cannot compute the new device's SAS, so it gets one guess in 10^6.

A party that relays the URI to the new device can defeat the SAS. On the typed-code path that party is the service: it can return its own `nostrpair://` URI, learn the new device's SAS from the new device's offer, and generate offer keys for the real source until the source's SAS matches, about 10^6 tries and seconds of work. Both screens then show the same code, the user confirms both, and the source sends the payload to the service. The transcript hash does not catch this, since each leg is consistent on its own. This is acceptable only because the payload is always an `ncryptsec`: on a typed-code session it is the recovery backup, which the service could already fetch from the storage relays, since it knows the queue pubkey and the relays. The typed path is therefore no weaker than recovery (6.1), and the 128-bit recovery code puts that blob out of reach of offline guessing. A substituted URI can also give the new device a different `qusme_relays`, which step 7's check against the signed kind 10013 catches. The commit-then-reveal change proposed on the NIP-AB PR would close this; qus.me implements it if NIP-AB adopts it.

On ordinary relays any subscriber of the filter sees the pairing messages, not only the `p`-tagged key, and strfry relays return them to later queries for about five minutes (`ephemeralEventsLifetimeSeconds`, 300 by default). The messages are NIP-44 between ephemeral keys, so this shows only that a pairing took place, when, and the message sizes.

What 8.3 needs that NIP-AB does not define, and which qus.me raises on the NIP-AB PR rather than in a separate NIP:

- A typed-code rendezvous for a new device without a camera (a desktop browser extension). NIP-AB has only the QR, and a relayed URI defeats the SAS as above. The proposal: a security consideration that any party relaying the URI can do this and that such a path sends only `ncryptsec` payloads, or, as NIP-AB `v=2`, a commit-then-reveal step before the SAS.
- Relay list and npub alongside the key. NIP-AB's `payload` message in the PR text has one field, while block/buzz requires `payload_type`; qus.me sends `payload_type`, adds `qusme_relays` and `qusme_npub`, and proposes that the NIP define `payload_type` and optional `pubkey` and `relays`. If it does, qus.me sends both its own and the standard fields for one release and then drops `qusme_*`.
- A requirement that the payload be an `ncryptsec`. NIP-AB prefers it but allows an `nsec`; qus.me requires it everywhere as its own policy.
- Storage: NIP-AB requires platform-secure storage (a keychain or keystore). The extension's `storage.local` is not one; the NIP-49 encryption protects the key at rest there.
- Authenticated relays. NIP-AB says no special relay handling is required; on a relay that asks for NIP-42 AUTH, each device authenticates as its ephemeral key, never the user's key.
- Ephemeral-event retention and fan-out on ordinary relays, as above. NIP-AB's security does not depend on it; one sentence under its metadata privacy section.

### 8.4 MCP tools

Streamable HTTP at `/mcp`, stateless, official MCP TypeScript SDK on Hono.

| Tool                | Description                                                                                                                                                                                                         |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `list_destinations` | Destinations from this agent's grant: site, account, fields, constraints                                                                                                                                            |
| `get_definition`    | Effective site definition for a granted destination                                                                                                                                                                 |
| `list_registry`     | All officially supported sites                                                                                                                                                                                      |
| `create_draft`      | Validate against constraints (422-equivalent error on violation unless `lenient`, which never relaxes the 32 KiB cap of 7.1), seal with the agent key, gift-wrap to the grant's `inbox_pubkey` with any `min_pow` work, publish to the grant's inbox relays. Returns a receipt (gift wrap id, timestamp) |
| `list_submissions`  | Receipts for this agent's submissions. No content and no status, since the service retains no plaintext and cannot read the queue                                                                                   |

A draft for a destination not in the grant is accepted only if the grant's `allow_new_destinations` is true (7.4); the user's devices then create it as `pending`.

The service retains no submission plaintext after publishing. For each published submission it stores a receipt (8.5) holding the agent key id, the queue pubkey, the gift wrap id, and the time; `list_submissions` returns these, and the service counts them against the grant's quota for the current period (7.4) before publishing.

### 8.5 Portability

The service is a `createApp(deps)` Hono factory using only Web-standard APIs, with thin Workers and Node entrypoints, as in v0.1. For development it runs on the operator's homelab through the Node entrypoint, behind a Cloudflare tunnel at `app.qus.me`; Workers remains a supported target at the same hostname. Its own state is small:

- OAuth clients (cached Client ID Metadata Documents), authorization codes and tokens (hashed, with expiry);
- pending authorizations (8.2: short code, client id, PKCE challenge, scopes, minted agent key id, `expires_at`);
- agent keys (encrypted, with a key version so the service secret can rotate);
- bindings of agent keys to queue pubkeys and the queues' storage relays;
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

## 9. Relays

A queue runs on ordinary Nostr relays meeting the baseline profile (9.1). The qus.me relay profile (9.2) is optional: it adds enforcement that hides the queue's metadata, and it is what the paid hosted relay offers. Content is end-to-end encrypted on every relay under either profile. `docs/relays.md` reports the probe of public relays these profiles come from (2026-10-27).

### 9.1 Baseline profile

The baseline profile has two roles, usually filled by different relays.

**Storage relays** are the relays in the queue's kind 10013 (NIP-37). Each must accept kinds 31234, 30078, 10013, `KIND_SUBMITTERS`, and `KIND_AGENT_GRANT` without requiring AUTH; honor NIP-09 deletion requests from an event's author; honor NIP-40 expiration at read time; and accept events up to 64 KiB. They also carry NIP-AB pairing messages (8.3). Anyone can read what they store. Devices publish to every storage relay, and setup suggests two.

**The inbox relay** is the relay in each agent grant's `inbox` (7.4) and the settings' `inbox_relays` (7.2). It must support NIP-42 and return kind 1059 events only to a connection authenticated as the event's `p`-tagged pubkey, as NIP-59 and NIP-17 recommend. Devices authenticate on it as the inbox key (6.4).

Devices check a relay before saving it in either role by probing it, not from its NIP-11 document alone: in the probe, one relay advertised AUTH that never succeeds, and the one free relay that restricts gift wrap reads does not list NIP-59. For an inbox relay the device publishes a gift wrap to a throwaway key of its own and confirms that an unauthenticated read and a read authenticated as another throwaway key return nothing, and a read authenticated as the recipient returns it. For a storage relay it publishes and reads back each kind and a 64 KiB event, and deletes them. A relay that fails is refused with the failing check named.

On the baseline profile no relay gates who writes a gift wrap, so ingestion (11.4) is the only spam filter, bounded by the inbox key, the per-sync cap, and optional proof of work. No relay learns which agent sent a wrap, and deletion is a request that other copies may outlive (13).

Recommended for development: storage on `wss://nos.lol` and `wss://relay.ditto.pub`, inbox on `wss://auth.nostr1.com`; for local work and CI, a strfry built from master, whose default configuration restricts kind 1059 reads to the recipient.

### 9.2 qus.me relay profile and the hosted relay

A relay meeting this profile can be both a queue's storage relay and its inbox relay. "AUTH pubkey" below is the pubkey a connection authenticated as under NIP-42; a connection may authenticate as several. The relay applies read rules to every event it would return, not only to the filter in a REQ, and silently omits events a rule does not allow.

1.  **Authentication.** NIP-42 AUTH is required before any REQ or EVENT. NIP-59 itself recommends relays require it before accepting gift wraps.
2.  **Queue reads.** Kinds 31234, 30078, 10013, `KIND_SUBMITTERS`, and `KIND_AGENT_GRANT` are readable by their author, with three exceptions:
    - kind 30078 with `d` = `qus.me/recovery` is readable by any authenticated connection, so a recovering device can authenticate with a throwaway key and fetch the backup (6.1);
    - `KIND_AGENT_GRANT` is also readable by the AUTH pubkey equal to its `d` tag, the agent it is addressed to (7.4);
    - `KIND_SUBMITTERS` is also readable by any AUTH pubkey listed in its `p` tags, so the service can confirm an approval as the agent key (8.2). An agent learns the pubkeys of the other agents on the list, not their labels.
3.  **Gift wraps.** A kind 1059 event must carry exactly one `p` tag. It is accepted only from a connection whose AUTH pubkey is in the current `KIND_SUBMITTERS` authored by the `p`-tagged pubkey, which for an inbox key is the copy devices publish under it (7.3), and readable only by the AUTH pubkey equal to that `p` tag.
4.  **Pairing messages.** A kind 24134 event (NIP-AB, 8.3) is accepted from a connection whose AUTH pubkey equals the event's pubkey, if it carries exactly one `p` tag and content within NIP-AB's size bounds. The relay never stores it, rate-limits it per connection, and should deliver it only to subscriptions on connections whose AUTH pubkey equals that `p` tag; NIP-AB's security does not depend on that restriction.
5.  **Other writes.** Any other event is accepted only when the AUTH pubkey equals the event's pubkey and the relay serves that pubkey (one queue, a configured list, or the queues bound to accounts on the hosted relay).
6.  **Expiration and deletion.** NIP-40 expiration is honored. The relay hard-deletes the author's own events, and gift wraps at the request of their `p`-tagged recipient, and refuses to store a deleted gift wrap id again.

The gift wrap write check authenticates the connection, not the event: a gift wrap is signed by an ephemeral key, so the relay checks the AUTH pubkey of the submitting connection against the list. This tells the relay operator which agent submitted each wrap, acceptable on a relay the user or qus.me runs and a reason this profile is not asked of third-party relays.

Over the baseline, this profile adds author-only reads, submitter-gated gift wrap writes, real deletion, and per-queue caps. On it, a queue may publish its recovery backup encrypted with the passphrase instead of a recovery code (6.1), since only authenticated connections can fetch it and the relay can rate-limit them; this is optional.

**Hosted relay.** qus.me runs a relay meeting this profile as a paid service gated by accounts ([#39](https://github.com/lokkju/qusme/issues/39), post-v1). The relay admits NIP-42 AUTH only from pubkeys bound to an active account; how a device binds a queue pubkey, and what happens when a subscription lapses, are settled in #39. Choosing the hosted relay at setup binds the queue pubkey before the first publish (11.3), and a rotation (6.1) binds the new key before the first publish under it. Retention:

- active drafts and NIP-78 data are kept indefinitely;
- archived drafts are deleted after the settings' `archive_retention_days` (default 90, 7.2). The relay cannot see a draft's status, since it is inside the encrypted rumor, so devices do this: on sync, a device blanks and requests deletion of each archived draft whose wrap `created_at` (the time it was last republished, which archiving does) is older than the setting;
- gift wraps are bounded by their NIP-40 expiration and deleted on ingestion;
- each queue pubkey has an event count and byte cap, set in the relay's configuration; writes over the cap are refused with a NIP-01 `OK` false message naming the cap.

### 9.3 Deployment

A self-hosted relay meeting 9.2: strfry or nostr-rs-relay with a write-policy plugin implementing it, bundled in the service's compose file. Workers: a Workers or Durable Objects relay implementation if one meets 9.2 (to be evaluated). The relay software for the hosted relay depends on that evaluation. The service itself runs on the homelab through the Node entrypoint for development, with Workers supported at the same hostname (8.5).

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

Locators match ARIA role and accessible name, keyed by `document.documentElement.lang`, with `en` as fallback. `constraints.counter` names a counting strategy implemented in the `nostr`/core packages (`default`: code points; `graphemes`: extended grapheme clusters per Unicode UAX #29, as `Intl.Segmenter` with `granularity: "grapheme"` counts them, for Bluesky's 300-grapheme limit; `twitter-text`: X's weighting). Strategies are a closed set in code; definitions only reference them, and a field naming an unknown strategy is unusable while the rest of the definition loads (7, "Unknown fields").

`twitter-text` is a port of twitter-text 3.1.0 with its config v3, which matches X's published counting rules: the text is NFC-normalized, every URL counts 23, code points in U+0000-U+10FF, U+2000-U+200D, U+2010-U+201F and U+2032-U+2037 count 1, every other code point 2, and each emoji sequence 2. The port keeps upstream's URL extraction and passes its conformance suite. It finds emoji with the engine's Unicode properties (any RGI emoji, ZWJ sequences missing their U+FE0F, bare keycaps) instead of upstream's twemoji-parser, whose Emoji 12 data counts newer sequences per code point.

Validation checks a value against its field's `maxLength` in the field's counter (code points when it names none) and against the 32 KiB cap (7.1), and reports each violation as field, constraint (`maxLength` or `maxBytes`), limit and actual value. `lenient` accepts a value that breaks only definition constraints; the cap still fails it. The rumor's `validation` tag records the result as JSON: `counter`, `length`, `max` when the field sets one, `ok`, and `lenient` and `violations` when present (`{"counter":"twitter-text","length":12,"max":280,"ok":true}`).

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

Either create a new queue (generate the queue key and the inbox key, choose a passphrase, show the recovery code and confirm it was saved, choose and probe storage relays and an inbox relay (9.1), publish 10013, settings, and the recovery backup), or pair with an existing device (section 8.3), or recover from backup (relay URL, npub, recovery code, then a passphrase). Choosing the hosted relay binds the queue pubkey to the user's account before the first publish (9.2).

### 11.4 Sync and ingestion

On popup open (and on an alarm while unlocked), the background connects to the storage relays and requests the user's 31234 drafts, the destinations and settings events, and the rotation marker (6.1). It connects to the inbox relays authenticated as the inbox key (and any retired inbox keys still draining, 6.4) and requests kind 1059 addressed to them.

Ingestion of submissions, in this order, so a wrap is discarded at the cheapest step that can reject it:

- Derive the draft's `d` tag deterministically from the gift wrap id, so two devices ingesting concurrently produce the same addressable event rather than duplicates: `d` is the lowercase hex SHA-256 of the UTF-8 string `qus.me/submission:` followed by the gift wrap id in lowercase hex. Drafts created on a device use other ids, which never take this 64-hex-character form. Skip any gift wrap whose derived `d` already exists.
- If any current grant sets `min_pow`, discard a wrap whose id has less NIP-13 difficulty than the lowest `min_pow` among the grants, before any ECDH. After unwrapping, check the wrap against its own agent's `min_pow`.
- Open at most 100 gift wraps per sync and leave the rest for the next one, so a flood delays ingestion instead of freezing the popup. A device that hits the cap on several consecutive syncs tells the user and offers inbox key rotation (6.4).
- Decrypt the gift wrap and read the seal's pubkey. Discard the wrap if that pubkey is not in the current submitters list, before verifying the seal's signature or decrypting the rumor. A full unwrap took 15.6 ms per wrap in Node 24 on a fast machine in the 2026-10-27 probe, and phones are several times slower, so this order matters on the baseline profile, where anyone who knows the inbox pubkey can send wraps.
- Verify the seal, decrypt the rumor, and check the rumor's pubkey equals the seal's and its content is within the 32 KiB cap (7.1).
- Create a pending destination if the submission names an unknown one.
- Query with a lookback of at least two days past the last sync, since NIP-59 randomizes gift wrap `created_at` into the past.
- After the draft wrap is published, request deletion of the ingested gift wrap with a NIP-09 request signed by the inbox key. NIP-17 permits a recipient to do this, and [nostr-protocol/nips#2350](https://github.com/nostr-protocol/nips/pull/2350) proposes adding it to NIP-09; the text of NIP-59 does not grant it. In the 2026-10-27 probe three of five relays ignored the request, so in practice the NIP-40 expiration bounds how long a wrap stays, and a device that fetches an ingested wrap again skips it by its derived `d`.
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

A full paired device: holds the queue key (NIP-49 at rest), syncs and ingests from the relays directly, and approves agents. Tapping a draft either opens the site's `compose` intent with the value (`pwa_intent`) or copies the value and opens the site or app (`pwa_copy`; Facebook personal profiles land here). Neither archives the draft on tap, since the PWA cannot observe whether the user posted and an intent can fail (logged out, app not installed). When the PWA becomes visible again after an open, it asks "Posted?" for that draft: Yes archives it as `archived:inserted` with an `inserted` tag recording the method; Not yet, or dismissing the prompt, leaves it active. No external signer is needed, so this works on iOS.

Firefox for Android users can also run the extension.

## 13. Security and privacy

Content is end-to-end encrypted on every relay: values, sites, accounts, fields, status, destinations, settings, and agent labels are inside NIP-44 payloads under either relay profile. What differs between the profiles is who sees the metadata.

**On ordinary relays (the baseline profile, 9.1), anyone who can query a storage relay sees:** the queue pubkey, and that it is a qus.me queue (the `qus.me/` `d` tags and the submitters and grant kinds, 7.2); event kinds, sizes, and timestamps, and so the queue's activity and volume: the number of draft wraps, the time of every edit, insertion, archive, and deletion, and each ingestion, since it updates the settings' `quota_counts`; the agent pubkeys, from the submitters list's `p` tags and the grants' `d` tags, with when each was added and removed; and the encrypted recovery backup. A single filter on `d` = `qus.me/recovery` returns the backup of every queue on a relay, and a copy can be attacked offline indefinitely, which is why the published copy is encrypted with a 128-bit recovery code (6.1). The inbox relay's operator sees the inbox pubkey and the count, sizes, and arrival times of gift wraps to it, but nothing on a storage relay links that pubkey to the queue (6.4). No relay learns which agent sent each wrap (7.5). The pairing messages of 8.3 are visible to any subscriber, which shows that a pairing took place.

**On a relay meeting the qus.me relay profile (9.2), such as the paid hosted relay,** only the relay's operator sees that metadata, and the operator also sees which agent submitted each gift wrap. Hiding the queue's metadata from everyone else is what the hosted relay offers.

**The service sees:** agent submissions in plaintext at write time (not retained); contentless receipts of them; which queue pubkeys it serves; agent grants for agents it holds keys for, and the agent pubkeys on those queues' submitters lists; on a typed-code pairing, the NIP-AB URI including its session secret (8.3). It cannot read the queue, sign as the user, or authorize a submitter. On a typed-code pairing it can defeat the SAS and receive the payload, which on that path is the recovery backup it could already fetch (8.3). A compromised service can submit drafts as any agent key it holds, until the user revokes those agents (8.2).

**Devices see:** everything; they hold the queue key. Every device holds the same key, so revoking one device means rotating the queue key (6.1).

**The extension sees** nothing on any site until the user acts in that tab, and then only that tab until navigation. It does not observe network traffic.

**Sites see** the inserted value, as if pasted. Nothing else from the queue.

**Agents** can submit to destinations in their grant (or propose new ones if the grant allows) and learn the inbox pubkey. On the qus.me relay profile they read only their own grant and the pubkeys on the submitters list that names them; on ordinary relays those events are public anyway. They cannot read, edit, or delete drafts. The human insertion step is the review gate.

**Spam** is blocked by the submitters list at the relay and again at ingestion on the qus.me relay profile. On the baseline profile ingestion is the only filter (11.4), and its cost is bounded by the inbox key, which a stranger cannot address without being given it (6.4), the per-sync cap, and optional proof of work.

**Deletion** is real on a relay meeting the qus.me relay profile and a request elsewhere; other relays and archivers may already hold a copy of anything published to an ordinary relay. Devices request deletion of each submission after ingesting it, as NIP-17 permits a recipient (11.4); most relays probed ignored that request, so NIP-40 expirations bound gift wraps in practice.

**Lost recovery code** with no remaining paired device loses the queue. A forgotten passphrase is recovered with the recovery code (6.1).

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

- Workers relay viability against the qus.me relay profile ([#11](https://github.com/lokkju/qusme/issues/11)); the hosted relay's software depends on it (9.3). With it, whether stock strfry can limit delivery of kind 24134 to the `p`-tagged AUTH pubkey (9.2, rule 4).
- The hosted relay's hostname. v0.2 proposed `relay.qus.me`; nothing has settled it.
- The relays the registry publisher key lists in its NIP-65 relay list, and so the ones builds bundle (10.3).
- The payload of a typed-code pairing. 8.3 sends the recovery backup (recovery code) on a session that issued a typed code, so that path is no weaker than recovery but needs the recovery code on the new device; a QR session sends the passphrase copy. The alternative is the passphrase copy on both paths, which keeps the typed path convenient and lets a compromised service guess the passphrase offline.
- How a qus.me-profile inbox relay knows which agents may write to an inbox key. 9.2 rule 3 has devices publish a copy of the submitters list signed by the inbox key to that relay only (7.3); settle with [#39](https://github.com/lokkju/qusme/issues/39).
- Whether the Draft Inbox NIP publishes inbox relays as NIP-17's kind 10050, and under which key; v0.4 keeps them in the grant and the encrypted settings.

### Decided

- 2026-10-27: the service runs at `app.qus.me` with MCP at `/mcp`. `mcp.qus.me` is not used by this service.
- 2026-10-27: pairing sessions live in D1 on Workers (and SQLite on Node) with an `expires_at` column, not KV (8.5).
- 2026-10-27: the hosted service bundles a relay, open only to queues bound to the hosted service, with retention as in 9.2 ([#27](https://github.com/lokkju/qusme/issues/27)). Superseded the same day by the relay profiles below: the hosted relay is paid and gated by accounts.
- 2026-10-27: agent grants default to not allowing new destinations; the approval screen offers the toggle (7.4, 11.8; [#28](https://github.com/lokkju/qusme/issues/28)).
- 2026-10-27: a PWA intent or copy open archives the draft only after a "Posted?" confirmation (12; [#29](https://github.com/lokkju/qusme/issues/29)).
- 2026-10-27: submission expiration is a per-grant setting, default 30 days, refused above 90 (7.4, 7.5; [#30](https://github.com/lokkju/qusme/issues/30)).
- 2026-10-27: kind numbers are picked from unused ranges before v1 and used in v1, with parsers accepting former numbers (2.2; [#31](https://github.com/lokkju/qusme/issues/31)). The numbers: `KIND_FIELD_VALUE` 1235, `KIND_SUBMITTERS` 11235, `KIND_AGENT_GRANT` 31235, `KIND_SITE_DEF` 31236 ([#2](https://github.com/lokkju/qusme/issues/2)).
- 2026-10-27: device pairing adopts NIP-AB; there is no separate Device Linking NIP (8.3; [#26](https://github.com/lokkju/qusme/issues/26)).
- 2026-10-27: the queue key's `ncryptsec` uses NIP-49 `log_n` 18. The recovery backup is readable by anyone who knows the relay URL and queue npub (6.1, 9.2), so the cost sets how fast an attacker can guess passphrases offline, against how long unlocking takes on a phone. One unlock measured 1.28 s at 18 on a Node 24 server (0.32 s at 16, 5.2 s at 20); phones are slower, and a device unlocks once per session (6.1; [#40](https://github.com/lokkju/qusme/issues/40)).
- 2026-10-27: v1 runs on ordinary relays under the baseline profile, with storage relays and an inbox relay (9.1). v0.3's relay rules become the optional qus.me relay profile, met by the paid, account-gated hosted relay (9.2; [#38](https://github.com/lokkju/qusme/issues/38), [#39](https://github.com/lokkju/qusme/issues/39)).
- 2026-10-27: the published recovery backup is encrypted with a device-generated 128-bit recovery code that the user stores; the passphrase protects only the local copy. Recovery needs the relay URL, npub, and recovery code, and rotation issues a new code. A passphrase-only backup is an option on the qus.me relay profile only (6.1, 9.2). Since the published copy no longer depends on the passphrase, the `log_n` 18 choice above now weighs only the local copy and the passphrase-only option.
- 2026-10-27: for development the service runs on the homelab through the Node entrypoint, behind the tunnel at `app.qus.me`; Workers remains a supported target at the same hostname (8.5, 9.3).
- 2026-10-27: gift wraps are addressed to a separate inbox key, rotatable without the queue key (6.4; `docs/relays.md`).
- 2026-10-27: a field value is at most 32 KiB of plaintext, so its draft wrap fits default strfry's 64 KiB event limit (7.1).
- 2026-10-27: the `qus.me/` `d`-tag prefix stays, as NIP-78's application identifier (7.2).
- 2026-10-27: pairing keeps the typed code; 8.3 states that a party relaying the URI can defeat the SAS, and qus.me raises the commit-then-reveal fix on the NIP-AB PR instead of changing the protocol locally (8.3; [#26](https://github.com/lokkju/qusme/issues/26)).
