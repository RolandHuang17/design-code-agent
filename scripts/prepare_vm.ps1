param(
    [string]$IsoPath = 'D:\projects\Task\.local\vm\Windows11-Enterprise-Evaluation-zh-cn.iso',
    [string]$MachineName = 'DesignCodeAgent-Clean-Windows',
    [string]$VmDirectory = 'D:\projects\Task\.local\vm\machines'
)
$ErrorActionPreference = 'Stop'
$VBox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path -LiteralPath $VBox)) { throw 'Install the official VirtualBox base package first; Extension Pack is not needed.' }
$iso = (Resolve-Path -LiteralPath $IsoPath).Path
if ($MachineName -ne 'DesignCodeAgent-Clean-Windows') { throw 'This script only manages the fixed acceptance VM name.' }
$root = [IO.Path]::GetFullPath($VmDirectory)
if (-not $root.StartsWith('D:\projects\Task\.local\vm\', [StringComparison]::OrdinalIgnoreCase)) { throw 'VM directory is outside the intended workspace.' }
$existing = & $VBox list vms
if ($LASTEXITCODE -ne 0) { throw 'Cannot list existing VMs; stopping to preserve existing machines.' }
if ($existing | Where-Object { $_.StartsWith('"' + $MachineName + '" ') }) { throw 'Acceptance VM already exists; refusing to overwrite.' }
New-Item -ItemType Directory -Force -Path $root | Out-Null
& $VBox createvm --name $MachineName --platform-architecture x86 --ostype Windows11_64 --basefolder $root --register
if ($LASTEXITCODE -ne 0) { throw 'VM creation failed.' }
& $VBox modifyvm $MachineName --memory 4096 --cpus 2 --firmware efi --tpm-type 2.0 --graphicscontroller vboxsvga --vram 128 --nic1 nat --mouse usbtablet --keyboard usb --usb-xhci on --clipboard-mode disabled --drag-and-drop disabled
if ($LASTEXITCODE -ne 0) { throw 'VM configuration failed.' }
$disk = Join-Path (Join-Path $root $MachineName) 'Windows.vdi'
& $VBox createmedium disk --filename $disk --size 81920 --format VDI
if ($LASTEXITCODE -ne 0) { throw 'Virtual disk creation failed.' }
& $VBox storagectl $MachineName --name SATA --add sata --controller IntelAhci
if ($LASTEXITCODE -ne 0) { throw 'Storage controller creation failed.' }
& $VBox storageattach $MachineName --storagectl SATA --port 0 --device 0 --type hdd --medium $disk
if ($LASTEXITCODE -ne 0) { throw 'Virtual disk attachment failed.' }
& $VBox storageattach $MachineName --storagectl SATA --port 1 --device 0 --type dvddrive --medium $iso
if ($LASTEXITCODE -ne 0) { throw 'Installation media attachment failed.' }
Write-Output 'VM prepared. User handles OS licensing and account setup. Do not install Python/Node/Docker before the clean snapshot.'
