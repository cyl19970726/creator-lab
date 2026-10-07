# 创作如何接入共享底座

此 URL 曾是一份覆盖服务器、harness、执行器、存储、评价和工作台的长篇创作方案。那些要求属于可复用的 agent-workflow 产品，已归到共享 [产品与动机](../../../../vendor/agent-workflow/docs/product.md)、[分层架构](../../../../vendor/agent-workflow/docs/architecture.md)及[目标与差距](../../../../vendor/agent-workflow/docs/harness-roadmap.md)。保留本页作为旧链接的导航，不再在创作文档内维护第二套通用方案。

创作接入共享底座时只需提供：

- `creation.content` 和 `creation.b3` 的业务流程、角色、工具及标准；内容内允许研究、主线与完整稿往返。
- 完整内容和 B3 成品的主资产、阅读视图、业务验收依据；创作者分别验收完整稿与成品。
- 内容验收后的版本化作品档案，以及 B3 各角色读取的交接切片。
- C1 交付／发布、C2 反馈的业务规则和授权边界；现阶段不自动发布。

共享层负责执行与版本迭代、运行历史、四问评价、Agent A、比较与采用、通用工作台、Agent SDK／Codex 节点控制、trace／session 和以 PostgreSQL 为主的持久 harness。创作可以给共享界面增加作品展示，但不应把通用控制能力长期复制在业务项目。研究和分析工作台保持独立，可按需提供材料。当前阶段不考虑独立或临时 VM 生命周期。

当前 `apps/workbench`、`src/workbench` 是已实现的**本地原型**，使用 SQLite、文件与 Codex；它没有自动迁入共享的[可选 PG Space 层](../../../../vendor/agent-workflow/docs/space-storage.md)。共享层已有节点合同、runtime bridge、只读控制台和 SIWC Responses 适配；创作确定性 CONTENT、人工交接、B3 fixture 与 v2 演示已通过。一般 Agents SDK、完整媒体存储、真实 B3 生产和正式部署仍未完成。原型的使用、部署示例和验收边界见[业务工作台](business-workbench.md)，迁移顺序见[接入计划](../workbench-implementation-plan.md)；模型与成片质量仍需在真实案例中单独验证。
