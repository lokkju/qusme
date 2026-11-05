import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { updateSnapshot } from '../scripts/registry-update.ts';
import { KIND_SITE_DEF, REGISTRY_SNAPSHOT_FORMAT } from '../src/index.ts';

const key = generateSecretKey();
const pinned = getPublicKey(key);

const snapshotWith = (version: string, signer = key) => ({
  format: REGISTRY_SNAPSHOT_FORMAT,
  publisher: getPublicKey(signer),
  siteDefinitions: [
    finalizeEvent(
      {
        kind: KIND_SITE_DEF,
        created_at: 1_793_836_800,
        tags: [['d', 'example']],
        content: JSON.stringify({
          id: 'example',
          version,
          name: 'Example',
          match: ['https://example.com/*'],
          fields: [
            {
              name: 'text',
              label: 'Text',
              locators: [{ role: 'textbox', name: { en: ['Text'] } }],
              inject: ['paste'],
            },
          ],
        }),
      },
      signer
    ),
  ],
});

function files(source: unknown, target?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'qusme-registry-update-'));
  const paths = { source: join(dir, 'source.json'), target: join(dir, 'target.json') };
  writeFileSync(paths.source, JSON.stringify(source));
  if (target !== undefined) writeFileSync(paths.target, JSON.stringify(target));
  return paths;
}

describe('pnpm registry:update', () => {
  it('writes a snapshot that verifies against the pin', () => {
    const paths = files(snapshotWith('2026.11.2'), snapshotWith('2026.11.1'));
    const lines = updateSnapshot({ ...paths, pinned });
    expect(lines).toContain('example: 2026.11.1 -> 2026.11.2');
    expect(JSON.parse(readFileSync(paths.target, 'utf8'))).toEqual(
      JSON.parse(readFileSync(paths.source, 'utf8'))
    );
  });

  it('refuses a snapshot signed by another key and leaves the target alone', () => {
    const paths = files(snapshotWith('2026.11.2', generateSecretKey()), snapshotWith('2026.11.1'));
    expect(() => updateSnapshot({ ...paths, pinned })).toThrow(/publisher/);
    const target = JSON.parse(readFileSync(paths.target, 'utf8'));
    expect(target.siteDefinitions[0].content).toContain('2026.11.1');
  });

  it('refuses a downgrade unless asked', () => {
    const paths = files(snapshotWith('2026.10.9'), snapshotWith('2026.11.1'));
    expect(() => updateSnapshot({ ...paths, pinned })).toThrow(/older than the bundled/);
    expect(updateSnapshot({ ...paths, pinned, allowDowngrade: true })[0]).toMatch(/allowed/);
  });
});
