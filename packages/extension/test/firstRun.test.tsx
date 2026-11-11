/** The first-run checklist (src/firstRun.ts) against the fake storage relays. */
import { buildSubmittersList } from '@qusme/nostr';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import {
  type ChecklistState,
  checklistDone,
  LOCAL_FIRST_RUN,
  loadChecklist,
  markPaired,
  readFirstRun,
  updateFirstRun,
} from '../src/firstRun.ts';
import { ChecklistView } from '../src/ui/firstRun.tsx';
import { destinationsQueue, ORIGIN } from './helpers.ts';

const view = (state: ChecklistState) =>
  renderToString(
    <ChecklistView
      state={state}
      serviceOrigin={ORIGIN}
      onAddDestination={() => {}}
      onPair={() => {}}
      onSkipPair={() => {}}
      onDismiss={() => {}}
    />
  );

describe('first-run checklist', { timeout: 30_000 }, () => {
  it('starts with nothing ticked on a new queue', async () => {
    const q = await destinationsQueue({ destinations: [] });
    expect(await loadChecklist(q.deps)).toEqual({
      agent: false,
      destination: false,
      device: false,
      dismissed: false,
    });
    q.close();
  });

  it('ticks each item from the queue state: a destination, an agent, a paired or skipped device', async () => {
    const q = await destinationsQueue();
    expect(await loadChecklist(q.deps)).toMatchObject({ destination: true, agent: false });

    const agent = getPublicKey(generateSecretKey());
    await q.publish(
      await buildSubmittersList(q.queue, { [agent]: { label: 'Claude', authorized_at: 1 } })
    );
    const ticked = await loadChecklist(q.deps);
    expect(ticked).toMatchObject({ destination: true, agent: true, device: false });
    expect(checklistDone(ticked as ChecklistState)).toBe(false);

    await updateFirstRun(q.store.local, q.pubkey, { device: 'skipped' });
    const done = (await loadChecklist(q.deps)) as ChecklistState;
    expect(done).toMatchObject({ destination: true, agent: true, device: true });
    expect(checklistDone(done)).toBe(true);
    q.close();
  });

  it('counts a pairing on either side, and an agent bound at the service', async () => {
    const q = await destinationsQueue({ destinations: [] });
    await markPaired(q.deps);
    expect(await readFirstRun(q.store.local, q.pubkey)).toEqual({
      queuePubkey: q.pubkey,
      device: 'paired',
    });
    const agent = getPublicKey(generateSecretKey());
    q.deps.fetch = (async () =>
      new Response(
        JSON.stringify({
          bindings: [{ agent_pubkey: agent, client_id: 'https://claude.ai/oauth', created_at: 1 }],
        }),
        { status: 200 }
      )) as typeof fetch;
    expect(await loadChecklist(q.deps)).toMatchObject({ agent: true, device: true });
    q.close();
  });

  it('stays hidden once dismissed, and ignores a record for another queue', async () => {
    const q = await destinationsQueue({ destinations: [] });
    await q.store.local.set({
      [LOCAL_FIRST_RUN]: { queuePubkey: 'f'.repeat(64), dismissed: true },
    });
    expect(await loadChecklist(q.deps)).toMatchObject({ dismissed: false });
    await updateFirstRun(q.store.local, q.pubkey, { dismissed: true });
    const state = (await loadChecklist(q.deps)) as ChecklistState;
    expect(checklistDone(state)).toBe(true);
    expect(view(state)).toBe('');
    await q.store.lock();
    expect(await loadChecklist(q.deps)).toBeUndefined();
    q.close();
  });

  it('shows the connector address with a copy button and what is left', () => {
    const html = view({ agent: false, destination: true, device: false, dismissed: false });
    expect(html).toContain('Connect an agent');
    expect(html).toContain('value="https://app.qus.me/mcp"');
    expect(html).toContain('Copy');
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('Add the account you post from');
    expect(html).toContain('(done)');
    expect(html).toContain('Pair your phone');
    expect(html).toContain('optional');
    expect(html).toContain('Hide this checklist');
    // Names no particular app or site in the item titles (critique H7).
    expect(html).not.toContain('Claude');
    expect(html).not.toContain('Add your X account');
  });

  it('opens with the queue as a ticked line naming its servers by host', () => {
    const html = renderToString(
      <ChecklistView
        state={{ agent: false, destination: false, device: false, dismissed: false }}
        serviceOrigin={ORIGIN}
        servers={['wss://relay.primal.net', 'wss://relay.ditto.pub/']}
        onAddDestination={() => {}}
        onPair={() => {}}
        onSkipPair={() => {}}
      />
    );
    expect(html).toContain('Your queue is ready');
    expect(html).toContain('Queue stored on 2 servers');
    expect(html).toContain('relay.primal.net and relay.ditto.pub.');
    expect(html).toContain('0 of 3 done');
    expect(html).not.toContain('wss://');
    // Without onDismiss (the create flow's last step), no Hide.
    expect(html).not.toContain('Hide this checklist');
  });
});
