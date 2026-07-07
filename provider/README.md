# Connect your GPU to GpuGrid

One step. The installer sets up everything and keeps your GPU online & earning.
It installs **Ollama** (runs AI on your GPU) and **cloudflared** (a secure tunnel -
**no account needed**), then joins your card to the network. No terminal skills required.

**You need:** a GPU (NVIDIA/AMD), internet, and a **provider token** (get it from the
GpuGrid site / ask the team - looks like `ggrid_pv_...`).

## Windows
1. Download this `provider` folder.
2. Double-click **`connect.bat`**.
3. Paste your provider token when asked.
4. Leave the window open - your GPU is now earning. Close it to stop.

## Linux / macOS
```bash
PROVIDER_TOKEN=ggrid_pv_... bash install.sh
```
(or run `bash install.sh` and paste the token when prompted)

## Notes
- First run downloads a model (a few GB) - that's normal.
- The tunnel URL changes each run; the installer re-registers automatically.
- Custom gateway/model: set `GGRID_GATEWAY` and `MODEL` env vars (defaults: the public
  GpuGrid API and `llama3:8b`).
- Advanced users can still run the raw agent in [`../agent`](../agent) with their own tunnel.
