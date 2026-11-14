param(
    [string]$Server = 'https://poseguard.nanaoni.tech',
    [string]$Config = '.secrets/windows-cloud.json'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$python = Join-Path $root '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }
$code = Read-Host '输入网页端生成的 Windows 一次性绑定码'
& $python -m poseguard.cloud.edge enroll --server $Server --code $code --platform windows --config $Config
if ($LASTEXITCODE -ne 0) { throw '设备绑定未完成' }
Write-Host '绑定完成。启动摄像头：'
Write-Host "$python -m poseguard.app --source 0 --cloud-config $Config"
