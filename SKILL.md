---
name: tialink
description: Operate Siemens TIA Portal projects through the TiaLink MCP gateway. Use when an AI agent needs to connect to TIA Portal (V19 or V20), configure hardware and networks, create FB/FC/DB/UDT blocks, write SCL, compile, download to S7-PLCSIM for simulation, and read back the project for verification.
license: CC-BY-4.0
metadata:
  version: 1.0.0
  publisher: 汇智网 (hubwiz.com)
  product-page: https://tia.hubwiz.com/tia-link
---

# TiaLink — TIA Portal MCP Gateway

TiaLink exposes Siemens **TIA Portal Openness** capabilities as MCP tools so any MCP-capable AI agent can operate a real TIA Portal project directly: configure hardware and networks, create blocks, write SCL, compile, simulate on S7-PLCSIM, and read results back. It is agent-agnostic (Claude Code, Cursor, VS Code, Tencent WorkBuddy, or any client speaking Streamable HTTP with a Bearer token).

**Supported TIA Portal versions: V19 and V20. V21 is not supported yet.** Do not connect to a V21 installation.

## Prerequisites

1. **Windows** machine with an installed, licensed **TIA Portal V19 or V20**.
2. The Windows account running the gateway is in the local **Siemens TIA Openness** user group.
3. TiaLink installed and licensed (commercial software — buy on the [product page](https://tia.hubwiz.com/tia-link)).
4. Full machine checklist and troubleshooting: **[install.md](./install.md)**.

## Connect an MCP client

TiaLink runs on the **same Windows machine as TIA Portal** (Openness requirement). The MCP client may run on another machine — connect over the LAN:

```json
{
  "mcpServers": {
    "tialink": {
      "type": "http",
      "url": "http://<gateway-host>:8080/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_API_TOKEN>"
      }
    }
  }
}
```

- Protocol: MCP (Streamable HTTP), endpoint `/mcp`.
- Authentication: `Authorization: Bearer <token>` (configure the token in the gateway). Recommended for every deployment.
- Project data never leaves the local network — suitable for offline / on-premises environments.
- Ready-made client configs for Claude Code, Cursor, VS Code and Claude Desktop: **[examples/](./examples/README.md)**.

## First session: verify before operating

Run this sequence the first time you connect to any machine or project:

1. **List tools** — confirm the client sees the TiaLink tool set.
2. **Read** — open a scratch project and read the block list / hardware tree.
3. **Write** — create one small block, require the compile result, then read it back.

If step 1–3 fails, check [install.md §Troubleshooting](./install.md#7-troubleshooting): account not in the Openness group, gateway project not open, version mismatch (V21 is not supported).

## Core workflows

| Goal | Flow |
|---|---|
| Add a CPU / network | read hardware tree → add device/module → assign IP, subnet, IO system → compile → read back |
| Create program blocks | read block list → create FB/FC/DB/UDT → write SCL (or import SimaticML incl. LAD) → compile → dry-run → read back interface |
| Simulate | download to **S7-PLCSIM Advanced** virtual CPU → read/write variables → run test scenario → read results |
| Archive | compile → save → export / archive project → read back |

Always make the agent **read back** the project state after each write — verification is part of the work, not an optional extra.

## Safety rules (do not skip)

- **Default to simulation.** Download to S7-PLCSIM, not to physical hardware, unless the operator explicitly confirms the physical target.
- **Never touch production projects or running machines** without explicit human confirmation in the loop.
- AI handles the verifiable software part only. Safety functions must be implemented in hardware (safety relay / safety PLC); hard interlocks must be pneumatic or electrical; time/sensor tuning must be done on the real machine.

## Environment facts

- Gateway: Windows, same machine as TIA Portal; MCP client can be remote over LAN.
- Underlying API: Siemens TIA Portal Openness.
- The gateway does **not** need internet access; the MCP client connects over the local network.
