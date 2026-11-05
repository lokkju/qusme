/**
 * Every event kind the package builds or parses. No other file in the package writes a kind
 * number; a test enforces that, so changing a constant here changes it everywhere.
 *
 * The four kinds of the proposed NIPs (spec 2.2) were picked on 2026-10-27 from numbers unused in
 * the kind registry of the nips README, in nostr-protocol/registry-of-kinds and in the open
 * nostr-protocol/nips PRs (decided in lokkju/qusme#31). They share the suffix 1235 across the
 * regular, replaceable and addressable ranges, the way NIP-51 pairs 10000 and 30000, and sit next
 * to NIP-37's 31234, which wraps every draft.
 *
 * If review of a NIP forces a number to change, the old number moves into that kind's `_FORMER`
 * list: parsers accept every number in {@link FIELD_VALUE_KINDS} and its siblings, builders write
 * only the current one, so existing data migrates as it is republished instead of breaking.
 */

/** NIP-09 deletion request. */
export const KIND_DELETION = 5;
/** NIP-01 short text note; a Nostr note draft is a NIP-37 wrap of an unsigned kind 1 (spec 2.2). */
export const KIND_SHORT_NOTE = 1;
/** NIP-59 seal. */
export const KIND_SEAL = 13;
/** NIP-59 gift wrap. */
export const KIND_GIFT_WRAP = 1059;
/** NIP-65 relay list metadata: the registry publisher's relays (spec 10.3). */
export const KIND_RELAY_LIST = 10002;
/** NIP-37 private storage relay list. */
export const KIND_PRIVATE_RELAYS = 10013;
/** NIP-AB device pairing message (ephemeral range, spec 8.3). */
export const KIND_PAIRING = 24134;
/** NIP-42 relay authentication. */
export const KIND_RELAY_AUTH = 22242;
/** NIP-98 HTTP auth. */
export const KIND_HTTP_AUTH = 27235;
/** NIP-78 application-specific data (addressable). */
export const KIND_APP_DATA = 30078;
/** NIP-37 draft wrap. */
export const KIND_DRAFT_WRAP = 31234;

/** Web Field Values NIP: the unsigned field value rumor (regular range, spec 7.1). */
export const KIND_FIELD_VALUE = 1235;
/** Draft Inbox NIP: the authorized-submitters list (replaceable range, spec 7.3). */
export const KIND_SUBMITTERS = 11235;
/** Draft Inbox NIP: an agent grant (addressable range, spec 7.4). */
export const KIND_AGENT_GRANT = 31235;
/** Site and Field Definitions NIP: a site definition (addressable range, spec 7.6). */
export const KIND_SITE_DEF = 31236;

/** Numbers {@link KIND_FIELD_VALUE} has had before, oldest first. Parsers still accept them. */
export const KIND_FIELD_VALUE_FORMER: readonly number[] = [];
/** Numbers {@link KIND_SUBMITTERS} has had before. */
export const KIND_SUBMITTERS_FORMER: readonly number[] = [];
/** Numbers {@link KIND_AGENT_GRANT} has had before. */
export const KIND_AGENT_GRANT_FORMER: readonly number[] = [];
/** Numbers {@link KIND_SITE_DEF} has had before. */
export const KIND_SITE_DEF_FORMER: readonly number[] = [];

/** Every number a field value rumor is accepted under, current first. */
export const FIELD_VALUE_KINDS: readonly number[] = [KIND_FIELD_VALUE, ...KIND_FIELD_VALUE_FORMER];
/** Every number a submitters list is accepted under, current first. */
export const SUBMITTERS_KINDS: readonly number[] = [KIND_SUBMITTERS, ...KIND_SUBMITTERS_FORMER];
/** Every number an agent grant is accepted under, current first. */
export const AGENT_GRANT_KINDS: readonly number[] = [KIND_AGENT_GRANT, ...KIND_AGENT_GRANT_FORMER];
/** Every number a site definition is accepted under, current first. */
export const SITE_DEF_KINDS: readonly number[] = [KIND_SITE_DEF, ...KIND_SITE_DEF_FORMER];
