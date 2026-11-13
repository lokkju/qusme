/**
 * The context menu item (spec 11.5 steps 4 and 5): on `editable` contexts, only on pages matching
 * the user's destinations. With a draft armed it reads "Insert: <first 40 characters>…" and
 * inserts; with nothing armed it opens the popup. The two cases use different item ids so the
 * click handler can tell them apart without awaiting storage: Firefox opens the popup only from
 * inside the click's own handler. A second item, "Save to qus.me", saves the field as a draft
 * (11.7); with two items the browser groups them under the extension's name.
 */
import type { Destination } from '@qusme/nostr';
import type { ArmedDraft } from './armed.ts';
import { menuTitle } from './armed.ts';
import type { SiteDefinitionSource } from './definitions.ts';
import { documentUrlPatterns, savePatterns } from './matching.ts';

/** The item when a draft is armed: inserts it. */
export const MENU_INSERT = 'qusme.insert';
/** The item when nothing is armed: opens the popup to choose a draft. */
export const MENU_CHOOSE = 'qusme.choose';
/** Saves the field the menu was opened on as a new draft (11.7). */
export const MENU_SAVE = 'qusme.save';

/** The save item's title. */
export const SAVE_TITLE = 'Save to qus.me';

export interface MenuItem {
  id: typeof MENU_INSERT | typeof MENU_CHOOSE | typeof MENU_SAVE;
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

/**
 * The save item (11.7), on `editable` contexts on the destinations' pages and every registry
 * site's; undefined when there are none. It needs no more than activeTab, which the click grants.
 */
export function saveMenuItem(input: {
  destinations: readonly Destination[];
  definitions: SiteDefinitionSource;
}): MenuItem | undefined {
  const patterns = savePatterns(input.destinations, input.definitions);
  if (patterns.length === 0) return undefined;
  return {
    id: MENU_SAVE,
    title: SAVE_TITLE,
    contexts: ['editable'],
    documentUrlPatterns: patterns,
  };
}
