param(
    [ValidateSet("Export", "Prepare", "Convert", "Compare", "All")]
    [string]$Action = "All",
    [Parameter(Mandatory = $true)]
    [string]$SourceModel,
    [Parameter(Mandatory = $true)]
    [string]$SourceVideo
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$modelSource = Get-Item -LiteralPath $SourceModel
$videoSource = Get-Item -LiteralPath $SourceVideo
$dockerfile = Join-Path $PSScriptRoot "docker\model.Dockerfile"
$artifactRoot = Join-Path $PSScriptRoot "artifacts\model"
$calibrationDir = Join-Path $artifactRoot "calibration"
$comparisonDir = Join-Path $artifactRoot "comparison"
$mediaDir = Join-Path $PSScriptRoot "media"
$onnxPath = Join-Path $artifactRoot "poseguard-yolo11n-pose-320.onnx"
$rknnPath = Join-Path $artifactRoot "poseguard-yolo11n-pose-320-int8.rknn"
$reportPath = Join-Path $artifactRoot "comparison-report.json"
$regressionVideo = Join-Path $mediaDir "yoga-regression.mp4"

New-Item -ItemType Directory -Force -Path $artifactRoot, $mediaDir | Out-Null

function Assert-LastExitCode([string]$operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$operation failed with exit code $LASTEXITCODE"
    }
}

& docker info --format "{{.ServerVersion}}" *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not ready. Enable VirtualMachinePlatform, reboot, and start Docker Desktop."
}

& docker build -t poseguard-rk3566-model -f $dockerfile $repoRoot
Assert-LastExitCode "model image build"

$mounts = @(
    "--mount", "type=bind,source=$repoRoot,target=/workspace",
    "--mount", "type=bind,source=$($modelSource.DirectoryName),target=/source-model,readonly",
    "--mount", "type=bind,source=$($videoSource.DirectoryName),target=/source-video,readonly"
)

function Invoke-ModelContainer([string[]]$Command) {
    & docker run --rm @mounts poseguard-rk3566-model @Command
    Assert-LastExitCode "model container command"
}

if ($Action -in @("Export", "All")) {
    Invoke-ModelContainer @(
        "python", "-m", "platforms.rk3566.tools.export_pose_onnx",
        "--model", "/source-model/$($modelSource.Name)",
        "--output", "/workspace/platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320.onnx"
    )
}

if ($Action -in @("Prepare", "All")) {
    Invoke-ModelContainer @(
        "ffmpeg", "-y", "-i", "/source-video/$($videoSource.Name)",
        "-vf", "crop=960:540:210:215,fps=30,scale=960:540",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "/workspace/platforms/rk3566/media/yoga-regression.mp4"
    )
    Invoke-ModelContainer @(
        "python", "-m", "platforms.rk3566.tools.prepare_inputs",
        "--video", "/workspace/platforms/rk3566/media/yoga-regression.mp4",
        "--output-dir", "/workspace/platforms/rk3566/artifacts/model/calibration",
        "--comparison-dir", "/workspace/platforms/rk3566/artifacts/model/comparison",
        "--count", "40"
    )
}

if ($Action -in @("Convert", "All")) {
    Invoke-ModelContainer @(
        "python", "-m", "platforms.rk3566.tools.convert_pose_rknn",
        "--onnx", "/workspace/platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320.onnx",
        "--dataset", "/workspace/platforms/rk3566/artifacts/model/calibration/dataset.txt",
        "--output", "/workspace/platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320-int8.rknn"
    )
}

if ($Action -in @("Compare", "All")) {
    Invoke-ModelContainer @(
        "python", "-m", "platforms.rk3566.tools.compare_outputs",
        "--onnx", "/workspace/platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320.onnx",
        "--rknn", "/workspace/platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320-int8.rknn",
        "--dataset", "/workspace/platforms/rk3566/artifacts/model/calibration/dataset.txt",
        "--images", "/workspace/platforms/rk3566/artifacts/model/comparison",
        "--report", "/workspace/platforms/rk3566/artifacts/model/comparison-report.json"
    )
}

Write-Output "ONNX: $onnxPath"
Write-Output "RKNN: $rknnPath"
Write-Output "Regression video: $regressionVideo"
Write-Output "Comparison report: $reportPath"
