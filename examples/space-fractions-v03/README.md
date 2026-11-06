# Space Fractions v0.3 验证示例

本示例来自一次全新生成，加三次基于操作者独立浏览器反馈的 Agent 续跑；不是一次全新、全自动成功。没有人工修改生成产品代码或产品 README。`project/` 的46个文件与最终运行报告逐字节一致；`inputs/` 的两份原始设计文档和操作者 Space Fractions 补充契约也与全新试验输入一致。

谱系及失败记录全部保留：

- [全新 Space04](../../experiments/v03/main/space-04-final-fresh/)：宿主检查通过，独立浏览器登录端口错误。
- [浏览器来源修复续跑](../../experiments/v03/main/space-04-browser-repair/)：真实登录通过，页面主区域空白。
- [页面修复续跑](../../experiments/v03/main/space-04-ui-repair/)：游戏及管理员创建／列表／删除通过；刷新后成绩恢复和管理员编辑仍缺失。
- [状态与编辑修复续跑](../../experiments/v03/main/space-04-state-repair/)：最终产品来源，原始报告仍保留 completed_with_gaps，外部复验独立记录。

最终自带44项测试通过。单独的[独立 HTTP 27项](../../experiments/v03/main/space-04-state-repair/independent-http.json)及[真实 Chromium 浏览器18项](../../experiments/v03/main/space-04-state-repair/browser.json)通过，覆盖学生登录、开始、答题计分、页内暂停恢复、帮助、8题结束反馈，以及管理员创建／列表／编辑／删除。刷新后网页从服务端重新读取同一游戏的1分和8分；管理员编辑后的题干、选项和正确答案在整页刷新后保持。截图、请求路径及服务端成绩响应见最终试验的 `browser/`。

这不证明刷新后恢复精确答题位置，不证明跨会话／进程崩溃恢复、一般成功率或生产可用性。Redis 只有容器配置，未观察到运行时缓存客户端；Elasticsearch、RabbitMQ、Prometheus 的完整端到端能力及云／集群部署未由本次浏览器验收建立。五个真实应用服务入口和 PostgreSQL 持久化实现的静态观察见[架构复核](../../experiments/v03/main/space-04-state-repair/independent-architecture.json)。

运行步骤保留在未经修改的[产品 README](project/README.md)，需要 Node.js、Docker 及相应服务。示例中的学生／管理员账户是本地测试账户。[导出清单](EXPORT-MANIFEST.json)记录逐文件哈希、输入来源和完整谱系。旧的人工调整 Space Fractions 示例保持原样。
