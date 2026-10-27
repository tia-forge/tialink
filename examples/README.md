# Client configurations

Ready-to-use MCP client configurations for TiaLink, plus the raw request shape for everything else.

**Replace two things everywhere:**

| Placeholder | Replace with |
|---|---|
| `192.168.1.78` | The IP address or hostname of the machine running TiaLink |
| `8080` | The port the gateway listens on (the setup steps that come with your build state it) |
| `<YOUR_API_TOKEN>` | The API token configured on the gateway |

The endpoint always ends in **`/mcp`** — `http://192.168.1.78:8080/mcp`, not the host root.

| Client | File | Notes |
|---|---|---|
| Claude Code | [claude-code.json](./claude-code.json) | Project-scope `.mcp.json`; supports `${ENV_VAR}` so the token need not be committed |
| Cursor | [cursor-mcp.json](./cursor-mcp.json) | `~/.cursor/mcp.json` (user) or `.cursor/mcp.json` (project) |
| VS Code | [vscode-mcp.json](./vscode-mcp.json) | `.vscode/mcp.json`; prompts for the token and stores it in VS Code's secret storage |
| Claude Desktop | [claude-desktop-config.json](./claude-desktop-config.json) | Desktop has no built-in HTTP transport, so it goes through the `mcp-remote` shim (needs Node.js) |
| Anything else | below | Any client that supports Streamable HTTP and a `Bearer` header works |

### Notes per client

**Claude Code** — put `claude-code.json` in your project as `.mcp.json`, and export the token before launching the client (the config reads an environment variable so the token never lands in the file):

```bash
export TIALINK_API_TOKEN=<YOUR_API_TOKEN>        # Git Bash / WSL
setx TIALINK_API_TOKEN "<YOUR_API_TOKEN>"         # Windows, then reopen the terminal
```

**Cursor** — copy `cursor-mcp.json` to `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` for one. If your Cursor version asks for a transport type, set it to `http`.

**VS Code** — copy `vscode-mcp.json` to `.vscode/mcp.json`. VS Code prompts for the token the first time and keeps it in secret storage.

**Claude Desktop** — Desktop has no built-in HTTP transport, so the config runs the `mcp-remote` shim through `npx`, which needs Node.js on the same machine. Two caveats: the shim is a third-party package, and Desktop keeps its config in plain text, so the token is readable by anything that can open the file. If that matters in your environment, use a client with secret storage instead.

## Batch jobs instead of one-offs

MCP clients are good at single operations ("create this block"). Repeating an operation across 20 devices is a different problem, and it is the one that eats project hours. [`batch-copy/`](./batch-copy/) is a dependency-free Node script that clones one template FB into N devices from a CSV spec — IO addresses, block numbers and per-device parameters all come from the spreadsheet — then builds the tag table and the call sites, with a dry run before anything is written:

```bash
node examples/batch-copy/tialink-batch.mjs clone --device PLC_1   --template FB_MotorSeq --spec examples/batch-copy/examples/fans.csv   --mode copy --base 200 --db-base 200 --tags Fans_IO --calls FB_FanCalls --dry
```

It talks to the REST API (`/api/v1/...`) rather than MCP, so it also works as a reference for the non-agent path. Details, measured timings and the SimaticML traps it encodes: [`batch-copy/README.md`](./batch-copy/README.md).

## Raw request shape

For a client we have not listed, or for a manual check, TiaLink speaks MCP **Streamable HTTP**: a JSON-RPC `POST` to `/mcp` with an `Authorization: Bearer` header and both content types accepted.

```bash
curl -sS -X POST "http://192.168.1.78:8080/mcp" \
  -H "Authorization: Bearer <YOUR_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-smoke-test","version":"1.0"}}}'
```

A working gateway answers with a JSON-RPC result containing the server name and its capabilities. From there, a client sends `notifications/initialized` and then `tools/list`.

Useful signals when it does not work:

| Response | Meaning |
|---|---|
| JSON-RPC result with `serverInfo` | Gateway is up and the token is accepted |
| `401` / `403` | Token missing or wrong — check the header spelling and that the token has no trailing newline |
| `404` | Wrong path — the endpoint is `/mcp` |
| Connection refused / timeout | Firewall on the gateway host, or the gateway is bound to `localhost` only |
| `406 Not Acceptable` | The `Accept` header is missing `text/event-stream` |

## Windows and LAN notes

- The client may run on a different machine from the gateway. If it does, use the gateway machine's LAN address (not `localhost`) and make sure inbound TCP on the gateway port is allowed through Windows Firewall.
- If you use a hostname instead of an IP address, it must resolve from the client machine.
- Tokens are per-gateway, not per-client: several clients (Claude Code and VS Code, for example) can point at the same gateway at the same time.

See [../install.md](../install.md) for prerequisites, verification steps and troubleshooting.
