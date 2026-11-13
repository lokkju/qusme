/**
 * Where the local server keeps its files (spec 8.6), and how it writes them: the user's config
 * directory (XDG on Linux, Application Support on macOS, %APPDATA% on Windows) in a directory of
 * its own, mode 0700, and every file in it mode 0600, written whole through a temporary file so a
 * crash never leaves half of one.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The directory under the user's config directory. */
export const CONFIG_DIR_NAME = 'qusme-mcp';

export interface ConfigDirInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

/**
 * The config directory: `QUSME_MCP_CONFIG_DIR` when set; otherwise `%APPDATA%\qusme-mcp` on
 * Windows, `~/Library/Application Support/qusme-mcp` on macOS, and
 * `$XDG_CONFIG_HOME/qusme-mcp` (or `~/.config/qusme-mcp`) elsewhere.
 */
export function configDir(
  inputs: ConfigDirInputs = { env: process.env, platform: process.platform, home: homedir() }
): string {
  const { env, platform, home } = inputs;
  const override = env.QUSME_MCP_CONFIG_DIR;
  if (override !== undefined && override !== '') return override;
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), CONFIG_DIR_NAME);
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', CONFIG_DIR_NAME);
  const xdg = env.XDG_CONFIG_HOME;
  // XDG: a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const base = xdg?.startsWith('/') ? xdg : join(home, '.config');
  return join(base, CONFIG_DIR_NAME);
}

/** Creates the directory, owner-only, if it is missing. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The parsed JSON in `path`, or undefined when there is no such file. */
export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text);
}

/** Writes `value` as JSON to `path`, mode 0600, through a temporary file and a rename. */
export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode applies only when it creates the file; a leftover keeps its old one.
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/**
 * Whether `path` is readable by anyone but its owner. POSIX only: on Windows the mode bits say
 * nothing about access, and %APPDATA% is already the user's own.
 */
export function readableByOthers(path: string, platform = process.platform): boolean {
  if (platform === 'win32') return false;
  return (statSync(path).mode & 0o077) !== 0;
}
