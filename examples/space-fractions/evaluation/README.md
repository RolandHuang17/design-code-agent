# 验证证据说明

`operator-static/install/test/integration/build/auth.json` 是交付副本的固定检查结果，最后一次源码复验的单元测试为 83/83，集成测试为 59/59。`live-final-source/` 是最后一次实际服务联调，包含 HTTP、并发、持久化、Redis、Elasticsearch、RabbitMQ 和 Prometheus；`browser.json` 记录实际浏览器验收。

其他 `live-*` 子目录及 `*-full.txt` 为联调过程中间记录，可能含失败，不代表最终状态。曾出现主机保留 3000 端口、服务尚未就绪、测试夹具缺失 SQL 支持、缓存检查未先触发缓存填充等问题；没有将这些中间失败删除或算作成功。原始模型输出的报告另外保存在 `../raw-artifacts/` 和 `../additional-agent-artifacts/`。

最后一轮纯 Agent 修复的状态仍是 failed_validation；本交付副本含 11 个文件的后续差异，其中一个是 Agent HTML 修复快照摘取，其余为操作者修改。见逐文件 SHA 与完整 patch。
