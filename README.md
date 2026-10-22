# TiaLink — TIA Portal MCP Gateway

**TiaLink** is a **TIA Portal MCP gateway** by [汇智网 (hubwiz.com)](https://www.hubwiz.com/).
It lets any [MCP](https://modelcontextprotocol.io)-capable AI agent operate **Siemens TIA Portal** projects directly.

> 📄 Product page: **https://tia.hubwiz.com/tia-link**

---

## What it does

TiaLink exposes Siemens TIA Portal capabilities as MCP tools, so an AI agent can:

- **Configure hardware & networks** — add devices and modules, assign IP addresses, create subnets and IO systems
- **Work with programs & data** — create FB / FC / DB / UDT blocks, write SCL, import SimaticML (including LAD) blocks
- **Build** — compile, save, export, and archive projects
- **Simulate & verify** — download to S7-PLCSIM Advanced, read/write variables, run test scenarios
- **Read back** — project model, block interfaces, and hardware tree for verification

In short: instead of getting a code snippet in a chat window, the agent operates a real TIA Portal project and reads the result back.

---

## How it works

```
AI agent (MCP client)
        │  MCP (Streamable HTTP, endpoint /mcp)
        ▼
     TiaLink  ──►  Siemens TIA Portal Openness  ──►  TIA Portal project
```

- **Protocol**: MCP (Model Context Protocol), Streamable HTTP, endpoint `/mcp`
- **Underlying**: Siemens TIA Portal Openness
- **Agent-agnostic**: TiaLink does not bind to any specific model or vendor. Any MCP client that supports Streamable HTTP and can send a Bearer header can connect.

---

## Getting started

1. **Check the machine** — Windows, a licensed TIA Portal **V19 or V20** (V21 is not supported yet), and the Windows account in the local *Siemens TIA Openness* group. Full checklist: **[install.md](./install.md)**.
2. **Buy and download** — TiaLink is paid software: **¥99/month or ¥999/year** (China). Buy on the [product page](https://tia.hubwiz.com/tia-link); the download link and the setup steps appear immediately after the WeChat Pay payment. Keep the order number — the licence request needs it.
3. **Point your MCP client at the gateway** — ready-made configurations for Claude Code, Cursor, VS Code and Claude Desktop are in **[examples/](./examples/README.md)**.
4. **Verify** — list the tools, read a scratch project, then create one block and require the compile result. If step three fails, see the troubleshooting table in [install.md](./install.md#7-troubleshooting).

### If your client only speaks stdio

TiaLink serves **Streamable HTTP**. Most clients handle that directly, but some
desktop hosts and one-click bundles can only launch **stdio** servers. For those
there is a small adapter in this repository, **[`server/index.js`](./server/index.js)** —
it forwards JSON-RPC between stdio and the gateway and adds no functionality of
its own.

> ⚠️ **The adapter is not the product.** It needs a licensed TiaLink gateway
> already running. Without one it fails on the first request — by design.

```bash
# Run the adapter against a local gateway
TIALINK_URL=http://127.0.0.1:8080/mcp npx tialink-mcp

# Pre-flight: is the gateway reachable, is the token right, which tools exist?
TIALINK_URL=http://192.168.1.78:8080/mcp TIALINK_TOKEN=... npx tialink-mcp --check
```

| Path | What you get |
|---|---|
| `npx tialink-mcp` | stdio ↔ HTTP adapter (npm, no dependencies, Node ≥ 18) |
| [`manifest.json`](./manifest.json) + `.mcpb` | one-click desktop bundle — `npx @anthropic-ai/mcpb pack .` |
| [`Dockerfile`](./Dockerfile) | the same adapter in a container, for Linux CI and sandboxed agents |

Configuration is by environment variable: `TIALINK_URL` (default
`http://127.0.0.1:8080/mcp`), `TIALINK_TOKEN`, `TIALINK_TIMEOUT_MS` (default
600000 — compile and download calls are slow on purpose).

## Deployment

- TiaLink runs on the **same Windows machine as TIA Portal** (Openness only runs where TIA Portal is installed).
- The **MCP client can run on another machine** and connect over the LAN — for example, `http://<gateway-host>:8080/mcp`.
- **Project data never leaves the local network.** Suitable for offline and on-premises environments.
- Recommended: configure an API token; the MCP client sends it as a `Bearer` header.

---

## Supported clients

Any MCP client that supports **Streamable HTTP** and can send a **Bearer** header, for example:

- Claude Code
- Cursor
- VS Code

TiaLink is **not tied to a specific vendor** — the same gateway works with different agents (including Tencent WorkBuddy and other MCP clients).

---

## Example MCP configuration

```json
{
  "mcpServers": {
    "tialink": {
      "type": "http",
      "url": "http://192.168.1.78:8080/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_API_TOKEN>"
      }
    }
  }
}
```

Replace `192.168.1.78` with the IP or hostname of the machine running TiaLink, and `<YOUR_API_TOKEN>` with your configured token. Configurations for specific clients — including one that reads the token from an environment variable instead of the file — are in [examples/](./examples/README.md).

---

## Related tools in the TIA Forge suite

TiaLink is part of **TIA Forge**, a TIA Portal engineering agent suite by 汇智网:

- **reverse-docs** — reverse engineering documentation for existing PLC projects
- **lad2scl / txt2scl / txt2lad** — LAD / SCL / text conversion
- **block-sim** — block-level simulation

## Where else to find us

- **[Awesome PLC AI](https://github.com/tia-forge/awesome-plc-ai#readme)** — a curated list of AI tools, agents and MCP bridges for PLC engineering (Siemens TIA Portal, CODESYS, TwinCAT, Studio 5000, GX Works), maintained by 汇智网. TiaLink is listed there alongside the alternatives, with a disclosure.

---

## FAQ

**What is TiaLink?**
TiaLink is a TIA Portal MCP gateway by 汇智网 (hubwiz.com). It lets any AI agent operate Siemens TIA Portal projects through the MCP protocol.

**Does TiaLink require internet access?**
No. TiaLink runs on the same machine as TIA Portal, all operations happen locally, and project data stays on-prem.

**Does the MCP gateway have to be on the same computer as TIA Portal?**
The gateway itself must run on the same machine as TIA Portal (Openness requires it). The MCP client, however, can run on a different machine and connect over the LAN.

**Is TiaLink tied to one AI vendor?**
No. TiaLink is agent-agnostic — any MCP client that supports Streamable HTTP with a Bearer header can use it.

**Can AI-generated PLC code be used directly?**
AI handles the verifiable software part, but safety functions must be implemented in hardware (safety relay / safety PLC), hard interlocks must be pneumatic or electrical, and time/sensor tuning must be done on the real machine. TiaLink does not replace safety responsibility.

**What does it cost?**
**¥99/month or ¥999/year** (China; the annual licence saves ¥189). Multi-seat, floating and air-gapped enterprise deployments are quoted — write to **support@hubwiz.com**.

**How do I buy it and get a licence?**
Buy on the product page: after the WeChat Pay payment, the page immediately shows the download link and the setup steps — no account or form required. Install TiaLink as a normal user, open `http://localhost:8080/`, and send the machine code plus the generated `.tlreq` request file to **support@hubwiz.com**. The machine-bound `.lic` is issued for that machine and works fully offline.

---

## Links

- **Product page / buy**: https://tia.hubwiz.com/tia-link (WeChat Pay; the download link appears after payment)
- **Publisher**: 汇智网 — https://www.hubwiz.com/

---

## License

- **Documentation** in this repository is licensed under **CC BY 4.0** — see [LICENSE](./LICENSE).
- The **TiaLink software itself** (the MCP gateway / server) is **commercial software** and is not covered by that license. All rights reserved.
- The **stdio bridge** in [`server/`](./server/index.js) — plus its `package.json`, `manifest.json` and `Dockerfile` — is **MIT licensed** — see [LICENSE-BRIDGE](./LICENSE-BRIDGE). It is a thin transport adapter: fork it, vendor it, ship it in your own agent tooling. A licensed TiaLink gateway is still required at runtime.
