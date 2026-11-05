/**
 * The context menu item (spec 11.5 steps 4 and 5): on `editable` contexts, only on pages matching
 * the user's destinations. With a draft armed it reads "Insert: <first 40 characters>…" and
 * inserts; with nothing armed it opens the popup. The two cases use different item ids so the
 * click handler can tell them apart without awaiting storage: Firefox opens the popup only from
 * inside the click's own handler.
 */
import type { Destination } from '@qusme/nostr';
import type { ArmedDraft } from './armed.ts';
import { menuTitle } from './armed.ts';
import type { SiteDefinitionSource } from './definitions.ts';
import { documentUrlPatterns } from './matching.ts';

/** The item when a draft is armed: inserts it. */
export const MENU_INSERT = 'qusme.insert';
/** The item when nothing is armed: opens the popup to choose a draft. */
export const MENU_CHOOSE = 'qusme.choose';

export interface MenuItem {
  id: typeof MENU_INSERT | typeof MENU_CHOOSE;
  title: string;
  contexts: ['editable'];
  documentUrlPatterns: string[];
}

/** The one menu item to create, or undefined when no destination gives it a page to appear on. */
export function menuItem(input: {
  armed: ArmedDraft | undefined;
  destinations: readonly Destination[];
  definitions: SiteDefinitionSource;
  accessKeys?: boolean;
}): MenuItem | undefined {
  const patterns = documentUrlPatterns(input.destinations, input.definitions);
  if (patterns.length === 0) return undefined;
  return {
    id: input.armed === undefined ? MENU_CHOOSE : MENU_INSERT,
    title: menuTitle(input.armed, { accessKeys: input.accessKeys ?? false }),
    contexts: ['editable'],
    documentUrlPatterns: patterns,
  };
}
