// @vitest-environment happy-dom
/**
 * The approve, agents and unlock screens of the redesign (critique A1-A3, U1, S4), driven in
 * happy-dom: the code read off the sign-in tab, the Limits line, the pinned bar, Unlock's focus,
 * progress and forgot-passphrase path, and the one disabled look.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizePage } from '../../core/src/oauth/pages.ts';
import { type ApprovalChoices, defaultChoices } from '../src/agents/approve.ts';
import type { AuthorizationRequest } from '../src/agents/service.ts';
import { approvalCodeFromTab, isApprovalPage, readCodeOnPage } from '../src/agents/tabCode.ts';
import type { KeyStore } from '../src/keyStore.ts';
import { WrongPassphrase } from '../src/keyStore.ts';
import type { SetupDeps } from '../src/setup/deps.ts';
import { ApprovalReview, EditGrantView, GrantForm, limitsSummary } from '../src/ui/agents.tsx';
import { App, Unlock } from '../src/ui/app.tsx';
import { Button } from '../src/ui/components.tsx';
import { createdDevice, network, ORIGIN, until } from './helpers.ts';

let root: HTMLElement | undefined;
const host = () => root as HTMLElement;
afterEach(() => {
  if (root !== undefined) render(null, root);
  document.body.innerHTML = '';
});

function mount(node: preact.ComponentChild) {
  root = document.createElement('div');
  document.body.append(root);
  render(node, root);
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const buttons = (name: string) =>
  [...host().querySelectorAll('button')].filter(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name
  );
const button = (name: string): HTMLButtonElement => {
  const found = buttons(name)[0];
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = host().querySelector<T>(selector);
  if (el === null) throw new Error(`no ${selector}`);
  return el;
};

const request: AuthorizationRequest = {
  code: 'QK7D-M4XR',
  agentPubkey: 'a'.repeat(64),
  clientId: 'https://claude.ai/oauth/mcp-client',
  clientHost: 'claude.ai',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['drafts:submit'],
  expiresAt: 0,
};

const X_LOKKJU = {
  id: '1'.repeat(32),
  site: 'x',
  account: 'lokkju',
  label: 'X / lokkju',
  status: 'confirmed' as const,
  override: null,
};

describe('the approval code on the sign-in tab', () => {
  const authorizeUrl = `${ORIGIN}/authorize/abc123`;

  it('reads the code off the service authorize page as the service renders it', () => {
    const page = authorizePage({
      userCode: 'QK7D-M4XR',
      qrUrl: `${ORIGIN}/approve?code=QK7D-M4XR`,
      clientName: 'Claude',
      clientHost: 'claude.ai',
      statusPath: '/authorize/abc123/status',
      expiresAt: 0,
    });
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(page.html)?.[1] ?? '';
    expect(readCodeOnPage()).toBe('QK7D-M4XR');
    // Without the data attribute (an older page), the code box's text, then the QR's label.
    document.querySelector('[data-approval-code]')?.removeAttribute('data-approval-code');
    expect(readCodeOnPage()).toBe('QK7D-M4XR');
    document.querySelector('.code')?.remove();
    expect(readCodeOnPage()).toBe('QK7D-M4XR');
  });

  it('reads only the service authorize and approve pages, and parses what it finds', async () => {
    expect(isApprovalPage(authorizeUrl, ORIGIN)).toBe(true);
    expect(isApprovalPage(`${ORIGIN}/approve?code=QK7D-M4XR`, ORIGIN)).toBe(true);
    expect(isApprovalPage(`${ORIGIN}/authorize/abc123/status`, ORIGIN)).toBe(false);
    expect(isApprovalPage('https://evil.example/authorize/abc123', ORIGIN)).toBe(false);
    expect(isApprovalPage('https://x.com/compose/post', ORIGIN)).toBe(false);

    const reads: number[] = [];
    const from = (url: string, text: string | undefined) =>
      approvalCodeFromTab({
        serviceOrigin: ORIGIN,
        activeTab: async () => ({ id: 7, url }),
        readPage: async (tabId) => {
          reads.push(tabId);
          return text;
        },
      });
    expect(await from(authorizeUrl, ' qk7d-m4xr ')).toBe('QK7D-M4XR');
    expect(reads).toEqual([7]);
    // The QR's page carries the code in its URL; nothing is run in the tab.
    expect(await from(`${ORIGIN}/approve?code=QK7D-M4XR`, undefined)).toBe('QK7D-M4XR');
    expect(reads).toEqual([7]);
    // Another site, however it looks, is never read; a page with no code gives nothing.
    expect(await from('https://evil.example/authorize/abc123', 'QK7D-M4XR')).toBeUndefined();
    expect(await from(authorizeUrl, 'not a code <script>')).toBeUndefined();
    expect(reads).toEqual([7, 7]);
  });

  it('opens the popup on the approval with the code filled in, waiting for Look up', async () => {
    const a = await createdDevice(network());
    mount(<App deps={a.deps} tabApprovalCode={async () => 'QK7D-M4XR'} />);
    await until(() => host().querySelector('#approval-code') !== null);
    expect($<HTMLInputElement>('#approval-code').value).toBe('QK7D-M4XR');
    expect(host().textContent).toContain('the sign-in page in this tab');
    // No permission check is available, so nothing is requested without the user's click.
    expect(a.permissionRequests).toBe(0);
    expect(button('Look up').disabled).toBe(false);
  });

  it('looks the code up on its own when the service permission is already granted', async () => {
    const a = await createdDevice(network());
    const fetched: string[] = [];
    const deps: SetupDeps = {
      ...a.deps,
      hasServicePermission: async () => true,
      fetch: async (input) => {
        fetched.push(String(input));
        return new Response('{}', { status: 404 });
      },
    };
    mount(<App deps={deps} tabApprovalCode={async () => 'QK7D-M4XR'} />);
    await until(() => host().textContent?.includes('That code is unknown or expired') === true);
    expect(fetched.some((url) => url.startsWith(ORIGIN))).toBe(true);
    expect(a.permissionRequests).toBe(0);
  });

  it('stays home on any other tab', async () => {
    const a = await createdDevice(network());
    mount(<App deps={a.deps} tabApprovalCode={async () => undefined} />);
    await until(() => host().querySelector('[aria-label^="Menu"]') !== null);
    await settle();
    expect(host().querySelector('#approval-code')).toBeNull();
  });
});

/** The form with its own state, as the screens hold it. */
function StatefulForm(props: { start: ApprovalChoices }) {
  const [choices, setChoices] = useState(props.start);
  return <GrantForm destinations={[X_LOKKJU]} choices={choices} onChange={setChoices} />;
}

describe('the compact grant form', () => {
  it('folds the limits into one line that Change expands', async () => {
    mount(<StatefulForm start={defaultChoices(request, [X_LOKKJU])} />);
    expect($('#limits-summary').textContent).toBe(
      'Limits: 50 drafts a day · unread drafts expire after 30 days · no end date'
    );
    expect(host().querySelector('#quota-max')).toBeNull();
    expect(host().querySelector('#agent-label')).toBeNull();
    // No free-text fields input on a one-field site (critique A2).
    expect(host().querySelector('input[aria-label^="Fields for"]')).toBeNull();
    const change = button('Change limits');
    expect(change.getAttribute('aria-expanded')).toBe('false');
    change.click();
    await settle();
    expect(button('Hide limits').getAttribute('aria-expanded')).toBe('true');
    for (const id of ['quota-max', 'quota-period', 'submission-expiration', 'grant-expires']) {
      expect(host().querySelector(`#${id}`)).not.toBeNull();
    }
    const quota = $<HTMLInputElement>('#quota-max');
    quota.value = '1';
    quota.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect($('#limits-summary').textContent).toContain('1 draft a day');
    button('Hide limits').click();
    await settle();
    expect(host().querySelector('#quota-max')).toBeNull();
    expect($('#limits-summary').textContent).toContain('1 draft a day');
  });

  it('says an end date in the summary', () => {
    const at = Math.floor(new Date('2031-03-04T23:59:59').getTime() / 1000);
    expect(limitsSummary({ ...defaultChoices(request), expiresAt: at })).toContain(
      'access ends 2031-03-04'
    );
  });

  it('pins Approve and Deny, and any error, in the bottom bar', () => {
    mount(
      <ApprovalReview
        request={request}
        destinations={[X_LOKKJU]}
        choices={defaultChoices(request, [X_LOKKJU])}
        busy={undefined}
        error="The quota must be a whole number of at least 1."
        onChange={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onBack={() => {}}
      />
    );
    const bar = $('[data-bottom-bar]');
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Approve',
      'Deny',
    ]);
    expect(bar.querySelector('[role="alert"]')?.textContent).toContain('quota');
    // The label sits under Details in the request card, prefilled with the client's name.
    const label = $<HTMLInputElement>('#agent-label');
    expect(label.closest('details')).not.toBeNull();
    expect(label.value).toBe('Claude');
  });

  it('gives Edit access the same pinned bar and Details', () => {
    const choices = defaultChoices(request, [X_LOKKJU]);
    mount(
      <EditGrantView
        agent={{ agentPubkey: 'b'.repeat(64), label: 'Claude', listed: true }}
        destinations={[X_LOKKJU]}
        start={{ choices, dropped: [] }}
        choices={choices}
        busy={undefined}
        error={undefined}
        onChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    expect(
      [...$('[data-bottom-bar]').querySelectorAll('button')].map((b) => b.textContent)
    ).toEqual(['Save', 'Cancel']);
    expect($('#agent-label').closest('details')).not.toBeNull();
    expect(host().querySelector('#limits-summary')).not.toBeNull();
  });
});

/** A store whose unlock waits until the test settles it. */
function slowStore() {
  let settle: (error?: Error) => void = () => {};
  const store = {
    unlock: () =>
      new Promise<void>((resolve, reject) => {
        settle = (error) => (error === undefined ? resolve() : reject(error));
      }),
  } as unknown as KeyStore;
  return { store, settle: (error?: Error) => settle(error) };
}

const unlockDeps = (store: KeyStore) =>
  ({
    store,
    serviceOrigin: ORIGIN,
    fetch,
    requestServicePermission: async () => true,
  }) as SetupDeps;

describe('unlock', () => {
  const type = (value: string) => {
    const input = $<HTMLInputElement>('#unlock-passphrase');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () =>
    $<HTMLFormElement>('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );

  it('focuses the passphrase and shows progress while the key opens', async () => {
    const slow = slowStore();
    let unlocked = 0;
    mount(<Unlock deps={unlockDeps(slow.store)} onUnlocked={() => (unlocked += 1)} />);
    // Effects run after the first paint.
    await until(() => document.activeElement?.id === 'unlock-passphrase');
    const status = $('[data-unlock-progress]');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    type('plum anchor violet seventeen');
    await settle();
    submit();
    await until(() => status.textContent?.includes('Opening your queue') === true);
    expect(button('Unlocking…').disabled).toBe(true);
    slow.settle();
    await until(() => unlocked === 1);
    expect(status.textContent).toBe('');
  });

  it('says a wrong passphrase and puts the focus back', async () => {
    const slow = slowStore();
    mount(<Unlock deps={unlockDeps(slow.store)} onUnlocked={() => {}} />);
    await settle();
    type('wrong');
    await settle();
    submit();
    await until(() => $('[data-unlock-progress]').textContent !== '');
    slow.settle(new WrongPassphrase());
    await until(() => host().querySelector('[role="alert"]') !== null);
    expect($('[data-unlock-progress]').textContent).toBe('');
    expect(document.activeElement?.id).toBe('unlock-passphrase');
  });

  it('leads a forgotten passphrase to recovery by code, and back', async () => {
    const a = await createdDevice(network());
    await a.store.lock();
    mount(<App deps={a.deps} />);
    await until(() => host().querySelector('#unlock-passphrase') !== null);
    expect(host().textContent).not.toContain('npub1');
    button('Forgot your passphrase? Recover with your code').click();
    await until(() => host().querySelector('#recover-sheet') !== null);
    expect($('#screen-title').textContent).toBe('Recover a queue');
    expect($('[data-forgot]').textContent).toContain('replaces the one you forgot');
    button('Back').click();
    await until(() => host().querySelector('#unlock-passphrase') !== null);
  });
});

describe('disabled buttons', () => {
  it('look the same in every variant: plain, muted, never faded', () => {
    for (const variant of ['primary', 'plain', 'danger'] as const) {
      mount(
        <Button variant={variant} disabled>
          Go
        </Button>
      );
      const cls = $('button').className;
      expect(cls).toContain('disabled:bg-band');
      expect(cls).toContain('disabled:text-muted');
      expect(cls).toContain('disabled:border-line');
      expect(cls).not.toContain('opacity');
      render(null, host());
    }
  });
});
