/**
 * The popup's header toolbar (critique H1, H2, H5): the brand, the page-context chip and, once
 * unlocked, one overflow menu in place of the six buttons that used to sit under the drafts.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

export type MenuTarget = 'agents' | 'destinations' | 'archive' | 'pair-source' | 'settings';

const itemClass =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-ink hover:bg-band focus-visible:bg-band';

export function OverflowMenu(props: {
  /** Accounts agents proposed that wait for the user; shown beside Agents. */
  pending: number;
  onSelect: (target: MenuTarget) => void;
  onLock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null && !menu.current?.contains(target) && !button.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? list[0] : list.at(-1))?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const item = (target: MenuTarget, label: string, extra?: preact.ComponentChildren) => (
    <button
      type="button"
      role="menuitem"
      class={itemClass}
      onClick={() => {
        close(false);
        props.onSelect(target);
      }}
    >
      {label}
      {extra}
    </button>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        class="relative flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-band hover:text-ink"
        aria-label={props.pending > 0 ? `Menu, ${props.pending} waiting` : 'Menu'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg aria-hidden="true" viewBox="0 0 18 18" class="h-[18px] w-[18px]" fill="currentColor">
          <circle cx="4" cy="9" r="1.5" />
          <circle cx="9" cy="9" r="1.5" />
          <circle cx="14" cy="9" r="1.5" />
        </svg>
        {props.pending > 0 && (
          <span
            aria-hidden="true"
            class="absolute top-0.5 right-0.5 h-2 w-2 rounded-full border border-paper bg-accent"
          />
        )}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="qus.me"
          tabIndex={-1}
          class="absolute top-[46px] right-2.5 z-10 w-[236px] card p-1.5 shadow-[0_1px_2px_rgba(0,0,0,.06),0_18px_44px_-10px_rgba(20,30,25,.18)]"
          onKeyDown={onKeyDown}
        >
          {item(
            'agents',
            'Agents',
            props.pending > 0 && (
              <span class="ml-auto h-5 min-w-5 rounded-full bg-accent px-1.5 text-center font-semibold text-[11px] text-on-accent leading-5">
                {props.pending}
                <span class="sr-only"> waiting</span>
              </span>
            )
          )}
          {item('destinations', 'Accounts')}
          {item('archive', 'Archive')}
          <hr class="mx-1 my-1.5 border-line border-t" />
          {item('pair-source', 'Pair a device')}
          {item('settings', 'Settings')}
          <hr class="mx-1 my-1.5 border-line border-t" />
          <button
            type="button"
            role="menuitem"
            class={itemClass}
            onClick={() => {
              close(false);
              props.onLock();
            }}
          >
            Lock
            <span class="ml-auto text-[11px] text-muted">asks for the passphrase</span>
          </button>
        </div>
      )}
    </>
  );
}

/** The 46px header: the q mark and name, the chip, and the menu when there is one. */
export function Toolbar(props: { chip?: string | undefined; children?: preact.ComponentChildren }) {
  return (
    <header class="relative flex h-[46px] flex-none items-center gap-2.5 border-line border-b bg-paper pr-3 pl-3.5">
      <span class="q-mark" aria-hidden="true">
        q
      </span>
      <span class="font-medium font-serif text-lg leading-none" aria-hidden="true">
        qus.me
      </span>
      <span class="flex-1" />
      {props.chip !== undefined && (
        <span
          class="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full border border-line bg-band px-2.5 text-ink-2 text-xs"
          title={`This tab: ${props.chip}`}
        >
          <span aria-hidden="true" class="h-[7px] w-[7px] flex-none rounded-full bg-accent" />
          <span class="sr-only">This tab: </span>
          <span class="truncate">{props.chip}</span>
        </span>
      )}
      {props.children}
    </header>
  );
}
