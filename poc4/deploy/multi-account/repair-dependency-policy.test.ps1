#Requires -Version 5.1
<#
.SYNOPSIS
  Fixture tests for repair-dependency-policy.ps1. No cluster connection.

.DESCRIPTION
  Every kubectl invocation made by the migration script is served by a generated
  mock-kubectl.cmd that reads JSON fixtures and records its calls. The tests cover:
  read-only preview (no cluster writes, no files), legacy-vs-narrowed selector detection,
  refusal on out-of-scope/broad leftover policies, refusal on unknown/mismatched specs,
  refusal on missing reviewed policies, abort on uid/resourceVersion conflicts, idempotent
  already-fixed policies, JSON Patch preconditions, and policy-only backups.

  Run with: pwsh -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1
  Exit code 0 when every fixture test passes, non-zero otherwise.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepairScript = Join-Path $PSScriptRoot 'repair-dependency-policy.ps1'
if (-not (Test-Path -LiteralPath $script:RepairScript)) {
    throw "repair-dependency-policy.ps1 not found next to the test script: $script:RepairScript"
}
$script:TestContext = 'reviewed-context'
$script:TestNamespace = 'manao-test'
$script:PolicyNamePrefix = 'manao-dep-netpol-'
$script:ManagedBy = 'manao-poc4-backend'
$script:ProjectIdLabel = 'manao.poc4/project-id'
$script:ComponentLabel = 'manao.poc4/component'
$script:NewLine = [Environment]::NewLine
$script:PassCount = 0
$script:FailCount = 0
$script:TempRoots = New-Object System.Collections.Generic.List[string]
$script:PowerShellHost = $null

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ([string]$Expected -ne [string]$Actual) {
        throw ($Message + " (expected '" + [string]$Expected + "', actual '" + [string]$Actual + "')")
    }
}

function Assert-Contains {
    param([string]$Text, [string]$Needle, [string]$Message)
    if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw ($Message + " (missing '" + $Needle + "' in script output; output was: " + $Text + ")")
    }
}

function Assert-NotContains {
    param([string]$Text, [string]$Needle, [string]$Message)
    if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0) {
        throw ($Message + " (unexpected '" + $Needle + "')")
    }
}

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function New-TestDirectory {
    $root = Join-Path $env:TEMP ('manao-repair-policy-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $script:TempRoots.Add($root)
    return $root
}

function Get-PowerShellHost {
    if ($null -ne $script:PowerShellHost) { return $script:PowerShellHost }
    $candidates = @(
        (Join-Path $PSHOME 'pwsh.exe'),
        (Join-Path $PSHOME 'powershell.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $script:PowerShellHost = $candidate
            return $script:PowerShellHost
        }
    }
    throw 'could not locate a PowerShell host executable for child scenario runs'
}

function Invoke-ChildPowerShell {
    param([string[]]$Arguments)
    $hostExecutable = Get-PowerShellHost
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 turns redirected native stderr into a terminating
        # NativeCommandError under ErrorActionPreference=Stop; the script under test reports
        # refusals on stderr, so capture it explicitly instead.
        $ErrorActionPreference = 'Continue'
        $output = & $hostExecutable @Arguments 2> $stderrFile
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        $stdout = (@($output) | Out-String)
        $stderr = ''
        if (Test-Path -LiteralPath $stderrFile) {
            $stderr = [System.IO.File]::ReadAllText($stderrFile)
        }
        return [pscustomobject]@{
            ExitCode = $exitCode
            StdOut   = $stdout
            StdErr   = $stderr
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

function Write-FixtureJson {
    param([string]$Path, $Value)
    Write-Utf8NoBom -Path $Path -Text (ConvertTo-Json -InputObject $Value -Depth 30)
}

function New-Policy {
    param(
        [string]$ProjectId,
        [bool]$Narrowed = $false,
        [string]$Uid = '',
        [string]$ResourceVersion = '',
        [string]$Name = '',
        [scriptblock]$MutateSpec = $null
    )
    if ([string]::IsNullOrWhiteSpace($Name)) { $Name = $script:PolicyNamePrefix + $ProjectId }
    if ([string]::IsNullOrWhiteSpace($Uid)) { $Uid = 'uid-' + $ProjectId }
    if ([string]::IsNullOrWhiteSpace($ResourceVersion)) { $ResourceVersion = '100' }
    $requirements = @(@{ key = $script:ComponentLabel; operator = 'In'; values = @('mysql', 'redis') })
    $podSelector = @{ matchExpressions = $requirements }
    if ($Narrowed) {
        $podSelector = @{
            matchLabels      = @{ $script:ProjectIdLabel = $ProjectId }
            matchExpressions = $requirements
        }
    }
    $spec = @{
        podSelector = $podSelector
        policyTypes = @('Ingress')
        ingress     = @(@{
            from  = @(@{ podSelector = @{ matchLabels = @{ $script:ProjectIdLabel = $ProjectId } } })
            ports = @(
                @{ protocol = 'TCP'; port = 3306 },
                @{ protocol = 'TCP'; port = 6379 }
            )
        })
    }
    if ($null -ne $MutateSpec) {
        & $MutateSpec $spec
    }
    return [ordered]@{
        apiVersion = 'networking.k8s.io/v1'
        kind       = 'NetworkPolicy'
        metadata   = [ordered]@{
            name            = $Name
            namespace       = $script:TestNamespace
            uid             = $Uid
            resourceVersion = $ResourceVersion
            labels          = [ordered]@{
                'app.kubernetes.io/managed-by' = $script:ManagedBy
                'manao.poc4/project-id'        = $ProjectId
                'stage6-test'                  = 'true'
                'manao.poc4/component'         = 'dependencies'
            }
        }
        spec       = $spec
    }
}

function New-PolicyList {
    param([object[]]$Policies)
    return [ordered]@{
        apiVersion = 'networking.k8s.io/v1'
        kind       = 'NetworkPolicyList'
        items      = @($Policies)
    }
}

function New-ProjectList {
    param([object[]]$Projects)
    return @($Projects)
}

# ---------------------------------------------------------------------------
# Mock kubectl: a batch shim reading JSON files and appending every call to a log.
# It never touches a cluster. Environment variables select the fixtures.
# ---------------------------------------------------------------------------

function New-MockKubectl {
    param([string]$Directory)
    $mockPath = Join-Path $Directory 'mock-kubectl.cmd'
    $content = @'
@echo off
setlocal EnableExtensions
set "ARGS=%*"
if not "%MOCK_KUBECTL_LOG%"=="" >>"%MOCK_KUBECTL_LOG%" echo %ARGS%
echo %ARGS% | findstr /C:"get-contexts" >nul
if not errorlevel 1 goto mock_contexts
echo %ARGS% | findstr /C:" patch " >nul
if not errorlevel 1 goto mock_patch
echo %ARGS% | findstr /C:" get networkpolicies" >nul
if not errorlevel 1 goto mock_list
echo %ARGS% | findstr /C:" get networkpolicy " >nul
if not errorlevel 1 goto mock_get
goto mock_unexpected

:mock_contexts
type "%MOCK_CONTEXTS_FILE%"
exit /b 0

:mock_patch
set "TARGET="
set "PAYLOAD="
set "PREV="
for %%A in (%*) do call :track "%%A"
if not "%MOCK_PATCH_CAPTURE_DIR%"=="" copy /Y "%PAYLOAD%" "%MOCK_PATCH_CAPTURE_DIR%\%TARGET%.json" >nul
if "%MOCK_PATCH_EXIT%"=="" goto mock_patch_success
if "%MOCK_PATCH_EXIT%"=="0" goto mock_patch_success
echo Error from server (Conflict): the object has been modified; the uid/resourceVersion precondition failed 1>&2
exit /b %MOCK_PATCH_EXIT%

:mock_patch_success
if not "%MOCK_PATCHED_DIR%"=="" if exist "%MOCK_PATCHED_DIR%\%TARGET%.json" copy /Y "%MOCK_PATCHED_DIR%\%TARGET%.json" "%MOCK_STATE_DIR%\%TARGET%.json" >nul
echo networkpolicy.networking.k8s.io/%TARGET% patched
exit /b 0

:mock_list
type "%MOCK_POLICY_LIST_FILE%"
exit /b 0

:mock_get
set "TARGET="
set "PREV="
for %%A in (%*) do call :track "%%A"
if not exist "%MOCK_STATE_DIR%\%TARGET%.json" goto mock_get_missing
type "%MOCK_STATE_DIR%\%TARGET%.json"
exit /b 0

:mock_get_missing
echo Error from server (NotFound): networkpolicies.networking.k8s.io "%TARGET%" not found 1>&2
exit /b 1

:mock_unexpected
echo mock kubectl: unexpected invocation: %ARGS% 1>&2
exit /b 99

:track
if /I "%PREV%"=="networkpolicy" set "TARGET=%~1"
if /I "%PREV%"=="--patch-file" set "PAYLOAD=%~1"
set "PREV=%~1"
exit /b 0
'@
    $normalized = (($content -split "\r?\n") -join $script:NewLine)
    Write-Utf8NoBom -Path $mockPath -Text $normalized
    return $mockPath
}

# ---------------------------------------------------------------------------
# Scenario plumbing
# ---------------------------------------------------------------------------

function New-Scenario {
    $root = New-TestDirectory
    $stateDirectory = Join-Path $root 'state'
    $captureDirectory = Join-Path $root 'capture'
    $patchedDirectory = Join-Path $root 'patched'
    New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $captureDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $patchedDirectory | Out-Null
    $mockPath = New-MockKubectl -Directory $root
    $scenario = [pscustomobject]@{
        Root        = $root
        StateDir    = $stateDirectory
        CaptureDir  = $captureDirectory
        PatchedDir  = $patchedDirectory
        OutputDir   = (Join-Path $root 'output')
        MockPath    = $mockPath
        CallLog     = (Join-Path $root 'kubectl-calls.log')
        ContextsFile = (Join-Path $root 'contexts.txt')
        PoliciesFile = (Join-Path $root 'policies.json')
        ProjectsFile = (Join-Path $root 'projects.json')
    }
    Write-Utf8NoBom -Path $scenario.ContextsFile -Text ($script:TestContext + $script:NewLine)
    $env:MANAO_REPAIR_KUBECTL = $scenario.MockPath
    $env:MOCK_KUBECTL_LOG = $scenario.CallLog
    $env:MOCK_CONTEXTS_FILE = $scenario.ContextsFile
    $env:MOCK_POLICY_LIST_FILE = $scenario.PoliciesFile
    $env:MOCK_STATE_DIR = $scenario.StateDir
    $env:MOCK_PATCH_CAPTURE_DIR = $scenario.CaptureDir
    $env:MOCK_PATCHED_DIR = $scenario.PatchedDir
    $env:MOCK_PATCH_EXIT = '0'
    return $scenario
}

function Clear-MockEnvironment {
    foreach ($name in @(
        'MANAO_REPAIR_KUBECTL', 'MOCK_KUBECTL_LOG', 'MOCK_CONTEXTS_FILE',
        'MOCK_POLICY_LIST_FILE', 'MOCK_STATE_DIR', 'MOCK_PATCH_CAPTURE_DIR',
        'MOCK_PATCHED_DIR', 'MOCK_PATCH_EXIT'
    )) {
        Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
    }
}

function Invoke-RepairScript {
    param($Scenario, [switch]$Apply)
    $arguments = @(
        '-NoProfile', '-File', $script:RepairScript,
        '-Context', $script:TestContext,
        '-Namespace', $script:TestNamespace,
        '-ProjectsFile', $Scenario.ProjectsFile,
        '-OutputDirectory', $Scenario.OutputDir
    )
    if ($Apply) { $arguments += '-Apply' }
    return Invoke-ChildPowerShell -Arguments $arguments
}

function Get-MockCalls {
    param($Scenario)
    if (-not (Test-Path -LiteralPath $Scenario.CallLog)) { return @() }
    return @([System.IO.File]::ReadAllLines($Scenario.CallLog) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Assert-NoClusterWrites {
    param($Scenario)
    foreach ($call in @(Get-MockCalls -Scenario $Scenario)) {
        if ($call -match '(^| )(patch|create|delete|replace|apply|edit)( |$)') {
            throw "unexpected mutating kubectl call: $call"
        }
    }
}

function Assert-ExplicitContextAndNamespace {
    param($Scenario)
    foreach ($call in @(Get-MockCalls -Scenario $Scenario)) {
        if ($call -notmatch '--context') { throw "kubectl call lacks explicit --context: $call" }
        if ($call -notmatch '--namespace') { throw "kubectl call lacks explicit --namespace: $call" }
        if ($call -match '(^| )(-A|--all-namespaces)( |$)') { throw "kubectl call uses all namespaces: $call" }
        if ($call.IndexOf($script:TestContext, [System.StringComparison]::Ordinal) -lt 0) {
            throw "kubectl call lacks the explicit context value: $call"
        }
        if ($call.IndexOf($script:TestNamespace, [System.StringComparison]::Ordinal) -lt 0) {
            throw "kubectl call lacks the explicit namespace value: $call"
        }
    }
}

function Assert-NoSecretAccess {
    param($Scenario)
    foreach ($call in @(Get-MockCalls -Scenario $Scenario)) {
        if ($call -match 'secret') { throw "script must never read Secrets: $call" }
    }
}

function Get-PatchCalls {
    param($Scenario)
    return @(Get-MockCalls -Scenario $Scenario | Where-Object { $_ -match ' patch ' })
}

function Get-PatchPayloads {
    param($Scenario)
    $payloads = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $Scenario.CaptureDir -File -Filter '*.json')) {
        $raw = [System.IO.File]::ReadAllText($file.FullName)
        # Assign ConvertFrom-Json before wrapping: Windows PowerShell 5.1 treats a
        # top-level JSON array produced inside a pipeline as one nested array.
        $parsedOperations = $raw | ConvertFrom-Json
        $payloads += [pscustomobject]@{
            PolicyName = $file.BaseName
            Operations = @($parsedOperations)
            Raw        = $raw
        }
    }
    return $payloads
}

function Invoke-Scenario {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:PassCount++
        Write-Output ("[PASS] " + $Name)
    } catch {
        $script:FailCount++
        Write-Output ("[FAIL] " + $Name + " :: " + $_.Exception.Message)
        if ($null -ne $_.ScriptStackTrace -and $_.ScriptStackTrace.Length -gt 0) {
            Write-Output ("    at " + $_.ScriptStackTrace)
        }
    } finally {
        Clear-MockEnvironment
    }
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

function Test-PreviewIsReadOnly {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1'),
        (New-Policy -ProjectId 'p2')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-1'; projectId = 'p2' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 0 $result.ExitCode 'preview exit code'
    Assert-Contains $result.StdOut 'PREVIEW_ONLY' 'preview must announce it is read-only'
    Assert-Contains $result.StdOut 'PREVIEW_RESULT=WOULD_PATCH count=2' 'preview must count both old policies'
    Assert-Contains $result.StdOut '[NEEDS_MIGRATION] ownerId=owner-1 projectId=p1 policy=manao-dep-netpol-p1' 'p1 is detected as legacy'
    Assert-Contains $result.StdOut '[NEEDS_MIGRATION] ownerId=owner-1 projectId=p2 policy=manao-dep-netpol-p2' 'p2 is detected as legacy'
    Assert-True (-not (Test-Path -LiteralPath $scenario.OutputDir)) 'preview must not create the output directory'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'preview must not patch'
    Assert-NoClusterWrites -Scenario $scenario
    Assert-ExplicitContextAndNamespace -Scenario $scenario
    Assert-NoSecretAccess -Scenario $scenario
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $scenario.CaptureDir -File).Count 'preview must not produce patch payloads'
}

function Test-PreviewDetectsOldVersusNarrowedSelector {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Narrowed $false),
        (New-Policy -ProjectId 'p2' -Narrowed $true -ResourceVersion '200')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-2'; projectId = 'p2' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 0 $result.ExitCode 'preview exit code'
    Assert-Contains $result.StdOut '[NEEDS_MIGRATION] ownerId=owner-1 projectId=p1 policy=manao-dep-netpol-p1' 'legacy target selector needs migration'
    Assert-Contains $result.StdOut '[ALREADY_FIXED] ownerId=owner-2 projectId=p2 policy=manao-dep-netpol-p2' 'narrowed target selector is recognized'
    Assert-Contains $result.StdOut 'PREVIEW_RESULT=WOULD_PATCH count=1' 'only the legacy policy would be patched'
    Assert-True (-not (Test-Path -LiteralPath $scenario.OutputDir)) 'preview must not create the output directory'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'preview must not patch'
    Assert-NoClusterWrites -Scenario $scenario
}

function Test-PreviewRefusesOutOfScopeBroadLeftover {
    $scenario = New-Scenario
    $unreviewed = New-Policy -ProjectId 'p9' -Name 'manao-dep-netpol-p9'
    $broad = [ordered]@{
        apiVersion = 'networking.k8s.io/v1'
        kind       = 'NetworkPolicy'
        metadata   = [ordered]@{
            name            = 'legacy-allow-all'
            namespace       = $script:TestNamespace
            uid             = 'uid-legacy-allow-all'
            resourceVersion = '77'
            labels          = [ordered]@{ 'app.kubernetes.io/managed-by' = $script:ManagedBy }
        }
        spec       = [ordered]@{
            podSelector = @{}
            policyTypes = @('Ingress')
            ingress     = @(@{ from = @() })
        }
    }
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1'),
        $unreviewed,
        $broad
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 2 $result.ExitCode 'scope refusal exit code'
    Assert-Contains $result.StdOut 'RESULT=REFUSED' 'completion must be refused'
    Assert-Contains $result.StdOut '[OUT_OF_SCOPE] policy=manao-dep-netpol-p9' 'unreviewed dependency policy must be reported'
    Assert-Contains $result.StdOut '[OUT_OF_SCOPE] policy=legacy-allow-all' 'broad leftover policy must be reported'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'refusal must not patch anything'
    Assert-NoClusterWrites -Scenario $scenario
    Assert-True (-not (Test-Path -LiteralPath $scenario.OutputDir)) 'refusal must not create the output directory'
}

function Test-PreviewRefusesUnknownSpec {
    $scenario = New-Scenario
    $mutated = New-Policy -ProjectId 'p1' -MutateSpec {
        param($spec)
        $spec.ingress[0].ports = @(
            @{ protocol = 'TCP'; port = 3306 },
            @{ protocol = 'TCP'; port = 6379 },
            @{ protocol = 'TCP'; port = 9999 }
        )
    }
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @($mutated))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 2 $result.ExitCode 'unknown spec refusal exit code'
    Assert-Contains $result.StdOut '[UNKNOWN_SPEC] ownerId=owner-1 projectId=p1 policy=manao-dep-netpol-p1' 'unknown spec must be reported'
    Assert-Contains $result.StdOut 'RESULT=REFUSED' 'unknown spec must refuse completion'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'unknown spec must not be patched'
    Assert-NoClusterWrites -Scenario $scenario
}

function Test-PreviewRefusesMissingReviewedPolicy {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-1'; projectId = 'p2' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 2 $result.ExitCode 'missing policy refusal exit code'
    Assert-Contains $result.StdOut '[MISSING] ownerId=owner-1 projectId=p2 policy=manao-dep-netpol-p2' 'missing reviewed policy must be reported'
    Assert-Contains $result.StdOut 'RESULT=REFUSED' 'zero-omission failure must refuse completion'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'refusal must not patch anything'
    Assert-NoClusterWrites -Scenario $scenario
}

function Test-ApplyAbortsOnConcurrentChange {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $env:MOCK_PATCH_EXIT = '1'
    $result = Invoke-RepairScript -Scenario $scenario -Apply
    Assert-Equal 3 $result.ExitCode 'conflict abort exit code'
    Assert-Contains $result.StdOut '[FAILED] policy=manao-dep-netpol-p1 status=CONFLICT' 'conflict must be reported'
    Assert-Contains $result.StdOut 'RESULT=APPLY_FAILED' 'apply must not claim success'
    Assert-NotContains $result.StdOut 'RESULT=APPLIED' 'apply must not claim success'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenario).Count 'a rejected patch must not be retried'
    Assert-Equal 0 @(Get-MockCalls -Scenario $scenario | Where-Object { $_ -match ' get networkpolicy ' }).Count 'no read-back after a rejected patch'
    $backupFiles = @(Get-ChildItem -LiteralPath (Join-Path $scenario.OutputDir 'backup') -File -Filter '*.json' -ErrorAction SilentlyContinue)
    Assert-Equal 1 $backupFiles.Count 'the policy is backed up before the patch attempt'
    Assert-ExplicitContextAndNamespace -Scenario $scenario
    Assert-NoSecretAccess -Scenario $scenario
}

function Test-ApplyIsIdempotentForAlreadyFixedPolicies {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Narrowed $true -ResourceVersion '300'),
        (New-Policy -ProjectId 'p2' -Narrowed $true -ResourceVersion '301')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-1'; projectId = 'p2' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario -Apply
    Assert-Equal 0 $result.ExitCode 'already-fixed apply exit code'
    Assert-Contains $result.StdOut 'RESULT=ALREADY_SCOPED count=0' 'already-fixed policies are not patched again'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'already-fixed policies must not be patched'
    Assert-NoClusterWrites -Scenario $scenario
    if (Test-Path -LiteralPath $scenario.OutputDir) {
        $backupDirectory = Join-Path $scenario.OutputDir 'backup'
        if (Test-Path -LiteralPath $backupDirectory) {
            Assert-Equal 0 @(Get-ChildItem -LiteralPath $backupDirectory -File).Count 'nothing to back up when nothing is patched'
        }
    }
    Assert-NoSecretAccess -Scenario $scenario
}

function Test-ApplyBacksUpOnlyPoliciesAndPatchesOnlyTheSelector {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100'),
        (New-Policy -ProjectId 'p2' -Uid 'uid-p2' -ResourceVersion '200')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-2'; projectId = 'p2' }
    ))
    # The mock serves these as read-back objects after a successful patch.
    Write-FixtureJson -Path (Join-Path $scenario.PatchedDir 'manao-dep-netpol-p1.json') -Value (New-Policy -ProjectId 'p1' -Narrowed $true -Uid 'uid-p1' -ResourceVersion '101')
    Write-FixtureJson -Path (Join-Path $scenario.PatchedDir 'manao-dep-netpol-p2.json') -Value (New-Policy -ProjectId 'p2' -Narrowed $true -Uid 'uid-p2' -ResourceVersion '201')
    $result = Invoke-RepairScript -Scenario $scenario -Apply
    Assert-Equal 0 $result.ExitCode 'apply exit code'
    Assert-Contains $result.StdOut 'RESULT=APPLIED count=2' 'both legacy policies are migrated'
    Assert-Contains $result.StdOut '[PATCHED] policy=manao-dep-netpol-p1' 'p1 patch is reported'
    Assert-Contains $result.StdOut '[PATCHED] policy=manao-dep-netpol-p2' 'p2 patch is reported'
    Assert-Contains $result.StdOut '[VERIFIED] policy=manao-dep-netpol-p1' 'p1 read-back is verified'
    Assert-Contains $result.StdOut '[VERIFIED] policy=manao-dep-netpol-p2' 'p2 read-back is verified'
    Assert-Equal 2 @(Get-PatchCalls -Scenario $scenario).Count 'one patch per legacy policy'
    Assert-ExplicitContextAndNamespace -Scenario $scenario
    Assert-NoSecretAccess -Scenario $scenario

    # The JSON Patch must pin uid/resourceVersion and replace ONLY the pod selector.
    $payloads = @(Get-PatchPayloads -Scenario $scenario)
    Assert-Equal 2 $payloads.Count 'one patch payload per migrated policy'
    foreach ($payload in $payloads) {
        $operations = @($payload.Operations)
        Assert-Equal 3 $operations.Count 'patch must contain only two tests plus one replace'
        Assert-Equal 'test' $operations[0].op 'first patch op pins the uid'
        Assert-Equal '/metadata/uid' $operations[0].path 'first patch op path'
        Assert-Equal 'test' $operations[1].op 'second patch op pins the resource version'
        Assert-Equal '/metadata/resourceVersion' $operations[1].path 'second patch op path'
        Assert-Equal 'replace' $operations[2].op 'only the pod selector is replaced'
        Assert-Equal '/spec/podSelector' $operations[2].path 'only the pod selector is replaced'
        foreach ($operation in $operations) {
            Assert-True ($operation.path -in @('/metadata/uid', '/metadata/resourceVersion', '/spec/podSelector')) ('unexpected patch path: ' + $operation.path)
        }
        Assert-NotContains $payload.Raw '/spec/ingress' 'patch must not touch ingress'
        $expectedProjectId = 'p1'
        if ($payload.PolicyName -eq 'manao-dep-netpol-p2') { $expectedProjectId = 'p2' }
        Assert-Equal ('uid-' + $expectedProjectId) $operations[0].value 'uid test value must match the reviewed object'
        Assert-Equal 'test' $operations[1].op 'resourceVersion test op'
        $matchLabels = Get-Prop $operations[2].value 'matchLabels'
        Assert-Equal $expectedProjectId (Get-Prop $matchLabels $script:ProjectIdLabel) 'replace selector must carry the project label'
        Assert-Equal 1 @($matchLabels.PSObject.Properties.Name).Count 'replace selector matchLabels must contain only the project label'
        $matchExpressions = @(Get-Prop $operations[2].value 'matchExpressions')
        Assert-Equal 1 $matchExpressions.Count 'replace selector keeps the component expression'
        Assert-Equal $script:ComponentLabel $matchExpressions[0].key 'replace selector component key'
        Assert-Equal 'In' $matchExpressions[0].operator 'replace selector component operator'
        Assert-Equal 'mysql,redis' (@($matchExpressions[0].values) -join ',') 'replace selector component values'
    }

    # Backups contain NetworkPolicies only, never Secrets, and hold the pre-patch spec.
    $backupDirectory = Join-Path $scenario.OutputDir 'backup'
    $backupFiles = @(Get-ChildItem -LiteralPath $backupDirectory -File)
    Assert-Equal 2 $backupFiles.Count 'one policy backup per patched policy'
    foreach ($backupFile in $backupFiles) {
        $backup = [System.IO.File]::ReadAllText($backupFile.FullName) | ConvertFrom-Json
        Assert-Equal 'NetworkPolicy' $backup.kind 'backup must contain only NetworkPolicies'
        Assert-Equal 'networking.k8s.io/v1' $backup.apiVersion 'backup bearer policy api version'
        $podSelector = Get-Prop $backup.spec 'podSelector'
        Assert-True ($null -eq (Get-Prop $podSelector 'matchLabels')) 'the backup holds the pre-patch (broad) selector'
        Assert-NotContains ([System.IO.File]::ReadAllText($backupFile.FullName)) 'stringData' 'backup must not contain secret data'
        Assert-NotContains ([System.IO.File]::ReadAllText($backupFile.FullName)) 'Secret' 'backup must not contain Secret objects'
    }
    Assert-Equal 2 @(Get-MockCalls -Scenario $scenario | Where-Object { $_ -match ' get networkpolicy ' }).Count 'every patch is read back and verified'
    $reportPath = Join-Path $scenario.OutputDir 'apply-report.json'
    Assert-True (Test-Path -LiteralPath $reportPath) 'apply report is written'
    $report = [System.IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
    Assert-Equal 'APPLIED' $report.status 'apply report status'
    Assert-Equal '2' $report.appliedCount 'apply report count'
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

$exitCode = 0
try {
    Invoke-Scenario 'default preview is read-only and writes nothing' { Test-PreviewIsReadOnly }
    Invoke-Scenario 'preview distinguishes legacy and narrowed selectors' { Test-PreviewDetectsOldVersusNarrowedSelector }
    Invoke-Scenario 'preview refuses out-of-scope broad leftovers' { Test-PreviewRefusesOutOfScopeBroadLeftover }
    Invoke-Scenario 'preview refuses unknown/mismatched specs' { Test-PreviewRefusesUnknownSpec }
    Invoke-Scenario 'preview refuses a missing reviewed policy (zero omission)' { Test-PreviewRefusesMissingReviewedPolicy }
    Invoke-Scenario 'apply aborts on uid/resourceVersion conflict' { Test-ApplyAbortsOnConcurrentChange }
    Invoke-Scenario 'apply is idempotent for already-fixed policies' { Test-ApplyIsIdempotentForAlreadyFixedPolicies }
    Invoke-Scenario 'apply backs up only policies and patches only the selector' { Test-ApplyBacksUpOnlyPoliciesAndPatchesOnlyTheSelector }
} finally {
    Clear-MockEnvironment
    foreach ($root in $script:TempRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output ''
Write-Output ('repair-dependency-policy fixture tests: PASS=' + $script:PassCount + ' FAIL=' + $script:FailCount)
if ($script:FailCount -gt 0) { $exitCode = 1 } else { $exitCode = 0 }
exit $exitCode
