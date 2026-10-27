import { v2 } from 'nostr-tools/nip44';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  type AgentGrantInput,
  buildAgentGrant,
  KIND_AGENT_GRANT,
  nip44Encrypt,
  parseAgentGrant,
  quotaPeriodStart,
} from '../src/index.ts';
import {
  agent,
  agentKey,
  agentPubkey,
  expectError,
  expectOk,
  NOW,
  other,
  queue,
  queueKey,
  queuePubkey,
  sign,
  tamper,
} from './helpers.ts';

const input: AgentGrantInput = {
  inbox: ['wss://relay.example/'],
  destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
  quota: { max_submissions: 50, period: 'day' },
};

const grantWith = (content: unknown, d = agentPubkey) =>
  sign({
    kind: KIND_AGENT_GRANT,
    created_at: NOW,
    tags: [['d', d]],
    content: nip44Encrypt(
      queueKey,
      agentPubkey,
      typeof content === 'string' ? content : JSON.stringify(content)
    ),
  });

describe('agent grant (spec 7.4)', () => {
  it('round-trips with defaults written out, readable by the agent and the queue', async () => {
    const event = await buildAgentGrant(queue, agentPubkey, input, { createdAt: NOW });
    expect(event.kind).toBe(KIND_AGENT_GRANT);
    expect(event.tags).toEqual([['d', agentPubkey]]);
    expect(verifyEvent({ ...event })).toBe(true);
    const key = v2.utils.getConversationKey(agentKey, queuePubkey);
    const full = {
      ...input,
      allow_new_destinations: false,
      submission_expiration_days: 30,
      expires_at: null,
    };
    expect(JSON.parse(v2.decrypt(event.content, key))).toEqual(full);
    for (const signer of [agent, queue]) {
      expect(expectOk(await parseAgentGrant(event, signer))).toEqual({
        id: event.id,
        pubkey: queuePubkey,
        agentPubkey,
        createdAt: NOW,
        grant: full,
      });
    }
  });

  it('keeps explicit allow_new_destinations, submission_expiration_days and expires_at', async () => {
    const event = await buildAgentGrant(queue, agentPubkey, {
      ...input,
      allow_new_destinations: true,
      submission_expiration_days: 90,
      expires_at: NOW + 86_400,
    });
    const { grant } = expectOk(await parseAgentGrant(event, agent));
    expect(grant.allow_new_destinations).toBe(true);
    expect(grant.submission_expiration_days).toBe(90);
    expect(grant.expires_at).toBe(NOW + 86_400);
  });

  it('applies the defaults when a grant leaves them out', async () => {
    const { grant } = expectOk(await parseAgentGrant(grantWith(input), agent));
    expect(grant.allow_new_destinations).toBe(false);
    expect(grant.submission_expiration_days).toBe(30);
    expect(grant.expires_at).toBeNull();
  });

  it('refuses to build or parse submission_expiration_days above 90', async () => {
    await expect(
      buildAgentGrant(queue, agentPubkey, { ...input, submission_expiration_days: 91 })
    ).rejects.toThrow(/invalid agent grant/);
    expectError(
      await parseAgentGrant(grantWith({ ...input, submission_expiration_days: 91 }), agent),
      'invalid_content'
    );
  });

  it('rejects a grant whose content does not decrypt', async () => {
    const event = sign({
      kind: KIND_AGENT_GRANT,
      created_at: NOW,
      tags: [['d', agentPubkey]],
      content: nip44Encrypt(queueKey, queuePubkey, JSON.stringify(input)),
    });
    expectError(await parseAgentGrant(event, agent), 'decrypt_failed');
  });

  it('rejects a reader that is neither the queue nor the agent', async () => {
    expectError(
      await parseAgentGrant(await buildAgentGrant(queue, agentPubkey, input), other),
      'wrong_author'
    );
  });

  it('rejects malformed grants', async () => {
    const cases: unknown[] = [
      { ...input, inbox: [] },
      { ...input, inbox: ['https://relay.example'] },
      { ...input, destinations: [{ site: 'x', account: 'lokkju', fields: [] }] },
      { ...input, destinations: [{ site: 'x', account: 'lokkju' }] },
      { ...input, quota: { max_submissions: 0, period: 'day' } },
      { ...input, quota: { max_submissions: 5, period: 'year' } },
      { ...input, allow_new_destinations: 'yes' },
      { ...input, expires_at: 'never' },
      { inbox: input.inbox, destinations: input.destinations },
      { ...input, scopes: ['all'] },
    ];
    for (const content of cases) {
      expectError(await parseAgentGrant(grantWith(content), agent), 'invalid_content');
    }
    expectError(await parseAgentGrant(grantWith(input, 'notapubkey'), agent), 'invalid_tags');
    const event = await buildAgentGrant(queue, agentPubkey, input);
    expectError(
      await parseAgentGrant(tamper(event, { tags: [['d', queuePubkey]] }), agent),
      'bad_signature'
    );
  });
});

describe('quota periods (UTC calendar, spec 7.4)', () => {
  // 2026-10-28T15:30:00Z, a Wednesday
  const t = Date.UTC(2026, 9, 28, 15, 30) / 1000;

  it('starts days at 00:00 UTC, weeks on Monday, months on the first', () => {
    expect(quotaPeriodStart('day', t)).toBe(Date.UTC(2026, 9, 28) / 1000);
    expect(quotaPeriodStart('week', t)).toBe(Date.UTC(2026, 9, 26) / 1000);
    expect(quotaPeriodStart('month', t)).toBe(Date.UTC(2026, 9, 1) / 1000);
  });

  it('puts Sunday in the week that began the Monday before, across a month boundary', () => {
    const sunday = Date.UTC(2026, 10, 1, 23, 59) / 1000;
    expect(quotaPeriodStart('week', sunday)).toBe(Date.UTC(2026, 9, 26) / 1000);
    const monday = Date.UTC(2026, 10, 2) / 1000;
    expect(quotaPeriodStart('week', monday)).toBe(monday);
  });
});
