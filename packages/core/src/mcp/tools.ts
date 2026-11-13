/**
 * The qus.me MCP tools (spec 8.4), apart from where they run. The hosted service (`server.ts`)
 * and the local stdio server (`@qusme/mcp`, spec 8.6) register the same five tools with the same
 * schemas, validation and errors; each passes a {@link ToolSession} that says how it reads the
 * agent's grant, holds the agent key, counts and keeps receipts, and what proof of work it mines.
 *
 * - `list_registry`: the bundled registry snapshot;
 * - `list_destinations`, `get_definition`: the agent's grant, with effective definitions (10.2);
 * - `create_draft`: validate, check the grant and its quota, seal with the agent key, gift-wrap
 *   to the grant's inbox key, publish to its inbox relays and record a contentless receipt;
 * - `list_submissions`: those receipts.
 *
 * This module imports no store and no runtime: Web-standard APIs and `@qusme/nostr` only, so the
 * local server can bundle it without the service's database layer. The submitted value is held
 * only for the length of the call: it is never stored, logged or put in an error.
 */
import type { McpServer } from '@modelcontextprotocol/server';
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
  type Signer,
  type SiteDefinition,
  type SiteField,
  sameAccount,
  validateFieldValue,
  validationTagJson,
} from '@qusme/nostr';
import { generateSecretKey } from 'nostr-tools/pure';
import { z } from 'zod';
import { checkStorageRelays } from '../oauth/relayReader.ts';
import { effectiveDefinition, type Registry } from './registry.ts';
import type { RelayPublisher } from './relayPublisher.ts';

const DAY = 86_400;

/** Most receipts `list_submissions` returns per page. */
export const MAX_SUBMISSIONS_PAGE = 100;

/** What the MCP server tells every client it serves. */
export const QUSME_INSTRUCTIONS =
  'Drafts for the user to review and post: list_destinations shows where you may draft, ' +
  'get_definition the constraints of a field, create_draft submits a value. Nothing is ' +
  'posted until the user inserts it.';

/** Error codes in a failed tool result's structured content. */
export type McpToolErrorCode =
  | 'approval_required'
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

/** A refusal a tool returns as an MCP tool error naming `code` (8.4). */
export class ToolError extends Error {
  readonly code: McpToolErrorCode;
  readonly details: JsonObject;
  constructor(code: McpToolErrorCode, message: string, details: JsonObject = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** A receipt as a session keeps it: no content (8.4, 8.5). */
export interface ToolReceipt {
  giftWrapId: string;
  createdAt: number;
  /** When the receipt may be forgotten: no earlier than the wrap's expiration or its quota period. */
  expiresAt: number;
}

/**
 * Where the tools run. The hosted service makes one per request from its database, agent key
 * custody and limits; the local server makes one per call from its files.
 */
export interface ToolSession {
  /** Unix seconds, fixed for the call. */
  now: number;
  /** Seconds to wait when this request is over a rate limit; every tool then refuses. */
  rateLimited?: number;
  /**
   * The agent's current grant (7.4), checked against the submitters list (7.3) and its expiry, or
   * a {@link ToolError} (`grant_not_found`, `grant_revoked`, `grant_expired`, `approval_required`).
   */
  currentGrant(): Promise<AgentGrant>;
  /** Receipts this agent recorded at or after `start`, for the grant's quota. */
  countSince(start: number): Promise<number>;
  /**
   * Checks and takes any caps beyond the grant's quota before publishing, throwing a
   * {@link ToolError} when one is used up; returns what gives the reservation back if nothing is
   * published. The local server has none.
   */
  reserve?(): Promise<() => Promise<void>>;
  /** Runs `fn` with the agent key's signer, for the length of `fn` only. */
  withAgentSigner<T>(fn: (signer: Signer) => Promise<T>): Promise<T>;
  publisher: RelayPublisher;
  recordReceipt(receipt: ToolReceipt): Promise<void>;
  /** Unexpired receipts, newest first, before the cursor when one is given. */
  listReceipts(page: { before?: number; beforeId?: string; limit: number }): Promise<ToolReceipt[]>;
  /** Highest grant `min_pow` this server mines; a grant asking more is refused. */
  maxPow: number;
  /** Most bytes of serialized wrap hashed while mining; unbounded when absent. */
  powMaxBytes?: number;
  /** Who does the mining, in `grant_unusable`'s message: "this qus.me service". */
  minerName: string;
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
  session: ToolSession,
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

/** The message every tool returns once the submitters list no longer names the agent. */
export const GRANT_REVOKED_MESSAGE =
  "The user revoked this agent's access to their qus.me drafts. Nothing was submitted. " +
  'Tell the user; this agent must be authorized again in qus.me before it can draft.';

/**
 * The checks every grant read goes through (8.4): a submitters list that was found and no longer
 * names the agent revokes it, whatever grant a relay still holds; no grant, or one whose
 * `expires_at` has passed, refuses. Returns the grant, or throws a {@link ToolError}.
 */
export function checkGrant<T extends { grant: AgentGrant }>(
  found: T | undefined,
  submitters: readonly string[] | undefined,
  agentPubkey: string,
  now: number
): T {
  if (submitters !== undefined && !submitters.includes(agentPubkey)) {
    throw new ToolError('grant_revoked', GRANT_REVOKED_MESSAGE);
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

async function quotaUsage(session: ToolSession, grant: AgentGrant) {
  const { max_submissions, period } = grant.quota;
  const start = quotaPeriodStart(period, session.now);
  const used = await session.countSince(start);
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
  registry: Registry,
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
function fieldFor(
  registry: Registry,
  site: string,
  override: JsonObject | null | undefined,
  field: string
) {
  const effective = effectiveDefinition(registry, site, override);
  if (effective.kind === 'invalid') {
    throw new ToolError(
      'invalid_definition',
      'the destination override does not merge into a valid definition',
      { site, reason: effective.reason }
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
  registry: Registry,
  session: ToolSession,
  args: { site: string; account: string; field: string; value: string; lenient?: boolean }
) {
  const grant = await session.currentGrant();
  const destination = resolveDestination(registry, grant, args.site, args.account, args.field);
  const field = fieldFor(registry, args.site, destination?.override, args.field);
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
  const { maxPow } = session;
  if (grant.min_pow > maxPow) {
    throw new ToolError(
      'grant_unusable',
      `The user's grant asks for ${grant.min_pow} bits of proof of work (NIP-13 min_pow) on ` +
        `each submission, and ${session.minerName} mines at most ${maxPow} bits. Nothing was ` +
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
  const release = (await session.reserve?.()) ?? (async () => undefined);

  const { now } = session;
  const expiration = now + grant.submission_expiration_days * DAY;
  const publishWrap = () =>
    session.withAgentSigner(async (agentSigner) => {
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
          ...(session.powMaxBytes !== undefined && { powMaxBytes: session.powMaxBytes }),
        }
      );
      // A key of the connection's own for relays that only want someone authenticated (7.5).
      const connectionKey = generateSecretKey();
      try {
        const results = await session.publisher.publish({
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
          ` more work than ${session.minerName} spends on one draft. Nothing was submitted. ` +
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
  await session.recordReceipt({
    giftWrapId: wrapId,
    createdAt: now,
    // Spec 8.5: listed for as long as the wrap can exist, counted for its whole quota period.
    expiresAt: Math.max(expiration, quota.resets_at),
  });
  return {
    gift_wrap_id: wrapId,
    created_at: now,
    expires_at: expiration,
    relays: accepted,
    validation: validationTagJson(validation),
    pending_destination: destination === undefined,
  };
}

/**
 * Registers the five tools on `server`, acting for `session`. `session` is a function so a server
 * that lives for many calls (the local stdio server) builds a fresh one, with its own clock, for
 * each call; the hosted service passes one made for its request.
 */
export function registerQusmeTools(
  server: McpServer,
  registry: Registry,
  sessionFor: () => ToolSession | Promise<ToolSession>
): void {
  const withSession =
    <A>(body: (session: ToolSession, args: A) => Promise<Record<string, unknown>>) =>
    async (args: A): Promise<ToolResult> => {
      let session: ToolSession;
      try {
        session = await sessionFor();
      } catch (error) {
        return failed(
          error instanceof ToolError ? error : new ToolError('internal_error', 'the call failed')
        );
      }
      return run(session, () => body(session, args));
    };

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
    withSession(async () => ({ sites: registry.definitions.map(definitionSummary) }))
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
    withSession(async (session) => {
      const grant = await session.currentGrant();
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
    withSession(async (session, { site, account }: { site: string; account: string }) => {
      const grant = await session.currentGrant();
      const destination = resolveDestination(registry, grant, site, account);
      const effective = effectiveDefinition(registry, site, destination?.override);
      if (effective.kind === 'invalid') {
        throw new ToolError(
          'invalid_definition',
          'the destination override does not merge into a valid definition',
          { site, reason: effective.reason }
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
    withSession(
      (
        session,
        args: { site: string; account: string; field: string; value: string; lenient?: boolean }
      ) => createDraft(registry, session, args)
    )
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
    withSession(async (session, { limit, cursor }: { limit?: number; cursor?: string }) => {
      await session.currentGrant();
      const pageSize = limit ?? 50;
      const page = cursor === undefined ? {} : decodeCursor(cursor);
      const rows = await session.listReceipts({ ...page, limit: pageSize + 1 });
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
}
