# 决策与历史

按时间记录做过的关键决定：决定是什么、为什么、现在在哪里体现。被替代的设计原文在[归档](archive/README.md)。

## 决策记录

| 日期 | 决定 | 为什么 | 体现在 |
| --- | --- | --- | --- |
| 2026-09-26 | 创作工作台从 token-economics 迁入 creator-lab，与研究、分析并列，共用一份固定版本的 agent-workflow | 三个工作台各自独立，只共享执行库 | [仓库迁移记录](../../../docs/migration.md)、[创作迁移记录](archive/migration-from-token-economics.md) |
| 2026-09-29 | 用户授权全新实现创作，不保留旧 UI、API、CLI、目录和数据库兼容，可以修改 agent-workflow | 旧实现是迁入的基线，不是架构约束 | 仓库 `AGENTS.md`；文章应用首版：[首个实现 PR](archive/article-platform-first-pr.md) |
| 2026-09-29 | 平台设计 v0.3：B1/B2/B3 是可组合的职责，TypeScript 网页 / API / worker | 为文章与视频共用一个平台 | [平台设计 v0.3](archive/creation-platform-design-v0.3.md)（已归档） |
| 2026-09-30 | **停止扩平台，先让 B1/B2/B3 在一个真实题目上跑好** | 复盘发现：验收题是虚构的，真实题目零次运行；平台越建越大，内容仍由主 Agent 手工完成 | [核心思想](01-principles.md#以前为什么一直做不好) |
| 2026-09-30 | 一个阶段 = 一个决定 + 一份主资产 + 一张标准卡；每个角色防一种失败；阶段停在创作者关口，意见写回标准卡 | 出错时能知道回到哪一步；人的判断要能被审阅角色学到 | [工作流](04-workflows/README.md) |
| 2026-09-30 | 内容只能由 workflow 产出，主 Agent 只编排与审阅 | 以前七版视频都在 workflow 外手工完成，workflow 从未被检验 | [核心思想](01-principles.md#5-内容必须是-workflow-做出来的) |
| 2026-09-30 | workflow 靠调优成形：同一冻结输入、一次改一处、升版本、前后对比；审阅者用正反案例校准 | 第一版的错法事先猜不到，只有 trace 里看得见 | [调优手册](05-tuning.md) |
| 2026-09-30 | 阶段 Agent 默认 `gpt-6-sol`（执行 medium、判断 high），Codex CLI 用 ChatGPT 应用内版本；避免大规模多 Agent 编排 | 关键判断用强推理；SDK 自带 CLI 拒绝 GPT-6；控制额度 | [架构](03-architecture/README.md#角色的运行环境) |
| 2026-09-30 | B3 包住现成的视频模板装配线，只加画面设计者和成品检查两个 Agent；检查者必须看图 | 装配线是确定的，模板的机器闸来自真实事故；视觉验收不能交给看不见图的 Agent | [B3](04-workflows/b3.md) |
| 2026-09-30 | 阶段之间用有版本的作品档案交接，按角色切片；冷读者隔离 | 会话里手工拼输入，丢了观众问题、参照作品教训和主编给制作的话 | [作品档案与交接](03-architecture/brief-and-handoff.md) |
| 2026-09-30 | 工作台先用生成的静态页面，按阶段一行、结论先行；暂不接进 React 应用 | 先看清要显示什么，再做成产品；调优期间页面要跟着改 | [产品](02-product.md#在哪里看) |
| 2026-09-30 | agent-workflow 增加：重复 step key 报错、按角色的 Codex 环境、开跑前模型探针、trace 摘要与按 thread id 找会话；并写入“workflow 是调出来的”核心思想 | 这几类问题都在调优中真实发生过，属于通用 harness 能力 | agent-workflow [调优循环](../../../vendor/agent-workflow/docs/tuning-loop.md)、[Harness 路线](../../../vendor/agent-workflow/docs/harness-roadmap.md) |
| 2026-09-30 | 文档以 Markdown 为源、生成一个站点；按导览 → 核心思想 → 产品 → 架构 → 工作流 → 调优 → 决策组织；旧设计归档 | 以前的文档分散在手写 HTML、生成 HTML 和多份 md 里，状态互相矛盾 | 本目录；`pnpm docs:build` |

## 否定过的做法

| 做法 | 为什么不做 |
| --- | --- |
| 继续扩平台、先做完整网页工作台 | 平台越大，越难判断哪个改动真的让内容变好；先在命令行和静态页上把方法调好 |
| 用大规模多 Agent 编排（几十个 Agent 并行）做设计或评估 | 额度有限；这件事的瓶颈是真跑与读 trace，不是并行度 |
| workflow 跑不出来时由主 Agent 补内容 | 会把“workflow 不行”藏起来，这一轮调优也就没有意义 |
| 按阶段页面的 run 状态或测试数判断“做好了” | 执行完成、结构有效和内容合格是不同的事；内容以创作者关口和标准卡为准 |
