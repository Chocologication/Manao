#Requires -Version 5.1
<#
.SYNOPSIS
  Bind the verified email address of one legacy Manao account. Manual maintenance only;
  there is no public administrator binding API.

.DESCRIPTION
  Legacy accounts created before multi-account registration have email = NULL and cannot use
  email-based password recovery. This script binds a NEW email after the operator has
  confirmed that the account owner controls that mailbox. It is deliberately narrow:

  - It never rebinds an account that already has an email. The conditional UPDATE requires
    email IS NULL, so a bound address can never be overwritten.
  - It requires the exact account identity: the row must match UserId AND ExpectedUsername
    (ordinal, case-sensitive comparison in this script) before anything is planned.
  - It normalizes the new email exactly like the backend (trim, Locale.ROOT lower-case,
    length <= 254, syntax validation, no dot stripping and no +tag stripping), then checks
    email uniqueness.
  - The default mode is a read-only preview: it prints the exact planned change and touches
    no row and writes no file. -Apply performs one atomic conditional UPDATE
    (WHERE id = ? AND username = ? AND email IS NULL), requires exactly one affected row,
    sets email_verified_at explicitly and verifies the result with a read-back.
  - It is idempotent: re-running with the already-bound normalized value reports a no-op;
    a different value is refused.
  - It does NOT send mail, contact the account owner, verify mailbox ownership, or prove
    that the email address is deliverable. The operator must confirm ownership out of band.

  Database access mechanism (chosen after inspecting this repository's existing patterns):
  the repository already uses the mysql command-line client as a small, dependency-free
  transport for operator scripts (poc4/frontend/scripts/ai-stage*-verify-ledger.mjs) with
  env-only passwords. This script reuses that mechanism and hardens it:
  - connection settings come only from MANAO_DB_URL / MANAO_DB_USERNAME /
    MANAO_DB_PASSWORD environment variables; there is no password command-line parameter;
  - the password is passed to the child mysql client through its process environment
    (MYSQL_PWD), never through argv, and is never printed (output is also redacted);
  - SQL is sent over the child's stdin (never spliced into a shell command line);
  - all data access uses server-side prepared statements (PREPARE / EXECUTE USING): the SQL
    statement text is constant, and every user-supplied value is bound as a hex-encoded
    (X'...') server variable, so no user text is ever embedded in the SQL statement text;
  - the client runs with --no-defaults so local option files cannot change the target.

.PARAMETER UserId
  Exact app_user.id of the legacy account. Required unless -SelfTest is used.

.PARAMETER ExpectedUsername
  Exact app_user.username of the same account (case-sensitive). Required unless -SelfTest.

.PARAMETER Email
  The new email address. It is normalized/validated by the script; the operator must have
  confirmed that the account owner controls this mailbox. Required unless -SelfTest.

.PARAMETER Apply
  Perform the conditional update. Without it the script is a read-only preview.

.PARAMETER SelfTest
  Test-only harness. Creates one uniquely named disposable MySQL schema
  (manao_stage6_t8_<32 hex>), runs the real script scenarios against it as child processes,
  verifies the database rows, and drops that schema again. It never connects to the running
  manao_poc4 / manao_poc4_6b schemas; MANAO_DB_URL for -SelfTest must point at a test
  database (for example jdbc:mysql://127.0.0.1:3306/manao_poc4_test).

.EXITCODE
  0  success: preview planned a change, -Apply bound the address, or an idempotent no-op
     (already bound to the same normalized value).
  1  environment / configuration / mysql client transport / SQL / read-back failure.
  2  invalid argument (user id, expected username or email format/length).
  3  identity mismatch: no account with that UserId, or its username is not exactly
     ExpectedUsername (case-sensitive).
  4  the account already has a different email bound; refusing to overwrite it.
  5  the normalized email is already used by another account.

.NOTES
  Environment variables:
    MANAO_DB_URL       required; jdbc:mysql://<host>[:<port>]/<database>[?<ignored params>]
                       Embedded credentials (user:pass@) are rejected.
    MANAO_DB_USERNAME  required; database user.
    MANAO_DB_PASSWORD  optional; may be empty. Only read from the environment.
    MANAO_MYSQL_CLIENT optional; mysql client executable name/path (default: mysql).

  This script only updates app_user.email / email_verified_at for one exact account id.
  It never creates accounts, never changes usernames/passwords/projects, never sends mail
  and never reads or writes any other table.

  Test-only switch: -SelfTest must never be used against a running schema. It refuses a
  base URL that points at manao_poc4 / manao_poc4_6b and only creates/drops a schema whose
  name matches ^manao_stage6_t8_[0-9a-f]{32}$.

.EXAMPLE
  Preview only (no row is touched):
  $env:MANAO_DB_URL='jdbc:mysql://127.0.0.1:3306/manao_poc4'
  $env:MANAO_DB_USERNAME='manao'
  $env:MANAO_DB_PASSWORD=''
  powershell -NoProfile -File poc4/deploy/multi-account/bind-legacy-email.ps1 -UserId 'u-123' -ExpectedUsername 'legacyuser' -Email 'owner@example.com'

.EXAMPLE
  Run the local disposable-schema self-test (creates and drops its own schema):
  $env:MANAO_DB_URL='jdbc:mysql://127.0.0.1:3306/manao_poc4_test'
  $env:MANAO_DB_USERNAME='manao'
  $env:MANAO_DB_PASSWORD=''
  powershell -NoProfile -File poc4/deploy/multi-account/bind-legacy-email.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    [string]$UserId,
    [string]$ExpectedUsername,
    [string]$Email,
    [switch]$Apply,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The script reports through the process stdout/stderr directly so that command output
# never mixes with the exit-code value returned by its internal functions.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
}

$script:ExitOk = 0
$script:ExitFailure = 1
$script:ExitInvalidInput = 2
$script:ExitIdentityMismatch = 3
$script:ExitEmailBound = 4
$script:ExitEmailTaken = 5

$script:DbSettings = $null
$script:OutputSecrets = @()

# ---------------------------------------------------------------------------
# Output helpers. Database passwords are registered here and redacted from every
# line the script prints or throws.
# ---------------------------------------------------------------------------

function Register-OutputSecret {
    param([string]$Secret)
    if ([string]::IsNullOrEmpty($Secret)) { return }
    $script:OutputSecrets += $Secret
}

function Protect-OutputText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $value = $Text
    foreach ($secret in $script:OutputSecrets) {
        if (-not [string]::IsNullOrEmpty($secret)) {
            $value = $value.Replace($secret, '***')
        }
    }
    $value = [regex]::Replace($value, 'MYSQL_PWD=\S*', 'MYSQL_PWD=***')
    $value = [regex]::Replace($value, '--password(=|\s+)\S*', '--password=***')
    return $value
}

function Write-Line {
    param([string]$Text = '')
    [Console]::Out.WriteLine((Protect-OutputText $Text))
}

function Write-FailureLine {
    param([string]$Text)
    [Console]::Error.WriteLine((Protect-OutputText $Text))
}

# ---------------------------------------------------------------------------
# Environment / connection settings
# ---------------------------------------------------------------------------

function Get-EnvironmentText {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $value) { return $null }
    return $value
}

function Read-DbSettings {
    $url = Get-EnvironmentText 'MANAO_DB_URL'
    if ([string]::IsNullOrWhiteSpace($url)) {
        throw 'MANAO_DB_URL is not set; refusing to guess a database target'
    }
    $url = $url.Trim()
    if ($url -match '@') {
        throw 'MANAO_DB_URL must not embed credentials; use MANAO_DB_USERNAME / MANAO_DB_PASSWORD'
    }
    $pattern = '^(?i:jdbc:mysql://)([^/?#]+)/([^?#]+)(?:\?.*)?$'
    if ($url -notmatch $pattern) {
        throw 'MANAO_DB_URL must look like jdbc:mysql://host[:port]/database'
    }
    $authority = $Matches[1]
    $database = $Matches[2]
    $hostName = $authority
    $port = 3306
    if ($authority -match '^([^:]+):([0-9]+)$') {
        $hostName = $Matches[1]
        $port = [int]$Matches[2]
    } elseif ($authority -match ':') {
        throw 'MANAO_DB_URL has an invalid host:port authority'
    }
    if ($hostName -cnotmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') {
        throw 'MANAO_DB_URL host is invalid'
    }
    if ($port -lt 1 -or $port -gt 65535) {
        throw 'MANAO_DB_URL port is invalid'
    }
    if ($database -cnotmatch '^[A-Za-z0-9_]+$') {
        throw 'MANAO_DB_URL database name is invalid'
    }

    $userName = Get-EnvironmentText 'MANAO_DB_USERNAME'
    if ([string]::IsNullOrWhiteSpace($userName)) {
        throw 'MANAO_DB_USERNAME is not set'
    }
    $userName = $userName.Trim()
    if ($userName -cnotmatch '^[A-Za-z0-9_.-]{1,64}$') {
        throw 'MANAO_DB_USERNAME contains unsupported characters'
    }
    $password = Get-EnvironmentText 'MANAO_DB_PASSWORD'
    if ($null -eq $password) { $password = '' }
    Register-OutputSecret $password

    $client = Get-EnvironmentText 'MANAO_MYSQL_CLIENT'
    if ([string]::IsNullOrWhiteSpace($client)) { $client = 'mysql' }
    $client = $client.Trim()
    if ($client.Length -eq 0) { throw 'MANAO_MYSQL_CLIENT is empty' }

    return [pscustomobject]@{
        Host     = $hostName
        Port     = $port
        Database = $database
        UserName = $userName
        Password = $password
        Client   = $client
    }
}

# ---------------------------------------------------------------------------
# MySQL client transport: no shell, password only via the child environment,
# SQL only via stdin. Every statement is ASCII (values are hex-encoded).
# ---------------------------------------------------------------------------

function Invoke-MySqlClient {
    param(
        [string[]]$ClientArguments,
        [string]$SqlText,
        [int]$TimeoutMilliseconds = 60000
    )
    $settings = $script:DbSettings
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $settings.Client
    $startInfo.Arguments = ($ClientArguments -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['MYSQL_PWD'] = $settings.Password

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
    } catch {
        throw ('could not start the mysql client ''' + $settings.Client + '''; install it or set MANAO_MYSQL_CLIENT: ' + $_.Exception.Message)
    }
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($SqlText)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch { }
            throw 'mysql client timed out'
        }
        [void]$process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut   = $stdoutTask.Result
            StdErr   = $stderrTask.Result
        }
    } finally {
        $process.Dispose()
    }
}

function Invoke-Sql {
    param(
        [AllowNull()][string]$Database,
        [string[]]$Statements
    )
    $settings = $script:DbSettings
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("SET time_zone = '+00:00'")
    $lines.Add('SET NAMES utf8mb4')
    foreach ($statement in @($Statements)) {
        $text = [string]$statement
        if ($text.EndsWith(';')) { $text = $text.Substring(0, $text.Length - 1) }
        $lines.Add($text)
    }
    $separator = [string][char]10
    $sqlText = ($lines.ToArray() -join (';' + $separator)) + ';' + $separator
    $clientArguments = @(
        '--no-defaults', '--protocol=TCP',
        '-h', $settings.Host,
        '-P', [string]$settings.Port,
        '-u', $settings.UserName,
        '--batch', '--skip-column-names', '--default-character-set=utf8mb4'
    )
    if (-not [string]::IsNullOrWhiteSpace($Database)) {
        $clientArguments += @('-D', $Database)
    }
    return Invoke-MySqlClient -ClientArguments $clientArguments -SqlText $sqlText
}

function Assert-SqlSucceeded {
    param($Result, [string]$Operation)
    if ($null -ne $Result -and $Result.ExitCode -eq 0) { return }
    $errorText = ''
    if ($null -ne $Result) { $errorText = [string]$Result.StdErr }
    $errorText = (Protect-OutputText $errorText).Trim()
    if ($errorText.Length -gt 500) { $errorText = $errorText.Substring(0, 500) }
    throw ('database operation failed (' + $Operation + '): ' + $errorText)
}

function New-HexLiteral {
    param([string]$Value)
    if ($null -eq $Value) { $Value = '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append("X'")
    foreach ($byte in $bytes) {
        [void]$builder.Append($byte.ToString('x2'))
    }
    [void]$builder.Append("'")
    return $builder.ToString()
}

function ConvertFrom-MysqlBatchCell {
    param([AllowNull()][string]$Cell)
    if ($null -eq $Cell) { return $null }
    if ($Cell -ceq 'NULL') { return $null }
    $sentinel = [string][char]0
    $value = $Cell.Replace('\\', $sentinel)
    $value = $value.Replace('\n', [string][char]10)
    $value = $value.Replace('\t', [string][char]9)
    $value = $value.Replace('\0', $sentinel)
    $value = $value.Replace($sentinel, '\')
    return $value
}

function ConvertTo-ResultRows {
    param([AllowNull()][string]$StdOut)
    $rows = New-Object System.Collections.Generic.List[object]
    if ([string]::IsNullOrEmpty($StdOut)) { return $rows.ToArray() }
    $normalized = $StdOut.Replace([string][char]13, '')
    foreach ($line in $normalized.Split([char]10)) {
        if ($line.Length -eq 0) { continue }
        $cells = $line.Split([char]9)
        $rows.Add(@($cells))
    }
    return $rows.ToArray()
}

# ---------------------------------------------------------------------------
# Argument validation and email normalization (mirrors backend AuthContracts)
# ---------------------------------------------------------------------------

function Assert-UserArgument {
    param([AllowNull()][string]$Value, [string]$Name, [int]$MaximumLength)
    if ($null -eq $Value -or $Value.Length -eq 0) {
        Write-Line ('REFUSED: INVALID_ARGUMENT ' + $Name + ' is required')
        return $false
    }
    if ($Value.Length -gt $MaximumLength) {
        Write-Line ('REFUSED: INVALID_ARGUMENT ' + $Name + ' is longer than ' + [string]$MaximumLength + ' characters')
        return $false
    }
    if ($Value -cne $Value.Trim()) {
        Write-Line ('REFUSED: INVALID_ARGUMENT ' + $Name + ' must not have leading/trailing whitespace')
        return $false
    }
    if ($Value -match '[\x00-\x1F\x7F]') {
        Write-Line ('REFUSED: INVALID_ARGUMENT ' + $Name + ' contains control characters')
        return $false
    }
    return $true
}

function Get-NormalizedEmail {
    param([AllowNull()][string]$RawEmail)
    if ($null -eq $RawEmail) {
        Write-Line 'REFUSED: INVALID_EMAIL an email address is required'
        return $null
    }
    $value = $RawEmail.Trim().ToLowerInvariant()
    if ($value.Length -eq 0 -or $value.Length -gt 254) {
        Write-Line 'REFUSED: INVALID_EMAIL email must be 1-254 characters after trim'
        return $null
    }
    $at = $value.IndexOf('@')
    if ($at -le 0 -or $at -ne $value.LastIndexOf('@') -or $at -eq $value.Length - 1) {
        Write-Line 'REFUSED: INVALID_EMAIL email format is invalid (exactly one @ with local and domain parts required)'
        return $null
    }
    $local = $value.Substring(0, $at)
    $domain = $value.Substring($at + 1)
    if ($local.Length -gt 64 -or $local.StartsWith('.') -or $local.EndsWith('.') -or $local.Contains('..')) {
        Write-Line 'REFUSED: INVALID_EMAIL email local part is invalid'
        return $null
    }
    if ($local -cnotmatch "^[a-z0-9!#$%&''*+/=?^_{|}~.-]+$") {
        Write-Line 'REFUSED: INVALID_EMAIL email local part contains unsupported characters'
        return $null
    }
    if ($domain.Length -gt 253 -or $domain.StartsWith('.') -or $domain.EndsWith('.') -or $domain.Contains('..') -or -not $domain.Contains('.')) {
        Write-Line 'REFUSED: INVALID_EMAIL email domain is invalid'
        return $null
    }
    foreach ($label in $domain.Split('.')) {
        if ($label.Length -eq 0 -or $label.Length -gt 63) {
            Write-Line 'REFUSED: INVALID_EMAIL email domain label length is invalid'
            return $null
        }
        if ($label.StartsWith('-') -or $label.EndsWith('-')) {
            Write-Line 'REFUSED: INVALID_EMAIL email domain label must not start or end with a hyphen'
            return $null
        }
        if ($label -cnotmatch '^[a-z0-9-]+$') {
            Write-Line 'REFUSED: INVALID_EMAIL email domain label contains unsupported characters'
            return $null
        }
    }
    return $value
}

function New-PlannedVerifiedAt {
    return [DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss.ffffff', [System.Globalization.CultureInfo]::InvariantCulture)
}

# ---------------------------------------------------------------------------
# Read-only queries (server-side prepared statements, hex-bound values)
# ---------------------------------------------------------------------------

function Get-UserRowById {
    param([string]$Database, [string]$Id)
    $statements = @(
        ('SET @p_id = ' + (New-HexLiteral $Id)),
        "PREPARE stmt_user FROM 'SELECT id, username, email, CAST(email_verified_at AS CHAR), enabled FROM app_user WHERE id = ?'",
        'EXECUTE stmt_user USING @p_id',
        'DEALLOCATE PREPARE stmt_user'
    )
    $result = Invoke-Sql -Database $Database -Statements $statements
    Assert-SqlSucceeded -Result $result -Operation 'read app_user row'
    $rows = @(ConvertTo-ResultRows -StdOut $result.StdOut)
    if ($rows.Count -eq 0) { return $null }
    if ($rows.Count -gt 1) { throw 'primary-key lookup returned more than one row' }
    $cells = @($rows[0])
    return [pscustomobject]@{
        Id              = ConvertFrom-MysqlBatchCell $cells[0]
        Username        = ConvertFrom-MysqlBatchCell $cells[1]
        Email           = ConvertFrom-MysqlBatchCell $cells[2]
        EmailVerifiedAt = ConvertFrom-MysqlBatchCell $cells[3]
        Enabled         = ConvertFrom-MysqlBatchCell $cells[4]
    }
}

function Get-EmailOwnerId {
    param([string]$Database, [string]$NormalizedEmail, [string]$ExcludeUserId)
    $statements = @(
        ('SET @p_email = ' + (New-HexLiteral $NormalizedEmail)),
        ('SET @p_exclude = ' + (New-HexLiteral $ExcludeUserId)),
        "PREPARE stmt_email FROM 'SELECT id FROM app_user WHERE email = ? AND id <> ?'",
        'EXECUTE stmt_email USING @p_email, @p_exclude',
        'DEALLOCATE PREPARE stmt_email'
    )
    $result = Invoke-Sql -Database $Database -Statements $statements
    Assert-SqlSucceeded -Result $result -Operation 'check email uniqueness'
    $rows = @(ConvertTo-ResultRows -StdOut $result.StdOut)
    if ($rows.Count -eq 0) { return $null }
    return ConvertFrom-MysqlBatchCell (@($rows[0])[0])
}

# ---------------------------------------------------------------------------
# Binding decision (read-only): shared by preview and apply
# ---------------------------------------------------------------------------

function Get-BindDecision {
    param([string]$Database, [string]$UserId, [string]$ExpectedUsername, [string]$NormalizedEmail)
    $row = Get-UserRowById -Database $Database -Id $UserId
    if ($null -eq $row) {
        return [pscustomobject]@{ Action = 'REFUSE'; ExitCode = $script:ExitIdentityMismatch; Code = 'USER_NOT_FOUND'; Message = ('no app_user row exists for id ' + $UserId); Row = $null }
    }
    if ($row.Id -cne $UserId) {
        return [pscustomobject]@{ Action = 'REFUSE'; ExitCode = $script:ExitIdentityMismatch; Code = 'USER_ID_MISMATCH'; Message = 'the matched row id is not exactly the requested UserId'; Row = $null }
    }
    if ($row.Username -cne $ExpectedUsername) {
        return [pscustomobject]@{ Action = 'REFUSE'; ExitCode = $script:ExitIdentityMismatch; Code = 'USERNAME_MISMATCH'; Message = 'the account username is not exactly the requested ExpectedUsername'; Row = $row }
    }
    if ($null -ne $row.Email) {
        if ($row.Email -ceq $NormalizedEmail) {
            return [pscustomobject]@{ Action = 'NO_OP'; ExitCode = $script:ExitOk; Code = 'ALREADY_BOUND_SAME'; Message = 'the account is already bound to the same normalized email'; Row = $row }
        }
        return [pscustomobject]@{ Action = 'REFUSE'; ExitCode = $script:ExitEmailBound; Code = 'EMAIL_ALREADY_BOUND'; Message = 'the account already has a different email bound; refusing to overwrite it'; Row = $row }
    }
    $ownerId = Get-EmailOwnerId -Database $Database -NormalizedEmail $NormalizedEmail -ExcludeUserId $UserId
    if ($null -ne $ownerId) {
        return [pscustomobject]@{ Action = 'REFUSE'; ExitCode = $script:ExitEmailTaken; Code = 'EMAIL_TAKEN'; Message = ('the normalized email is already used by another account (' + $ownerId + ')'); Row = $null }
    }
    return [pscustomobject]@{ Action = 'BIND'; ExitCode = $script:ExitOk; Code = 'WOULD_BIND'; Message = 'the account is unbound and the normalized email is unique'; Row = $row }
}

# ---------------------------------------------------------------------------
# Apply: one atomic conditional UPDATE + read-back verification
# ---------------------------------------------------------------------------

function Invoke-BindApply {
    param([string]$Database, [string]$UserId, [string]$ExpectedUsername, [string]$NormalizedEmail, [string]$PlannedVerifiedAt)
    $statements = @(
        ('SET @p_email = ' + (New-HexLiteral $NormalizedEmail)),
        ('SET @p_verified = ' + (New-HexLiteral $PlannedVerifiedAt)),
        ('SET @p_id = ' + (New-HexLiteral $UserId)),
        ('SET @p_username = ' + (New-HexLiteral $ExpectedUsername)),
        "PREPARE stmt_update FROM 'UPDATE app_user SET email = ?, email_verified_at = ? WHERE id = ? AND username = ? AND email IS NULL'",
        'EXECUTE stmt_update USING @p_email, @p_verified, @p_id, @p_username',
        'SELECT ROW_COUNT()',
        'DEALLOCATE PREPARE stmt_update',
        "PREPARE stmt_readback FROM 'SELECT id, username, email, CAST(email_verified_at AS CHAR) FROM app_user WHERE id = ?'",
        'EXECUTE stmt_readback USING @p_id',
        'DEALLOCATE PREPARE stmt_readback'
    )
    $result = Invoke-Sql -Database $Database -Statements $statements
    if ($null -eq $result) { throw 'mysql client returned no result' }
    if ($result.ExitCode -ne 0) {
        $errorText = [string]$result.StdErr
        if ($errorText -match 'Duplicate entry|error 1062|Error 1062') {
            Write-Line 'REFUSED: EMAIL_TAKEN the normalized email was taken by another account during the update (unique key)'
            return [pscustomobject]@{ ExitCode = $script:ExitEmailTaken }
        }
        Assert-SqlSucceeded -Result $result -Operation 'conditional email update'
    }
    $rows = @(ConvertTo-ResultRows -StdOut $result.StdOut)
    if ($rows.Count -lt 1) { throw 'the conditional update did not report ROW_COUNT()' }
    $affectedText = [string](@($rows[0])[0])
    $affected = 0
    if (-not [int]::TryParse($affectedText, [ref]$affected)) { throw ('unexpected ROW_COUNT() value: ' + $affectedText) }

    if ($affected -ne 1) {
        $row = Get-UserRowById -Database $Database -Id $UserId
        if ($null -eq $row) {
            Write-Line 'REFUSED: USER_NOT_FOUND the account row disappeared during the update'
            return [pscustomobject]@{ ExitCode = $script:ExitIdentityMismatch }
        }
        if ($row.Username -cne $ExpectedUsername) {
            Write-Line 'REFUSED: USERNAME_MISMATCH the username changed during the update'
            return [pscustomobject]@{ ExitCode = $script:ExitIdentityMismatch }
        }
        if ($null -ne $row.Email -and $row.Email -ceq $NormalizedEmail) {
            Write-Line '[ALREADY_BOUND] the account is already bound to the same normalized email (concurrent no-op)'
            Write-Line 'DB_RESULT=NO_OP'
            return [pscustomobject]@{ ExitCode = $script:ExitOk }
        }
        if ($null -ne $row.Email) {
            Write-Line 'REFUSED: EMAIL_ALREADY_BOUND the account already has a different email bound'
            return [pscustomobject]@{ ExitCode = $script:ExitEmailBound }
        }
        throw 'the conditional update affected no row although the account still looks eligible'
    }

    if ($rows.Count -ne 2) { throw 'the read-back did not return exactly one row' }
    $cells = @($rows[1])
    $readBackId = ConvertFrom-MysqlBatchCell $cells[0]
    $readBackEmail = ConvertFrom-MysqlBatchCell $cells[2]
    $readBackVerifiedAt = ConvertFrom-MysqlBatchCell $cells[3]
    if ($readBackId -cne $UserId) { throw 'read-back id does not match the updated account' }
    if ($readBackEmail -cne $NormalizedEmail) { throw 'read-back email does not equal the normalized email' }
    if ($readBackVerifiedAt -cne $PlannedVerifiedAt) {
        throw ('read-back email_verified_at ''' + [string]$readBackVerifiedAt + ''' does not equal the planned value ''' + $PlannedVerifiedAt + '''')
    }
    Write-Line '[VERIFIED] read-back email and email_verified_at match the planned change'
    return [pscustomobject]@{ ExitCode = $script:ExitOk }
}

# ---------------------------------------------------------------------------
# Main (preview / apply)
# ---------------------------------------------------------------------------

function Invoke-Main {
    $script:DbSettings = Read-DbSettings
    $mode = 'preview'
    if ($Apply) { $mode = 'apply' }
    Write-Line ('bind-legacy-email mode=' + $mode)
    Write-Line ('target host=' + $script:DbSettings.Host + ' port=' + [string]$script:DbSettings.Port + ' database=' + $script:DbSettings.Database + ' user=' + $script:DbSettings.UserName)

    if (-not (Assert-UserArgument -Value $UserId -Name '-UserId' -MaximumLength 64)) { return $script:ExitInvalidInput }
    if (-not (Assert-UserArgument -Value $ExpectedUsername -Name '-ExpectedUsername' -MaximumLength 128)) { return $script:ExitInvalidInput }
    $normalizedEmail = Get-NormalizedEmail -RawEmail $Email
    if ($null -eq $normalizedEmail) { return $script:ExitInvalidInput }
    $plannedVerifiedAt = New-PlannedVerifiedAt

    $decision = Get-BindDecision -Database $script:DbSettings.Database -UserId $UserId -ExpectedUsername $ExpectedUsername -NormalizedEmail $normalizedEmail
    if ($decision.Action -ceq 'REFUSE') {
        Write-Line ('REFUSED: ' + $decision.Code + ' ' + $decision.Message)
        return $decision.ExitCode
    }
    if ($decision.Action -ceq 'NO_OP') {
        Write-Line '[ALREADY_BOUND] the account is already bound to the same normalized email; nothing to do'
        Write-Line ('email=' + $normalizedEmail + ' emailVerifiedAt=' + [string]$decision.Row.EmailVerifiedAt)
        Write-Line 'DB_RESULT=NO_OP'
        if (-not $Apply) { Write-Line 'PREVIEW_ONLY no rows changed' }
        return $script:ExitOk
    }

    if (-not $Apply) {
        Write-Line ('[WOULD_BIND] userId=' + $UserId + ' username=' + $ExpectedUsername + ' email=' + $normalizedEmail + ' emailVerifiedAt=' + $plannedVerifiedAt)
        Write-Line 'DB_RESULT=PLANNED'
        Write-Line 'PREVIEW_ONLY no rows changed'
        return $script:ExitOk
    }

    Write-Line ('[PLANNED] userId=' + $UserId + ' username=' + $ExpectedUsername + ' email=' + $normalizedEmail + ' emailVerifiedAt=' + $plannedVerifiedAt)
    $applyResult = Invoke-BindApply -Database $script:DbSettings.Database -UserId $UserId -ExpectedUsername $ExpectedUsername -NormalizedEmail $normalizedEmail -PlannedVerifiedAt $plannedVerifiedAt
    if ($applyResult.ExitCode -eq $script:ExitOk) {
        Write-Line ('[APPLIED] userId=' + $UserId + ' email=' + $normalizedEmail + ' emailVerifiedAt=' + $plannedVerifiedAt)
        Write-Line 'DB_RESULT=BOUND'
    }
    return $applyResult.ExitCode
}

# ---------------------------------------------------------------------------
# Self-test (test-only): one disposable schema, real child invocations
# ---------------------------------------------------------------------------

function Assert-SelfTestTrue {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-SelfTestEqual {
    param($Expected, $Actual, [string]$Message)
    if ([string]$Expected -cne [string]$Actual) {
        throw ($Message + ' (expected ''' + [string]$Expected + ''', actual ''' + [string]$Actual + ''')')
    }
}

function Assert-SelfTestContains {
    param([string]$Text, [string]$Needle, [string]$Message)
    if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw ($Message + ' (missing ''' + $Needle + ''' in: ' + $Text + ')')
    }
}

function Assert-SelfTestNotContains {
    param([string]$Text, [string]$Needle, [string]$Message)
    if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0) {
        throw ($Message + ' (unexpected ''' + $Needle + ''')')
    }
}

function Invoke-SelfTestChild {
    param([string[]]$ChildArguments)
    $hostExecutable = (Get-Process -Id $PID).Path
    $raw = @()
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $raw = & $hostExecutable -NoProfile -File $PSCommandPath @ChildArguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $stdout = New-Object System.Text.StringBuilder
    $stderr = New-Object System.Text.StringBuilder
    foreach ($item in @($raw)) {
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            [void]$stderr.AppendLine([string]$item)
        } else {
            [void]$stdout.AppendLine([string]$item)
        }
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        StdOut   = $stdout.ToString()
        StdErr   = $stderr.ToString()
    }
}

function Invoke-SelfTestSql {
    param([AllowNull()][string]$Database, [string[]]$Statements)
    $result = Invoke-Sql -Database $Database -Statements $Statements
    if ($null -eq $result -or $result.ExitCode -ne 0) {
        Assert-SqlSucceeded -Result $result -Operation 'self-test SQL'
    }
    return $result
}

function Get-SelfTestEmailState {
    param([string]$Database, [string]$Id)
    $statements = @(
        ('SET @p_id = ' + (New-HexLiteral $Id)),
        "PREPARE stmt_state FROM 'SELECT email, CAST(email_verified_at AS CHAR) FROM app_user WHERE id = ?'",
        'EXECUTE stmt_state USING @p_id',
        'DEALLOCATE PREPARE stmt_state'
    )
    $result = Invoke-SelfTestSql -Database $Database -Statements $statements
    $rows = @(ConvertTo-ResultRows -StdOut $result.StdOut)
    if ($rows.Count -ne 1) { throw ('expected exactly one app_user row for ' + $Id) }
    $cells = @($rows[0])
    return [pscustomobject]@{
        Email           = ConvertFrom-MysqlBatchCell $cells[0]
        EmailVerifiedAt = ConvertFrom-MysqlBatchCell $cells[1]
    }
}

function Invoke-SelfTestHarness {
    $base = Read-DbSettings
    $script:DbSettings = $base
    if ($base.Database -cin @('manao_poc4', 'manao_poc4_6b')) {
        throw 'refusing to run -SelfTest with MANAO_DB_URL pointing at a running schema; use a test database such as manao_poc4_test'
    }
    if (-not (Get-Command -Name $base.Client -ErrorAction SilentlyContinue)) {
        Write-Line ('SELF_TEST=NOT_RUN mysql client ''' + $base.Client + ''' is not available on PATH')
        return $script:ExitFailure
    }

    $suffix = [guid]::NewGuid().ToString('N')
    $schema = 'manao_stage6_t8_' + $suffix
    if ($schema -cnotmatch '^manao_stage6_t8_[0-9a-f]{32}$') { throw 'generated self-test schema name is invalid' }
    $childUrl = 'jdbc:mysql://' + $base.Host + ':' + [string]$base.Port + '/' + $schema

    $script:SelfTestPass = 0
    $script:SelfTestFail = 0
    $script:SelfTestLegacyVerifiedAt = $null
    $originalUrl = Get-EnvironmentText 'MANAO_DB_URL'
    $schemaCreated = $false
    $scenarioScript = $null
    try {
        Write-Line ('SELF_TEST schema=' + $schema + ' (disposable; will be dropped)')
        [void](Invoke-SelfTestSql -Database $null -Statements @('CREATE SCHEMA ' + $schema + ' CHARACTER SET utf8mb4'))
        $schemaCreated = $true
        $createTable = 'CREATE TABLE app_user (' +
            'id VARCHAR(64) NOT NULL, ' +
            'username VARCHAR(128) NOT NULL, ' +
            'password_hash VARCHAR(255) NOT NULL, ' +
            'enabled BOOLEAN NOT NULL DEFAULT TRUE, ' +
            'created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
            'email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, ' +
            'email_verified_at TIMESTAMP(6) NULL, ' +
            'auth_version BIGINT NOT NULL DEFAULT 0, ' +
            'PRIMARY KEY (id), ' +
            'UNIQUE KEY uq_app_user_username (username), ' +
            'UNIQUE KEY uq_app_user_email (email)' +
            ') ENGINE=InnoDB'
        [void](Invoke-SelfTestSql -Database $schema -Statements @($createTable))
        $insertStatements = @(
            ('INSERT INTO app_user (id, username, password_hash, enabled, email, email_verified_at) VALUES (' + (New-HexLiteral 'u-legacy') + ', ' + (New-HexLiteral 'legacy_user') + ', ' + (New-HexLiteral 'self-test-hash') + ', TRUE, NULL, NULL)'),
            ('INSERT INTO app_user (id, username, password_hash, enabled, email, email_verified_at) VALUES (' + (New-HexLiteral 'u-bound') + ', ' + (New-HexLiteral 'bound_user') + ', ' + (New-HexLiteral 'self-test-hash') + ', TRUE, ' + (New-HexLiteral 'already@example.com') + ', ' + (New-HexLiteral '2026-01-01 00:00:00.000000') + ')'),
            ('INSERT INTO app_user (id, username, password_hash, enabled, email, email_verified_at) VALUES (' + (New-HexLiteral 'u-other') + ', ' + (New-HexLiteral 'other_user') + ', ' + (New-HexLiteral 'self-test-hash') + ', TRUE, ' + (New-HexLiteral 'taken@example.com') + ', ' + (New-HexLiteral '2026-01-02 00:00:00.000000') + ')')
        )
        [void](Invoke-SelfTestSql -Database $schema -Statements $insertStatements)

        $env:MANAO_DB_URL = $childUrl
        $scenarioScript = {
            param(
                [string]$Name,
                [string[]]$ChildArguments,
                [int]$ExpectedExit,
                [string[]]$ExpectedStdOut,
                [string[]]$ExpectedStdOutAbsent,
                [scriptblock]$After
            )
            try {
                $result = Invoke-SelfTestChild -ChildArguments $ChildArguments
                Assert-SelfTestEqual $ExpectedExit $result.ExitCode ($Name + ': exit code')
                foreach ($needle in @($ExpectedStdOut)) {
                    Assert-SelfTestContains $result.StdOut $needle ($Name + ': expected output')
                }
                foreach ($needle in @($ExpectedStdOutAbsent)) {
                    Assert-SelfTestNotContains $result.StdOut $needle ($Name + ': unexpected output')
                }
                Assert-SelfTestNotContains ($result.StdOut + $result.StdErr) 'MYSQL_PWD' ($Name + ': output must not mention MYSQL_PWD')
                Assert-SelfTestNotContains ($result.StdOut + $result.StdErr) 'MANAO_DB_PASSWORD=' ($Name + ': output must not echo the password variable')
                if ($null -ne $After) { & $After }
                Write-Line ('[PASS] ' + $Name)
                $script:SelfTestPass = $script:SelfTestPass + 1
            } catch {
                Write-Line ('[FAIL] ' + $Name + ' :: ' + $_.Exception.Message)
                $script:SelfTestFail = $script:SelfTestFail + 1
            }
        }

        & $scenarioScript -Name 'preview of an unbound legacy account plans the change and writes nothing' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', 'Legacy.New+Tag@Example.COM') -ExpectedExit 0 -ExpectedStdOut @('mode=preview', '[WOULD_BIND] userId=u-legacy username=legacy_user email=legacy.new+tag@example.com', 'DB_RESULT=PLANNED', 'PREVIEW_ONLY no rows changed') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual $null $state.Email 'preview must not bind the email'
        }

        & $scenarioScript -Name 'invalid email is rejected before any database write' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', 'not-an-email', '-Apply') -ExpectedExit 2 -ExpectedStdOut @('REFUSED: INVALID_EMAIL') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual $null $state.Email 'invalid email must not bind anything'
        }

        & $scenarioScript -Name 'wrong expected username is refused as an identity mismatch' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_USer', '-Email', 'legacy.new@example.com', '-Apply') -ExpectedExit 3 -ExpectedStdOut @('REFUSED: USERNAME_MISMATCH') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual $null $state.Email 'identity mismatch must not bind anything'
        }

        & $scenarioScript -Name 'unknown user id is refused as an identity mismatch' -ChildArguments @('-UserId', 'u-missing', '-ExpectedUsername', 'legacy_user', '-Email', 'legacy.new@example.com', '-Apply') -ExpectedExit 3 -ExpectedStdOut @('REFUSED: USER_NOT_FOUND') -ExpectedStdOutAbsent @() -After $null

        & $scenarioScript -Name 'an already bound different email is never overwritten' -ChildArguments @('-UserId', 'u-bound', '-ExpectedUsername', 'bound_user', '-Email', 'another@example.com', '-Apply') -ExpectedExit 4 -ExpectedStdOut @('REFUSED: EMAIL_ALREADY_BOUND') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-bound'
            Assert-SelfTestEqual 'already@example.com' $state.Email 'a bound email must not be overwritten'
            Assert-SelfTestEqual '2026-01-01 00:00:00.000000' $state.EmailVerifiedAt 'a bound email_verified_at must not change'
        }

        & $scenarioScript -Name 'an email owned by another account is refused' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', 'TAKEN@example.com', '-Apply') -ExpectedExit 5 -ExpectedStdOut @('REFUSED: EMAIL_TAKEN') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual $null $state.Email 'a taken email must not be bound'
        }

        & $scenarioScript -Name 'apply binds the normalized email and sets email_verified_at explicitly' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', '  Legacy.New+Tag@Example.COM  ', '-Apply') -ExpectedExit 0 -ExpectedStdOut @('[APPLIED] userId=u-legacy email=legacy.new+tag@example.com', '[VERIFIED]', 'DB_RESULT=BOUND') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual 'legacy.new+tag@example.com' $state.Email 'apply must store the normalized email'
            Assert-SelfTestTrue ($null -ne $state.EmailVerifiedAt) 'apply must set email_verified_at'
            $script:SelfTestLegacyVerifiedAt = $state.EmailVerifiedAt
        }

        & $scenarioScript -Name 're-running apply with the same value is an idempotent no-op' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', 'LEGACY.NEW+TAG@example.com', '-Apply') -ExpectedExit 0 -ExpectedStdOut @('[ALREADY_BOUND]', 'DB_RESULT=NO_OP') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual 'legacy.new+tag@example.com' $state.Email 'no-op must keep the email'
            Assert-SelfTestEqual $script:SelfTestLegacyVerifiedAt $state.EmailVerifiedAt 'no-op must not change email_verified_at'
        }

        & $scenarioScript -Name 'preview of the already bound same value reports a no-op' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', 'legacy.new+tag@example.com') -ExpectedExit 0 -ExpectedStdOut @('[ALREADY_BOUND]', 'DB_RESULT=NO_OP', 'PREVIEW_ONLY no rows changed') -ExpectedStdOutAbsent @() -After $null

        & $scenarioScript -Name 're-running apply with a different value is refused' -ChildArguments @('-UserId', 'u-legacy', '-ExpectedUsername', 'legacy_user', '-Email', 'different@example.com', '-Apply') -ExpectedExit 4 -ExpectedStdOut @('REFUSED: EMAIL_ALREADY_BOUND') -ExpectedStdOutAbsent @() -After {
            $state = Get-SelfTestEmailState -Database $schema -Id 'u-legacy'
            Assert-SelfTestEqual 'legacy.new+tag@example.com' $state.Email 'the original binding must be kept'
        }

        Write-Line ''
        Write-Line ('bind-legacy-email self-test (disposable schema ' + $schema + '): PASS=' + [string]$script:SelfTestPass + ' FAIL=' + [string]$script:SelfTestFail)
        if ($script:SelfTestFail -gt 0) { return $script:ExitFailure }
        return $script:ExitOk
    } finally {
        $env:MANAO_DB_URL = $originalUrl
        if ($schemaCreated) {
            try {
                [void](Invoke-SelfTestSql -Database $null -Statements @('DROP SCHEMA IF EXISTS ' + $schema))
                Write-Line ('SELF_TEST cleanup dropped schema ' + $schema)
            } catch {
                Write-FailureLine ('SELF_TEST cleanup failed to drop schema ' + $schema + ': ' + $_.Exception.Message)
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if ($SelfTest) {
    if ($Apply) {
        Write-FailureLine 'usage: -SelfTest cannot be combined with -Apply'
        exit $script:ExitInvalidInput
    }
    try {
        $selfTestExit = Invoke-SelfTestHarness
        exit $selfTestExit
    } catch {
        Write-FailureLine ('bind-legacy-email self-test failed: ' + $_.Exception.Message)
        exit $script:ExitFailure
    }
}

try {
    $mainExit = Invoke-Main
    exit $mainExit
} catch {
    Write-FailureLine ('bind-legacy-email: ' + $_.Exception.Message)
    exit $script:ExitFailure
}
