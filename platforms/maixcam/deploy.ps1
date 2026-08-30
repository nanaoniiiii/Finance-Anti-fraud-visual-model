param(
    [string]$HostName = "192.168.31.114",
    [string]$UserName = "root",
    [string]$RemoteDir = "/root/poseguard_maix"
)

python "$PSScriptRoot/deploy.py" `
    --host $HostName `
    --user $UserName `
    --remote-dir $RemoteDir

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
