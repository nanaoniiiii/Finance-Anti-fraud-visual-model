param(
    [Parameter(Mandatory = $true)][string]$Serial,
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [ValidateRange(1024, 65535)][int]$LocalPort = 18081,
    [switch]$SkipClockSync
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Invoke-Adb([string[]]$Arguments) {
    if ($Arguments[0] -eq 'shell') {
        $marker = 'POSEGUARD_EXIT_' + [guid]::NewGuid().ToString('N') + '='
        $command = '( ' + $Arguments[1] + ' ); pg_exit=$?; printf "\n' + $marker + '%s\n" "$pg_exit"'
        $lines = & adb -s $Serial shell $command
        if ($LASTEXITCODE -ne 0) { throw 'ADB transport failed' }
        $responseText = ($lines -join "`n").Replace("`r", '')
        $match = [regex]::Match($responseText, [regex]::Escape($marker) + '(\d+)')
        if (-not $match.Success) { throw 'Board did not return an exit status' }
        Write-Output ($responseText.Substring(0, $match.Index).Trim())
        if ($match.Groups[1].Value -ne '0') { throw "Board operation failed (exit $($match.Groups[1].Value))" }
        return
    }
    & adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "ADB operation failed (exit $LASTEXITCODE)" }
}
$bundle = (Get-Item -LiteralPath $BundlePath).FullName
$nonce = [guid]::NewGuid().ToString('N')
$remoteArchive = "/userdata/poseguard-upload-$nonce.tar"
$remoteStage = "/userdata/poseguard-stage-$nonce"
Invoke-Adb @('get-state')
$architecture = (& adb -s $Serial shell uname -m).Trim()
if ($LASTEXITCODE -ne 0 -or $architecture -ne 'aarch64') { throw 'Target is not AArch64 Linux' }
if (-not $SkipClockSync) {
    $utc = [DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    Invoke-Adb @('shell', "date -u -s '$utc' && if [ -c /dev/rtc0 ]; then hwclock -w -u; fi")
}
$upload = $bundle
$temporaryTar = $null
if ($bundle.EndsWith('.gz', [StringComparison]::OrdinalIgnoreCase)) {
    # Minimal Buildroot tar may have no gzip support. Decompress on the PC.
    $temporaryTar = Join-Path ([IO.Path]::GetTempPath()) "poseguard-$nonce.tar"
    $inputStream = [IO.File]::OpenRead($bundle)
    $gzipStream = [IO.Compression.GZipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress)
    $outputStream = [IO.File]::Create($temporaryTar)
    try { $gzipStream.CopyTo($outputStream) } finally {
        $outputStream.Dispose()
        $gzipStream.Dispose()
        $inputStream.Dispose()
    }
    $upload = $temporaryTar
}
$expected = (Get-FileHash -LiteralPath $upload -Algorithm SHA256).Hash.ToLowerInvariant()
try { Invoke-Adb @('push', $upload, $remoteArchive) } finally {
    if ($temporaryTar) { Remove-Item -LiteralPath $temporaryTar -Force }
}
$actual = ((& adb -s $Serial shell "sha256sum '$remoteArchive'") -split '\s+')[0].ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $expected -ne $actual) { throw 'Uploaded bundle SHA-256 mismatch' }
Invoke-Adb @('shell', "mkdir -p '$remoteStage' && tar -xf '$remoteArchive' -C '$remoteStage' && sh '$remoteStage/poseguard-rk3566/install.sh'")
Invoke-Adb @('forward', "tcp:$LocalPort", 'tcp:8081')
Write-Host "Installed. Preview: http://127.0.0.1:$LocalPort/"
Write-Host "Staging and archive retained for recovery: $remoteStage, $remoteArchive"
