# Stage 6A operator-injected faults. Run as stage6-operator, never as Alice/Bob or the 6A kubeconfig.
# Writes STAGE6_FAULT_EVIDENCE JSON: operator identity, action, timestamps, sha256 target hash, result.
#
# Examples:
#   $env:STAGE6_FAULT = 'bridge-loss'
#   $env:STAGE6_OPERATOR_KUBECONFIG = 'D:\path\to\stage6-operator-kubeconfig'
#   $env:STAGE6_NAMESPACE = 'manao-stage6-test'
#   $env:STAGE6_FAULT_TARGET = '<projectId>'
#   $env:STAGE6_FAULT_EVIDENCE = 'D:\tmp\stage6-fault-evidence.json'
#   powershell -NoProfile -File poc4/backend/scripts/inject-stage6-fault.ps1

$ErrorActionPreference = 'Stop'
$fault = $env:STAGE6_FAULT
$operator = if ($env:STAGE6_OPERATOR_ID) { $env:STAGE6_OPERATOR_ID } else { 'stage6-operator' }
$namespace = if ($env:STAGE6_NAMESPACE) { $env:STAGE6_NAMESPACE } else { 'manao-stage6-test' }
$evidencePath = $env:STAGE6_FAULT_EVIDENCE
if (-not $fault) { throw 'STAGE6_FAULT is required (backend-restart | tunnel-loss | bridge-loss)' }
if (-not $evidencePath) { throw 'STAGE6_FAULT_EVIDENCE is required' }

function Write-Evidence([string]$Action, [string]$TargetHash, [hashtable]$Proof) {
    $payload = [ordered]@{
        operator = $operator
        action = $Action
        startedAt = $script:startedAt
        endedAt = [DateTime]::UtcNow.ToString('o')
        targetHash = $TargetHash
        result = 'injected'
        proof = $Proof
    }
    $json = $payload | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($evidencePath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-Sha256([string]$Value) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

$script:startedAt = [DateTime]::UtcNow.ToString('o')

if ($fault -eq 'bridge-loss') {
    $kubeconfig = $env:STAGE6_OPERATOR_KUBECONFIG
    $projectId = $env:STAGE6_FAULT_TARGET
    if (-not $kubeconfig) { throw 'STAGE6_OPERATOR_KUBECONFIG is required for bridge-loss' }
    if (-not $projectId) { throw 'STAGE6_FAULT_TARGET (project id) is required for bridge-loss' }
    $pod = "manao-ws-$projectId"
    $raw = kubectl --kubeconfig $kubeconfig -n $namespace get pod $pod -o json | Out-String
    $parsed = $raw | ConvertFrom-Json
    if ($parsed.metadata.labels.'stage6-test' -ne 'true') {
        throw 'refusing to delete a pod without stage6-test=true'
    }
    if ($parsed.metadata.labels.'manao.poc4/component' -ne 'workspace') {
        throw 'refusing to delete a non-workspace pod'
    }
    kubectl --kubeconfig $kubeconfig -n $namespace delete pod $pod --wait=false | Out-Null
    Write-Evidence 'bridge-loss' (Get-Sha256 "pod/$pod") @{ label = 'stage6-test=true'; deleted = $true; component = 'workspace' }
    return
}

if ($fault -eq 'backend-restart') {
    $cmd = $env:STAGE6_BACKEND_RESTART_CMD
    if (-not $cmd) { throw 'STAGE6_BACKEND_RESTART_CMD is required for backend-restart' }
    $pidBefore = $env:STAGE6_BACKEND_PID
    Invoke-Expression $cmd
    Write-Evidence 'backend-restart' (Get-Sha256 'backend-restart') @{ commandRan = $true; pidBefore = $pidBefore }
    return
}

if ($fault -eq 'tunnel-loss') {
    $cmd = $env:STAGE6_TUNNEL_STOP_CMD
    if (-not $cmd) { throw 'STAGE6_TUNNEL_STOP_CMD is required for tunnel-loss' }
    Invoke-Expression $cmd
    Write-Evidence 'tunnel-loss' (Get-Sha256 'tunnel-loss') @{ commandRan = $true }
    return
}

throw "unknown STAGE6_FAULT: $fault"
