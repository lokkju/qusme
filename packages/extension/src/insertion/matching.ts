/**
 * Which drafts belong on the current page (spec 11.5 step 3) and where the context menu appears
 * (`documentUrlPatterns`, step 5). Both come from the effective definitions' `match` patterns.
 */
import { type Destination, type SiteAccount, sameAccount } from '@qusme/nostr';
import type { CachedDraft } from '../sync/state.ts';
import {
  definitionForDraft,
  effectiveDefinition,
  type SiteDefinitionSource,
} from './definitions.ts';

const PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/;
/** A pattern both browsers accept in `documentUrlPatterns`: no port, no userinfo. */
const MENU_PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*:@]+)\/.*$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `url` matches a WebExtension match pattern (`https://x.com/*`, `*://*.example.com/a*`):
 * `*` scheme is http or https, `*.host` takes the host and its subdomains, `*` in the path is any
 * run of characters, and the path is compared with the query included. Ports are ignored.
 */
export function matchesPattern(pattern: string, url: string): boolean {
  const m = PATTERN.exec(pattern);
  if (m === null) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const [, scheme, host, path] = m as unknown as [string, string, string, string];
  const protocol = parsed.protocol.slice(0, -1);
  if (scheme === '*' ? protocol !== 'http' && protocol !== 'https' : protocol !== scheme) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2).toLowerCase();
      if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
    } else if (hostname !== host.toLowerCase()) {
      return false;
    }
  }
  const glob = new RegExp(`^${path.split('*').map(escapeRegExp).join('.*')}$`);
  return glob.test(parsed.pathname + parsed.search);
}

export interface PageDraft {
  draft: CachedDraft;
  /** The `match` patterns of the draft's effective definition (empty when it has none). */
  match: string[];
}

export interface PageDrafts {
  /** Active drafts whose destination matches the page, after the account filter. */
  matching: PageDraft[];
  /** Matching drafts left out because they are for another account than the one detected. */
  otherAccounts: number;
  /** Detected account by site id; a site absent here had no locator or detection failed. */
  detected: Record<string, string>;
  /** Active drafts whose destination does not match the page. */
  elsewhere: PageDraft[];
}

/** The account locators to run on a page: one per site among the drafts matching it. */
export function accountLocators(
  drafts: readonly CachedDraft[],
  destinations: readonly Destination[],
  source: SiteDefinitionSource,
  url: string
): Map<string, SiteAccount> {
  const locators = new Map<string, SiteAccount>();
  for (const draft of drafts) {
    if (draft.status !== 'active' || locators.has(draft.site)) continue;
    const { definition } = definitionForDraft(source, draft, destinations);
    if (definition?.account === undefined) continue;
    if (definition.match.some((p) => matchesPattern(p, url))) {
      locators.set(draft.site, definition.account);
    }
  }
  return locators;
}

/**
 * Step 3: active drafts whose effective definition matches `url`, newest first. For a site where
 * an account was detected only that account's drafts are kept; where detection failed every
 * account's drafts are kept, and the popup labels each with its account.
 */
export function draftsForPage(input: {
  drafts: readonly CachedDraft[];
  destinations: readonly Destination[];
  source: SiteDefinitionSource;
  url: string;
  detected: Record<string, string>;
}): PageDrafts {
  const result: PageDrafts = {
    matching: [],
    otherAccounts: 0,
    detected: input.detected,
    elsewhere: [],
  };
  const active = input.drafts
    .filter((d) => d.status === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const draft of active) {
    const { definition } = definitionForDraft(input.source, draft, input.destinations);
    const match = definition?.match ?? [];
    const entry = { draft, match };
    if (!match.some((p) => matchesPattern(p, input.url))) {
      result.elsewhere.push(entry);
      continue;
    }
    const detected = input.detected[draft.site];
    if (detected !== undefined && !sameAccount(draft.site, detected, draft.account, definition)) {
      result.otherAccounts++;
      continue;
    }
    result.matching.push(entry);
  }
  return result;
}

/**
 * `documentUrlPatterns` for the context menu: the `match` patterns of every confirmed
 * destination's effective definition, deduplicated and sorted. Patterns a menu would refuse (a
 * port or userinfo in the host) are left out, since one bad pattern fails the whole menu item.
 */
export function documentUrlPatterns(
  destinations: readonly Destination[],
  source: SiteDefinitionSource
): string[] {
  const patterns = new Set<string>();
  for (const destination of destinations) {
    if (destination.status !== 'confirmed') continue;
    const definition = effectiveDefinition(source, destination.site, destination.override);
    for (const pattern of definition?.match ?? []) {
      if (MENU_PATTERN.test(pattern)) patterns.add(pattern);
    }
  }
  return [...patterns].sort();
}
