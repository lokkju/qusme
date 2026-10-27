import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildSubmittersList,
  KIND_SUBMITTERS,
  nip44Encrypt,
  parseSubmittersList,
  parseSubmittersPublic,
} from '../src/index.ts';
import {
  agentPubkey,
  expectError,
  expectOk,
  NOW,
  other,
  otherPubkey,
  queue,
  queueKey,
  queuePubkey,
  sign,
} from './helpers.ts';

const labels = {
  [agentPubkey]: { label: 'Claude Desktop', authorized_at: NOW },
  [otherPubkey]: { label: 'Other agent', authorized_at: NOW + 1 },
};

const listWith = (tags: string[][], content: unknown) =>
  sign({
    kind: KIND_SUBMITTERS,
    created_at: NOW,
    tags,
    content: nip44Encrypt(queueKey, queuePubkey, JSON.stringify(content)),
  });

describe('submitters list (spec 7.3)', () => {
  it('round-trips public p tags and encrypted labels', async () => {
    const event = await buildSubmittersList(queue, labels, { createdAt: NOW });
    expect(event.kind).toBe(KIND_SUBMITTERS);
    expect(event.tags).toEqual([
      ['p', agentPubkey],
      ['p', otherPubkey],
    ]);
    expect(event.content).not.toContain('Claude');
    expect(verifyEvent({ ...event })).toBe(true);
    const parsed = expectOk(await parseSubmittersList(event, queue));
    expect(parsed).toEqual({
      id: event.id,
      pubkey: queuePubkey,
      createdAt: NOW,
      submitters: [agentPubkey, otherPubkey],
      labels,
    });
  });

  it('lets anyone read the p tags without the queue key', async () => {
    const event = await buildSubmittersList(queue, labels);
    const pub = expectOk(parseSubmittersPublic(event, { queuePubkey }));
    expect(pub.submitters).toEqual([agentPubkey, otherPubkey]);
    expect(pub).not.toHaveProperty('labels');
    expect(pub).not.toHaveProperty('content');
    expectError(parseSubmittersPublic(event, { queuePubkey: otherPubkey }), 'wrong_author');
  });

  it('builds an empty list', async () => {
    const event = await buildSubmittersList(queue, {});
    expect(expectOk(await parseSubmittersList(event, queue)).submitters).toEqual([]);
  });

  it('rejects labels that do not match the p tags, bad p tags and bad labels', async () => {
    const one = { [agentPubkey]: labels[agentPubkey] };
    expectError(
      await parseSubmittersList(listWith([['p', agentPubkey]], labels), queue),
      'invalid_content'
    );
    expectError(
      await parseSubmittersList(
        listWith(
          [
            ['p', agentPubkey],
            ['p', otherPubkey],
          ],
          one
        ),
        queue
      ),
      'invalid_content'
    );
    expectError(
      await parseSubmittersList(
        listWith(
          [
            ['p', agentPubkey],
            ['p', agentPubkey],
          ],
          one
        ),
        queue
      ),
      'invalid_tags'
    );
    expectError(await parseSubmittersList(listWith([['p', 'nothex']], one), queue), 'invalid_tags');
    expectError(
      await parseSubmittersList(
        listWith([['p', agentPubkey]], { [agentPubkey]: { label: 'x' } }),
        queue
      ),
      'invalid_content'
    );
    expectError(
      await parseSubmittersList(listWith([], { __proto__: null, constructor: {} }), queue),
      'invalid_content'
    );
    expectError(
      await parseSubmittersList(await buildSubmittersList(queue, labels), other),
      'wrong_author'
    );
  });
});
