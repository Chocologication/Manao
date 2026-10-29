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

  The default mode is a read-only preview: it prints the classification and performs no
  cluster writes and no filesystem writes (it uses no temporary files at all). Out-of-scope
  policies are fail-closed: a policy outside the reviewed list is ignored only when a
  selector constraint provably excludes every dependency pod; otherwise it blocks
  completion. Completion is refused (exit code 2) when a reviewed project's policy is
  missing, when any policy cannot be proven to match the reviewed legacy contract, or when
  the namespace still contains a broad policy outside the reviewed project list. The
  script never creates missing policies, never widens the reviewed list, never retries a
  rejected patch and never rolls anything back.

.PARAMETER Context
  Explicit kubectl context. Required; every cluster call passes it as --context.

.PARAMETER Namespace
  Explicit namespace. Required; every cluster call passes it as --namespace. The script
  never uses -A / --all-namespaces.

.PARAMETER ProjectsFile
  Path to a reviewed top-level JSON array of {ownerId, projectId} objects. ownerId and
  projectId must be JSON strings; projectId must be an exact lowercase DNS label of at most
  63 characters (no trailing hyphen). Every entry is verified: the dependency policy must
  exist, carry the platform managed-by/project/component labels, carry a UID, and match the
  expected legacy spec exactly (case-sensitively).

.PARAMETER OutputDirectory
  Directory for apply artifacts. Only used with -Apply: <dir>/backup/<policy>.json holds
  one NetworkPolicy per patched policy (never Secrets), <dir>/patch/<policy>.json holds the
  JSON Patch payload passed to kubectl --patch-file (audit evidence; it contains only the
  uid/resourceVersion test values and the podSelector replace) and
  <dir>/apply-report.json holds the per-item before/after status, UID and resourceVersion
  values. A preview does not create this directory or any of its files.

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

# Exact, ordinal JSON property access. PowerShell's normal property accelerator is
# case-insensitive; identity and spec checks must not be.
function Get-JsonProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        $key = $null
        foreach ($candidate in @($Object.Keys)) {
            if ([string]::Equals([string]$candidate, $Name, [System.StringComparison]::Ordinal)) {
                $key = $candidate
                break
            }
        }
        if ($null -eq $key) { return $null }
        return $Object[$key]
    }
    foreach ($property in @($Object.PSObject.Properties)) {
        if ([string]::Equals($property.Name, $Name, [System.StringComparison]::Ordinal)) {
            return $property.Value
        }
    }
    return $null
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
    if ($Object -is [System.Collections.IDictionary]) {
        $names = @()
        foreach ($key in @($Object.Keys)) { $names += [string]$key }
        return $names
    }
    $names = @()
    foreach ($property in @($Object.PSObject.Properties)) { $names += $property.Name }
    return $names
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

# Deterministic case-sensitive JSON used for strict structural comparison: object
# properties are sorted with an ordinal sort, array order is preserved and scalars keep
# their JSON type.
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
        foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) {
            $parts.Add(((ConvertTo-Json -InputObject ([string]$key) -Compress) + ':' + (ConvertTo-CanonicalJson -Value $Value[$key])))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $parts = New-Object System.Collections.Generic.List[string]
        $names = @()
        foreach ($property in @($Value.PSObject.Properties)) { $names += $property.Name }
        foreach ($name in @($names | Sort-Object -CaseSensitive)) {
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
# kubectl access (explicit context/namespace on every cluster call).
# Everything is captured in memory: the preview must not create files, not even
# temporary stderr files.
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
    $previousErrorActionPreference = $ErrorActionPreference
    $raw = @()
    try {
        # Windows PowerShell 5.1 turns redirected native stderr into ErrorRecords; keep
        # ErrorActionPreference at Continue so a failing command is classified by us
        # instead of aborting the script through a NativeCommandError.
        $ErrorActionPreference = 'Continue'
        $raw = & $kubectl @KubectlArguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $stdoutBuilder = New-Object System.Text.StringBuilder
    $stderrBuilder = New-Object System.Text.StringBuilder
    foreach ($item in @($raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            [void]$stderrBuilder.AppendLine([string]$item)
        } else {
            [void]$stdoutBuilder.AppendLine([string]$item)
        }
    }
    $outputText = $stdoutBuilder.ToString()
    $stderrText = $stderrBuilder.ToString()
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $command = (@($KubectlArguments) -join ' ')
        throw "kubectl $command failed (exit $exitCode): $($stderrText.Trim())"
    }
    return [pscustomobject]@{
        ExitCode  = $exitCode
        Output    = $outputText
        ErrorText = $stderrText
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
    if ($contexts -cnotcontains $script:ContextName) {
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
    if ($null -ne $kind -and $kind -cne 'NetworkPolicyList') {
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
    return ($actual -ceq $expected)
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
    if ($actualName -cne $expectedName) {
        $reasons.Add("metadata.name is '$actualName', expected '$expectedName'")
    }
    $actualNamespace = Get-JsonString $metadata 'namespace'
    if ($actualNamespace -cne $script:NamespaceName) {
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
    if ($managedBy -cne $script:ManagedByLabelValue) {
        $reasons.Add("label app.kubernetes.io/managed-by is '$managedBy', expected '$($script:ManagedByLabelValue)'")
    }
    $projectLabel = Get-JsonString $labels $script:ProjectIdLabel
    if ($projectLabel -cne $ProjectId) {
        $reasons.Add("label $($script:ProjectIdLabel) is '$projectLabel', expected '$ProjectId'")
    }
    $componentLabel = Get-JsonString $labels $script:ComponentLabel
    if ($componentLabel -cne 'dependencies') {
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
    if ($actualPodSelector -cne $legacySelector -and $actualPodSelector -cne $narrowedSelector) {
        $reasons.Add('spec.podSelector is neither the reviewed legacy selector nor the narrowed selector')
    }
    $actualPolicyTypes = ConvertTo-CanonicalJson -Value (Get-JsonProperty $spec 'policyTypes')
    if ($actualPolicyTypes -cne (ConvertTo-CanonicalJson -Value @('Ingress'))) {
        $reasons.Add('spec.policyTypes is not exactly [Ingress]')
    }
    $actualIngress = ConvertTo-CanonicalJson -Value (Get-JsonProperty $spec 'ingress')
    $expectedIngress = ConvertTo-CanonicalJson -Value ((New-ExpectedPolicySpec -ProjectId $ProjectId -Narrowed $false)['ingress'])
    if ($actualIngress -cne $expectedIngress) {
        $reasons.Add('spec.ingress does not match the reviewed same-project source and 3306/6379 ports')
    }
    $actualNames = @(Get-JsonPropertyNames $spec | Sort-Object -CaseSensitive)
    $expectedNames = @('ingress', 'podSelector', 'policyTypes')
    if (($actualNames -join ',') -cne ($expectedNames -join ',')) {
        $reasons.Add("spec has unexpected fields: $($actualNames -join ',')")
    }
    return $reasons.ToArray()
}

# A dependency pod is known to carry: manao.poc4/project-id = <any project>,
# manao.poc4/component in {mysql, redis}, and app.kubernetes.io/managed-by =
# manao-poc4-backend. Other labels are unknown. A single selector constraint proves that
# a policy excludes every dependency pod only for the exact cases below; anything else is
# treated as possibly matching (fail-closed).
function Test-LabelConstraintExcludesDependencyPods {
    param([string]$Key, [string]$Operator, $Values)
    if ($Key -ceq $script:ComponentLabel) {
        if ($Operator -ceq 'In') {
            foreach ($value in @($Values)) {
                if ([string]$value -ceq 'mysql' -or [string]$value -ceq 'redis') { return $false }
            }
            return $true
        }
        if ($Operator -ceq 'NotIn') {
            $coversMysql = $false
            $coversRedis = $false
            foreach ($value in @($Values)) {
                if ([string]$value -ceq 'mysql') { $coversMysql = $true }
                if ([string]$value -ceq 'redis') { $coversRedis = $true }
            }
            return ($coversMysql -and $coversRedis)
        }
        if ($Operator -ceq 'Exists') { return $false }
        if ($Operator -ceq 'DoesNotExist') { return $true }
        return $false
    }
    if ($Key -ceq 'app.kubernetes.io/managed-by') {
        if ($Operator -ceq 'In') {
            foreach ($value in @($Values)) {
                if ([string]$value -ceq $script:ManagedByLabelValue) { return $false }
            }
            return $true
        }
        if ($Operator -ceq 'NotIn') {
            foreach ($value in @($Values)) {
                if ([string]$value -ceq $script:ManagedByLabelValue) { return $true }
            }
            return $false
        }
        if ($Operator -ceq 'Exists') { return $false }
        if ($Operator -ceq 'DoesNotExist') { return $true }
        return $false
    }
    if ($Key -ceq $script:ProjectIdLabel) {
        return ($Operator -ceq 'DoesNotExist')
    }
    # Unknown label key: cannot prove that dependency pods are excluded.
    return $false
}

function Test-SelectorProvablyExcludesDependencyPods {
    param($PodSelector)
    if ($null -eq $PodSelector) { return $false }
    $matchLabels = Get-JsonProperty $PodSelector 'matchLabels'
    $matchExpressions = Get-JsonProperty $PodSelector 'matchExpressions'
    if ($null -ne $matchLabels) {
        foreach ($labelName in @(Get-JsonPropertyNames $matchLabels)) {
            $labelValue = Get-JsonProperty $matchLabels $labelName
            if ($null -eq $labelValue) { continue }
            if (Test-LabelConstraintExcludesDependencyPods -Key $labelName -Operator 'In' -Values @([string]$labelValue)) {
                return $true
            }
        }
    }
    if ($null -ne $matchExpressions) {
        foreach ($requirement in @($matchExpressions)) {
            $key = Get-JsonString $requirement 'key'
            $operator = Get-JsonString $requirement 'operator'
            if ([string]::IsNullOrEmpty($key) -or [string]::IsNullOrEmpty($operator)) { continue }
            $valuesValue = Get-JsonProperty $requirement 'values'
            $values = @()
            if ($null -ne $valuesValue) { $values = @($valuesValue) }
            if (Test-LabelConstraintExcludesDependencyPods -Key $key -Operator $operator -Values $values) {
                return $true
            }
        }
    }
    return $false
}

# An out-of-scope policy is a completion blocker when it can still admit ingress to
# dependency pods. Policies with no ingress rules (or with policyTypes that exclude
# Ingress) cannot allow dependency ingress. Otherwise the policy blocks unless its
# pod selector provably excludes every dependency pod (fail-closed).
function Test-PolicyCanStillAllowDependencyIngress {
    param($Policy)
    $spec = Get-JsonProperty $Policy 'spec'
    if ($null -eq $spec) {
        # A NetworkPolicy with no spec selects every pod and has no rules, but fail closed.
        return $true
    }
    $policyTypesValue = Get-JsonProperty $spec 'policyTypes'
    if ($null -ne $policyTypesValue) {
        $policyTypes = @($policyTypesValue)
        if ($policyTypes.Count -gt 0 -and -not ($policyTypes -ccontains 'Ingress')) {
            return $false
        }
    }
    $ingressValue = Get-JsonProperty $spec 'ingress'
    if ($null -eq $ingressValue) { return $false }
    $ingress = @($ingressValue)
    if ($ingress.Count -eq 0) { return $false }
    $podSelector = Get-JsonProperty $spec 'podSelector'
    if ($null -eq $podSelector) { return $true }
    if (Test-SelectorProvablyExcludesDependencyPods -PodSelector $podSelector) { return $false }
    return $true
}

# ---------------------------------------------------------------------------
# Reviewed project list
# ---------------------------------------------------------------------------

function Read-ReviewedProjects {
    param([string]$Path)
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $raw = [System.IO.File]::ReadAllText($resolved.Path)
    $trimmed = $raw.Trim()
    if ($trimmed.Length -eq 0) {
        throw 'ProjectsFile is empty'
    }
    if (-not $trimmed.StartsWith('[', [System.StringComparison]::Ordinal)) {
        throw 'ProjectsFile must be a top-level JSON array of {ownerId, projectId} objects'
    }
    $parsed = $null
    try {
        $parsed = $raw | ConvertFrom-Json
    } catch {
        throw "ProjectsFile is not valid JSON ($Path): $($_.Exception.Message)"
    }
    $entries = @($parsed)
    if ($entries.Count -eq 0) {
        throw 'ProjectsFile must contain at least one reviewed {ownerId, projectId} entry'
    }
    $seen = [System.Collections.Generic.Dictionary[string,bool]]::new([System.StringComparer]::Ordinal)
    $projects = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $entries) {
        if ($null -eq $entry) {
            throw 'ProjectsFile contains a null entry'
        }
        if (-not ($entry -is [System.Management.Automation.PSCustomObject])) {
            throw 'ProjectsFile entries must be JSON objects with ownerId and projectId'
        }
        $ownerValue = Get-JsonProperty $entry 'ownerId'
        $projectValue = Get-JsonProperty $entry 'projectId'
        if (-not ($ownerValue -is [string])) {
            throw 'ProjectsFile entry ownerId must be a JSON string'
        }
        if (-not ($projectValue -is [string])) {
            throw 'ProjectsFile entry projectId must be a JSON string'
        }
        $ownerId = $ownerValue.Trim()
        $projectId = $projectValue.Trim()
        if ($ownerId.Length -eq 0) {
            throw 'ProjectsFile entry is missing ownerId'
        }
        if ($projectId.Length -eq 0) {
            throw 'ProjectsFile entry is missing projectId'
        }
        # Project ids are UUID strings used as label values and resource-name suffixes:
        # require an exact lowercase DNS label of at most 63 characters, no trailing hyphen.
        if ($projectId -cnotmatch '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') {
            throw "ProjectsFile projectId '$projectId' is not a safe lowercase DNS label (at most 63 characters, no trailing hyphen)"
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
    $byName = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
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
        if ($expectedNames -ccontains $name) { continue }
        if ($name.StartsWith($script:PolicyNamePrefix, [System.StringComparison]::Ordinal)) {
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
        if ($result.Status -ceq 'MISSING' -or $result.Status -ceq 'IDENTITY_MISMATCH' -or $result.Status -ceq 'UNKNOWN_SPEC') {
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
    if ($kind -cne 'NetworkPolicy') {
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
    param($Policy, [string]$ProjectId, [string]$PatchDirectory)
    $metadata = Get-JsonProperty $Policy 'metadata'
    $name = Get-JsonString $metadata 'name'
    $uid = Get-JsonString $metadata 'uid'
    $resourceVersion = Get-JsonString $metadata 'resourceVersion'
    if ([string]::IsNullOrWhiteSpace($uid) -or [string]::IsNullOrWhiteSpace($resourceVersion)) {
        return [pscustomobject]@{ Ok = $false; Conflict = $false; Message = 'metadata.uid/resourceVersion missing before patch'; PatchPath = $null }
    }
    $operations = @(
        [ordered]@{ op = 'test'; path = '/metadata/uid'; value = $uid },
        [ordered]@{ op = 'test'; path = '/metadata/resourceVersion'; value = $resourceVersion },
        [ordered]@{ op = 'replace'; path = '/spec/podSelector'; value = (New-ExpectedPodSelector -ProjectId $ProjectId -Narrowed $true) }
    )
    # Windows PowerShell 5.1 native argv quoting strips the JSON double quotes, so an
    # inline --patch '<json>' argument reaches kubectl as invalid JSON. Apply mode writes
    # the payload under OutputDirectory/patch and passes it with --patch-file instead
    # (never the OS temp directory; preview mode never creates any of these files).
    if (-not (Test-Path -LiteralPath $PatchDirectory)) {
        New-Item -ItemType Directory -Force -Path $PatchDirectory | Out-Null
    }
    $patchPath = Join-Path $PatchDirectory ($name + '.json')
    $patchJson = ConvertTo-Json -InputObject $operations -Depth 30 -Compress
    Write-Utf8NoBom -Path $patchPath -Text $patchJson
    $result = Invoke-ClusterKubectl -KubectlArguments @(
        'patch', 'networkpolicy', $name, '--type=json', '--patch-file', $patchPath
    ) -AllowFailure
    if ($result.ExitCode -ne 0) {
        $message = $result.ErrorText.Trim()
        if ($message.Length -eq 0) { $message = $result.Output.Trim() }
        return [pscustomobject]@{
            Ok        = $false
            Conflict  = $true
            Message   = "patch rejected (uid/resourceVersion test failed or concurrent change): $message"
            PatchPath = $patchPath
        }
    }
    return [pscustomobject]@{ Ok = $true; Conflict = $false; Message = ''; PatchPath = $patchPath }
}

function Test-MigratedPolicyReadBack {
    param([string]$Name, [string]$ProjectId, [string]$ExpectedUid)
    try {
        $readBack = Get-NamespaceNetworkPolicy -Name $Name
    } catch {
        return [pscustomobject]@{ Ok = $false; Message = $_.Exception.Message; Uid = $null; ResourceVersion = $null }
    }
    $metadata = Get-JsonProperty $readBack 'metadata'
    $uid = Get-JsonString $metadata 'uid'
    $resourceVersion = Get-JsonString $metadata 'resourceVersion'
    if ($uid -cne $ExpectedUid) {
        return [pscustomobject]@{
            Ok = $false
            Message = "read-back metadata.uid '$uid' differs from the patched object '$ExpectedUid'"
            Uid = $uid
            ResourceVersion = $resourceVersion
        }
    }
    if (-not (Test-PolicyMatchesSpec -Policy $readBack -ProjectId $ProjectId -Narrowed $true)) {
        return [pscustomobject]@{
            Ok = $false
            Message = 'read-back spec does not equal the narrowed dependency policy contract'
            Uid = $uid
            ResourceVersion = $resourceVersion
        }
    }
    return [pscustomobject]@{ Ok = $true; Message = ''; Uid = $uid; ResourceVersion = $resourceVersion }
}

function New-ReportEntries {
    param($ClassificationResults)
    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($result in @($ClassificationResults)) {
        $status = $result.Status
        if ($status -ceq 'NEEDS_MIGRATION') { $status = 'PENDING' }
        $entries.Add([pscustomobject]@{
            OwnerId               = $result.OwnerId
            ProjectId             = $result.ProjectId
            PolicyName            = $result.PolicyName
            Status                = $status
            BeforeUid             = $result.Uid
            BeforeResourceVersion = $result.ResourceVersion
            AfterUid              = $null
            AfterResourceVersion  = $null
            Reasons               = @($result.Reasons)
        })
    }
    return $entries.ToArray()
}

function Get-ReportEntry {
    param($Entries, [string]$PolicyName)
    foreach ($entry in @($Entries)) {
        if ([string]::Equals($entry.PolicyName, $PolicyName, [System.StringComparison]::Ordinal)) {
            return $entry
        }
    }
    return $null
}

function Write-ApplyReport {
    param([string]$Status, [int]$AppliedCount, $Entries, [string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory)) {
        New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    }
    $reportResults = @()
    foreach ($entry in @($Entries)) {
        $entryStatus = $entry.Status
        if ($entryStatus -ceq 'PENDING') { $entryStatus = 'NOT_ATTEMPTED' }
        $afterUid = $entry.AfterUid
        $afterResourceVersion = $entry.AfterResourceVersion
        if ($entryStatus -ceq 'ALREADY_FIXED') {
            $afterUid = $entry.BeforeUid
            $afterResourceVersion = $entry.BeforeResourceVersion
        }
        $reportResults += [ordered]@{
            ownerId               = $entry.OwnerId
            projectId             = $entry.ProjectId
            policyName            = $entry.PolicyName
            status                = $entryStatus
            beforeUid             = $entry.BeforeUid
            beforeResourceVersion = $entry.BeforeResourceVersion
            afterUid              = $afterUid
            afterResourceVersion  = $afterResourceVersion
            reasons               = @($entry.Reasons)
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

    $candidates = @($classification.Results | Where-Object { $_.Status -ceq 'NEEDS_MIGRATION' })

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
    $patchDirectory = Join-Path $script:OutputDirectoryPath 'patch'
    $reportEntries = @(New-ReportEntries -ClassificationResults $classification.Results)
    $applied = 0
    foreach ($candidate in $candidates) {
        $reportEntry = Get-ReportEntry -Entries $reportEntries -PolicyName $candidate.PolicyName
        try {
            $backupPath = Write-PolicyBackup -Policy $candidate.Policy -BackupDirectory $backupDirectory
        } catch {
            if ($null -ne $reportEntry) {
                $reportEntry.Status = 'FAILED'
                $reportEntry.Reasons = @('backup failed: ' + $_.Exception.Message)
            }
            Write-Line "[FAILED] policy=$($candidate.PolicyName) reason=backup failed: $($_.Exception.Message)"
            Write-Line 'RESULT=APPLY_FAILED'
            Write-ApplyReport -Status 'FAILED' -AppliedCount $applied -Entries $reportEntries -Directory $script:OutputDirectoryPath | Out-Null
            $script:RepairExitCode = $script:ExitApplyFailed
            return
        }
        Write-Line "[BACKUP] policy=$($candidate.PolicyName) path=$backupPath"
        $patchResult = Invoke-PolicyPatch -Policy $candidate.Policy -ProjectId $candidate.ProjectId -PatchDirectory $patchDirectory
        if (-not [string]::IsNullOrWhiteSpace($patchResult.PatchPath)) {
            Write-Line "[PATCH_PAYLOAD] policy=$($candidate.PolicyName) path=$($patchResult.PatchPath)"
        }
        if (-not $patchResult.Ok) {
            if ($null -ne $reportEntry) {
                $reportEntry.Status = 'FAILED'
                $reportEntry.Reasons = @($patchResult.Message)
            }
            Write-Line "[FAILED] policy=$($candidate.PolicyName) status=CONFLICT reason=$($patchResult.Message)"
            Write-Line 'RESULT=APPLY_FAILED'
            Write-ApplyReport -Status 'FAILED' -AppliedCount $applied -Entries $reportEntries -Directory $script:OutputDirectoryPath | Out-Null
            $script:RepairExitCode = $script:ExitApplyFailed
            return
        }
        $readBack = Test-MigratedPolicyReadBack -Name $candidate.PolicyName -ProjectId $candidate.ProjectId -ExpectedUid $candidate.Uid
        if (-not $readBack.Ok) {
            if ($null -ne $reportEntry) {
                $reportEntry.Status = 'FAILED'
                $reportEntry.AfterUid = $readBack.Uid
                $reportEntry.AfterResourceVersion = $readBack.ResourceVersion
                $reportEntry.Reasons = @($readBack.Message)
            }
            Write-Line "[FAILED] policy=$($candidate.PolicyName) status=READBACK_MISMATCH reason=$($readBack.Message)"
            Write-Line 'RESULT=APPLY_FAILED'
            Write-ApplyReport -Status 'FAILED' -AppliedCount $applied -Entries $reportEntries -Directory $script:OutputDirectoryPath | Out-Null
            $script:RepairExitCode = $script:ExitApplyFailed
            return
        }
        $applied++
        if ($null -ne $reportEntry) {
            $reportEntry.Status = 'PATCHED'
            $reportEntry.AfterUid = $readBack.Uid
            $reportEntry.AfterResourceVersion = $readBack.ResourceVersion
        }
        Write-Line "[PATCHED] policy=$($candidate.PolicyName) uid=$($candidate.Uid)"
        Write-Line "[VERIFIED] policy=$($candidate.PolicyName) selector=project-scoped uid=$($readBack.Uid) resourceVersion=$($readBack.ResourceVersion)"
    }
    Write-Line "RESULT=APPLIED count=$applied"
    Write-Line 'APPLY_SUMMARY every reviewed policy now targets only its own project''s dependency pods.'
    $reportPath = Write-ApplyReport -Status 'APPLIED' -AppliedCount $applied -Entries $reportEntries -Directory $script:OutputDirectoryPath
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
