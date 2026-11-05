param(
    [string]$IsoPath = 'D:\projects\Task\.local\vm\Windows11-Enterprise-Evaluation-zh-cn.iso',
    [string]$MachineName = 'DesignCodeAgent-Clean-Windows',
    [string]$VmDirectory = 'D:\projects\Task\.local\vm\machines'
)
$ErrorActionPreference = 'Stop'
$VBox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path -LiteralPath $VBox)) { throw '请先完成已下载的官方 VirtualBox 基础安装；不要安装 Extension Pack。' }
$iso = (Resolve-Path -LiteralPath $IsoPath).Path
if ($MachineName -ne 'DesignCodeAgent-Clean-Windows') { throw '此脚本只管理本次验收的固定机器名。' }
$root = [IO.Path]::GetFullPath($VmDirectory)
if (-not $root.StartsWith('D:\projects\Task\.local\vm\', [StringComparison]::OrdinalIgnoreCase)) { throw '虚拟机目录越界。' }
$existing = & $VBox list vms
if ($LASTEXITCODE -ne 0) { throw '无法列出现有虚拟机；停止以免覆盖已有机器。' }
if ($existing | Where-Object { $_.StartsWith('"' + $MachineName + '" ') }) { throw '验收虚拟机已存在；保留现状，不自动覆盖。' }
New-Item -ItemType Directory -Force -Path $root | Out-Null
& $VBox createvm --name $MachineName --ostype Windows11_64 --basefolder $root --register
if ($LASTEXITCODE -ne 0) { throw '创建虚拟机失败。' }
& $VBox modifyvm $MachineName --memory 4096 --cpus 2 --firmware efi --tpm-type 2.0 --graphicscontroller vboxsvga --vram 128 --nic1 nat --clipboard-mode disabled --drag-and-drop disabled
if ($LASTEXITCODE -ne 0) { throw '配置虚拟机失败。' }
$disk = Join-Path (Join-Path $root $MachineName) 'Windows.vdi'
& $VBox createmedium disk --filename $disk --size 81920 --format VDI
if ($LASTEXITCODE -ne 0) { throw '创建虚拟磁盘失败。' }
& $VBox storagectl $MachineName --name SATA --add sata --controller IntelAhci
& $VBox storageattach $MachineName --storagectl SATA --port 0 --device 0 --type hdd --medium $disk
& $VBox storageattach $MachineName --storagectl SATA --port 1 --device 0 --type dvddrive --medium $iso
if ($LASTEXITCODE -ne 0) { throw '挂载安装介质失败。' }
Write-Output '配置完成。系统安装许可和账户交互由用户完成；安装后不要预装 Python/Node/Docker，先创建干净快照。'
