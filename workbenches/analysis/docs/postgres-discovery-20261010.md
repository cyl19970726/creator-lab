# 分析工作台 PostgreSQL 迁移：接线勘查（2026-10-10）

范围：只读核对现有存储、共享 PG 合同和迁移边界；未改业务代码、未连接数据库、未启动模型或服务。目标按本次任务理解为：PG 是新生产运行的唯一持久读写正本，旧 SQLite 只保留只读导入和历史测试；已有 UI、报告正文和媒体引用需继续可读。共享产品目标见 `vendor/agent-workflow/docs/product.md`、`architecture.md`、`harness-roadmap.md`，不把目标当成已实现。

## 核心判断

这不是替换一个 `RunStore` 的小改动。分析工作台的 `createSignalRoomComposition()` 在同一 `self-media.sqlite` 中接入业务研究仓储、批次仓储与 workflow ledger（`src/server/composition-root.ts:57-64,132-138`）。业务仓储接口全为同步方法（`packages/research/src/creator-research/repository.ts:7-31`、`batch-repository.ts:3-11`），而共享 `PostgresWorkflowRunStore` 是异步 `RunStore`，只覆盖 run/step/attempt/event/artifact ledger，不提供分析队列、租约或业务资产（`vendor/agent-workflow/packages/postgres/postgres-run-store.ts:106-142`；`docs/postgres-storage.md:1-23`）。必须将业务读写链异步化、保持队列原语及跨表事务，并迁移独立的 workflow execution 表。

## 当前正本与依赖面

| 域 | 现有接线/关键位置 | PG 迁移影响 |
| --- | --- | --- |
| 默认 DB | `packages/adapters/src/core/config.ts:33-55`：`SELF_MEDIA_RUNTIME_DIR` 或项目 `.runtime/self-media.sqlite` | 新生产配置显式指向 PG；路径只用于旧导入/媒体，不回落 SQLite 写入。 |
| 研究 run、job、event | `packages/adapters/src/platform/database/sqlite-creator-research-repository.ts:137-201,203-444`：run JSON、job 幂等键、全局 event sequence、lane/lease/心跳/过期预算 | 新 PG 业务表及 Repository；`claimNext` 在事务中以行锁/`SKIP LOCKED` 保持排他、容量和相同 run 互斥；过期恢复/重试预算不能省。 |
| 批次 | `packages/adapters/src/platform/database/sqlite-creator-research-batch-repository.ts:22-141`：operation-key+command-hash 和有序成员 | PG 事务先占 operation key，同键同 hash 复用、不同 hash 冲突，保持位置顺序。 |
| Workflow ledger | `packages/adapters/src/workflow/sqlite-run-store.ts:2` 重导出共享 SQLite；`vendor/agent-workflow/packages/sqlite/sqlite-run-store.ts:12-153` 保存完整 JSON payload | 可用共享 `@signal-room/workflow-postgres` 的异步 ledger，需保持旧 ID、事件序号、payload/hash 和父子/依赖关系。 |
| Workflow execution 队列记录 | `packages/adapters/src/workflow/research-workflow-executor.ts:55-66,297-423`：独立 `research_workflow_executions` 表，仍同步读写；取消用 250ms 查询 | 新 PG persistence 或重构 executor；不能仅迁 ledger。 |
| 版本登记事务 | `packages/research/src/workflows/research-version-registration.ts:65-68` 要求锁定 creator row，并让 get/save 在同一事务；SQLite 实现 `packages/adapters/src/workflow/sqlite-research-version-transaction.ts:5-18` | 将事务端口改为异步并显式传同一 PG client/仓储上下文，`SELECT ... FOR UPDATE`；不能在回调内从 pool 另取连接。 |
| 报告与研究资产 | `packages/research/src/creator-research/artifact-store.ts:1-6` 全同步；`packages/adapters/src/platform/artifacts/local-creator-artifact-store.ts:27-80` 以 `/artifacts/<run>/<file>` 引用、文件 hash/registry 保存 JSON；`src/server/app.ts:69` 静态读取 `runs/` | 报告 JSON/正文应成为 PG 正本（immutable ref、bytes/hash、依赖）；接口及约 101 个 `artifacts.read/write/...` 调用需异步化。媒体文件/帧另列，不可把小 JSON PG 化后声称完整媒体已迁。 |
| API/CLI/worker | `apps/api/src/main.ts:6-11`、`apps/worker/src/main.ts:3-7`、`apps/cli/src/main.ts:14-19` 均同步创建 composition；`src/server/video-research.ts:133-177`、`creator-dossier.ts:158-165` 同步读 service | composition 异步初始化/关闭 pool；服务、processor、scheduler、读模型和路由 await。尽量保留 HTTP JSON/URL 合同，让 Web UI 无需整体重写。 |

共享 `PostgresBlobStore` 实际保存字节，但默认单对象仅 16 MiB（`vendor/agent-workflow/packages/spaces/blob-store.ts:13-46`；`docs/space-storage.md:68`）。它没有现有报告 registry/引用合同。小型报告可以用 PG 业务资产表或接 Space 资产服务；大型视频、图片及转写中间件仍要受管私有对象存储或有完整备份的媒体目录。当前 `artifactPath()` 将 `/artifacts/...` 映射到本机目录（`packages/adapters/src/core/artifacts.ts:5-18`），迁移必须保留 URI 身份并改读取器，不能只挪 DB。

## 最小完整实现边界与文件所有权建议

1. **PG 仓储/导入（可独立所有权）：** 新 `packages/adapters/src/platform/database/postgres-creator-research-repository.ts`、`postgres-creator-research-batch-repository.ts`、schema/migration；`packages/adapters/src/workflow/` 的 PG execution persistence/版本事务；业务 PG artifact store；只读 SQLite→PG 导入脚本及 PG 集成测试。共享 PG ledger 可直接依赖，不复制 vendor 源码。若复用 shared Space 任务服务，应先证明它保留分析 lane/lease/互斥语义；直接替换现有队列不成立。
2. **Async 消费链（独立所有权）：** `packages/research/src/creator-research/{repository,batch-repository,artifact-store,service,batch-service,job-processor,video-synthesis-processor,worker}.ts`、`packages/research/src/workflows/{queue-scheduler,research-version-registration}.ts`；`src/server/{creator-dossier,creators,video-research,workflow-artifact-reader,workflow-creator-reader,...}.ts`、相关 routes；`apps/{api,worker,cli}`。这些改的是 port 和 await，不应更改 Builder 的三部分正文来源或 UI 投影语义。
3. **集成单点（主负责人）：** `src/server/composition-root.ts`、`packages/adapters/src/workflow/production-research-runner.ts`、`packages/adapters/index.ts`、`package.json`/build 脚本与必要接口连接。`production-research-runner.ts:472,550` 仍显式依赖 `DatabaseSync`/`SQLiteResearchVersionRegistrationTransaction`；与 runner 改造工作应避开同文件并行编辑。

异步资产接口本身可以先由 PG 仓储负责人定义和实现，再交消费链负责人统一替换调用；接口所有权只给一方。当前 `CreatorArtifactStore` 四个方法均同步，不能引入内存镜像把 PG 包成“同步正本”。生产脚本在启动时必须迁移 PG schema 并以 pool 的生命周期关闭。旧 SQLite adapter 留作导入和回归对照，不能成为 PG 不可用时的静默回退。

## 历史数据迁移及幂等验收

先停写并排空/冻结旧 worker，使用现有 SQLite backup API 制只读一致快照；`scripts/snapshot-runtime.py:1-23` 只备份 DB、把 `runs/` 链回旧媒体，不足以构成独立完整资产副本。导入前列出旧 run/job/event/batch/workflow 五类表的行数、ID 集、状态分布、每 run 事件序列与文件 registry/hash；检测缺失文件、悬空引用、异常活动 lease。历史未决的 `running/leased` 不直接自动重跑，先标记待核对。

导入顺序：研究 run → job/event → batch+items → workflow run（父先于子）→ step → attempt → event（保留 `seq`）→ artifact（依赖先于消费者）→ workflow execution → 业务 JSON 资产。PG ledger `createRun` 会生成新 UUID（`postgres-run-store.ts:145`）；历史导入须用受控迁移事务/SQL保留原 ID，并在导入后设 `aw_runs.next_event_seq=MAX(seq)+1`，保持 UI 深链、父子关系与引用。共享 PG schema 有更严格的外键/依赖检查，先报告不一致数据，不得重写历史来让导入通过。每一批以来源快照 ID、目标 workspace ID 和源行 ID 做幂等键；同键同 hash 可重复验证，不同 hash 中止。PG 业务资产 hash 以原始文件字节验证，ledger JSON payload 用 core canonical hash 校验。

导入后双向核对 ID、行数、状态与序列，随机抽取单帖和单博主的 Builder 三部分正文、Reviewer状态、候选/修订、batch、workflow 过程图和原始媒体链接，从旧只读工作台与 PG 工作台比对 HTTP 投影及内容 hash；重启 API/worker 后复查。PG 新增一次任务、批次幂等重试、并发 claim/heartbeat、取消、版本登记事务、子 workflow 恢复应有确定性集成测试。仅当 PG 页面完整读取旧报告且新运行没有 SQLite 写入时切主；保留旧快照与回退窗口。SQLite 与 PG 双写会制造无法判断的主从差异，不建议作为过渡正本。

## 现成验证环境与边界

共享 `vendor/agent-workflow/docs/postgres-storage.md:24-47` 给出 `npm run example:postgres` 与 `npm run test:postgres`；后者由 `vendor/agent-workflow/scripts/test-postgres.mjs:4-17` 强制要求专用 `WORKFLOW_TEST_DATABASE_URL`，不设时明确失败。已有 `packages/postgres/postgres-run-store.test.ts` 覆盖 PG ledger 隔离、并发事件和恢复。分析侧现有 SQLite repository、workflow executor、composition、API 测试可作行为对照（`packages/adapters/src/platform/database/*repository.test.ts`、`packages/adapters/src/workflow/research-workflow-executor.test.ts`、`src/server/analysis-composition.test.ts`）；本工作台 `package.json:9-24` 有 typecheck/test/lint/build/smoke/verify，但 `build:workflow` 尚未列入 PG 包。本文不记录当前机器上的数据库环境状态，也未运行 PG 集成测试。
