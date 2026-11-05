import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The custody modules handle decrypted agent secret keys. None of them may log anything, so no
// secret key can reach a log through them; callers log only what custody returns (ids, pubkeys,
// error codes). Entrypoints that log rotation results print counts, ids and codes.
const src = join(import.meta.dirname, '..', 'src');
const custodyFiles = readdirSync(src).filter((f) => f.startsWith('agentKey'));

describe('agent key custody logging', () => {
  it('covers the custody modules', () => {
    expect(custodyFiles.sort()).toEqual(['agentKeyRing.ts', 'agentKeys.ts']);
  });

  it.each(custodyFiles)('%s makes no logging call', (file) => {
    const text = readFileSync(join(src, file), 'utf8');
    expect(text).not.toMatch(/\bconsole\s*\.|\blogger\b|\bdebug\s*\(/);
  });

  // The OAuth server handles authorization codes, tokens and PKCE verifiers; it logs nothing.
  it.each(readdirSync(join(src, 'oauth')))('oauth/%s makes no logging call', (file) => {
    const text = readFileSync(join(src, 'oauth', file), 'utf8');
    expect(text).not.toMatch(/\bconsole\s*\.|\blogger\b|\bdebug\s*\(/);
  });

  // The MCP tools hold submitted values in plaintext for the length of a call (spec 8.4, 13); they
  // log nothing, so no value outlives the call in a log.
  it.each(readdirSync(join(src, 'mcp')))('mcp/%s makes no logging call', (file) => {
    const text = readFileSync(join(src, 'mcp', file), 'utf8');
    expect(text).not.toMatch(/\bconsole\s*\.|\blogger\b|\bdebug\s*\(|\bonerror\b/);
  });

  it('entrypoints log rotation results without key material', () => {
    for (const file of [
      '../../entry-node/src/server.ts',
      '../../entry-node/src/rotateAgentKeys.ts',
      '../../entry-worker/src/index.ts',
    ]) {
      const text = readFileSync(join(src, file), 'utf8');
      for (const call of text.match(/console\.\w+\([^;]*\)/gs) ?? []) {
        // Messages may name the environment variables; the arguments may not touch a secret.
        const args = call.replace(/'[^']*'|`[^`]*`/g, "''");
        expect(args).not.toMatch(/secret|withAgentKey|openAgentSecret/i);
      }
    }
  });
});
