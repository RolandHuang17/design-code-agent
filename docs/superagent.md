# Super-agent 架构原型

`DesignCodeAgent-Superagent.exe` 是独立于正式工具的研究原型。模型固定为百炼 `deepseek-v4-pro-0813`；不是新模型、上游 Harness 的移植版或完整复现，也不以原型结果证明生成能力优于正式工具。

参考 [DeepSeek Super-agent 固定提交](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。借鉴工作项与执行尝试分离、资源摘要和按需展开、持久化待办、独立执行上下文以及结构化状态。Python 实现针对两份设计文档到代码的作业场景进行了简化，没有 GitHub／飞书事件接入和自动合并。

## 源码依据与改造边界

补充核验使用 GitHub 内容 API 读取同一固定提交，文件哈希及具体阅读范围见 [来源清单](../experiments/v03/upstream-reading.json)。以下是机制借鉴与本项目实现的对应，不是代码逐行移植。

| 上游实际机制与依据 | 本项目落地 | 简化或扩展 |
| --- | --- | --- |
| [Domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md) 与 [model.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/model.ts)：Ticket 与 Assignment 各有状态，不跟随 Session 生存期 | SQLite 分开保存工作项、请求尝试与模型会话；关闭 exe 后仍可恢复工作 | 不实现上游的事件准入、Mandate、跨来源订阅与授权模型 |
| [resources.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/resources.ts)：资源描述、分页、后续读取位置及会话读取范围 | 原始设计、计划与源码按摘要、ID及页码读取 | 本地内容哈希和不可变资源版本是本项目的扩展；不复用上游的进程内分页缓存。偏移单位是 Python Unicode 字符，上游文本页采用 UTF-16 码元 |
| [effects.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/effects.ts) 与 [store.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts)：持久化副作用队列与事务提交后的执行分开 | 文件集成先记录意图，再按基础哈希接受；模型请求先记尝试，未知结果需确认 | 没有实现上游完整的渠道 Outbox、分类退避与外部消息交付；不保证远端请求恰好执行一次 |
| [sessions.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts)：主会话与执行会话使用不同工具范围 | 真实规划、代码、只读审查会话分开，审查者不能修改文件 | 本项目协调器为确定性 Python 调度器；没有照搬上游模型主会话和终端工具集合 |
| [background.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/background.ts)：后台作业归属、事件与有界结束处理 | 固定检查提交返回 job_id，后台完成事件携带快照；过期结果拒绝通过 | 检查快照绑定是本项目扩展。重启时未完成检查标为中断并重新核验，不恢复旧操作系统进程 |

本项目重点验证设计到代码场景下的调度、上下文与证据机制。目录隔离、候选文件归属和单宿主集成不能替代操作系统安全沙箱；只读审查也不能替代运行测试。

## 实际执行链

```mermaid
flowchart LR
  I[原始设计资源] --> P[独立规划会话]
  P --> Q[SQLite任务与依赖]
  Q --> A[隔离执行会话A]
  Q --> B[隔离执行会话B]
  A --> M[宿主串行集成]
  B --> M
  M --> R[独立只读审查]
  R --> V[固定检查作业]
  V --> E[状态和证据报告]
```

协调器负责确定性调度。规划者建立文件归属和依赖；最多两个代码执行者并行，各自拥有独立模型消息和工作目录。审查者只有资源读取和结构化审查工具，没有写文件能力。最终检查由宿主运行，模型批准不代表测试通过。

执行者先在 `stages/任务编号` 产生候选，宿主核对基础哈希后合入 `project`。同一文件只有一个任务所有者，冲突保留候选并停止集成。每个文件以替换方式写入，集成意图持久化，恢复时识别已经接受的相同内容；这不等于跨多个文件的操作系统原子事务。正式工具的候选修改另有回滚日志机制。

## 持久化与上下文

任务目录中的 `state.sqlite` 使用 WAL，保存任务、模型请求尝试、会话、操作意图、检查作业、事件及不可变资源。资源 ID 含内容哈希，摘要内联，原文分页读取；偏移量单位为 Python Unicode 字符。

工作项与模型会话分别记录。暂停在安全点生效，已经完成的步骤从磁盘恢复；未知请求、遗留执行租约需要明确确认旧进程退出后才能重新尝试。费用预留不因恢复清零。本地持久化不能保证远端 API 恰好执行一次。

检查提交返回作业编号，在后台执行，完成后产生事件。结果绑定代码快照，过期结果不能算通过。安装允许宿主派生锁文件；缺少 Node 等环境时保持未验证。

## 操作

1. 解压原型程序，在英文输入状态粘贴密钥，或读取 `DASHSCOPE_API_KEY`。Base URL 必须与密钥地域及业务空间匹配。
2. 核对价格，选择两份 Markdown 和一个新任务目录；需要真实测试时允许执行生成项目。
3. 点击“新建并运行”，查看任务依赖、集成、审查和检查事件。
4. 暂停后可关闭程序，再选择同一任务目录点击“恢复所选目录”。存在未知请求时先核查旧进程及费用提示。
5. 从事件中的资源 ID 展开原始设计、计划和源码；通过报告入口查看最终状态。

工具无需预装 Python。生成项目仍需要 Node/npm；执行权限为当前用户权限，隔离目录不是系统安全沙箱。当前原型侧重机制可运行，不提供正式工具的完整多轮领域修复能力。

真实运行、失败、中断恢复与最终 exe 验收见 [v0.3 验证记录](v03-validation.md)，不能用离线模拟测试替代。
