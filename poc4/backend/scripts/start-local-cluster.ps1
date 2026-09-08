# Stage 6A: start the local Spring Boot backend with the local-cluster profile.
# Prerequisites (operator-provided, never committed):
#   1. Local MySQL running and migrated (Flyway runs at startup).
#   2. SSH API tunnel already up (operator-controlled; the backend only consumes the forwarded endpoint).
#   3. Temporary kubeconfig with tls-server-name + CA (validated by the backend's startup preflight).
#   4. Environment values from a copy of config/local-cluster.example.env.
param(
    [Parameter(Mandatory = $true)]
    [string]$EnvFile
)

if (-not (Test-Path $EnvFile)) {
    Write-Error "Environment file not found: $EnvFile"
    exit 1
}

Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
}

Write-Host "Starting backend on http://127.0.0.1:18080 with the local-cluster profile..."
& mvn.cmd '-q' '-Dspring-boot.run.profiles=local-cluster' 'spring-boot:run'
