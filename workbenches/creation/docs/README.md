# 创作工作台文档导览

**一句话：** 把“从选题到成片”做成 B1 定题 → B2 成稿 → B3 成片三个 workflow。内容由 workflow 里的 Agent 产出，每个阶段停在创作者的关口；阶段之间用有版本的作品档案交接。workflow 靠在真实题目上一轮一轮调优成形。

状态（2026-09-30）：三个阶段都已实现，并在一个题目（Kimi/GLM「弱模型怎么训出强模型」）上从 B1 跑到 B3 成片（占位配音）。调优到 B1 v7、B2 v7、B3 v9。还没换题验证迁移，发布与数据回流也还没接上。

## 按这个顺序读

| 顺序 | 文档 | 回答什么 |
| --- | --- | --- |
| 1 | [核心思想](01-principles.md) | 为什么这样拆、为什么要反复调、为什么以前一直做不好 |
| 2 | [产品](02-product.md) | 创作者用它做什么，每个阶段交出什么、在哪里看、什么时候需要人 |
| 3 | [架构](03-architecture/README.md) | 代码在哪、Agent 在什么环境里跑、状态存在哪；[作品档案与交接](03-architecture/brief-and-handoff.md)；[文章应用合同](03-architecture/article-app.md) |
| 4 | [工作流](04-workflows/README.md) | 三个阶段的本质问题、角色、最终形态与调优记录：[B1](04-workflows/b1.md) · [B2](04-workflows/b2.md) · [B3](04-workflows/b3.md) · [发布后](04-workflows/after-publish.md) |
| 5 | [调优手册](05-tuning.md) | 一轮怎么跑、用哪些命令、怎么评估、踩过哪些坑、下一轮做什么 |
| 6 | [决策与历史](06-decisions.md) | 做过哪些关键决定、为什么；已归档的旧设计在 [归档](archive/README.md) |

通用方法（不限于创作）在 agent-workflow：[调优循环](../../../vendor/agent-workflow/docs/tuning-loop.md)。

## 常用命令

在 `workbenches/creation` 下运行，Node 24：

```bash
pnpm stage b1 <input.json>                                        # 跑一个阶段
pnpm stage:accept <topic> <runId> --verdict accept --reviewer <名字>  # 创作者关口：记录判决并生成下一版作品档案
pnpm stage:workbench <topic>                                       # 作品工作台页面
pnpm stage:trace <topic> [runId]                                   # 每个角色每次调用做了什么
```

完整说明见[调优手册](05-tuning.md#命令)。运行状态在 `.local/stages/<topic>/`，不进仓库。

## 文档怎么维护

- Markdown 是唯一的源；网页由仓库根目录的 `pnpm docs:build` 生成到 `docs/site/`（不进仓库），`pnpm docs:serve` 后打开 `http://127.0.0.1:4340/docs/site/index.html`。
- 生成时会检查所有站内链接和锚点，坏链接直接报错。
- 每改一版 workflow，就在对应阶段文档的调优记录里加一行；结论变了就更新[调优手册](05-tuning.md)的评估表。
- 被替代的设计移到 [归档](archive/README.md)，并在开头写明被什么替代。
