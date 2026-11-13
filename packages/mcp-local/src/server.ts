/**
 * The local MCP server (spec 8.6): the hosted endpoint's five tools (`@qusme/core/mcp`) on one
 * long-lived McpServer, each call acting through a fresh {@link ToolSession} of the local agent.
 * Once the client has initialized, a server that is not yet approved sends its approval request
 * (7.7) with the client's name, so the code is waiting when the user opens the extension.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { QUSME_INSTRUCTIONS, registerQusmeTools } from '@qusme/core/mcp';
import type { LocalAgent } from './agent.ts';

/** What MCP clients call themselves, as a person would name them. */
const CLIENT_NAMES: Record<string, string> = {
  'claude-ai': 'Claude Desktop',
  'claude-code': 'Claude Code',
};

/** The name the approval screen shows for an MCP client's `clientInfo`. */
export function clientDisplayName(info: { name?: string; title?: string } | undefined): string {
  if (info === undefined) return 'Local MCP server';
  const known = info.name === undefined ? undefined : CLIENT_NAMES[info.name];
  return known ?? info.title ?? info.name ?? 'Local MCP server';
}

export const LOCAL_INSTRUCTIONS =
  `${QUSME_INSTRUCTIONS} This server runs on the user's computer. Until the user approves it, ` +
  'tools answer approval_required with a code: show the user that code and ask them to enter ' +
  'it in the qus.me extension under "Approve an agent".';

export function createLocalServer(agent: LocalAgent, options: { version: string }): McpServer {
  const server = new McpServer(
    { name: 'qus.me', version: options.version },
    { instructions: LOCAL_INSTRUCTIONS }
  );
  registerQusmeTools(server, agent.registry, () => agent.toolSession());
  server.server.oninitialized = () => {
    agent.setClientName(clientDisplayName(server.server.getClientVersion()));
    if (agent.state.storage_relays !== undefined) return;
    // Best effort: a tool call retries and says what went wrong.
    agent.ensureRequest().catch(() => undefined);
  };
  return server;
}
