# Creator Lab

把现有三个工作台放在同一个仓库，各自独立使用。

| 工作台 | 保留功能 | 代码与使用说明 |
| --- | --- | --- |
| 研究 | 对齐问题、研究与证据综合、图文报告、审阅修订 | [research](workbenches/research/README.md) |
| 分析 | 单帖内容还原、编导与画面分析；单博主作品研究 | [analysis](workbenches/analysis/README.md) |
| 创作 | 内容迭代 → B3 制作的 workflow；文章应用 | [creation](workbenches/creation/README.md) |

研究、分析、创作没有必经的先后顺序。保留各工作台已有流程、界面和完整 Skill 包；只共享 `vendor/agent-workflow`。本次不加入统一业务平台或强制跨台流程。

## 安装

Node.js 24，pnpm 10.28.2。

```sh
git clone --recurse-submodules https://github.com/cyl19970726/creator-lab.git
cd creator-lab
pnpm install --frozen-lockfile
pnpm build
```

## 启动

```sh
pnpm research          # 研究工作台，4327
pnpm research:worker   # 需要执行研究时，另开终端
pnpm analysis          # 分析 API + 网页开发预览
pnpm creation          # PostgreSQL Space 创作工作台，4397
```

各工作台的本地资料配置见各自 README。私有报告、运行数据库和媒体不随公开仓库分发。研究执行由独立 worker 处理；分析沿用内嵌 worker 配置，查看历史数据时使用其 README 的只读模式。

## 文档

[文档导览](docs/README.md) · [三个工作台与流程图](docs/overview.md) · [创作文档](workbenches/creation/docs/README.md) · [迁移记录](docs/migration.md)

Markdown 是源，生成可浏览的网页并检查站内链接：

```sh
pnpm docs:build
pnpm docs:serve
```

打开 `http://127.0.0.1:4340/docs/site/index.html`。

## 技术栈

- 研究：React / Vite、Fastify、独立 worker、PostgreSQL。
- 分析：React / Vite、Express、分析 worker、PostgreSQL。
- 创作：TypeScript、共享 Workflow Space 工作台、PostgreSQL；B3 使用受控工具制作与检查媒体。
- 公用：Node 24、pnpm workspace、一份固定版本的 agent-workflow。

新执行统一使用官方 OpenAI Agents SDK 的 Agent / Runner / tool，默认模型为 `gpt-6-luna`；SIWC 保留 ChatGPT 授权及 Responses 传输。旧 Codex／SQLite 执行包已移除，SQLite 只供显式只读历史导入。迁移执行与构建验证完成，Reviewer 质量仍有未通过项，见[迁移验收与限制](workbenches/analysis/docs/postgres-sdk-retirement-20261012.md)。每个工作台的 `.agents/skills/` 包含方法及脚本、Schema、参考资料等完整资源，无全局安装。
