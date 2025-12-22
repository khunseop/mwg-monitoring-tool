# Generate PyInstaller spec file for better control over DLL inclusion
param(
    [string]$Name = "PMT",
    [string]$PyVersion = "3.10"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host "[SPEC] $msg" -ForegroundColor Cyan
}

# Move to repo root
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

# Choose Python launcher
$python = $null
try {
    $python = (Get-Command "py" -ErrorAction Stop).Path
} catch {}
if ($python) {
    $pythonCmd = "py -$PyVersion"
} else {
    $pythonCmd = "python"
}

# Activate venv if exists
if (Test-Path ".venv") {
    Write-Step "Activate venv"
    . .\.venv\Scripts\Activate.ps1
}

Write-Step "Generate spec file"
pyinstaller --name $Name `
    --onefile `
    --noconsole `
    --add-data "app/templates;app/templates" `
    --add-data "app/static;app/static" `
    --add-data "docs;docs" `
    --collect-all uvicorn `
    --collect-all fastapi_standalone_docs `
    --collect-all aiosnmp `
    --collect-all asyncio_dgram `
    --collect-all pyasn1 `
    --collect-all paramiko `
    --collect-all pynacl `
    --collect-all bcrypt `
    --collect-all cryptography `
    --hidden-import dotenv `
    --hidden-import Jinja2 `
    --hidden-import "cryptography.hazmat.bindings._rust" `
    --additional-hooks-dir hooks `
    run_app.py

Write-Host ""
Write-Host "Spec file generated: `"$((Resolve-Path "$Name.spec").Path)`"" -ForegroundColor Green
Write-Host "Edit the spec file to add DLLs manually if needed, then run: pyinstaller $Name.spec" -ForegroundColor Yellow

