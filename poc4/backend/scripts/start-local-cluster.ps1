# Stage 6A: start the local Spring Boot backend with the local-cluster profile.
# Prerequisites (operator-provided, never committed):
#   1. Local MySQL running and migrated (Flyway runs at startup).
#   2. SSH API tunnel already up (operator-controlled; the backend only consumes the forwarded endpoint).
#   3. Temporary kubeconfig with tls-server-name + CA (validated by the backend's startup preflight).
#   4. Environment values from a copy of config/local-cluster.example.env.
param(
    [Parameter(Mandatory = $true)]
    [string]$EnvFile,
    [switch]$Restart
)

if (-not (Test-Path $EnvFile)) {
    Write-Error "Environment file not found: $EnvFile"
    exit 1
}

if ($Restart) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $listenPort = 18080
    $wrapperDir = 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.14\ed7edd442f634ac1c1ef5ba2b61b6d690b5221091f1a8e1123f5fadcc967520d\bin'
    $backendDir = Split-Path -Parent $PSScriptRoot
    function Get-ListenPid {
        param([int]$Port)
        $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if ($conns.Count -gt 0) {
            return [int]$conns[0].OwningProcess
        }
        $line = netstat -ano | Select-String -Pattern (":$Port\s+\S+\s+LISTENING") | Select-Object -First 1
        if ($null -ne $line -and ($line.Line -match '\s(\d+)\s*$')) {
            return [int]$Matches[1]
        }
        return $null
    }
    $listenPid = Get-ListenPid -Port $listenPort
    if ($null -eq $listenPid) {
        throw 'BACKEND_PID_NOT_FOUND'
    }
    $row = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listenPid) -ErrorAction SilentlyContinue
    $commandLine = if ($null -eq $row) { '' } else { [string]$row.CommandLine }
    $knownBackend = ($commandLine -match 'spring-boot:run') -or
        ($commandLine -match 'manao-poc4-backend') -or
        ($commandLine -match 'com\.manao\.poc4\.Poc4BackendApplication')
    if (-not $knownBackend) {
        throw 'BACKEND_PID_REFUSED'
    }
    Write-Host ("Stopping backend PID " + $listenPid)
    Stop-Process -Id $listenPid -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq (Get-ListenPid -Port $listenPort)) {
            break
        }
        Start-Sleep -Seconds 1
    }
    if ($null -ne (Get-ListenPid -Port $listenPort)) {
        throw 'BACKEND_PORT_STILL_BOUND'
    }
    if (Test-Path -LiteralPath $wrapperDir) {
        $env:Path = $wrapperDir + ';' + $env:Path
    }
    Write-Host 'Starting backend via start-local-cluster.ps1'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-EnvFile', $EnvFile) `
        -WorkingDirectory $backendDir `
        -WindowStyle Hidden | Out-Null
    $healthDeadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $healthDeadline) {
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:18080/actuator/health' -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                Write-Host 'Backend healthy on 18080'
                exit 0
            }
        } catch {
        }
        try {
            Invoke-WebRequest -Uri 'http://127.0.0.1:18080/api/v1/projects' -UseBasicParsing -TimeoutSec 3 | Out-Null
        } catch {
            $status = 0
            if ($_.Exception.Response) {
                $status = [int]$_.Exception.Response.StatusCode
            }
            if ($status -eq 401 -or $status -eq 200) {
                Write-Host 'Backend healthy on 18080'
                exit 0
            }
        }
        Start-Sleep -Seconds 2
    }
    throw 'BACKEND_HEALTH_TIMEOUT'
}

Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
}

$backendHome = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $backendHome 'target\stage6-local-cluster.log'
New-Item -ItemType Directory -Force -Path (Join-Path $backendHome 'target') | Out-Null
$env:LOGGING_FILE_NAME = $logFile
Write-Host "Starting backend on http://127.0.0.1:18080 with the local-cluster profile..."
Write-Host ("logging.file.name=" + $logFile)
$logArg = '-Dspring-boot.run.jvmArguments=-Dlogging.file.name=' + ($logFile -replace '\\', '/')
$javaHome = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.16.8-hotspot'
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    if (Test-Path -LiteralPath (Join-Path $javaHome 'bin\java.exe')) {
        $env:JAVA_HOME = $javaHome
    }
}
if ($env:JAVA_HOME) {
    $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
}
$wrapperDir = 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.14\ed7edd442f634ac1c1ef5ba2b61b6d690b5221091f1a8e1123f5fadcc967520d\bin'
if (Test-Path -LiteralPath $wrapperDir) {
    $env:Path = $wrapperDir + ';' + $env:Path
}
& mvn.cmd '-q' '-Dspring-boot.run.profiles=local-cluster' $logArg 'spring-boot:run'
