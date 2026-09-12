param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('cleanup', 'basic')]
    [string]$Suite,
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDir
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$frontendDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path (Split-Path -Parent $frontendDir) 'backend'
$spec = if ($Suite -eq 'cleanup') {
    'tests/e2e/stage6-cleanup.spec.ts'
} else {
    'tests/e2e/stage6-real-backend.spec.ts'
}

New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
if (-not $env:STAGE6_CLEANUP_LEDGER_DIR) {
    $env:STAGE6_CLEANUP_LEDGER_DIR = Join-Path $EvidenceDir 'ledger'
}
New-Item -ItemType Directory -Force -Path $env:STAGE6_CLEANUP_LEDGER_DIR | Out-Null
if (-not $env:PLAYWRIGHT_JSON_OUTPUT_NAME) {
    $env:PLAYWRIGHT_JSON_OUTPUT_NAME = Join-Path $EvidenceDir 'results.json'
}

function Quote-CmdArg {
    param([string]$Value)
    if ($Value -match '[\s,&()^]') {
        return '"' + ($Value -replace '"', '\"') + '"'
    }
    return $Value
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$LogPath
    )
    $argLine = ($ArgumentList | ForEach-Object { Quote-CmdArg $_ }) -join ' '
    $batch = 'cd /d "' + $WorkingDirectory + '" && "' + $FilePath + '" ' + $argLine + ' > "' + $LogPath + '" 2>&1'
    & cmd.exe /c $batch | Out-Null
    $code = $LASTEXITCODE
    if (Test-Path -LiteralPath $LogPath) {
        Get-Content -LiteralPath $LogPath | ForEach-Object { Write-Host $_ }
    }
    if ($null -eq $code) {
        return 1
    }
    return [int]$code
}

function Read-PlaywrightOk {
    param([string]$ResultsPath)
    if (-not (Test-Path -LiteralPath $ResultsPath)) {
        return $false
    }
    try {
        $report = Get-Content -LiteralPath $ResultsPath -Raw | ConvertFrom-Json
        if ($null -eq $report.stats) {
            return $false
        }
        $expected = [int]$report.stats.expected
        $unexpected = [int]$report.stats.unexpected
        $skipped = [int]$report.stats.skipped
        $errorCount = @($report.errors).Count
        return ($expected -gt 0 -and $unexpected -eq 0 -and $skipped -eq 0 -and $errorCount -eq 0)
    } catch {
        return $false
    }
}

$e2eProcessExit = 1
$verifyExit = 1
try {
    $pnpmCmd = Join-Path (Split-Path -Parent (Get-Command pnpm).Source) 'pnpm.cmd'
    if (-not (Test-Path -LiteralPath $pnpmCmd)) {
        $pnpmCmd = 'pnpm.cmd'
    }
    $e2eProcessExit = Invoke-Native `
        -FilePath $pnpmCmd `
        -ArgumentList @('exec', 'playwright', 'test', $spec, '--project=stage6', '--workers=1', '--reporter=list,json') `
        -WorkingDirectory $frontendDir `
        -LogPath (Join-Path $EvidenceDir 'playwright.log')
} finally {
    $mvn = 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.14\ed7edd442f634ac1c1ef5ba2b61b6d690b5221091f1a8e1123f5fadcc967520d\bin\mvn.cmd'
    if (-not (Test-Path -LiteralPath $mvn)) {
        $mvn = 'mvn.cmd'
    }
    $verifyExit = Invoke-Native `
        -FilePath $mvn `
        -ArgumentList @('-B', '-Dtest=ProjectCleanupEvidenceTest', '-Dmanao.stage6.cleanup.verify=true', 'test') `
        -WorkingDirectory $backendDir `
        -LogPath (Join-Path $EvidenceDir 'verifier.log')
}

$playwrightOk = Read-PlaywrightOk -ResultsPath $env:PLAYWRIGHT_JSON_OUTPUT_NAME
$e2eExit = $e2eProcessExit
if ($e2eProcessExit -ne 0 -and $playwrightOk) {
    $e2eExit = 0
}

$summary = @{
    suite = $Suite
    spec = $spec
    e2eExit = [int]$e2eExit
    e2eProcessExit = [int]$e2eProcessExit
    playwrightOk = $playwrightOk
    verifyExit = [int]$verifyExit
    status = if (($e2eExit -eq 0) -and ($verifyExit -eq 0)) { 'PENDING_HUMAN_REVIEW' } else { 'FAILED' }
}
$summaryPath = Join-Path $EvidenceDir 'run-summary.json'
[System.IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
if ($e2eExit -ne 0 -or $verifyExit -ne 0) {
    exit 1
}
exit 0