/**
 * The local receipt log (spec 8.6): one JSON line per published submission in `receipts.jsonl`,
 * mode 0600, holding the gift wrap id and times and never the value, as the service's receipts
 * do (8.5). `list_submissions` reads it, and the grant's quota is counted from it.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolReceipt } from '@qusme/core/mcp';

export const RECEIPTS_FILE = 'receipts.jsonl';

export interface ReceiptLog {
  append(receipt: ToolReceipt & { queuePubkey: string }): void;
  countSince(start: number): number;
  /** Unexpired receipts, newest first, before the cursor when one is given. */
  list(now: number, page: { before?: number; beforeId?: string; limit: number }): ToolReceipt[];
}

const HEX64 = /^[0-9a-f]{64}$/;

export function createReceiptLog(dir: string): ReceiptLog {
  const path = join(dir, RECEIPTS_FILE);

  function all(): ToolReceipt[] {
    if (!existsSync(path)) return [];
    const out: ToolReceipt[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (
          typeof r.gift_wrap_id === 'string' &&
          HEX64.test(r.gift_wrap_id) &&
          typeof r.created_at === 'number' &&
          typeof r.expires_at === 'number'
        ) {
          out.push({
            giftWrapId: r.gift_wrap_id,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
          });
        }
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    return out;
  }

  return {
    append(receipt) {
      const line = JSON.stringify({
        gift_wrap_id: receipt.giftWrapId,
        queue_pubkey: receipt.queuePubkey,
        created_at: receipt.createdAt,
        expires_at: receipt.expiresAt,
      });
      const created = !existsSync(path);
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
      if (created) chmodSync(path, 0o600);
    },
    countSince(start) {
      return all().filter((r) => r.createdAt >= start).length;
    },
    list(now, page) {
      return all()
        .filter((r) => r.expiresAt > now)
        .filter(
          (r) =>
            page.before === undefined ||
            r.createdAt < page.before ||
            (r.createdAt === page.before &&
              page.beforeId !== undefined &&
              r.giftWrapId < page.beforeId)
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a.giftWrapId < b.giftWrapId ? 1 : -1))
        .slice(0, page.limit);
    },
  };
}
