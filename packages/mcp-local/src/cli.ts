#!/usr/bin/env node
/**
 * `npx @qusme/mcp`: qus.me's MCP server on your own computer (spec 8.6), over stdio. stdout is
 * the MCP protocol, so everything for the user goes to stderr, and the approval code also comes
 * back in every tool's `approval_required` error, since some MCP clients hide stderr.
 *
 *   qusme-mcp --queue npub1…            serve MCP over stdio (what an MCP client runs)
 *   qusme-mcp approve --queue npub1…    ask for approval in this terminal and wait for it
 *   qusme-mcp status                    show the agent key, queue and approval state
 */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { bundledRegistry } from '@qusme/core/mcp';
import { displayApprovalCode } from '@qusme/nostr';
import { npubEncode } from 'nostr-tools/nip19';
import snapshot from '../../../registry/snapshot.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { createLocalAgent, LocalAgentConfigError, shortNpub } from './agent.ts';
import { AgentKeyFileError } from './agentKey.ts';
import { configDir } from './files.ts';
import { parseQueueId } from './queueId.ts';
import { createLocalServer } from './server.ts';

const USAGE = `qus.me MCP server, local edition ${pkg.version}

Usage:
  npx @qusme/mcp --queue <npub|nprofile> [options]          serve MCP over stdio
  npx @qusme/mcp approve --queue <npub|nprofile> [options]  approve from this terminal
  npx @qusme/mcp status [options]

Options:
  --queue <id>        your Queue ID, from the qus.me extension (needed once)
  --inbox <wss://…>   your queue's inbox relay, if it isn't the default (repeatable)
  --name <name>       the name the approval screen shows (default: your MCP client's)
  --config-dir <dir>  where the agent key and state live
  --max-pow <bits>    most proof of work to mine for a grant (default 24)
  -h, --help          this text
  -v, --version       the version
`;

const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      queue: { type: 'string' },
      inbox: { type: 'string', multiple: true },
      name: { type: 'string' },
      'config-dir': { type: 'string' },
      'max-pow': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const command = positionals[0] ?? 'serve';
  if (!['serve', 'approve', 'status'].includes(command) || positionals.length > 1) {
    err(USAGE);
    return 2;
  }
  for (const url of values.inbox ?? []) {
    if (!/^wss:\/\/[^\s]+$/.test(url))
      throw new LocalAgentConfigError(`--inbox needs a wss:// URL: ${url}`);
  }
  let maxPow: number | undefined;
  if (values['max-pow'] !== undefined) {
    maxPow = Number(values['max-pow']);
    if (!Number.isInteger(maxPow) || maxPow < 0 || maxPow > 256) {
      throw new LocalAgentConfigError('--max-pow is a whole number of bits from 0 to 256');
    }
  }
  const dir = values['config-dir'] ?? configDir();
  const agent = createLocalAgent({
    dir,
    ...(values.queue !== undefined && { queue: parseQueueId(values.queue) }),
    ...(values.inbox !== undefined && { inbox: values.inbox }),
    ...(values.name !== undefined && { name: values.name }),
    ...(maxPow !== undefined && { maxPow }),
    registry: bundledRegistry(snapshot, { log: err }),
    log: err,
  });
  const { state } = agent;

  if (command === 'status') {
    process.stdout.write(
      [
        `Agent key:      ${npubEncode(agent.agentPubkey)}`,
        `Queue:          ${npubEncode(state.queue_pubkey)}`,
        `Inbox relays:   ${state.inbox_relays.join(', ')}`,
        `Storage relays: ${state.storage_relays?.join(', ') ?? '(not approved yet)'}`,
        `Config:         ${dir}`,
        '',
      ].join('\n')
    );
    return 0;
  }

  if (command === 'approve') {
    agent.resetApproval();
    agent.setClientName(values.name ?? 'Local MCP server');
    const request = await agent.ensureRequest();
    err('');
    err(`  Enter this code in the qus.me extension, under "Approve an agent":`);
    err('');
    err(`      ${displayApprovalCode(request.code)}`);
    err('');
    err(`  The approval screen will show the agent key ${shortNpub(agent.agentPubkey)}.`);
    err('  Waiting for your answer (Ctrl+C to stop)…');
    for (;;) {
      if (Math.floor(Date.now() / 1000) >= request.expires_at) {
        err('The code expired. Run this command again for a new one.');
        return 1;
      }
      const status = await agent.checkAnswer().catch(() => 'pending' as const);
      if (status === 'approved') {
        err('Approved. Your MCP client can use qus.me now.');
        return 0;
      }
      if (status === 'denied') {
        err('Denied.');
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  const server = createLocalServer(agent, { version: pkg.version });
  await server.connect(new StdioServerTransport());
  err(
    state.storage_relays === undefined
      ? `qus.me: started; agent key ${shortNpub(agent.agentPubkey)}, waiting for approval.`
      : `qus.me: started; agent key ${shortNpub(agent.agentPubkey)}, approved.`
  );
  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    const known =
      error instanceof LocalAgentConfigError ||
      error instanceof AgentKeyFileError ||
      (error instanceof Error && error.message.startsWith('--'));
    err(`qus.me: ${known ? (error as Error).message : String(error)}`);
    process.exit(2);
  }
);
