# qus.me: Specification

*Draft v0.4, 2026-10-27. Supersedes v0.3.*
*Revised 2026-11-09: the service runs on Cloudflare Workers and the homelab deployment is retired (8.5, 9.3); pairing sessions no longer store an attempt count (8.5).*
*Revised 2026-11-11: the recovery code alone finds the backup, through a lookup tag derived from it; recovery asks the current and earlier default storage relays and any the user names, together (6.1, 9.1).*

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
- The service runs on the homelab through the Node entrypoint for development, at `app.qus.me`; Workers remains supported at the same hostname (8.5, 9.3). Superseded 2026-11-05: the service runs on Workers, and the homelab no longer runs it (section 17).

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
- A qus.me service deployable unchanged to Cloudflare Workers or to Node, providing MCP, agent key custody, pairing, and agent authorization.
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

**Recovery backup.** The device encrypts the queue key with NIP-49 at `log_n` 18, using as the password the 32-character lowercase hex of the recovery code's bytes, and publishes that `ncryptsec` to the storage relays as an addressable NIP-78 event (`d` = `qus.me/recovery`). Devices keep a copy of the published event, since a typed-code pairing sends it (8.3).

**Lookup tag.** The backup also carries the code's lookup tag as a NIP-32 label, `["L", "qus.me/recovery-lookup"]` and `["l", <tag>, "qus.me/recovery-lookup"]`, where the tag is the 64-character lowercase hex of HKDF-SHA256 over the code's 16 bytes, salt `qus.me/recovery-lookup`, info `v1`, 32 bytes out. Relays index `l`, so a device holding only the code finds its backup with `{"kinds":[30078],"#l":[<tag>]}` and needs no npub. The tag tells nobody without the code anything, and the code can't be worked back from it (HKDF is one-way and the code is 128 random bits); it is separate from the NIP-49 password, so it gives no head start on the backup's scrypt. It links a queue's backups to each other across republishes, which the queue pubkey already does. A backup published before 2026-11-11 has no tag, and the device cannot add one on unlock, since it does not keep the code: a device that recovers with the code republishes the backup with the tag (the `ncryptsec` unchanged), and an unlocked device whose copy of the backup has no tag offers to add it once the user types the code, which must open the backup.

**Recovery.** Recovery on a new device needs the recovery code; the queue npub is optional. With the npub the device asks for that key's backup and kind 10013; with the code alone it asks for backups carrying the code's tag, and for backups without a tag (those that predate it) it opens the newest per pubkey, at most eight, with the code until one opens, and never tries a backup tagged for a different code. It asks the storage relays the user named (pasted on the sheet or typed), the current default storage relays, and the earlier ones (9.1), all together, and succeeds when any of them holds a backup the code opens; once the backup opens it reads the 10013 for the full relay list. Errors say which case it was: the text is not a recovery code; no relay asked holds a backup, naming the relays asked and the ones that could not be reached; or a backup was found and the code does not open it. The device then asks for the passphrase and encrypts its local copy under it. Setup offers a recovery sheet holding the code in both forms, the npub, the storage relays and the inbox relay, never the queue key in any form; recovery accepts the sheet's text pasted whole. On an ordinary relay the backup is readable by anyone, and a single filter on its `d` tag returns the backup of every queue on that relay (13). A copy fetched once can be attacked offline indefinitely, which is why the published copy is encrypted with a 128-bit random code and not with a passphrase. On a relay meeting the qus.me relay profile the backup is served to any authenticated connection, so a recovering device can fetch it with a throwaway key (9.2).

A user who has lost the code but still has an unlocked device can issue a new one: the device generates a new code, shows it as at setup, and republishes the backup under it. Copies of the old backup that a relay or anyone else kept still open with the old code. A lost recovery code with no paired device remaining loses the queue, and a forgotten passphrase is recovered with the recovery code; the setup UI states both.

On the qus.me relay profile only, a user may choose to publish the backup encrypted with the passphrase instead of a recovery code, since that profile serves the backup only to authenticated connections and the relay can rate-limit them (optional, 9.2).

**Rotation.** If a device is lost or compromised, a remaining device rotates: generate a new queue key; re-wrap every draft and the destinations and settings under it, keeping each `d`; generate a new inbox key (6.4), since the lost device held the old one; publish a new submitters list, agent grants (same content apart from the new `inbox_pubkey`), 10013, settings, and a recovery backup under a new recovery code (shown to the user as at setup); rebind agent authorizations at the service; publish a rotation marker under the old key; delete the old key's other events (blanked wraps and NIP-09) once the service confirms the rebind; re-pair remaining devices. On the hosted relay the new key is bound to the user's account before the first publish under it, since the relay admits only bound keys (9.2). Each step is idempotent, so a rotation interrupted at any point finishes on the next run. Rotation is the only revocation for a device, since every device holds the same key.

The rebind is `POST /rotate`, NIP-98 signed by the old key, with a body holding an event signed by the new key that names the old pubkey. The service rebinds every binding from the old queue pubkey to the new one only when both signatures verify, so the new key named in a rebind is always one the requester controls. This does not cover an attacker who holds the old key and rotates first to a key of their own: the service then binds the user's agents to the attacker's queue, and the agents' later submissions go there. The user's remedy is to revoke those authorizations in the MCP clients and authorize the clients again under the user's new key.

The rotation marker is a NIP-78 event under the old key, `d` = `qus.me/rotated`, content NIP-44-encrypted to the old key, holding the new npub as `{ "npub": "<new npub>" }`. A device that unlocks and finds it tells the user the queue has rotated and offers pairing (8.3) with a device that holds the new key. A device never switches keys on the marker alone, since anyone holding the old key can publish one.

### 6.2 Agent keys

Minted by the service when a device fetches a pending OAuth authorization (section 8.2, step 3), and destroyed if the user denies it or it expires before approval. Stored by the service, encrypted at rest with a service secret. One agent key per MCP client authorization, so revocation is per client.

The service secret is 32 random bytes; each agent key is encrypted with AES-256-GCM under a key derived from it with HKDF-SHA256, bound to the secret's version, the agent pubkey and the key's row id, and is decrypted only for the duration of one operation. The secret rotates one version at a time: while the previous version's secret is still configured, the service re-encrypts every key under the new one, and a revoked key's ciphertext is discarded rather than re-encrypted.

### 6.3 External signers

A user who prefers to keep the queue key in a NIP-46 bunker or NIP-07 extension can do so; devices then call the signer for every signature and decryption. Opening the popup over N drafts costs N remote `nip44_decrypt` round trips with a bunker. Supported, documented as slower, not the default.

### 6.4 Inbox key

Gift wraps from agents `p`-tag the inbox key's pubkey, not the queue pubkey (7.5). The first device generates the inbox key with the queue key and keeps its secret in the settings event (7.2), so every device holds it. Each agent grant carries the inbox pubkey (7.4), encrypted to the agent, so nothing on a storage relay links the inbox to the queue: a stranger who learns the queue pubkey cannot address a gift wrap to it, and the storage relays do not show submission timing for the queue pubkey. On the inbox relay, devices authenticate as the inbox key (NIP-42 allows several AUTH pubkeys on one connection) to read and delete its gift wraps.

The inbox key rotates without the queue key. If an agent's grant leaks the inbox pubkey or the inbox is flooded, a device generates a new inbox key, writes it to the settings, and republishes every grant with the new `inbox_pubkey`. The old key moves to the settings' `retired_inbox_keys` with the time it was retired, and devices keep draining gift wraps addressed to it, under the same limits as current ones (11.4), until the longest `submission_expiration_days` among the grants at that time has passed, then drop it. The grants at retirement are not recorded, so devices use the current grants (30 days when there are none) and remove the key from the settings when they next republish them. A queue key rotation (6.1) also rotates the inbox key.

## 7. Events

Queue-key events go to the storage relays listed in the queue's kind 10013, every one of them; devices read from all of them and keep the latest version of each replaceable or addressable event. Gift wraps go to the inbox relay named in each agent grant (7.4).

**Unknown fields.** Devices on different builds share one queue, since extension-store and PWA updates arrive at different times. Data that devices read and republish (field value rumor tags, destinations, settings, the recovery backup, the rotation marker, agent grants as the queue reads them, submitters labels) is parsed strictly for the fields a build knows, and unknown tags and keys are kept and written back unchanged, after the known ones, when the device republishes. Agent submissions stay strict: draft state tags (`status`, `source`, `inserted`, `destination`) are refused and other unknown tags are dropped and logged. Site definitions and agent grants as the agent reads them ignore unknown keys, and a site field naming an injection strategy or counter the build does not know is unusable, not fatal to the definition; a locator whose `by` the build does not know is skipped (10.1).

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

`status` is `confirmed` or `pending` (created by an agent submission naming an unknown destination). A pending destination's `id` is the first 32 lowercase hex characters of the SHA-256 of the UTF-8 string `qus.me/destination:` followed by the JSON array `[site, account]` with the account normalized (10.1), so two devices ingesting at once create the same one and `@Handle` and `handle` name one pending destination; its `account` is the submitted one without a leading `@` or surrounding whitespace, and its `label` is `<site> / <account>`. `override` is a partial site definition merged over the official one (10.2). Settings use `d` = `qus.me/settings`, encrypted the same way:

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
    { "site": "x", "account": "lokkju", "fields": ["text"] },
    { "site": "mastodon", "account": "lokkju@mastodon.social", "fields": ["text"],
      "override": { "match": ["https://mastodon.social/*"] } }
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

Each destination may carry the destination's `override` from the settings (7.2), so the agent's effective definition (10.2) is the one devices use; a device includes it whenever the destination has one, and always for a site whose definition has an empty `match`.

`inbox` lists the inbox relays and `inbox_pubkey` the inbox key (6.4) the agent addresses its submissions to. `min_pow`, when present and above 0, is the NIP-13 difficulty the agent's gift wrap ids must have; devices check it before any decryption (11.4). The service mines it for each submission, up to a cap set per deployment (`QUSME_MAX_POW`, 5 bits by default), and refuses with `grant_unusable` to submit under a grant asking for more, naming both numbers. Each bit doubles the work, about 2^`min_pow` hashes on average, and every attempt hashes the whole serialized gift wrap, so the work also grows with the value's size. Measured under workerd, one attempt costs about 20 ns per byte of wrap: 37 µs for a short value's 1.6 KB wrap, 160 µs at 8 KB, 1.2 ms for the largest value's 60 KB wrap. A short value fits about 8 bits in the whole of the Workers Free plan's 10 ms of CPU per request (8.5) and 5 bits in about 1 ms, which is why the cap is 5; mining 20 bits would take seconds. Mining is bounded by work, not time (workerd's clock stands still while a request computes): it hashes at most 2^cap × 8 KiB of serialized wrap, 256 KiB at the default, and refuses with `pow_budget_exceeded` (`min_pow`, `max_pow`, `wrap_bytes`, `budget_bytes`, `hashes`) when it runs out, or before the first hash when the expected work alone exceeds that budget. A short value's wrap gets about five times its expected work, so roughly one draft in 150 runs out and succeeds on a retry; a value of a few KiB or more cannot carry 5 bits within the budget. A deployment with more CPU per request raises the cap, and the budget with it. Since that leaves proof of work a weak filter on the Free plan, devices leave it absent unless the user turns it on for an agent, typically after rotating a flooded inbox (6.4).

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

The endpoints, lifetimes, scope, and the rules for fetching client metadata and matching redirect URIs are in `docs/oauth.md`.

**Client registration.** MCP clients identify themselves with OAuth Client ID Metadata Documents: the `client_id` is an HTTPS URL serving the client's metadata, and the service advertises `client_id_metadata_document_supported` in its authorization server metadata. The MCP authorization specification (revision 2025-11-25) makes this the recommended approach for clients and servers with no prior relationship, and lists Dynamic Client Registration only as an optional fallback. It also fits this service: there is no open registration endpoint that anyone can fill with client rows, and the client name on the approval screen comes from a document at a URL the client's publisher controls, whose host the approval screen shows next to the name. Clients that support only Dynamic Client Registration cannot connect until the service adds it.

Revocation: the user removes the agent from the submitters list on any device, then tells the service to destroy the key, its binding and its tokens. Devices discard the agent's submissions at ingestion from then on, and a relay meeting the qus.me relay profile refuses them at once. The service refuses the agent's tool calls once it reads a submitters list that no longer names it (8.4), within its 30-second cache, even where a relay kept the grant after its deletion request. Telling the service is part of revoking, not an option: until it confirms, the agent's client still holds a working token, so the device keeps the revocation pending and retries it (11.8). On the baseline profile the agent still knows the inbox pubkey, so the user may also rotate the inbox key (6.4).

### 8.3 Device pairing flow

Pairing is NIP-AB ([nostr-protocol/nips#2328](https://github.com/nostr-protocol/nips/pull/2328)). The existing device is NIP-AB's source and the new device its target. Messages are NIP-AB's kind 24134 events between ephemeral keys, carried by the queue's storage relays.

1.  On an unlocked existing device, the user starts pairing. The device generates NIP-AB's ephemeral keypair and session secret and builds the `nostrpair://` URI, listing up to three of the queue's storage relays (its kind 10013) and never the inbox relay, which may refuse kind 24134. It shows the URI as a QR code.
2.  If the new device has no camera, the user asks the existing device for a typed code. The device posts the URI with its session's expiry to the service (`POST /pair`, NIP-98 signed by the queue key, body `{"uri", "expires_at"}`) and shows the short code the service returns beside the QR. The code is 8 Crockford base32 characters, single use, and expires with the NIP-AB session: at the `expires_at` the device sent, and never more than 120 seconds after the post. A queue key holds at most three live codes, NIP-AB's recommended limit on concurrent sessions. The device marks the session as typed-code before it posts, and only while waiting for an offer. A session that issued a code is a typed-code session from then on: the existing device sends the recovery backup, encrypted with the recovery code, and the new device asks for the recovery code (steps 5 and 7). A QR session, where no third party carries the URI, sends the passphrase-encrypted local copy, and the new device asks for the passphrase.
3.  The new device scans the QR or, without a camera, takes the typed code and fetches the URI from the service (`GET /pair/:code`, unauthenticated and rate-limited per client). The service reads the code as Crockford base32 (case, spaces and hyphens ignored; I and L read as 1, O as 0) and deletes the row on the first successful fetch, in the same statement, so a code is fetched at most once and a per-code attempt limit would add nothing. An unknown, used or expired code gets the same 404.
4.  Each device opens a relay connection for the pairing session alone. Where a relay asks for NIP-42 AUTH, each authenticates on it as its session ephemeral key, never as the queue key or the inbox key. The devices run NIP-AB from the offer through SAS verification. Both screens show the 6-digit SAS, and the user confirms on both. The new device knows both ephemeral keys once it sends the offer, so it shows the SAS at once; otherwise it would have nothing to compare until the existing device had already confirmed and sent the payload. Its user may confirm before or after the existing device's `sas-confirm` arrives.
5.  The existing device sends NIP-AB's `payload` message with `payload_type` `"nsec"`, which block/buzz's parser requires, and a `payload` that is always an `ncryptsec`, never an `nsec`. On a QR session it is the device's passphrase-encrypted local copy (6.1). On a typed-code session it is the published recovery backup, encrypted with the recovery code. The same decrypted message also carries `qusme_relays` (the queue's storage relays) and `qusme_npub` (the queue npub). NIP-AB requires implementations to ignore unknown fields, so these do not break a plain NIP-AB peer.
6.  The new device buffers a `payload` message that arrives early, including one that a relay delivers before `sas-confirm`, and reads it only once the transcript hash verifies and the user has confirmed the SAS on that device. A missing `payload_type` reads as `"nsec"`, as in the NIP-AB PR text; any other value is refused like a non-`ncryptsec` payload. If `payload` is not an `ncryptsec`, it discards it, sends `complete` with `success: false`, and tells the user. Otherwise it stores the `ncryptsec` and sends `complete` at once, before asking the user for anything, since NIP-AB's source waits only 30 seconds for it. `complete` always carries `success` explicitly, since block/buzz's parser requires it. If no `payload` arrives within 30 seconds of a verified `sas-confirm`, the new device aborts with `timeout`; once it holds the payload, the session clock no longer applies, and `complete` goes out even after the 120 seconds.
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

Accounts match the grant's after normalizing (10.1), and the submission names the grant's spelling of a granted destination. A draft for a destination not in the grant is accepted only if the grant's `allow_new_destinations` is true (7.4); the user's devices then create it as `pending`. For a destination in the grant, the field must be one of its `fields`. A value is validated against the field in the effective definition (10.2), the bundled definition with the grant's override for that destination merged over it; a destination with neither a bundled definition nor a whole definition in its override is checked against the 32 KiB cap alone, and a field the definition does not have is refused.

Every tool except `list_registry` reads the agent's grant from the queue's storage relays first, as the agent key (7.4), and refuses to act without a current one: none found, or `expires_at` passed. It reads the queue's current submitters list alongside, the same way and with the same choice of the newest list signed by the queue key as an approval (8.2 step 5), and refuses with `grant_revoked` when that list no longer names the agent, whatever grant a relay still serves: most relays ignore NIP-09 deletion, so a revoked agent's grant can outlive the revocation (13). When no storage relay returns a submitters list, the grant alone decides and the service logs that it went ahead without the list, naming the agent and queue pubkeys. A grant or list that was found is reused for up to 30 seconds; a missing one is read again on the next call. `grant_revoked`'s message tells the agent in plain words that the user revoked its access and that it must be authorized again before it can draft. A tool that refuses returns an MCP tool error whose structured content names the reason in `error` (`grant_revoked`, `grant_not_found`, `grant_expired`, `grant_unusable`, `destination_not_granted`, `field_not_granted`, `unknown_field`, `field_unusable`, `invalid_definition`, `constraint_violation` with the violations, `quota_exhausted` with the period, when it resets, `retry_after` in seconds and a `scope` of `grant`, `queue` or `service` (8.5, "Limits"), `rate_limited` with `retry_after`, `publish_failed` with each relay's answer, `pow_budget_exceeded` with the work asked and the budget (7.4)), and publishes nothing. The messages of `quota_exhausted` and `rate_limited` tell the agent in plain words that nothing was submitted and how many seconds to wait before retrying. A submission counts as published when at least one inbox relay answers `OK` true; only then is its receipt stored, so a failed publish uses none of the quota.

The service retains no submission plaintext after publishing. For each published submission it stores a receipt (8.5) holding the agent key id, the queue pubkey, the gift wrap id, and the time; `list_submissions` returns these, and the service counts them against the grant's quota for the current period (7.4) before publishing.

### 8.5 Portability

The service is a `createApp(deps)` Hono factory using only Web-standard APIs, with thin Workers and Node entrypoints, as in v0.1. It runs on Cloudflare Workers: one Worker, `qusme`, serves the service at `app.qus.me` and the static landing site and privacy policy at `qus.me` (`site/`), routing by Host so the service answers only on `app.qus.me` and the site never does. Its state is the D1 database `qusme`. lokkju/infra's Pulumi stack owns the script, its custom domains, the database, the Worker secret and the deploy token; this repo's deploy workflow applies pending migrations and deploys the code on every push to `main`. The Node entrypoint, with a SQLite file in place of D1, is for local development and the SQLite tests, and nothing deploys it. On the Workers Free plan a request gets 10 ms of CPU, which is what bounds the proof of work `create_draft` can mine for a grant's `min_pow` (7.4): `QUSME_MAX_POW` caps it at 5 bits. The service's own state is small:

- OAuth clients (cached Client ID Metadata Documents), authorization codes and tokens (hashed, with expiry);
- pending authorizations (8.2: short code, client id, PKCE challenge, scopes, minted agent key id, a keyed hash of the client IP for the per-IP cap, `expires_at`);
- agent keys (encrypted, with a key version so the service secret can rotate);
- bindings of agent keys to queue pubkeys and the queues' storage relays;
- submission receipts (agent key id, queue pubkey, gift wrap id, created at; no content), for `list_submissions` and quota (8.4);
- pairing sessions (8.3: code, `nostrpair://` URI, queue pubkey, `expires_at`);
- recently seen NIP-98 event ids, for replay protection;
- queues registered for the hosted relay (9.2);
- usage counters for service-wide caps (the daily `create_draft` ceiling), one row per day.

Tokens don't store a queue pubkey. A token is bound to its agent key, and the queue comes from that key's binding, so a rotation rebind (6.1) is one update to the binding and every token follows it. A submission receipt carries its own `expires_at`, set no earlier than both the gift wrap's NIP-40 expiration and the end of the quota period it counts toward, so `list_submissions` shows a submission for as long as the wrap can exist and the quota count (7.4) never loses a receipt early.

Requests that devices sign with NIP-98 are checked against the configured public origin (`https://app.qus.me`) plus the request's path and query, never against the `Host` or forwarded headers, which a proxy in front of the service can rewrite. The service holds each accepted event id until the event's 60-second window has passed and refuses it again until then.

SQLite on both targets (D1 on Workers, a SQLite file on Node). Rows with a TTL carry an `expires_at` column, every read filters on it, and a sweep deletes expired rows. Nothing lives in KV: KV's free-tier write limit is account-wide and small, and every pairing step is a write. Nostr publishing uses outbound websockets, available on both runtimes.

```text
packages/
  core/          Hono app, MCP tools, OAuth, pairing, validation
  nostr/         Event builders and parsers for the kinds in section 7; NIP-44/49/59 helpers
  store-sql/     Drizzle schema for service state; D1 and SQLite drivers
  entry-worker/  Workers entrypoint
  entry-node/    Node entrypoint
  extension/     WXT project
  pwa/           Mobile client
registry/        Site definitions (separate repo, separate license)
```

The `nostr` package is shared by the service, extension, and PWA, so every client builds and parses events identically.

**Limits.** Cloudflare's edge rate-limits `/authorize*`, `/token`, `/revoke` and `/pair/*` per IP (lokkju/infra), but that alone still lets one address reach the Worker hundreds of thousands of times a day, so the service enforces its own limits, of two kinds.

Rate limits slow abuse. They are fixed windows counted through an injectable limiter: the Workers Rate Limiting binding on Workers, which counts per Cloudflare location and is eventually consistent, and an in-memory counter on Node. The unauthenticated routes are limited per client IP (`CF-Connecting-IP`): `GET /authorize` 10 a minute, the waiting page and its status poll 60 a minute, `/token` and `/revoke` together 20 a minute, and the typed-code lookup `GET /pair/:code` 10 a minute. `/mcp` is limited per agent key (30 a minute) and per queue (60 a minute), and the NIP-98 device routes and `POST /pair` per queue key (30 a minute). An HTTP route over its limit answers 429 with `Retry-After`; the binding does not report when its window ends, so on Workers `Retry-After` is the whole window. On `/mcp` a tool call over the limit gets the tool error `rate_limited` with `retry_after`, and any other request (initialize, `tools/list`) gets 429. A class whose binding is missing or unusable (no `limit` function, or an answer without a boolean `success`), as on an account or deploy without Workers Rate Limiting, is counted in memory for the life of the isolate instead, and the Worker logs `ratelimit_binding_unavailable name=<binding>` once per binding per isolate; the service keeps serving. A binding call that throws lets the request through. Neither weakens the hard caps below, which stay fail-closed and bound cost on their own.

Hard caps bound cost and fail closed: they are counted in D1 or SQLite, and an error while counting refuses the request. At most 5 undecided pending authorizations may be open from one client IP and 500 across the service, answered with 429 and `Retry-After` until the first of them expires; the service stores an HMAC of the IP under a key derived from the service secret, never the address. A queue may have at most 10 agents (unrevoked bindings): a device fetching an eleventh request, or approving one fetched before the queue filled, gets 409 `agent_limit_reached` and no key is minted. A queue may hold 3 live pairing codes (8.3). `create_draft` is capped per queue at 100 a UTC day, counted from receipts across all the queue's agents, on top of each grant's own quota (7.4), and the whole service accepts at most a configured number of drafts a UTC day (`QUSME_DAILY_DRAFT_CEILING`, 2000 by default; 0 refuses every draft), reserved in one conditional statement before publishing and given back if no relay accepts the wrap. A failed reservation is `quota_exhausted` with `scope` `service`.

Every request is size-capped before any handler reads it: the URL at 8 KiB (414), the body at 256 KiB on `/mcp` (a 32 KiB value, JSON-escaped, in its envelope), 8 KiB on `/token` and `/revoke`, and 4 KiB everywhere else (413). JSON is parsed only after that check.

The per-queue limits come from the queue's tier, a table in code (`packages/core/src/limits.ts`) looked up by queue pubkey. There is one tier, `free`, and every queue is in it; when accounts arrive ([#39](https://github.com/lokkju/qusme/issues/39)), the lookup can name a higher tier for a queue without a code change to the routes. A tier whose rates differ needs its own rate classes and bindings. An unknown tier name falls back to `free`.

## 9. Relays

A queue runs on ordinary Nostr relays meeting the baseline profile (9.1). The qus.me relay profile (9.2) is optional: it adds enforcement that hides the queue's metadata, and it is what the paid hosted relay offers. Content is end-to-end encrypted on every relay under either profile. `docs/relays.md` reports the probe of public relays these profiles come from (2026-10-27).

### 9.1 Baseline profile

The baseline profile has two roles, usually filled by different relays.

**Default storage relays.** Setup suggests relay.primal.net and relay.ditto.pub; until 2026-11-09 it suggested nos.lol and relay.ditto.pub. Recovery (6.1) asks both lists, since a queue made on the earlier defaults may now be on relay.ditto.pub alone.

**Storage relays** are the relays in the queue's kind 10013 (NIP-37). Each must accept kinds 31234, 30078, 10013, `KIND_SUBMITTERS`, and `KIND_AGENT_GRANT` without requiring AUTH; honor NIP-09 deletion requests from an event's author; honor NIP-40 expiration at read time; and accept events up to 64 KiB. They also carry NIP-AB pairing messages (8.3). Anyone can read what they store. Devices publish to every storage relay, and setup suggests two.

**The inbox relay** is the relay in each agent grant's `inbox` (7.4) and the settings' `inbox_relays` (7.2). It must support NIP-42 and return kind 1059 events only to a connection authenticated as the event's `p`-tagged pubkey, as NIP-59 and NIP-17 recommend. Devices authenticate on it as the inbox key (6.4).

Devices check a relay before saving it in either role by probing it, not from its NIP-11 document alone: in the probe, one relay advertised AUTH that never succeeds, and the one free relay that restricts gift wrap reads does not list NIP-59. For an inbox relay the device publishes a gift wrap to a throwaway key of its own and confirms that an unauthenticated read and a read authenticated as another throwaway key return nothing, and a read authenticated as the recipient returns it. For a storage relay it publishes and reads back each kind and a 64 KiB event, and deletes them. A relay that fails is refused with the failing check named.

**A storage relay that accepts nothing.** A relay can answer REQs and still keep nothing: nos.lol answered EVENTs with no OK, NOTICE or CLOSED (`docs/relays.md`, 2026-11-09). Each device records, per storage relay and per sync, whether any EVENT it sent there got `OK` true; a sync where the relay answered the REQ but every EVENT went unanswered within the timeout or was refused is one failure, and one `OK` true clears the count. A relay that cannot be reached, or whose connection drops, is offline for that sync and counts neither way. A sync that has written nothing to a relay for an hour re-sends the queue's current 10013 to it, so an idle queue still finds out. Three failures in a row, the first and the latest at least an hour apart, while another storage relay accepted a write after the first, mark the relay as accepting nothing; the popup names it, says what was seen, and offers to replace it with a default storage relay the queue does not use or one the user types. The replacement must pass the storage probe above. With the queue unlocked, the device then reads the queue's events from every remaining storage relay (all must answer) and from the dead relay where it answers: the newest version of each live draft wrap, the 30078 recovery backup, destinations and settings, the submitters list and every agent grant, with its own copies of the backup and settings (11.3) where no relay has them. It publishes each, as signed, to the replacement, then a new 10013 with the replacement in the dead relay's place to the replacement and every remaining relay, and to the dead relay best effort; it changes its own relay list only after the replacement accepted every event and every remaining relay the new 10013, so a replacement that fails at any step leaves the queue as it was. Other devices adopt the newest 10013 they read on sync (11.4). The recovery sheet names the storage relays, so the device then offers a new one: the device does not keep the recovery code (6.1), so the user types it, the device checks that it opens the recovery backup, and the sheet carries the same code with the new relays. An old sheet still works while one of its relays stays in the list. The service keeps the storage relays an approval named (8.2, 8.5) and reads grants from them until the next approval names the new list, which works as long as one of them remains a storage relay.

On the baseline profile no relay gates who writes a gift wrap, so ingestion (11.4) is the only spam filter, bounded by the inbox key, the per-sync cap, and optional proof of work. No relay learns which agent sent a wrap, and deletion is a request that other copies may outlive (13).

Recommended for development: storage on `wss://relay.primal.net` and `wss://relay.ditto.pub`, inbox on `wss://auth.nostr1.com`; for local work and CI, a strfry built from master, whose default configuration restricts kind 1059 reads to the recipient.

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

A self-hosted relay meeting 9.2: strfry or nostr-rs-relay with a write-policy plugin implementing it. Workers: a Workers or Durable Objects relay implementation if one meets 9.2 (to be evaluated). The relay software for the hosted relay depends on that evaluation. The service itself runs on Cloudflare Workers (8.5).

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
    "extract": "@([A-Za-z0-9_]{1,15})",
    "caseSensitive": false
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

Locators match ARIA role and accessible name, keyed by `document.documentElement.lang`, with `en` as fallback: the names for the exact language tag, else for its primary subtag (`de` for `de-AT`), else `en`, tags compared without regard to case. A name matches when it equals the element's accessible name with whitespace collapsed; matching is exact, so a composer whose name embeds the user's name needs its own rule, decided with the definitions that need it.

A locator with `"by": "placeholder"` compares its names with placeholder text instead, for editors that have a role but no accessible name: the element's own `placeholder`, `aria-placeholder` and `data-placeholder`, then the `data-placeholder` of up to 16 descendants, which is where TipTap and ProseMirror put the prompt (Bluesky: `{ "role": "textbox", "name": { "en": ["What's up?"] }, "by": "placeholder" }`). Only elements with the locator's role are candidates and only their own subtree is read, so placeholder text elsewhere on the page never matches. `by` is a closed set (`name`, the default, and `placeholder`); a locator naming another is skipped, and an account whose locator is skipped is treated as absent.

Locators search the light DOM first. When it has no match, the extension searches open shadow roots too (LinkedIn's share box sometimes renders inside `#interop-outlet`'s): breadth first, at most 4 levels of nesting and 64 roots, and walking at most 20,000 elements to find their hosts, so a large page costs a bounded walk. Closed shadow roots are out of reach. The focused-element lookup (10.2) already follows open shadow roots.

The account `extract` expression is applied to the account element's text, then its accessible name, `title` and `href`, and the first capture group of the first match is the detected account. When the site shows less than the account destinations name, `extract` is an object, `{ "pattern": "@([A-Za-z0-9_]+)", "template": "{1}@{host}" }`: `pattern` is the expression, and the first match builds the account from `template`, where `{1}` to `{9}` are capture groups and `{host}` is the page's host name, lowercased. A template must use at least one capture group, and any other `{...}` makes the definition invalid. A group that took no part in the match gives no account. Mastodon's web client shows `@user` and its destinations are `user@instance`, so its definition uses `{1}@{host}`; an instance whose accounts live on another domain than its web host (`LOCAL_DOMAIN` differs from `WEB_DOMAIN`) overrides the template with that domain, `{ "account": { "extract": { "template": "{1}@example.com" } } }`.

`account` and `intents` are optional. Without `account` the extension can't tell which account a page is signed in as: it lists every destination's drafts for the site, labelled with their accounts, and asks the user to type the account when adding a destination. Without an `intents.compose` template, the PWA's tap opens the site after copying the value (12). LinkedIn's definition has neither, since nothing on the page names the member without opening a menu and LinkedIn documents no URL that prefills post text.

**Accounts.** Devices, ingestion and the service compare accounts, and key anything by them, after normalizing: surrounding whitespace and one leading `@` are removed, and the result is case-folded unless the effective definition (10.2) sets `account.caseSensitive` to true. `caseSensitive` is optional and defaults to false, which fits every site in the registry; a site with no definition compares case-insensitively. So `@Handle`, `handle` and ` handle ` name one destination. Devices store an account as the user or agent wrote it, without the `@` and whitespace, and show it that way; normalization happens on every comparison, so destinations and grants written before it still match.

`constraints.counter` names a counting strategy implemented in the `nostr`/core packages (`default`: code points; `graphemes`: extended grapheme clusters per Unicode UAX #29, as `Intl.Segmenter` with `granularity: "grapheme"` counts them, for Bluesky's 300-grapheme limit; `twitter-text`: X's weighting; `mastodon`: Mastodon's). Strategies are a closed set in code; definitions only reference them, and a field naming an unknown strategy is unusable while the rest of the definition loads (7, "Unknown fields").

`twitter-text` is a port of twitter-text 3.1.0 with its config v3, which matches X's published counting rules: the text is NFC-normalized, every URL counts 23, code points in U+0000-U+10FF, U+2000-U+200D, U+2010-U+201F and U+2032-U+2037 count 1, every other code point 2, and each emoji sequence 2. The port keeps upstream's URL extraction and passes its conformance suite. It finds emoji with the engine's Unicode properties (any RGI emoji, ZWJ sequences missing their U+FE0F, bare keycaps) instead of upstream's twemoji-parser, whose Emoji 12 data counts newer sequences per code point.

`mastodon` follows Mastodon's `StatusLengthValidator` (v4.7.5): every URL that starts with `http://` or `https://`, as twitter-text's extractor finds it, counts 23; every mention `@user@domain`, by `Account::MENTION_RE` and not followed by `@`, a Latin accented letter or `://`, counts as `@user`; where a URL and a mention overlap, the one that starts first wins; and the result is counted in grapheme clusters as `graphemes` counts them. A content warning, which the server adds to the count, is not a field and is not counted.

**Compatibility.** Builds older than these additions read a definition as follows, and the registry chooses the form of each change by it. A locator's `by` is an unknown key, ignored, so an older build compares the placeholder names with the accessible name: on a TipTap editor that has none it finds nothing and falls back to the focused element, and on an `<input>` or `<textarea>`, whose accessible name falls back to its placeholder, it finds the same element. The shadow-root search is extension behavior, not format. An unknown counter makes its field unusable (7, "Unknown fields"). The object form of `extract` is the one change an older build must not half-read, since it would detect `user` and hide the drafts for `user@instance` as another account's; an older parser requires a string and rejects the whole definition, and a device keeps the newest version it accepted (10.3). So a definition that uses a template is invisible to older builds, which keep the previous signed version.

Validation checks a value against its field's `maxLength` in the field's counter (code points when it names none) and against the 32 KiB cap (7.1), and reports each violation as field, constraint (`maxLength` or `maxBytes`), limit and actual value. `lenient` accepts a value that breaks only definition constraints; the cap still fails it. The rumor's `validation` tag records the result as JSON: `counter`, `length`, `max` when the field sets one, `ok`, and `lenient` and `violations` when present (`{"counter":"twitter-text","length":12,"max":280,"ok":true}`).

A definition may leave `match` empty (`[]`) when the site has no fixed hosts. Every destination for such a site must supply `match` in its override, and devices refuse to save the destination without it. Mastodon is the case: one `mastodon` definition with `match: []` and a 500-character `maxLength`, and a destination per account whose override names that account's instance (`{ "match": ["https://mastodon.social/*"] }`), with `account` in `user@instance` form. Intent templates may use `{origin}`, replaced with the origin of the effective definition's first `match` pattern (`"compose": "{origin}/share?text={text}"`). An instance with a different post limit overrides `constraints` as well.

### 10.2 Resolution

Effective definition = official definition with the destination's `override` merged over it. Custom destinations have only the override, which may be as little as `{ "match": [...] }`.

Merge rules: objects merge key by key, recursively; a scalar in the override replaces the official value; `null` in the override removes the key. Arrays replace the official array whole, including `match`, `locators`, and `inject`, so an override that adds a locator lists the official ones it keeps. `fields` is the one exception: its entries merge by `name`, an override entry with an existing `name` merging over that field by these same rules and an entry with a new `name` being appended. At insertion time the extension targets the page's focused editable element first, then the field's locators, then asks the user to click into the target field (focus placement), which works on any site.

### 10.3 Distribution and licensing

Published as signed `KIND_SITE_DEF` events under a registry publisher key, and as JSON in its own repository under CC0 (proposed). Clients verify the publisher signature. Builds bundle a snapshot, the registry publisher pubkey, and a snapshot of that key's NIP-65 relay list (kind 10002). Devices refresh by fetching the publisher's current kind 10002 from the bundled relays, then `KIND_SITE_DEF` events from its write relays; a definition replaces the bundled one only if its signature verifies against the pinned pubkey and its `version` is newer. If no relay answers, devices keep the bundled snapshot.

The registry is lokkju/qusme-registry. Its `pnpm snapshot` writes a `qusme-registry-snapshot/1` file (`format`, `publisher`, `relayList`: the signed kind 10002, `siteDefinitions`: one signed `KIND_SITE_DEF` per site), and this repository commits it as `registry/snapshot.json`, refreshed with `pnpm registry:update`, which verifies it against the pinned key and refuses a downgrade. The pinned key is `REGISTRY_PUBLISHER` in `@qusme/nostr` (`144986da…f54c`, created 2026-11-05). A build may bundle a snapshot without `relayList`; devices then read the relay list from the fallback relays, `wss://relay.primal.net` and `wss://relay.ditto.pub`, which are also the publisher's own. The service and the extension verify every bundled event at startup and drop, with a log line on the service, any that fails. The extension refreshes on sync at most every six hours, keeps the newest version per site across the bundle, its cache and the relays, never accepts an equal or older version, and caches the verified events in `storage.local`, since they are public.

## 11. Browser extension

### 11.1 Framework and targets

WXT, Chrome MV3 and Firefox MV3, one codebase, `browser` namespace throughout. Safari is out of scope for v1.

### 11.2 Permissions

Required: `activeTab`, `scripting`, `contextMenus`, `storage`, `alarms`. `alarms` runs sync while the queue is unlocked (11.4); a service worker's timers do not survive it being stopped, and the permission shows the user no warning.

Optional: host permission for the qus.me service origin, requested when the user uses a typed pairing code (8.3), looks up an approval code, approves an agent and revokes one (11.8). An approval without it publishes nothing, since revoking that agent later needs it too. Relay websockets need no host permission.

No host permissions for any site the user posts to, and no `tabs` permission. Page access exists only after a user gesture (the toolbar button, the context menu item, or the picker shortcut, a `commands` entry), only for the current tab, and only until navigation. The manifest declares no `content_scripts`, `web_accessible_resources` or `externally_connectable`.

### 11.3 Setup

Either create a new queue (generate the queue key and the inbox key, choose a passphrase, choose and probe storage relays and an inbox relay (9.1), show the recovery code with the npub and the storage relays and offer the recovery sheet (6.1), confirm the code was saved, publish 10013, settings, and the recovery backup), or pair with an existing device (section 8.3), or recover from backup (the recovery code alone, the npub and code, or the pasted recovery sheet, with another relay URL only when no relay asked has the queue, then a passphrase; 6.1). The relays come before the code so the sheet names the relays the queue is created on. The passphrase field states the rule the strength check applies, shows its feedback as the user types, and offers a suggestion of five random words from the BIP-39 English list. Choosing the hosted relay binds the queue pubkey to the user's account before the first publish (9.2).

The extension keeps the queue key's `ncryptsec` and a copy of the settings event in `storage.local`; the inbox key is read from that copy with the queue key at unlock, so at rest it sits behind the passphrase too. The unlocked keys go to `storage.session`, and to `storage.local` only while "stay unlocked" is on; locking deletes both. Create publishes only once every storage relay has passed its probe, and stores the key only once every storage relay has accepted the 10013, the settings and the recovery backup. The setup UI probes the suggested relays as the relay step opens and shows the result as one line naming them by host, with the addresses editable under "Use other servers"; a relay that fails is named with the check it failed. The setup UI confirms the recovery code by asking for three of its twelve words, at positions drawn at random when the code is generated, or for the whole code in either form, and for the user's statement that they saved the code and the sheet (design pass, 2026-11-11; before it, the whole code was typed back).

The confirmation shows that the user has the code at hand when they create the queue; it is not a check of their copy. Three words at random positions fail for a user who saved nothing (a guess passes about once in 8.6 billion, 2048³) or saved another code, and take seconds where twelve took a minute. They do not catch a slip in one of the other nine words. That shows only at recovery, where the BIP-39 checksum refuses most such slips (15 in 16) without saying which word, and a slip the checksum lets through is a different code that opens nothing. The downloaded sheet is a machine copy with no slips, which is why the sheet step offers it first, and the whole-code form stays for a user who wrote the code by hand and wants it checked in full. The positions say which words to type, not what they are, and the device keeps neither after setup.

Create ends on a first-run checklist, which the unlocked home screen keeps as its list's empty state (and under the list once drafts exist) until every item is ticked or the user hides it: the queue itself, always ticked, naming its storage relays by host; connect an MCP client, with `https://app.qus.me/mcp` and a copy button; add a destination; pair a second device, marked optional. Each item is ticked from the queue's state, and none names a particular MCP client or site. A desktop browser has no camera to scan the QR, so the new-device side takes the `nostrpair://` link pasted as text (copied from the QR screen) as a QR session, or a typed code (8.3).

### 11.4 Sync and ingestion

On popup open (and on an alarm while unlocked), the background connects to the storage relays and requests the user's 31234 drafts, the destinations and settings events, the rotation marker (6.1) and the 10013; when the newest 10013 names different storage relays than the device holds, the device switches to them from the next sync, and it records whether each storage relay accepted its writes (9.1). It connects to the inbox relays authenticated as the inbox key (and any retired inbox keys still draining, 6.4) and requests kind 1059 addressed to them.

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

Further rules devices follow at ingestion:

- After unwrapping, the grant's other rules apply as the service applies them (8.4), as a backstop: a submitter with no readable grant, a rumor `created_at` at or after the grant's `expires_at`, a destination not in the grant when `allow_new_destinations` is false, or a field the grant does not list for its destination is discarded. A rumor `created_at` more than 10 minutes in the future is discarded, so it cannot advance the quota period.
- A rumor whose quota period starts before the recorded `period_start` counts in the recorded period, so a backdated rumor cannot escape the quota. A wrap id already in `accepted` or `discarded` keeps that decision.
- The query window moves (the "last sync" of the lookback) only after a sync that read every inbox relay, left nothing over the cap and published every draft; otherwise the next sync repeats the same window, so deferred wraps are not lost.
- A draft wrap counts as published once every reachable storage relay accepted it; only then is its gift wrap deleted. Wraps already ingested and discarded junk are deleted too, except a listed submitter's wrap discarded for want of a grant, which may arrive mid-approval and is retried on the next sync. A device also remembers the ids of wraps it handled, ids only, so junk is not reopened while it stays in the lookback.
- Decrypted drafts are kept only in `storage.session` (extension) or memory (PWA), and lock deletes them with the keys. Junk is counted by reason and never shown.

### 11.5 Arming and inserting

1.  The user opens the popup; `activeTab` grants access to the current tab.
2.  The popup reads the tab URL and injects a read-only script resolving the site's account locator.
3.  Decrypted drafts are filtered locally by destination match and detected account. If detection fails, drafts for every account at that site are shown, labeled. The popup shows one list of active drafts grouped "For this page" (these) and "Elsewhere" (every other active draft). Each row shows who wrote the draft, how long ago, its destination when the page doesn't already say, its length against the field's `maxLength` counted with the field's counter, and the text clamped at three lines; the keyboard picker shows the same row. A row expands to the draft's full text and its other actions.
4.  The user inserts with a row's Insert button, which inserts that draft in one click without arming it (the popup's click granted `activeTab`; it targets the page's still-focused element), so a failure leaves nothing armed. Rows for this page show Insert; an "Elsewhere" row offers "Insert here anyway" only once expanded. Or the user arms a draft with "Set for right-click" on an expanded row; it becomes the armed draft (one at a time, in `storage.session`) and the background rebuilds the context menu title ("Insert: first 40 characters…").
5.  The context menu item on `editable` contexts, restricted by `documentUrlPatterns` to the user's destinations, inserts the armed draft. Either way the gesture grants `activeTab`; the insertion script resolves the target (10.2) and runs the field's injection chain.
6.  On success the device appends an `inserted` tag, sets `status` to `archived:inserted`, republishes the wrap, and disarms if that draft was the armed one.

If nothing is armed, the context menu item opens the popup.

The keyboard picker is the third way in (operator decision 2026-11-06). A `commands` shortcut, suggested as Alt+Q and rebindable at chrome://extensions/shortcuts or in Firefox's about:addons, grants `activeTab` like the other two. The background runs the step 2 detection, builds the same list as step 3, and injects the insertion script, which opens a small picker anchored at the caret or the focused editable field (or the field the last picker opened at, when the focus is no longer on one; else at the top of the viewport). Drafts for this page come first; every other active draft follows under an "Other sites" heading, listed at once when nothing matches the page and otherwise opened and closed with Tab or a click on the heading, which says so, as does the key line at the foot. Typing filters, the arrow keys choose, Enter or a click inserts, a digit 1 to 9 inserts that row while the filter is empty (the rows show their digits only then, and a digit typed after other text filters as usual), and Escape closes. The head names the detected account, not the site, which the page already shows. Choosing a draft runs it through steps 5 and 6 without arming it, so a failure leaves any armed draft as it was. After an insertion the page shows a short notice that the draft went in, never its text. When the insertion was recorded (step 6 archived the draft), the notice offers Undo for a few seconds: the background's answer to the pick carries a one-time token, kept in `storage.session` with its tab and draft and good for a minute, and Undo sends it back to restore that draft to `active`, as the popup's Undo does. The picker says when the queue is locked or nothing matches the page, and offers to open the popup. It lives in a closed shadow root on a host element with no qus.me id, class or attribute, its styles are entirely inside that root, keystrokes typed into it stop at the root, and only trusted events act on it. Insert, Escape, the focus leaving it, the window losing focus, or navigation removes the host and every listener it added. Each picker carries a fresh token kept in `storage.session` with its tab, so only the latest picker in that tab can insert, and only a draft it listed.

The `inserted` tag's method is `extension_popup`, `extension_context_menu` or `extension_shortcut`. Detected accounts compare with drafts' accounts after normalizing (10.1). A destination with no usable definition (no official definition and an override that is not a whole one) has no field: insertion targets the focused field, then asks the user to click into one, and runs `insertText`, `paste`, `clipboard` on a contenteditable or `insertText`, `native`, `clipboard` on an `<input>` or `<textarea>` (11.6). The popup can also insert or arm a draft whose destination does not match the page, from its "Elsewhere" group; the context menu still appears only on the user's destinations. When the insertion succeeds but the wrap cannot be republished (locked, no relay answered, a relay refused), the device disarms anyway, keeps the `inserted` tag in `storage.session` and retries on request; lock discards it.

Draft selection happens in extension origin (the popup) or in the extension's isolated world (the picker, which renders the list in its closed shadow root, out of reach of the page's scripts); the full value of no draft other than the inserted one enters the page. Draft text is rendered with `textContent`, never as HTML, since agent-supplied content is untrusted.

Each row of the popup's list can also be edited or dismissed from its expanded state, and an Archive view lists inserted and dismissed drafts, newest first, each with Restore. All three republish the wrap with the same `d` (7.1), rebuilt from the newest version on the storage relays, and, like the destination changes of 11.8, need every storage relay to answer the read and accept the new wrap. An edit refuses empty text and text over the 32 KiB cap, keeps the status and every other tag, and recomputes the `validation` tag against the draft's field when the effective definition has one, or drops it. Dismissing sets `archived:dismissed` and disarms the draft if it was armed; restoring sets `active` and keeps the `inserted` tags. After a dismissal, or an insertion that was recorded, the status line offers Undo, which restores that draft, until the popup closes.

The toolbar badge shows the number of active drafts, updated after every sync, insertion and dismissal, in a distinct colour when something needs the user (a pending destination, a revocation qus.me has not confirmed, an insertion not yet recorded), and is cleared while the queue is locked (operator decision 2026-11-06).

### 11.6 Injection strategies

| Strategy     | Mechanism                                                                          | Notes                                                  |
|--------------|------------------------------------------------------------------------------------|--------------------------------------------------------|
| `paste`      | Focus; dispatch a `paste` ClipboardEvent with a DataTransfer carrying `text/plain` | Rich editors that ignore `insertText`                  |
| `insertText` | `document.execCommand('insertText', false, value)`                                 | Default first step; trusted `beforeinput` and `input`  |
| `native`     | Native value setter on the element prototype, then `input`                         | Plain `<input>` and `<textarea>` under framework state |
| `clipboard`  | Write to clipboard, focus, prompt the user to press Ctrl/Cmd+V                     | Unblockable (a real paste is trusted); always last     |

Without a definition the chain tries `insertText` first. `execCommand` makes the browser fire trusted `beforeinput` and `input` events, as typing does. The synthetic `paste` ClipboardEvent and `native`'s `input` event carry `isTrusted: false`, which a page can detect and ignore or flag, so they come after it. A site definition still orders its own chain.

Success is judged by reading the element's value or text after injection. The comparison ignores whitespace and the zero-width characters rich editors insert, since editors render line breaks as paragraphs, and counts occurrences: the draft must appear once more than before, so a field that already held the same text does not pass a strategy that did nothing. A strategy that changes the field without the draft appearing stops the chain, since the next strategy could insert the draft a second time; the user is asked to check the field. `native` applies only to `<input>` and `<textarea>`. For `clipboard`, the page writes the clipboard when it may; otherwise the popup writes it inside the user's click. The insertion script then shows a notice asking for Ctrl/Cmd+V (it never shows draft text), judges the paste the same way, in the resolved field or any field the user clicks into, and gives up after two minutes. Asking the user to click into the field (10.2) waits the same way.

### 11.7 Saving a field as a draft

A context menu item on editable contexts, "Save to qus.me," reads the focused element's value and creates a draft for the current destination (prompting if the page matches several or none).

### 11.8 Agent approvals

The extension and PWA are where the user approves agent authorizations (8.2) and pending destinations. Approval UIs show the agent label, the host of its client ID URL (8.2), and the requested destinations, offer the `allow_new_destinations` toggle (off by default) with a one-line explanation, and require the queue to be unlocked. The extension's approval screen starts with every confirmed destination ticked, shows the client ID's host large with the rest of the request under Details, warns above Approve when nothing is ticked and the toggle is off (the agent could draft nothing, and the button reads "Approve anyway"), and on success lists what finished: saved to the queue, qus.me confirmed, and the client finishing its sign-in on its own (operator decision 2026-11-06). The destinations are a checkbox list in the one account format (11.5), with fields to tick only where the site definition has more than one; the quota, `submission_expiration_days` and `expires_at` are one Limits line that Change opens; the label is prefilled with the client name and sits under Details; and Approve and Deny are pinned to the bottom of the popup.

Opening the extension's popup on the service's authorize page (`/authorize/<id>`, 8.2 step 2) or on the page its QR opens (`/approve?code=`) reads the code off that tab under the popup's `activeTab` grant, with one read-only `scripting.executeScript` on the authorize page (its code box carries `data-approval-code`), and opens the approval with the code filled in. The code goes through the same parser as a typed one, and no other tab is read. When the service host permission (11.2) is already granted, the lookup runs on open, so the popup lands on the review; otherwise it waits for Look up, since the permission can be requested only inside the user's gesture. Typing or pasting the code stays available.

An approval re-reads the submitters list, grants, destinations and settings from every storage relay and goes no further if any relay is unreachable or does not answer, since a list republished from a partial read could drop an agent another device added. It publishes the submitters list with the agent added, then the grant, and needs every storage relay to accept both before it posts the approval naming those relays. The service may not see the new list at once, so the device retries a 409 `submitters_list_not_found` or `agent_not_in_submitters_list` a few times over about eight seconds before it reports the error; the request stays open and the user can approve again. Destinations the user shares are the confirmed ones, each with the fields the user ticks for it (`text` where the site definition has one field) and its `override` when it has one (7.4).

Revocation on a device asks for the service host permission (11.2) inside the user's gesture, publishes the submitters list without the agent first, then a NIP-09 deletion request for the agent's grant, best effort, then `DELETE /device/bindings/:agentPubkey` at the service (8.2). Once the list is out the device records the revocation as pending in `storage.local` (agent and queue pubkeys, the label, the last error) and clears it only when the service answers the `DELETE` with revoked or not found. If the user declined the permission, or the request fails (offline, the service down), the agents view shows the agent as "Revoked on your devices; finishing with qus.me…", says that it may still look like it works in its client though devices refuse its drafts, and offers Retry; each sync (11.4) retries every pending revocation of the unlocked queue. The agents view lists the agents on the submitters list with their labels, joined with the service's bindings for the client name and the host of its client ID; an agent the service still holds a key for but the list no longer names is shown as such, and revoking it again only tells the service. A pending revocation the service's answered bindings list no longer contains is cleared, since another device finished it.

Confirming a pending destination sets its `status` to `confirmed`. Rejecting one first republishes each active draft submitted for it (by `destination` id, or by site and account for a draft without one) as `archived:dismissed`, then removes the destination; if a draft fails to republish, the destination stays pending and the user can reject it again. Merging one into a confirmed destination (the same account under another spelling, say) first republishes each of its drafts, active or archived, matched the same way, with the target's `destination` id, site and account, then removes the pending destination; if a draft fails to republish, it stays pending and the user can merge again.

The agents view also edits an approved agent's access with the approval screen's form, started from its current grant: the destinations it shares (a grant destination that is no longer a confirmed destination is named and dropped on save), their fields, `allow_new_destinations`, the quota, `submission_expiration_days`, `expires_at` and the label. Saving re-reads the queue from every storage relay as an approval does, republishes the grant, keeping `min_pow` and every unknown key and tag, and republishes the submitters list only when the label changed; every storage relay must accept both. The service reads the grant from the relays on each call (8.4), so nothing is posted to it. An edit never adds an agent to the submitters list or removes one, and it refuses an agent the list no longer names or whose revocation the service has not confirmed, so it cannot undo a revocation. After the user adds a destination or confirms a pending one, the device offers to share it, with the default field, with each authorized agent whose grant has not expired and lacks it, none ticked, and republishes the grants of those the user ticks.

The user also manages destinations by hand, on the extension's Destinations screen, under the same rules: each change re-reads the destinations from every storage relay, changes only its own destination, keeps unknown fields, needs every storage relay to accept the new list, and requires the queue to be unlocked. Adding one picks a site from the registry definitions the device holds (10.3) and takes the account as typed or as the site's account locator finds it on the active tab (11.5 step 2), or makes a custom destination whose override gives at least its `match` patterns (10.2). The label defaults to `<site name> / <account>`, the account is stored as typed without a leading `@` or surrounding whitespace, the `id` is 32 random lowercase hex characters, and a site and account the list already has (accounts normalized, 10.1) is refused. Editing changes only the label and the override; the override must pass the definition parser (10.1), as a whole definition once merged when the site has an official one, and as valid `match` patterns at least for a custom destination. Removing one dismisses its active drafts as rejecting does, then removes it, and a failed dismissal leaves it in the list. When the active tab matches a registry site, an account is detected there and no destination has that site and account, the insert panel offers to add it with the default label.

### 11.9 Distribution

WXT builds and zips both targets, including the sources archive AMO requires; `wxt submit` covers both stores.

## 12. Mobile PWA

A full paired device: holds the queue key (NIP-49 at rest), syncs and ingests from the relays directly, and approves agents. Tapping a draft either opens the site's `compose` intent with the value (`pwa_intent`) or copies the value and opens the site or app (`pwa_copy`; Facebook personal profiles land here). Neither archives the draft on tap, since the PWA cannot observe whether the user posted and an intent can fail (logged out, app not installed). When the PWA becomes visible again after an open, it asks "Posted?" for that draft: Yes archives it as `archived:inserted` with an `inserted` tag recording the method; Not yet, or dismissing the prompt, leaves it active. No external signer is needed, so this works on iOS.

Firefox for Android users can also run the extension.

## 13. Security and privacy

Content is end-to-end encrypted on every relay: values, sites, accounts, fields, status, destinations, settings, and agent labels are inside NIP-44 payloads under either relay profile. What differs between the profiles is who sees the metadata.

**On ordinary relays (the baseline profile, 9.1), anyone who can query a storage relay sees:** the queue pubkey, and that it is a qus.me queue (the `qus.me/` `d` tags and the submitters and grant kinds, 7.2); event kinds, sizes, and timestamps, and so the queue's activity and volume: the number of draft wraps, the time of every edit, insertion, archive, and deletion, and each ingestion, since it updates the settings' `quota_counts`; the agent pubkeys, from the submitters list's `p` tags and the grants' `d` tags, with when each was added and removed; and the encrypted recovery backup. A single filter on `d` = `qus.me/recovery` returns the backup of every queue on a relay, and a copy can be attacked offline indefinitely, which is why the published copy is encrypted with a 128-bit recovery code (6.1). The backup's lookup tag is an HKDF output of that code and tells an observer nothing more. The inbox relay's operator sees the inbox pubkey and the count, sizes, and arrival times of gift wraps to it, but nothing on a storage relay links that pubkey to the queue (6.4). No relay learns which agent sent each wrap (7.5). The pairing messages of 8.3 are visible to any subscriber, which shows that a pairing took place.

**On a relay meeting the qus.me relay profile (9.2), such as the paid hosted relay,** only the relay's operator sees that metadata, and the operator also sees which agent submitted each gift wrap. Hiding the queue's metadata from everyone else is what the hosted relay offers.

**The service sees:** agent submissions in plaintext at write time (not retained); contentless receipts of them; which queue pubkeys it serves; the IP address of each request, of which it keeps only a keyed hash on a pending authorization until that row is swept (8.5, "Limits"), and which on Workers also passes through Cloudflare's rate limiting counters; agent grants for agents it holds keys for, and the agent pubkeys on those queues' submitters lists; on a typed-code pairing, the NIP-AB URI including its session secret (8.3). It cannot read the queue, sign as the user, or authorize a submitter. On a typed-code pairing it can defeat the SAS and receive the payload, which on that path is the recovery backup it could already fetch (8.3). A compromised service can submit drafts as any agent key it holds, until the user revokes those agents (8.2).

**Devices see:** everything; they hold the queue key. Every device holds the same key, so revoking one device means rotating the queue key (6.1).

**The extension sees** nothing on any site until the user acts in that tab, and then only that tab until navigation. It does not observe network traffic.

**Sites see** the inserted value, as if pasted. Nothing else from the queue.

**Agents** can submit to destinations in their grant (or propose new ones if the grant allows) and learn the inbox pubkey. On the qus.me relay profile they read only their own grant and the pubkeys on the submitters list that names them; on ordinary relays those events are public anyway. They cannot read, edit, or delete drafts. The human insertion step is the review gate.

**Abuse and cost** of the service itself are bounded by its own rate limits and hard caps (8.5, "Limits"): per-IP limits on the unauthenticated routes, per-agent and per-queue limits on `/mcp`, caps on open authorizations, agents per queue and drafts per queue per day, and a service-wide daily draft ceiling that fails closed, so neither a bug nor an attacker holding many tokens can push the hosted service past a known number of drafts a day.

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
- 2026-10-27: for development the service runs on the homelab through the Node entrypoint, behind the tunnel at `app.qus.me`; Workers remains a supported target at the same hostname (8.5, 9.3). Superseded 2026-11-05 by the Workers deployment below.
- 2026-10-27: gift wraps are addressed to a separate inbox key, rotatable without the queue key (6.4; `docs/relays.md`).
- 2026-10-27: a field value is at most 32 KiB of plaintext, so its draft wrap fits default strfry's 64 KiB event limit (7.1).
- 2026-10-27: the `qus.me/` `d`-tag prefix stays, as NIP-78's application identifier (7.2).
- 2026-10-27: a pairing session started with a typed code sends the recovery backup, encrypted with the 128-bit recovery code, and the new device asks for the recovery code; a QR session sends the passphrase copy. Whoever relays the URI can defeat the SAS, so on the typed path a compromised service could receive the payload, and the recovery backup gives it nothing it could not already fetch from the storage relays or attack offline. Sending the passphrase copy on both paths was the alternative: more convenient, but it would let a compromised service guess the passphrase offline (8.3; [#48](https://github.com/lokkju/qusme/issues/48)).
- 2026-10-27: pairing keeps the typed code; 8.3 states that a party relaying the URI can defeat the SAS, and qus.me raises the commit-then-reveal fix on the NIP-AB PR instead of changing the protocol locally (8.3; [#26](https://github.com/lokkju/qusme/issues/26)).
- 2026-11-05: the registry publisher key lists `wss://nos.lol` and `wss://relay.ditto.pub` (read and write) in its NIP-65 relay list, also sent to the indexer `wss://purplepag.es`; builds bundle that list and fall back to the same two relays without it (10.3; lokkju/qusme-registry). Superseded 2026-11-09 by relay.primal.net in place of nos.lol, below.
- 2026-11-05: a grant's destinations carry the destination's `override`, since the service cannot read the settings and validates against the effective definition (7.4, 8.4); the service mines `min_pow` up to 24 bits and refuses a grant asking for more (7.4; [#9](https://github.com/lokkju/qusme/issues/9)).
- 2026-11-05: accounts compare normalized everywhere (no leading `@` or surrounding whitespace, case-folded unless the definition sets `account.caseSensitive`), at the service, at ingestion, in pending destination ids and on devices; devices store the account as written, minus the `@` (10.1; [#72](https://github.com/lokkju/qusme/issues/72)).
- 2026-11-05: the service runs on Cloudflare Workers, as the `qusme` Worker that also serves the landing site at `qus.me`, with the D1 database `qusme`, deployed by this repo on every push to `main`; lokkju/infra owns the script, domains, database, secret and deploy token. The homelab deployment is retired, and the Node entrypoint is for local development only; its container image and the workflow that built it were removed ([#84](https://github.com/lokkju/qusme/pull/84)). The Workers Free plan's 10 ms of CPU per request bounds the proof of work the service can mine (7.4, 8.5; [#66](https://github.com/lokkju/qusme/issues/66)).
- 2026-11-09: `wss://relay.primal.net` replaces `wss://nos.lol` as a recommended storage relay (9.1), in the extension's suggested storage relays, and in the registry publisher's relay list and the fallback relays (10.3; lokkju/qusme-registry#11, #12). nos.lol (strfry 1.1.3) silently drops writes: it answered a kind 31234 EVENT with a one-hour NIP-40 expiration with no OK, NOTICE or CLOSED, from the publisher key and from a fresh key, while relay.primal.net and relay.ditto.pub answered OK true and relay.primal.net served the registry's events back (`docs/relays.md`). Existing queues keep the relays they were created with; moving them off nos.lol is [#101](https://github.com/lokkju/qusme/issues/101).
- 2026-11-10: a device marks a storage relay as accepting nothing after three syncs in a row, at least an hour from first to last, in which the relay answered REQs and accepted none of the EVENTs sent to it while another storage relay accepted one, and offers to replace it: probe, copy the queue's events, publish the new 10013, and only then switch, then offer a new recovery sheet from the typed recovery code (9.1, 11.4; [#101](https://github.com/lokkju/qusme/issues/101)). Reads (a relay that accepts and serves nothing back) are not checked; the probe at setup and at a swap covers them.
- 2026-11-10: the service mines `min_pow` up to `QUSME_MAX_POW` bits, 5 by default, sized from a workerd measurement to the Workers Free plan's 10 ms of CPU, in place of 24, and stops mining after 2^cap × 8 KiB of hashing with `pow_budget_exceeded` (7.4, 8.4, 8.5; [#93](https://github.com/lokkju/qusme/issues/93)).
- 2026-11-11: site definitions gain placeholder locators (`by: "placeholder"`), `account.extract` as `{ pattern, template }` with `{N}` and `{host}`, and the `mastodon` counter; locators search open shadow roots when the light DOM has no match; `account` and `intents` stay optional. A template is the one addition older parsers reject, so they keep the previous signed definition (10.1; [#94](https://github.com/lokkju/qusme/issues/94)).
- 2026-11-11: the recovery code alone finds the backup: the backup carries an HKDF-derived lookup tag as a NIP-32 label, and a code-only recovery asks for it, falling back to opening untagged backups (at most eight) with the code (6.1). Recovery asks the current and earlier default storage relays and the user's, together, so a queue made on nos.lol and relay.ditto.pub, now on relay.ditto.pub alone, is found (9.1). A user on 2026.11.10.1 who kept only the code could not recover: the recover screen refused any text without an npub.
