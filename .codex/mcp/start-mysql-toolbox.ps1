$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "mysql-toolbox.env"
$toolbox = "C:\Users\shili\.codex\bin\mcp-toolbox\v1.9.0\toolbox.exe"

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "MySQL Toolbox environment file is missing: $envFile"
}

foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*(MYSQL_[A-Z_]+)=(.*)\s*$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

if (-not (Test-Path -LiteralPath $toolbox)) {
    throw "MCP Toolbox executable is missing: $toolbox"
}

& $toolbox --prebuilt mysql --stdio
exit $LASTEXITCODE
