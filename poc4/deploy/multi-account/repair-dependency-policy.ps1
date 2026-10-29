#Requires -Version 5.1
<#
.SYNOPSIS
  Repair the legacy broad dependency NetworkPolicies so each one targets only its own
  project's MySQL/Redis pods.

.DESCRIPTION
  Design 4.1 / multi-account plan Task 1. A legacy dependency policy has a target
  podSelector of "component In (mysql,redis)" with no project label, so it governs the
  dependency pods of every project in the shared namespace. A newly narrowed policy does
  not cancel that old broad policy: NetworkPolicy ingress is additive, so the old broad
  selector keeps admitting traffic until every legacy policy is narrowed. This script
  verifies the namespace against an explicitly reviewed owner/project list, classifies
  every policy as ALREADY_FIXED / NEEDS_MIGRATION / MISSING / UNKNOWN, and (only with
  -Apply) patches only spec.podSelector with a JSON Patch whose test operations pin
  /metadata/uid and /metadata/resourceVersion.

  The default mode is a read-only preview: it prints the classification and writes
  nothing to the cluster and nothing to disk. Completion is refused (exit code 2) when a
  reviewed project's policy is missing, when any policy cannot be proven to match the
  reviewed legacy contract, or when the namespace still contains a broad policy outside
  the reviewed project list. The script never creates missing policies, never widens the
  reviewed list, never retries a rejected patch and never rolls anything back.

.PARAMETER Context
  Explicit kubectl context. Required; every cluster call passes it as --context.

.PARAMETER Namespace
  Explicit namespace. Required; every cluster call passes it as --namespace. The script
  never uses -A / --all-namespaces.

.PARAMETER ProjectsFile
  Path to a reviewed JSON array of {ownerId, projectId} entries. Every entry is verified:
  the dependency policy must exist, carry the platform managed-by/project/component
  labels, carry a UID, and match the expected legacy spec exactly.

.PARAMETER OutputDirectory
  Directory for apply artifacts. Only used with -Apply: <dir>/backup/<policy>.json holds
  one NetworkPolicy per patched policy (never Secrets) and <dir>/apply-report.json holds
  the summary. A preview does not create this directory.

.PARAMETER Apply
  Apply the migration. Without it the script is a read-only preview that performs no
  cluster writes and no filesystem writes.

.EXITCODE
  0 success or nothing to do; 2 scope/verification refused (no changes made);
  3 apply/read-back failure; 1 unexpected error.

.NOTES
  Tests only: MANAO_REPAIR_KUBECTL may name a kubectl executable substitute. It exists so
  repair-dependency-policy.test.ps1 can run without a cluster; never set it in production.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Context,
    [Parameter(Mandatory = $true)][string]$Namespace,
    [Parameter(Mandatory = $true)][string]$ProjectsFile,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ManagedByLabelValue = 'manao-poc4-backend'
$script:ProjectIdLabel = 'manao.poc4/project-id'
$script:ComponentLabel = 'manao.poc4/component'
$script:PolicyNamePrefix = 'manao-dep-netpol-'
$script:ExitScopeRefused = 2
$script:ExitApplyFailed = 3

# Native kubectl output is UTF-8; decode it as such instead of the Windows ANSI code page.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Best effort only: the script only compares ASCII identifiers.
}

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

function Write-Line {
    param([string]$Text = '')
    Write-Output $Text
}

function Assert-NonEmptyText {
    param([string]$Value, [string]$Name)
    if ($null -eq $Value -or $Value.Trim().Length -eq 0) {
        throw "$Name is required"
    }
    return $Value.Trim()
}

function Get-JsonProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-JsonString {
    param($Object, [string]$Name)
    $value = Get-JsonProperty $Object $Name
    if ($null -eq $value) { return $null }
    return [string]$value
}

function Get-JsonPropertyNames {
    param($Object)
    if ($null -eq $Object) { return @() }
    return @($Object.PSObject.Properties.Name)
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Read-JsonFile {
    param([string]$Path, [string]$Description)
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $raw = [System.IO.File]::ReadAllText($resolved.Path)
    if ($raw.Trim().Length -eq 0) {
        throw "$Description is empty: $Path"
    }
    try {
        return ($raw | ConvertFrom-Json)
    } catch {
        throw "$Description is not valid JSON ($Path): $($_.Exception.Message)"
    }
}

# Deterministic JSON used for strict structural comparison: object properties are sorted,
# array order is preserved and scalars keep their JSON type.
function ConvertTo-CanonicalJson {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return (ConvertTo-Json -InputObject $Value -Compress) }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        return (ConvertTo-Json -InputObject $Value -Compress)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $parts.Add(((ConvertTo-Json -InputObject ([string]$key) -Compress) + ':' + (ConvertTo-CanonicalJson -Value $Value[$key])))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($name in @($Value.PSObject.Properties.Name | Sort-Object)) {
            $parts.Add(((ConvertTo-Json -InputObject ([string]$name) -Compress) + ':' + (ConvertTo-CanonicalJson -Value $Value.PSObject.Properties[$name].Value)))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($item in $Value) { $parts.Add((ConvertTo-CanonicalJson -Value $item)) }
        return '[' + ($parts -join ',') + ']'
    }
    return (ConvertTo-Json -InputObject $Value -Compress -Depth 30)
}

# ---------------------------------------------------------------------------
# kubectl access (explicit context/namespace on every cluster call)
# ---------------------------------------------------------------------------

function Invoke-Kubectl {
    param(
        [Parameter(Mandatory = $true)][string[]]$KubectlArguments,
        [switch]$AllowFailure
    )
    $kubectl = 'kubectl'
    if (-not [string]::IsNullOrWhiteSpace($env:MANAO_REPAIR_KUBECTL)) {
        $kubectl = $env:MANAO_REPAIR_KUBECTL
    }
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 turns redirected native stderr into a terminating
        # NativeCommandError under ErrorActionPreference=Stop; capture the exit code and
        # stderr file explicitly instead.
        $ErrorActionPreference = 'Continue'
        $output = & $kubectl @KubectlArguments 2> $stderrFile
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        $outputText = ($output | Out-String)
        $stderrText = ''
        if (Test-Path -LiteralPath $stderrFile) {
            $stderrText = [System.IO.File]::ReadAllText($stderrFile)
        }
        if ($exitCode -ne 0 -and -not $AllowFailure) {
            $command = (@($KubectlArguments) -join ' ')
            throw "kubectl $command failed (exit $exitCode): $($stderrText.Trim())"
        }
        return [pscustomobject]@{
            ExitCode  = $exitCode
            Output    = $outputText
            ErrorText = $stderrText
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-ClusterKubectl {
    param(
        [Parameter(Mandatory = $true)][string[]]$KubectlArguments,
        [switch]$AllowFailure
    )
    $scoped = @('--context', $script:ContextName, '--namespace', $script:NamespaceName) + @($KubectlArguments)
    return Invoke-Kubectl -KubectlArguments $scoped -AllowFailure:$AllowFailure
}

function Assert-KubectlContextConfigured {
    # Local kubeconfig check (no cluster connection). It still carries the explicit
    # --context/--namespace pair so every kubectl invocation has an explicit scope.
    $result = Invoke-ClusterKubectl -KubectlArguments @('config', 'get-contexts', '-o', 'name')
    $contexts = @($result.Output -split "\r?\n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    if ($contexts -notcontains $script:ContextName) {
        throw "kubectl context '$($script:ContextName)' is not configured (available: $($contexts -join ', '))"
    }
}

function Get-JsonFromKubectl {
    param([Parameter(Mandatory = $true)][string[]]$KubectlArguments)
    $result = Invoke-ClusterKubectl -KubectlArguments $KubectlArguments
    try {
        return ($result.Output | ConvertFrom-Json)
    } catch {
        throw "kubectl $(@($KubectlArguments) -join ' ') returned invalid JSON: $($_.Exception.Message)"
    }
}

function Get-NamespaceNetworkPolicies {
    $parsed = Get-JsonFromKubectl -KubectlArguments @('get', 'networkpolicies', '-o', 'json')
    $kind = Get-JsonString $parsed 'kind'
    if ($null -ne $kind -and $kind -ne 'NetworkPolicyList') {
        throw "kubectl get networkpolicies returned unexpected kind '$kind'"
    }
    $items = Get-JsonProperty $parsed 'items'
    if ($null -eq $items) { return @() }
    return @($items)
}

function Get-NamespaceNetworkPolicy {
    param([string]$Name)
    $parsed = Get-JsonFromKubectl -KubectlArguments @('get', 'networkpolicy', $Name, '-o', 'json')
    if ($null -eq $parsed) {
        throw "kubectl get networkpolicy $Name returned no object"
    }
    return $parsed
}

# ---------------------------------------------------------------------------
# Expected contracts
# ---------------------------------------------------------------------------

function New-ExpectedPodSelector {
    param([string]$ProjectId, [bool]$Narrowed)
    $requirements = @([ordered]@{
        key      = $script:ComponentLabel
        operator = 'In'
        values   = @('mysql', 'redis')
    })
    if ($Narrowed) {
        return [ordered]@{
            matchLabels      = [ordered]@{ $script:ProjectIdLabel = $ProjectId }
            matchExpressions = $requirements
        }
    }
    return [ordered]@{ matchExpressions = $requirements }
}

function New-ExpectedPolicySpec {
    param([string]$ProjectId, [bool]$Narrowed)
    return [ordered]@{
        podSelector = (New-ExpectedPodSelector -ProjectId $ProjectId -Narrowed $Narrowed)
        policyTypes = @('Ingress')
        ingress     = @([ordered]@{
            from  = @([ordered]@{ podSelector = [ordered]@{ matchLabels = [ordered]@{ $script:ProjectIdLabel = $ProjectId } } })
            ports = @(
                [ordered]@{ protocol = 'TCP'; port = 3306 },
                [ordered]@{ protocol = 'TCP'; port = 6379 }
            )
        })
    }
}

function Test-PolicyMatchesSpec {
    param($Policy, [string]$ProjectId, [bool]$Narrowed)
    $spec = Get-JsonProperty $Policy 'spec'
    if ($null -eq $spec) { return $false }
    $actual = ConvertTo-CanonicalJson -Value $spec
    $expected = ConvertTo-CanonicalJson -Value (New-ExpectedPolicySpec -ProjectId $ProjectId -Narrowed $Narrowed)
    return ($actual -eq $expected)
}

function Get-PolicyIdentityMismatchReasons {
    param($Policy, [string]$ProjectId)
    $reasons = New-Object System.Collections.Generic.List[string]
    $metadata = Get-JsonProperty $Policy 'metadata'
    if ($null -eq $metadata) {
        $reasons.Add('metadata is missing')
        return $reasons.ToArray()
    }
    $expectedName = $script:PolicyNamePrefix + $ProjectId
    $actualName = Get-JsonString $metadata 'name'
    if ($actualName -ne $expectedName) {
        $reasons.Add("metadata.name is '$actualName', expected '$expectedName'")
    }
    $actualNamespace = Get-JsonString $metadata 'namespace'
    if ($actualNamespace -ne $script:NamespaceName) {
        $reasons.Add("metadata.namespace is '$actualNamespace', expected '$($script:NamespaceName)'")
    }
    $uid = Get-JsonString $metadata 'uid'
    if ([string]::IsNullOrWhiteSpace($uid)) {
        $reasons.Add('metadata.uid is missing')
    }
    $resourceVersion = Get-JsonString $metadata 'resourceVersion'
    if ([string]::IsNullOrWhiteSpace($resourceVersion)) {
        $reasons.Add('metadata.resourceVersion is missing')
    }
    $labels = Get-JsonProperty $metadata 'labels'
    $managedBy = Get-JsonString $labels 'app.kubernetes.io/managed-by'
    if ($managedBy -ne $script:ManagedByLabelValue) {
        $reasons.Add("label app.kubernetes.io/managed-by is '$managedBy', expected '$($script:ManagedByLabelValue)'")
    }
    $projectLabel = Get-JsonString $labels $script:ProjectIdLabel
    if ($projectLabel -ne $ProjectId) {
        $reasons.Add("label $($script:ProjectIdLabel) is '$projectLabel', expected '$ProjectId'")
    }
    $componentLabel = Get-JsonString $labels $script:ComponentLabel
    if ($componentLabel -ne 'dependencies') {
        $reasons.Add("label $($script:ComponentLabel) is '$componentLabel', expected 'dependencies'")
    }
    return $reasons.ToArray()
}

function Get-PolicySpecMismatchReasons {
    param($Policy, [string]$ProjectId)
    $reasons = New-Object System.Collections.Generic.List[string]
    $spec = Get-JsonProperty $Policy 'spec'
    if ($null -eq $spec) {
        $reasons.Add('spec is missing')
        return $reasons.ToArray()
    }
    $actualPodSelector = ConvertTo-CanonicalJson -Value (Get-JsonProperty $spec 'podSelector')
    $legacySelector = ConvertTo-CanonicalJson -Value (New-ExpectedPodSelector -ProjectId $ProjectId -Narrowed $false)
    $narrowedSelector = ConvertTo-CanonicalJson -Value (New-ExpectedPodSelector -ProjectId $ProjectId -Narrowed $true)
    if ($actualPodSelector -ne $legacySelector -and $actualPodSelector -ne $narrowedSelector) {
        $reasons.Add('spec.podSelector is neither the reviewed legacy selector nor the narrowed selector')
    }
    $actualPolicyTypes = ConvertTo-CanonicalJson -Value (Get-JsonProperty $spec 'policyTypes')
    if ($actualPolicyTypes -ne (ConvertTo-CanonicalJson -Value @('Ingress'))) {
        $reasons.Add('spec.policyTypes is not exactly [Ingress]')
    }
    $actualIngress = ConvertTo-CanonicalJson -Value (Get-JsonProperty $spec 'ingress')
    $expectedIngress = ConvertTo-CanonicalJson -Value (Get-JsonProperty (New-ExpectedPolicySpec -ProjectId $ProjectId -Narrowed $false) 'ingress')
    if ($actualIngress -ne $expectedIngress) {
        $reasons.Add('spec.ingress does not match the reviewed same-project source and 3306/6379 ports')
    }
    $actualNames = @(Get-JsonPropertyNames $spec | Sort-Object)
    $expectedNames = @('ingress', 'podSelector', 'policyTypes')
    if (($actualNames -join ',') -ne ($expectedNames -join ',')) {
        $reasons.Add("spec has unexpected fields: $($actualNames -join ',')")
    }
    return $reasons.ToArray()
}

# A policy outside the reviewed list is a completion blocker when it can still govern
# dependency pods and admit ingress. Any project-id constraint selects that project's pods
# (including its MySQL/Redis pods), and an empty selector selects every pod.
function Test-PolicyCanStillAllowDependencyIngress {
    param($Policy)
    $spec = Get-JsonProperty $Policy 'spec'
    $ingressValue = Get-JsonProperty $spec 'ingress'
    if ($null -eq $ingressValue) { return $false }
    $ingress = @($ingressValue)
    if ($ingress.Count -eq 0) { return $false }
    $podSelector = Get-JsonProperty $spec 'podSelector'
    if ($null -eq $podSelector) { return $true }
    $matchLabels = Get-JsonProperty $podSelector 'matchLabels'
    $matchExpressions = Get-JsonProperty $podSelector 'matchExpressions'
    $labelCount = 0
    if ($null -ne $matchLabels) { $labelCount = @(Get-JsonPropertyNames $matchLabels).Count }
    $expressionCount = 0
    if ($null -ne $matchExpressions) { $expressionCount = @($matchExpressions).Count }
    if ($labelCount -eq 0 -and $expressionCount -eq 0) { return $true }
    if ($null -ne $matchLabels) {
        $component = Get-JsonString $matchLabels $script:ComponentLabel
        if ($component -eq 'mysql' -or $component -eq 'redis') { return $true }
        $project = Get-JsonString $matchLabels $script:ProjectIdLabel
        if (-not [string]::IsNullOrWhiteSpace($project)) { return $true }
    }
    if ($null -ne $matchExpressions) {
        foreach ($requirement in @($matchExpressions)) {
            $key = Get-JsonString $requirement 'key'
            $valuesValue = Get-JsonProperty $requirement 'values'
            $values = @()
            if ($null -ne $valuesValue) { $values = @($valuesValue) }
            if ($key -eq $script:ComponentLabel -and ($values.Count -eq 0 -or $values -contains 'mysql' -or $values -contains 'redis')) {
                return $true
            }
            if ($key -eq $script:ProjectIdLabel) { return $true }
        }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Reviewed project list
# ---------------------------------------------------------------------------

function Read-ReviewedProjects {
    param([string]$Path)
    $parsed = Read-JsonFile -Path $Path -Description 'ProjectsFile'
    $entries = @($parsed)
    if ($entries.Count -eq 0) {
        throw 'ProjectsFile must contain at least one reviewed {ownerId, projectId} entry'
    }
    $seen = @{}
    $projects = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $entries) {
        if ($null -eq $entry) { throw 'ProjectsFile contains a null entry' }
        $ownerId = Get-JsonString $entry 'ownerId'
        $projectId = Get-JsonString $entry 'projectId'
        if ([string]::IsNullOrWhiteSpace($ownerId)) {
            throw 'ProjectsFile entry is missing ownerId'
        }
        if ([string]::IsNullOrWhiteSpace($projectId)) {
            throw 'ProjectsFile entry is missing projectId'
        }
        $ownerId = $ownerId.Trim()
        $projectId = $projectId.Trim()
        # Project ids are UUID strings and label values; refuse anything that is not a
        # safe lowercase DNS label before it is concatenated into a resource name.
        if ($projectId -notmatch '^[a-z0-9][a-z0-9-]{0,99}$') {
            throw "ProjectsFile projectId '$projectId' is not a safe lowercase DNS label"
        }
        if ($seen.ContainsKey($projectId)) {
            throw "ProjectsFile contains duplicate projectId '$projectId'"
        }
        $seen[$projectId] = $true
        $projects.Add([pscustomobject]@{ OwnerId = $ownerId; ProjectId = $projectId })
    }
    return $projects.ToArray()
}

# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

function Get-PolicyClassification {
    param($Projects, $Policies)
    $projectIds = @($Projects | ForEach-Object { $_.ProjectId })
    $expectedNames = @($projectIds | ForEach-Object { $script:PolicyNamePrefix + $_ })
    $byName = @{}
    foreach ($policy in $Policies) {
        $name = Get-JsonString (Get-JsonProperty $policy 'metadata') 'name'
        if ([string]::IsNullOrWhiteSpace($name)) {
            throw 'namespace contains a NetworkPolicy without metadata.name'
        }
        if ($byName.ContainsKey($name)) {
            throw "namespace contains duplicate NetworkPolicy name '$name'"
        }
        $byName[$name] = $policy
    }

    $results = New-Object System.Collections.Generic.List[object]
    $outOfScope = New-Object System.Collections.Generic.List[object]
    $ignored = New-Object System.Collections.Generic.List[object]

    foreach ($project in $Projects) {
        $projectId = $project.ProjectId
        $name = $script:PolicyNamePrefix + $projectId
        $policy = $null
        if ($byName.ContainsKey($name)) { $policy = $byName[$name] }
        if ($null -eq $policy) {
            $results.Add([pscustomobject]@{
                OwnerId              = $project.OwnerId
                ProjectId            = $projectId
                PolicyName           = $name
                Status               = 'MISSING'
                Policy               = $null
                Uid                  = $null
                ResourceVersion      = $null
                Reasons              = @('reviewed dependency policy does not exist in the namespace')
            })
            continue
        }
        $metadata = Get-JsonProperty $policy 'metadata'
        $uid = Get-JsonString $metadata 'uid'
        $resourceVersion = Get-JsonString $metadata 'resourceVersion'
        $identityReasons = @(Get-PolicyIdentityMismatchReasons -Policy $policy -ProjectId $projectId)
        if ($identityReasons.Count -gt 0) {
            $results.Add([pscustomobject]@{
                OwnerId         = $project.OwnerId
                ProjectId       = $projectId
                PolicyName      = $name
                Status          = 'IDENTITY_MISMATCH'
                Policy          = $policy
                Uid             = $uid
                ResourceVersion = $resourceVersion
                Reasons         = $identityReasons
            })
            continue
        }
        if (Test-PolicyMatchesSpec -Policy $policy -ProjectId $projectId -Narrowed $true) {
            $results.Add([pscustomobject]@{
                OwnerId         = $project.OwnerId
                ProjectId       = $projectId
                PolicyName      = $name
                Status          = 'ALREADY_FIXED'
                Policy          = $policy
                Uid             = $uid
                ResourceVersion = $resourceVersion
                Reasons         = @()
            })
            continue
        }
        if (Test-PolicyMatchesSpec -Policy $policy -ProjectId $projectId -Narrowed $false) {
            $results.Add([pscustomobject]@{
                OwnerId         = $project.OwnerId
                ProjectId       = $projectId
                PolicyName      = $name
                Status          = 'NEEDS_MIGRATION'
                Policy          = $policy
                Uid             = $uid
                ResourceVersion = $resourceVersion
                Reasons         = @()
            })
            continue
        }
        $results.Add([pscustomobject]@{
            OwnerId         = $project.OwnerId
            ProjectId       = $projectId
            PolicyName      = $name
            Status          = 'UNKNOWN_SPEC'
            Policy          = $policy
            Uid             = $uid
            ResourceVersion = $resourceVersion
            Reasons         = @(Get-PolicySpecMismatchReasons -Policy $policy -ProjectId $projectId)
        })
    }

    foreach ($policy in $Policies) {
        $name = Get-JsonString (Get-JsonProperty $policy 'metadata') 'name'
        if ($expectedNames -contains $name) { continue }
        if ($name.StartsWith($script:PolicyNamePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $outOfScope.Add([pscustomobject]@{
                PolicyName = $name
                Reasons    = @('dependency policy name is outside the reviewed project list (zero-omission check)')
            })
            continue
        }
        if (Test-PolicyCanStillAllowDependencyIngress -Policy $policy) {
            $outOfScope.Add([pscustomobject]@{
                PolicyName = $name
                Reasons    = @('policy can still target dependency pods and admit ingress; it is outside the reviewed list')
            })
            continue
        }
        $ignored.Add([pscustomobject]@{ PolicyName = $name })
    }

    return [pscustomobject]@{
        Results    = $results.ToArray()
        OutOfScope = $outOfScope.ToArray()
        Ignored    = $ignored.ToArray()
    }
}

function Test-ClassificationIsComplete {
    param($Classification)
    foreach ($result in @($Classification.Results)) {
        if ($result.Status -eq 'MISSING' -or $result.Status -eq 'IDENTITY_MISMATCH' -or $result.Status -eq 'UNKNOWN_SPEC') {
            return $false
        }
    }
    if (@($Classification.OutOfScope).Count -gt 0) { return $false }
    return $true
}

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

function Write-PolicyBackup {
    param($Policy, [string]$BackupDirectory)
    $metadata = Get-JsonProperty $Policy 'metadata'
    $name = Get-JsonString $metadata 'name'
    $kind = Get-JsonString $Policy 'kind'
    if ($kind -ne 'NetworkPolicy') {
        throw "refusing to back up '$name': object kind is '$kind', not NetworkPolicy"
    }
    if (-not (Test-Path -LiteralPath $BackupDirectory)) {
        New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
    }
    $path = Join-Path $BackupDirectory ($name + '.json')
    Write-Utf8NoBom -Path $path -Text (ConvertTo-Json -InputObject $Policy -Depth 40)
    return $path
}

function Invoke-PolicyPatch {
    param($Policy, [string]$ProjectId)
    $metadata = Get-JsonProperty $Policy 'metadata'
    $name = Get-JsonString $metadata 'name'
    $uid = Get-JsonString $metadata 'uid'
    $resourceVersion = Get-JsonString $metadata 'resourceVersion'
    if ([string]::IsNullOrWhiteSpace($uid) -or [string]::IsNullOrWhiteSpace($resourceVersion)) {
        return [pscustomobject]@{ Ok = $false; Conflict = $false; Message = 'metadata.uid/resourceVersion missing before patch' }
    }
    $operations = @(
        [ordered]@{ op = 'test'; path = '/metadata/uid'; value = $uid },
        [ordered]@{ op = 'test'; path = '/metadata/resourceVersion'; value = $resourceVersion },
        [ordered]@{ op = 'replace'; path = '/spec/podSelector'; value = (New-ExpectedPodSelector -ProjectId $ProjectId -Narrowed $true) }
    )
    $patchFile = [System.IO.Path]::GetTempFileName()
    try {
        Write-Utf8NoBom -Path $patchFile -Text (ConvertTo-Json -InputObject $operations -Depth 30 -Compress)
        $result = Invoke-ClusterKubectl -KubectlArguments @(
            'patch', 'networkpolicy', $name, '--type=json', '--patch-file', $patchFile
        ) -AllowFailure
        if ($result.ExitCode -ne 0) {
            $message = $result.ErrorText.Trim()
            if ($message.Length -eq 0) { $message = $result.Output.Trim() }
            return [pscustomobject]@{
                Ok       = $false
                Conflict = $true
                Message  = "patch rejected (uid/resourceVersion test failed or concurrent change): $message"
            }
        }
        return [pscustomobject]@{ Ok = $true; Conflict = $false; Message = '' }
    } finally {
        Remove-Item -LiteralPath $patchFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-MigratedPolicyReadBack {
    param([string]$Name, [string]$ProjectId, [string]$ExpectedUid)
    try {
        $readBack = Get-NamespaceNetworkPolicy -Name $Name
    } catch {
        return [pscustomobject]@{ Ok = $false; Message = $_.Exception.Message }
    }
    $metadata = Get-JsonProperty $readBack 'metadata'
    $uid = Get-JsonString $metadata 'uid'
    if ($uid -ne $ExpectedUid) {
        return [pscustomobject]@{ Ok = $false; Message = "read-back metadata.uid '$uid' differs from the patched object '$ExpectedUid'" }
    }
    if (-not (Test-PolicyMatchesSpec -Policy $readBack -ProjectId $ProjectId -Narrowed $true)) {
        return [pscustomobject]@{ Ok = $false; Message = 'read-back spec does not equal the narrowed dependency policy contract' }
    }
    return [pscustomobject]@{ Ok = $true; Message = '' }
}

function Write-ApplyReport {
    param([string]$Status, [int]$AppliedCount, $Results, [string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory)) {
        New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    }
    $reportResults = @()
    foreach ($result in @($Results)) {
        $reportResults += [ordered]@{
            ownerId         = $result.OwnerId
            projectId       = $result.ProjectId
            policyName      = $result.PolicyName
            status          = $result.Status
            uid             = $result.Uid
            resourceVersion = $result.ResourceVersion
            reasons         = @($result.Reasons)
        }
    }
    $report = [ordered]@{
        script         = 'repair-dependency-policy'
        mode           = 'apply'
        status         = $Status
        context        = $script:ContextName
        namespace      = $script:NamespaceName
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        appliedCount   = $AppliedCount
        results        = $reportResults
    }
    $path = Join-Path $Directory 'apply-report.json'
    Write-Utf8NoBom -Path $path -Text (ConvertTo-Json -InputObject $report -Depth 30)
    return $path
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

function Invoke-RepairDependencyPolicy {
    $script:ContextName = Assert-NonEmptyText -Value $Context -Name 'Context'
    $script:NamespaceName = Assert-NonEmptyText -Value $Namespace -Name 'Namespace'
    $script:ProjectsFilePath = Assert-NonEmptyText -Value $ProjectsFile -Name 'ProjectsFile'
    $script:OutputDirectoryPath = Assert-NonEmptyText -Value $OutputDirectory -Name 'OutputDirectory'

    $projects = Read-ReviewedProjects -Path $script:ProjectsFilePath
    Assert-KubectlContextConfigured

    $policies = Get-NamespaceNetworkPolicies
    $classification = Get-PolicyClassification -Projects $projects -Policies $policies

    $mode = 'preview'
    if ($Apply) { $mode = 'apply' }
    Write-Line "repair-dependency-policy mode=$mode"
    Write-Line "context=$($script:ContextName) namespace=$($script:NamespaceName) projects=$(@($projects).Count)"

    foreach ($result in @($classification.Results)) {
        Write-Line "[$($result.Status)] ownerId=$($result.OwnerId) projectId=$($result.ProjectId) policy=$($result.PolicyName) uid=$($result.Uid) resourceVersion=$($result.ResourceVersion)"
        foreach ($reason in @($result.Reasons)) {
            Write-Line "  reason: $reason"
        }
    }
    foreach ($entry in @($classification.OutOfScope)) {
        Write-Line "[OUT_OF_SCOPE] policy=$($entry.PolicyName)"
        foreach ($reason in @($entry.Reasons)) {
            Write-Line "  reason: $reason"
        }
    }
    foreach ($entry in @($classification.Ignored)) {
        Write-Line "[IGNORED] policy=$($entry.PolicyName) reason=does not target or allow dependency pods"
    }

    if (-not (Test-ClassificationIsComplete -Classification $classification)) {
        Write-Line 'RESULT=REFUSED'
        Write-Line 'REFUSED: the namespace is not proven complete against the reviewed project list; no changes were made.'
        $script:RepairExitCode = $script:ExitScopeRefused
        return
    }

    $candidates = @($classification.Results | Where-Object { $_.Status -eq 'NEEDS_MIGRATION' })

    if (-not $Apply) {
        if ($candidates.Count -eq 0) {
            Write-Line 'RESULT=ALREADY_SCOPED count=0'
            Write-Line 'PREVIEW_ONLY no cluster changes applied'
            $script:RepairExitCode = 0
            return
        }
        foreach ($candidate in $candidates) {
            Write-Line "[WOULD_PATCH] projectId=$($candidate.ProjectId) policy=$($candidate.PolicyName) uid=$($candidate.Uid) resourceVersion=$($candidate.ResourceVersion)"
        }
        Write-Line "PREVIEW_RESULT=WOULD_PATCH count=$($candidates.Count)"
        Write-Line 'PREVIEW_ONLY no cluster changes applied'
        $script:RepairExitCode = 0
        return
    }

    if ($candidates.Count -eq 0) {
        Write-Line 'RESULT=ALREADY_SCOPED count=0'
        Write-Line 'APPLY_SUMMARY nothing to patch; all reviewed policies are already project-scoped.'
        $script:RepairExitCode = 0
        return
    }

    if (-not (Test-Path -LiteralPath $script:OutputDirectoryPath)) {
        New-Item -ItemType Directory -Force -Path $script:OutputDirectoryPath | Out-Null
    }
    $backupDirectory = Join-Path $script:OutputDirectoryPath 'backup'
    $applied = 0
    foreach ($candidate in $candidates) {
        try {
            $backupPath = Write-PolicyBackup -Policy $candidate.Policy -BackupDirectory $backupDirectory
        } catch {
            Write-Line "[FAILED] policy=$($candidate.PolicyName) reason=backup failed: $($_.Exception.Message)"
            Write-Line 'RESULT=APPLY_FAILED'
            Write-ApplyReport -Status 'FAILED' -AppliedCount $applied -Results $classification.Results -Directory $script:OutputDirectoryPath | Out-Null
            $script:RepairExitCode = $script:ExitApplyFailed
            return
        }
        Write-Line "[BACKUP] policy=$($candidate.PolicyName) path=$backupPath"
        $patchResult = Invoke-PolicyPatch -Policy $candidate.Policy -ProjectId $candidate.ProjectId
        if (-not $patchResult.Ok) {
            Write-Line "[FAILED] policy=$($candidate.PolicyName) status=CONFLICT reason=$($patchResult.Message)"
            Write-Line 'RESULT=APPLY_FAILED'
            Write-ApplyReport -Status 'FAILED' -AppliedCount $applied -Results $classification.Results -Directory $script:OutputDirectoryPath | Out-Null
            $script:RepairExitCode = $script:ExitApplyFailed
            return
        }
        $readBack = Test-MigratedPolicyReadBack -Name $candidate.PolicyName -ProjectId $candidate.ProjectId -ExpectedUid $candidate.Uid
        if (-not $readBack.Ok) {
            Write-Line "[FAILED] policy=$($candidate.PolicyName) status=READBACK_MISMATCH reason=$($readBack.Message)"
            Write-Line 'RESULT=APPLY_FAILED'
            Write-ApplyReport -Status 'FAILED' -AppliedCount $applied -Results $classification.Results -Directory $script:OutputDirectoryPath | Out-Null
            $script:RepairExitCode = $script:ExitApplyFailed
            return
        }
        $applied++
        Write-Line "[PATCHED] policy=$($candidate.PolicyName) uid=$($candidate.Uid)"
        Write-Line "[VERIFIED] policy=$($candidate.PolicyName) selector=project-scoped"
    }
    Write-Line "RESULT=APPLIED count=$applied"
    Write-Line 'APPLY_SUMMARY every reviewed policy now targets only its own project''s dependency pods.'
    $reportPath = Write-ApplyReport -Status 'APPLIED' -AppliedCount $applied -Results $classification.Results -Directory $script:OutputDirectoryPath
    Write-Line "applyReport=$reportPath"
    $script:RepairExitCode = 0
    return
}

# The main routine writes its report with Write-Output, so its call must not be assigned:
# an assignment would capture the report lines instead of sending them to stdout.
$script:RepairExitCode = 0
try {
    Invoke-RepairDependencyPolicy
} catch {
    [Console]::Error.WriteLine('repair-dependency-policy: ' + $_.Exception.Message)
    exit 1
}
exit $script:RepairExitCode
