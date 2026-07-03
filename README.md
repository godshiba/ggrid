# GpuGrid ($GGRID)

Decentralized GPU network — "Uber for GPUs". Contribute idle GPU power and earn
**$GGRID**; developers get cheap, OpenAI-compatible AI compute, routed across the grid.

Full engineering plan: **[PLAN.md](PLAN.md)**.

## Layout

```
GpuGrid/
├─ server/   Bun + Hono + bun:sqlite gateway — OpenAI API, registry, billing, RunPod fallback
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

See [server/README.md](server/README.md) for the API reference.
