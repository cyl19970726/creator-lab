# 开发与运维

使用 Node 24 和根目录 pnpm workspace。在启动 API 或 worker 前设置 `WORKFLOW_DATABASE_URL`，值放在本机 shell/私有运行配置中，不提交仓库。研究数据库需要独立 PostgreSQL database/schema 权限；首次启动会执行 shared ledger 与 research host/collaboration 的可重复迁移。API 仅监听 `127.0.0.1`。

| 变量 | 用途 |
| --- | --- |
| `WORKFLOW_DATABASE_URL` | 必填；研究工作台的 PostgreSQL live store 与 workflow ledger |
| `WORKBENCH_CONTENT_ROOT` | 来源 `manifest.json` 和冻结来源文件，默认 `.local/content` |
| `WORKBENCH_STATE_ROOT` | 本地私有运行状态目录，默认 `.local/state`；历史数据保留原处 |
| `WORKBENCH_ARTIFACT_ROOT` | 从 Postgres artifact payload 导出的 Markdown 文件，默认 `.local/artifacts` |
| `WORKBENCH_MEDIA_ROOT` | 预留的显式媒体输入根目录，当前 UI 流程不消费 |
| `PORT` | API 端口，默认 `4327` |

研究角色固定为 `gpt-6-luna` / medium。SIWC connection 使用已安装在本机的 Creator Lab 授权；没有连接时可通过 `pnpm --filter @signal-room/workflow-agent-sdk exec workflow-siwc login` 授权。运行工具不读取 Codex credentials，不要求或创建 OpenAI API key。SDK事件由 workflow ledger 保存，旧私有 trace 文件、原始来源、媒体和历史报告由操作者按路径备份，不会被运行代码清理。

## 检查

`pnpm --dir workbenches/research check` 构建 shared core、Agents SDK adapter、Skill snapshot、PostgreSQL RunStore、read model 和网页，再做 TypeScript 与 node:test 检查。PostgreSQL 集成回归使用专用、可丢弃数据库，设置 `WORKBENCH_TEST_DATABASE_URL` 后运行：

```sh
WORKBENCH_TEST_DATABASE_URL='postgresql://...' pnpm --dir workbenches/research test
```

集成测试用独立 workspace identity，并在结束时清理自己写入的 ledger 与 host 行；不要把变量指向已有研究库。测试覆盖跨 service handle 的持久运行与历史读取、幂等提交、worker lease、取消、报告/资产 lineage、版本绑定协作事件与官方 SDK 请求映射。真实模型研究会消耗现有 SIWC 计划额度，属于单独的端到端质量验证，不纳入常规 test/check。网页搜索回归验证 host tool 的结果与失败行为，不代表报告质量或用户接受。

历史 SQLite 归档的只读流程与数据范围见 [storage.md](storage.md)。备份旧数据时停止旧 API/worker，完整保留 SQLite/WAL 与对应来源、产物、媒体及私有 traces；归档脚本不会删除源文件。
