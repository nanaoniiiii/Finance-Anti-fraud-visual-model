param(
    [string]$BoardHost = "192.168.31.230",
    [string]$User = "root",
    [string]$IdentityFile = (Join-Path $env:USERPROFILE ".ssh\id_ed25519"),
    [string]$BinaryPath = "",
    [string]$ModelPath = "",
    [string]$VideoPath = "",
    [string]$ConfigPath = "",
    [string]$RuntimePath = "",
    [switch]$SkipService
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $BinaryPath) {
    $standardBinary = Join-Path $repoRoot "build\rk3566-aarch64\poseguard-rk3566"
    $portableBinary = Join-Path $repoRoot "build\rk3566-aarch64-board-objects\poseguard-rk3566"
    $BinaryPath = if (Test-Path $standardBinary) { $standardBinary } else { $portableBinary }
}
if (-not $ModelPath) {
    $ModelPath = Join-Path $PSScriptRoot "artifacts\model\poseguard-yolo11n-pose-320-int8.rknn"
}
if (-not $VideoPath) {
    $VideoPath = Join-Path $PSScriptRoot "media\yoga-regression.mp4"
}
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot "config\poseguard.conf"
}
$servicePath = Join-Path $PSScriptRoot "service\S99poseguard"
$runnerPath = Join-Path $PSScriptRoot "service\poseguard-run"

foreach ($path in @($IdentityFile, $BinaryPath, $ModelPath, $VideoPath, $ConfigPath, $servicePath, $runnerPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required deployment file not found: $path"
    }
}

$target = "${User}@${BoardHost}"
if ($RuntimePath -and -not (Test-Path -LiteralPath $RuntimePath -PathType Leaf)) {
    throw "Runtime library not found: $RuntimePath"
}
$sshBase = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-i", $IdentityFile)
$remoteRoot = "/userdata/poseguard"

function Invoke-Ssh([string]$command) {
    & ssh @sshBase $target $command
    if ($LASTEXITCODE -ne 0) {
        throw "SSH command failed with exit code $LASTEXITCODE"
    }
}

function Install-Atomic([string]$localPath, [string]$remotePath, [string]$mode) {
    $newPath = "$remotePath.new"
    & scp @sshBase $localPath "${target}:$newPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Upload failed: $localPath"
    }

    $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLowerInvariant()
    $remoteHash = (& ssh @sshBase $target "sha256sum '$newPath' | cut -d ' ' -f 1").Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $localHash -ne $remoteHash) {
        throw "SHA-256 mismatch for $remotePath"
    }

    $leaf = Split-Path $remotePath -Leaf
    Invoke-Ssh "if [ -f '$remotePath' ]; then cp -p '$remotePath' '$remoteRoot/backup/previous/$leaf'; fi; mv '$newPath' '$remotePath'; chmod '$mode' '$remotePath'"
    Write-Host "[deploy] $remotePath  sha256=$localHash"
}

Invoke-Ssh "mkdir -p '$remoteRoot/bin' '$remoteRoot/lib' '$remoteRoot/models' '$remoteRoot/config' '$remoteRoot/media' '$remoteRoot/runs' '$remoteRoot/logs' '$remoteRoot/service' '$remoteRoot/backup'; rm -rf '$remoteRoot/backup/previous'; mkdir -p '$remoteRoot/backup/previous'"

if (-not $SkipService) {
    Invoke-Ssh "if [ -x /etc/init.d/S99poseguard ]; then /etc/init.d/S99poseguard stop; fi"
}
Install-Atomic $BinaryPath "$remoteRoot/bin/poseguard-rk3566" "0755"
Install-Atomic $runnerPath "$remoteRoot/bin/poseguard-run" "0755"
if ($RuntimePath) {
    Install-Atomic $RuntimePath "$remoteRoot/lib/librknnrt.so" "0644"
}
Install-Atomic $ModelPath "$remoteRoot/models/poseguard-yolo11n-pose-320-int8.rknn" "0644"
Install-Atomic $ConfigPath "$remoteRoot/config/poseguard.conf" "0644"
Install-Atomic $VideoPath "$remoteRoot/media/yoga-regression.mp4" "0644"
Install-Atomic $servicePath "$remoteRoot/service/S99poseguard" "0755"
Invoke-Ssh "touch '$remoteRoot/runs/events.jsonl' '$remoteRoot/logs/poseguard.log'; sync"

if (-not $SkipService) {
    Invoke-Ssh "install -m 0755 '$remoteRoot/service/S99poseguard' /etc/init.d/S99poseguard; /etc/init.d/S99poseguard restart; sleep 2; /etc/init.d/S99poseguard status"
}

Write-Host "[deploy] Complete. Web UI: http://${BoardHost}:8081/"
