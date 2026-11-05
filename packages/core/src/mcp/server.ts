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
 * relays as the agent key. Failures are tool results with `isError` and structured content naming
 * the error, so a client can tell a constraint violation from an exhausted quota. The submitted
 * value is held only for the length of the call: it is never stored, logged or put in an error.
 */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  type AgentGrant,
  buildSubmission,
  createLocalSigner,
  type FieldValidation,
  type GrantDestination,
  type JsonObject,
  quotaPeriodEnd,
  quotaPeriodStart,
  type SiteDefinition,
  type SiteField,
  validateFieldValue,
  validationTagJson,
} from '@qusme/nostr';
import { createStore, type QusmeDb, type Store } from '@qusme/store-sql';
import type { Context } from 'hono';
import { generateSecretKey } from 'nostr-tools/pure';
import { z } from 'zod';
import type { AgentKeyRing } from '../agentKeyRing.ts';
import { type AgentKeyCustody, createAgentKeyCustody } from '../agentKeys.ts';
import { checkStorageRelays, type RelayReader } from '../oauth/relayReader.ts';
import type { McpAuthEnv } from '../oauth/server.ts';
import { createGrantCache, type FoundGrant, type GrantCache } from './grants.ts';
import {
  effectiveDefinition,
  loadRegistry,
  type Registry,
  type RegistrySnapshot,
} from './registry.ts';
import { createWebSocketRelayPublisher, type RelayPublisher } from './relayPublisher.ts';

const DAY = 86_400;

/** Most NIP-13 difficulty the service mines by default: about 16 million hashes. */
export const DEFAULT_MAX_POW = 24;
/** Seconds a grant read from the relays is reused by default. */
export const DEFAULT_GRANT_CACHE_SECONDS = 30;
/** Largest request body: a 32 KiB value, JSON-escaped, with room for the envelope. */
const MAX_REQUEST_BYTES = 256 * 1024;
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
  /** Seconds a grant is reused; 0 reads the relays on every call. */
  grantCacheSeconds?: number;
  /** Highest grant `min_pow` the service mines; a grant asking more is refused. */
  maxPow?: number;
}

export interface McpOptions extends McpOverrides {
  db: QusmeDb;
  agentKeys: AgentKeyRing;
  relayReader: RelayReader;
  version: string;
}

/** Error codes in a failed tool result's structured content. */
export type McpToolErrorCode =
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

/** Runs a tool body, turning a ToolError into its result and anything else into a bare one. */
async function run(body: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
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

function findDestination(grant: AgentGrant, site: string, account: string) {
  return grant.destinations.find((d) => d.site === site && d.account === account);
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
}

export function createMcp(options: McpOptions) {
  const store: Store = createStore(options.db);
  const custody: AgentKeyCustody = createAgentKeyCustody(store, options.agentKeys);
  const registry: Registry = loadRegistry(options.registry);
  const publisher = options.relayPublisher ?? createWebSocketRelayPublisher();
  const grants: GrantCache = createGrantCache({
    relayReader: options.relayReader,
    ttlSeconds: options.grantCacheSeconds ?? DEFAULT_GRANT_CACHE_SECONDS,
  });
  const maxPow = options.maxPow ?? DEFAULT_MAX_POW;
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));

  /** The current grant or a ToolError; read as the agent key (7.4). */
  async function currentGrant(session: Session): Promise<FoundGrant> {
    const { agent, now } = session;
    let found: FoundGrant | undefined;
    try {
      found = await custody.withAgentKey(agent.agentKeyId, (signer) =>
        grants.get(agent, signer, now)
      );
    } catch {
      throw new ToolError('grant_not_found', 'the agent grant could not be read');
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
    const destination = findDestination(grant, site, account);
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
        `the grant asks for more proof of work than ${maxPow} bits`,
        {
          min_pow: grant.min_pow,
          max_pow: maxPow,
        }
      );
    }
    const quota = await quotaUsage(session, grant);
    if (quota.used >= quota.max_submissions) {
      throw new ToolError('quota_exhausted', 'the grant quota for this period is used up', quota);
    }

    const { now } = session;
    const expiration = now + grant.submission_expiration_days * DAY;
    const { wrapId, results } = await custody.withAgentKey(
      session.agent.agentKeyId,
      async (agentSigner) => {
        const wrap = await buildSubmission(
          agentSigner,
          grant.inbox_pubkey,
          {
            site: args.site,
            account: args.account,
            field: args.field,
            content: args.value,
            validation: validationTagJson(validation),
          },
          { now, submissionExpirationDays: grant.submission_expiration_days, pow: grant.min_pow }
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
      }
    );
    const accepted = results.filter((r) => r.ok).map((r) => r.relay);
    if (accepted.length === 0) {
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
      () => run(async () => ({ sites: registry.definitions.map(definitionSummary) }))
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
        run(async () => {
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
        run(async () => {
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
            account,
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
      (args) => run(() => createDraft(session, args))
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
        run(async () => {
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
    const session: Session = { agent: c.var.agent, now: clock() };
    // 'auto' answers with one JSON body, since no tool emits anything before its result.
    const handler = createMcpHandler(() => buildServer(session), {
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    return handler.fetch(c.req.raw);
  }

  return { handle, grants, registry };
}

export type Mcp = ReturnType<typeof createMcp>;
