/**
 * Re-encrypts every agent key under the current service secret version, once, and exits. Run it
 * with the server's environment after raising QUSME_AGENT_KEY_VERSION and setting
 * QUSME_AGENT_KEY_SECRET_PREVIOUS (README, "Rotating the agent key secret"):
 *
 *   node packages/entry-node/src/rotateAgentKeys.ts
 *
 * Prints counts and the ids of keys that failed, never key material. Exits 1 if any failed.
 */
import { buildApp, configFromEnv } from './app.ts';

const config = configFromEnv(process.env);
if (!config.agentKeys.rotating) {
  console.error('QUSME_AGENT_KEY_SECRET_PREVIOUS is not set; nothing to rotate from');
  process.exit(2);
}
const result = await buildApp(config).rotateAgentKeys();
console.log(JSON.stringify({ keyVersion: config.agentKeys.currentVersion, ...result }, null, 2));
process.exitCode = result.failed.length > 0 ? 1 : 0;
