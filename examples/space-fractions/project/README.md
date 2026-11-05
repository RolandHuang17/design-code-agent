# Space Fractions

六年级分数学习演示项目。由真实 Code Agent 生成后在独立副本修正，原始输出和差异见上级目录。本 README 由操作者整理，验证状态以 `../evaluation/` 为准。

## 运行

需要 Docker Engine + Compose v2。占用 3000–3004、5432、5672、6379、8080、9090–9095、9200、15672 端口。首次启动需要下载镜像、安装 npm 依赖。

```sh
docker compose up -d --build
docker compose ps
```

打开 http://localhost:3000，点击 Sign in。开发夹具学生 `student / student`、管理员 `admin / admin`。使用 Keycloak 公共浏览器客户端的 Authorization Code + PKCE S256 流程；服务验证 RS256 签名、issuer、audience、时间及管理员角色。无需手工粘贴 token。

若 3000 端口不可用，在 PowerShell 设置 `$env:GATEWAY_PORT='3100'` 后启动；Linux/WSL 使用 `GATEWAY_PORT=3100 docker compose up -d --build`，访问 http://localhost:3100。realm 已允许这两个本机来源。更换域名需同步调整 OIDC issuer、重定向与内部 JWKS 地址。

停止使用 `docker compose down`，保留数据卷。Keycloak 首次导入 realm，已有数据卷不会自动应用后续 realm 文件修改，需管理员更新配置。默认密码、HTTP、开放中间件端口和 Keycloak start-dev 仅供本机开发，不适用于公网。

## 架构

| 服务 | 职责 | 内部端口 |
| --- | --- | --- |
| gateway | 网页、统一 API、超时与健康检查 | 3000 |
| game-service | 游戏状态、答题、分数、所有权 | 3001 |
| question-service | 公开题目与搜索 | 3002 |
| user-service | OIDC 用户和内部用户资料 | 3003 |
| admin-service | 管理员题目 CRUD | 3004 |

PostgreSQL 持久化用户、题目、游戏与答案，迁移幂等执行；Redis 缓存游戏；RabbitMQ 发送计分事件；Elasticsearch 索引维护的题目，搜索故障时可回退 PostgreSQL；Prometheus 抓取五个服务。

答题在同一数据库事务中锁定游戏行，完成去重、加分和状态更新。首次正确答案加 1 分；进行中的重复提交不重复计分，已结束游戏拒绝写入（409）。精确分数运算支持等价未约分答案；非法分数返回 400。游戏允许所有者或管理员访问。

## 测试

源码运行需要 Node.js 22+：

```sh
npm ci --ignore-scripts
npm test
npm run test:integration
npm run build
```

`build` 实际检查 JS、JSON 和配置结构；原生网页不需要打包器。集成测试经过真实 Express HTTP 边界，基础设施用内存替身，JWT 验证真实 RSA 签名；不能替代上级目录的真实服务验收。

## 接口与参考配置

接口见 `openapi.yaml`：创建/读取游戏，答题，暂停/恢复，成绩，公开题目，用户资料及管理员题目 CRUD。`GET /play` 保留原始入口，说明新的 REST 调用方式。

实际服务通信使用 REST，`internal.proto` 仅为协议设计参考。`k8s/`、`terraform/`、`Jenkinsfile`、`vault/`、`istio/` 未部署；Terraform 为 AWS 示例，未创建云资源。需按环境配置镜像、存储、证书、域名、密钥和权限。

补充假设见 `architecture-decisions.md`，路径追溯见 `traceability.json`。没有验证负载、可用性 SLO、云部署或消息事务一致性；RabbitMQ 未实现 outbox / exactly-once。
