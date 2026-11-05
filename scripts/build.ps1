$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Test-Path '.venv/Scripts/python.exe')) { python -m venv .venv }
& .venv/Scripts/python.exe -m pip install -r requirements-lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& .venv/Scripts/python.exe -m pytest -q
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
& .venv/Scripts/python.exe -m PyInstaller --noconfirm --clean --onefile --windowed --name DesignCodeAgent --collect-data yaml --add-data 'codeagent/acceptance/auth.cjs;codeagent/acceptance' --add-data 'codeagent/cases;codeagent/cases' desktop.py
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
$releaseDir = Join-Path (Get-Location) 'dist'
New-Item -ItemType Directory -Force (Join-Path $releaseDir 'examples/inputs') | Out-Null
Copy-Item -LiteralPath 'Architecture_Documentation.md','Architecture_View.md' -Destination (Join-Path $releaseDir 'examples/inputs')
Copy-Item -LiteralPath 'README.md' -Destination $releaseDir
Copy-Item -LiteralPath 'LICENSE' -Destination $releaseDir
Copy-Item -LiteralPath 'docs' -Destination $releaseDir -Recurse -Force
$hash = (Get-FileHash (Join-Path $releaseDir 'DesignCodeAgent.exe') -Algorithm SHA256).Hash.ToLower()
"$hash  DesignCodeAgent.exe" | Set-Content -Encoding ascii (Join-Path $releaseDir 'SHA256SUMS.txt')
Write-Output "Built: $releaseDir/DesignCodeAgent.exe"
