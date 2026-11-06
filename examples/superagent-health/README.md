# Super-agent 小服务示例

本目录的 `project` 是架构原型真实生成的小型 Node.js HTTP 项目，未人工修改源码。需要 Node.js 22+；在项目目录执行 `npm ci --ignore-scripts`、`npm test`、`npm run build` 和 `npm start`。

来源为 [153522-health 全新生成](../../experiments/v03/prototype/20261106-153522-health/manifest.json)，最终 [154127 审查检查点续跑](../../experiments/v03/prototype/20261106-154127-health-policy-continuation/report.json) 完成。续跑没有重新生成产品代码，源码哈希见 [清单](project-sha256.json)。

已验证3项自带测试、实际构建，以及项目外6项HTTP／进程重启检查：健康接口200、未知路由404、未知请求后仍健康；重启后重复上述检查。原始 [独立检查](../../experiments/v03/prototype/20261106-154127-health-policy-continuation/independent-http.json) 保留。

父运行曾因审查者扩大范围而受阻；调整为需求关联审查后，在新会话中重新评审通过，旧记录保留。两阶段合计25次请求、有效用量估算1.302711元；这是一个生成谱系，不是两次全新成功。完整原型结果和限制见 [实跑记录](../../docs/superagent-results.md)。
