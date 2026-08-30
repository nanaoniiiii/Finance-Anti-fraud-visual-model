param(
    [ValidateSet("Test", "Aarch64", "All")]
    [string]$Target = "All"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$dockerfile = Join-Path $PSScriptRoot "docker\toolchain.Dockerfile"
$mount = "${repoRoot}:/workspace"

function Assert-LastExitCode([string]$operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$operation failed with exit code $LASTEXITCODE"
    }
}

function Assert-DockerReady {
    & docker info --format "{{.ServerVersion}}" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is not ready. Start Docker Desktop and retry."
    }
}

function Invoke-NativeTests {
    & docker build --target native-test -t poseguard-rk3566-test -f $dockerfile $repoRoot
    Assert-LastExitCode "native toolchain image build"

    & docker run --rm -v $mount -w /workspace poseguard-rk3566-test `
        cmake -S platforms/rk3566 -B build/rk3566-native -G Ninja `
        -DPOSEGUARD_BUILD_TESTS=ON -DPOSEGUARD_ENABLE_BOARD=OFF
    Assert-LastExitCode "native CMake configure"

    & docker run --rm -v $mount -w /workspace poseguard-rk3566-test `
        cmake --build build/rk3566-native -j2
    Assert-LastExitCode "native build"

    & docker run --rm -v $mount -w /workspace poseguard-rk3566-test `
        ctest --test-dir build/rk3566-native --output-on-failure
    Assert-LastExitCode "native tests"
}

function Invoke-Aarch64Build {
    & docker build --target aarch64-build -t poseguard-rk3566-cross -f $dockerfile $repoRoot
    Assert-LastExitCode "AArch64 toolchain image build"

    & docker run --rm -v $mount -w /workspace poseguard-rk3566-cross `
        cmake -S platforms/rk3566 -B build/rk3566-aarch64 -G Ninja `
        -DPOSEGUARD_BUILD_TESTS=OFF -DPOSEGUARD_ENABLE_BOARD=ON `
        -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 `
        -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++
    Assert-LastExitCode "AArch64 CMake configure"

    & docker run --rm -v $mount -w /workspace poseguard-rk3566-cross `
        cmake --build build/rk3566-aarch64 -j2
    Assert-LastExitCode "AArch64 build"

    & docker run --rm -v $mount -w /workspace poseguard-rk3566-cross `
        file build/rk3566-aarch64/poseguard-rk3566
    Assert-LastExitCode "AArch64 file check"
}

Assert-DockerReady

if ($Target -in @("Test", "All")) {
    Invoke-NativeTests
}
if ($Target -in @("Aarch64", "All")) {
    Invoke-Aarch64Build
}
