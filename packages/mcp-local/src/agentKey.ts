/**
 * The local server's agent key (spec 6.2, 8.6): made on first run and kept in `agent-key.json`
 * in the config directory, mode 0600. It never leaves this file except as signatures, NIP-44
 * decryption of its own grant and answers, and the seals of its submissions. One key per config
 * directory: the user approves it once, and revoking it on a device revokes this server.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey } from 'nostr-tools/pure';
import { ensureDir, readableByOthers, readJson } from './files.ts';

export const AGENT_KEY_FILE = 'agent-key.json';

export class AgentKeyFileError extends Error {}

/**
 * Reads the agent key from `dir`, or creates one there. Refuses a key file anyone but its owner
 * can read, as ssh does, since whoever reads it can draft as this agent.
 */
export function loadOrCreateAgentKey(dir: string, platform = process.platform): Uint8Array {
  ensureDir(dir);
  const path = join(dir, AGENT_KEY_FILE);
  const existing = readJson(path);
  if (existing === undefined) {
    const key = generateSecretKey();
    const body = `${JSON.stringify(
      { version: 1, secret_key: bytesToHex(key), created_at: Math.floor(Date.now() / 1000) },
      null,
      2
    )}\n`;
    // `wx`: never overwrite a key another process made between the read and here.
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return loadOrCreateAgentKey(dir, platform);
      }
      throw error;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return key;
  }
  if (readableByOthers(path, platform)) {
    throw new AgentKeyFileError(`${path} is readable by other users. Run: chmod 600 "${path}"`);
  }
  const record = existing as { version?: unknown; secret_key?: unknown };
  if (
    record.version !== 1 ||
    typeof record.secret_key !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.secret_key)
  ) {
    throw new AgentKeyFileError(`${path} is not a qus.me agent key file`);
  }
  return hexToBytes(record.secret_key);
}
