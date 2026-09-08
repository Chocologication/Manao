param([string]$Maven = "mvn.cmd")

$ErrorActionPreference = "Stop"
$backend = Split-Path $PSScriptRoot -Parent
$agent = Join-Path (Split-Path $backend -Parent) "workspace-agent"

# Compile both real modules without starting the backend or touching its MySQL database.
foreach ($module in @($backend, $agent)) {
    Push-Location $module
    try {
        & $Maven '-q' '-DskipTests' 'test-compile'
        if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $module" }
    } finally { Pop-Location }
}
Push-Location $backend
try {
    & $Maven '-q' 'dependency:build-classpath' '-Dmdep.outputFile=target/contract-classpath.txt'
    if ($LASTEXITCODE -ne 0) { throw "Cannot resolve contract test classpath" }
    $dependencies = [IO.File]::ReadAllText((Join-Path $backend 'target/contract-classpath.txt')).Trim()
    $classpath = (@((Join-Path $agent 'target/classes'), (Join-Path $backend 'target/classes'),
        (Join-Path $backend 'target/test-classes'), $dependencies) -join [IO.Path]::PathSeparator)
    $classes = Join-Path $backend 'target/contract-classes'
    [IO.Directory]::CreateDirectory($classes) | Out-Null
    $source = Join-Path $backend 'src/contract-test/java/com/manao/poc4/contract/WorkspaceHttpContractCheck.java'
    & javac '-encoding' 'UTF-8' '-cp' $classpath '-d' $classes $source
    if ($LASTEXITCODE -ne 0) { throw "Cannot compile HTTP contract check" }
    # Each run owns a fresh workspace. Retain its receipts under ignored target/ for diagnosis.
    $workspace = Join-Path $backend ('target/contract-workspaces/' + [guid]::NewGuid().ToString('N'))
    & java '-cp' ($classes + [IO.Path]::PathSeparator + $classpath) 'com.manao.poc4.contract.WorkspaceHttpContractCheck' $workspace
    if ($LASTEXITCODE -ne 0) { throw "HTTP contract check failed; workspace retained at $workspace" }
    Write-Host "Local HTTP contract PASS. MySQL/Kubernetes/browser gate NOT covered."
} finally { Pop-Location }
