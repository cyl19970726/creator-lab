# Creator Lab

把现有三个工作台放在同一个仓库，各自独立使用。

| 工作台 | 保留功能 | 代码与使用说明 |
| --- | --- | --- |
| 研究 | 对齐问题、研究与证据综合、图文报告、审阅修订 | [research](workbenches/research/README.md) |
| 分析 | 单帖内容还原、编导与画面分析；单博主作品研究 | [analysis](workbenches/analysis/README.md) |
| 创作 | 内容迭代 → B3 制作的 workflow；文章应用 | [creation](workbenches/creation/README.md) |

研究、分析、创作没有必经的先后顺序，各自保留业务流程、界面和完整 Skill 包，共享 `vendor/agent-workflow`。三个工作台的代码接线与 PostgreSQL + 官方 OpenAI Agents SDK 迁移已完成，旧共享 Codex／SQLite 执行包与 SIWC runner alias 已移除。回归证据包括 root build、shared 600 项实际 PG 测试、analysis 613 项回归加 9 项定向 Reviewer 修复检查、research 33 项及实际历史导入和 UI 阅读、creation PG 回归与配置迁移。Creation launcher 已切换到新配置；main 与 first-design 配置及 metadata 均为 `ordinary-content-20261012`，未触发新模型运行或方法采用，原有 5 条 run 记录保持不变。新单帖 run `a33ae133-94a8-401d-b5f2-eebc1e572854` 已完成，历时 546.287 秒、36 次模型请求；报告和三 Lens 图片已在浏览器可读。候选状态为 `revised_unverified`：Reviewer 的一条相矛盾 minor finding 已正确驳回，因此不能称独立审阅通过。只读审计确认此前完整性缺口已修复，仍有少量精度备注；质量调优继续，不宣称整体质量成熟或全质量通过。旧 SQLite 数据只允许明确选择的只读历史导入，不用于新 run，也不作为 PostgreSQL 连接失败时的执行 fallback。旧 Codex trace 只能作为只读历史证据。

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
pnpm creation          # 新创作工作台/API，4337
pnpm creation:worker   # 独立终端：执行显式提交的创作任务
```

各工作台的本地资料配置见各自 README。私有报告、运行数据库和媒体不随公开仓库分发。以上启动命令保留现有入口；三台代码迁移与指定回归、creation launcher 配置切换和单帖新一轮主执行验收均已完成。该单帖候选仍为 `revised_unverified`，Reviewer finding 被驳回且没有独立审阅通过结论，质量调优仍在继续。历史 SQLite 读取必须显式走只读导入，不会启动 SQLite 执行器或自动重放旧队列。

## 文档

[文档导览](docs/README.md) · [三个工作台与流程图](docs/overview.md) · [创作文档](workbenches/creation/docs/README.md) · [迁移记录](docs/migration.md)

Markdown 是源，生成可浏览的网页并检查站内链接：

```sh
pnpm docs:build
pnpm docs:serve
```

打开 `http://127.0.0.1:4340/docs/site/index.html`。

## 技术栈

- 目标共享运行基线：PostgreSQL 执行账本与官方 `@openai/agents` SDK；SIWC 仅是当前受限 runner 的 ChatGPT 授权和 Responses transport。
- 保留各工作台自己的 UI、业务流程和数据适配；代码迁移与指定回归已完成。单帖主执行和报告／三 Lens 浏览器阅读已完成，候选仍为 `revised_unverified`，业务质量调优继续。
- 历史兼容：SQLite 仅显式只读导入；Codex trace 仅由 read-model 解码阅读。新 workflow 不使用 SQLite/Codex 执行 fallback。
- 公用：Node 24、pnpm workspace、一份固定版本的 agent-workflow；技能快照由独立 `@signal-room/workflow-skill-snapshot` 包提供。

本次保留各工作台现有 UI 与业务方法，执行和存储的统一代码迁移与指定回归已完成；单帖主执行验收通过并完成浏览器阅读，Reviewer 未通过独立审阅门，候选仍为 `revised_unverified`，质量调优继续。每个工作台的 `.agents/skills/` 包含方法及脚本、Schema、参考资料等完整资源，无全局安装；共享快照 helper 也只在项目内使用，不安装全局 skill。
