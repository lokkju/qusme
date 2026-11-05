/**
 * Account names as devices, ingestion and the service compare them (spec 7.2, 10.1, 11.5). A
 * user or agent may write an account with the `@` a site shows handles with, with stray spaces,
 * or in another case than the site does; all of those name one destination. Compare and key by
 * {@link normalizeAccount}; store and show {@link displayAccount}, which keeps the user's case.
 */
import type { SiteDefinition } from './siteDef.ts';

/** The part of a definition normalization reads: its id and `account.caseSensitive`. */
export type AccountRules = Pick<SiteDefinition, 'id'> & {
  account?: { caseSensitive?: boolean } | undefined;
};

/** The account as stored and shown: surrounding whitespace and one leading `@` removed. */
export const displayAccount = (account: string): string => account.trim().replace(/^@/, '').trim();

/**
 * The account's comparison key on `site`: {@link displayAccount}, case-folded unless the site's
 * definition sets `account.caseSensitive` (10.1). Without a definition, or with one for another
 * site, accounts are case-insensitive, as handles are on every site in the registry.
 */
export function normalizeAccount(site: string, account: string, definition?: AccountRules): string {
  const bare = displayAccount(account);
  const caseSensitive = definition?.id === site && definition.account?.caseSensitive === true;
  return caseSensitive ? bare : bare.toLowerCase();
}

/** Whether two accounts on `site` name the same destination. */
export const sameAccount = (
  site: string,
  a: string,
  b: string,
  definition?: AccountRules
): boolean => normalizeAccount(site, a, definition) === normalizeAccount(site, b, definition);
