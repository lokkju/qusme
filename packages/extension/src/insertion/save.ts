/**
 * Saving a field as a draft (spec 11.7), the background's half: the reverse of insertion. The
 * context menu's "Save to qus.me" grants activeTab like insertion's item does; the background
 * resolves the page's destination as insertion matches drafts to a page (the effective
 * definitions' `match` patterns, then the detected account, 11.5 steps 2 and 3), has the page
 * script read the field through the definition's field locators, and publishes a new draft wrap
 * to every storage relay: `status` `active`, no `source` (so the popup attributes it to "You"),
 * and a `validation` tag against the field's constraints, as an edit computes it (11.5). The page
 * then shows a short notice; never the text.
 *
 * A page that matches none of the user's destinations, or several the detected account can't
 * tell apart, is refused with a notice rather than guessed at, and so is a focused field the
 * definition's locators don't find.
 */
import {
  buildDraftWrap,
  type Destination,
  displayAccount,
  FIELD_VALUE_MAX_BYTES,
  type FieldValue,
  newDraftId,
  type SiteAccount,
  type SiteDefinition,
  sameAccount,
  utf8Length,
  validateFieldValue,
  validationTagJson,
} from '@qusme/nostr';
import { publishOrThrow, type QueueDeps, withQueue } from '../agents/queue.ts';
import { SetupError } from '../setup/deps.ts';
import { type CachedDraft, readDraftCache, writeDraftCache } from '../sync/state.ts';
import { effectiveDefinition, type SiteDefinitionSource } from './definitions.ts';
import { matchesPattern } from './matching.ts';
import type { NoticeKind, PageReadRequest, PageReadResult } from './protocol.ts';

type Target = { tabId: number; frameId?: number };

/** What saving needs from the page: account detection, reading the field and the notice. */
export interface SavePage {
  detectAccounts(tabId: number, locators: readonly SiteAccount[]): Promise<(string | undefined)[]>;
  readField(target: Target, request: PageReadRequest): Promise<PageReadResult>;
  notice(target: Target, text: string, kind: NoticeKind): Promise<void>;
}

export interface SaveDeps extends QueueDeps {
  definitions: SiteDefinitionSource;
  page: SavePage;
  /** The new draft's `d`; defaults to {@link newDraftId}. */
  draftId?: () => string;
}

export type SaveRefusal =
  /** The page matches no destination, though a registry site's definition matches it. */
  | 'no_destination'
  /** No definition the device holds matches the page. */
  | 'no_definition'
  /** Several destinations match and detection could not pick one. */
  | 'ambiguous'
  /** The page is signed in as an account no matching destination has. */
  | 'other_account'
  /** The focused field is not one of the definition's fields. */
  | 'no_field'
  /** Nothing editable is focused and no field locator finds one. */
  | 'no_target'
  | 'empty'
  | 'too_long';

export type SaveResponse =
  | { state: 'saved'; d: string; destination: string; field: string; over: boolean }
  | { state: 'refused'; reason: SaveRefusal; account?: string }
  | { state: 'locked' }
  | { state: 'setup' }
  | { state: 'failed'; message: string };

/** The notice each outcome shows in the page; none of them carries the field's text. */
export function saveNotice(response: SaveResponse): { text: string; kind: NoticeKind } {
  const failure = (text: string) => ({ text, kind: 'failure' as const });
  switch (response.state) {
    case 'saved':
      return response.over
        ? failure("qus.me: saved. It's over this field's limit; edit it before posting.")
        : { text: 'qus.me: saved.', kind: 'success' };
    case 'locked':
      return failure('qus.me is locked. Open qus.me to unlock it, then save again.');
    case 'setup':
      return failure('qus.me has no queue in this browser yet. Open qus.me to set one up.');
    case 'failed':
      return failure(`qus.me couldn't save the draft: ${response.message}`);
    case 'refused':
      switch (response.reason) {
        case 'no_destination':
          return failure(
            "qus.me: this page isn't one of your destinations. Add it in qus.me, then save again."
          );
        case 'no_definition':
          return failure("qus.me doesn't know this site's fields, so it can't save from here.");
        case 'ambiguous':
          return failure(
            "qus.me couldn't tell which of your accounts this page is signed in to. Nothing was saved."
          );
        case 'other_account':
          return failure(
            `qus.me: this page is signed in as @${response.account ?? '?'}, which isn't one of your destinations.`
          );
        case 'no_field':
          return failure(
            "qus.me: this isn't a field qus.me knows on this site. Click into the post box and save again."
          );
        case 'no_target':
          return failure('qus.me: click into the post box, then save again.');
        case 'empty':
          return failure('qus.me: the field is empty. Nothing was saved.');
        case 'too_long':
          return failure(
            `qus.me: a draft holds at most ${FIELD_VALUE_MAX_BYTES} bytes, and this field has more.`
          );
      }
  }
}

/**
 * The destination the page is for: the confirmed destinations whose effective definition matches
 * `url`, narrowed by the account detected on the page where their site has a locator. Exactly one
 * must remain.
 */
async function resolveDestination(
  deps: SaveDeps,
  tabId: number,
  url: string,
  destinations: readonly Destination[]
): Promise<
  | { state: 'resolved'; destination: Destination; definition: SiteDefinition }
  | { state: 'refused'; reason: SaveRefusal; account?: string }
> {
  const candidates: { destination: Destination; definition: SiteDefinition }[] = [];
  for (const destination of destinations) {
    if (destination.status !== 'confirmed') continue;
    const definition = effectiveDefinition(
      deps.definitions,
      destination.site,
      destination.override
    );
    if (definition?.match.some((p) => matchesPattern(p, url))) {
      candidates.push({ destination, definition });
    }
  }
  if (candidates.length === 0) {
    const known = deps.definitions.sites().some((json) => {
      if (typeof json.id !== 'string') return false;
      const definition = effectiveDefinition(deps.definitions, json.id, null);
      return definition?.match.some((p) => matchesPattern(p, url)) === true;
    });
    return { state: 'refused', reason: known ? 'no_destination' : 'no_definition' };
  }

  // One locator per site, run in the page's main frame, as the popup and picker do (step 2).
  const locators = new Map<string, SiteAccount>();
  for (const { destination, definition } of candidates) {
    if (definition.account !== undefined && !locators.has(destination.site)) {
      locators.set(destination.site, definition.account);
    }
  }
  const detected: Record<string, string> = {};
  if (locators.size > 0) {
    const sites = [...locators.keys()];
    const results = await deps.page
      .detectAccounts(tabId, [...locators.values()])
      .catch(() => [] as (string | undefined)[]);
    for (const [i, site] of sites.entries()) {
      const account = results[i];
      if (typeof account === 'string' && account !== '') detected[site] = account;
    }
  }
  const remaining = candidates.filter(({ destination, definition }) => {
    const account = detected[destination.site];
    return (
      account === undefined ||
      sameAccount(destination.site, account, destination.account, definition)
    );
  });
  const [only] = remaining;
  if (remaining.length === 1 && only !== undefined) return { state: 'resolved', ...only };
  if (remaining.length > 1) return { state: 'refused', reason: 'ambiguous' };
  const account = Object.values(detected)[0];
  return account === undefined
    ? { state: 'refused', reason: 'no_destination' }
    : { state: 'refused', reason: 'other_account', account: displayAccount(account) };
}

export class SaveService {
  readonly deps: SaveDeps;

  constructor(deps: SaveDeps) {
    this.deps = deps;
  }

  /** Saves the tab's field as a draft and shows the outcome in the page. */
  async save(input: { tabId: number; frameId?: number; url: string }): Promise<SaveResponse> {
    const target: Target =
      input.frameId === undefined
        ? { tabId: input.tabId }
        : { tabId: input.tabId, frameId: input.frameId };
    let response: SaveResponse;
    try {
      response = await this.#save(input.tabId, target, input.url);
    } catch (error) {
      const message =
        error instanceof SetupError ? error.message : String((error as Error)?.message ?? error);
      response = { state: 'failed', message };
    }
    const { text, kind } = saveNotice(response);
    await this.deps.page.notice(target, text, kind).catch(() => undefined);
    return response;
  }

  async #save(tabId: number, target: Target, url: string): Promise<SaveResponse> {
    const { store } = this.deps;
    const status = await store.status();
    if (status.state === 'empty') return { state: 'setup' };
    if (status.state !== 'unlocked') return { state: 'locked' };

    const cache = await readDraftCache(store.session);
    const resolved = await resolveDestination(this.deps, tabId, url, cache?.destinations ?? []);
    if (resolved.state === 'refused') return resolved;
    const { destination, definition } = resolved;

    const read = await this.deps.page.readField(target, {
      fields: definition.fields.map((f) => ({ name: f.name, locators: f.locators })),
    });
    if (read.state !== 'read') return { state: 'refused', reason: read.state };
    const content = read.value;
    if (content.trim() === '') return { state: 'refused', reason: 'empty' };
    if (utf8Length(content) > FIELD_VALUE_MAX_BYTES)
      return { state: 'refused', reason: 'too_long' };

    const field = definition.fields.find((f) => f.name === read.field);
    let validation: FieldValue['validation'];
    let over = false;
    if (field !== undefined) {
      try {
        const result = validateFieldValue(content, field);
        validation = validationTagJson(result);
        over = !result.ok;
      } catch {
        // A constraint this build does not know: leave the tag out instead of guessing, as an
        // edit does.
      }
    }

    const d = this.deps.draftId?.() ?? newDraftId();
    const { pubkey, value, createdAt } = await withQueue(this.deps, async (session) => {
      const value: FieldValue = {
        createdAt: session.now,
        site: destination.site,
        account: destination.account,
        field: read.field,
        destination: destination.id,
        status: 'active',
        inserted: [],
        content,
        reserved: [],
      };
      if (validation !== undefined) value.validation = validation;
      const event = await buildDraftWrap(session.queue, {
        d,
        draft: { type: 'field_value', value },
        createdAt: session.now,
      });
      await publishOrThrow(session, event, 'draft');
      return { pubkey: session.pubkey, value, createdAt: event.created_at };
    });
    await this.#cache(pubkey, d, value, createdAt);
    return { state: 'saved', d, destination: destination.id, field: read.field, over };
  }

  /** Adds the new draft to this device's session cache, so the list and the badge follow at once. */
  async #cache(pubkey: string, d: string, value: FieldValue, updatedAt: number): Promise<void> {
    const { session } = this.deps.store;
    const cache = await readDraftCache(session);
    if (cache === undefined || cache.queuePubkey !== pubkey) return;
    const entry: CachedDraft = {
      d,
      updatedAt,
      site: value.site,
      account: value.account,
      field: value.field,
      status: value.status,
      content: value.content,
    };
    if (value.destination !== undefined) entry.destination = value.destination;
    await writeDraftCache(session, {
      ...cache,
      drafts: [...cache.drafts.filter((draft) => draft.d !== d), entry],
    });
  }
}

/**
 * The context menu's click on "Save to qus.me": the tab the click granted activeTab on, the frame
 * the field is in, and the tab's URL (readable under that grant), else the menu's `pageUrl`. Pages
 * other than http and https are left alone. Undefined when nothing ran.
 */
export function saveFromMenu(
  saver: Pick<SaveService, 'save'>,
  info: { frameId?: number; pageUrl?: string },
  tab: { id?: number; url?: string } | undefined
): Promise<SaveResponse> | undefined {
  if (tab?.id === undefined) return undefined;
  const url = tab.url ?? info.pageUrl;
  if (url === undefined || !/^https?:/.test(url)) return undefined;
  return saver.save({
    tabId: tab.id,
    ...(info.frameId !== undefined && { frameId: info.frameId }),
    url,
  });
}
