/**
 * The slice of `browser.storage.local` and `browser.storage.session` the extension uses, so the
 * key store runs against an in-memory area in tests.
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/** An in-memory {@link StorageArea}. Values are copied through JSON, as the browser's are. */
export class MemoryStorageArea implements StorageArea {
  readonly data = new Map<string, string>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const value = this.data.get(key);
      if (value !== undefined) out[key] = JSON.parse(value);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, JSON.stringify(value));
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  /** Everything stored, as one string, for tests that look for a secret anywhere in the area. */
  dump(): string {
    return [...this.data.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  }
}
