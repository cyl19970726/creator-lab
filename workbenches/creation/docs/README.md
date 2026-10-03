# 创作工作台文档导览

**内容形成 → 制作。** 选题、研究和完整稿在一个 `content` workflow 内反复修改：初稿暴露的问题可以触发补研究或调整主线。完整内容经一次创作者验收后，通过作品档案进入 B3 制作。

2026-10-03，用户授权合并原 B1/B2。原因是 MiMo 实跑虽然经过各环节代理 accept，普通读者仍难以理解训练前、训练过程、逐渐变强的机制、结果和资源消耗。工程跑通与内容质量是两项结论。旧 B1/B2 资产与当时判决保留，后续真人反馈使“已证明内容质量可迁移”的判断不成立。

新流程的代码验证和真实内容验证分别记录在[调优手册](05-tuning.md)。本次合并不代表审阅者已经校准，也不自动启动视频制作或发布。

## 按这个顺序读

| 文档 | 回答什么 |
| --- | --- |
| [核心思想](01-principles.md) | 为什么按内容和制作设交付节点 |
| [产品](02-product.md) | 创作者给什么、审什么、在哪里看 |
| [架构](03-architecture/README.md) | 执行、状态和代码位置；[作品档案与交接](03-architecture/brief-and-handoff.md) |
| [工作流](04-workflows/README.md) | [内容迭代](04-workflows/content.md)与[B3 制作](04-workflows/b3.md) |
| [调优手册](05-tuning.md) | 命令、测试与真实运行记录 |
| [决策与历史](06-decisions.md) | 当前决定与被替代的设计；[旧 B1](04-workflows/b1.md)、[旧 B2](04-workflows/b2.md)保留历史 |

通用方法在 agent-workflow：[调优循环](../../../vendor/agent-workflow/docs/tuning-loop.md)。

## 常用命令

在 `workbenches/creation` 下运行，Node 24：

```bash
pnpm stage content <input.json>
pnpm stage:render <topic> [runId]
pnpm stage:workbench <topic>
pnpm stage:trace <topic> [runId]
pnpm stage:accept <topic> <runId> --verdict accept --reviewer <名字>
```

只有接受完整内容后才生成给 B3 的作品档案。`revise` 记录修改意见；修订输入使用原目的与新的具体反馈。运行状态在 `.local/stages/<topic>/`，不进仓库。

## 文档怎么维护

Markdown 是唯一的源。仓库根目录运行 `pnpm docs:build`，生成到 Git 忽略的 `docs/site/` 并校验链接；`pnpm docs:serve` 后打开 `http://127.0.0.1:4340/docs/site/index.html`。修改 workflow 时升版本、记录依据及验证结果；历史结论注明适用时间，不能当作当前质量保证。
