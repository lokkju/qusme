// @vitest-environment happy-dom
/**
 * The create and recover screens driven in happy-dom against the fake relays: the passphrase
 * feedback and suggestion (#73), the recovery sheet at setup and pasted at recovery (#71).
 */

import { KIND_DRAFT_WRAP } from '@qusme/nostr';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_RELAYS, DEFAULT_STORAGE_RELAYS } from '../src/setup/create.ts';
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

  /** Through the passphrase step to the server step. */
  async function toServers(net: ReturnType<typeof network>, onDone = () => {}) {
    const d = device(net);
    mount(
      <CreateScreen deps={d.deps} onDone={onDone} onBack={() => {}} suggest={() => SUGGESTED} />
    );
    button('Suggest one').click();
    await settle();
    button('Next').click();
    await settle();
    return d;
  }

  /** The sheet's words, then on to the confirmation. */
  async function sheetThenConfirm(): Promise<string[]> {
    expect(root.textContent).toContain('Save your recovery sheet');
    const words = [...root.querySelectorAll('ol li')].map((li) => li.textContent ?? '');
    expect(words).toHaveLength(12);
    button('Next').click();
    await settle();
    return words;
  }

  /** The word numbers the confirmation asks for, counted from 1, from its labels. */
  const askedFor = (): number[] =>
    [...root.querySelectorAll('label[for^="check-word-"]')].map((l) =>
      Number(l.textContent?.replace('Word ', ''))
    );

  it('checks the suggested servers on open and shows them as one line', async () => {
    const net = network();
    for (const url of DEFAULT_STORAGE_RELAYS) net.add(url);
    for (const url of DEFAULT_INBOX_RELAYS)
      net.add(url, { restrictGiftWraps: true, refuseKinds: [KIND_DRAFT_WRAP] });
    await toServers(net);
    expect(root.textContent).toContain('Storage servers');
    const line = () => $('[data-server-check]').textContent ?? '';
    // Checked without a click; Next is the only thing to press (F2).
    await until(() => line().includes('2 public servers, checked'));
    expect(line()).toContain('Stored on relay.primal.net and relay.ditto.pub');
    expect(line()).toContain('drafts arrive through auth.nostr1.com');
    expect(root.textContent).not.toContain('Nostr');
    // The addresses are under "Use other servers", closed.
    const details = root.querySelector('details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('Use other servers');
    expect(details.open).toBe(false);
    expect(details.querySelector('#storage-relays')).not.toBeNull();
    expect(button('Next').disabled).toBe(false);
  });

  it('confirms with three of the twelve words, then shows the checklist as its last step', async () => {
    const net = network();
    for (const url of DEFAULT_STORAGE_RELAYS) net.add(url);
    for (const url of DEFAULT_INBOX_RELAYS)
      net.add(url, { restrictGiftWraps: true, refuseKinds: [KIND_DRAFT_WRAP] });
    let done = false;
    const d = await toServers(net, () => {
      done = true;
    });
    await until(() => !button('Next').disabled);
    button('Next').click();
    await settle();

    const npub = root.querySelector('dd')?.textContent ?? '';
    expect(npub).toMatch(/^npub1/);
    expect(root.textContent).toContain('Queue ID');
    expect(root.textContent).not.toContain('(npub)');
    expect(root.textContent).not.toContain('(relays)');
    button('Download recovery sheet');
    button('Printable version');
    const words = await sheetThenConfirm();

    expect(root.textContent).toContain(npub);
    const asked = askedFor();
    expect(asked).toHaveLength(3);
    expect(new Set(asked).size).toBe(3);
    expect(asked).toEqual([...asked].sort((a, b) => a - b));
    expect(root.querySelector('legend')?.textContent).toBe(
      `Type words ${asked[0]}, ${asked[1]} and ${asked[2]} of your recovery code`
    );
    expect(root.querySelector('#code-typed')).toBeNull();
    $<HTMLInputElement>('#sheet-saved').click();
    await settle();
    // A word from the wrong position is refused.
    const wrong = words.find((_, i) => !asked.includes(i + 1)) as string;
    type('#check-word-0', wrong);
    type('#check-word-1', words[(asked[1] as number) - 1] as string);
    type('#check-word-2', words[(asked[2] as number) - 1] as string);
    await settle();
    button('Create queue').click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      `Those aren't words ${asked[0]}, ${asked[1]} and ${asked[2]} of the code shown. Check what you wrote down.`
    );
    expect(await d.store.record()).toBeUndefined();
    // Case and spaces don't matter.
    type('#check-word-0', ` ${(words[(asked[0] as number) - 1] as string).toUpperCase()} `);
    await settle();
    button('Create queue').click();
    await until(() => root.textContent?.includes('Your queue is ready') === true, 20_000);
    expect((await d.store.record())?.storageRelays).toEqual([...DEFAULT_STORAGE_RELAYS]);

    // The done step is the checklist: the queue ticked, the connector address with Copy (F6).
    expect(root.textContent).toContain('Queue stored on 2 servers');
    expect(root.textContent).toContain('relay.primal.net and relay.ditto.pub.');
    expect(root.textContent).toContain('Connect an agent');
    expect($<HTMLInputElement>('[aria-label="Connector address"]').value).toBe(
      'https://app.qus.me/mcp'
    );
    button('Copy');
    expect(root.textContent).toContain('Add the account you post from');
    expect(root.textContent).toContain('Pair your phone');
    expect(root.textContent).not.toContain('Hide this checklist');
    button('Go to drafts').click();
    expect(done).toBe(true);
  });

  it('takes other servers when the suggested ones fail, and the whole code instead of words', async () => {
    const net = network();
    const d = await toServers(net);
    const line = () => $('[data-server-check]').textContent ?? '';
    // The suggested servers aren't on this network: the check fails and says so.
    await until(() => line().includes("didn't pass the check"));
    expect(line()).toContain("3 of 3 servers didn't pass the check");
    expect((root.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(button('Next').disabled).toBe(true);
    type('#storage-relays', STORAGE.join('\n'));
    type('#inbox-relays', INBOX.join('\n'));
    await settle();
    button('Check servers').click();
    await until(() => !button('Next').disabled);
    expect(line()).toContain('2 servers, checked');
    expect(line()).not.toContain('public');
    button('Next').click();
    await settle();
    for (const url of STORAGE) expect(root.textContent).toContain(url);
    const words = await sheetThenConfirm();

    button('Type the whole code instead').click();
    await settle();
    expect(root.querySelector('#check-word-0')).toBeNull();
    type('#code-typed', words.join(' '));
    await settle();
    expect(button('Create queue').disabled).toBe(true);
    $<HTMLInputElement>('#sheet-saved').click();
    await settle();
    button('Create queue').click();
    await until(() => root.textContent?.includes('Your queue is ready') === true, 20_000);
    expect((await d.store.record())?.storageRelays).toEqual(STORAGE);
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
      'Recovery code found, Queue ID found, 2 storage servers.'
    );
    button('Recover').click();
    await until(() => root.textContent?.includes('Choose a passphrase') === true, 20_000);
  });

  it('offers another storage server when no relay asked has the queue', async () => {
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
    expect(root.textContent).toContain(
      'No recovery backup for that Queue ID on wss://default-empty.example'
    );
    type('#recover-relay', STORAGE[0] as string);
    await settle();
    button('Recover').click();
    await until(() => root.textContent?.includes('Choose a passphrase') === true, 20_000);
  });

  for (const withNpub of [true, false]) {
    it(`offers another storage server when no default relay can be reached (${
      withNpub ? 'Queue ID and code' : 'code alone'
    })`, async () => {
      const net = network();
      const a = await createdDevice(net);
      const b = device(net);
      b.deps.defaultStorageRelays = ['wss://gone-a.example', 'wss://gone-b.example'];
      mount(<RecoverScreen deps={b.deps} onDone={() => {}} onBack={() => {}} />);
      type('#recover-sheet', withNpub ? `${a.npub}\n${a.words}` : a.words);
      await settle();
      button('Recover').click();
      await until(() => root.querySelector('#recover-relay') !== null);
      expect(root.textContent).toContain(
        'Could not reach any of wss://gone-a.example, wss://gone-b.example.'
      );
      type('#recover-relay', STORAGE[0] as string);
      await settle();
      button('Recover').click();
      await until(() => root.textContent?.includes('Choose a passphrase') === true, 20_000);
    });
  }

  it('recovers from the 12 words alone, with no Queue ID', async () => {
    const net = network();
    const a = await createdDevice(net);
    const b = device(net);
    b.deps.defaultStorageRelays = STORAGE;
    mount(<RecoverScreen deps={b.deps} onDone={() => {}} onBack={() => {}} />);
    type('#recover-sheet', a.words);
    await settle();
    expect($('#recover-sheet-found').textContent).toBe(
      'Recovery code found, no Queue ID (not needed).'
    );
    button('Recover').click();
    await until(() => root.textContent?.includes('Choose a passphrase') === true, 20_000);
  });

  it('says plainly when the text is not a recovery code', async () => {
    const b = device(network());
    mount(<RecoverScreen deps={b.deps} onDone={() => {}} onBack={() => {}} />);
    type('#recover-sheet', 'abandon ability able about above absent absorb abstract');
    await settle();
    button('Recover').click();
    await until(() => root.textContent?.includes('That is not a recovery code') === true);
  });
});
