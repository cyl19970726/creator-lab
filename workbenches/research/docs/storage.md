# 研究工作台的存储边界

新研究运行只写入 `WORKFLOW_DATABASE_URL` 指向的 PostgreSQL 数据库。启动缺少该变量时会失败；运行时不会打开 SQLite，也不会在 SQLite 与 PostgreSQL 之间静默回退。

| 数据 | 新运行的正本或用途 |
| --- | --- |
| 运行、步骤、尝试、事件与产物 payload | shared `PostgresWorkflowRunStore`；`aw_*` 表由上游迁移管理 |
| 冻结输入、模型/方法指纹、排队状态、取消、恢复与幂等命令 | `research_host_*` PostgreSQL 表 |
| worker 单主租约 | PostgreSQL 行锁和有期限租约；API 与 worker 可各自重启并共享同一数据库 |
| 用户反馈、接受/退回决定 | `research_collaboration_events`，追加写入并绑定确切产物身份 |
| Markdown 阅读器导出 | `.local/artifacts/` 下的派生文件；正文仍以不可变 artifact payload 为准 |
| 选题清单、来源原文件 | `.local/content/manifest.json` 与清单引用的本地文件，读取时校验 SHA-256 |

入队事务同时创建 shared ledger run 和宿主冻结记录。worker 在 PostgreSQL 中领取租约；取消标记持久化，活动 runner 收到 abort signal。重启后过期作业成为 `interrupted`，只有显式 resume 才能重新排队。方法、输入及运行模型指纹不匹配时拒绝用新定义恢复旧运行。

shared ledger 的物理 workspace 与研究输入的逻辑 workspace 分开保存。任务列表、历史产物复用和 repair 引用按逻辑 workspace 与 topic 一起校验；同一物理数据库中的其他逻辑工作区不能混入当前选题。

模型执行由官方 `@openai/agents` SDK `Runner` 驱动；SIWC 只提供已有的 Continue with ChatGPT 授权和 Responses transport。每个 attempt 只获 host 绑定的 `read_frozen_source`、`search_public_web`、`open_public_page` 工具：来源只从该次冻结输入读取；网页搜索使用不需新账户的 DuckDuckGo HTML endpoint；页面读取限制 HTTPS、拒绝私网/本地地址、逐跳复核重定向、只接受 HTML/plain text 并限制读取字节。网页检索/读取失败会让实际研究尝试失败，模型不会被提示把未检索到的内容伪装成来源。共享 SDK tracing 关闭，调用事件和安全元数据由 PostgreSQL ledger 保存；原有本机私有 traces 不会被启动代码删除或覆盖。

## 历史研究数据

原工作台位于 `/absolute/path/to/legacy-research/.local`。SQLite 原件、已导出的报告、来源和私有 traces 留在原路径；本工作台的忽略目录 `.local/content` 是原 `manifest.json` 与 116 个来源文件的字节一致副本，因此选题和来源仍能在现有 UI 中浏览。历史报告正文与账本记录导入 PostgreSQL 后由现有阅读 API 提供；读取历史报告会在本工作台 `.local/artifacts/` 生成派生副本。旧 traces 不导入或重放，原目录不变。

本机配置位于 Git 忽略的 `workbenches/research/.env`，API 和 worker 从该文件加载研究数据库 URL。已确认导入源为：

- `.local/state/research.sqlite`：4 次历史运行、283 个步骤、283 个尝试、1,729 个事件、90 个产物和 90 个 host asset 映射。
- `.local/state/collaboration.sqlite`：0 条协作事件。
- `.local/backups/20260923-storage-native/research.sqlite`：同样 4/283/283/1,729/90 条 ledger 记录；run、step、attempt、event、artifact payload 与当前库逐 ID 相同，但 host asset 路径映射是旧版本。

显式导入命令：

```sh
node workbenches/research/scripts/import-sqlite-archive.mjs /absolute/path/to/legacy-research/.local/state/research.sqlite
node workbenches/research/scripts/import-sqlite-archive.mjs /absolute/path/to/legacy-research/.local/state/collaboration.sqlite
node workbenches/research/scripts/import-sqlite-archive.mjs --archive-only /absolute/path/to/legacy-research/.local/backups/20260923-storage-native/research.sqlite
```

脚本用 Node `node:sqlite` 的 `readOnly` 连接和 `PRAGMA query_only=ON`；源 SQLite 永不写入。主文件与 WAL sidecar 的组合 SHA-256、表名、每行 JSON 和行数进入 `research_legacy_imports` / `research_legacy_rows`，按相同字节组合幂等。主 research 库投影到 shared `aw_*` 表，以保留旧 ID、state、payload、来源和模型标签，让既有阅读器继续显示报告；投影 host rows 标为只读，恢复、取消、意见、决策和修订操作会被拒绝。备份库的 workflow 账本逐 ID 与主库一致，因此使用 `--archive-only` 只保留其原始表/行及不同的旧路径映射，避免重复投影覆盖当前阅读视图。旧模型标签按历史原值保留，绝不重标成新 Agents SDK 运行。原 SQLite、导出报告、来源和 traces 都仍留在旧路径。导入前停止旧 API/worker，并完整保留主文件及其 `-wal` sidecar。

新系统备份需同时覆盖 PostgreSQL 数据库、选题/来源目录和派生文件。恢复 PostgreSQL 后核对研究状态及 payload；派生 Markdown 文件可由 artifact payload 重建。不要把旧 SQLite 数据库直接配置成新 runtime 的存储。

归档与阅读视图投影分别记录完成状态：先执行 `--archive-only`，之后仍可用普通导入补齐投影。同一历史 ID 已存在但 payload 或宿主映射不同会使事务失败；同一来源已投影到其他目标 workspace 时也会拒绝重新投影，不覆盖既有 PostgreSQL 数据。

网页连接使用一次校验后的 IPv4 DNS 结果，并将结果绑定到本次连接，禁止再次解析或自动回退到未校验的 IPv6 地址；重定向每跳重新校验。当前不支持仅有 IPv6 地址的来源站点。本机既有托管出口使用的合成 IPv4 地址仍遵循原出口配置，工具不修改代理设置。
