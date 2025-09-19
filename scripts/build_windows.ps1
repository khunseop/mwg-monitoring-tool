param(
    [string]$Name = "PPAT",
    [string]$PyVersion = "3.10",
    [string]$PyInstallerVersion = "6.11.0"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host "[BUILD] $msg" -ForegroundColor Cyan
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

# Create venv if missing
if (-not (Test-Path ".venv")) {
    Write-Step "Create venv (.venv)"
    & $pythonCmd -m venv .venv
}

# Activate venv
Write-Step "Activate venv"
. .\.venv\Scripts\Activate.ps1

# Upgrade pip and install deps
Write-Step "Install Python deps"
pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller==$PyInstallerVersion

# Build with PyInstaller
Write-Step "Run PyInstaller"
$argsList = @(
    "--name", $Name,
    "--onefile",
    "--noconfirm",
    "--noconsole",
    "--add-data", "app/templates;app/templates",
    "--add-data", "app/static;app/static",
    "--add-data", "docs;docs",
    "--collect-all", "uvicorn",
    "--collect-all", "fastapi_standalone_docs",
    "--collect-all", "aiosnmp",
    "--collect-all", "asyncio_dgram",
    "--collect-all", "pyasn1",
    "--collect-all", "paramiko",
    "--collect-all", "pynacl",
    "--collect-all", "bcrypt",
    "--hidden-import", "dotenv",
    "--hidden-import", "Jinja2",
    "--hidden-import", "cryptography.hazmat.bindings._rust",
    "--additional-hooks-dir", "hooks",
    "run_app.py"
)

pyinstaller @argsList

Write-Host "" 
Write-Host "Build complete: `"$((Resolve-Path "dist\$Name.exe").Path)`"" -ForegroundColor Green
Write-Host "Run: .\dist\$Name.exe" -ForegroundColor Green

