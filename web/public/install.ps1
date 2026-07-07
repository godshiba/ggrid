<#
  GpuGrid - one-step provider installer (Windows).
  Turns an idle GPU into income: installs Ollama + cloudflared, exposes the GPU
  through a secure tunnel (no account needed) and joins the GpuGrid network.

  Run:  double-click connect.bat   - or -   right-click install.ps1 → Run with PowerShell
#>
param(
  [string]$Gateway = $env:GGRID_GATEWAY,
  [string]$ProviderToken = $env:PROVIDER_TOKEN,
  [string]$Model = "llama3:8b"
)
$ErrorActionPreference = "Stop"
if (-not $Gateway) { $Gateway = "https://gpugrid.app" }
$Gateway = $Gateway.TrimEnd("/")

function Info($m) { Write-Host "[GpuGrid] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[GpuGrid] $m" -ForegroundColor Yellow }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:LOCALAPPDATA\GpuGrid"
}

Write-Host ""
Info "GpuGrid provider setup - turn your idle GPU into income."
Write-Host ""

# --- provider token ---
if (-not $ProviderToken) { $ProviderToken = Read-Host "Paste your provider token (from the GpuGrid site)" }
if (-not $ProviderToken) { throw "A provider token is required." }

# --- 1. Ollama ---
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Info "Installing Ollama..."
  try { winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements }
  catch { throw "Could not auto-install Ollama. Get it from https://ollama.com/download, then re-run." }
  Refresh-Path
}

function Ollama-Up {
  try { Invoke-RestMethod "http://localhost:11434/api/tags" -TimeoutSec 3 | Out-Null; $true } catch { $false }
}
if (-not (Ollama-Up)) {
  Info "Starting Ollama..."
  Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Ollama-Up); $i++) { Start-Sleep 1 }
}
if (-not (Ollama-Up)) { throw "Ollama is not responding on port 11434." }

# --- 2. model ---
Info "Downloading model '$Model' (first run can be a few GB)..."
ollama pull $Model

# --- 3. cloudflared (secure tunnel, no account) ---
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Info "Installing cloudflared..."
  try {
    winget install --id Cloudflare.cloudflared -e --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
  } catch {
    $dir = "$env:LOCALAPPDATA\GpuGrid"; New-Item -ItemType Directory -Force $dir | Out-Null
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "$dir\cloudflared.exe"
    Refresh-Path
  }
}

# --- 4. open tunnel, capture public URL ---
$log = "$env:TEMP\gpugrid_tunnel.log"
if (Test-Path $log) { Remove-Item $log -Force }
Info "Opening secure tunnel..."
$cf = Start-Process cloudflared -ArgumentList "tunnel --url http://localhost:11434 --no-autoupdate" -RedirectStandardError $log -PassThru -WindowStyle Hidden
$publicUrl = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep 1
  if (Test-Path $log) {
    $hit = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $publicUrl = $hit.Matches[0].Value; break }
  }
}
if (-not $publicUrl) { throw "Tunnel did not come up. Check your internet and re-run." }
Info "Your node URL: $publicUrl"

# --- 5. register with the grid ---
function Get-ModelsJson {
  $names = (Invoke-RestMethod "http://localhost:11434/api/tags").models | ForEach-Object { $_.name }
  "[" + (($names | ForEach-Object { '"' + ($_ -replace '"', '') + '"' }) -join ",") + "]"
}
# Best-effort GPU name so the node shows up labelled in the marketplace.
function Get-GpuName {
  try {
    $n = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
    if ($n) { return $n.Trim() }
  } catch {}
  try {
    $c = (Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Name)
    if ($c) { return $c.Trim() }
  } catch {}
  return ""
}
$gpuName = (Get-GpuName) -replace '"', ''
$body = '{"url":"' + $publicUrl + '","models":' + (Get-ModelsJson) + ',"gpuInfo":"' + $gpuName + '","providerToken":"' + $ProviderToken + '"}'
$reg = Invoke-RestMethod "$Gateway/nodes/register" -Method Post -ContentType "application/json" -Body $body
if (-not $reg.nodeId) { throw "Registration failed." }
Info "Connected! Node id: $($reg.nodeId)"
Write-Host ""
Info "Your GPU is now earning. Keep this window open. Press Ctrl+C to stop."
Write-Host ""

# --- 6. heartbeat loop (+ clean disconnect on exit) ---
try {
  while ($true) {
    try {
      $hb = '{"status":"ONLINE","models":' + (Get-ModelsJson) + '}'
      Invoke-RestMethod "$Gateway/nodes/$($reg.nodeId)/heartbeat" -Method Post -ContentType "application/json" `
        -Headers @{ "x-node-secret" = $reg.nodeSecret } -Body $hb | Out-Null
      Write-Host ("[GpuGrid] online {0:HH:mm:ss}" -f (Get-Date))
    } catch { Warn "heartbeat failed: $($_.Exception.Message)" }
    Start-Sleep 15
  }
}
finally {
  Warn "Disconnecting..."
  try { Invoke-RestMethod "$Gateway/nodes/$($reg.nodeId)" -Method Delete -Headers @{ "x-node-secret" = $reg.nodeSecret } | Out-Null } catch {}
  if ($cf -and -not $cf.HasExited) { Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue }
  Info "Stopped. Bye!"
}
