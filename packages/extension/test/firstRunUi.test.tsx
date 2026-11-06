// @vitest-environment happy-dom
/**
 * The create and recover screens driven in happy-dom against the fake relays: the passphrase
 * feedback and suggestion (#73), the recovery sheet at setup and pasted at recovery (#71).
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverySheetText } from '../src/setup/recoverySheet.ts';
import { CreateScreen } from '../src/ui/create.tsx';
import { RecoverScreen } from '../src/ui/recover.tsx';
import { createdDevice, device, INBOX, network, STORAGE, until } from './helpers.ts';

const SUGGESTED = 'orbit lantern cedar wobble kettle';

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  document.body.innerHTML = '';
});

function mount(node: preact.ComponentChild) {
  root = document.createElement('div');
  document.body.append(root);
  render(node, root);
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`no ${selector}`);
  return el;
};
const button = (text: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
};
const type = (selector: string, value: string) => {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(selector);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('create screen', { timeout: 30_000 }, () => {
  it('states the rule, gives live feedback and suggests a passphrase', async () => {
    const d = device(network());
    mount(
      <CreateScreen deps={d.deps} onDone={() => {}} onBack={() => {}} suggest={() => SUGGESTED} />
    );
    expect(root.textContent).toContain('four or more random words, or 16 or more characters');
    const status = $('#new-passphrase-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    type('#new-passphrase', 'kqzvjwmxrpbt');
    await settle();
    expect(status.textContent).toMatch(/^Almost\. .*13 or more characters/);
    expect($('[data-level]').dataset.level).toBe('2');
    expect(button('Next').disabled).toBe(true);
    button('Suggest one').click();
    await settle();
    expect($<HTMLInputElement>('#new-passphrase').value).toBe(SUGGESTED);
    expect($<HTMLInputElement>('#new-passphrase-confirm').value).toBe(SUGGESTED);
    expect($<HTMLInputElement>('#new-passphrase').type).toBe('text');
    expect(status.textContent).toBe('Strong.');
    expect(button('Next').disabled).toBe(false);
  });

  it('shows the Queue ID and storage servers with the code, then confirms both and creates', async () => {
    const net = network();
    const d = device(net);
    let done = false;
    mount(
      <CreateScreen
        deps={d.deps}
        onDone={() => {
          done = true;
        }}
        onBack={() => {}}
        suggest={() => SUGGESTED}
      />
    );
    button('Suggest one').click();
    await settle();
    button('Next').click();
    await settle();
    type('#storage-relays', STORAGE.join('\n'));
    type('#inbox-relays', INBOX.join('\n'));
    await settle();
    button('Check relays').click();
    await until(() => !button('Next').disabled);
    button('Next').click();
    await settle();

    expect(root.textContent).toContain('Save your recovery sheet');
    const npub = root.querySelector('dd')?.textContent ?? '';
    expect(npub).toMatch(/^npub1/);
    for (const url of STORAGE) expect(root.textContent).toContain(url);
    expect(root.textContent).toContain('Queue ID (npub)');
    expect(root.textContent).toContain('Storage servers (relays)');
    button('Download recovery sheet');
    button('Printable version');
    const words = [...root.querySelectorAll('ol li')].map((li) => li.textContent ?? '');
    expect(words).toHaveLength(12);
    button('Next').click();
    await settle();

    expect(root.textContent).toContain(npub);
    type('#code-typed', words.join(' '));
    await settle();
    expect(button('Create queue').disabled).toBe(true);
    $<HTMLInputElement>('#sheet-saved').click();
    await settle();
    button('Create queue').click();
    await until(() => root.textContent?.includes('Queue created') === true, 20_000);
    expect((await d.store.record())?.storageRelays).toEqual(STORAGE);
    button('Done').click();
    expect(done).toBe(true);
  });
});

describe('recover screen', { timeout: 30_000 }, () => {
  it('takes a pasted sheet in one box', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    mount(<RecoverScreen deps={b.deps} onDone={() => {}} onBack={() => {}} />);
    type(
      '#recover-sheet',
      recoverySheetText({
        words: a.words.split(' '),
        base32: a.base32,
        npub: a.npub,
        storageRelays: STORAGE,
        inboxRelays: INBOX,
        createdAt: new Date(),
      })
    );
    await settle();
    expect($('#recover-sheet-found').textContent).toBe(
      'Queue ID found, recovery code found, 2 storage servers.'
    );
    button('Recover').click();
    await until(() => root.textContent?.includes('Choose a passphrase') === true, 20_000);
  });

  it('asks for a storage server only when the default ones do not have the queue', async () => {
    const net = network();
    net.add('wss://default-empty.example');
    const a = await createdDevice(net);
    const b = device(net);
    b.deps.defaultStorageRelays = ['wss://default-empty.example'];
    mount(<RecoverScreen deps={b.deps} onDone={() => {}} onBack={() => {}} />);
    expect(root.querySelector('#recover-relay')).toBeNull();
    type('#recover-sheet', `${a.npub}\n${a.words}`);
    await settle();
    button('Recover').click();
    await until(() => root.querySelector('#recover-relay') !== null);
    expect(root.textContent).toContain('isn’t on the default storage servers');
    type('#recover-relay', STORAGE[0] as string);
    await settle();
    button('Recover').click();
    await until(() => root.textContent?.includes('Choose a passphrase') === true, 20_000);
  });
});
