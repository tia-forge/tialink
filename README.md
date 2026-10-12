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

Replace `192.168.1.78` with the IP or hostname of the machine running TiaLink, and `<YOUR_API_TOKEN>` with your configured token.

---

## Related tools in the TIA Forge suite

TiaLink is part of **TIA Forge**, a TIA Portal engineering agent suite by 汇智网:

- **reverse-docs** — reverse engineering documentation for existing PLC projects
- **lad2scl / txt2scl / txt2lad** — LAD / SCL / text conversion
- **block-sim** — block-level simulation

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

---

## Links

- **Product page**: https://tia.hubwiz.com/tia-link
- **Publisher**: 汇智网 — https://www.hubwiz.com/

---

## License

- **Documentation** in this repository is licensed under **CC BY 4.0** — see [LICENSE](./LICENSE).
- The **TiaLink software itself** (the MCP gateway / server) is **commercial software** and is not covered by that license. All rights reserved.
