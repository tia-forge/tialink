# tialink-mcp — container image
#
# What this image is
# ------------------
# A stdio ↔ Streamable HTTP bridge for TiaLink. It contains **only** the
# bridge (`server/index.js`, no dependencies) — not the TiaLink gateway, and
# not TIA Portal. The gateway runs on the Windows machine that has TIA Portal
# installed; this container just talks to it over the network.
#
# Build
#   docker build -t tialink-mcp .
#
# Run (stdio MCP server — keep stdin open with -i)
#   docker run -i --rm \
#     -e TIALINK_URL=http://192.168.1.78:8080/mcp \
#     -e TIALINK_TOKEN=... \
#     tialink-mcp
#
# Reach a gateway on the Docker host
#   Linux:   --add-host=host.docker.internal:host-gateway
#   Desktop: host.docker.internal resolves out of the box
#
# Smoke test (no gateway required — proves the bridge starts and reports usage)
#   docker run --rm tialink-mcp --help
#   docker run --rm -e TIALINK_URL=http://127.0.0.1:8080/mcp tialink-mcp --check

FROM node:22-alpine

LABEL org.opencontainers.image.title="tialink-mcp" \
      org.opencontainers.image.description="stdio to Streamable HTTP bridge for TiaLink (TIA Portal MCP gateway). Contains the bridge only; a running TiaLink gateway is required." \
      org.opencontainers.image.url="https://tia.hubwiz.com/tia-link" \
      org.opencontainers.image.source="https://github.com/tia-forge/tialink" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package.json ./package.json
COPY server ./server

# Sensible default for a gateway on the Docker host. Override at runtime.
ENV TIALINK_URL=http://host.docker.internal:8080/mcp
# Keep the container quiet by default; the MCP protocol owns stdout either way.
ENV TIALINK_QUIET=1
ENV NODE_ENV=production

# stdio server: no ports to expose, no long-running daemon of its own.
ENTRYPOINT ["node", "/app/server/index.js"]
