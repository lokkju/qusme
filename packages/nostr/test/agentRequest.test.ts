import { describe, expect, it } from 'vitest';
import {
  AGENT_REQUEST_TTL_SECONDS,
  buildAgentRequest,
  buildAgentRequestAnswer,
  findAgentRequest,
  giftWrap,
  KIND_AGENT_REQUEST,
  KIND_GIFT_WRAP,
  MAX_AGENT_REQUEST_TTL_SECONDS,
  openAgentRequest,
  openAgentRequestAnswer,
} from '../src/index.ts';
import {
  agent,
  agentPubkey,
  expectError,
  expectOk,
  NOW,
  other,
  otherPubkey,
  queue,
  queuePubkey,
} from './helpers.ts';

const request = (signer = agent, code = 'ABCD-1234', expiresAt = NOW + AGENT_REQUEST_TTL_SECONDS) =>
  buildAgentRequest(
    signer,
    queuePubkey,
    { clientName: 'Claude Desktop', code, expiresAt },
    { now: NOW }
  );

describe('local agent request (spec 7.7)', () => {
  it('is a gift wrap to the queue key that expires with the request', async () => {
    const wrap = await request();
    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(wrap.tags).toContainEqual(['p', queuePubkey]);
    expect(wrap.tags).toContainEqual(['expiration', String(NOW + AGENT_REQUEST_TTL_SECONDS)]);
    expect(wrap.content).not.toContain('ABCD');
    expect(wrap.content).not.toContain('Claude');
  });

  it('opens with the queue key, naming the agent by its seal', async () => {
    const opened = expectOk(await openAgentRequest(await request(), queue));
    expect(opened).toMatchObject({
      agentPubkey,
      clientName: 'Claude Desktop',
      code: 'ABCD1234',
      expiresAt: NOW + AGENT_REQUEST_TTL_SECONDS,
      createdAt: NOW,
    });
  });

  it('cleans the client name and refuses a request that would live too long', async () => {
    const wrap = await buildAgentRequest(
      agent,
      queuePubkey,
      { clientName: 'Evil‮\nName  ', code: 'abcd1234', expiresAt: NOW + 60 },
      { now: NOW }
    );
    expect(expectOk(await openAgentRequest(wrap, queue)).clientName).toBe('Evil Name');
    await expect(
      buildAgentRequest(
        agent,
        queuePubkey,
        { clientName: 'x', code: 'ABCD1234', expiresAt: NOW + MAX_AGENT_REQUEST_TTL_SECONDS + 1 },
        { now: NOW }
      )
    ).rejects.toThrow(/expires_at/);
  });

  it('refuses a gift wrap whose rumor is another kind', async () => {
    const wrap = await giftWrap({ kind: 1, content: '{}' }, agent, queuePubkey, { now: NOW });
    expectError(await openAgentRequest(wrap, queue), 'wrong_kind');
  });

  it('is found by its code, in any typed form', async () => {
    const wraps = [await request(agent, 'WXYZ-0000'), await request()];
    const found = await findAgentRequest(wraps, queue, 'abcd 1234', { now: NOW + 5 });
    expect(found.ok && found.request.agentPubkey).toBe(agentPubkey);
    expect(await findAgentRequest(wraps, queue, 'ZZZZ-ZZZZ', { now: NOW })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses an expired request', async () => {
    const wraps = [await request()];
    expect(
      await findAgentRequest(wraps, queue, 'ABCD-1234', { now: NOW + AGENT_REQUEST_TTL_SECONDS })
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a replayed request the device already answered', async () => {
    const wraps = [await request()];
    const first = await findAgentRequest(wraps, queue, 'ABCD-1234', { now: NOW });
    if (!first.ok) throw new Error('not found');
    const handled = new Set([first.request.rumorId]);
    expect(
      await findAgentRequest(wraps, queue, 'ABCD-1234', {
        now: NOW,
        handled: (r) => handled.has(r.rumorId),
      })
    ).toEqual({ ok: false, reason: 'handled' });
  });

  it('refuses a code two agent keys both sent', async () => {
    const wraps = [await request(), await request(other)];
    expect(await findAgentRequest(wraps, queue, 'ABCD-1234', { now: NOW })).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('round-trips an approval naming the storage relays back to the agent', async () => {
    const wrap = await buildAgentRequestAnswer(
      queue,
      agentPubkey,
      { code: 'ABCD-1234', status: 'approved', storage: ['wss://a.example', 'wss://a.example'] },
      { now: NOW }
    );
    expect(wrap.tags).toContainEqual(['p', agentPubkey]);
    const answer = expectOk(await openAgentRequestAnswer(wrap, agent, { queuePubkey }));
    expect(answer).toMatchObject({
      code: 'ABCD1234',
      status: 'approved',
      storage: ['wss://a.example'],
    });
  });

  it('refuses an answer not sealed by the queue key', async () => {
    const forged = await buildAgentRequestAnswer(
      other,
      agentPubkey,
      { code: 'ABCD-1234', status: 'approved', storage: ['wss://evil.example'] },
      { now: NOW }
    );
    expectError(await openAgentRequestAnswer(forged, agent, { queuePubkey }), 'wrong_author');
    expect(otherPubkey).not.toBe(queuePubkey);
  });

  it('carries a denial without relays', async () => {
    const wrap = await buildAgentRequestAnswer(
      queue,
      agentPubkey,
      { code: 'ABCD1234', status: 'denied' },
      { now: NOW }
    );
    const answer = expectOk(await openAgentRequestAnswer(wrap, agent, { queuePubkey }));
    expect(answer.status).toBe('denied');
    expect(answer.storage).toBeUndefined();
    expect(KIND_AGENT_REQUEST).toBe(21235);
  });
});
