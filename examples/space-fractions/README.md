# Space Fractions 真实生成案例

`project/` 是可演示的交付副本，起点为真实运行 `run-20261106-004631-f79548f8`。实验使用百炼，最初尝试 `deepseek-v4-pro`，后续统一为 `deepseek-v4-pro-0813`，多次续跑继承已有文件；不能把每个文件都算作最后一轮独立生成。原始起点共 84 个文件，见 `origin.json` 和 `raw-project/`。这不是离线模拟结果。

**交付副本包含操作者修正，不能作为全自动一次成功的证据。** 原始输出、调用日志和失败检查另行保留；逐文件差异见 `operator-changes.patch` 和 `operator-changes.json`。网页 HTML 来自后续 Agent 修复运行 revision 15，其余差异按实际来源记录。

## 演示

在 `project/` 内运行 `docker compose up -d --build`，打开 http://localhost:3000。本次 Windows 主机保留了 2914–3013 端口，因此实际使用 `GATEWAY_PORT=3100` 和 http://localhost:3100，没有修改系统端口保留设置。

学生账号 `student / student`；管理员 `admin / admin`。这些是本机开发夹具，不能用于公网部署。点击 Sign in 经过 Keycloak 登录，无需粘贴 token。容器和生成项目需要 Docker / Node.js；Agent exe 自带 Python 运行时。

## 已运行的验证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 项目单元测试 | 83/83 通过，0 跳过 | `evaluation/operator-test.json` |
| HTTP 边界集成测试（基础设施用假对象） | 59/59 通过，0 跳过；JWT 验证真实 RSA 签名 | `evaluation/operator-integration.json` |
| 目录外独立 JWT 检查 | 6/6 通过 | `evaluation/operator-auth.json` |
| 真实服务 HTTP 验收 | 17/17 通过 | `evaluation/live-all/independent-http.json` |
| 8 个并发重复答案 | 仅计 1 分 | `evaluation/live-all/independent-concurrency-persistence.json` |
| 重启持久化 | 重启 game / user 服务后仍为 1 分 | 同上及 `restart-command.txt` |
| Redis / RabbitMQ / Elasticsearch / Prometheus | 实际缓存/投递/搜索/五个采集目标通过 | 同上及 `independent-rabbitmq.json` |

这些数字覆盖不同测试集合，不能相加当作完整率。指定场景通过不证明生产安全、千人并发、99.99% 可用性或云部署成功。

## 架构范围

已在 WSL Docker 实际运行 gateway、game、question、user、admin 五个 Node.js 服务以及 PostgreSQL、Redis、RabbitMQ、Elasticsearch、Keycloak 和 Prometheus。补充 REST 接口、OIDC subject 到数据库用户 ID 映射、计分事务与原始 `GET /play` 的兼容入口。

`internal.proto` 为协议设计参考，服务实际通过 REST 通信，未实现 gRPC 传输。Kubernetes、AWS Terraform、Jenkins、Vault 和 Istio 未在集群/云上运行，不将文件存在记为部署完成。RabbitMQ 是尽力发送，没有事务 outbox 或端到端 exactly-once 保证。

输入的需求编号不完整、接口缺失与可用性指标冲突见决策文件及根目录 `docs/design.md`。补充设计没有被冒充原始要求。
