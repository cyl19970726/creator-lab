# Creator Lab 文档

Creator Lab 把三个工作台放在一个仓库里，各自独立使用，共享一份 agent-workflow。共享项目正在从现有执行包扩展为工作流执行与迭代底座：PostgreSQL 资产管理、一般 Agent SDK、评价比较与通用工作台都属于它的目标范围。creation 提供业务流程与扩展；研究和分析保留当前实现，不在本轮强制迁移。

先读共享项目的[产品定位](../vendor/agent-workflow/docs/product.md)、[Space 工作台产品与交互](../vendor/agent-workflow/docs/workbench-presentation.md)、[架构与职责](../vendor/agent-workflow/docs/architecture.md)、[建设状态](../vendor/agent-workflow/docs/harness-roadmap.md)，再进入具体业务。Space 按工作流生命周期组织方法、执行、运营观察和版本演进画布；业务与资产提供跨案例工作入口，评价就近展开。当前整体产品仍在整改，不将历史局部验收视为完整交付。

理解这些选择背后的原因，读[产品认知与逐层设计](product-understanding.md)：先讲深层目标、使用方式、价值积累和成功依据，再从整体工作台推到导航、各入口主体和具体操作，最后说明阶段取舍。这是设计推导，不能替代现行产品合同或实现状态。

| 工作台 | 做什么 | 从这里读 |
| --- | --- | --- |
| 创作 | 内容形成 → 制作；选题、研究和完整稿在同一 workflow 内反复调优 | [创作文档导览](../workbenches/creation/docs/README.md) |
| 研究 | 对齐问题、研究与证据综合、图文报告、审阅修订 | [研究工作台](../workbenches/research/README.md) |
| 分析 | 单帖内容还原、编导与画面分析；单博主作品研究 | [分析工作台](../workbenches/analysis/README.md) |

三者没有必经的先后顺序。流程图见[三个工作台](overview.md)，安装与启动见[仓库使用说明](../README.md)。

## 核心思想

**workflow 是调出来的。** 把一项业务交给 workflow，先做一个最简单、能真跑的第一版，然后在同一份冻结输入上反复真跑，读 trace 和资产找到出问题的那一层，只改一处并升版本，再重跑对比。调的过程中逐步定下三件事：看哪些 trace 和资产，关键流程怎么划分、在工作台里怎么显示，哪些资产给用户看。

- 通用方法：agent-workflow 的[调优循环](../vendor/agent-workflow/docs/tuning-loop.md)
- 在创作上的具体做法：[核心思想](../workbenches/creation/docs/01-principles.md)、[调优手册](../workbenches/creation/docs/05-tuning.md)

## 文档怎么组织

通用产品和技术合同在 agent-workflow 维护；业务文档说明领域流程、schema、阅读器、标准与接入。阅读顺序是**产品目的 → 工作台使用方式 → 技术架构 → 唯一实现状态 → 业务接入与运行**。文档不按每轮对话追加一套平级架构；现行定义修订在原页，日期化计划和实施记录保留历史证据。

| 要回答的问题 | 唯一主要入口 |
| --- | --- |
| 产品是什么、为谁解决什么问题 | [product.md](../vendor/agent-workflow/docs/product.md) |
| 深层目标如何推到使用场景、整体设计和阶段取舍 | [产品认知与逐层设计](product-understanding.md) |
| Space 长什么样、图与各类对象如何使用 | [workbench-presentation.md](../vendor/agent-workflow/docs/workbench-presentation.md) |
| 模块、包、服务与业务如何分工 | [architecture.md](../vendor/agent-workflow/docs/architecture.md) |
| 前端如何分包、通信、分批落地 | [前端架构](../vendor/agent-workflow/docs/space-frontend-architecture.md)与[实施计划](../vendor/agent-workflow/docs/space-frontend-implementation-plan.md) |
| 哪些已有、缺什么、下一步做什么 | [harness-roadmap.md](../vendor/agent-workflow/docs/harness-roadmap.md) |
| 某轮为什么判断通过、后来发现什么问题 | [认知与交付复盘](../vendor/agent-workflow/docs/cognition-execution-loop.md)及日期化实施记录 |

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
