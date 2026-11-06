# 构建与验证

## v0.3 两个独立程序

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_dual.ps1 -OutputDirectory dist/my-v03-build
```

脚本先执行工具回归，再分别构建 `main/DesignCodeAgent.exe` 和 `prototype/DesignCodeAgent-Superagent.exe`，每个目录包含输入示例与 SHA256。输出目录必须是工作区 dist 下尚不存在的新目录。可用 `-Track main` 或 `-Track prototype` 单独构建；不能沿用另一个文件的验收结论。

本轮本机回归为 **171 通过、1 跳过**（Windows 符号链接权限）。最终文件与源码绑定见 [构建清单](../experiments/v03/build-final.json)，真实运行和干净 Windows 状态见 [v0.3 验证](v03-validation.md)。下文 v0.2 构建和 CI 记录作为历史资料保留。

## 本机构建

需要 Windows、Python 3.12 和锁定的开发依赖。在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

默认输出为 `dist/DesignCodeAgent.exe`，同时附带示例输入、文档和 SHA256 校验值。可用 `-OutputDirectory` 指定其他构建目录。脚本执行 Python 回归测试后，使用 PyInstaller 打包解释器、Tkinter、案例补充材料及 CA 证书。

自行构建的 exe 可能因构建环境与时间产生不同哈希，应单独验收，不能直接沿用已发布文件的干净 Windows 验收结论。

## 文档修订包

v0.2.1 是文档及发布材料修订，桌面程序保持 **0.2.0**，文件与已验收版本相同。原始构建来源和哈希见 [构建清单](../experiments/v02/build-final.json)。

对已经与构建清单匹配的 exe，可运行：

```powershell
python scripts/package_release.py --exe dist/v0.2.0-tls/DesignCodeAgent.exe --output dist/v0.2.1-release --bundle-version 0.2.1
```

打包脚本只接受与清单哈希一致的 exe；输出目录和 ZIP 必须不存在。包内 `BUILD-MANIFEST.json` 记录程序构建，`BUNDLE-MANIFEST.json` 分别记录文档包与程序版本。

## 验证记录

已配置 GitHub Actions Windows 测试和打包。已有运行因 GitHub 账户账单锁定未启动，见 [CI 原始状态](../experiments/v02/ci.json)；不能将其计作 CI 测试通过。

已发布程序在本机通过78项测试、1项因 Windows 符号链接权限跳过；干净 Windows 独立验收见 [验证记录](validation.md) 和 [干净系统验收](clean-windows.md)。文档修订不重跑模型实验或替换验收程序。
