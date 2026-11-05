/**
 * Account detection for adding destinations (spec 10.1, 11.5 step 2): which registry sites the
 * active tab is on, and which account the site's account locator finds there. The detection is
 * the insertion script's read-only `detectAccount`, run under activeTab like the insert panel's.
 */
import {
  type Destination,
  displayAccount,
  type JsonObject,
  type SiteAccount,
  type SiteDefinition,
  sameAccount,
} from '@qusme/nostr';
import { effectiveDefinition, type SiteDefinitionSource } from './definitions.ts';
import { matchesPattern } from './matching.ts';

/** What detection needs from the browser: the panel's own functions. */
export interface DetectDeps {
  definitions: SiteDefinitionSource;
  activeTab(): Promise<{ id: number; url: string } | undefined>;
  detectAccounts(tabId: number, locators: readonly SiteAccount[]): Promise<(string | undefined)[]>;
}

export type Detection =
  | { state: 'detected'; account: string }
  /** No tab qus.me can read (not http or https, or none). */
  | { state: 'no_tab' }
  /** The tab is not on the site's effective `match` patterns. */
  | { state: 'other_site' }
  /** The site's definition has no account locator. */
  | { state: 'no_locator' }
  /** The locator found nothing, or the page could not be read. */
  | { state: 'undetected' };

/**
 * Runs the site's account detection on the active tab, with the destination's override (if any)
 * merged over the official definition, as the insert panel would.
 */
export async function detectForSite(
  deps: DetectDeps,
  site: string,
  override: JsonObject | null
): Promise<Detection> {
  const tab = await deps.activeTab().catch(() => undefined);
  if (tab === undefined) return { state: 'no_tab' };
  const definition = effectiveDefinition(deps.definitions, site, override);
  if (definition === undefined || !definition.match.some((p) => matchesPattern(p, tab.url))) {
    return { state: 'other_site' };
  }
  if (definition.account === undefined) return { state: 'no_locator' };
  const [account] = await deps
    .detectAccounts(tab.id, [definition.account])
    .catch(() => [] as (string | undefined)[]);
  return typeof account === 'string' && account !== ''
    ? { state: 'detected', account }
    : { state: 'undetected' };
}

/** Registry sites whose official definition matches `url` and can detect an account. */
export function registrySitesOn(source: SiteDefinitionSource, url: string): SiteDefinition[] {
  const sites: SiteDefinition[] = [];
  for (const json of source.sites()) {
    if (typeof json.id !== 'string') continue;
    const definition = effectiveDefinition(source, json.id, null);
    if (definition?.account === undefined) continue;
    if (definition.match.some((p) => matchesPattern(p, url))) sites.push(definition);
  }
  return sites;
}

/** A detected account on a registry site that the list has no destination for. */
export interface DestinationOffer {
  site: string;
  siteName: string;
  account: string;
}

/**
 * The insert panel's shortcut: each registry site the page is on where an account was detected
 * and no destination (confirmed or pending) has that site and account.
 */
export function destinationOffers(
  sites: readonly SiteDefinition[],
  detected: Record<string, string>,
  destinations: readonly Destination[]
): DestinationOffer[] {
  const offers: DestinationOffer[] = [];
  for (const site of sites) {
    const account = detected[site.id];
    if (account === undefined) continue;
    const known = destinations.some(
      (d) => d.site === site.id && sameAccount(site.id, d.account, account, site)
    );
    if (known) continue;
    offers.push({ site: site.id, siteName: site.name, account: displayAccount(account) });
  }
  return offers;
}
