/**
 * The MCP endpoint (spec 8.4): stateless streamable HTTP through the official MCP TypeScript SDK,
 * mounted at `/mcp` behind the bearer check, which resolves the token to `c.var.agent`. Each
 * request gets a fresh server whose tools act for that agent:
 *
 * - `list_registry`: the bundled registry snapshot;
 * - `list_destinations`, `get_definition`: the agent's grant, with effective definitions (10.2);
 * - `create_draft`: validate, check the grant and its quota, seal with the agent key, gift-wrap
 *   to the grant's inbox key, publish to its inbox relays and record a contentless receipt;
 * - `list_submissions`: those receipts.
 *
 * Every tool but `list_registry` needs a current grant (7.4), read from the queue's storage
 * relays as the agent key, and an agent the queue's current submitters list (7.3) still names: a
 * list that dropped the agent revokes it even where a relay kept the grant. Failures are tool results with `isError` and structured content naming
 * the error, so a client can tell a constraint violation from an exhausted quota. The submitted
 * value is held only for the length of the call: it is never stored, logged or put in an error.
 */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  type AgentGrant,
  buildSubmission,
  createLocalSigner,
  displayAccount,
  type FieldValidation,
  type GrantDestination,
  type JsonObject,
  PowBudgetExceeded,
  quotaPeriodEnd,
  quotaPeriodStart,
  type SiteDefinition,
  type SiteField,
  sameAccount,
  validateFieldValue,
  validationTagJson,
} from '@qusme/nostr';
import { createStore, type QusmeDb, type Store } from '@qusme/store-sql';
import type { Context } from 'hono';
import { generateSecretKey } from 'nostr-tools/pure';
import { z } from 'zod';
import type { AgentKeyRing } from '../agentKeyRing.ts';
import { type AgentKeyCustody, createAgentKeyCustody } from '../agentKeys.ts';
import {
  BODY_LIMITS,
  createServiceLimits,
  type ServiceLimits,
  type TierLimits,
  tooManyRequests,
  utcDay,
} from '../limits.ts';
import { checkStorageRelays, type RelayReader } from '../oauth/relayReader.ts';
import type { McpAuthEnv } from '../oauth/server.ts';
import {
  createGrantCache,
  createSubmittersCache,
  type FoundGrant,
  type GrantCache,
  type SubmittersCache,
} from './grants.ts';
import {
  effectiveDefinition,
  loadRegistry,
  type Registry,
  type RegistrySnapshot,
} from './registry.ts';
import { createWebSocketRelayPublisher, type RelayPublisher } from './relayPublisher.ts';

const DAY = 86_400;

/**
 * Most NIP-13 difficulty the service mines by default (spec 7.4): 2^5 = 32 hashes on average.
 * Measured under workerd (packages/nostr/scripts/pow-bench.ts), one hash of a gift wrap costs
 * about 20 ns per byte, 37 µs for a short value's 1.6 KB wrap, so 5 bits of a short value take
 * about 1 ms of the Workers Free plan's 10 ms per request and 8 bits would take the whole 10 ms.
 * A deployment with more CPU raises it (`QUSME_MAX_POW`).
 */
export const DEFAULT_MAX_POW = 5;
/**
 * Bytes of serialized gift wrap the miner may hash per expected hash at the cap: the budget is
 * 2^maxPow times this, 256 KiB (about 5 ms) at the default. A short value's wrap gets about five
 * times its expected work before mining gives up (one try in 150 fails); a wrap whose expected
 * work alone exceeds the budget is refused without mining.
 */
export const POW_BYTES_PER_HASH = 8 * 1024;
/** Most `QUSME_MAX_POW` may be: NIP-13 difficulty counts the leading zero bits of a 256-bit id. */
const MAX_POW_LIMIT = 256;
/** Seconds a grant read from the relays is reused by default. */
export const DEFAULT_GRANT_CACHE_SECONDS = 30;
/** Largest request body: a 32 KiB value, JSON-escaped, with room for the envelope. */
const MAX_REQUEST_BYTES = BODY_LIMITS.mcp;
/** The usage counter scope of the service-wide daily create_draft ceiling. */
export const DRAFT_CEILING_SCOPE = 'create_draft';
/** Most receipts `list_submissions` returns per page. */
export const MAX_SUBMISSIONS_PAGE = 100;

/** What an entrypoint or a test may override; everything has a default. */
export interface McpOverrides {
  /** Bundled site definitions (10.3), as published JSON. Empty by default. */
  registry?: RegistrySnapshot;
  /** Reads grants from storage relays; the OAuth server's reader by default. */
  relayReader?: RelayReader;
  /** Publishes gift wraps to inbox relays; WebSockets by default. */
  relayPublisher?: RelayPublisher;
  /** Unix seconds. */
  now?: () => number;
  /** Seconds a grant or submitters list is reused; 0 reads the relays on every call. */
  grantCacheSeconds?: number;
  /**
   * Told when a tool went ahead without the submitters list because no storage relay returned one
   * (8.4). The MCP modules log nothing themselves; an entrypoint logs what this passes, which is
   * pubkeys only.
   */
  notice?: (notice: McpNotice) => void;
  /**
   * Highest grant `min_pow` the service mines (`QUSME_MAX_POW`), 0 to 256; a grant asking more is
   * refused. It also sets the mining budget: 2^maxPow × {@link POW_BYTES_PER_HASH} bytes hashed.
   */
  maxPow?: number;
}

export interface McpOptions extends McpOverrides {
  db: QusmeDb;
  agentKeys: AgentKeyRing;
  relayReader: RelayReader;
  version: string;
  /** Rate limits, caps and tiers (spec 8.5, "Limits"); in-memory defaults when left out. */
  limits?: ServiceLimits;
}

/** Something an operator may want to see; carries no key material and no submitted value. */
export interface McpNotice {
  event: 'submitters_list_unavailable';
  agentPubkey: string;
  queuePubkey: string;
}

/** Error codes in a failed tool result's structured content. */
export type McpToolErrorCode =
  | 'grant_revoked'
  | 'grant_not_found'
  | 'grant_expired'
  | 'grant_unusable'
  | 'destination_not_granted'
  | 'field_not_granted'
  | 'unknown_field'
  | 'field_unusable'
  | 'invalid_definition'
  | 'constraint_violation'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'pow_budget_exceeded'
  | 'publish_failed'
  | 'invalid_cursor'
  | 'internal_error';

class ToolError extends Error {
  readonly code: McpToolErrorCode;
  readonly details: JsonObject;
  constructor(code: McpToolErrorCode, message: string, details: JsonObject = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function failed(error: ToolError): ToolResult {
  const structured = { error: error.code, message: error.message, ...error.details };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

/**
 * Runs a tool body, turning a ToolError into its result and anything else into a bare one. A
 * request over its rate limit runs no tool at all and gets `rate_limited`.
 */
async function run(
  session: Session,
  body: () => Promise<Record<string, unknown>>
): Promise<ToolResult> {
  try {
    if (session.rateLimited !== undefined) {
      const seconds = session.rateLimited;
      throw new ToolError(
        'rate_limited',
        `Too many requests from this agent or its queue. Nothing was done. Wait ${seconds} ` +
          'seconds, then retry the same call.',
        { retry_after: seconds }
      );
    }
    return ok(await body());
  } catch (error) {
    // Unexpected errors carry no message: it could hold relay text or, worse, part of the value.
    return failed(
      error instanceof ToolError ? error : new ToolError('internal_error', 'the call failed')
    );
  }
}

function fieldSummary(field: SiteField) {
  return { name: field.name, label: field.label, constraints: field.constraints };
}

function definitionSummary(definition: SiteDefinition) {
  return {
    id: definition.id,
    name: definition.name,
    version: definition.version,
    match: definition.match,
    fields: definition.fields.map(fieldSummary),
  };
}

/**
 * The grant's destination for a site and account, accounts compared as devices compare them
 * (`normalizeAccount`: no leading `@`, no surrounding whitespace, case-folded unless the effective
 * definition says the site's accounts are case-sensitive).
 */
function findDestination(registry: Registry, grant: AgentGrant, site: string, account: string) {
  return grant.destinations.find((d) => {
    if (d.site !== site) return false;
    const effective = effectiveDefinition(registry, d.site, d.override);
    const rules = effective.kind === 'definition' ? effective.definition : undefined;
    return sameAccount(site, d.account, account, rules);
  });
}

/** Receipts page from the newest; the cursor is the last receipt's `created_at` and id. */
function encodeCursor(createdAt: number, giftWrapId: string): string {
  return `${createdAt}.${giftWrapId}`;
}

function decodeCursor(cursor: string): { before: number; beforeId: string } {
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(cursor);
  if (m === null)
    throw new ToolError('invalid_cursor', 'cursor is not one list_submissions returned');
  return { before: Number(m[1]), beforeId: m[2] as string };
}

const constraintsSchema = z.object({
  maxLength: z.number().int().optional(),
  counter: z.string().optional(),
});
const quotaSchema = z.object({
  max_submissions: z.number().int(),
  period: z.enum(['day', 'week', 'month']),
  used: z.number().int(),
  remaining: z.number().int(),
  period_start: z.number().int(),
  resets_at: z.number().int(),
});
const receiptSchema = z.object({
  gift_wrap_id: z.string(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
});

interface Session {
  agent: McpAuthEnv['Variables']['agent'];
  now: number;
  /** The limits of the agent's queue's tier. */
  tier: TierLimits;
  /** Seconds to wait when this request is over a rate limit; tools then refuse. */
  rateLimited?: number;
}

/** True when a JSON-RPC body (one message or a batch) calls a tool. */
function callsTool(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some(
      (m) =>
        typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call'
    );
  } catch {
    return false;
  }
}

export function createMcp(options: McpOptions) {
  const store: Store = createStore(options.db);
  const custody: AgentKeyCustody = createAgentKeyCustody(store, options.agentKeys);
  const registry: Registry = loadRegistry(options.registry);
  const publisher = options.relayPublisher ?? createWebSocketRelayPublisher();
  const cacheOptions = {
    relayReader: options.relayReader,
    ttlSeconds: options.grantCacheSeconds ?? DEFAULT_GRANT_CACHE_SECONDS,
  };
  const grants: GrantCache = createGrantCache(cacheOptions);
  const submitters: SubmittersCache = createSubmittersCache(cacheOptions);
  const maxPow = options.maxPow ?? DEFAULT_MAX_POW;
  if (!Number.isInteger(maxPow) || maxPow < 0 || maxPow > MAX_POW_LIMIT) {
    throw new Error(`maxPow (QUSME_MAX_POW) must be a whole number from 0 to ${MAX_POW_LIMIT}`);
  }
  const powMaxBytes = 2 ** maxPow * POW_BYTES_PER_HASH;
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const limits = options.limits ?? createServiceLimits({ now: clock });

  /**
   * The current grant or a ToolError; read as the agent key (7.4). The submitters list is read
   * alongside it: when one is found and no longer names the agent, the user revoked it, whatever
   * grant a relay still holds. When none is found the grant alone decides, as before the check.
   */
  async function currentGrant(session: Session): Promise<FoundGrant> {
    const { agent, now } = session;
    let found: FoundGrant | undefined;
    let list: Awaited<ReturnType<SubmittersCache['get']>>;
    try {
      [found, list] = await custody.withAgentKey(agent.agentKeyId, (signer) =>
        Promise.all([grants.get(agent, signer, now), submitters.get(agent, signer, now)])
      );
    } catch {
      throw new ToolError('grant_not_found', 'the agent grant could not be read');
    }
    if (list !== undefined && !list.submitters.includes(agent.agentPubkey)) {
      throw new ToolError(
        'grant_revoked',
        "The user revoked this agent's access to their qus.me drafts. Nothing was submitted. " +
          'Tell the user; this agent must be authorized again in qus.me before it can draft.'
      );
    }
    if (found === undefined) {
      throw new ToolError(
        'grant_not_found',
        "no grant for this agent was found on the queue's storage relays"
      );
    }
    const { expires_at } = found.grant;
    if (expires_at !== null && expires_at <= now) {
      throw new ToolError('grant_expired', 'the agent grant has expired', { expires_at });
    }
    // Going ahead on the grant alone: worth an operator's attention if it keeps happening.
    if (list === undefined) {
      options.notice?.({
        event: 'submitters_list_unavailable',
        agentPubkey: agent.agentPubkey,
        queuePubkey: agent.queuePubkey,
      });
    }
    return found;
  }

  async function quotaUsage(session: Session, grant: AgentGrant) {
    const { max_submissions, period } = grant.quota;
    const start = quotaPeriodStart(period, session.now);
    const used = await store.submissionReceipts.countSince(session.agent.agentKeyId, start);
    return {
      max_submissions,
      period,
      used,
      remaining: Math.max(0, max_submissions - used),
      period_start: start,
      resets_at: quotaPeriodEnd(period, session.now),
    };
  }

  /**
   * The destination the agent may draft for, with the field it names: in the grant, or any
   * destination when the grant allows new ones (7.4).
   */
  function resolveDestination(
    grant: AgentGrant,
    site: string,
    account: string,
    field?: string
  ): GrantDestination | undefined {
    const destination = findDestination(registry, grant, site, account);
    if (destination === undefined) {
      if (grant.allow_new_destinations) return undefined;
      throw new ToolError('destination_not_granted', 'this destination is not in the agent grant', {
        site,
        account,
      });
    }
    if (field !== undefined && !destination.fields.includes(field)) {
      throw new ToolError('field_not_granted', 'this field is not granted for the destination', {
        site,
        account,
        field,
        fields: destination.fields,
      });
    }
    return destination;
  }

  /** The field to validate against: the effective definition's, or the cap alone without one. */
  function fieldFor(site: string, override: JsonObject | null | undefined, field: string) {
    const effective = effectiveDefinition(registry, site, override);
    if (effective.kind === 'invalid') {
      throw new ToolError(
        'invalid_definition',
        'the destination override does not merge into a valid definition',
        {
          site,
          reason: effective.reason,
        }
      );
    }
    if (effective.kind === 'none') return { name: field, constraints: {} };
    const found = effective.definition.fields.find((f) => f.name === field);
    if (found !== undefined) return found;
    const unusable = effective.definition.unusableFields?.find((f) => f.name === field);
    if (unusable !== undefined) {
      throw new ToolError('field_unusable', 'this field needs a newer build of the service', {
        site,
        field,
        reason: unusable.reason,
      });
    }
    throw new ToolError('unknown_field', 'the site definition has no such field', {
      site,
      field,
      fields: effective.definition.fields.map((f) => f.name),
    });
  }

  async function createDraft(
    session: Session,
    args: { site: string; account: string; field: string; value: string; lenient?: boolean }
  ) {
    const { grant } = await currentGrant(session);
    const destination = resolveDestination(grant, args.site, args.account, args.field);
    const field = fieldFor(args.site, destination?.override, args.field);
    const validation: FieldValidation = validateFieldValue(args.value, field, {
      lenient: args.lenient === true,
    });
    if (!validation.accepted) {
      throw new ToolError('constraint_violation', 'the value breaks the field constraints', {
        violations: validation.violations.map((v) => ({ ...v })),
        validation: validationTagJson(validation),
        lenient_allowed: validation.violations.every((v) => v.constraint !== 'maxBytes'),
      });
    }
    const inbox = checkStorageRelays(grant.inbox);
    if (typeof inbox === 'string') {
      throw new ToolError('grant_unusable', `the grant's inbox relays are unusable: ${inbox}`);
    }
    if (grant.min_pow > maxPow) {
      throw new ToolError(
        'grant_unusable',
        `The user's grant asks for ${grant.min_pow} bits of proof of work (NIP-13 min_pow) on ` +
          `each submission, and this qus.me service mines at most ${maxPow} bits. Nothing was ` +
          `submitted. The user can lower min_pow for this agent in this agent's grant.`,
        { min_pow: grant.min_pow, max_pow: maxPow }
      );
    }
    const quota = await quotaUsage(session, grant);
    if (quota.used >= quota.max_submissions) {
      const retryAfter = Math.max(1, quota.resets_at - session.now);
      throw new ToolError(
        'quota_exhausted',
        `The user's grant allows ${quota.max_submissions} drafts per ${quota.period} and they ` +
          `are used up. Nothing was submitted. Retry after ${retryAfter} seconds.`,
        { ...quota, scope: 'grant', retry_after: retryAfter }
      );
    }

    const { now } = session;
    // The queue's own daily cap (its tier), counted from receipts, then the service-wide ceiling,
    // reserved exactly before publishing and given back if nothing is published.
    const day = utcDay(now);
    const queueUsed = await store.submissionReceipts.countByQueueSince(
      session.agent.queuePubkey,
      day.start
    );
    if (queueUsed >= session.tier.draftsPerDay) {
      throw new ToolError(
        'quota_exhausted',
        `This qus.me queue has reached its limit of ${session.tier.draftsPerDay} drafts per day. ` +
          `Nothing was submitted. Retry after ${day.retryAfter} seconds (00:00 UTC).`,
        {
          scope: 'queue',
          max_submissions: session.tier.draftsPerDay,
          period: 'day',
          used: queueUsed,
          resets_at: day.end,
          retry_after: day.retryAfter,
        }
      );
    }
    const reserved = await store.usageCounters.reserve(
      DRAFT_CEILING_SCOPE,
      day.start,
      limits.config.draftsPerDayCeiling,
      day.end + DAY
    );
    if (reserved === undefined) {
      throw new ToolError(
        'quota_exhausted',
        'The qus.me service has reached its limit of drafts for today across all users. ' +
          `Nothing was submitted. Retry after ${day.retryAfter} seconds (00:00 UTC).`,
        { scope: 'service', period: 'day', resets_at: day.end, retry_after: day.retryAfter }
      );
    }
    const release = () =>
      store.usageCounters.release(DRAFT_CEILING_SCOPE, day.start).catch(() => undefined);

    const expiration = now + grant.submission_expiration_days * DAY;
    const publishWrap = () =>
      custody.withAgentKey(session.agent.agentKeyId, async (agentSigner) => {
        const wrap = await buildSubmission(
          agentSigner,
          grant.inbox_pubkey,
          {
            site: args.site,
            // The grant's spelling when it names the destination, so the draft matches it.
            account: destination?.account ?? displayAccount(args.account),
            field: args.field,
            content: args.value,
            validation: validationTagJson(validation),
          },
          {
            now,
            submissionExpirationDays: grant.submission_expiration_days,
            pow: grant.min_pow,
            powMaxBytes,
          }
        );
        // A key of the connection's own for relays that only want someone authenticated (7.5).
        const connectionKey = generateSecretKey();
        try {
          const results = await publisher.publish({
            relays: inbox,
            event: wrap,
            auth: createLocalSigner(connectionKey),
            fallbackAuth: agentSigner,
          });
          return { wrapId: wrap.id, results };
        } finally {
          connectionKey.fill(0);
        }
      });
    let published: Awaited<ReturnType<typeof publishWrap>>;
    try {
      published = await publishWrap();
    } catch (error) {
      await release();
      if (error instanceof PowBudgetExceeded) {
        throw new ToolError(
          'pow_budget_exceeded',
          `The user's grant asks for ${error.difficulty} bits of proof of work, and mining them ` +
            `on this ${error.eventBytes}-byte submission ` +
            (error.hashes === 0 ? 'would take' : 'took') +
            ` more work than this qus.me service spends on one draft. Nothing was submitted. ` +
            (error.hashes === 0
              ? 'A shorter value needs less work.'
              : 'Mining is random; retrying usually succeeds.'),
          {
            min_pow: error.difficulty,
            max_pow: maxPow,
            wrap_bytes: error.eventBytes,
            budget_bytes: error.maxBytes,
            hashes: error.hashes,
          }
        );
      }
      throw error;
    }
    const { wrapId, results } = published;
    const accepted = results.filter((r) => r.ok).map((r) => r.relay);
    if (accepted.length === 0) {
      await release();
      throw new ToolError('publish_failed', 'no inbox relay accepted the submission', {
        relays: results.map((r) => ({ relay: r.relay, message: r.message })),
      });
    }
    const receipt = await store.submissionReceipts.create({
      giftWrapId: wrapId,
      agentKeyId: session.agent.agentKeyId,
      queuePubkey: session.agent.queuePubkey,
      createdAt: now,
      // Spec 8.5: listed for as long as the wrap can exist, counted for its whole quota period.
      expiresAt: Math.max(expiration, quota.resets_at),
    });
    return {
      gift_wrap_id: receipt.giftWrapId,
      created_at: receipt.createdAt,
      expires_at: expiration,
      relays: accepted,
      validation: validationTagJson(validation),
      pending_destination: destination === undefined,
    };
  }

  function buildServer(session: Session): McpServer {
    const server = new McpServer(
      { name: 'qus.me', version: options.version },
      {
        instructions:
          'Drafts for the user to review and post: list_destinations shows where you may draft, ' +
          'get_definition the constraints of a field, create_draft submits a value. Nothing is ' +
          'posted until the user inserts it.',
      }
    );

    server.registerTool(
      'list_registry',
      {
        title: 'List supported sites',
        description: 'All officially supported sites with their fields and constraints.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          sites: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              version: z.string(),
              match: z.array(z.string()),
              fields: z.array(
                z.object({ name: z.string(), label: z.string(), constraints: constraintsSchema })
              ),
            })
          ),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () => run(session, async () => ({ sites: registry.definitions.map(definitionSummary) }))
    );

    server.registerTool(
      'list_destinations',
      {
        title: 'List destinations',
        description:
          'Where you may draft for the user: the destinations in your grant with their fields and ' +
          'constraints, whether you may propose new destinations, and your remaining quota.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          destinations: z.array(
            z.object({
              site: z.string(),
              account: z.string(),
              fields: z.array(
                z.object({
                  name: z.string(),
                  label: z.string().optional(),
                  constraints: constraintsSchema.nullable(),
                })
              ),
            })
          ),
          allow_new_destinations: z.boolean(),
          submission_expiration_days: z.number().int(),
          expires_at: z.number().int().nullable(),
          quota: quotaSchema,
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () =>
        run(session, async () => {
          const { grant } = await currentGrant(session);
          const destinations = grant.destinations.map((d) => {
            const effective = effectiveDefinition(registry, d.site, d.override);
            const fields = d.fields.map((name) => {
              const f =
                effective.kind === 'definition'
                  ? effective.definition.fields.find((x) => x.name === name)
                  : undefined;
              return f === undefined ? { name, constraints: null } : fieldSummary(f);
            });
            return { site: d.site, account: d.account, fields };
          });
          return {
            destinations,
            allow_new_destinations: grant.allow_new_destinations,
            submission_expiration_days: grant.submission_expiration_days,
            expires_at: grant.expires_at,
            quota: await quotaUsage(session, grant),
          };
        })
    );

    server.registerTool(
      'get_definition',
      {
        title: 'Get a site definition',
        description:
          "The effective site definition for a destination: the registry's definition with the " +
          "user's override for that destination merged over it. null when none is known.",
        inputSchema: z.object({
          site: z.string().min(1).max(128),
          account: z.string().min(1).max(512),
        }),
        outputSchema: z.object({
          site: z.string(),
          account: z.string(),
          granted: z.boolean(),
          definition: z.record(z.string(), z.unknown()).nullable(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      ({ site, account }) =>
        run(session, async () => {
          const { grant } = await currentGrant(session);
          const destination = resolveDestination(grant, site, account);
          const effective = effectiveDefinition(registry, site, destination?.override);
          if (effective.kind === 'invalid') {
            throw new ToolError(
              'invalid_definition',
              'the destination override does not merge into a valid definition',
              {
                site,
                reason: effective.reason,
              }
            );
          }
          return {
            site,
            account: destination?.account ?? displayAccount(account),
            granted: destination !== undefined,
            definition: effective.kind === 'definition' ? { ...effective.definition } : null,
          };
        })
    );

    server.registerTool(
      'create_draft',
      {
        title: 'Create a draft',
        description:
          "Submits a value for one field of a destination as a draft in the user's queue. The " +
          "value is validated against the field's constraints first; with lenient set, a value " +
          "that breaks only the definition's constraints is accepted and marked, but the 32 KiB " +
          'limit always applies. Returns a receipt.',
        inputSchema: z.object({
          site: z.string().min(1).max(128),
          account: z.string().min(1).max(512),
          field: z.string().min(1).max(128),
          value: z.string(),
          lenient: z.boolean().optional(),
        }),
        outputSchema: receiptSchema.extend({
          relays: z.array(z.string()),
          validation: z.record(z.string(), z.unknown()),
          pending_destination: z.boolean(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      (args) => run(session, () => createDraft(session, args))
    );

    server.registerTool(
      'list_submissions',
      {
        title: 'List submissions',
        description:
          'Receipts for your submissions, newest first: gift wrap id and times only. The service ' +
          'keeps no content and cannot see what the user did with a draft.',
        inputSchema: z.object({
          limit: z.number().int().min(1).max(MAX_SUBMISSIONS_PAGE).optional(),
          cursor: z.string().max(100).optional(),
        }),
        outputSchema: z.object({
          submissions: z.array(receiptSchema),
          next_cursor: z.string().optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      ({ limit, cursor }) =>
        run(session, async () => {
          await currentGrant(session);
          const pageSize = limit ?? 50;
          const page = cursor === undefined ? {} : decodeCursor(cursor);
          const rows = await store.submissionReceipts.listByAgentKey(
            session.agent.agentKeyId,
            session.now,
            {
              ...page,
              limit: pageSize + 1,
            }
          );
          const shown = rows.slice(0, pageSize);
          const last = shown.at(-1);
          const out: Record<string, unknown> = {
            submissions: shown.map((r) => ({
              gift_wrap_id: r.giftWrapId,
              created_at: r.createdAt,
              expires_at: r.expiresAt,
            })),
          };
          if (rows.length > pageSize && last !== undefined) {
            out.next_cursor = encodeCursor(last.createdAt, last.giftWrapId);
          }
          return out;
        })
    );

    return server;
  }

  /** The `/mcp` handler; mount it after `requireBearer()`. */
  async function handle(c: Context<McpAuthEnv>): Promise<Response> {
    const agent = c.var.agent;
    const tier = await limits.tierFor(agent.queuePubkey);
    // The body is already capped by the app's size limit; read it once to see whether it calls a
    // tool, and hand the SDK a copy.
    const raw = c.req.raw;
    const hasBody = raw.method !== 'GET' && raw.method !== 'HEAD';
    const text = hasBody ? await raw.text() : '';
    const rate =
      (await limitedFor(limits, tier.mcpAgentRate, agent.agentPubkey)) ??
      (await limitedFor(limits, tier.mcpQueueRate, agent.queuePubkey));
    // Over the limit: a tool call gets a tool error the agent can read and act on; anything else
    // (initialize, tools/list) gets a plain 429.
    if (rate !== undefined && !callsTool(text)) {
      return tooManyRequests(
        c,
        rate,
        `too many requests from this agent or its queue; retry after ${rate} seconds`
      );
    }
    const session: Session = { agent, now: clock(), tier };
    if (rate !== undefined) session.rateLimited = rate;
    // 'auto' answers with one JSON body, since no tool emits anything before its result.
    const handler = createMcpHandler(() => buildServer(session), {
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    const request = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      ...(hasBody ? { body: text } : {}),
    });
    return handler.fetch(request);
  }

  return { handle, grants, submitters, registry };
}

/** Seconds to wait if `key` is over `rateClass`, or undefined. */
async function limitedFor(
  limits: ServiceLimits,
  rateClass: TierLimits['mcpAgentRate'],
  key: string
): Promise<number | undefined> {
  const decision = await limits.limiter.limit(rateClass, key);
  return decision.ok ? undefined : decision.retryAfter;
}

export type Mcp = ReturnType<typeof createMcp>;
