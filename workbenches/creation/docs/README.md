# 创作工作台文档导览

创作负责把一次内容机会变成可验收的作品：**形成完整内容 → 制作成品 → 交付与反馈**。研究与分析是可选的材料来源，三个工作台没有强制先后顺序。

当前 CONTENT 和真实 B3 制作均使用共享 PostgreSQL workflow ledger 与官方 OpenAI Agents SDK；CONTENT 由 Space 入口运行，B3 保留业务 stage workflow 和专用 `b3` CLI。B3 的确定性配音、装配、核验和真实渲染是业务实现，不由演示 fixture 替代。先从[共享工作台产品与交互](../../../vendor/agent-workflow/docs/workbench-presentation.md)理解版本、Case、运行和资产，再读本目录的创作流程与标准。建设状态见[共享建设状态](../../../vendor/agent-workflow/docs/harness-roadmap.md)。

2026-10-03，用户授权将原 B1 选题研究与 B2 写作合为一个 `content` workflow。MiMo 实跑说明，环节代理逐一接受也可能留下普通读者无法理解的稿件；工程跑通不能证明内容质量。现在研究、定位、完整稿和返工在同一轮内往返，创作者只在完整内容形成后验收一次，再由版本化作品档案交给 B3。旧 B1/B2 资产及当时判断保留为历史。进一步撤销人工验收须用创作者认可和不认可的正反例校准审阅者。

工作流执行、版本迭代、四问评价、Agent A、资产与版本、PostgreSQL 主存储、通用 Agent SDK／工具／上下文控制、trace／session 和通用工作台属于共享 [agent-workflow 产品](../../../vendor/agent-workflow/docs/product.md)与[架构](../../../vendor/agent-workflow/docs/architecture.md)。创作提供业务流程、角色、工具、标准和作品展示扩展。历史 Codex/SQLite runtime 已退役；其数据库、reports、media 和 traces 作为历史数据保留，不自动修改或导入。旧 SQLite 只允许由明确的只读历史归档工具检查。

| 文档 | 读什么 |
| --- | --- |
| [核心思想](01-principles.md) | 创作怎样用真实作品和创作者判断调优 |
| [产品](02-product.md) | 创作者提交、验收与阅读的内容 |
| [架构](03-architecture/README.md) | 创作扩展与当前本地原型的关系；[作品档案](03-architecture/brief-and-handoff.md) |
| [接入共享底座](03-architecture/runtime-options-report.md) | 职责边界和接入导航 |
| [运行与历史数据边界](03-architecture/business-workbench.md) | 当前 PG/SDK 入口、B3 执行方式和历史数据说明 |
| [工作流](04-workflows/README.md) | [内容迭代](04-workflows/content.md)与[B3 制作](04-workflows/b3.md) |
| [调优手册](05-tuning.md) | 命令、测试与真实运行记录 |
| [决策与历史](06-decisions.md) | 当前决定及旧 [B1](04-workflows/b1.md)、[B2](04-workflows/b2.md) |
| [接入计划](workbench-implementation-plan.md) | 本地原型已有功能与共享底座目标缺口 |

## B3 真实制作 CLI

在 `workbenches/creation` 下使用 Node 24：

```bash
pnpm --filter @creator-lab/creation b3 <input.json>
```

输入需包含已接受的版本化作品档案和工程目录。真实 B3 会执行配音、画面规格设计、装配、技术检查、快照、成片检查和视频渲染；PG 账本使用 `WORKFLOW_DATABASE_URL`，run 私有产物写入 `.local/creation/runs/<runId>` 或 `CREATION_STATE_ROOT` 指定目录。历史阶段文件 CLI 和 Codex runner 已删除，旧运行资料保留用于阅读与校准。

## PostgreSQL Space 接入

`src/spaces/contracts.ts` 登记 CONTENT／B3 业务 schema 与节点合同；`src/spaces/runtime.ts` 将 Space 节点接入共享 harness；`src/spaces/readers.ts` 为稿件、作品档案、研究和制作方案提供按 schema 版本选择的阅读方式。真实 B3 的 stage CLI 也直接使用同一 PG workflow ledger 和共享 Agents SDK runner。

先在根目录运行 `pnpm build:workflow`，为专用数据库设置 `WORKFLOW_DATABASE_URL`，再运行：

```bash
pnpm --filter @creator-lab/creation space:demo
pnpm --filter @creator-lab/creation space:console
```

demo 会在指定数据库持久化合成案例：CONTENT 流程、模拟人工接受、作品档案、独立 B3 方案样例、反馈后的第二版以及四问比较。Agent 回答和人工选择都是明确标注的测试数据；demo 不调用模型，也不执行 B3 媒体制作。要制作真实视频，使用上面的 B3 CLI；fixture 不替代该 workflow。

控制台默认只读监听 `http://127.0.0.1:4318/`；`WORKFLOW_SPACE_CONSOLE_PORT` 可更改端口，`WORKFLOW_SPACE_PRINCIPAL` 选择本地认证主体（默认 `local-owner`）。这只是可信单用户宿主入口，不是面向公网的身份认证。旧 SQLite 业务记录不会自动导入 PostgreSQL。

历史真实模型探针和 CONTENT 运行记录仍适用于各自发生时的条件；2026-10-05 的 MiMo 冻结材料运行三版后仍未收敛，不能宣称内容质量通过。当前执行器、权限和 PostgreSQL 接入见[运行说明](03-architecture/business-workbench.md)；故障恢复与历史检查结果见[迁移前实施记录](workbench-implementation-plan.md#2026-10-05-当前交付先完成单条-content)。

## 当前 CONTENT 调优操作

目前由人或负责调优的 Agent 阅读历史 session、资产和评价，提出原因假设，修改流程代码、角色指令或标准，再通过 CLI 显式发起下一轮。系统保存运行与证据，不会自动判断该改什么或自行改写 workflow。共享层的 `inspectSpace` 提供有权限的只读证据查询；`content:space` 是创作业务 CLI，负责 CONTENT 的案例、运行、评价和返工命令。加上 `pnpm --silent` 可获得不带包管理器日志的 JSON 输出。检查命令不会调用模型；`run`、`revise`、`experiment` 和显式 `dispatch` 可以调用模型。先设置专用 `WORKFLOW_DATABASE_URL`、明确的 `WORKFLOW_SIWC_MODEL`，并按[共享接入说明](../../../vendor/agent-workflow/docs/space-storage.md)完成当前 SIWC 授权。从仓库根目录可运行：

```bash
pnpm --filter @creator-lab/creation content:space --help
pnpm --filter @creator-lab/creation content:space init
pnpm --filter @creator-lab/creation content:space method-preview
# 使用预览返回的准确候选 ID；首个版本可省略 --predecessor
pnpm --filter @creator-lab/creation content:space method-publish --expected-version VERSION_ID --predecessor PREVIOUS_VERSION_ID --reason "本次具体修改依据"
pnpm --filter @creator-lab/creation content:space case --file case.json
pnpm --filter @creator-lab/creation content:space run --version VERSION_ID --case CASE_ID --input input.json --key RUN_KEY
pnpm --filter @creator-lab/creation content:space inspect --run RUN_ID
pnpm --filter @creator-lab/creation content:space events --run RUN_ID --after 0 --limit 100
pnpm --filter @creator-lab/creation content:space asset --asset ASSET_VERSION_ID
pnpm --filter @creator-lab/creation content:space context --context CONTEXT_ID
pnpm --filter @creator-lab/creation content:space session --session SESSION_ID --after 0 --limit 100
pnpm --filter @creator-lab/creation content:space review --case CASE_ID --file review.json
pnpm --filter @creator-lab/creation content:space compare
```

需要阅读稿件或填写反馈时，运行 `pnpm --filter @creator-lab/creation content:workbench`，打开 `http://127.0.0.1:4393/workbench`。`CONTENT_WORKBENCH_PORT` 可更改端口；它与 CLI 使用相同的 Space。页面只在明确提交开始、再跑或派发排队任务时调用模型，保存四问不会启动下一轮。当前仍是本机可信单用户入口。

方法入口是侧栏“工作流”，当前候选的完整图在 `/workbench/workflows/preview`。尚无案例和运行也可预览，点击节点阅读用途、指令、模型、工具及输入来源。`method-preview` 不写数据库；`method-publish` 单独保存不可变版本和明确父版本／修改原因，不运行也不采用。运行时明确选择已发布的方法版本；修改方法文件后重启、重新预览和发布。任务会固定准确版本和输入，不随之后的发布变化。宿主只允许执行登记过的完整部署工厂；缺少匹配代码的旧版可阅读但不可执行。同一代码的旧配置可通过明确保留的部署 profile 继续运行。版本入口见[方法图记录](../../../vendor/agent-workflow/docs/workbench-method-implementation-2026-10-05.md)，执行任务与边界见[第 3 步实施记录](../../../vendor/agent-workflow/docs/workbench-execution-implementation-2026-10-06.md)。

运行任务入口为 `/workbench/runs`，按选题显示准确方法、排队／执行／停止状态和历史入口。默认并发上限为 2 个 workflow run；同一 run 内的审阅节点仍按方法并行，不能把 run 上限理解为模型调用总数上限。多个宿主共用同一个 Space 限额，配置冲突会报错，不自动扩大容量。

```bash
pnpm --filter @creator-lab/creation content:space tasks
pnpm --filter @creator-lab/creation content:space cancel --run RUN_ID
pnpm --filter @creator-lab/creation content:space dispatch
```

取消排队任务不会调用模型；取消执行中任务先记录请求，等待执行器停止。重启工作台不会自动跑任务，未开始的任务可显式 `dispatch`。已失去心跳的任务保留为中断待核对，不自动重试；其占用在安全核对前不释放。历史资产、会话和已发生的外部操作不会因取消而删除。

首轮 `input.json` 必须明确设置 `webResearch: false` 并提供材料；当前 CONTENT Space 入口拒绝联网研究。`inspect` 看 run 及步骤，`asset` 看准确资产版本，`context` 看节点拿到的上下文，`session` 看可观察会话记录；查询属于操作者权限，不是给 workflow 节点开放全部历史。

`events` 读取原生 workflow 事件，支持游标和 `--type` 精确筛选，例如 `--type harness.recovery_patch`。成功步骤复用、失败和人工核对后的恢复属于运行事件；不能通过覆盖旧错误来制造成功记录。当前恢复仍由操作者核对持久状态后使用底层恢复接口，尚无通用的一键恢复命令。

这里自动保存的是 **workflow 执行节点**的可观察历史。负责调优的宿主 Codex 会话仍在 Codex 中，并未自动全量归档到 Space；CLI 会记录实验假设、方法快照和基线，但不应因此宣称已经收齐宿主的全部探索过程。

`review.json` 要写准确 `runId`、`draftVersionId`、标准、四问、`id` 和 `idempotencyKey`。此命令以当前认证主体记录 **human** 判者；不能用它把 Agent 的评价冒充创作者。内部主编通过也不等于用户接受；文件中的 `accept: true` 仅在创作者明确决定、给出 `reason` 且通过内容关口时才可提交。

在已保存准确基线评价后，两种下一轮有不同输入语义：

```bash
pnpm --filter @creator-lab/creation content:space revise --version VERSION_ID --case CASE_ID --baseline-run RUN_ID --baseline-asset ASSET_VERSION_ID --baseline-review REVIEW_ID --file notes.json --hypothesis "具体改善假设" --key REVISE_KEY
pnpm --filter @creator-lab/creation content:space experiment --version VERSION_ID --case CASE_ID --baseline-run RUN_ID --baseline-review REVIEW_ID --hypothesis "方法改动假设" --key EXPERIMENT_KEY
```

`revise` 的 `notes.json` 是非空反馈条目数组；它用**准确旧稿＋显式反馈**继续修这份作品。`experiment` 取基线冻结的**原始输入**，去掉上一轮稿件反馈，以明确选择且已部署的方法开新 run，用于检查流程／提示词改动；它保存版本、假设和基线关联。修改方法文件后须重启宿主，避免代码变了却仍把旧运行版本记作当前版本。比较结果还须由人检查输入、方法及评价口径变化，不能因记录已关联就声称改善已被证明。

Markdown 是文档源。在仓库根目录运行 `pnpm docs:build` 会生成 Git 忽略的 `docs/site/` 并校验内部链接；`pnpm docs:serve` 后可打开 `http://127.0.0.1:4340/docs/site/index.html`。修改业务流程时记录版本、依据和实跑结果；历史结论须标明适用时间。


历史记录：2026-10-06 接入共享 [Archify 交互工作流查看器](../../../vendor/agent-workflow/docs/archify-viewer.md)，并记录了当时可用入口。当前方法预览与运行入口以本机正在运行的 CONTENT Space 配置为准；不要依赖本段中的旧端口或旧执行器标签。
