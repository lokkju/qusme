import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as kinds from '../src/kinds.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const kindValues = Object.entries(kinds)
  .filter(([name, value]) => name.startsWith('KIND_') && typeof value === 'number')
  .map(([, value]) => value as number);

describe('kind constants', () => {
  it('uses the NIP-assigned numbers for existing NIPs', () => {
    expect(kinds.KIND_SHORT_NOTE).toBe(1);
    expect(kinds.KIND_DELETION).toBe(5);
    expect(kinds.KIND_SEAL).toBe(13);
    expect(kinds.KIND_GIFT_WRAP).toBe(1059);
    expect(kinds.KIND_PRIVATE_RELAYS).toBe(10013);
    expect(kinds.KIND_HTTP_AUTH).toBe(27235);
    expect(kinds.KIND_APP_DATA).toBe(30078);
    expect(kinds.KIND_DRAFT_WRAP).toBe(31234);
  });

  it('puts each proposed kind in the NIP-01 range its semantics need', () => {
    // regular: 1000 <= n < 10000; replaceable: 10000 <= n < 20000; addressable: 30000 <= n < 40000
    expect(kinds.KIND_FIELD_VALUE).toBeGreaterThanOrEqual(1000);
    expect(kinds.KIND_FIELD_VALUE).toBeLessThan(10000);
    expect(kinds.KIND_SUBMITTERS).toBeGreaterThanOrEqual(10000);
    expect(kinds.KIND_SUBMITTERS).toBeLessThan(20000);
    for (const kind of [kinds.KIND_AGENT_GRANT, kinds.KIND_SITE_DEF]) {
      expect(kind).toBeGreaterThanOrEqual(30000);
      expect(kind).toBeLessThan(40000);
    }
  });

  it('gives every kind a distinct number', () => {
    expect(new Set(kindValues).size).toBe(kindValues.length);
  });

  it('accepts the current number first and never lists it as former', () => {
    const lists: [number, readonly number[], readonly number[]][] = [
      [kinds.KIND_FIELD_VALUE, kinds.KIND_FIELD_VALUE_FORMER, kinds.FIELD_VALUE_KINDS],
      [kinds.KIND_SUBMITTERS, kinds.KIND_SUBMITTERS_FORMER, kinds.SUBMITTERS_KINDS],
      [kinds.KIND_AGENT_GRANT, kinds.KIND_AGENT_GRANT_FORMER, kinds.AGENT_GRANT_KINDS],
      [kinds.KIND_SITE_DEF, kinds.KIND_SITE_DEF_FORMER, kinds.SITE_DEF_KINDS],
    ];
    for (const [current, former, accepted] of lists) {
      expect(accepted[0]).toBe(current);
      expect(former).not.toContain(current);
      expect(accepted).toEqual([current, ...former]);
    }
  });

  it('is the only source file that writes a kind number', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith('.ts') || file === 'kinds.ts') continue;
      const code = readFileSync(SRC + file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const match of code.matchAll(/\b\d{2,5}\b/g)) {
        const n = Number(match[0]);
        if (n >= 1000 && kindValues.includes(n)) offenders.push(`${file}: ${match[0]}`);
      }
      for (const match of code.matchAll(/kind\s*(?::|===|!==|==|!=)\s*(\d+)/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
