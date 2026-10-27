import type { QusmeDb } from '@qusme/store-sql';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';

const app = createApp({
  version: 'test-version',
  // No route touches the database yet.
  db: {} as QusmeDb,
  agentKeySecret: 'test-secret',
});

describe('createApp', () => {
  it('reports health and the build version', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'test-version' });
  });

  it('answers 501 on /mcp until MCP lands', async () => {
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(501);
  });

  it('answers 404 elsewhere', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
  });
});
