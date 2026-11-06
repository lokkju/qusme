/**
 * The background's side of arming and inserting (spec 11.5 steps 5 and 6). Both entry points,
 * the popup's Insert button and the context menu item, come here: read the armed draft, work out
 * its field from the effective definition, run the insertion script in the tab, and on success
 * record the insertion and disarm. An insertion that waits for the user (a click into the field,
 * or a paste) finishes when the page sends {@link PageDone}.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { INJECTION_STRATEGIES, type InjectionStrategy, type Insertion } from '@qusme/nostr';
import { type CachedDraft, readDraftCache } from '../sync/state.ts';
import {
  disarm,
  type InsertionState,
  readArmed,
  readInsertionState,
  writeInsertionState,
} from './armed.ts';
import { definitionForDraft, type SiteDefinitionSource } from './definitions.ts';
import {
  type InsertMethod,
  PAGE_DONE_MESSAGE,
  type PageDone,
  type PageFailure,
  type PageInserted,
  type PageInsertRequest,
  type PageOutcome,
} from './protocol.ts';
import { type RecordDeps, recordInsertion } from './record.ts';

/** Runs the insertion script in a tab: injects it, then calls its `insert`. */
export interface PageRunner {
  insert(
    target: { tabId: number; frameId?: number },
    request: PageInsertRequest
  ): Promise<PageOutcome>;
}

export interface InsertionDeps extends RecordDeps {
  definitions: SiteDefinitionSource;
  page: PageRunner;
  /** A fresh token per insertion; defaults to 16 random bytes in hex. */
  token?: () => string;
}

export type InsertResponse =
  | {
      state: 'inserted';
      strategy: InjectionStrategy;
      /** False when the `inserted` tag could not be published yet; `message` says why. */
      recorded: boolean;
      message?: string;
    }
  | { state: 'waiting'; reason: 'focus' | 'paste'; clipboardWritten?: boolean }
  | { state: 'failed'; reason: PageFailure | 'injection'; message?: string }
  | { state: 'not_armed' }
  | { state: 'locked' };

const MAX_URL = 2048;
const MAX_NAME = 256;

/** Validates a {@link PageDone} from a content script; undefined if it is anything else. */
export function readPageDone(message: unknown): PageDone | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.type !== PAGE_DONE_MESSAGE || typeof m.token !== 'string') return undefined;
  const o = m.outcome as Record<string, unknown> | null | undefined;
  if (typeof o !== 'object' || o === null) return undefined;
  if (o.state === 'failed' && typeof o.reason === 'string') {
    const tried = Array.isArray(o.tried) ? o.tried.filter(isStrategy) : [];
    return {
      type: PAGE_DONE_MESSAGE,
      token: m.token,
      outcome: { state: 'failed', reason: o.reason as PageFailure, tried },
    };
  }
  if (
    o.state === 'inserted' &&
    isStrategy(o.strategy) &&
    typeof o.url === 'string' &&
    typeof o.accessibleName === 'string' &&
    typeof o.detectedAccount === 'string' &&
    (o.resolution === 'focused' || o.resolution === 'locator' || o.resolution === 'focus_placement')
  ) {
    return {
      type: PAGE_DONE_MESSAGE,
      token: m.token,
      outcome: {
        state: 'inserted',
        strategy: o.strategy,
        resolution: o.resolution,
        url: o.url,
        accessibleName: o.accessibleName,
        detectedAccount: o.detectedAccount,
      },
    };
  }
  return undefined;
}

function isStrategy(value: unknown): value is InjectionStrategy {
  return typeof value === 'string' && (INJECTION_STRATEGIES as readonly string[]).includes(value);
}

export class InsertionService {
  readonly deps: InsertionDeps;

  constructor(deps: InsertionDeps) {
    this.deps = deps;
  }

  #now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Inserts the armed draft into the tab (step 5), or `draft` when given: the picker inserts the
   * draft the user chose there without arming it, so a failure leaves the armed draft as it was.
   */
  async insert(input: {
    tabId: number;
    frameId?: number;
    method: InsertMethod;
    draft?: Pick<CachedDraft, 'd' | 'site' | 'account' | 'field' | 'destination' | 'content'>;
  }): Promise<InsertResponse> {
    const { store } = this.deps;
    if ((await store.status()).state !== 'unlocked') return { state: 'locked' };
    const armed = input.draft ?? (await readArmed(store.session));
    if (armed === undefined) return { state: 'not_armed' };
    const destinations = (await readDraftCache(store.session))?.destinations ?? [];
    const { definition, field } = definitionForDraft(this.deps.definitions, armed, destinations);
    const token = this.deps.token?.() ?? bytesToHex(randomBytes(16));
    const request: PageInsertRequest = {
      token,
      value: armed.content,
      method: input.method,
      clipboardFallback: input.method === 'extension_popup',
    };
    if (field !== undefined) request.field = { locators: field.locators, inject: field.inject };
    if (definition?.account !== undefined) request.account = definition.account;

    await this.#setPending({
      token,
      tabId: input.tabId,
      d: armed.d,
      method: input.method,
      startedAt: this.#now(),
    });
    let outcome: PageOutcome;
    try {
      const target =
        input.frameId === undefined
          ? { tabId: input.tabId }
          : { tabId: input.tabId, frameId: input.frameId };
      outcome = await this.deps.page.insert(target, request);
    } catch (error) {
      await this.#clearPending(token);
      return {
        state: 'failed',
        reason: 'injection',
        message: `qus.me could not run in this page: ${(error as Error)?.message ?? String(error)}`,
      };
    }
    if (outcome.state === 'waiting') {
      const waiting: InsertResponse = { state: 'waiting', reason: outcome.reason };
      if (outcome.clipboardWritten !== undefined)
        waiting.clipboardWritten = outcome.clipboardWritten;
      return waiting;
    }
    await this.#clearPending(token);
    if (outcome.state === 'failed') return { state: 'failed', reason: outcome.reason };
    return this.#finish(armed.d, input.method, outcome);
  }

  /**
   * The final outcome from a page that answered `waiting`. Ignored (undefined) unless it carries
   * the pending token and comes from the tab the insertion ran in.
   */
  async pageDone(
    senderTabId: number | undefined,
    done: PageDone
  ): Promise<InsertResponse | undefined> {
    const state = await readInsertionState(this.deps.store.session);
    const pending = state.pending;
    if (pending === undefined || pending.token !== done.token || pending.tabId !== senderTabId) {
      return undefined;
    }
    await this.#clearPending(done.token);
    if (done.outcome.state === 'failed') return { state: 'failed', reason: done.outcome.reason };
    return this.#finish(pending.d, pending.method, done.outcome);
  }

  /** Tries again to record insertions that could not be published; returns how many remain. */
  async retryUnrecorded(): Promise<{ remaining: number; messages: string[] }> {
    const state = await readInsertionState(this.deps.store.session);
    const remaining: InsertionState['unrecorded'] = [];
    const messages: string[] = [];
    for (const entry of state.unrecorded) {
      const result = await recordInsertion(this.deps, entry.d, entry.insertion);
      if (result.state === 'retry') {
        remaining.push(entry);
        messages.push(result.message);
      } else if (result.state === 'gone') {
        messages.push(result.message);
      }
    }
    const latest = await readInsertionState(this.deps.store.session);
    await writeInsertionState(this.deps.store.session, { ...latest, unrecorded: remaining });
    return { remaining: remaining.length, messages };
  }

  /** Step 6: disarm, then append the `inserted` tag, archive and republish. */
  async #finish(d: string, method: InsertMethod, outcome: PageInserted): Promise<InsertResponse> {
    const insertion: Insertion = {
      at: this.#now(),
      url: outcome.url.slice(0, MAX_URL),
      strategy: outcome.strategy,
      method,
      accessibleName: outcome.accessibleName.slice(0, MAX_NAME),
      detectedAccount: outcome.detectedAccount.slice(0, MAX_NAME),
    };
    // The draft is in the page now: disarm first, so a second click cannot insert it twice. Only
    // this draft: one inserted from the picker leaves another armed draft armed.
    await disarm(this.deps.store.session, d);
    const result = await recordInsertion(this.deps, d, insertion);
    if (result.state === 'recorded')
      return { state: 'inserted', strategy: outcome.strategy, recorded: true };
    if (result.state === 'retry') {
      const state = await readInsertionState(this.deps.store.session);
      await writeInsertionState(this.deps.store.session, {
        ...state,
        unrecorded: [...state.unrecorded, { d, insertion }],
      });
    }
    return {
      state: 'inserted',
      strategy: outcome.strategy,
      recorded: false,
      message: result.message,
    };
  }

  async #setPending(pending: NonNullable<InsertionState['pending']>): Promise<void> {
    const state = await readInsertionState(this.deps.store.session);
    await writeInsertionState(this.deps.store.session, { ...state, pending });
  }

  async #clearPending(token: string): Promise<void> {
    const state = await readInsertionState(this.deps.store.session);
    if (state.pending?.token !== token) return;
    const { pending: _, ...rest } = state;
    await writeInsertionState(this.deps.store.session, rest);
  }
}
