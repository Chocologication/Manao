# Stage 6A: stop the local backend and every workspace port-forward child it spawned.
# Workspace bridges are killed by the backend's shutdown hook; this script stops any leftovers.
Write-Host "Stopping local Spring Boot backend..."
Get-Process -Name java -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'spring-boot:run' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Stopping leftover kubectl port-forward processes (workspace bridges and backend service)..."
Get-Process -Name kubectl -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'port-forward' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Done. The SSH API tunnel itself is operator-managed and is NOT stopped by this script."
