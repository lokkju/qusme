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

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'plain' | 'danger' }
) {
  const { variant = 'primary', class: extra, type = 'button', ...rest } = props;
  const look =
    variant === 'primary'
      ? 'bg-accent text-white'
      : variant === 'danger'
        ? 'border border-danger text-danger'
        : 'border border-ink/30 text-ink';
  return (
    <button
      type={type}
      class={`rounded px-3 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${look} ${extra ?? ''}`}
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
        <p id={`${props.id}-hint`} class="text-ink/70 text-xs">
          {props.hint}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  'w-full rounded border border-ink/30 bg-white px-2 py-1.5 font-mono text-sm focus-visible:outline-2 focus-visible:outline-accent';

export function ErrorText(props: { message: string | undefined }) {
  if (props.message === undefined) return null;
  return (
    <p role="alert" class="mt-3 text-danger text-sm">
      {props.message}
    </p>
  );
}

export function Heading(props: { children: ComponentChildren }) {
  return <h1 class="font-semibold text-lg">{props.children}</h1>;
}

export function Screen(props: { title: string; onBack?: () => void; children: ComponentChildren }) {
  return (
    <section class="flex flex-col" aria-labelledby="screen-title">
      <div class="flex items-center gap-2">
        {props.onBack && (
          <Button variant="plain" class="px-2 py-1 text-sm" onClick={props.onBack}>
            Back
          </Button>
        )}
        <h1 id="screen-title" class="font-semibold text-lg">
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
        <li key={`${result.role}:${result.url}`} class="rounded border border-ink/20 p-2">
          <span class="font-mono">{result.url}</span>{' '}
          <span class="text-ink/70">({result.role})</span>{' '}
          {result.ok ? (
            <span class="text-green-700">passed</span>
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
export function CopyButton(props: { text: string; label?: string; class?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = props.label ?? 'Copy';
  return (
    <Button
      variant="plain"
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
  const color =
    props.level >= 3 ? 'bg-green-700' : props.level === 2 ? 'bg-amber-500' : 'bg-danger';
  return (
    <div class="mt-1 flex gap-1" aria-hidden="true" data-level={props.level}>
      {[1, 2, 3, 4].map((n) => (
        <div key={n} class={`h-1.5 flex-1 rounded ${n <= props.level ? color : 'bg-ink/15'}`} />
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
            class="shrink-0 text-sm"
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
        <p id="new-passphrase-rule" class="text-ink/70 text-xs">
          {PASSPHRASE_RULE}
        </p>
        <StrengthMeter level={strength.level} />
        <p
          id="new-passphrase-status"
          class={`text-xs ${strength.level >= 3 && !mismatch ? 'text-green-700' : 'text-ink'}`}
          aria-live="polite"
        >
          {status}
        </p>
        <div class="flex gap-2">
          <Button variant="plain" class="px-2 py-1 text-xs" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </Button>
          <CopyButton text={props.value} class="px-2 py-1 text-xs" />
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
    <p class="mt-3 rounded bg-amber-100 p-2 text-sm">
      If you forget the passphrase, the recovery code restores the queue. If you lose the recovery
      code and no other paired device remains, the queue is lost.
    </p>
  );
}
