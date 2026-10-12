# 创作工作台

创作把完整内容变成可验收的作品：CONTENT 负责研究、定位、写作和创作者交接；B3 负责真实配音、画面设计、装配、检查与渲染；交付与反馈仍是独立生命周期。研究和分析是可选材料来源，三个工作台没有强制先后顺序。

当前运行统一使用共享 PostgreSQL workflow ledger 与官方 OpenAI Agents SDK。CONTENT 的 Space 工作台和业务命令见[创作文档导览](docs/README.md)。B3 保留真实视频制作 workflow，明确使用 `PostgresWorkflowRunStore` 和 `OpenAIAgentsSdkRunner`，不是 Space 中的合成 fixture。

## B3 制作入口

从仓库根目录使用 Node 24，为创作配置专用 PostgreSQL 数据库及 SIWC 授权：

```sh
pnpm --filter @creator-lab/creation b3 ./path/to/input.json
```

输入是 `src/stages/b3.ts` 定义的严格 B3 JSON，必须含已接受的版本化作品档案、绝对 `episodeDir`、`templateDir` 和 `referenceDir`。默认模型是 `gpt-6-luna` / low；可用 `--model` 和 `--effort` 显式调整。PG 运行账本由 `WORKFLOW_DATABASE_URL` 指定；私有 run 输入、输出、截图和视频副本保存在 `CREATION_STATE_ROOT`（默认 `.local/creation`），不会写入仓库。

B3 通过共享受限 workspace tools 给设计角色开放工程/参考读取、`frames-spec/` 写入及固定 `python3 scripts/build-frames.py --check` 命令；检查角色只读取本轮真实截图像素。其他配音、装配、技术检查、截图、渲染及视频哈希保存仍由原业务 workflow 执行。

历史 Codex/SQLite 原型已退役，旧作品、数据库、报告、媒体和 trace 保持原样，不自动导入。只读历史 SQLite 文件归档工具为 `history:archive-sqlite`，它仅以 SQLite `readOnly` 模式做完整性核验，不启动或恢复旧 runtime。`tooling/social-publish` 和项目内 skills 仍是独立的交付工具与方法资料。

## 检查

```sh
pnpm --filter @creator-lab/creation typecheck
pnpm --filter @creator-lab/creation test
pnpm --filter @creator-lab/creation build
```

测试通过不等于真实模型质量或创作者验收通过；两者需分别依据真实产物评估。
