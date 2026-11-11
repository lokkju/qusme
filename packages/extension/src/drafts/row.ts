/**
 * Builds a draft's row data (`rowFormat.ts`) from the draft cache and the site definitions, for
 * the popup's list and for the picker view the background sends to the page.
 */
import { countLength, type Destination, displayAccount, type SiteDefinition } from '@qusme/nostr';
import { defaultLabel } from '../agents/destinations.ts';
import {
  definitionForDraft,
  effectiveDefinition,
  type SiteDefinitionSource,
} from '../insertion/definitions.ts';
import type { CachedDraft } from '../sync/state.ts';
import { type RowData, type RowMeta, relativeTime } from './rowFormat.ts';

/** The site's host from its first match pattern, without `*.` or `www.`; undefined for none. */
export function siteHost(definition: SiteDefinition | undefined): string | undefined {
  const pattern = definition?.match[0];
  const host = pattern === undefined ? undefined : /^[^:]+:\/\/([^/]+)\//.exec(pattern)?.[1];
  if (host === undefined || host === '*') return undefined;
  return host.replace(/^\*\./, '').replace(/^www\./, '');
}

/**
 * The one destination format (critique R3, P5, V2): the label the user gave it, else
 * `host · account`. A label equal to the default ("X / lokkju") counts as not given. On a site
 * with no fixed host (Mastodon), an account written `user@host` gives the host.
 */
export function destinationLabel(
  source: SiteDefinitionSource,
  site: string,
  account: string,
  destination?: Pick<Destination, 'label' | 'override'>
): string {
  const label = destination?.label.trim() ?? '';
  if (label !== '' && label !== defaultLabel(source, site, account)) return label;
  const shown = displayAccount(account);
  const host = siteHost(effectiveDefinition(source, site, destination?.override ?? null));
  if (host !== undefined) return `${host} · ${shown}`;
  const at = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(shown);
  if (at !== null) return `${at[2]} · ${at[1]}`;
  return `${site} · ${shown}`;
}

/** Who wrote the draft: the agent's label, "An agent" without one, else "You". */
export const draftAuthor = (draft: Pick<CachedDraft, 'source'>): string =>
  draft.source === undefined ? 'You' : (draft.source.label ?? 'An agent');

/**
 * The row for a draft. `showDestination` is false when the page already says where it goes (a
 * draft for this page whose account was detected).
 */
export function rowData(
  draft: CachedDraft,
  context: {
    source: SiteDefinitionSource;
    destinations: readonly Destination[];
    now: number;
    showDestination: boolean;
    /** The text to show; the draft's content by default. */
    text?: string;
  }
): RowData {
  const { source, destinations } = context;
  const { definition, field } = definitionForDraft(source, draft, destinations);
  const meta: RowMeta = {
    who: draftAuthor(draft),
    when: relativeTime(draft.updatedAt, context.now),
  };
  if (context.showDestination) {
    const destination =
      destinations.find((d) => d.id === draft.destination) ??
      destinations.find((d) => d.site === draft.site && d.account === draft.account);
    meta.destination = destinationLabel(source, draft.site, draft.account, destination);
  }
  if (definition !== undefined && definition.fields.length > 1) {
    meta.field = field?.label ?? draft.field;
  }
  const max = field?.constraints.maxLength;
  if (max !== undefined) {
    const length = countLength(draft.content, field?.constraints.counter);
    meta.count = { length, max, over: length > max };
  }
  return { d: draft.d, text: context.text ?? draft.content, meta };
}
