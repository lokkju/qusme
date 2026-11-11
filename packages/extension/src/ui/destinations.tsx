/**
 * The Destinations screen (spec 7.2, 10.2): every destination, confirmed and pending, with add,
 * edit and remove. Labels, accounts, site names and overrides come from relays, the registry and
 * agents, so every one is a JSX text child (or an input's value), which Preact sets as text.
 */
import {
  type Destination,
  displayAccount,
  type JsonObject,
  parseDestinationOverride,
} from '@qusme/nostr';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  addDestination,
  defaultLabel,
  editDestination,
  LABEL_MAX,
  loadDestinations,
  removeDestination,
} from '../agents/destinations.ts';
import type { SiteDefinitionSource } from '../insertion/definitions.ts';
import { type DetectDeps, type Detection, detectForSite } from '../insertion/detect.ts';
import { type SetupDeps, SetupError } from '../setup/deps.ts';
import { ShareOffer } from './agents.tsx';
import { messageOf } from './app.tsx';
import { Button, ErrorText, Field, inputClass, Screen } from './components.tsx';

/** The value of the site picker that means a custom destination. */
export const CUSTOM_SITE = '';

/** A registry site the picker offers. */
export interface SiteChoice {
  id: string;
  name: string;
  /** Whether the definition has no fixed hosts, so the destination must give `match` (10.1). */
  needsMatch: boolean;
}

/** The registry's sites, by name, for the picker. */
export function siteChoices(source: SiteDefinitionSource): SiteChoice[] {
  const choices: SiteChoice[] = [];
  for (const json of source.sites()) {
    if (typeof json.id !== 'string') continue;
    const name = typeof json.name === 'string' && json.name !== '' ? json.name : json.id;
    const needsMatch = !Array.isArray(json.match) || json.match.length === 0;
    choices.push({ id: json.id, name, needsMatch });
  }
  return choices.sort((a, b) => a.name.localeCompare(b.name));
}

/** Match patterns typed one per line (or separated by spaces or commas). */
export const parsePatterns = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');

/** What the user should read after a detection, written for them. */
export function detectionMessage(detection: Detection, siteName: string): string | undefined {
  switch (detection.state) {
    case 'detected':
      return undefined;
    case 'no_tab':
      return "qus.me can't read this tab.";
    case 'other_site':
      return `This tab isn't on ${siteName}.`;
    case 'no_locator':
      return `${siteName}'s definition can't tell which account is signed in; type it.`;
    case 'undetected':
      return `Couldn't tell which ${siteName} account is signed in; type it.`;
  }
}

/** One destination with its controls. */
export function DestinationItem(props: {
  destination: Destination;
  siteName: string;
  custom: boolean;
  busy: boolean;
  confirming: boolean;
  onEdit: (d: Destination) => void;
  onAskRemove: (d: Destination | undefined) => void;
  onRemove: (d: Destination) => void;
}) {
  const { destination: d } = props;
  return (
    <li class="card p-3">
      <p class="font-medium text-sm">{d.label}</p>
      <p class="text-muted text-xs">
        {props.siteName}
        {props.custom && ' (custom)'} · {d.account}
        {d.override !== null && ' · override'}
      </p>
      {d.status === 'pending' && (
        <p class="text-xs">Proposed by an agent; confirm or reject it under Agents.</p>
      )}
      {props.confirming ? (
        <div class="mt-2">
          <p class="text-xs">Removing it dismisses its active drafts too.</p>
          <div class="mt-1 flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onRemove(d)}
            >
              Remove and dismiss its drafts
            </Button>
            <Button variant="plain" size="sm" onClick={() => props.onAskRemove(undefined)}>
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <div class="mt-2 flex gap-2">
          <Button variant="plain" size="sm" disabled={props.busy} onClick={() => props.onEdit(d)}>
            Edit
          </Button>
          <Button
            variant="plain"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onAskRemove(d)}
          >
            Remove…
          </Button>
        </div>
      )}
    </li>
  );
}

/** The list, confirmed first. */
export function DestinationList(props: {
  destinations: Destination[];
  source: SiteDefinitionSource;
  busy: boolean;
  confirmingId: string | undefined;
  onEdit: (d: Destination) => void;
  onAskRemove: (d: Destination | undefined) => void;
  onRemove: (d: Destination) => void;
}) {
  const { source } = props;
  if (props.destinations.length === 0) {
    return <p class="mt-2 text-sm">No destinations yet. Add the accounts you post as.</p>;
  }
  const ordered = [
    ...props.destinations.filter((d) => d.status === 'confirmed'),
    ...props.destinations.filter((d) => d.status !== 'confirmed'),
  ];
  return (
    <ul class="mt-2 flex flex-col gap-2">
      {ordered.map((d) => {
        const official = source.official(d.site);
        const name = typeof official?.name === 'string' ? official.name : d.site;
        return (
          <DestinationItem
            key={d.id}
            destination={d}
            siteName={name}
            custom={official === undefined}
            busy={props.busy}
            confirming={props.confirmingId === d.id}
            onEdit={props.onEdit}
            onAskRemove={props.onAskRemove}
            onRemove={props.onRemove}
          />
        );
      })}
    </ul>
  );
}

export interface AddValues {
  /** A registry site id, or {@link CUSTOM_SITE}. */
  choice: string;
  /** The custom site's id. */
  customSite: string;
  account: string;
  label: string;
  /** Match patterns, one per line; required for a custom site or one with no fixed hosts. */
  patterns: string;
}

export const emptyAdd = (choices: readonly SiteChoice[]): AddValues => ({
  choice: choices[0]?.id ?? CUSTOM_SITE,
  customSite: '',
  account: '',
  label: '',
  patterns: '',
});

/** The site id and override an add form describes. */
export function addInput(values: AddValues, choices: readonly SiteChoice[]) {
  const custom = values.choice === CUSTOM_SITE;
  const site = custom ? values.customSite.trim() : values.choice;
  const patterns = parsePatterns(values.patterns);
  const needsMatch = custom || choices.find((c) => c.id === site)?.needsMatch === true;
  const override: JsonObject | null =
    needsMatch || patterns.length > 0 ? { match: patterns } : null;
  return { site, custom, needsMatch, override };
}

/** The add form's markup. */
export function AddDestinationForm(props: {
  choices: SiteChoice[];
  source: SiteDefinitionSource;
  values: AddValues;
  canDetect: boolean;
  busy: string | undefined;
  detectNote: string | undefined;
  error: string | undefined;
  onChange: (values: AddValues) => void;
  onDetect: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { values, choices } = props;
  const set = (patch: Partial<AddValues>) => props.onChange({ ...values, ...patch });
  const { site, custom, needsMatch } = addInput(values, choices);
  const placeholder =
    site !== '' && values.account.trim() !== ''
      ? defaultLabel(props.source, site, values.account)
      : 'Site / account';
  return (
    <form
      class="mt-2 card p-3"
      aria-labelledby="add-destination-title"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <h2 id="add-destination-title" class="font-semibold text-sm">
        Add a destination
      </h2>
      <Field id="destination-site" label="Site">
        <select
          id="destination-site"
          class={inputClass}
          value={values.choice}
          onChange={(e) => set({ choice: e.currentTarget.value })}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={CUSTOM_SITE}>Custom…</option>
        </select>
      </Field>
      {custom && (
        <Field
          id="destination-custom-site"
          label="Site id"
          hint="Lowercase letters and digits, such as myblog. It names the site in drafts."
        >
          <input
            id="destination-custom-site"
            class={inputClass}
            autocomplete="off"
            spellcheck={false}
            value={values.customSite}
            aria-describedby="destination-custom-site-hint"
            onInput={(e) => set({ customSite: e.currentTarget.value })}
          />
        </Field>
      )}
      <Field id="destination-account" label="Account">
        <input
          id="destination-account"
          class={inputClass}
          autocomplete="off"
          spellcheck={false}
          value={values.account}
          onInput={(e) => set({ account: e.currentTarget.value })}
        />
      </Field>
      {!custom && props.canDetect && (
        <Button
          variant="plain"
          size="sm"
          class="mt-1"
          disabled={props.busy !== undefined}
          onClick={props.onDetect}
        >
          Detect from this tab
        </Button>
      )}
      {props.detectNote !== undefined && (
        <p role="status" class="mt-1 text-xs">
          {props.detectNote}
        </p>
      )}
      {needsMatch && (
        <Field
          id="destination-match"
          label="Match patterns"
          hint="One per line, such as https://blog.example/*. The pages where its drafts go."
        >
          <textarea
            id="destination-match"
            class={`${inputClass} font-mono`}
            rows={2}
            spellcheck={false}
            value={values.patterns}
            aria-describedby="destination-match-hint"
            onInput={(e) => set({ patterns: e.currentTarget.value })}
          />
        </Field>
      )}
      <Field id="destination-label" label="Label" hint="Only your devices see it.">
        <input
          id="destination-label"
          class={inputClass}
          maxLength={LABEL_MAX}
          placeholder={placeholder}
          value={values.label}
          aria-describedby="destination-label-hint"
          onInput={(e) => set({ label: e.currentTarget.value })}
        />
      </Field>
      <ErrorText message={props.error} />
      <div class="mt-3 flex gap-2">
        <Button type="submit" disabled={props.busy !== undefined}>
          {props.busy ?? 'Add'}
        </Button>
        <Button variant="plain" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The override as the edit form shows it: pretty JSON, or empty for none. */
export const overrideText = (override: JsonObject | null): string =>
  override === null ? '' : JSON.stringify(override, null, 2);

/** The edit form's markup. */
export function EditDestinationForm(props: {
  destination: Destination;
  label: string;
  override: string;
  busy: string | undefined;
  error: string | undefined;
  onLabel: (label: string) => void;
  onOverride: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { destination: d } = props;
  return (
    <form
      class="mt-2 card p-3"
      aria-labelledby="edit-destination-title"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <h2 id="edit-destination-title" class="font-semibold text-sm">
        Edit {d.label}
      </h2>
      <p class="text-muted text-xs">
        Site {d.site}, account {d.account}
      </p>
      <Field id="edit-destination-label" label="Label">
        <input
          id="edit-destination-label"
          class={inputClass}
          maxLength={LABEL_MAX}
          value={props.label}
          onInput={(e) => props.onLabel(e.currentTarget.value)}
        />
      </Field>
      <Field
        id="edit-destination-override"
        label="Override (JSON)"
        hint="Merged over the site's definition. Empty for none."
      >
        <textarea
          id="edit-destination-override"
          class={`${inputClass} font-mono`}
          rows={6}
          spellcheck={false}
          value={props.override}
          aria-describedby="edit-destination-override-hint"
          onInput={(e) => props.onOverride(e.currentTarget.value)}
        />
      </Field>
      <ErrorText message={props.error} />
      <div class="mt-3 flex gap-2">
        <Button type="submit" disabled={props.busy !== undefined}>
          {props.busy ?? 'Save'}
        </Button>
        <Button variant="plain" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Mode =
  | { mode: 'list' }
  | { mode: 'add'; values: AddValues; detectNote?: string }
  | { mode: 'edit'; destination: Destination; label: string; override: string };

/** The screen with its effects. `detect` is absent where there is no tab to read. */
export function DestinationsScreen(props: {
  deps: SetupDeps;
  definitions: SiteDefinitionSource;
  detect?: DetectDeps | undefined;
  onBack: () => void;
  /** Open on the add form with this registry site chosen (the first-run checklist's "Add your X account"). */
  startAdding?: string | undefined;
}) {
  const { deps, definitions, detect } = props;
  const choices = siteChoices(definitions);
  const [destinations, setDestinations] = useState<Destination[] | undefined>();
  const [mode, setMode] = useState<Mode>(() => {
    if (props.startAdding === undefined) return { mode: 'list' };
    const values = emptyAdd(choices);
    if (choices.some((c) => c.id === props.startAdding)) values.choice = props.startAdding;
    return { mode: 'add', values };
  });
  const [confirmingId, setConfirmingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  // A destination just added, offered to the agents that could use it (UX audit 3.2).
  const [shared, setShared] = useState<Destination | undefined>();

  const load = useCallback(async () => {
    try {
      setDestinations(await loadDestinations(deps));
    } catch (e) {
      setError(messageOf(e));
    }
  }, [deps]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    setShared(undefined);
    try {
      const message = await action();
      setMode({ mode: 'list' });
      setConfirmingId(undefined);
      setNotice(message);
      await load();
      void deps.requestSync?.().catch(() => undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };

  const onDetect = async (values: AddValues) => {
    if (detect === undefined || values.choice === CUSTOM_SITE) return;
    const choice = choices.find((c) => c.id === values.choice);
    const { override } = addInput(values, choices);
    setBusy('Detecting…');
    try {
      const detection = await detectForSite(detect, values.choice, override);
      const note = detectionMessage(detection, choice?.name ?? values.choice);
      setMode({
        mode: 'add',
        values:
          detection.state === 'detected'
            ? { ...values, account: displayAccount(detection.account) }
            : values,
        ...(note !== undefined && { detectNote: note }),
      });
    } finally {
      setBusy(undefined);
    }
  };

  let body: ComponentChildren;
  if (mode.mode === 'add') {
    const { values } = mode;
    body = (
      <AddDestinationForm
        choices={choices}
        source={definitions}
        values={values}
        canDetect={detect !== undefined}
        busy={busy}
        detectNote={mode.detectNote}
        error={error}
        onChange={(next) => setMode({ mode: 'add', values: next })}
        onDetect={() => void onDetect(values)}
        onCancel={() => {
          setError(undefined);
          setMode({ mode: 'list' });
        }}
        onSubmit={() =>
          void run('Adding…', async () => {
            const { site, custom, override } = addInput(values, choices);
            if (custom && choices.some((c) => c.id === site)) {
              throw new SetupError(`${site} is in the registry; pick it from the list.`);
            }
            const added = await addDestination(
              { site, account: values.account, label: values.label, override },
              definitions,
              deps
            );
            setShared(added);
            return `Added ${added.label}.`;
          })
        }
      />
    );
  } else if (mode.mode === 'edit') {
    const { destination } = mode;
    body = (
      <EditDestinationForm
        destination={destination}
        label={mode.label}
        override={mode.override}
        busy={busy}
        error={error}
        onLabel={(label) => setMode({ ...mode, label })}
        onOverride={(override) => setMode({ ...mode, override })}
        onCancel={() => {
          setError(undefined);
          setMode({ mode: 'list' });
        }}
        onSubmit={() =>
          void run('Saving…', async () => {
            const checked = parseDestinationOverride(
              definitions.official(destination.site),
              mode.override
            );
            if (!checked.ok) {
              throw new SetupError(`The override doesn't work: ${checked.error.message}`);
            }
            const edited = await editDestination(
              destination.id,
              { label: mode.label, override: checked.value.override },
              definitions,
              deps
            );
            return `Saved ${edited.label}.`;
          })
        }
      />
    );
  } else {
    body = (
      <>
        {destinations === undefined && error === undefined && <p class="mt-2 text-sm">Loading…</p>}
        {destinations !== undefined && (
          <DestinationList
            destinations={destinations}
            source={definitions}
            busy={busy !== undefined}
            confirmingId={confirmingId}
            onEdit={(d) => {
              setNotice(undefined);
              setError(undefined);
              setMode({
                mode: 'edit',
                destination: d,
                label: d.label,
                override: overrideText(d.override),
              });
            }}
            onAskRemove={(d) => setConfirmingId(d?.id)}
            onRemove={(d) =>
              void run('Removing…', async () => {
                const { dismissed } = await removeDestination(d.id, deps, definitions);
                return `Removed ${d.label} and dismissed ${dismissed} draft${dismissed === 1 ? '' : 's'}.`;
              })
            }
          />
        )}
        <Button
          class="mt-3"
          disabled={busy !== undefined}
          onClick={() => {
            setNotice(undefined);
            setError(undefined);
            setMode({ mode: 'add', values: emptyAdd(choices) });
          }}
        >
          Add a destination
        </Button>
        <ErrorText message={error} />
      </>
    );
  }

  return (
    <Screen title="Destinations" onBack={props.onBack}>
      {body}
      {notice !== undefined && (
        <p role="status" class="mt-3 text-sm">
          {notice}
        </p>
      )}
      {shared !== undefined && mode.mode === 'list' && (
        <ShareOffer
          deps={deps}
          destination={shared}
          source={definitions}
          onDone={(message) => {
            setShared(undefined);
            if (message !== undefined) setNotice(message);
          }}
        />
      )}
    </Screen>
  );
}
