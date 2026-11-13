import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { powOf } from '@qusme/nostr';
import { afterEach, describe, expect, it } from 'vitest';
import { RECEIPTS_FILE, readState } from '../src/index.ts';
import { eventually, INBOX, localServer, queueOnFakeRelays, STORAGE, tempDir } from './helpers.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function started(...args: Parameters<typeof localServer>) {
  const s = await localServer(...args);
  closers.push(s.close);
  return s;
}

/** Runs the whole approval: the server's request, the device finding it, the answer. */
async function approved(q = queueOnFakeRelays(), grant = {}) {
  const s = await started(q);
  const first = await s.call('list_destinations');
  expect(first.isError).toBe(true);
  const code = first.structuredContent.code as string;
  const found = await q.findRequest(code);
  if (!found.ok) throw new Error(`request not found: ${found.reason}`);
  await q.approve(s.agent.agentPubkey, grant);
  await q.answer(s.agent.agentPubkey, code, 'approved');
  return { q, s, code };
}

describe('local MCP server tools (spec 8.6)', () => {
  it('lists the registry without an approval', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q);
    const result = await s.call('list_registry');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sites: [] });
  });

  it('asks for approval with a code, sent to the inbox relay with the client name', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q);
    const result = await s.call('list_destinations');
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe('approval_required');
    const code = result.structuredContent.code as string;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(result.structuredContent.message).toContain(code);
    expect(s.lines.join('\n')).toContain(code);

    const found = await q.findRequest(code);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.request.agentPubkey).toBe(s.agent.agentPubkey);
    expect(found.request.clientName).toBe('Claude Desktop');
    // Asking again reuses the pending code rather than spamming the inbox.
    const again = await s.call('get_definition', { site: 'x', account: 'lokkju' });
    expect(again.structuredContent.code).toBe(code);
    expect(q.inbox.events.length).toBe(1);
  });

  it('takes --name over what the client reports', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q, { name: 'Laptop agent' });
    const code = (await s.call('list_destinations')).structuredContent.code as string;
    const found = await q.findRequest(code);
    expect(found.ok && found.request.clientName).toBe('Laptop agent');
  });

  it('reads the grant from the storage relays once the device answers', async () => {
    const { s } = await approved();
    const result = await s.call('list_destinations');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      destinations: [{ site: 'x', account: 'lokkju' }],
      allow_new_destinations: false,
      quota: { max_submissions: 50, used: 0 },
    });
    expect(readState(s.dir)?.storage_relays).toEqual([STORAGE]);
    expect(readState(s.dir)?.request).toBeUndefined();
  });

  it('publishes a draft to the inbox key and keeps a contentless receipt', async () => {
    const { q, s } = await approved();
    const result = await s.call('create_draft', {
      site: 'x',
      account: '@LOKKJU',
      field: 'text',
      value: 'a secret draft',
    });
    expect(result.isError).toBeFalsy();
    const id = result.structuredContent.gift_wrap_id as string;
    expect(result.structuredContent.relays).toEqual([INBOX]);
    expect(q.submissions().map((e) => e.id)).toEqual([id]);

    const log = readFileSync(join(s.dir, RECEIPTS_FILE), 'utf8');
    expect(log).toContain(id);
    expect(log).not.toContain('secret');
    expect(statSync(join(s.dir, RECEIPTS_FILE)).mode & 0o777).toBe(0o600);

    const listed = await s.call('list_submissions');
    expect(listed.structuredContent.submissions).toEqual([
      expect.objectContaining({ gift_wrap_id: id }),
    ]);
    const quota = (await s.call('list_destinations')).structuredContent.quota as { used: number };
    expect(quota.used).toBe(1);
  });

  it("mines the grant's min_pow locally", async () => {
    const { q, s } = await approved(undefined, { min_pow: 8 });
    const result = await s.call('create_draft', {
      site: 'x',
      account: 'lokkju',
      field: 'text',
      value: 'worked for',
    });
    expect(result.isError).toBeFalsy();
    const [wrap] = q.submissions();
    expect(powOf(wrap?.id ?? '')).toBeGreaterThanOrEqual(8);
  });

  it('refuses a min_pow above its cap', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q, { maxPow: 4 });
    const code = (await s.call('list_destinations')).structuredContent.code as string;
    await q.approve(s.agent.agentPubkey, { min_pow: 6 });
    await q.answer(s.agent.agentPubkey, code, 'approved');
    const result = await s.call('create_draft', {
      site: 'x',
      account: 'lokkju',
      field: 'text',
      value: 'hi',
    });
    expect(result.structuredContent).toMatchObject({
      error: 'grant_unusable',
      min_pow: 6,
      max_pow: 4,
    });
    expect(result.structuredContent.message).toContain('this local qus.me server');
    expect(q.submissions()).toEqual([]);
  });

  it('validates against the grant as the service does', async () => {
    const { s } = await approved();
    const result = await s.call('create_draft', {
      site: 'mastodon',
      account: 'lokkju',
      field: 'text',
      value: 'hi',
    });
    expect(result.structuredContent.error).toBe('destination_not_granted');
  });

  it('stops once the submitters list drops the agent', async () => {
    const { q, s } = await approved();
    await q.setSubmitters([]);
    const result = await s.call('list_destinations');
    expect(result.structuredContent.error).toBe('grant_revoked');
    expect(result.structuredContent.message).toContain('npx @qusme/mcp approve');
  });

  it('says the request was denied and offers a new code', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q);
    const code = (await s.call('list_destinations')).structuredContent.code as string;
    await q.answer(s.agent.agentPubkey, code, 'denied');
    const result = await s.call('list_destinations');
    expect(result.structuredContent.error).toBe('approval_required');
    expect(result.structuredContent.message).toContain('denied');
    expect(result.structuredContent.code).not.toBe(code);
  });

  it('ignores an approval answer not sealed by the queue key', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q);
    const code = (await s.call('list_destinations')).structuredContent.code as string;
    const other = queueOnFakeRelays();
    // A stranger answers on the same inbox relay, naming its own storage relay.
    const { buildAgentRequestAnswer, createLocalSigner } = await import('@qusme/nostr');
    const wrap = await buildAgentRequestAnswer(
      createLocalSigner(other.queueKey),
      s.agent.agentPubkey,
      { code, status: 'approved', storage: ['wss://evil.example'] }
    );
    q.inbox.accepted.length = 0;
    const { RelayConnection } = await import('@qusme/nostr');
    const c = await RelayConnection.open(INBOX, { socket: q.network.socket });
    await c.publish(wrap);
    c.close();
    const result = await s.call('list_destinations');
    expect(result.structuredContent.error).toBe('approval_required');
    expect(readState(s.dir)?.storage_relays).toBeUndefined();
  });

  it('sends the request once the client initializes, before any tool call', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q);
    await eventually(() => q.inbox.events.length === 1);
    const code = readState(s.dir)?.request?.code as string;
    const found = await q.findRequest(code);
    expect(found.ok).toBe(true);
  });

  it('keeps its approval across restarts', async () => {
    const { q, s } = await approved();
    await s.call('list_destinations');
    const again = await started(q, { dir: s.dir });
    expect(again.agent.agentPubkey).toBe(s.agent.agentPubkey);
    expect((await again.call('list_destinations')).isError).toBeFalsy();
  });

  it('starts over for another queue', async () => {
    const { s } = await approved();
    await s.call('list_destinations');
    const other = queueOnFakeRelays();
    const again = await started(other, { dir: s.dir });
    expect((await again.call('list_destinations')).structuredContent.error).toBe(
      'approval_required'
    );
    expect(readState(s.dir)?.queue_pubkey).toBe(other.queuePubkey);
  });

  it('reports an inbox relay it cannot reach', async () => {
    const q = queueOnFakeRelays();
    const s = await started(q, { inbox: ['wss://nowhere.example'], dir: tempDir() });
    const result = await s.call('list_destinations');
    expect(result.structuredContent.error).toBe('approval_required');
    expect(result.structuredContent.message).toContain('--inbox');
  });
});
