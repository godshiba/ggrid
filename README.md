# GpuGrid ($GGRID)

A decentralized GPU compute network where anyone can contribute idle GPU power and earn rewards whenever their compute is used.

---

## The Problem

Millions of GPUs sit idle every day - gaming PCs at night, AI workstations between jobs, mining rigs collecting dust. At the same time, developers overpay for compute on AWS and Azure. Small startups can't afford to scale. The compute market is controlled by a handful of corporations.

The hardware already exists. It just isn't connected.

---

## The Solution

GPU Grid is a peer-to-peer compute network. GPU owners install a node, connect their hardware, and earn $GGRID every time their card processes a job. Developers access AI inference through a single OpenAI-compatible API - same code, same SDKs, just cheaper.

No datacenters. No middlemen. Just GPUs around the world connected into one network.

---

## How It Works

**Supply side - GPU providers**

Any GPU owner can become a node: install Ollama, register on the platform, connect a payout wallet. The node sends a heartbeat every 30 seconds to stay active in the network. Once live, it starts receiving jobs and earning $GGRID.

Supported hardware: RTX 3060, RTX 4070, RTX 4090, A100, H100 and others.

**Demand side - developers**

Developers sign up, get an API key and point any OpenAI client at the GPU Grid endpoint. The network finds the best available node and routes the job automatically. No configuration, no vendor lock-in.

**Routing**

Every job is routed based on four signals: price → speed → reliability → current load. The cheapest healthy node wins.

**Reputation system**

Every node has a reliability score from 0 to 1. A failed job reduces it by 0.1. Below 0.3, the node is removed from routing. Successful jobs restore reputation slowly (+0.02 each). Stable nodes naturally receive more work.

---

## Token - $GGRID

Every completed job generates fees. The split is automatic:

- 75% → GPU providers
- 12.5% → Buyback & burn
- 7.5% → Stakers
- 5% → Treasury

More compute usage → more fees → more token demand.

Token utility: paying for compute, staking nodes, governance, priority access.

---

## Technical Stack

- **Backend:** Bun + Hono + SQLite - single container, no external DB for MVP
- **API:** OpenAI-compatible (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`)
- **Node software:** Ollama (local GPU inference server)
- **Fallback:** RunPod cloud GPUs when no community nodes are available
- **Blockchain:** Solana - on-chain payout splitter, validated on devnet, mainnet via pump.fun
- **Auth:** SHA-256 hashed API keys, provider tokens, node secrets

---

## Layout

```
GpuGrid/
├─ server/   Bun + Hono + bun:sqlite gateway - OpenAI API, registry, billing, RunPod fallback
├─ web/      Vite + React site (UI polish is a later phase)
├─ agent/    provider node CLI (Ollama → grid: register + heartbeat)
├─ Dockerfile        all-in-one: builds web + runs gateway (serves site + API)
└─ .env              deploy config (docker-db)
```

## Develop

```bash
# backend
cd server && bun install && bun run dev        # http://localhost:8080  (/health)
cd server && bun run test:e2e                  # full-loop test (in-memory DB, mock node)

# site
cd web && bun install && bun run dev           # http://localhost:5173
```

## Deploy (the deploy platform)

Push to `main` → the platform builds the `Dockerfile`, runs the container, and
serves it on your domain with automatic SSL.

- Set `DOMAIN` in [`.env`](.env) before the first push.
- `DEPLOY=docker-db` → persistent SQLite at `/data` (survives redeploys).
- Secrets (`RUNPOD_API_KEY`, `ADMIN_KEY`) go in the deploy platform → Settings → Actions → Secrets;
  they're listed in `RUNTIME_KEYS` so the container receives them.
- Wait for a green build/deploy run before opening the domain.
