/**
 * Small building blocks for the popup. Every string they render, including relay messages and
 * anything typed or received, goes in as a JSX text child, which Preact sets as text.
 */
import type { ProbeResult } from '@qusme/nostr';
import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { encode } from 'uqr';
import {
  checkPassphrase,
  PASSPHRASE_RULE,
  passphraseStrength,
  type StrengthLevel,
  suggestPassphrase,
} from '../passphrase.ts';

export type ButtonVariant = 'primary' | 'plain' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'xs';

const BUTTON_LOOK: Record<ButtonVariant, string> = {
  primary:
    'border-accent bg-accent text-on-accent enabled:hover:border-accent-hover enabled:hover:bg-accent-hover',
  plain: 'border-line-strong bg-surface text-ink enabled:hover:border-ink',
  danger: 'border-danger bg-surface text-danger enabled:hover:bg-danger-tint',
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: 'min-h-10 px-4 py-2 text-sm',
  sm: 'min-h-8 px-3 py-1 text-sm',
  xs: 'min-h-7 px-2.5 py-0.5 text-xs',
};

/**
 * Every disabled button, whatever its look: the plain look with muted text, so a disabled primary
 * never reads as a third colour (critique S4). Variants come after base utilities in the
 * stylesheet, so these win over the look's border, background and text.
 */
const BUTTON_DISABLED =
  'disabled:cursor-default disabled:border-line disabled:bg-band disabled:text-muted';

/** The popup's button: 6px corners like the site's, in three looks and three sizes. */
export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
) {
  const { variant = 'primary', size = 'md', class: extra, type = 'button', ...rest } = props;
  return (
    <button
      type={type}
      class={`inline-flex cursor-pointer items-center justify-center rounded-control border font-medium leading-tight ${BUTTON_DISABLED} ${BUTTON_LOOK[variant]} ${BUTTON_SIZE[size]} ${extra ?? ''}`}
      {...rest}
    />
  );
}

export function Field(props: {
  id: string;
  label: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="mt-3 flex flex-col gap-1">
      <label for={props.id} class="font-medium text-sm">
        {props.label}
      </label>
      {props.children}
      {props.hint !== undefined && (
        <p id={`${props.id}-hint`} class="text-muted text-xs">
          {props.hint}
        </p>
      )}
    </div>
  );
}

/** Text inputs, textareas and selects. Add `font-mono` where the value is a code, key or URL. */
export const inputClass =
  'w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink text-sm placeholder:text-muted focus-visible:border-accent';

export function ErrorText(props: { message: string | undefined; class?: string }) {
  if (props.message === undefined) return null;
  return (
    <p role="alert" class={`font-medium text-danger text-sm ${props.class ?? 'mt-3'}`}>
      {props.message}
    </p>
  );
}

/** A small uppercase heading over a list of hairline rows. */
export const groupLabel =
  'pt-3 pb-1.5 font-semibold text-[11px] text-muted uppercase tracking-[0.08em]';

/**
 * The bar pinned to the bottom of the popup with a screen's decision in it (Approve and Deny,
 * Save and Cancel), so the buttons are never a scroll away (critique A3). The popup's scroll area
 * drops its bottom padding while one is on screen (`app.tsx`).
 */
export function BottomBar(props: { children: ComponentChildren }) {
  return (
    <div
      data-bottom-bar
      class="sticky bottom-0 z-10 -mx-4 mt-4 border-line border-t bg-paper px-4 py-3"
    >
      {props.children}
    </div>
  );
}

export function Heading(props: { children: ComponentChildren }) {
  return <h1 class="font-serif font-medium text-2xl leading-tight">{props.children}</h1>;
}

export function Screen(props: {
  title: string;
  onBack?: () => void;
  /** The title for screen readers only, where the popup's header already says it. */
  hideTitle?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class="flex flex-col" aria-labelledby="screen-title">
      <div class={`flex items-center gap-3 ${props.hideTitle ? 'sr-only' : ''}`}>
        {props.onBack && (
          <Button variant="plain" size="sm" onClick={props.onBack}>
            Back
          </Button>
        )}
        <h1 id="screen-title" class="font-serif font-medium text-2xl leading-tight">
          {props.title}
        </h1>
      </div>
      {props.children}
    </section>
  );
}

/** The six-digit SAS, large, read out digit by digit by screen readers. */
export function Sas(props: { code: string }) {
  return (
    <p class="my-4 text-center font-mono font-semibold text-4xl tracking-[0.3em]">
      <span aria-hidden="true">{props.code}</span>
      <span class="sr-only">Code {props.code.split('').join(' ')}</span>
    </p>
  );
}

/** A QR code drawn as SVG paths from the encoded modules. */
export function Qr(props: { text: string; label: string }) {
  const qr = encode(props.text, { ecc: 'M', border: 2 });
  let d = '';
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label={props.label}
      class="mx-auto my-3 h-56 w-56"
      shape-rendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** The outcome of each relay probe, with the failing check named (spec 9.1). */
export function ProbeResults(props: { results: ProbeResult[] }) {
  return (
    <ul class="mt-3 flex flex-col gap-2 text-sm" aria-live="polite">
      {props.results.map((result) => (
        <li key={`${result.role}:${result.url}`} class="card p-3">
          <span class="font-mono">{result.url}</span>{' '}
          <span class="text-muted">({result.role})</span>{' '}
          {result.ok ? (
            <span class="font-medium text-accent">passed</span>
          ) : (
            <span class="text-danger">
              refused: {result.failed?.name}
              {result.failed?.detail !== undefined && ` (${result.failed.detail})`}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Copies `text` and says so on the button for a moment. */
export function CopyButton(props: {
  text: string;
  label?: string;
  class?: string;
  size?: 'md' | 'sm' | 'xs';
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = props.label ?? 'Copy';
  return (
    <Button
      variant="plain"
      {...(props.size !== undefined && { size: props.size })}
      class={props.class}
      disabled={props.text === ''}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
          setFailed(false);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setFailed(true);
        }
      }}
    >
      {failed ? 'Copy failed' : copied ? 'Copied' : label}
    </Button>
  );
}

/** The strength meter: four bars, filled to the level, hidden from screen readers (the text says it). */
export function StrengthMeter(props: { level: StrengthLevel }) {
  const color = props.level >= 3 ? 'bg-accent' : props.level === 2 ? 'bg-warn' : 'bg-danger';
  return (
    <div class="mt-1 flex gap-1" aria-hidden="true" data-level={props.level}>
      {[1, 2, 3, 4].map((n) => (
        <div key={n} class={`h-1.5 flex-1 rounded-full ${n <= props.level ? color : 'bg-line'}`} />
      ))}
    </div>
  );
}

/**
 * Two passphrase inputs with the rule stated, live strength feedback (a meter and, for screen
 * readers, the same in words in a polite live region), "Suggest one" and a copy button. Callers
 * accept the passphrase when {@link checkPassphrase} passes and both entries match.
 */
export function NewPassphrase(props: {
  value: string;
  confirm: string;
  onInput: (value: string) => void;
  onConfirm: (value: string) => void;
  /** Draws a suggestion; tests pass a deterministic one. */
  suggest?: () => string;
}) {
  const [shown, setShown] = useState(false);
  const strength = passphraseStrength(props.value);
  const inputType = shown ? ({ type: 'text' } as const) : ({ type: 'password' } as const);
  const mismatch = props.confirm !== '' && props.confirm !== props.value;
  const status =
    props.value === ''
      ? ''
      : strength.check.ok && mismatch
        ? 'The two entries differ.'
        : strength.label;
  return (
    <>
      <div class="mt-3 flex flex-col gap-1">
        <label for="new-passphrase" class="font-medium text-sm">
          Passphrase for this device
        </label>
        <div class="flex gap-2">
          <input
            id="new-passphrase"
            {...inputType}
            autocomplete="new-password"
            spellcheck={false}
            class={inputClass}
            value={props.value}
            aria-describedby="new-passphrase-rule new-passphrase-status"
            onInput={(e) => props.onInput(e.currentTarget.value)}
          />
          <Button
            variant="plain"
            class="shrink-0"
            onClick={() => {
              const phrase = (props.suggest ?? suggestPassphrase)();
              props.onInput(phrase);
              props.onConfirm(phrase);
              setShown(true);
            }}
          >
            Suggest one
          </Button>
        </div>
        <p id="new-passphrase-rule" class="text-muted text-xs">
          {PASSPHRASE_RULE}
        </p>
        <StrengthMeter level={strength.level} />
        <p
          id="new-passphrase-status"
          class={`text-xs ${strength.level >= 3 && !mismatch ? 'text-accent' : 'text-ink'}`}
          aria-live="polite"
        >
          {status}
        </p>
        <div class="flex gap-2">
          <Button variant="plain" size="xs" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </Button>
          <CopyButton text={props.value} size="xs" />
        </div>
      </div>
      <Field id="new-passphrase-confirm" label="Type it again">
        <input
          id="new-passphrase-confirm"
          {...inputType}
          autocomplete="new-password"
          spellcheck={false}
          class={inputClass}
          value={props.confirm}
          onInput={(e) => props.onConfirm(e.currentTarget.value)}
        />
      </Field>
    </>
  );
}

/** Whether a new passphrase and its confirmation can be used. */
export const passphraseReady = (value: string, confirm: string): boolean =>
  checkPassphrase(value).ok && confirm === value;

/**
 * Saves `content` as a file through an object URL and a download link, which needs no
 * `downloads` permission (11.2).
 */
export function saveFile(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The statement spec 6.1 requires at setup. */
export function LossWarning() {
  return (
    <p class="card-warn mt-3 p-3 text-sm">
      If you forget the passphrase, the recovery code restores the queue. If you lose the recovery
      code and no other paired device remains, the queue is lost.
    </p>
  );
}
