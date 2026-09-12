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
$e2eExit = 1
$verifyExit = 1
try {
    Push-Location -LiteralPath $frontendDir
    try {
        pnpm exec playwright test $spec --project=stage6 --workers=1 '--reporter=list,json'
        $e2eExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    Push-Location -LiteralPath $backendDir
    try {
        $mvn = 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.14\ed7edd442f634ac1c1ef5ba2b61b6d690b5221091f1a8e1123f5fadcc967520d\bin\mvn.cmd'
        if (-not (Test-Path -LiteralPath $mvn)) {
            $mvn = 'mvn'
        }
        & $mvn -B '-Dtest=ProjectCleanupEvidenceTest' '-Dmanao.stage6.cleanup.verify=true' test
        $verifyExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

$summary = @{
    suite = $Suite
    spec = $spec
    e2eExit = $e2eExit
    verifyExit = $verifyExit
    status = if ($e2eExit -eq 0 -and $verifyExit -eq 0) { 'PENDING_HUMAN_REVIEW' } else { 'FAILED' }
}
$summaryPath = Join-Path $EvidenceDir 'run-summary.json'
[System.IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
if ($e2eExit -ne 0 -or $verifyExit -ne 0) {
    exit 1
}
exit 0
