import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nprofileEncode, npubEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import {
  AGENT_KEY_FILE,
  AgentKeyFileError,
  configDir,
  createReceiptLog,
  loadOrCreateAgentKey,
  parseQueueId,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

const PUBKEY = 'a'.repeat(64);

describe('config directory', () => {
  it('follows each platform', () => {
    expect(configDir({ env: {}, platform: 'linux', home: '/home/u' })).toBe(
      '/home/u/.config/qusme-mcp'
    );
    expect(configDir({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', home: '/home/u' })).toBe(
      '/x/qusme-mcp'
    );
    // A relative XDG_CONFIG_HOME is invalid per the spec and ignored.
    expect(configDir({ env: { XDG_CONFIG_HOME: 'rel' }, platform: 'linux', home: '/h' })).toBe(
      '/h/.config/qusme-mcp'
    );
    expect(configDir({ env: {}, platform: 'darwin', home: '/Users/u' })).toBe(
      '/Users/u/Library/Application Support/qusme-mcp'
    );
    expect(
      configDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', home: '' })
    ).toContain('qusme-mcp');
    expect(configDir({ env: { QUSME_MCP_CONFIG_DIR: '/o' }, platform: 'linux', home: '/h' })).toBe(
      '/o'
    );
  });
});

describe('agent key file', () => {
  it('is created once, owner-only, and read back', () => {
    const dir = tempDir();
    const key = loadOrCreateAgentKey(dir);
    expect(statSync(join(dir, AGENT_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(loadOrCreateAgentKey(dir)).toEqual(key);
    expect(JSON.parse(readFileSync(join(dir, AGENT_KEY_FILE), 'utf8')).version).toBe(1);
  });

  it('is refused when others can read it', () => {
    const dir = tempDir();
    loadOrCreateAgentKey(dir);
    chmodSync(join(dir, AGENT_KEY_FILE), 0o644);
    expect(() => loadOrCreateAgentKey(dir, 'linux')).toThrow(AgentKeyFileError);
    // Windows mode bits say nothing about access.
    expect(() => loadOrCreateAgentKey(dir, 'win32')).not.toThrow();
  });
});

describe('--queue', () => {
  it('reads an npub, an nprofile with its inbox hint, and hex', () => {
    expect(parseQueueId(npubEncode(PUBKEY))).toEqual({ pubkey: PUBKEY, relays: [] });
    expect(
      parseQueueId(
        nprofileEncode({ pubkey: PUBKEY, relays: ['wss://inbox.example', 'ws://insecure.example'] })
      )
    ).toEqual({ pubkey: PUBKEY, relays: ['wss://inbox.example'] });
    expect(parseQueueId(PUBKEY).pubkey).toBe(PUBKEY);
  });

  it('refuses anything else, without echoing it', () => {
    expect(() => parseQueueId('nsec1notakey')).toThrow(/npub1/);
    try {
      parseQueueId('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
    } catch (error) {
      expect((error as Error).message).not.toContain('nsec1vl');
    }
  });
});

describe('receipt log', () => {
  it('pages newest first and drops expired receipts', () => {
    const log = createReceiptLog(tempDir());
    const id = (n: number) => n.toString(16).padStart(64, '0');
    log.append({ giftWrapId: id(1), createdAt: 100, expiresAt: 1000, queuePubkey: PUBKEY });
    log.append({ giftWrapId: id(2), createdAt: 200, expiresAt: 1000, queuePubkey: PUBKEY });
    log.append({ giftWrapId: id(3), createdAt: 300, expiresAt: 400, queuePubkey: PUBKEY });
    expect(log.countSince(150)).toBe(2);
    expect(log.list(500, { limit: 10 }).map((r) => r.createdAt)).toEqual([200, 100]);
    expect(
      log.list(500, { limit: 10, before: 200, beforeId: id(2) }).map((r) => r.createdAt)
    ).toEqual([100]);
  });
});
