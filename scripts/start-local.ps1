$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$runtimeExe = Join-Path (Get-Location) '.runtime/ollama/ollama.exe'
$env:OLLAMA_MODELS = Join-Path (Get-Location) '.runtime/models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_HOST = '127.0.0.1:11434'
try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 } catch {
  if (-not (Test-Path -LiteralPath $runtimeExe)) { throw 'Install the local Ollama runtime first. See README.md.' }
  Start-Process -FilePath $runtimeExe -ArgumentList 'serve' -WindowStyle Hidden -RedirectStandardOutput '.runtime/ollama-stdout.log' -RedirectStandardError '.runtime/ollama-stderr.log'
}
$env:APP_URL = 'http://127.0.0.1:3000'
& npx.cmd tsx scripts/init-auth.ts
# `npm run start` below runs Next.js in production mode (it reads .env.production*,
# .env.local and .env). The worker picks the same files by NODE_ENV, so give it
# the same mode; without this it would read the development files instead.
$env:NODE_ENV = 'production'
Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList '--import', 'tsx', 'scripts/analysis-worker.ts' -WindowStyle Hidden -RedirectStandardOutput '.runtime/worker-stdout.log' -RedirectStandardError '.runtime/worker-stderr.log'
# Account mail. With no SMTP_URL the web process also captures mail to the
# private .data/mail-outbox folder on its own; this worker is what sends real
# mail when SMTP_URL is configured (and is harmless otherwise).
Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList '--import', 'tsx', 'scripts/mail-worker.ts' -WindowStyle Hidden -RedirectStandardOutput '.runtime/mail-worker-stdout.log' -RedirectStandardError '.runtime/mail-worker-stderr.log'
& npm.cmd run start -- --hostname 127.0.0.1



