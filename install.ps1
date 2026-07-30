$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

function Get-NodeMajor {
  try {
    return [int](& node -p "process.versions.node.split('.')[0]")
  } catch {
    return 0
  }
}

$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
  Write-Host "Node.js 20 or newer is required. Installing the current LTS release..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if ($nodeMajor -gt 0) {
      winget upgrade --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    } else {
      winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    }
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    choco upgrade nodejs-lts -y
  } else {
    throw "Automatic Node.js installation requires winget or Chocolatey. Install either package manager, then run this script again."
  }

  $nodeDirectory = Join-Path $env:ProgramFiles "nodejs"
  if (Test-Path -LiteralPath $nodeDirectory) {
    $env:Path = "$nodeDirectory;$env:Path"
  }
  $nodeMajor = Get-NodeMajor
}

if ($nodeMajor -lt 20) {
  throw "Node.js installation completed but this terminal cannot find Node 20+. Reopen PowerShell and run install.ps1 again."
}

Write-Host "Using Node.js $(& node --version)"
Write-Host "Installing desktop installer dependencies..."
& npm install
if ($LASTEXITCODE -ne 0) {
  throw "Dependency installation failed with exit code $LASTEXITCODE."
}
& npm run setup
if ($LASTEXITCODE -ne 0) {
  throw "Setup failed with exit code $LASTEXITCODE."
}
