/**
 * One draft in the popup's list: the row the in-page picker also draws (`insertion/page/picker.ts`),
 * from the same {@link RowData} and segment keys, plus an expanded state for the popup (critique
 * R1, R2, R4, D1, H6). Collapsed, a row is the meta line, three lines of text and, for a draft for
 * this page, Insert. Expanded, it shows the whole text with Edit, Dismiss and "Set for right-click";
 * a draft for another site offers a plain "Insert here anyway" only then. Draft text and agent
 * labels are JSX text children, which Preact sets as text.
 */
import { useState } from 'preact/hooks';
import { countText, type RowData, type RowSegment, rowSegments } from '../drafts/rowFormat.ts';
import { Button, inputClass } from './components.tsx';

/** Only the destination gives way when the line is short of room; the time never does. */
const SEGMENT_CLASS: Record<RowSegment['key'], string> = {
  who: 'max-w-[40%] shrink-0 truncate font-medium text-ink-2',
  destination: 'min-w-0 truncate',
  field: 'shrink-0 whitespace-nowrap',
  when: 'shrink-0 whitespace-nowrap',
};

/** The row's meta line: the picker's `.s` line, in the popup's tokens. */
export function RowMetaLine(props: { row: RowData; children?: preact.ComponentChildren }) {
  const { meta } = props.row;
  return (
    <p class="flex min-h-[18px] items-baseline gap-1.5 text-muted text-xs">
      {rowSegments(meta).map((segment, i) => (
        <span key={segment.key} class="contents">
          {i > 0 && <span aria-hidden="true">·</span>}
          <span class={SEGMENT_CLASS[segment.key]} data-meta={segment.key}>
            {segment.text}
          </span>
        </span>
      ))}
      {meta.count !== undefined && (
        <span
          class={`ml-auto flex-none tabular-nums ${meta.count.over ? 'font-semibold text-danger' : ''}`}
          data-meta="count"
        >
          {countText(meta.count)}
          {meta.count.over && <span class="sr-only"> (over the limit)</span>}
        </span>
      )}
      {props.children}
    </p>
  );
}

export function DraftRow(props: {
  row: RowData;
  /** A draft for another site than the page's: no button until expanded (H6). */
  elsewhere: boolean;
  /** False on a tab qus.me can't use: the row offers no Insert. */
  insertable: boolean;
  armed: boolean;
  busy: boolean;
  onInsert: () => void;
  onArm: () => void;
  onEdit?: ((content: string) => Promise<boolean>) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | undefined>();
  const toggle = (
    <button
      type="button"
      class={`-my-1 flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-control text-muted hover:bg-band hover:text-ink ${row.meta.count === undefined ? 'ml-auto' : ''}`}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        class={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
      >
        <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="sr-only">{open ? 'Show less' : 'Show all'}</span>
    </button>
  );

  if (editing !== undefined && props.onEdit !== undefined) {
    const save = props.onEdit;
    const id = `edit-${row.d}`;
    return (
      <li
        class="border-line border-b bg-surface px-4 py-2.5 shadow-[inset_3px_0_0_var(--color-accent)]"
        data-draft={row.d}
      >
        <RowMetaLine row={row} />
        <label for={id} class="sr-only">
          Draft text
        </label>
        <textarea
          id={id}
          class={`${inputClass} mt-1 min-h-24`}
          value={editing}
          onInput={(e) => setEditing(e.currentTarget.value)}
        />
        <div class="mt-2 flex justify-end gap-2">
          <Button variant="plain" size="sm" onClick={() => setEditing(undefined)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={props.busy || editing.trim() === '' || editing === row.text}
            onClick={async () => {
              if (await save(editing)) setEditing(undefined);
            }}
          >
            Save
          </Button>
        </div>
      </li>
    );
  }

  const insert = props.insertable && (!props.elsewhere || open) && (
    <Button
      variant={props.elsewhere ? 'plain' : 'primary'}
      size="sm"
      class="ml-auto"
      disabled={props.busy}
      onClick={props.onInsert}
    >
      {props.elsewhere ? 'Insert here anyway' : 'Insert'}
    </Button>
  );
  const links = open && (
    <>
      {props.onEdit !== undefined && (
        <button
          type="button"
          class="text-xs link"
          disabled={props.busy}
          onClick={() => setEditing(row.text)}
        >
          Edit
        </button>
      )}
      {props.onDismiss !== undefined && (
        <button type="button" class="text-xs link" disabled={props.busy} onClick={props.onDismiss}>
          Dismiss
        </button>
      )}
      {props.insertable &&
        (props.armed ? (
          <span class="text-muted text-xs">Set for right-click</span>
        ) : (
          <button type="button" class="text-xs link" disabled={props.busy} onClick={props.onArm}>
            Set for right-click
          </button>
        ))}
    </>
  );
  return (
    <li
      class={`border-line border-b px-4 pt-2.5 pb-3 ${open ? 'bg-surface shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`}
      data-draft={row.d}
    >
      <RowMetaLine row={row}>{toggle}</RowMetaLine>
      {/* The text is the mouse's expand target; the chevron is the keyboard's. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the toggle button above is the keyboard path */}
      <p
        class={`mt-0.5 cursor-pointer text-sm leading-[1.45] [overflow-wrap:anywhere] ${open ? 'whitespace-pre-wrap' : 'line-clamp-3'}`}
        onClick={() => setOpen(!open)}
      >
        {row.text}
      </p>
      {(insert || links) && (
        <div class="mt-2 flex items-center gap-3">
          {links}
          {insert}
        </div>
      )}
    </li>
  );
}
