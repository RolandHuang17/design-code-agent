# 干净 Windows 验收：待重启后执行

当前状态：宿主构建和窗口检查已完成；没有把宿主已有 Python 的结果当作干净 Windows 验收。使用者明确要求先完成其余工作，再重启并安装 VirtualBox。此文件是后续验收步骤，不是通过报告。

## 已准备

- 官方 VirtualBox 安装包保存在 `.local/vm/VirtualBox-7.2.22-175245-Win.exe`。本地 SHA256 已与官方清单匹配，数字签名显示 Valid / Oracle America, Inc.；下载来源与哈希记录在 `.local/vm/downloads.json`。
- Windows 11 企业评估版 ISO 从微软官方链接下载到 `.local/vm/Windows11-Enterprise-Evaluation-zh-cn.iso`。记录了本地 SHA256，尚未获得官方独立哈希作比对，不声称已完成厂商哈希验证。
- `scripts/prepare_vm.ps1` 仅为本次固定名称的虚拟机创建配置；默认2核、4GB内存、80GB动态磁盘，关闭共享剪贴板与拖放。不覆盖同名机器，不安装到宿主磁盘。

## 后续步骤

1. 等后台实验、打包和 Git 推送结束，记录安全重启点后再重启。安装包的管理员确认由使用者自行处理；不需要 Extension Pack。
2. 安装后先核验 `VBoxManage --version` 和脚本所用参数，再运行 `scripts/prepare_vm.ps1`。已有机器时保留现状，不自动删建。系统许可与账户交互由使用者完成。
3. 不在来宾系统安装 Python、Node 或 Docker。保存干净快照，记录 Windows 版本与未安装运行时的状态。启动前停止本项目旧演示容器以释放内存；不关闭 WSL / Hyper-V 或修改 Windows 安全配置。
4. 将已经校验 SHA256 的发布包放入来宾的中文、空格目录；传入密钥时不录屏、不写入共享文件，也不把密钥提交到证据仓库。
5. 双击 exe，验证 GUI、默认示例路径、免费解析、0813 连接、实际文件生成、取消和结果入口。生成项目执行选项不启用；另验证缺少 Node / Docker 的检查显示“未验证”，不能显示通过。
6. 保存操作截图、生成目录和脱敏报告；注明它验证的是桌面 Agent 无需预装 Python。完整生成项目的 Node / PostgreSQL / Docker 验收在宿主开发环境另行报告。

完成后把实际结果补入验证报告，出现失败则保留原始结果与复现步骤。
