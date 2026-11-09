# Public relays for qus.me queues

Spike for [#38](https://github.com/lokkju/qusme/issues/38): can a qus.me queue run on ordinary public Nostr relays, which ones, and what changes in the spec if it does. Results are from 2026-10-27, against `docs/spec.md` v0.3; the 2026-11-09 recheck below changes the storage recommendation.

## Method

`packages/nostr/scripts/relay-probe.ts` runs every check below against each relay with keys generated for that run: a queue key Q, an agent key A, an unrelated key S, a junk submitter J, and two NIP-AB ephemeral keys. It opens four connections per relay: Q, A and S authenticate (NIP-42) whenever the relay sends a challenge or answers `auth-required`, and the fourth never authenticates. Every event it publishes is deleted at the end (NIP-09 by Q, gift wraps by Q as their recipient), test gift wraps carry a two-hour NIP-40 expiration, and the burst is 30 events of one byte each.

```sh
pnpm -C packages/nostr relay-probe --out results.json [wss://relay ...]
```

Raw output of the run this document reports is `docs/relays-results.json`. Placeholder kinds are 13234 for `KIND_SUBMITTERS` (replaceable range) and 33234 for `KIND_AGENT_GRANT` (addressable range). The rumor inside test gift wraps is kind 31235.

The checks:

- NIP-11: supported NIPs, limits, payment and auth flags.
- Kind 31234 (an encrypted NIP-37 draft wrap), kind 30078 twice (the recovery backup with a real `ncryptsec`, and encrypted destinations), the submitters list and an agent grant, each published by Q and read back by Q, by S authenticated, and unauthenticated; the submitters list and grant also by A.
- Kind 1059 gift wraps `p`-tagged to Q: one sealed by A and sent over A's connection, one sealed by J and sent over the unauthenticated connection. Read back by Q, by S and unauthenticated.
- Kind 24134 (NIP-AB) from one ephemeral key to the other: delivered live to the `p`-tagged subscriber, to S subscribed to the same filter, to an unauthenticated subscriber, and whether a later query returns it.
- NIP-40: an event that expires 20 seconds after publication, queried after expiry, both as a draft wrap and as a gift wrap; and an event already expired when published.
- NIP-09: Q deletes its draft wrap; Q deletes the gift wrap addressed to it ([NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md), open [nips#2350](https://github.com/nostr-protocol/nips/pull/2350)), then A republishes the same wrap.
- Sizes: draft wraps with 10 KiB and 64 KiB of content.
- Burst: 30 draft wraps sent without waiting for each `OK`.

## Results

| Check | [auth.nostr1.com](https://auth.nostr1.com) | [nos.lol](https://nos.lol) | [relay.primal.net](https://primal.net) | [relay.ditto.pub](https://relay.ditto.pub) | [relay.nostr.net](https://nostr.net) | [inbox.nostr.wine](https://inbox.nostr.wine) | [nostr.wine](https://nostr.wine) |
|---|---|---|---|---|---|---|---|
| Software | strfry fork (relay.tools) | strfry 1.1.3 | strfry 1.1.3 | ditto-relay 2.5.1 | strfry 1.1.2+148 | nostr.wine inbox 0.1.4 | nostr.wine 0.3.3 |
| Payment | free | free | free | free | free | paid subscription | paid admission |
| NIP-42 AUTH | required for everything | not offered | not offered | not offered | challenge sent, every AUTH refused (`relay needs serviceUrl`) | AUTH refused for non-subscribers | AUTH works, writes need payment |
| 31234 draft wrap: write | refused (`this relay is for private messages only`) | ok | ok | ok | ok | refused | refused |
| 31234 read by other key / unauthed | n/a | yes / yes | yes / yes | yes / yes | yes / yes | n/a | n/a |
| 30078 recovery and destinations: write | ok | ok | ok | ok | ok | refused | refused |
| 30078 read by other key / unauthed | yes / auth required | yes / yes | yes / yes | yes / yes | yes / yes | n/a | n/a |
| Submitters (13234) and grant (33234): write | ok | ok | ok | ok | ok | refused | refused |
| Same, read by other key / unauthed | yes / auth required | yes / yes | yes / yes | yes / yes | yes / yes | n/a | n/a |
| 1059 write, authed agent | ok | ok | ok | ok | ok | refused (`inbox ... does not exist`) | refused |
| 1059 write, unknown key, unauthed | refused (auth required) | ok | ok | ok | ok | refused | refused |
| 1059 read by recipient | yes | yes | yes | yes | no (auth required, AUTH broken) | n/a | n/a |
| 1059 read by other key / unauthed | no / auth required | yes / yes | yes / yes | yes / yes | no / no | n/a | n/a |
| 24134 live to recipient | yes | yes | yes | yes | yes | refused kind | refused |
| 24134 live to other key / unauthed | yes / auth required | yes / yes | yes / yes | yes / yes | yes / yes | n/a | n/a |
| 24134 returned by a later query | auth required to ask | yes | yes | no | yes | n/a | n/a |
| NIP-40: expired event hidden | yes (gift wrap) | yes | yes in 2 of 3 runs | yes | no (draft wrap served after expiry in all 3 runs) | n/a | n/a |
| NIP-40: already-expired event refused | yes | yes | yes | yes | yes | yes | yes |
| NIP-09 by author | honored | honored | honored | honored | honored | n/a | refused (payment) |
| Recipient deletes gift wrap | ignored | ignored | ignored | honored | honored | n/a | n/a |
| Deleted gift wrap republished | stored again | stored again | stored again | refused | refused | n/a | n/a |
| 10 KiB / 64 KiB draft wrap | n/a (kind refused) | ok / refused (`event too large: 65909`) | ok / ok | ok / ok | ok / ok | n/a | n/a |
| Burst of 30 | n/a (kind refused) | 30 ok in 0.3 s | 30 ok in 0.4 s | 30 ok in 0.1 s | 30 ok in 0.4 s | n/a | n/a |

"Other key" is S, authenticated wherever the relay offers AUTH. On relays that do not offer it, it is just another unauthenticated client.

Not tested:

- relay.0xchat.com: the name did not resolve on 2026-10-27.
- relay.damus.io: its NIP-11 answers, and an HTTP/1.1 websocket upgrade with curl succeeds, but Node 24's built-in `WebSocket` is refused at connect every time. I did not try to get around that; a browser client would likely connect. Its NIP-11 lists NIP-59, which is not evidence of restricted reads.
- inbox.nostr.wine and nostr.wine store nothing for a key without a subscription. inbox.nostr.wine refuses a gift wrap to any pubkey that is not a subscriber (`the inbox you tried to reach does not exist`), so it is usable only if the queue key itself pays, and it accepts no kind but its inbox kinds (its NIP-11 `retention` lists 4, 1059, 1984, 9735, 65000 and 65001).

## Which relays meet the base needs

None of the tested relays meets the whole of 9.1, and none can: no ordinary relay knows the submitters list, so none can gate gift wrap writes by it, and none restricts reads of 30078 or the placeholder kinds to their author. The base needs split cleanly into two roles that different relays meet.

Storage (31234, 30078, 10013, submitters, grants) works on nos.lol, relay.primal.net and relay.ditto.pub: they accept every kind, honor NIP-09 from the author and NIP-40 at read time, and took a burst of 30 without complaint. relay.nostr.net works too, except that it served an expired event in all three runs. Every one of them serves everything to everyone.

The inbox (kind 1059) needs a relay that restricts reads to the `p`-tagged pubkey under NIP-42, as [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) and [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) recommend. Of the free relays tested, only auth.nostr1.com does it: the recipient reads its wraps, any other authenticated key gets nothing, and unauthenticated clients are refused. It refuses kind 31234, so it can never be the storage relay. It ignores the recipient's deletion request; the NIP-40 expiration hides the wrap instead. relay.nostr.net restricts 1059 reads but its AUTH is misconfigured, so nobody can read gift wraps there at all, the recipient included: a wrap sent there is lost. strfry gained restricted reads in [hoytech/strfry#250](https://github.com/hoytech/strfry/pull/250) (merged 2026-08-05), and `strfry.conf` on master now defaults to `restrictedReadKinds = "4, 1059"` with `restrictReadToInvolvedPubkey = true`. Tag 1.1.3 does not include it. Once a release ships it, most strfry relays that upgrade with the default config become usable inboxes.

## What degrades on an ordinary relay, rule by rule

Against 9.1, on a storage relay like nos.lol plus an inbox relay like auth.nostr1.com:

1. **Authentication.** Gone on the storage relay; required on the inbox. Nothing in the device's own flow needs AUTH on a storage relay, and the service needs none to read a grant, since anyone can.
2. **Queue reads.** Gone. Every queue event is readable by anyone, so the three exceptions in rule 2 stop mattering: the recovery backup, grants and submitters lists are public. Content stays NIP-44-encrypted; what leaks is metadata (next section). auth.nostr1.com, the one relay that requires AUTH for everything, still serves 30078 and the placeholder kinds to any authenticated key.
3. **Gift wraps.** Write gating by the submitters list is gone everywhere. Any key, or on most relays no key at all, can put a gift wrap `p`-tagged to the queue. Read restriction survives only on the inbox relay. The one thing gained: no relay learns which agent sent which wrap, since the agent authenticates as nobody in particular (or, on auth.nostr1.com, as itself, which that relay then sees; the service could authenticate with a throwaway key instead).
4. **Pairing messages.** Works without any special rule. Kind 24134 is delivered live to any subscriber of the filter, not only the `p`-tagged one, and strfry relays keep ephemeral events for a few minutes (`ephemeralEventsLifetimeSeconds`, 300 by default), so a later query returns them. The content is NIP-44 between ephemeral keys and the SAS check covers substitution, so this exposes only that a pairing happened at that moment.
5. **Other writes.** Gone; anyone writes anything. No queue is capped, but nothing a stranger writes can replace a queue-key event, since every addressable and replaceable event is keyed on its author.
6. **Expiration and deletion.** Partly. NIP-09 from the author was honored everywhere it was accepted. NIP-40 was honored at read time on nos.lol, relay.ditto.pub and auth.nostr1.com, and inconsistently or not at all on relay.primal.net and relay.nostr.net. Recipient deletion of a gift wrap, which 11.4 relies on, was honored only by relay.ditto.pub and relay.nostr.net, and those two are also the only ones that refused to store a deleted wrap again. Note that the text of NIP-59 on master does not grant recipients this right; NIP-17 says it does, and nips#2350 proposes adding it to NIP-09. Deletion on a public relay is a request, and other relays and archivers may already hold a copy.

Sizes: nos.lol refused a 64 KiB draft wrap (the whole event was 65,909 bytes, over strfry's default 64 KiB `maxEventSize`). NIP-44 caps plaintext at 65,535 bytes, which becomes about 87 KB of ciphertext, so any draft near the NIP-44 limit fails on default strfry relays. With NIP-44 padding, a rumor of up to 40 KiB keeps its draft wrap under 64 KiB; at 46 KiB the padded ciphertext alone passes it.

## What a third party learns from public queue events

Anyone who can query the storage relay learns:

- **That a pubkey is a qus.me queue.** The `d` tags `qus.me/recovery`, `qus.me/destinations` and `qus.me/settings` say so, as do the submitters and grant kinds once they have registered numbers.
- **Every queue on the relay.** A single filter, `{"kinds":[30078],"#d":["qus.me/recovery"]}`, returns the recovery backup of every queue on that relay with its pubkey. In 9.1 an attacker needed the relay URL and the queue npub; on a public relay, and on every relay that mirrors it, the `ncryptsec` of every user is one query away, and offline guessing against all of them at once is possible. The passphrase and the scrypt cost (open question in section 17) become the only protection, for every user, permanently: a copy fetched today can be attacked later.
- **The agents.** The submitters list `p`-tags every authorized agent pubkey, and each grant's `d` tag is an agent pubkey. The number of agents, when each was added (the list's `created_at` on each change) and when one was removed are all public. Agent pubkeys are minted by the service per MCP client authorization and are linked to nothing else.
- **Activity and volume.** Count of draft wraps (active and archived are indistinguishable, but blanked wraps and kind 5 deletions show when drafts are removed), the time of every edit, insertion and archive (each republishes the wrap with a new `created_at`), sizes of each draft, and how often the destinations and settings change. The settings event changes on every ingestion that updates `quota_counts`, which times ingestion.
- **Submissions,** if the inbox is a relay that does not restrict reads: the count of gift wraps to the queue and their sizes. NIP-59 randomizes `created_at` up to two days back, but a live subscriber sees each wrap when it arrives, so timing leaks anyway. On an inbox relay that restricts reads, only that relay's operator sees this.

Content does not leak: values, sites, accounts, fields, status and agent labels are inside NIP-44 payloads.

## Junk gift wraps and ingestion

Without a relay write gate, the ingestion check in 11.4 (seal pubkey in the submitters list) is the only filter, and it runs after the expensive part. Opening a gift wrap means verifying the wrap's signature, an ECDH with the wrap's one-time key (a fresh one per wrap, so the conversation-key cache does not help), a NIP-44 decryption, verifying the seal's signature, a second ECDH and decryption. With `unwrapGiftWrap` from this package, a full unwrap took 15.6 ms per wrap in Node 24 on ml-01 (500 wraps of 2.2 KB each, 7.8 s). Checking the seal pubkey before verifying the seal and decrypting the rumor would save a bit under half of that. A phone running the same pure-JavaScript crypto is several times slower.

So 10,000 junk wraps, which the burst test suggests any open relay will take in seconds, cost a device about 22 MB of download and two and a half minutes of CPU on a fast machine, more like ten minutes on a phone, on every device, on each sync until they expire. An attacker needs only the queue pubkey, which the storage relay publishes. auth.nostr1.com requires AUTH to write but accepts any key, so it raises the cost of a flood by nothing. Ingestion filtering is correct, in that junk never becomes a draft, but it does not bound the cost.

What bounds it, in order of how much each changes:

- **A separate inbox key.** Gift wraps `p`-tag an inbox pubkey that is not the queue pubkey. Devices hold its secret (inside the encrypted settings), grants carry the inbox pubkey to each agent (encrypted to the agent), and nothing public links it to the queue. A stranger cannot address a wrap to an inbox they cannot name, and the storage relay no longer shows submission timing for the queue pubkey. If an agent leaks it or the inbox is flooded anyway, devices mint a new inbox key and republish the grants, without rotating the queue key. On an inbox relay with restricted reads, devices authenticate as the inbox key (NIP-42 allows several AUTH pubkeys on one connection).
- **Proof of work.** Grants could require [NIP-13](https://github.com/nostr-protocol/nips/blob/master/13.md) work on the gift wrap's id, which a device checks with one hash before any ECDH, as NIP-59 already suggests. It costs the service the work for each submission; mining 20 bits is about a million SHA-256 hashes, which does not fit the Workers free plan's CPU limit.
- **A per-sync cap** on how many wraps a device opens, with the remainder left for later, so a flood delays ingestion instead of freezing the popup.

## NIP-AB pairing

Pairing works on every relay that accepts kind 24134: auth.nostr1.com (both ephemeral keys authenticate as themselves, which NIP-AB never asks for but the keys can do), nos.lol, relay.primal.net, relay.ditto.pub and relay.nostr.net. Each delivered the message live to the `p`-tagged subscriber within the three-second window. inbox.nostr.wine refuses the kind. Section 9.1 rule 4 exists only because the qus.me relay restricts everything else; on ordinary relays it is unnecessary. The `nostrpair://` URI should list the queue's storage relays, all of which carry it, and not the inbox relay, which may refuse the kind.

## 2026-11-09: nos.lol stopped accepting writes

nos.lol (still strfry 1.1.3) now silently drops writes. An EVENT gets no OK, NOTICE or CLOSED, whether it comes from the registry publisher key or from a freshly generated key; the test event was a kind 31234 with a one-hour NIP-40 expiration. relay.ditto.pub and relay.primal.net both answered OK true to the same event, and relay.primal.net serves the registry's events back on REQ. The registry publisher's relay list was already relay.primal.net plus relay.ditto.pub (lokkju/qusme-registry#11, #12).

So relay.primal.net replaces nos.lol as a recommended storage relay, in the extension's suggested storage relays and in the registry fallback relays. The 2026-10-27 results above are left as they were measured, including relay.primal.net's inconsistent NIP-40 handling in that run, which this recheck did not retest. Queues created with nos.lol keep it; [#101](https://github.com/lokkju/qusme/issues/101) is how they move off it.

## Recommended relays for development

- Storage (the queue's kind 10013): `wss://relay.primal.net` and `wss://relay.ditto.pub` (since 2026-11-09). Both accepted every kind; relay.ditto.pub also honors recipient deletion and NIP-40 consistently, and accepts larger events. The 2026-10-27 recommendation was nos.lol and relay.ditto.pub, with relay.primal.net as a reasonable third; nos.lol is out because it no longer accepts writes (above).
- Inbox (the grant's `inbox`): `wss://auth.nostr1.com`, the only free relay tested that restricts gift wrap reads to the recipient.
- Pairing: the storage relays.
- Local and CI: a strfry built from master, whose default config restricts 1059 reads, so tests do not depend on public relays' uptime or policy.

Do not use relay.nostr.net as an inbox until its AUTH works; gift wraps sent there cannot be read by anyone. Do not use inbox.nostr.wine unless the queue key holds a subscription.

## Spec changes

1. **9.1 becomes the "qus.me relay profile"**, optional, met by the hosted relay and by a self-hosted strfry or nostr-rs-relay with the write policy. It keeps its six rules. Section 5's diagram and section 13 describe what it adds over the baseline: author-only reads, submitter-gated writes, real deletion, per-queue caps.
2. **A new "baseline profile" for ordinary relays**, with two roles:
   - storage relays (kind 10013, as NIP-37 defines): accept kinds 31234, 30078, 10013, `KIND_SUBMITTERS` and `KIND_AGENT_GRANT`; honor NIP-09 from the author and NIP-40; accept events up to 64 KiB. No AUTH required.
   - inbox relays (the grant's `inbox`, and the queue's kind 10050 per NIP-17 if the Draft Inbox NIP adopts it): NIP-42, and kind 1059 readable only by the `p`-tagged pubkey.
   Devices check a relay before saving it by probing, not by NIP-11 alone: relay.nostr.net advertises AUTH that cannot succeed, and auth.nostr1.com restricts reads without listing NIP-59. The probe publishes a gift wrap to the device's own key and confirms that an unauthenticated read returns nothing and an authenticated read returns it.
3. **Section 7's opening line** ("All queue-key events go only to the private relay listed in the user's kind 10013") changes to: queue-key events go to the storage relays in 10013; gift wraps go to the inbox relay in the grant. 2.1's NIP-11 row changes to match.
4. **A separate inbox key** (7.4, 7.5, 11.4, 13): gift wraps `p`-tag an inbox pubkey distinct from the queue pubkey, carried in each grant, its secret held by devices in the encrypted settings, rotatable without rotating the queue key. This is the main defense against junk on the baseline profile and costs one more key in the settings event.
5. **The recovery backup** (6.1, 9.1 rule 2, 13, 17): on the baseline profile the backup is publicly enumerable across all queues by its `d` tag. Options for the next revision: publish it only to a relay that restricts reads (the qus.me profile, or a NIP-42 relay that serves 30078 to its author only, which none of the tested relays does); add a recovery code the user writes down, combined with the passphrase before scrypt; or keep it public and raise `log_n`. Whichever is chosen, 6.1 and 13 should state that on a public relay the backup can be copied by anyone and attacked offline indefinitely.
6. **Ingestion cost** (11.4): order the checks so the seal pubkey is compared with the submitters list before the seal's signature is verified or the rumor decrypted; cap the wraps opened per sync; optionally add a `min_pow` field to the grant (NIP-13 on the gift wrap id), checked before any ECDH.
7. **Recipient deletion** (11.4, 13): cite NIP-17 and nips#2350, not NIP-59, whose text does not grant it. State that three of five relays tested ignore it, so the NIP-40 expiration is the bound in practice, and devices skip already-ingested wraps by the derived `d` (already in 11.4).
8. **Spam** (13): "blocked by the submitters list at the relay and again at ingestion" holds only on the qus.me profile. On the baseline it is ingestion alone, bounded by the inbox key, proof of work and the per-sync cap.
9. **What the relay sees** (13): on the baseline profile, everyone sees what 13 now says only the relay sees, plus the agent list and the recovery backup. What it no longer sees: which agent sent each wrap, since nothing authenticates the submitting connection to an agent key.
10. **Pairing** (8.3, 9.1 rule 4): the NIP-AB relay list is the queue's storage relays. Rule 4 belongs to the qus.me profile only. Note in 8.3 that on ordinary relays any subscriber sees the (encrypted) pairing messages, and strfry relays keep them for about five minutes.
11. **Draft size** (7.1, 8.4): cap a field value so its draft wrap stays under 64 KiB, the default strfry limit; a 32 KiB plaintext cap leaves room for tags and the rumor envelope. The service's validation and the device both enforce it.
12. **`d` tag fingerprint** (7.2, 6.1): the `qus.me/` prefixes identify queue pubkeys to anyone. NIP-78 expects an app identifier, so this is a choice to record, not necessarily to change; with an inbox key the remaining link between a queue and its submissions is gone anyway.
