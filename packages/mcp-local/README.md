# @qusme/mcp

qus.me's MCP server, run on your own computer. Your agent (Claude Desktop, Claude Code or any MCP client that starts local servers) drafts posts into your [qus.me](https://qus.me) queue over stdio, and you insert and post them yourself with the qus.me extension. It offers the same tools as the hosted server at `https://app.qus.me/mcp` (`list_registry`, `list_destinations`, `get_definition`, `create_draft`, `list_submissions`), from the same code, but needs nothing from app.qus.me: the server holds its own agent key, publishes your agent's drafts to your queue's inbox relay itself and keeps its receipts on your disk.

The local server is free. The hosted one is free while qus.me is in beta and may become paid later.

You need Node 22.4 or later and the qus.me extension with a queue set up.

## Your Queue ID

The server needs your Queue ID once. In the extension, open "Approve an agent" and expand "Running qus.me's MCP server on your computer?": it shows the whole command with your Queue ID, ready to copy. That ID is an `nprofile1…` that also names your queue's inbox relay. The `npub1…` the extension shows elsewhere works too, if your queue uses the default inbox relay (`wss://auth.nostr1.com`); otherwise add `--inbox wss://…`.

The server can't look the inbox relay up from the npub, because your queue's relays are encrypted to your queue key; that's why the extension hands you the nprofile.

## Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "qusme": {
      "command": "npx",
      "args": ["-y", "@qusme/mcp", "--queue", "nprofile1…"]
    }
  }
}
```

## Claude Code

```sh
claude mcp add --scope user qusme -- npx -y @qusme/mcp --queue nprofile1…
```

## Approving it

The first time your agent calls a qus.me tool, the server isn't approved yet, so the tool answers with a code like `QK7D-M4XR` and your agent shows it to you. Open the extension, choose "Approve an agent", enter the code, pick the accounts the agent may draft for and its limit, and approve. The approval screen shows the server's agent key, `npub1…` cut short; it should match the one the server printed. Ask your agent again and it can draft. Codes last ten minutes; an expired one is replaced on the next call.

The server sends its request through your queue's inbox relay, gift-wrapped to your queue key, and the extension answers the same way, so app.qus.me never sees either. Revoke the server from the extension's Agents screen like any other agent.

To approve from a terminal instead, before you set up a client or after you revoked it:

```sh
npx @qusme/mcp approve --queue nprofile1…
```

It prints the code and waits until you approve or deny it.

## Options

| Option | |
|---|---|
| `--queue <npub or nprofile>` | Your Queue ID. Needed once; the server remembers it. Passing a different one starts over with that queue. |
| `--inbox <wss://…>` | Your queue's inbox relay, when the Queue ID doesn't name it. Repeatable. |
| `--name <name>` | The name the approval screen shows. By default it's your MCP client's ("Claude Desktop", "Claude Code"). |
| `--config-dir <dir>` | Where the agent key and state live. Also `QUSME_MCP_CONFIG_DIR`. |
| `--max-pow <bits>` | The most proof of work the server mines when your grant asks for it (default 24). |

`npx @qusme/mcp status` prints the agent key, the queue and whether it's approved.

## What it keeps on disk

Everything is under `$XDG_CONFIG_HOME/qusme-mcp` (or `~/.config/qusme-mcp`) on Linux, `~/Library/Application Support/qusme-mcp` on macOS and `%APPDATA%\qusme-mcp` on Windows, in a directory only you can open:

- `agent-key.json`: the agent's secret key, mode 0600. Whoever reads it can draft as this agent until you revoke it, so the server refuses to start if other users can read it.
- `state.json`: your queue's pubkey, its inbox and storage relays and any pending approval.
- `receipts.jsonl`: one line per draft sent (the gift wrap id and times, never the text), for `list_submissions` and your grant's quota.

One config directory is one agent. To run two agents with their own approvals and limits, give each its own `--config-dir`.

## How it differs from app.qus.me

- No OAuth and no account at app.qus.me; the approval is the code you type into the extension.
- The service's daily caps don't apply. Your grant's quota does, here and again on your devices.
- Proof of work runs on your machine, so a grant's `min_pow` up to 24 bits works (the hosted server mines at most 5).
- If your client never shows the server's log, that's fine: the code comes back in the tool's answer.

The protocol is in the qus.me specification, sections 7.7 and 8.6 (`docs/spec.md` in [lokkju/qusme](https://github.com/lokkju/qusme)).

## License

PolyForm Shield 1.0.0.
