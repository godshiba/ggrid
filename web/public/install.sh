#!/usr/bin/env bash
# GpuGrid — one-step provider installer (Linux / macOS, incl. Apple Silicon M1–M5).
# Installs Ollama + cloudflared (tunnel, no account), exposes the GPU and joins the grid.
#
#   PROVIDER_TOKEN=ggrid_pv_... bash install.sh
#
set -euo pipefail

GATEWAY="${GGRID_GATEWAY:-https://gpugrid.app}"; GATEWAY="${GATEWAY%/}"
MODEL="${MODEL:-llama3:8b}"
PROVIDER_TOKEN="${PROVIDER_TOKEN:-}"
OS="$(uname -s)"      # Linux | Darwin
ARCH="$(uname -m)"    # x86_64 | aarch64 (Linux ARM) | arm64 (Apple Silicon M1–M5)
mkdir -p "$HOME/.gpugrid"

info() { printf "\033[32m[GpuGrid]\033[0m %s\n" "$1"; }

if [ -z "$PROVIDER_TOKEN" ]; then read -rp "Paste your provider token: " PROVIDER_TOKEN; fi
[ -n "$PROVIDER_TOKEN" ] || { echo "A provider token is required."; exit 1; }

models_json() {
  curl -fsS http://localhost:11434/api/tags \
    | grep -oE '"name":"[^"]+"' | sed 's/"name":"//; s/"$//' \
    | awk 'BEGIN{ORS="";print "["} {if(NR>1)printf ",";printf "\"%s\"",$0} END{print "]"}'
}

# Human-readable GPU/chip name for the dashboard (best-effort, never fails the run).
gpu_info() {
  if [ "$OS" = "Darwin" ]; then
    sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1
  else
    echo ""
  fi
}

# --- 1. Ollama ---
if ! command -v ollama >/dev/null 2>&1; then
  info "Installing Ollama..."
  if [ "$OS" = "Darwin" ]; then
    # macOS (Apple Silicon M1–M5 or Intel): the ollama.com/install.sh is Linux-only.
    if command -v brew >/dev/null 2>&1; then
      brew install ollama
    else
      info "Downloading Ollama for macOS..."
      curl -fsSL "https://ollama.com/download/Ollama-darwin.zip" -o /tmp/Ollama-darwin.zip
      ditto -x -k /tmp/Ollama-darwin.zip /Applications/ >/dev/null 2>&1 || true
      export PATH="/Applications/Ollama.app/Contents/Resources:$PATH"
    fi
    command -v ollama >/dev/null 2>&1 \
      || { echo "Could not install Ollama automatically. Get it from https://ollama.com/download, then re-run."; exit 1; }
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
fi
if ! curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
  info "Starting Ollama..."; (ollama serve >/dev/null 2>&1 &)
  for _ in $(seq 1 30); do curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi
info "Downloading model '$MODEL' (first run can be a few GB)..."; ollama pull "$MODEL"

# --- 2. cloudflared ---
if ! command -v cloudflared >/dev/null 2>&1; then
  info "Installing cloudflared..."
  base="https://github.com/cloudflare/cloudflared/releases/latest/download"
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install cloudflared
  else
    case "$OS-$ARCH" in
      Linux-x86_64)   curl -fsSL "$base/cloudflared-linux-amd64"  -o "$HOME/.gpugrid/cloudflared";;
      Linux-aarch64)  curl -fsSL "$base/cloudflared-linux-arm64"  -o "$HOME/.gpugrid/cloudflared";;
      Darwin-arm64)   curl -fsSL "$base/cloudflared-darwin-arm64.tgz" -o /tmp/cf.tgz; tar -xzf /tmp/cf.tgz -C "$HOME/.gpugrid";;  # M1–M5
      Darwin-x86_64)  curl -fsSL "$base/cloudflared-darwin-amd64.tgz" -o /tmp/cf.tgz; tar -xzf /tmp/cf.tgz -C "$HOME/.gpugrid";;  # Intel Mac
      *) echo "Install cloudflared manually: https://github.com/cloudflare/cloudflared/releases"; exit 1;;
    esac
    chmod +x "$HOME/.gpugrid/cloudflared"
  fi
  export PATH="$HOME/.gpugrid:$PATH"
fi

# --- 3. open tunnel ---
LOG="$(mktemp)"
info "Opening secure tunnel..."
cloudflared tunnel --url http://localhost:11434 --no-autoupdate >"$LOG" 2>&1 &
CF_PID=$!
PUBLIC_URL=""
for _ in $(seq 1 40); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -n1 || true)"
  [ -n "$PUBLIC_URL" ] && break; sleep 1
done
[ -n "$PUBLIC_URL" ] || { echo "Tunnel failed to start."; kill "$CF_PID" 2>/dev/null || true; exit 1; }
info "Your node URL: $PUBLIC_URL"

# --- 4. register ---
GPU="$(gpu_info)"
REG="$(curl -fsS -X POST "$GATEWAY/nodes/register" -H "content-type: application/json" \
  -d "{\"url\":\"$PUBLIC_URL\",\"models\":$(models_json),\"gpuInfo\":\"$GPU\",\"providerToken\":\"$PROVIDER_TOKEN\"}")"
NODE_ID="$(echo "$REG"   | grep -oE '"nodeId":"[^"]+"'     | sed 's/"nodeId":"//; s/"$//')"
NODE_SECRET="$(echo "$REG" | grep -oE '"nodeSecret":"[^"]+"' | sed 's/"nodeSecret":"//; s/"$//')"
[ -n "$NODE_ID" ] || { echo "Registration failed: $REG"; kill "$CF_PID" 2>/dev/null || true; exit 1; }
info "Connected! Node id: $NODE_ID. Keep this window open (Ctrl+C to stop)."

cleanup() {
  info "Disconnecting..."
  curl -fsS -X DELETE "$GATEWAY/nodes/$NODE_ID" -H "x-node-secret: $NODE_SECRET" >/dev/null 2>&1 || true
  kill "$CF_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# --- 5. heartbeat loop ---
while true; do
  curl -fsS -X POST "$GATEWAY/nodes/$NODE_ID/heartbeat" -H "content-type: application/json" \
    -H "x-node-secret: $NODE_SECRET" -d "{\"status\":\"ONLINE\",\"models\":$(models_json)}" >/dev/null 2>&1 \
    || info "heartbeat failed"
  printf "[GpuGrid] online %s\n" "$(date +%H:%M:%S)"
  sleep 15
done
