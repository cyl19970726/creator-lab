# 产物、复核与 API 合同

本合同描述当前文章首版的实现，以 [`src/contracts/index.ts`](../../src/contracts/index.ts)、[`apps/api/app.ts`](../../apps/api/app.ts)、[`src/infrastructure/store.ts`](../../src/infrastructure/store.ts) 和 [`apps/worker/worker.ts`](../../apps/worker/worker.ts) 为准。工作区、作品、执行、产物和决定各有独立身份；页面只是这些记录的投影。B3 视频、交付、发布与反馈不在本接口中。

## 身份和产物

- `Workspace` 保存账号名称及定位；`Work` 属于一个工作区，当前只允许 `medium: "article"`。作品保存核心问题、受众、目的（`explanation` / `opinion` / `narrative`）、本篇定位、约束和最多 20 份带 ID 的材料。创建作品不启动执行。
- `Job` 冻结作品输入、模型、推理强度（`low` / `medium` / `high`）与最多 0–2 次自动修订。状态为 `queued`、`running`、`succeeded`、`needs_review`、`blocked`、`failed` 或 `canceled`。同一作品不能同时有两个排队或运行中的任务。
- `Artifact` 是不可变的 `definition`、`draft` 或 `review`。其 `sha256` 校验本地保存的 JSON 内容；`vendorRef` 另记原生资产 ID、修订号和原生哈希，两套哈希不得混用。`dependencies` 连接定义、稿件和针对该稿的复核。读取作品详情时会核验文件存在及哈希，缺失或变化返回冲突。
- `Decision` 针对同一作品中指定的 `draft` ID 和当前哈希，动作是 `select`、`accept` 或 `return`，须附理由。`select` 和 `accept` 更新 `selectedArtifactId`；`return` 只留下决定。`accept` 还要求该稿所属 workflow 已成功，且有直接依赖该稿、结论为 `pass` 的复核。模型复核通过不自动代表用户接受或发布许可。

文章 workflow 使用项目内 [`article-creation` 方法包](../../.agents/skills/article-creation/SKILL.md)：内容定义 → 完整草稿 → 对精确稿件复核 → 有上限的修订/重审。若 reviewer 给出 `blocked` 或修订预算耗尽，运行进入 `needs_review`；结构或来源 ID 校验失败会阻断相应阶段。用户提交的修订意见另开关联任务，沿用可核对的父稿和定义；旧产物不会被覆盖。

## 本机 API

所有请求与响应均为 JSON。除工作区列表和创建外，读取与写入都必须显式带工作区范围；未知或跨工作区对象返回 404。写入均用 `POST`，请求体含唯一 `commandId`（1–128 位字母、数字、`_` 或 `-`）。相同 ID 和相同范围/内容会重放原响应；同一 ID 改换内容或范围返回 409。校验错误为 400，冲突为 409；错误体为 `{ "error": "..." }`。

| 方法与路径 | 请求要点 | 响应 |
| --- | --- | --- |
| `GET /api/workspaces` | 无 | `Workspace[]` |
| `POST /api/workspaces` | `commandId, name, positioning` | `Workspace` |
| `GET /api/workspaces/:workspaceId/works` | 路径中的工作区 | `Work[]` |
| `POST /api/workspaces/:workspaceId/works` | `commandId, workspaceId, title, question, audience, purpose, medium: "article", accountPositioning, constraints, materials`；体内工作区须等于路径 | `Work` |
| `GET /api/works/:workId?workspaceId=...` | 显式工作区 | `{ work, jobs, artifacts, decisions }` |
| `POST /api/works/:workId/start?workspaceId=...` | `commandId, model, reasoningEffort, maxRevisions` | 新的 `Job`，初始为 `queued` |
| `POST /api/works/:workId/revise?workspaceId=...` | 上述执行配置加 `artifactId, sha256, feedback`；父产物须为匹配哈希的草稿 | 关联的新 `Job` |
| `POST /api/works/:workId/decisions?workspaceId=...` | `commandId, artifactId, sha256, action, reason` | `Decision` |
| `POST /api/jobs/:jobId/cancel?workspaceId=...` | `commandId`；只允许排队或运行中任务 | `Job` |
| `POST /api/jobs/:jobId/resume?workspaceId=...` | `commandId`；只允许失败任务 | 重新排队的同一 `Job` |
| `GET /api/jobs/:jobId/execution?workspaceId=...` | 显式工作区 | 原生 run 状态、workflow ID/修订、steps 及各步 attempt 数；未绑定 run 时 steps 为空 |

`materials` 中每项需有唯一 `id`、`title`、`text`，可选 `url`；URL 只作为来源记录。字符串长度、枚举及严格字段约束以 Zod 合同为准。任务取消时，排队任务直接变为 `canceled`；运行中任务先记取消请求，再由 worker 中止。`resume` 只恢复 `failed`，不重启 `blocked`、`needs_review` 或已取消任务；这类情况需按当前结果明确发起新任务。

## 执行与存储边界

API 仅创建和读取持久任务；独立 worker 持有同一 `CREATION_STATE_ROOT` 的 OS 锁，调用共享 `agent-workflow` 的 `runWorkflow` 和真实 Codex runner，并将原生 run/step/attempt 与业务产物协调保存。worker 崩溃后可重领 `running` 任务并按原生记录恢复；不会靠超时夺取锁。API 展示的执行详情来自原生账本，`queued` 本身不表示 Agent 已运行。模型调用轨迹、原生账本和业务产物属于私有运行数据，不入仓。

默认状态根目录为 `workbenches/creation/data/local/platform-v1`，可用 `CREATION_STATE_ROOT` 同时覆盖 API 与 worker。API 默认只监听 `127.0.0.1:4337`（`CREATION_PORT` 可改），并限制本机连接、Host、Origin 和跨站请求；这不是用户认证或公网安全边界。决定 API 在本机把操作者记录为 `user`，不能据此证明远程身份。旧清单、历史数据库及视频/发布助手没有自动导入接口；需要迁移时应另做有来源、可核验的迁移方案。
