param(
    [string]$Python = '.venv/Scripts/python.exe',
    [string]$OutputDirectory = 'dist/v03-build',
    [ValidateSet('both','main','prototype')][string]$Track = 'both'
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$workspace = (Get-Location).Path
$output = [IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
$distRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'dist')) + [IO.Path]::DirectorySeparatorChar
if (-not $output.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $output)) {
    throw 'Output must be a new directory below workspace dist; existing releases are preserved'
}
if (-not (Test-Path -LiteralPath $Python) -and -not (Get-Command $Python -ErrorAction SilentlyContinue)) { throw 'Python environment missing; install fixed build dependencies first' }
& $Python -m pytest -q
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; no executable is built' }
foreach ($program in @(
    @{Name='DesignCodeAgent'; Entry='desktop.py'; Track='main'},
    @{Name='DesignCodeAgent-Superagent'; Entry='desktop_superagent.py'; Track='prototype'}
)) {
    if ($Track -ne 'both' -and $program.Track -ne $Track) { continue }
    if (-not (Test-Path -LiteralPath $program.Entry)) { throw "Missing entrypoint: $($program.Entry)" }
    $target = Join-Path $output $program.Track
    $authData = (Join-Path $workspace 'codeagent/acceptance/auth.cjs') + ';codeagent/acceptance'
    $caseData = (Join-Path $workspace 'codeagent/cases') + ';codeagent/cases'
    & $Python -m PyInstaller --noconfirm --clean --onefile --windowed --distpath $target --workpath "build/v03-$($program.Track)" --specpath "build/v03-$($program.Track)" --name $program.Name --collect-data yaml --collect-data certifi --add-data $authData --add-data $caseData $program.Entry
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed: $($program.Name)" }
    New-Item -ItemType Directory -Force (Join-Path $target 'examples/inputs') | Out-Null
    Copy-Item -LiteralPath 'Architecture_Documentation.md','Architecture_View.md' -Destination (Join-Path $target 'examples/inputs')
    foreach ($case in @('temperature-converter', 'superagent-health', 'library')) {
        Copy-Item -LiteralPath (Join-Path 'benchmarks' $case) -Destination (Join-Path $target 'examples') -Recurse
    }
    $hash = (Get-FileHash -LiteralPath (Join-Path $target "$($program.Name).exe") -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($program.Name).exe" | Set-Content -Encoding ascii (Join-Path $target 'SHA256SUMS.txt')
}
Write-Output "Built selected track ($Track) under $output. Clean-Windows and real-model acceptance remain separate checks."
