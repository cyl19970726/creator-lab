# Creator Lab 文档

Creator Lab 把三个工作台放在一个仓库里，各自独立使用，只共享一份 agent-workflow 执行库：

| 工作台 | 做什么 | 从这里读 |
| --- | --- | --- |
| 创作 | 把“从选题到成片”做成 B1 定题 → B2 成稿 → B3 成片三个 workflow，靠在真实题目上反复调优成形 | [创作文档导览](../workbenches/creation/docs/README.md) |
| 研究 | 对齐问题、研究与证据综合、图文报告、审阅修订 | [研究工作台](../workbenches/research/README.md) |
| 分析 | 单帖内容还原、编导与画面分析；单博主作品研究 | [分析工作台](../workbenches/analysis/README.md) |

三者没有必经的先后顺序。流程图见[三个工作台](overview.md)，安装与启动见[仓库使用说明](../README.md)。

## 核心思想

**workflow 是调出来的。** 把一项业务交给 workflow，先做一个最简单、能真跑的第一版，然后在同一份冻结输入上反复真跑，读 trace 和资产找到出问题的那一层，只改一处并升版本，再重跑对比。调的过程中逐步定下三件事：看哪些 trace 和资产，关键流程怎么划分、在工作台里怎么显示，哪些资产给用户看。

- 通用方法：agent-workflow 的[调优循环](../vendor/agent-workflow/docs/tuning-loop.md)
- 在创作上的具体做法：[核心思想](../workbenches/creation/docs/01-principles.md)、[调优手册](../workbenches/creation/docs/05-tuning.md)

## 文档怎么组织

每个部分都按同一个顺序写：**导览 → 核心思想 → 产品 → 架构 → 工作流 → 调优手册 → 决策与历史**。左侧目录按这个顺序排。

| 部分 | 源文件 |
| --- | --- |
| 仓库 | `docs/`（本页、[三个工作台](overview.md)、[迁移记录](migration.md)）和根目录 `README.md` |
| 创作 | `workbenches/creation/docs/` |
| agent-workflow | `vendor/agent-workflow/README.md` 与 `docs/` |
| 研究、分析 | 各自的 `README.md` 与 `docs/` |

Markdown 是唯一的源。网页由生成器渲染，不手写 HTML：

```bash
pnpm docs:build   # 生成 docs/site/，检查所有站内链接和锚点
pnpm docs:serve   # 在仓库根目录起本机服务
```

然后打开 `http://127.0.0.1:4340/docs/site/index.html`。`docs/site/` 不进仓库。新增文档页面时，把它加进 `scripts/build-docs.mjs` 的 `NAV`；链接到不在 `NAV` 里的 Markdown 页面会导致生成失败。
