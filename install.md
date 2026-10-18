# Installing TiaLink

TiaLink is a **TIA Portal MCP gateway**: it runs on the same Windows machine as TIA Portal and exposes the engineering API as MCP tools, so an MCP-capable AI agent can configure hardware, import block and SCL source, compile, download to a simulator and read the project back.

TiaLink is commercial software in **early access** — see [Access](#access). This document covers what the machine needs, how to request a build, how to connect a client, and what to check when it does not work.

- Product page: https://tia.hubwiz.com/tia-link
- Client configs: [examples/](./examples/README.md)
- Capability list and FAQ: [README.md](./README.md)

---

## 1. Where it runs

| Piece | Where it runs |
|---|---|
| TiaLink gateway | The **same Windows machine as TIA Portal** (Siemens Openness only works where TIA Portal is installed) |
| TIA Portal | On that machine, licensed, currently **V19** |
| MCP client (Claude Code, Cursor, VS Code, …) | Anywhere — same machine or another machine on the LAN, connecting to `http://<gateway-host>:<port>/mcp` |
| S7-PLCSIM Advanced | Same machine, **only if** you want the simulation and download tools |

No internet connection is required for TiaLink itself, and project data stays on the local network.

## 2. Prerequisites

Check these before requesting a build — most setup failures are one of the first three rows.

| Requirement | Why it matters |
|---|---|
| Windows (64-bit) with a **licensed TIA Portal V19** installation | Openness is installed with TIA Portal; there is nothing extra to license for the gateway's own API access |
| The Windows account that runs the gateway is a member of the local **Siemens TIA Openness** user group | Without group membership, Openness calls fail with authorization errors. Your TIA Portal administrator usually sets this up |
| A free TCP port for the gateway (default `8080` in our examples), reachable from the client machine | The MCP client talks to the gateway over HTTP; a host firewall that blocks inbound traffic is the most common "agent cannot connect" cause |
| S7-PLCSIM Advanced installed and licensed *(optional)* | Needed only for the simulation and download-to-virtual-CPU tools |
| An MCP client that supports **Streamable HTTP** and can send a `Bearer` header | TiaLink is agent-agnostic; the only client-side requirements are the HTTP transport and the auth header |

> Working inside a plant network with no outbound internet? That is the intended deployment. Put TiaLink and the client on the same subnet and do not expose the port beyond it.

## 3. Buy, download and licence

**Buy:** TiaLink is paid software — **¥99/month or ¥999/year** (China). Purchase on the [product page](https://tia.hubwiz.com/tia-link); after the WeChat Pay payment the download link and the setup steps appear immediately. **Keep your order number** — the licence request needs it, and it lets you download again. The package is signed; a fresh certificate still triggers SmartScreen on the first downloads. It extracts to a `TiaLink\` folder with five files; read the `README.txt` inside it first.

**Install — four steps:**

1. Copy the whole folder to its final location, e.g. `C:\Program Files\TiaLink\`. Copy first, run later: the Openness whitelist records the exact path and file hash.
2. Run `TiaLink.Helper.exe` and click the one-click repair (one UAC prompt). Sign out or reboot if it asks.
3. Start `TiaLink.exe` **as a normal user** — never as administrator. It serves a local HTTP API and connects to TIA Portal in the background.
4. Open `http://localhost:8080/`.

**Licence:** TiaLink is read-only without a licence (it never blocks read access or modifies the project unasked). On the activation page (`http://localhost:8080/`) copy the **machine code** and download the **`.tlreq`** request file, then send both to **support@hubwiz.com** with your order number. The machine-bound `.lic` is issued for that machine and works fully offline; replacing a mainboard or disk may require a re-issue.

**Enterprise:** multi-seat, floating and air-gapped deployments are quoted — write to **support@hubwiz.com**.

**API access:** configure an API token before exposing the gateway on a shared LAN (see §6).

## 4. Connect an MCP client

1. Configure the gateway with a token and a listening port (see the `README.txt` inside the package, and §6 below).
2. Note the address — for example `http://192.168.1.78:8080/mcp`.
3. Add the server to your client using one of the ready-made configurations:

| Client | File |
|---|---|
| Claude Code | [examples/claude-code.json](./examples/claude-code.json) |
| Cursor | [examples/cursor-mcp.json](./examples/cursor-mcp.json) |
| VS Code (Copilot agent mode) | [examples/vscode-mcp.json](./examples/vscode-mcp.json) |
| Claude Desktop (via `mcp-remote` shim) | [examples/claude-desktop-config.json](./examples/claude-desktop-config.json) |
| Anything else | [examples/README.md](./examples/README.md) shows the raw request shape |

4. Restart the client so it picks up the new server, then run the smoke test below.

## 5. Verify the connection

**Step 1 — the agent can see the tools.** Ask your client to list the TiaLink tools. You should get tools for devices and modules, subnets and IO systems, blocks and SCL import, compile, HMI screens, and simulation.

**Step 2 — the agent can read a project.** Point it at a scratch project (not a production project) and ask for the device list and the block inventory. A read-only answer proves the gateway, Openness and the token are all working.

**Step 3 — the agent can change something small and verify it.** Ask it to create one function block, compile, and report the compile result. Nothing should be reported as "done" unless the compile output says so.

If step 2 or 3 fails, see [Troubleshooting](#7-troubleshooting).

## 6. Security

- Configure an API token, and keep the token in your client's secret/input mechanism rather than in a committed config file (the example configs show both ways).
- Bind the gateway to the LAN interface you intend to use, and do not forward the port to the internet.
- Treat the gateway host as engineering infrastructure: run it under an account with the least privilege that still satisfies Openness.
- Keep the dry-run → compile → simulate → read-back sequence as your standard workflow. The gateway supports it precisely because "the agent said it worked" is not evidence.

## 7. Troubleshooting

| Symptom | Likely cause and what to check |
|---|---|
| Client cannot connect / connection refused | Host firewall blocking the port; gateway bound to `localhost` while the client is on another machine; wrong port |
| HTTP `401` / `403` from the gateway | Missing or malformed auth header — it must be `Authorization: Bearer <token>` |
| HTTP `404` on the endpoint | Wrong path: the MCP endpoint is `/mcp`, not the host root |
| Client connects but shows no tools | Client caches the server list — restart it. Also confirm the client supports Streamable HTTP |
| Openness errors: authorization, "not permitted", user group | The Windows account running the gateway is not in the local **Siemens TIA Openness** user group |
| Openness errors mentioning TIA Portal version | Gateway build and installed TIA Portal version do not match (current support: V19) |
| Simulation or download tools fail | S7-PLCSIM Advanced not installed, not started, or no virtual instance running; the PLCSIM virtual adapter may also need to be selected as the PC/PG interface |
| Everything works, then dies after a reboot | The gateway is not registered as a service; start it after TIA Portal is available on that machine |

When you report a problem, include the gateway host's Windows version, the TIA Portal version, the client name and version, and the exact error text — not a screenshot of a chat window.

## 8. Related documents

- [README.md](./README.md) — what TiaLink does, how it works, FAQ
- [examples/](./examples/README.md) — client configurations and the raw request shape
- [LICENSE](./LICENSE) — documentation licence; the TiaLink software itself is commercial and is not covered by it

TiaLink is an independent product by 汇智网 (hubwiz.com). It is not affiliated with, or endorsed by, Siemens AG. TIA Portal, SIMATIC, S7 and PLCSIM are trademarks of Siemens AG.
