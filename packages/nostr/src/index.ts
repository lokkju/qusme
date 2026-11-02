/**
 * Event builders and parsers for the kinds in spec section 7, and NIP-44/49/59 helpers. Shared by
 * the service, the extension and the PWA, so every client builds and parses events identically.
 */

export type { EventTemplate, NostrEvent, UnsignedEvent } from 'nostr-tools/core';
export {
  type AgentGrant,
  type AgentGrantEvent,
  type AgentGrantInput,
  buildAgentGrant,
  DEFAULT_SUBMISSION_EXPIRATION_DAYS,
  type GrantDestination,
  type GrantQuota,
  MAX_SUBMISSION_EXPIRATION_DAYS,
  parseAgentGrant,
  QUOTA_PERIODS,
  type QuotaPeriod,
  quotaPeriodStart,
  readAgentGrant,
} from './agentGrant.ts';
export {
  type AppData,
  type AppDataOptions,
  archiveRetentionDays,
  buildDestinations,
  buildRecoveryBackup,
  buildRotationMarker,
  buildSettings,
  D_DESTINATIONS,
  D_RECOVERY,
  D_ROTATED,
  D_SETTINGS,
  DESTINATION_STATUSES,
  type Destination,
  type DestinationStatus,
  type Destinations,
  HOSTED_ARCHIVE_RETENTION_DAYS,
  parseDestinations,
  parseRecoveryBackup,
  parseRotationMarker,
  parseSettings,
  type QuotaCount,
  type RecoveryBackup,
  type RotationMarker,
  readDestinations,
  readSettings,
  type Settings,
} from './appData.ts';
export {
  type ConstraintName,
  type ConstraintViolation,
  countCodePoints,
  countGraphemes,
  countLength,
  countTwitterText,
  FIELD_VALUE_MAX_BYTES,
  type FieldValidation,
  utf8Length,
  validateFieldValue,
  validationTagJson,
} from './counting.ts';
export {
  buildDeletionRequest,
  buildGiftWrapDeletion,
  type DeletionRequest,
  type DeletionTargets,
  draftAddress,
  parseDeletionRequest,
} from './deletion.ts';
export {
  buildDraftDeletion,
  buildDraftWrap,
  type DeletedDraftWrap,
  type DraftContent,
  type DraftWrap,
  ingestedDraftD,
  type NoteDraft,
  newDraftId,
  parseDraftWrap,
} from './draftWrap.ts';
export {
  FIELD_VALUE_STATUSES,
  type FieldValue,
  type FieldValueSource,
  type FieldValueStatus,
  fieldValueRumor,
  type Insertion,
  parseFieldValue,
  RESERVED_FIELD_VALUE_TAGS,
  type SubmissionValue,
  submissionRumor,
} from './fieldValue.ts';
export * from './kinds.ts';
export {
  nip44ConversationKey,
  nip44Decrypt,
  nip44DecryptFromSelf,
  nip44DecryptWithKey,
  nip44Encrypt,
  nip44EncryptToSelf,
  nip44EncryptWithKey,
} from './nip44.ts';
export {
  decodeNcryptsec,
  encodeNcryptsec,
  type KeySecurity,
  NCRYPTSEC_DEFAULT_LOG_N,
  NCRYPTSEC_MAX_LOG_N,
  NCRYPTSEC_MIN_LOG_N,
  type NcryptsecOptions,
  type NcryptsecParams,
  ncryptsecParams,
} from './nip49.ts';
export {
  createGiftWrap,
  createRumor,
  createSeal,
  type GiftWrapOptions,
  giftWrap,
  NIP59_TIMESTAMP_JITTER,
  type Rumor,
  type RumorTemplate,
  randomizedTimestamp,
  type TimestampOptions,
  type Unwrapped,
  unwrapGiftWrap,
} from './nip59.ts';
export {
  buildHttpAuth,
  HTTP_AUTH_WINDOW_SECONDS,
  type HttpAuth,
  type HttpRequestFacts,
  httpAuthHeader,
  verifyHttpAuth,
} from './nip98.ts';
export {
  ABORT_REASONS,
  type AbortReason,
  matchesQueuePubkey,
  PAIRING_CREATED_AT_JITTER,
  PAIRING_SESSION_TIMEOUT_MS,
  PAIRING_STEP_TIMEOUT_MS,
  type PairingChannel,
  type PairingNotice,
  type PairingOptions,
  PairingSource,
  type PairingSourceState,
  type PairingStep,
  PairingTarget,
  type PairingTargetState,
  pairingFilter,
  type ReceivedPayload,
  type SourcePayload,
  type UnlockSecret,
  unlockSecretFor,
} from './nipAb.ts';
export {
  constantTimeEqual,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhShared,
  isCurvePoint,
  type Sas,
} from './nipAbCrypto.ts';
export {
  buildPairingUri,
  NIP_AB_VERSION,
  NOSTRPAIR_MAX_LENGTH,
  NOSTRPAIR_MAX_RELAYS,
  NOSTRPAIR_SCHEME,
  type PairingUri,
  parsePairingUri,
} from './nipAbUri.ts';
export {
  CROCKFORD_ALPHABET,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
} from './pairingCode.ts';
export {
  buildPrivateRelayList,
  type PrivateRelayList,
  parsePrivateRelayList,
} from './relayList.ts';
export type { ParseError, ParseErrorCode, ParseResult } from './result.ts';
export { createLocalSigner, type Signer } from './signer.ts';
export {
  COUNTER_NAMES,
  type CounterName,
  compareSiteVersions,
  type FieldConstraints,
  INJECTION_STRATEGIES,
  type InjectionStrategy,
  type Locator,
  parseSiteDefinition,
  parseSiteDefinitionEvent,
  type SiteAccount,
  type SiteDefinition,
  type SiteDefinitionEvent,
  type SiteField,
  type UnusableField,
} from './siteDef.ts';
export {
  buildSubmission,
  fieldValueFromSubmission,
  openSubmission,
  type Submission,
  type SubmissionInput,
} from './submission.ts';
export {
  buildSubmittersList,
  parseSubmittersList,
  parseSubmittersPublic,
  type SubmitterLabel,
  type SubmittersList,
  type SubmittersOptions,
  type SubmittersPublic,
} from './submitters.ts';
export {
  type ExtractedUrl,
  extractUrlsWithIndices,
  type ParsedTweet,
  parseTweet,
  TWITTER_TEXT_CONFIG_V2,
  TWITTER_TEXT_CONFIG_V3,
  type TwitterTextConfig,
} from './twitterText.ts';
export type { JsonObject, JsonValue } from './validate.ts';
