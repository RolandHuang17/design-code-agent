# Code Agent 机制调研

调研时间：2026-11-05 至 2026-11-06。以下区分实际访问到的代码、项目说明与作者分析，不将推测写成源码结论。

## 参考材料核验

| 作业链接 | 实际核验情况 | 使用边界 |
| --- | --- | --- |
| ultraworkers/clawcode | 原链接 404；访问到 ultraworkers/claw-code | 调研其当前 Rust 会话结构与工具路径边界测试 |
| Windy3f3f3f3f/howclaudecodeworks | 原链接 404；经仓库搜索找到 how-claude-code-works | 阅读 README 和主循环、上下文工程、工具系统章节；作为非官方教育性分析引用 |
| anthropics/claudecode | 原链接 404；访问到 anthropics/claude-code | 阅读官方 README，作为产品能力和资料入口，不当作完整内部实现源码 |

固定版本：Claw Code `ab8561dc378150e9e65868233dd872937aa68299`；Claude Code `26382c08758260c9f5deb2019d8fe851f89fa9ae`；Windy 学习笔记 `f4d6505ed9162a0ee6be089190f74c419ecacb19`。通过 `git ls-remote` 核对，并读取 GitHub 内容 API 返回的相应文件。

## 从已读代码提炼的机制

Claw Code 的 [conversation.rs](https://github.com/ultraworkers/claw-code/blob/ab8561dc378150e9e65868233dd872937aa68299/rust/crates/runtime/src/conversation.rs) 将模型客户端抽象为 `ApiClient`，工具执行抽象为 `ToolExecutor`，由 `ConversationRuntime` 持有会话、权限策略、用量和迭代上限。已检查的 `run_turn` 在发请求前判断中断和轮次上限，将会话传给流式客户端，再处理模型事件；工具调用交给执行器，错误也转为工具结果。这是本项目“模型选择动作，宿主负责执行与边界”的直接参考。

[compact.rs](https://github.com/ultraworkers/claw-code/blob/ab8561dc378150e9e65868233dd872937aa68299/rust/crates/runtime/src/compact.rs) 定义压缩阈值、近期消息保留和摘要结果。它与本项目的实现不同：本项目主要依靠磁盘计划、文件进度和接口索引重建上下文，并保留有界的完整近期工具交换。本次真实试跑曾因丢掉所有近期交换而反复阅读源文件，因此不能简单把“能缩短上下文”当作“能保持任务进度”。

Claw Code 的 [session.rs](https://github.com/ultraworkers/claw-code/blob/ab8561dc378150e9e65868233dd872937aa68299/rust/crates/runtime/src/session.rs) 定义了区分消息角色的会话、工具调用与结果内容块、用量元数据，以及上下文压缩和持久化信息。其会话代码还包含日志字段长度和脱敏相关处理。这表明 Agent 工程除了模型请求，还需管理工具配对、可追溯会话与资源边界。

其 [path_scope_enforcement.rs](https://github.com/ultraworkers/claw-code/blob/ab8561dc378150e9e65868233dd872937aa68299/rust/crates/tools/tests/path_scope_enforcement.rs) 测试构造工作区写入权限下的工具注册表，并测试目录内路径和外部绝对路径的权限行为。本实现参考的是“路径约束应由宿主强制并测试”的原则，没有直接移植该仓库代码。

Claude Code 的 [官方 README](https://github.com/anthropics/claude-code/blob/26382c08758260c9f5deb2019d8fe851f89fa9ae/README.md) 说明其仓库理解、开发和 Git 工作流能力，并链接官方文档。仅凭此 README 不能得出完整内部循环或调度实现结论。

## 本项目的具体实现

Windy 的 [主循环章节](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/f4d6505ed9162a0ee6be089190f74c419ecacb19/docs/02-agent-loop.md) 将会话生命周期管理和单次查询执行分开讨论；[上下文工程](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/f4d6505ed9162a0ee6be089190f74c419ecacb19/docs/03-context-engineering.md) 强调系统提示、项目知识与消息历史的不同变化频率；[工具系统](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/f4d6505ed9162a0ee6be089190f74c419ecacb19/docs/04-tool-system.md) 从契约、组装与执行讨论工具。这些是该作者的独立教育性分析，README 明确不保证与真实内部实现一致；本项目不将其中的具体规模、性能数字或逆向结论视为官方事实。

1. **模型与工具分离**：模型生成结构化调用；Python 宿主校验并执行，将真实结果用对应 tool_call_id 返回。
2. **文件作为工程状态**：代码实际落盘。每次写入另存快照，修复时读后修改，避免只给聊天中的代码片段。
3. **验证作为反馈**：宿主固定检查得到失败输出，最多三轮修复。没有运行的检查保持 unverified。
4. **上下文有界**：完整工具交换才允许丢弃，使用磁盘计划、原始输入和宿主观察重建，不杜撰压缩后的执行结果。
5. **可核验记录**：输入哈希、模型与平台、工具结果、检查状态、API usage 和累计费用构成证据链。

实跑进一步促成两项约束：将多文件任务拆成逐文件目标，完成依据为实际写入；将修复分成静态错误、各测试文件失败、独立鉴权和外部运行反馈等小组，限制写入前的重复读取。它们是针对本案例观察到的控制器问题所作的改进，不是对参考项目优劣的比较结论。

这些是本工具的工程选择，不宣称与任一参考工具完全一致。作业只要求简易 Agent，因此没有引入多 Agent 调度框架、浏览器工具或任意终端工具。

## 协议与发行依据

- [DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)：客户端执行工具并返回结果。实现显式关闭思考模式，避免混用不同思考历史协议。
- [DeepSeek 模型及价格](https://api-docs.deepseek.com/quick_start/pricing/)：官方模型 ID、上下文及计价信息；上线前再次核对。
- [百炼 DeepSeek 接口](https://help.aliyun.com/zh/model-studio/deepseek-api)：使用对应业务空间及地域的 OpenAI 兼容地址，采用 enable_thinking 参数。
- [百炼 V4 Pro 价格](https://help.aliyun.com/zh/model-studio/deepseek-v4-pro)：按地域 / 模型核对人民币计价；本机北京模式上界采用输入 12、输出 27 元 / 百万 tokens，覆盖本次已读页面列出的标准与快照型号北京价格。
- [PyInstaller 打包机制](https://pyinstaller.org/en/stable/operating-mode.html)：在 Windows 构建自带 Python 解释器的独立 exe；生成项目的 Node / Docker 不属于打包的 Python 工具运行时。
