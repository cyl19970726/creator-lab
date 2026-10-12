# 当前运行入口与历史数据

旧 `apps/api`、Codex runner、SQLite 可写控制库、worker 和关联网页原型已经退役。当前运行使用共享 PostgreSQL workflow ledger、官方 Agents SDK runner 与 SIWC 授权；本页说明实际入口，不为旧 prototype 保留兼容服务。

CONTENT 的业务运行入口为 `content:space`，只在操作者明确提交 `run`、`revise`、`experiment` 或派发排队任务时调用模型。案例、方法版本、workflow run、会话和评价写入共享 PostgreSQL Space。CONTENT workbench 运行 `content:workbench`，在本机可信入口读取和操作同一 Space。

真实 B3 生产通过 `pnpm --filter @creator-lab/creation b3 <input.json>` 发起。CLI 校验接受的作品档案及工程目录，然后用 `PostgresWorkflowRunStore` 记录执行，以 `OpenAIAgentsSdkRunner` + `SiwcAuth` 调用 `gpt-6-luna`（默认 low）。画面设计角色通过共享 workspace tools 读取当前工程和只读参考、只写 `frames-spec/`，并调用固定的帧规格检查命令；成品检查角色读取本轮 run/round 绑定的真实图片像素。配音、装配、对时、技术检查、快照、渲染和视频归档仍由 `src/stages/b3.ts` 中的业务流程实现。

```sh
export WORKFLOW_DATABASE_URL='postgresql://…'
pnpm --filter @creator-lab/creation b3 ./input.json --model gpt-6-luna --effort low
```

`CREATION_STATE_ROOT` 可指定运行私有文件根目录，默认 `.local/creation`。输入、run 元数据、真实截图、产物以及本轮视频副本保存在 `runs/<runId>/`。这些私有文件不入仓；PG 保存 workflow ledger 和共享资产记录。模型请求与 workflow 质量分别验证，构建通过不等于真实成片通过。

## 历史文件

退役不删除既有历史数据库、reports、media、traces、SIWC auth 或其他私有证据，也不自动导入或改写它们。历史 SQLite 只能通过 `history:archive-sqlite` 归档工具以 `readOnly` 方式核验；它复制普通文件并计算完整性清单，不包含旧 API/worker、数据库写入逻辑或继续运行入口。恢复也只是将文件还原到新的独立目录，不会启动旧 runtime。

```sh
pnpm --filter @creator-lab/creation history:archive-sqlite -- archive /path/to/inert-history /path/to/new-archive
pnpm --filter @creator-lab/creation history:archive-sqlite -- restore /path/to/archive /path/to/restored-files
```

旧 workflow、界面和 Codex/SQLite 部署文档位于 `docs/archive/` 或在各业务调优记录中作为历史证据阅读，不是当前可运行操作说明。历史会话可用于校准与溯源；不能仅凭旧配置推断其真实模型访问或当前权限。
