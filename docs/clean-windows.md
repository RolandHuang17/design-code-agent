# 干净 Windows 验收：v0.2 历史记录

v0.3 两个最终程序的原生验收、源码绑定与导出记录见 [v0.3 验证](v03-validation.md) 和 [最终主程序清单](../experiments/v03/clean-windows/main06-summary.json)。

当前状态：最终exe的独立工具验收已完成。Windows11企业评估版26H2，初始build26300.9457，更新后26300.9711；注册表ProductName仍写Windows10，原始值保留。系统没有预装Python、Node或Docker，先保存干净快照，再运行桌面工具。

## 已准备

- 官方 VirtualBox 安装包保存在 `.local/vm/VirtualBox-7.2.22-175245-Win.exe`。本地 SHA256 已与官方清单匹配，数字签名显示 Valid / Oracle America, Inc.；下载来源与哈希记录在 `.local/vm/downloads.json`。
- Windows 11 企业评估版 ISO 从微软官方链接下载到 `.local/vm/Windows11-Enterprise-Evaluation-zh-cn.iso`。记录了本地 SHA256，尚未获得官方独立哈希作比对，不声称已完成厂商哈希验证。
- `scripts/prepare_vm.ps1` 仅为本次固定名称的虚拟机创建配置；默认2核、4GB内存、80GB动态磁盘，关闭共享剪贴板与拖放。不覆盖同名机器，不安装到宿主磁盘。

## 后续步骤

1. 已完成重启、VirtualBox安装与驱动核验；不需要 Extension Pack。
2. 已通过 `scripts/prepare_vm.ps1` 创建虚拟机并启动安装；已有机器不重建。系统许可与账户交互由使用者完成。
3. 不在来宾系统安装 Python、Node 或 Docker。保存干净快照，记录 Windows 版本与未安装运行时的状态。启动前停止本项目旧演示容器以释放内存；不关闭 WSL / Hyper-V 或修改 Windows 安全配置。
4. 将已经校验 SHA256 的发布包放入来宾的中文、空格目录；传入密钥时不录屏、不写入共享文件，也不把密钥提交到证据仓库。
5. 双击 exe，验证 GUI、默认示例路径、免费解析、0813 连接、实际文件生成、取消和结果入口。生成项目执行选项不启用；另验证缺少 Node / Docker 的检查显示“未验证”，不能显示通过。
6. 保存操作截图、生成目录和脱敏报告；注明它验证的是桌面 Agent 无需预装 Python。完整生成项目的 Node / PostgreSQL / Docker 验收在宿主开发环境另行报告。

完成后把实际结果补入验证报告，出现失败则保留原始结果与复现步骤。

已另备只读验收介质，包含最终exe（SHA256见build.json）、小任务输入和原生Windows环境清单工具；不含密钥。环境清单只读取系统版本、PATH候选运行时及软件安装项，不能单独排除所有便携运行时，需与全新系统快照共同作为证据。

## 实际发现与修正

- 1024×768放大字体时下方按钮不可见：加入可滚动内容区域及DPI适配，已在来宾实际滚动到操作按钮和完整日志。
- 首次连接返回通用网络错误。最终构建加入固定certifi2026.10.23证书包及脱敏诊断，来宾重新连接返回OK；旧失败及未知费用预留保留。TLS主机名和证书链校验保持开启。
- 微软拼音组合候选不受Tk遮蔽框保护；旧式IME窗口关联隔离不能保证阻止现代输入法。已用假密钥核验英文输入，再进行真实连接。演示与README明确建议英文粘贴或读取环境变量，不将候选窗口截图收入证据。
- 虚拟机原PS/2输入不稳定，已改USB键盘和USB tablet；来宾一次关闭黑屏后重新启动并完成Windows更新。宿主未重启，原干净快照保留。

## 最终验收结果

| 项目 | 实际结果 |
| --- | --- |
| 发布文件绑定 | 来宾计算SHA256与宿主最终exe完全一致，见 [构建清单](../experiments/v02/build-final.json) |
| 启动及输入 | 中文、空格目录实际双击；原始两文档13图、1条冲突；0813真实连接返回OK |
| 真实生成 | 14文件、22轮、112.70秒；未人工修改生成源码 |
| 缺少项目运行时 | static/install/test/build/compose未验证；未声明集成脚本为not_applicable；追溯链接检查通过 |
| 取消 | 2轮、26.53秒，保留2份计划文件，最终cancelled |
| 结果入口 | 按钮打开对应取消任务的artifacts、inputs、project目录 |
| 来宾费用 | 有效响应1.245669元，未知请求预留0.747660元，26次请求尝试；与宿主账本分开 |

[完整原始记录](../experiments/v02/clean-windows/summary.json)、[更新前环境清单](../experiments/v02/clean-windows/environment-before.txt)、[更新后环境和exe哈希](../experiments/v02/clean-windows/environment-after.txt)。原始ZIP传回后逐文件哈希校验通过；传输服务仅监听宿主回环地址，验收后关闭。此项证明桌面工具不需要预装Python，不代表生成项目在无Node/Docker的机器上完成业务验收。
