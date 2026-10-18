# Publishes this folder to https://github.com/payfresco/claude-plugin (the repo already exists, empty).
# Right-click this file > Run with PowerShell (or run it from a terminal in this folder).
Set-Location $PSScriptRoot
if (-not (Test-Path .git)) { git init -b main | Out-Null }
git add -A
git commit -m "Initial release: Claude plugin + MCP connector" 2>$null
git remote remove origin 2>$null
git remote add origin https://github.com/payfresco/claude-plugin.git
git push -u origin main
Write-Host "Done: https://github.com/payfresco/claude-plugin"
