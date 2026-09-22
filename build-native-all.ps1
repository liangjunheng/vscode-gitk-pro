[CmdletBinding()]
param(
    [ValidateRange(1, 64)]
    [int]$Jobs = [Math]::Min(4, [Environment]::ProcessorCount),

    [switch]$MissingOnly,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'vscode-gitk-native-tools'))
if ([IO.Path]::GetDirectoryName($toolsRoot.TrimEnd('\')) -ne $repositoryRoot.TrimEnd('\')) {
    throw "Native tools directory is outside the repository: $toolsRoot"
}

New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
$env:VSCODE_GITK_NATIVE_TOOLS = $toolsRoot

$nativeArguments = @('run', 'build:native:all', '--', '--jobs', "$Jobs")
if ($MissingOnly) {
    $nativeArguments += '--missing'
}
if ($DryRun) {
    $nativeArguments += '--dry-run'
}

Push-Location -LiteralPath $repositoryRoot
try {
    Write-Host "Native tools: $toolsRoot"
    Write-Host "Parallel jobs: $Jobs"
    & npm.cmd @nativeArguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
