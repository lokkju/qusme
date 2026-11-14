/**
 * The archive retention choice on Settings (spec 7.2, 11.5; D30): 30, 90 (the default), 180 or
 * 365 days, or never. Saving republishes the queue's settings with the new value
 * (`src/setup/settings.ts`), and other devices adopt it on their next sync.
 */
import { createLocalSigner, DEFAULT_ARCHIVE_RETENTION_DAYS, parseSettings } from '@qusme/nostr';
import { useEffect, useState } from 'preact/hooks';
import { RETENTION_CHOICES, retentionDays } from '../drafts/retention.ts';
import type { SetupDeps } from '../setup/deps.ts';
import { saveArchiveRetention } from '../setup/settings.ts';
import { messageOf } from './app.tsx';
import { Button, ErrorText, inputClass } from './components.tsx';

const NEVER = 'never';

const optionValue = (days: number | null): string => (days === null ? NEVER : String(days));

export function retentionLabel(days: number | null): string {
  if (days === null) return 'Never delete archived drafts';
  const text = `${days} ${days === 1 ? 'day' : 'days'}`;
  return days === DEFAULT_ARCHIVE_RETENTION_DAYS ? `${text} (default)` : text;
}

/** The control's markup, separate from its effects so it renders in tests. */
export function RetentionControl(props: {
  /** The effective retention; `undefined` while loading. */
  current: number | null | undefined;
  selected: number | null | undefined;
  busy: boolean;
  notice?: string | undefined;
  error?: string | undefined;
  onSelect: (days: number | null) => void;
  onSave: () => void;
}) {
  const { current, selected } = props;
  const choices = [...RETENTION_CHOICES];
  // A value set elsewhere (another client, say) stays selectable.
  if (current !== undefined && !choices.includes(current)) choices.unshift(current);
  const changed = selected !== undefined && selected !== current;
  return (
    <div class="mt-4">
      <label for="archive-retention" class="font-medium text-sm">
        Keep archived drafts
      </label>
      <p id="archive-retention-hint" class="mt-1 text-muted text-xs">
        Inserted and dismissed drafts are deleted from your storage relays this long after they were
        archived. Applies to every device using this queue.
      </p>
      <div class="mt-2 flex items-center gap-2">
        <select
          id="archive-retention"
          class={inputClass}
          aria-describedby="archive-retention-hint"
          disabled={current === undefined || props.busy}
          value={selected === undefined ? '' : optionValue(selected)}
          onChange={(e) => {
            const v = e.currentTarget.value;
            props.onSelect(v === NEVER ? null : Number(v));
          }}
        >
          {choices.map((days) => (
            <option key={optionValue(days)} value={optionValue(days)}>
              {retentionLabel(days)}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={!changed || props.busy} onClick={props.onSave}>
          Save
        </Button>
      </div>
      {props.notice !== undefined && (
        <p role="status" class="mt-2 text-sm">
          {props.notice}
        </p>
      )}
      <ErrorText message={props.error} />
    </div>
  );
}

/** Reads the setting from the settings this device last synced, and saves a new one. */
export function RetentionSetting(props: { deps: SetupDeps }) {
  const { deps } = props;
  const [current, setCurrent] = useState<number | null | undefined>();
  const [selected, setSelected] = useState<number | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void (async () => {
      const unlocked = await deps.store.unlocked();
      let days: number | null = DEFAULT_ARCHIVE_RETENTION_DAYS;
      const kept = unlocked?.record.settings;
      if (unlocked !== undefined && kept !== undefined) {
        const parsed = await parseSettings(kept, createLocalSigner(unlocked.queueKey));
        if (parsed.ok) days = retentionDays(parsed.value.content);
      }
      if (live) {
        setCurrent(days);
        setSelected(days);
      }
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [deps]);

  const save = async () => {
    if (selected === undefined) return;
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      await saveArchiveRetention(selected, deps);
      setCurrent(selected);
      setNotice(
        selected === null
          ? 'Saved. Archived drafts are kept until you change this.'
          : `Saved. Archived drafts are deleted ${selected} days after they were archived.`
      );
      void deps.requestSync?.().catch(() => undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RetentionControl
      current={current}
      selected={selected}
      busy={busy}
      notice={notice}
      error={error}
      onSelect={(days) => {
        setSelected(days);
        setNotice(undefined);
      }}
      onSave={() => void save()}
    />
  );
}
