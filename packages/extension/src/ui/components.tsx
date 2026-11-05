/**
 * Small building blocks for the popup. Every string they render, including relay messages and
 * anything typed or received, goes in as a JSX text child, which Preact sets as text.
 */
import type { ProbeResult } from '@qusme/nostr';
import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { encode } from 'uqr';

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

/** Two password inputs and the strength problem, if any. */
export function NewPassphrase(props: {
  value: string;
  confirm: string;
  problem: string | undefined;
  onInput: (value: string) => void;
  onConfirm: (value: string) => void;
}) {
  return (
    <>
      <Field
        id="new-passphrase"
        label="Passphrase for this device"
        hint={props.problem ?? 'Strong enough.'}
      >
        <input
          id="new-passphrase"
          type="password"
          autocomplete="new-password"
          class={inputClass}
          value={props.value}
          aria-describedby="new-passphrase-hint"
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      </Field>
      <Field id="new-passphrase-confirm" label="Type it again">
        <input
          id="new-passphrase-confirm"
          type="password"
          autocomplete="new-password"
          class={inputClass}
          value={props.confirm}
          onInput={(e) => props.onConfirm(e.currentTarget.value)}
        />
      </Field>
    </>
  );
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
