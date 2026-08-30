$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "creating .venv ..."
    py -3.12 -m venv (Join-Path $root ".venv")
}
& $python -m pip install --upgrade pip --quiet
& $python -m pip install -r (Join-Path $root "requirements.txt") --quiet
Write-Host "ready."
