/**
 * The parts of the MCP endpoint that need no database, agent key custody or HTTP framework,
 * exported as `@qusme/core/mcp` for the local stdio server (`@qusme/mcp`, spec 8.6): the tools
 * and their session interface, grant and submitters list reading, the registry, and the relay
 * reader and publisher. Nothing here may import `@qusme/store-sql`, `hono` or a runtime global.
 */

export {
  checkStorageRelays,
  createWebSocketRelayReader,
  MAX_STORAGE_RELAYS,
  type RelayFilter,
  type RelayQuery,
  type RelayReader,
  type RelaySocket,
  type WebSocketCtor,
} from '../oauth/relayReader.ts';
export type { AgentAuth } from '../oauth/server.ts';
export {
  createGrantCache,
  createSubmittersCache,
  type FoundGrant,
  type FoundSubmitters,
  type GrantCache,
  type GrantCacheOptions,
  type SubmittersCache,
  storageMoveFor,
} from './grants.ts';
export {
  bundledRegistry,
  type EffectiveDefinition,
  effectiveDefinition,
  loadRegistry,
  type Registry,
  type RegistrySnapshot,
} from './registry.ts';
export {
  createWebSocketRelayPublisher,
  type RelayPublisher,
  type RelayPublishRequest,
  type RelayPublishResult,
} from './relayPublisher.ts';
export {
  checkGrant,
  GRANT_REVOKED_MESSAGE,
  MAX_SUBMISSIONS_PAGE,
  type McpToolErrorCode,
  QUSME_INSTRUCTIONS,
  registerQusmeTools,
  ToolError,
  type ToolReceipt,
  type ToolSession,
} from './tools.ts';
