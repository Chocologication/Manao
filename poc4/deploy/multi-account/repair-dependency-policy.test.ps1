#Requires -Version 5.1
<#
.SYNOPSIS
  Fixture tests for repair-dependency-policy.ps1. No cluster connection.

.DESCRIPTION
  Every kubectl invocation made by the migration script is served by a generated
  mock-kubectl.cmd that reads JSON fixtures and records its calls. The tests cover:
  read-only preview with no cluster writes and no filesystem writes (no TEMP usage),
  legacy-vs-narrowed selector detection, fail-closed out-of-scope proof cases,
  case-sensitive identity/spec validation, strict reviewed-list input validation,
  refusal on out-of-scope/unknown/missing policies, uid and resourceVersion conflict
  aborts (including stop-after-first-failure), read-back failure negatives, unified
  apply-failure reporting when a patch payload cannot be written, idempotent
  already-fixed policies, exact JSON Patch preconditions and policy-only backups.

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
    if ([string]$Expected -cne [string]$Actual) {
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
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in @($Object.Keys)) {
            if ([string]::Equals([string]$key, $Name, [System.StringComparison]::Ordinal)) { return $Object[$key] }
        }
        return $null
    }
    foreach ($property in @($Object.PSObject.Properties)) {
        if ([string]::Equals($property.Name, $Name, [System.StringComparison]::Ordinal)) { return $property.Value }
    }
    return $null
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

function ConvertTo-CapturedResult {
    param($ExitCode, $Raw)
    $stdoutBuilder = New-Object System.Text.StringBuilder
    $stderrBuilder = New-Object System.Text.StringBuilder
    foreach ($item in @($Raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            [void]$stderrBuilder.AppendLine([string]$item)
        } else {
            [void]$stdoutBuilder.AppendLine([string]$item)
        }
    }
    return [pscustomobject]@{
        ExitCode = $ExitCode
        StdOut   = $stdoutBuilder.ToString()
        StdErr   = $stderrBuilder.ToString()
    }
}

function Invoke-ChildPowerShell {
    param([string[]]$Arguments)
    $hostExecutable = Get-PowerShellHost
    $previousErrorActionPreference = $ErrorActionPreference
    $raw = @()
    try {
        $ErrorActionPreference = 'Continue'
        $raw = & $hostExecutable @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return (ConvertTo-CapturedResult -ExitCode $exitCode -Raw $raw)
}

function Invoke-WrapperPowerShell {
    param([string]$WrapperPath)
    $previousErrorActionPreference = $ErrorActionPreference
    $raw = @()
    try {
        $ErrorActionPreference = 'Continue'
        $raw = & $WrapperPath 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return (ConvertTo-CapturedResult -ExitCode $exitCode -Raw $raw)
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

function Write-FixtureJson {
    param([string]$Path, $Value)
    $text = $null
    if ($Value -is [array]) {
        # Serialize each element separately: Windows PowerShell 5.1 unwraps a
        # single-element top-level array passed to ConvertTo-Json -InputObject.
        $elements = @()
        foreach ($element in $Value) {
            $elements += (ConvertTo-Json -InputObject $element -Depth 30 -Compress)
        }
        $text = '[' + ($elements -join ',') + ']'
    } else {
        $text = ConvertTo-Json -InputObject $Value -Depth 30
    }
    Write-Utf8NoBom -Path $Path -Text $text
}

function New-Policy {
    param(
        [string]$ProjectId,
        [bool]$Narrowed = $false,
        [string]$Uid = '',
        [string]$ResourceVersion = '',
        [string]$Name = '',
        [scriptblock]$MutateSpec = $null,
        [scriptblock]$MutateMetadata = $null
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
    $labels = [ordered]@{
        'app.kubernetes.io/managed-by' = $script:ManagedBy
        'manao.poc4/project-id'        = $ProjectId
        'stage6-test'                  = 'true'
        'manao.poc4/component'         = 'dependencies'
    }
    $metadata = [ordered]@{
        name            = $Name
        namespace       = $script:TestNamespace
        uid             = $Uid
        resourceVersion = $ResourceVersion
        labels          = $labels
    }
    if ($null -ne $MutateMetadata) {
        & $MutateMetadata $metadata
    }
    return [ordered]@{
        apiVersion = 'networking.k8s.io/v1'
        kind       = 'NetworkPolicy'
        metadata   = $metadata
        spec       = $spec
    }
}

function New-AuxiliaryPolicy {
    param(
        [string]$Name,
        $PodSelector,
        $Ingress = $null,
        [string[]]$PolicyTypes = @('Ingress'),
        [string]$ManagedBy = ''
    )
    if ([string]::IsNullOrEmpty($ManagedBy)) { $ManagedBy = $script:ManagedBy }
    $spec = [ordered]@{
        podSelector = $PodSelector
        policyTypes = @($PolicyTypes)
    }
    if ($null -ne $Ingress) { $spec['ingress'] = @($Ingress) }
    return [ordered]@{
        apiVersion = 'networking.k8s.io/v1'
        kind       = 'NetworkPolicy'
        metadata   = [ordered]@{
            name            = $Name
            namespace       = $script:TestNamespace
            uid             = ('uid-' + $Name)
            resourceVersion = '7'
            labels          = [ordered]@{ 'app.kubernetes.io/managed-by' = $ManagedBy }
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
    # The unary comma keeps the reviewed list a JSON array even with one project.
    return ,@($Projects)
}

# ---------------------------------------------------------------------------
# Mock kubectl: a batch shim reading JSON fixtures and appending every call to a log.
# It never touches a cluster. Environment variables select the fixtures and simulate
# uid/resourceVersion conflicts or read-back GET failures.
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
echo %ARGS% | findstr /C:" --patch " >nul
if not errorlevel 1 goto mock_inline_patch
set "TARGET="
set "PATCHFILE="
set "PREV="
for %%A in (%*) do call :trackpatch "%%A"
if "%TARGET%"=="" goto mock_patch_payload_missing
if "%PATCHFILE%"=="" goto mock_patch_payload_missing
if not exist "%PATCHFILE%" goto mock_patch_payload_missing
for %%A in ("%PATCHFILE%") do if %%~zA==0 goto mock_patch_payload_missing
if not "%MOCK_PATCH_CAPTURE_DIR%"=="" copy /Y "%PATCHFILE%" "%MOCK_PATCH_CAPTURE_DIR%\%TARGET%.json" >nul
if /I "%MOCK_PATCH_CONFLICT%"=="uid" goto mock_conflict_uid
if /I "%MOCK_PATCH_CONFLICT%"=="resourceVersion" goto mock_conflict_rv
if not "%MOCK_PATCHED_DIR%"=="" if exist "%MOCK_PATCHED_DIR%\%TARGET%.json" copy /Y "%MOCK_PATCHED_DIR%\%TARGET%.json" "%MOCK_STATE_DIR%\%TARGET%.json" >nul
echo networkpolicy.networking.k8s.io/%TARGET% patched
exit /b 0

:mock_inline_patch
echo Error from server: inline --patch arguments are not allowed; a --patch-file payload is required 1>&2
exit /b 1

:mock_patch_payload_missing
echo Error from server: the --patch-file payload is missing or empty 1>&2
exit /b 1

:mock_conflict_uid
echo Error from server (Conflict): test operation failed: /metadata/uid does not match 1>&2
exit /b 1

:mock_conflict_rv
echo Error from server (Conflict): test operation failed: /metadata/resourceVersion does not match 1>&2
exit /b 1

:mock_list
type "%MOCK_POLICY_LIST_FILE%"
exit /b 0

:mock_get
shift
shift
shift
shift
set "TARGET=%~3"
if "%MOCK_GET_EXIT%"=="" goto mock_get_ok
if "%MOCK_GET_EXIT%"=="0" goto mock_get_ok
goto mock_get_missing

:mock_get_ok
if not exist "%MOCK_STATE_DIR%\%TARGET%.json" goto mock_get_missing
type "%MOCK_STATE_DIR%\%TARGET%.json"
exit /b 0

:mock_get_missing
echo Error from server (NotFound): networkpolicies.networking.k8s.io "%TARGET%" not found 1>&2
exit /b 1

:mock_unexpected
echo mock kubectl: unexpected invocation: %ARGS% 1>&2
exit /b 99

:trackpatch
if /I "%PREV%"=="networkpolicy" set "TARGET=%~1"
if /I "%PREV%"=="--patch-file" set "PATCHFILE=%~1"
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
    $patchedDirectory = Join-Path $root 'patched'
    $captureDirectory = Join-Path $root 'capture'
    New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $patchedDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $captureDirectory | Out-Null
    $mockPath = New-MockKubectl -Directory $root
    $scenario = [pscustomobject]@{
        Root         = $root
        StateDir     = $stateDirectory
        PatchedDir   = $patchedDirectory
        CaptureDir   = $captureDirectory
        OutputDir    = (Join-Path $root 'output')
        MockPath     = $mockPath
        CallLog      = (Join-Path $root 'kubectl-calls.log')
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
    $env:MOCK_PATCHED_DIR = $scenario.PatchedDir
    $env:MOCK_PATCH_CAPTURE_DIR = $scenario.CaptureDir
    $env:MOCK_PATCH_CONFLICT = ''
    $env:MOCK_GET_EXIT = '0'
    return $scenario
}

function Clear-MockEnvironment {
    foreach ($name in @(
        'MANAO_REPAIR_KUBECTL', 'MOCK_KUBECTL_LOG', 'MOCK_CONTEXTS_FILE',
        'MOCK_POLICY_LIST_FILE', 'MOCK_STATE_DIR', 'MOCK_PATCHED_DIR',
        'MOCK_PATCH_CAPTURE_DIR', 'MOCK_PATCH_CONFLICT', 'MOCK_GET_EXIT'
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

function Invoke-RepairScriptWithCustomTemp {
    param($Scenario, [string]$TempPath, [switch]$Apply)
    $hostExecutable = Get-PowerShellHost
    $applyArgument = ''
    if ($Apply) { $applyArgument = ' -Apply' }
    $commandLine = '"' + $hostExecutable + '" -NoProfile -File "' + $script:RepairScript + '"' +
        ' -Context "' + $script:TestContext + '"' +
        ' -Namespace "' + $script:TestNamespace + '"' +
        ' -ProjectsFile "' + $Scenario.ProjectsFile + '"' +
        ' -OutputDirectory "' + $Scenario.OutputDir + '"' + $applyArgument
    $lines = @(
        '@echo off',
        'setlocal EnableExtensions',
        ('set "TEMP=' + $TempPath + '"'),
        ('set "TMP=' + $TempPath + '"'),
        $commandLine,
        'exit /b %ERRORLEVEL%'
    )
    $wrapperPath = Join-Path $Scenario.Root 'run-with-custom-temp.cmd'
    Write-Utf8NoBom -Path $wrapperPath -Text (($lines -join $script:NewLine) + $script:NewLine)
    return Invoke-WrapperPowerShell -WrapperPath $wrapperPath
}

function Get-MockCalls {
    param($Scenario)
    if (-not (Test-Path -LiteralPath $Scenario.CallLog)) { return @() }
    return @([System.IO.File]::ReadAllLines($Scenario.CallLog) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Assert-NoClusterWrites {
    param($Scenario)
    foreach ($call in @(Get-MockCalls -Scenario $Scenario)) {
        if ($call -cmatch '(^| )(patch|create|delete|replace|apply|edit)( |$)') {
            throw "unexpected mutating kubectl call: $call"
        }
    }
}

function Assert-ExplicitContextAndNamespace {
    param($Scenario)
    foreach ($call in @(Get-MockCalls -Scenario $Scenario)) {
        if ($call -cnotmatch '--context') { throw "kubectl call lacks explicit --context: $call" }
        if ($call -cnotmatch '--namespace') { throw "kubectl call lacks explicit --namespace: $call" }
        if ($call -cmatch '(^| )(-A|--all-namespaces)( |$)') { throw "kubectl call uses all namespaces: $call" }
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
        if ($call -cmatch 'secret') { throw "script must never read Secrets: $call" }
    }
}

function Get-PatchCalls {
    param($Scenario)
    return @(Get-MockCalls -Scenario $Scenario | Where-Object { $_ -cmatch ' patch ' })
}

function Get-SinglePolicyReads {
    param($Scenario)
    return @(Get-MockCalls -Scenario $Scenario | Where-Object { $_ -cmatch ' get networkpolicy ' })
}

function Get-PatchFilePaths {
    param($Scenario)
    $paths = @()
    foreach ($call in @(Get-PatchCalls -Scenario $Scenario)) {
        $match = [regex]::Match($call, '--patch-file (?<path>.+)$')
        if (-not $match.Success) { continue }
        $paths += $match.Groups['path'].Value.Trim('"')
    }
    return $paths
}

function Get-PatchPayloads {
    param($Scenario)
    $payloads = @()
    if (-not (Test-Path -LiteralPath $Scenario.CaptureDir)) { return @() }
    foreach ($file in @(Get-ChildItem -LiteralPath $Scenario.CaptureDir -File -Filter '*.json')) {
        $raw = [System.IO.File]::ReadAllText($file.FullName)
        $parsedOperations = $raw | ConvertFrom-Json
        $payloads += [pscustomobject]@{
            PolicyName = $file.BaseName
            Operations = @($parsedOperations)
            Raw        = $raw
        }
    }
    return $payloads
}

function Get-ApplyReport {
    param($Scenario)
    $reportPath = Join-Path $Scenario.OutputDir 'apply-report.json'
    Assert-True (Test-Path -LiteralPath $reportPath) 'apply report is written'
    return ([System.IO.File]::ReadAllText($reportPath) | ConvertFrom-Json)
}

function Get-ReportItem {
    param($Report, [string]$PolicyName)
    foreach ($item in @($Report.results)) {
        if ([string]$item.policyName -ceq $PolicyName) { return $item }
    }
    throw "apply report is missing policy '$PolicyName'"
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
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $scenario.OutputDir 'patch'))) 'preview must not create the patch payload directory'
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $scenario.CaptureDir -File).Count 'preview must not produce patch payload files'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'preview must not patch'
    Assert-NoClusterWrites -Scenario $scenario
    Assert-ExplicitContextAndNamespace -Scenario $scenario
    Assert-NoSecretAccess -Scenario $scenario
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

function Test-OutOfScopeFailClosedReproductions {
    $scenario = New-Scenario
    $blockedManagedBy = New-AuxiliaryPolicy -Name 'allow-managed-by-deps' -PodSelector @{ matchLabels = @{ 'app.kubernetes.io/managed-by' = $script:ManagedBy } } -Ingress @(@{ from = @() })
    $blockedNotIn = New-AuxiliaryPolicy -Name 'allow-component-notin-workspace' -PodSelector @{ matchExpressions = @(@{ key = $script:ComponentLabel; operator = 'NotIn'; values = @('workspace') }) } -Ingress @(@{ from = @() })
    $blockedUnknownLabel = New-AuxiliaryPolicy -Name 'allow-unknown-label' -PodSelector @{ matchLabels = @{ 'example.com/team' = 'blue' } } -Ingress @(@{ from = @() })
    $safeWeb = New-AuxiliaryPolicy -Name 'safe-component-web' -PodSelector @{ matchLabels = @{ $script:ComponentLabel = 'web' } } -Ingress @(@{ from = @() })
    $safeNotInBoth = New-AuxiliaryPolicy -Name 'safe-component-notin-both' -PodSelector @{ matchExpressions = @(@{ key = $script:ComponentLabel; operator = 'NotIn'; values = @('mysql', 'redis') }) } -Ingress @(@{ from = @() })
    $safeManagedByOther = New-AuxiliaryPolicy -Name 'safe-managed-by-other' -PodSelector @{ matchLabels = @{ 'app.kubernetes.io/managed-by' = 'someone-else' } } -Ingress @(@{ from = @() })
    $safeNoIngress = New-AuxiliaryPolicy -Name 'safe-deny-only' -PodSelector @{}
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Narrowed $true),
        $blockedManagedBy,
        $blockedNotIn,
        $blockedUnknownLabel,
        $safeWeb,
        $safeNotInBoth,
        $safeManagedByOther,
        $safeNoIngress
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 2 $result.ExitCode 'fail-closed out-of-scope refusal exit code'
    Assert-Contains $result.StdOut 'RESULT=REFUSED' 'unprovable selectors must refuse completion'
    Assert-Contains $result.StdOut '[OUT_OF_SCOPE] policy=allow-managed-by-deps' 'managed-by-ours selector can match dependency pods'
    Assert-Contains $result.StdOut '[OUT_OF_SCOPE] policy=allow-component-notin-workspace' 'component NotIn [workspace] can match dependency pods'
    Assert-Contains $result.StdOut '[OUT_OF_SCOPE] policy=allow-unknown-label' 'unknown label selector cannot prove exclusion'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-component-web' 'component=web provably excludes dependency pods'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-component-notin-both' 'component NotIn [mysql,redis] provably excludes dependency pods'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-managed-by-other' 'managed-by of another manager excludes dependency pods'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-deny-only' 'a policy without ingress rules cannot allow ingress'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'refusal must not patch anything'
    Assert-NoClusterWrites -Scenario $scenario
}

function Test-OutOfScopeSafeSelectorsAreIgnored {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Narrowed $true),
        (New-AuxiliaryPolicy -Name 'safe-component-web' -PodSelector @{ matchLabels = @{ $script:ComponentLabel = 'web' } } -Ingress @(@{ from = @() })),
        (New-AuxiliaryPolicy -Name 'safe-component-notin-both' -PodSelector @{ matchExpressions = @(@{ key = $script:ComponentLabel; operator = 'NotIn'; values = @('mysql', 'redis') }) } -Ingress @(@{ from = @() })),
        (New-AuxiliaryPolicy -Name 'safe-managed-by-other' -PodSelector @{ matchLabels = @{ 'app.kubernetes.io/managed-by' = 'someone-else' } } -Ingress @(@{ from = @() })),
        (New-AuxiliaryPolicy -Name 'safe-deny-only' -PodSelector @{})
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $result = Invoke-RepairScript -Scenario $scenario
    Assert-Equal 0 $result.ExitCode 'provably unrelated policies must not block completion'
    Assert-Contains $result.StdOut 'RESULT=ALREADY_SCOPED count=0' 'reviewed policy is already scoped'
    Assert-NotContains $result.StdOut 'RESULT=REFUSED' 'provably unrelated policies must not refuse'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-component-web' 'web-only selector is ignored'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-component-notin-both' 'NotIn [mysql,redis] selector is ignored'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-managed-by-other' 'other-manager selector is ignored'
    Assert-Contains $result.StdOut '[IGNORED] policy=safe-deny-only' 'no-ingress policy is ignored'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'nothing is patched'
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

function Test-ReviewedProjectsFileStrictness {
    $scenario = New-Scenario
    $cases = @(
        @{ Name = 'top-level object'; Json = '{"ownerId":"owner-1","projectId":"p1"}'; Expected = 'top-level JSON array' },
        @{ Name = 'numeric projectId'; Json = '[{"ownerId":"owner-1","projectId":123}]'; Expected = 'projectId must be a JSON string' },
        @{ Name = 'uppercase projectId'; Json = '[{"ownerId":"owner-1","projectId":"P1"}]'; Expected = 'safe lowercase DNS label' },
        @{ Name = 'trailing hyphen projectId'; Json = '[{"ownerId":"owner-1","projectId":"p1-"}]'; Expected = 'safe lowercase DNS label' },
        @{ Name = 'null entry'; Json = '[null]'; Expected = 'null entry' },
        @{ Name = 'numeric ownerId'; Json = '[{"ownerId":7,"projectId":"p1"}]'; Expected = 'ownerId must be a JSON string' },
        @{ Name = 'duplicate projectId'; Json = '[{"ownerId":"owner-1","projectId":"p1"},{"ownerId":"owner-2","projectId":"p1"}]'; Expected = 'duplicate projectId' }
    )
    foreach ($case in $cases) {
        Write-Utf8NoBom -Path $scenario.ProjectsFile -Text $case.Json
        $result = Invoke-RepairScript -Scenario $scenario
        Assert-Equal 1 $result.ExitCode ('invalid ProjectsFile must exit 1: ' + $case.Name)
        Assert-Contains $result.StdErr $case.Expected ('invalid ProjectsFile must be rejected: ' + $case.Name)
        Assert-Equal 0 @(Get-MockCalls -Scenario $scenario).Count ('validation must fail before kubectl: ' + $case.Name)
    }
}

function Test-CaseSensitiveIdentityAndSpec {
    # (A) The ingress source project label is P1 but the reviewed project is p1: the
    # spec is unknown and must never be migrated with the wrong selector.
    $scenarioA = New-Scenario
    $policyA = New-Policy -ProjectId 'p1' -MutateSpec {
        param($spec)
        $spec.ingress[0].from[0].podSelector.matchLabels = @{ 'manao.poc4/project-id' = 'P1' }
    }
    Write-FixtureJson -Path $scenarioA.PoliciesFile -Value (New-PolicyList -Policies @($policyA))
    Write-FixtureJson -Path $scenarioA.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $resultA = Invoke-RepairScript -Scenario $scenarioA
    Assert-Equal 2 $resultA.ExitCode 'wrong-case ingress project label must refuse'
    Assert-Contains $resultA.StdOut '[UNKNOWN_SPEC] ownerId=owner-1 projectId=p1 policy=manao-dep-netpol-p1' 'wrong-case ingress label is not the reviewed legacy spec'
    Assert-NotContains $resultA.StdOut '[NEEDS_MIGRATION]' 'wrong-case spec must never be migrated'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenarioA).Count 'wrong-case spec must never be patched'

    # (B) Uppercase managed-by label value is an identity mismatch, not a legacy policy.
    $scenarioB = New-Scenario
    $policyB = New-Policy -ProjectId 'p1' -MutateMetadata {
        param($metadata)
        $metadata.labels['app.kubernetes.io/managed-by'] = 'MANAO-POC4-BACKEND'
    }
    Write-FixtureJson -Path $scenarioB.PoliciesFile -Value (New-PolicyList -Policies @($policyB))
    Write-FixtureJson -Path $scenarioB.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $resultB = Invoke-RepairScript -Scenario $scenarioB
    Assert-Equal 2 $resultB.ExitCode 'uppercase managed-by must refuse'
    Assert-Contains $resultB.StdOut '[IDENTITY_MISMATCH] ownerId=owner-1 projectId=p1 policy=manao-dep-netpol-p1' 'uppercase managed-by is an identity mismatch'
    Assert-NotContains $resultB.StdOut '[NEEDS_MIGRATION]' 'uppercase identity must not be migrated'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenarioB).Count 'uppercase identity must not be patched'

    # (C) Uppercase project label value in metadata is also an identity mismatch.
    $scenarioC = New-Scenario
    $policyC = New-Policy -ProjectId 'p1' -MutateMetadata {
        param($metadata)
        $metadata.labels['manao.poc4/project-id'] = 'P1'
    }
    Write-FixtureJson -Path $scenarioC.PoliciesFile -Value (New-PolicyList -Policies @($policyC))
    Write-FixtureJson -Path $scenarioC.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $resultC = Invoke-RepairScript -Scenario $scenarioC
    Assert-Equal 2 $resultC.ExitCode 'uppercase project label must refuse'
    Assert-Contains $resultC.StdOut '[IDENTITY_MISMATCH] ownerId=owner-1 projectId=p1 policy=manao-dep-netpol-p1' 'uppercase project label is an identity mismatch'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenarioC).Count 'uppercase project label must not be patched'
}

function Test-PreviewPerformsNoFilesystemWrites {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))

    # (A) TEMP/TMP point at an existing FILE: a preview that uses temp-file APIs fails
    # here, while a preview with no filesystem writes succeeds.
    $tempBlocker = Join-Path $scenario.Root 'temp-blocker'
    Write-Utf8NoBom -Path $tempBlocker -Text 'not-a-directory'
    $resultA = Invoke-RepairScriptWithCustomTemp -Scenario $scenario -TempPath $tempBlocker
    Assert-Equal 0 $resultA.ExitCode 'preview must not require a writable TEMP directory'
    Assert-Contains $resultA.StdOut 'PREVIEW_RESULT=WOULD_PATCH count=1' 'preview still classifies policies without TEMP'
    Assert-True (Test-Path -LiteralPath $tempBlocker -PathType Leaf) 'the TEMP path must not be replaced or modified'
    Assert-Equal 'not-a-directory' ([System.IO.File]::ReadAllText($tempBlocker)) 'the TEMP blocker file must be unchanged'
    Assert-True (-not (Test-Path -LiteralPath $scenario.OutputDir)) 'preview must not create the output directory'

    # (B) With an existing empty TEMP, the preview must leave no residual files
    # (the PowerShell host itself may touch TEMP, but the script must not leave artifacts)
    # and must not create the output directory.
    $tempDirectory = Join-Path $scenario.Root 'fresh-temp'
    New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
    $resultB = Invoke-RepairScriptWithCustomTemp -Scenario $scenario -TempPath $tempDirectory
    Assert-Equal 0 $resultB.ExitCode 'preview exit code with a fresh TEMP'
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $tempDirectory -Force).Count 'preview must leave the TEMP directory empty'
    Assert-True (-not (Test-Path -LiteralPath $scenario.OutputDir)) 'preview must not create the output directory'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $scenario.OutputDir 'patch'))) 'preview must not create the patch payload directory'
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $scenario.CaptureDir -File).Count 'preview must not produce patch payload files'
    Assert-Equal 0 @(Get-PatchCalls -Scenario $scenario).Count 'preview must not patch'
    Assert-NoClusterWrites -Scenario $scenario
}

function Test-ApplyAbortsOnUidConflictAndStops {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100'),
        (New-Policy -ProjectId 'p2' -Uid 'uid-p2' -ResourceVersion '200')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-1'; projectId = 'p2' }
    ))
    $env:MOCK_PATCH_CONFLICT = 'uid'
    $result = Invoke-RepairScript -Scenario $scenario -Apply
    Assert-Equal 3 $result.ExitCode 'uid conflict abort exit code'
    Assert-Contains $result.StdOut '[FAILED] policy=manao-dep-netpol-p1 status=CONFLICT' 'uid conflict must be reported'
    Assert-Contains $result.StdOut 'metadata/uid' 'uid conflict message is preserved'
    Assert-Contains $result.StdOut 'RESULT=APPLY_FAILED' 'apply must not claim success'
    Assert-NotContains $result.StdOut 'RESULT=APPLIED' 'apply must not claim success'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenario).Count 'the run must stop after the first rejected patch'
    Assert-Equal 0 @(Get-SinglePolicyReads -Scenario $scenario).Count 'no read-back after a rejected patch'
    foreach ($call in @(Get-MockCalls -Scenario $scenario)) {
        Assert-NotContains $call 'manao-dep-netpol-p2' 'the second candidate must not be touched after the first failure'
    }
    $backupDirectory = Join-Path $scenario.OutputDir 'backup'
    $backupFiles = @(Get-ChildItem -LiteralPath $backupDirectory -File -Filter '*.json' -ErrorAction SilentlyContinue)
    Assert-Equal 1 $backupFiles.Count 'only the first candidate is backed up before its patch attempt'
    Assert-True (Test-Path -LiteralPath (Join-Path $backupDirectory 'manao-dep-netpol-p1.json')) 'p1 backup exists'
    $report = Get-ApplyReport -Scenario $scenario
    Assert-Equal 'FAILED' $report.status 'failed apply report status'
    Assert-Equal 0 $report.appliedCount 'no policy was applied'
    Assert-Equal 'FAILED' (Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p1').status 'p1 is reported failed'
    Assert-Equal 'NOT_ATTEMPTED' (Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p2').status 'p2 is reported not attempted'
    Assert-ExplicitContextAndNamespace -Scenario $scenario
    Assert-NoSecretAccess -Scenario $scenario
}

function Test-ApplyAbortsOnResourceVersionConflict {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    $env:MOCK_PATCH_CONFLICT = 'resourceVersion'
    $result = Invoke-RepairScript -Scenario $scenario -Apply
    Assert-Equal 3 $result.ExitCode 'resourceVersion conflict abort exit code'
    Assert-Contains $result.StdOut '[FAILED] policy=manao-dep-netpol-p1 status=CONFLICT' 'resourceVersion conflict must be reported'
    Assert-Contains $result.StdOut 'metadata/resourceVersion' 'resourceVersion conflict message is preserved'
    Assert-Contains $result.StdOut 'RESULT=APPLY_FAILED' 'apply must not claim success'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenario).Count 'a rejected patch must not be retried'
    Assert-Equal 0 @(Get-SinglePolicyReads -Scenario $scenario).Count 'no read-back after a rejected patch'
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
        (New-Policy -ProjectId 'p2' -Uid 'uid-p2' -ResourceVersion '200'),
        (New-Policy -ProjectId 'p3' -Narrowed $true -Uid 'uid-p3' -ResourceVersion '300')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' },
        @{ ownerId = 'owner-2'; projectId = 'p2' },
        @{ ownerId = 'owner-3'; projectId = 'p3' }
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

    # The JSON Patch payload must travel as a --patch-file under OutputDirectory/patch (an
    # inline --patch argument is broken on Windows PowerShell 5.1 native argv quoting), must
    # pin the EXACT uid/resourceVersion values and replace ONLY the pod selector.
    $patchCalls = @(Get-PatchCalls -Scenario $scenario)
    foreach ($call in $patchCalls) {
        Assert-Contains $call '--patch-file' 'patch payload must be passed by file'
        Assert-NotContains $call ' --patch ' 'inline --patch argument must not be used (PS 5.1 strips JSON quotes)'
        Assert-NotContains $call '.tmp' 'patch must not reference a temporary file'
    }
    $patchFilePaths = @(Get-PatchFilePaths -Scenario $scenario)
    Assert-Equal 2 $patchFilePaths.Count 'one patch payload file per migrated policy'
    $patchDirectory = Join-Path $scenario.OutputDir 'patch'
    foreach ($patchFilePath in $patchFilePaths) {
        Assert-True ($patchFilePath.StartsWith($patchDirectory, [System.StringComparison]::Ordinal)) 'patch payload must live under OutputDirectory/patch'
        Assert-True (Test-Path -LiteralPath $patchFilePath -PathType Leaf) 'patch payload file must exist under OutputDirectory/patch'
        Assert-True ((Get-Item -LiteralPath $patchFilePath).Length -gt 0) 'patch payload file must not be empty'
    }
    $payloads = @(Get-PatchPayloads -Scenario $scenario)
    Assert-Equal 2 $payloads.Count 'the mock read one --patch-file payload per migrated policy'
    foreach ($payload in $payloads) {
        $auditPath = Join-Path $patchDirectory ($payload.PolicyName + '.json')
        Assert-True (Test-Path -LiteralPath $auditPath) 'patch payload is kept as audit evidence under OutputDirectory/patch'
        Assert-Equal ([System.IO.File]::ReadAllText($auditPath)) $payload.Raw 'the mock payload equals the audit payload file'
    }
    foreach ($payload in $payloads) {
        $expectedProjectId = 'p1'
        $expectedResourceVersion = '100'
        if ($payload.PolicyName -ceq 'manao-dep-netpol-p2') {
            $expectedProjectId = 'p2'
            $expectedResourceVersion = '200'
        }
        Assert-Equal ('manao-dep-netpol-' + $expectedProjectId) $payload.PolicyName 'patch payload belongs to the expected policy'
        $operations = @($payload.Operations)
        Assert-Equal 3 $operations.Count 'patch must contain only two tests plus one replace'
        Assert-Equal 'test' $operations[0].op 'first patch op pins the uid'
        Assert-Equal '/metadata/uid' $operations[0].path 'first patch op path'
        Assert-Equal ('uid-' + $expectedProjectId) $operations[0].value 'uid test value must be the exact reviewed uid'
        Assert-Equal 'test' $operations[1].op 'second patch op pins the resourceVersion'
        Assert-Equal '/metadata/resourceVersion' $operations[1].path 'second patch op path'
        Assert-Equal $expectedResourceVersion $operations[1].value 'resourceVersion test value must be the exact reviewed resourceVersion'
        Assert-Equal 'replace' $operations[2].op 'only the pod selector is replaced'
        Assert-Equal '/spec/podSelector' $operations[2].path 'only the pod selector is replaced'
        foreach ($operation in $operations) {
            Assert-True ($operation.path -cin @('/metadata/uid', '/metadata/resourceVersion', '/spec/podSelector')) ('unexpected patch path: ' + $operation.path)
        }
        Assert-NotContains $payload.Raw '/spec/ingress' 'patch must not touch ingress'
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
        $backupRaw = [System.IO.File]::ReadAllText($backupFile.FullName)
        $backup = $backupRaw | ConvertFrom-Json
        Assert-Equal 'NetworkPolicy' $backup.kind 'backup must contain only NetworkPolicies'
        Assert-Equal 'networking.k8s.io/v1' $backup.apiVersion 'backup bearer policy api version'
        $podSelector = Get-Prop $backup.spec 'podSelector'
        Assert-True ($null -eq (Get-Prop $podSelector 'matchLabels')) 'the backup holds the pre-patch (broad) selector'
        Assert-NotContains $backupRaw 'stringData' 'backup must not contain secret data'
        Assert-NotContains $backupRaw 'Secret' 'backup must not contain Secret objects'
    }
    Assert-Equal 2 @(Get-SinglePolicyReads -Scenario $scenario).Count 'every patch is read back and verified'

    # The apply report must record final per-item status and before/after uid/rv values.
    $report = Get-ApplyReport -Scenario $scenario
    Assert-Equal 'APPLIED' $report.status 'apply report status'
    Assert-Equal 2 $report.appliedCount 'apply report count'
    $p1Item = Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p1'
    Assert-Equal 'PATCHED' $p1Item.status 'p1 final report status'
    Assert-Equal 'uid-p1' $p1Item.beforeUid 'p1 before uid'
    Assert-Equal '100' $p1Item.beforeResourceVersion 'p1 before resourceVersion'
    Assert-Equal 'uid-p1' $p1Item.afterUid 'p1 after uid'
    Assert-Equal '101' $p1Item.afterResourceVersion 'p1 after resourceVersion'
    $p2Item = Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p2'
    Assert-Equal 'PATCHED' $p2Item.status 'p2 final report status'
    Assert-Equal 'uid-p2' $p2Item.beforeUid 'p2 before uid'
    Assert-Equal '200' $p2Item.beforeResourceVersion 'p2 before resourceVersion'
    Assert-Equal 'uid-p2' $p2Item.afterUid 'p2 after uid'
    Assert-Equal '201' $p2Item.afterResourceVersion 'p2 after resourceVersion'
    $p3Item = Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p3'
    Assert-Equal 'ALREADY_FIXED' $p3Item.status 'p3 final report status is already fixed'
    Assert-Equal 'uid-p3' $p3Item.beforeUid 'p3 before uid'
    Assert-Equal '300' $p3Item.beforeResourceVersion 'p3 before resourceVersion'
    Assert-Equal 'uid-p3' $p3Item.afterUid 'p3 after uid equals before uid'
    Assert-Equal '300' $p3Item.afterResourceVersion 'p3 after resourceVersion equals before value'
    foreach ($item in @($report.results)) {
        Assert-True ([string]$item.status -ceq 'PATCHED' -or [string]$item.status -ceq 'ALREADY_FIXED') ('unexpected final report status: ' + [string]$item.status)
    }
}

function Test-ApplyReadBackFailureNegatives {
    # (A) read-back uid mismatch
    $scenarioA = New-Scenario
    Write-FixtureJson -Path $scenarioA.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100')
    ))
    Write-FixtureJson -Path $scenarioA.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    Write-FixtureJson -Path (Join-Path $scenarioA.PatchedDir 'manao-dep-netpol-p1.json') -Value (New-Policy -ProjectId 'p1' -Narrowed $true -Uid 'uid-p1-other' -ResourceVersion '101')
    $resultA = Invoke-RepairScript -Scenario $scenarioA -Apply
    Assert-Equal 3 $resultA.ExitCode 'read-back uid mismatch exit code'
    Assert-Contains $resultA.StdOut '[FAILED] policy=manao-dep-netpol-p1 status=READBACK_MISMATCH' 'read-back uid mismatch must be reported'
    Assert-Contains $resultA.StdOut 'RESULT=APPLY_FAILED' 'read-back failure must not claim success'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenarioA).Count 'read-back failure must not retry the patch'
    $reportA = Get-ApplyReport -Scenario $scenarioA
    Assert-Equal 'FAILED' $reportA.status 'read-back uid mismatch report status'
    $itemA = Get-ReportItem -Report $reportA -PolicyName 'manao-dep-netpol-p1'
    Assert-Equal 'FAILED' $itemA.status 'read-back uid mismatch item status'
    Assert-Equal 'uid-p1-other' $itemA.afterUid 'read-back uid mismatch records the observed uid'

    # (B) read-back spec mismatch
    $scenarioB = New-Scenario
    Write-FixtureJson -Path $scenarioB.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100')
    ))
    Write-FixtureJson -Path $scenarioB.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    Write-FixtureJson -Path (Join-Path $scenarioB.PatchedDir 'manao-dep-netpol-p1.json') -Value (New-Policy -ProjectId 'p1' -Narrowed $false -Uid 'uid-p1' -ResourceVersion '101')
    $resultB = Invoke-RepairScript -Scenario $scenarioB -Apply
    Assert-Equal 3 $resultB.ExitCode 'read-back spec mismatch exit code'
    Assert-Contains $resultB.StdOut 'status=READBACK_MISMATCH' 'read-back spec mismatch must be reported'
    Assert-Contains $resultB.StdOut 'RESULT=APPLY_FAILED' 'read-back failure must not claim success'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenarioB).Count 'read-back failure must not retry the patch'

    # (C) read-back GET failure
    $scenarioC = New-Scenario
    Write-FixtureJson -Path $scenarioC.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1' -Uid 'uid-p1' -ResourceVersion '100')
    ))
    Write-FixtureJson -Path $scenarioC.ProjectsFile -Value (New-ProjectList -Projects @(
        @{ ownerId = 'owner-1'; projectId = 'p1' }
    ))
    Write-FixtureJson -Path (Join-Path $scenarioC.PatchedDir 'manao-dep-netpol-p1.json') -Value (New-Policy -ProjectId 'p1' -Narrowed $true -Uid 'uid-p1' -ResourceVersion '101')
    $env:MOCK_GET_EXIT = '1'
    $resultC = Invoke-RepairScript -Scenario $scenarioC -Apply
    Assert-Equal 3 $resultC.ExitCode 'read-back GET failure exit code'
    Assert-Contains $resultC.StdOut 'status=READBACK_MISMATCH' 'read-back GET failure must be reported'
    Assert-Contains $resultC.StdOut 'RESULT=APPLY_FAILED' 'read-back GET failure must not claim success'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenarioC).Count 'read-back GET failure must not retry the patch'
    $reportC = Get-ApplyReport -Scenario $scenarioC
    Assert-Equal 'FAILED' $reportC.status 'read-back GET failure report status'
}

function Test-ApplyFailsClosedOnPatchPayloadWriteFailure {
    $scenario = New-Scenario
    Write-FixtureJson -Path $scenario.PoliciesFile -Value (New-PolicyList -Policies @(
        (New-Policy -ProjectId 'p1'),
        (New-Policy -ProjectId 'p2')
    ))
    Write-FixtureJson -Path $scenario.ProjectsFile -Value (New-ProjectList -Projects @(
        [ordered]@{ ownerId = 'owner-1'; projectId = 'p1' },
        [ordered]@{ ownerId = 'owner-1'; projectId = 'p2' }
    ))
    Write-FixtureJson -Path (Join-Path $scenario.PatchedDir 'manao-dep-netpol-p1.json') -Value (New-Policy -ProjectId 'p1' -Narrowed $true -Uid 'uid-p1' -ResourceVersion '101')
    # p1 is patched first; for p2 the payload file path is occupied by a directory, so the
    # patch-payload write fails after the backup. This must follow the unified apply-failure
    # path (FAILED report, keep p1, exit 3, no retry) instead of escaping to the generic
    # exit-1 handler.
    $patchDirectory = Join-Path $scenario.OutputDir 'patch'
    New-Item -ItemType Directory -Force -Path (Join-Path $patchDirectory 'manao-dep-netpol-p2.json') | Out-Null
    $result = Invoke-RepairScript -Scenario $scenario -Apply
    Assert-Equal 3 $result.ExitCode 'patch payload write failure must exit 3 (apply failure)'
    Assert-Contains $result.StdOut '[FAILED] policy=manao-dep-netpol-p2 status=PATCH_PAYLOAD_FAILED' 'payload write failure is reported per policy'
    Assert-Contains $result.StdOut 'RESULT=APPLY_FAILED' 'payload write failure must not claim success'
    Assert-NotContains $result.StdOut 'RESULT=APPLIED' 'payload write failure must not claim success'
    Assert-NotContains $result.StdErr 'repair-dependency-policy:' 'payload write failure must not escape to the generic exit-1 path'
    Assert-Equal 1 @(Get-PatchCalls -Scenario $scenario).Count 'the run must stop after the payload write failure without retrying or touching p2'
    Assert-Equal 1 @(Get-SinglePolicyReads -Scenario $scenario).Count 'only the already-patched policy is read back'
    Assert-Equal 2 @(Get-ChildItem -LiteralPath (Join-Path $scenario.OutputDir 'backup') -File).Count 'both candidates keep their pre-patch backup'
    $report = Get-ApplyReport -Scenario $scenario
    Assert-Equal 'FAILED' $report.status 'payload write failure writes a FAILED apply report'
    Assert-Equal 1 $report.appliedCount 'the already-applied item is kept in the report count'
    $patchedItem = Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p1'
    Assert-Equal 'PATCHED' $patchedItem.status 'the first patched item stays PATCHED'
    Assert-Equal 'uid-p1' $patchedItem.afterUid 'the first patched item keeps its read-back uid'
    Assert-Equal '101' $patchedItem.afterResourceVersion 'the first patched item keeps its read-back resourceVersion'
    $failedItem = Get-ReportItem -Report $report -PolicyName 'manao-dep-netpol-p2'
    Assert-Equal 'FAILED' $failedItem.status 'the payload-write-failure item is FAILED'
    Assert-Contains (@($failedItem.reasons) -join ' ') 'patch payload write failed' 'the failure reason names the payload write failure'
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

$exitCode = 0
try {
    Invoke-Scenario 'default preview is read-only and writes nothing' { Test-PreviewIsReadOnly }
    Invoke-Scenario 'preview distinguishes legacy and narrowed selectors' { Test-PreviewDetectsOldVersusNarrowedSelector }
    Invoke-Scenario 'preview refuses out-of-scope broad leftovers' { Test-PreviewRefusesOutOfScopeBroadLeftover }
    Invoke-Scenario 'out-of-scope detection is fail-closed for unprovable selectors' { Test-OutOfScopeFailClosedReproductions }
    Invoke-Scenario 'out-of-scope policies are ignored only when provably unrelated' { Test-OutOfScopeSafeSelectorsAreIgnored }
    Invoke-Scenario 'preview refuses unknown/mismatched specs' { Test-PreviewRefusesUnknownSpec }
    Invoke-Scenario 'preview refuses a missing reviewed policy (zero omission)' { Test-PreviewRefusesMissingReviewedPolicy }
    Invoke-Scenario 'reviewed ProjectsFile input is strict (array, strings, DNS label)' { Test-ReviewedProjectsFileStrictness }
    Invoke-Scenario 'identity and spec validation is case-sensitive' { Test-CaseSensitiveIdentityAndSpec }
    Invoke-Scenario 'preview performs no filesystem writes (no TEMP usage)' { Test-PreviewPerformsNoFilesystemWrites }
    Invoke-Scenario 'apply aborts on uid conflict and stops after the first failure' { Test-ApplyAbortsOnUidConflictAndStops }
    Invoke-Scenario 'apply aborts on resourceVersion conflict' { Test-ApplyAbortsOnResourceVersionConflict }
    Invoke-Scenario 'apply is idempotent for already-fixed policies' { Test-ApplyIsIdempotentForAlreadyFixedPolicies }
    Invoke-Scenario 'apply backs up only policies and patches only the selector' { Test-ApplyBacksUpOnlyPoliciesAndPatchesOnlyTheSelector }
    Invoke-Scenario 'apply fails closed on read-back uid/spec/GET failures' { Test-ApplyReadBackFailureNegatives }
    Invoke-Scenario 'apply fails closed when the patch payload cannot be written' { Test-ApplyFailsClosedOnPatchPayloadWriteFailure }
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
