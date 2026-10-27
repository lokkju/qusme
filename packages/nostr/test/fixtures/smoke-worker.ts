// Bundled by workers.test.ts and run in workerd: the helpers using only what a Worker has.
import {
  createLocalSigner,
  decodeNcryptsec,
  encodeNcryptsec,
  giftWrap,
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  unwrapGiftWrap,
} from '../../src/index.ts';

const key = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

export default {
  async fetch(): Promise<Response> {
    const agent = createLocalSigner(key(1));
    const queue = createLocalSigner(key(2));
    const queuePubkey = await queue.getPublicKey();

    const selfPayload = await nip44EncryptToSelf(queue, 'to self');
    const wrap = await giftWrap({ kind: 1, content: 'wrapped' }, agent, queuePubkey, {
      expiration: Math.floor(Date.now() / 1000) + 86_400,
    });
    const opened = await unwrapGiftWrap(wrap, queue);
    // log_n 16 (64 MiB) stays inside a Worker's 128 MB memory limit.
    const ncryptsec = encodeNcryptsec(key(3), 'passphrase', { logN: 16 });

    return Response.json({
      self: await nip44DecryptFromSelf(queue, selfPayload),
      rumor: opened.rumor.content,
      sealedByAgent: opened.sealPubkey === (await agent.getPublicKey()),
      ncryptsec: Array.from(decodeNcryptsec(ncryptsec, 'passphrase')).every((b) => b === 3),
    });
  },
};
