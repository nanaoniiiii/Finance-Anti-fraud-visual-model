param(
    [string]$HostName = "10.243.64.1",
    [string]$UserName = "root",
    [string]$RemoteDir = "/root/poseguard-maix"
)

python "$PSScriptRoot/deploy.py" `
    --host $HostName `
    --user $UserName `
    --remote-dir $RemoteDir

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
