# DesignCodeAgent

一个面向架构文档的简易代码智能体：将 Markdown 架构文档和 PlantUML 架构视图转换为代码仓库，通过实际文件工具和检查反馈迭代修复。提供 Windows 桌面 GUI 和 CLI。

本项目用于 coding agent 作业。核心实现采用 Python / Tkinter；不依赖 Claude Code 安装，不使用预写的 Space Fractions 项目替代模型生成。

当前发布包 v0.2.1 为文档修订，桌面程序版本仍为 0.2.0。

![Windows 桌面界面与免费解析结果](docs/images/desktop-v02.jpg)

v0.2 源码新增案例输入分离、独立 Docker/HTTP 反馈、0/3轮修复设置、宿主派生锁文件和冻结实验记录。九次冻结实验已完成：借阅零轮修复0/3、三轮修复3/3，Space Fractions三轮修复0/3。小样本不推导普遍成功率；失败、成功和中断均保留。见 [最终结果](docs/v02-results.md)、[实验协议](docs/v02-experiments.md) 和 [可展开原始检查的离线审阅页](experiments/v02/20261106-v02-e3/review.html)。[全新借阅生成项目](examples/library/README.md) 未人工修改源码，并完成独立HTTP和浏览器复验。[浏览器反馈修复示例](docs/browser-feedback-v02.md) 保留了接口检查通过后仍发现页面错误的真实过程。

真实案例与验证：[Space Fractions 交付副本](examples/space-fractions/README.md) 包含原始输出、操作者修改差异及独立验收。项目单元测试 83/83、集成测试 59/59，真实 HTTP 17/17 通过；并发重复计分和服务重启持久化已复验。**交付副本经过修正，这不是一次全自动成功的声明。**

最终工具回归 **78通过、1跳过**；已完成 [无Python的干净Windows验收](docs/clean-windows.md)。全部失败、中断、开发续跑和正式实验可在 [离线证据总索引](experiments/v02/review.html) 展开查看。

## 快速开始

Windows 用户从 [Releases](https://github.com/RolandHuang17/design-code-agent/releases) 下载发布压缩包，解压后双击 `DesignCodeAgent.exe`。桌面工具自带 Python 运行时，无需预装 Python；联网生成仍需模型服务密钥。生成项目的构建与运行另需 Node.js / Docker。

1. 选择平台并填写匹配地域的 Base URL。官方模式为 `https://api.deepseek.com`；百炼选择控制台给出的 OpenAI 兼容地址，结尾为 `/compatible-mode/v1`。
2. 在遮蔽输入框粘贴 API Key，或点击“读取环境变量”：官方使用 `DEEPSEEK_API_KEY`，百炼使用 `DASHSCOPE_API_KEY`。可另配 `DASHSCOPE_BASE_URL`。密钥默认仅在内存使用。Windows 微软拼音请先切换英文，建议使用粘贴或读取环境变量；输入法尚未提交的组合候选窗口不受文本框遮蔽保护。
3. 核对当前模型价格上界并勾选确认，点击“测试连接”。输入、输出单价均为**元 / 百万 tokens**。
4. 选择 `Architecture_Documentation.md`、`Architecture_View.md` 和输出目录。先点“解析预览”可免费检查文档。
5. 点击“开始生成”。若需自动安装依赖并执行生成项目测试，勾选对应执行选项。此功能以当前用户权限运行生成代码，**不是系统沙箱**；建议在专门开发环境使用。
6. 通过“打开结果目录”查看生成项目、原始输入、事件日志和验证报告。取消会停止本地等待；远端请求可能继续完成，不确定费用预留会保留。单次请求整体等待上限 300 秒。

每次创建独立任务目录，不覆盖之前的项目。Windows 中文及空格路径受支持。本次实验配置为百炼 `deepseek-v4-pro-0813`，平台、型号和用量记录在运行报告中。

## 从源码运行

需要 Python 3.12+。推荐 Windows Python 3.12、Node.js 22+。

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-dev.txt
.venv/Scripts/python.exe -m codeagent gui
.venv/Scripts/python.exe -m pytest -q
```

免费解析：

```powershell
.venv/Scripts/python.exe -m codeagent inspect Architecture_Documentation.md Architecture_View.md
```

官方真实生成（事先配置用户环境变量密钥，价格确认以执行当日为准）：

```powershell
.venv/Scripts/python.exe -m codeagent run Architecture_Documentation.md Architecture_View.md --confirm-pricing --allow-project-execution --output runs
```

百炼真实生成（示例地址中替换自己的业务空间；北京单价上界须核对）：

```powershell
.venv/Scripts/python.exe -m codeagent run Architecture_Documentation.md Architecture_View.md --provider bailian --base-url https://YOUR-WORKSPACE.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 --model deepseek-v4-pro-0813 --input-price 12 --output-price 27 --confirm-pricing --allow-project-execution --output runs
```

上述命令会付费并执行生成项目脚本。取消按 Ctrl+C，等待结果落盘。连接测试可将 `run` 和两个文档路径替换为 `connection`，保留平台、计价参数。

## Agent 工作机制

v0.2 将通用控制器和案例补充输入分离。界面可选择 `space-fractions`、`library` 或 `generic-node` 验收方案，并设定 0–3 轮修复。案例补充材料会与两份原始输入分别保存并标明来源，不属于原始设计。`runtime` 检查会自动启动独立 Docker Compose 项目，在临时回环端口执行项目外 HTTP 验收，返回启动/SQL/功能失败用于修复，随后清理本次资源；没有可用引擎则标记未验证。本机优先 Docker CLI，其次现有 WSL Ubuntu Docker。

CLI 对应参数：`--acceptance-profile library --max-repair-rounds 3 --runtime-backend auto`。`--max-repair-rounds 0` 用于不反馈修复的对照。选择 `generic-node` 只进行通用检查，没有独立领域运行验收，不能据此宣称业务功能通过。

```mermaid
flowchart LR
  A[Markdown 与 PlantUML] --> B[含来源行号的结构化输入]
  B --> C[理解与规划]
  C --> D[模型请求工具调用]
  D --> E[文件工具与固定检查]
  E --> D
  D --> F[宿主重新验证]
  F -->|失败，最多三轮| G[反馈修复]
  G --> F
  F --> H[项目与证据报告]
```

单一控制器按阶段组织任务，并非多进程多智能体系统。规划后的生成按任务逐项推进；模型通过工具创建、读取和修改真实文件。宿主独立执行检查，不能由模型自行宣布“测试通过”。完整工具交换按轮保留；上下文达到字节阈值时由原始输入、保存计划、文件进度与最近检查重建，不凭空伪造工具消息。

失败后可在 CLI 加 `--seed-project 上一轮/project` 续跑：复制原始输出到全新 run，记录来源和文件哈希，跳过已具备目标文件的任务，再进行完整验证。文件存在不视为测试通过；原始运行不被覆盖。桌面 GUI 当前只支持新建任务。

独立验收发现问题后，可再加 `--feedback findings.json`，文件为检查对象数组（例如 `[{"profile":"database_restart","details":"实际失败输出及预期行为"}]`）。反馈触发至多三轮修复中的一轮；结果保留“外部复验待完成”状态，必须由原验收重新检查，不能由模型自行宣布修复成功。

工具：`list_files`、`read_file`、`write_file`、`edit_file`、`run_check`。修改文件需先读取并校验哈希；局部替换要求唯一匹配。检查类型固定为静态语法、依赖安装、单元测试、HTTP 集成测试、构建、Compose 配置和当前案例的独立 JWT 验收。安装禁用生命周期脚本；测试 / 构建及 JWT 检查会执行生成代码。

## 输出和证据

```text
run-时间-随机编号/
  inputs/                 原文副本
  project/                模型生成的项目
  artifacts/
    structured-input.json 含来源行号及输入哈希
    run-config.json       平台、模型、边界配置
    events.jsonl          脱敏模型工具交换与事件
    revisions/            每次写入的不可覆盖版本快照
    checks-0.json         宿主检查；后续编号对应修复轮次
    usage.json            有效响应的用量
    report.json           完整验证结果及累计费用
    report.md             可读报告
```

`passed` 代表相应检查实际运行且成功；`failed` 为失败；`unverified` 表示未运行或缺少条件。即使所有自动检查通过，最终也只标记 `checks_passed_requires_review`，不表示生产就绪。设计追溯自动检查仅验证来源行范围、文件链接和状态，语义覆盖还须独立审查。

## 预算与边界

- 默认累计上限 50 元，包含连接测试和此前运行；可调整为其他正数。明确取消金额上限可在界面填写 `不限`，CLI 使用 `--budget unlimited`，仍保留计价、用量和未知请求预留。本次实验未设金额上限，用量与未知请求预留持续记录。账本位于 `%LOCALAPPDATA%/DesignCodeAgent/budget.json`，没有界面内“重置费用”功能，原有费用不清零。
- 请求前按 UTF-8 字节数加协议余量及输出上限预留；有 usage 才结算。超时、重试和不确定错误保留预留，因此可能比实际账单更保守。缓存折扣不用于预算放宽。
- 单价由用户核对确认。模型服务实际账单才是最终收费依据；价格上界失效时工具估算不能保证实际费用上限。
- 最多 300 个模型轮次，限流 / 指定服务端错误最多重试两次；无网络响应时不盲目重发。生成按规划任务中的目标文件逐一推进，并提供接口索引和读取次数限制，避免反复遍历仓库。输出截断时不执行任何残缺调用，最多提示缩小单次写入后重试两次；超出限制或上下文上限则停止并保留结果。每次尝试均计入预算。
- 文件工具限制在任务项目目录，禁止绝对路径、路径穿越、Windows 保留名、符号链接和 junction；检查子进程使用精简环境，不继承 API 密钥或 `NODE_OPTIONS`。
- API 域名限定为 DeepSeek / 阿里云，拒绝重定向，不使用系统代理；公司网络如要求代理，需调整部署环境后使用。执行生成代码仍具有当前用户权限，不能把文件工具边界当作代码执行隔离。

本项目使用 AI 辅助实现与测试，生成结果及人工修正来源见实验记录。

许可、输入材料权属与参考来源见 [来源说明](NOTICE.md)。
