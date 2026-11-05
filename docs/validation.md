# 验证记录

更新：2026-11-06。此文档记录实际完成的验证，随交付更新。

| 项目 | 当前记录 |
| --- | --- |
| 开发环境 | Windows 11 x64；Python 3.12.13；Tk 8.6；Node 24.22.1 |
| Python 回归测试 | 49 passed，1 skipped；符号链接测试因账户无创建权限跳过 |
| 独立 exe 构建 | PyInstaller 6.16.0，onefile / windowed 构建成功 |
| exe 窗口 / 按钮检查 | 已通过实际窗口操作验证启动、默认示例路径、免费解析按钮；正确显示 2 份文档、13 个图和指标冲突 |
| 中文与空格路径 | 已在 .local/验收 空格 下启动 exe，进程 PATH 仅保留 Windows 系统目录；实际完成文档解析和 0813 API 连接（返回 OK） |
| 无 Python 的干净 Windows | 尚未验证；本机有 Python，不能代替干净机器验收 |
| DeepSeek 官方真实调用 | 尚未运行 |
| 百炼真实调用 | deepseek-v4-pro 初始试跑后，按使用者选择统一改用 deepseek-v4-pro-0813；CLI 与 exe 真实连接均成功，累计预算账本已记录 |
| 完整 Space Fractions 生成 | 已生成全部计划文件；原始输出有真实失败，交付副本含明确记录的操作者修正，不能称一次全自动成功 |
| Docker / 云部署 | 已在现有 WSL Ubuntu 24.04 中安装并启动 Docker 29.1.3 / Compose 2.40.3；未创建云资源 |
| 独立业务 E2E / 权限 / 持久化 | 交付副本通过真实 HTTP 17/17、8 并发重复答案仅计 1 分、重启 game/user 服务后分数保留 |
| 交付副本项目测试 | 单元 83/83、HTTP 边界集成 59/59，均无跳过；另有目录外独立 JWT 6/6 |
| 业务基础设施 | 实际验证 Redis 游戏缓存、RabbitMQ 计分事件投递、Elasticsearch 题目索引与搜索、Prometheus 5 个采集目标 |
| 浏览器验收 | 学生登录、答题、暂停恢复、帮助、登出、管理员新增/删除题目、十题 10/10 结束反馈与成绩页；实际录屏在 docs/media |
| 原始生成项目单元测试 | 已实际安装依赖；首批 71 项中 58 通过、13 失败，未跳过；失败输出已保留 |
| 真实 PostgreSQL 联调 | 原始 25P02 迁移问题经 Agent 修复；随后独立发现 42P01 计分 SQL 错误，交付副本改为事务持锁更新并复验 |
| 独立 JWT 验收 | 原始生成模块错误接受伪造签名；Agent 后续修复为真实 RS256 / JWKS 验证，独立 6 项检查已通过；保留修复前后证据 |
| GitHub Actions | 作业未启动：GitHub 返回账号因账单问题被锁定；没有将其计为 CI 测试通过 |

测试命令：`.venv/Scripts/python.exe -m pytest -q`。

重要测试包括真实 Node 语法失败到修复再检查的离线链路；HTTP 限流重试上限；取消后仍记录用量；无 usage / 截断停止；累计预算与未知请求预留；Windows 路径越界与保留名；读后修改及外部变更检测；进程超时、取消、输出上限和精简环境。

测试中的 ReplayProvider 是固定脚本，不访问 API，不代表模型生成能力。仓库级功能正确性、架构一致性和可维护性必须通过真实结果另行评估。

案例源码、逐文件差异、原始起点与复验报告见 [Space Fractions](../examples/space-fractions/README.md)。最后一轮额外 Agent 修复仍有测试失败，保留 failed_validation 状态；其结果没有被改写为成功。单元测试与集成测试属于模型生成后调整的测试集合，不是固定基准准确率。

Kubernetes / AWS Terraform / Jenkins / Vault / Istio 未部署；internal.proto 未实现 gRPC 传输。未验证生产安全、可用性指标、性能压测或无 Python 干净 Windows。本次使用百炼，尚未进行 DeepSeek 官方 API 实验。

真实运行遇到的外部条件：百炼免费额度耗尽且开启“仅使用免费额度”时，返回 HTTP 403 / insufficient_quota。关闭开关后需等待服务端配置生效，再继续运行。预算包含中断请求及已拒绝请求的保守预留，因此不等同于实际账单。
