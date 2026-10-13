# PostgreSQL 与官方 Agents SDK 迁移

分析工作台只接受 PostgreSQL 配置。任务、租约、队列、批次、工作流账本和文本资产通过共享 PostgreSQL 组件及分析域表保存；原始媒体保存在受管文件目录，runtime 为可重建缓存。这不等于已完成共享 Space 的全部资产治理功能。

官方 `@openai/agents` 的 `Agent`、`Runner.run`、`tool` 执行模型与工具循环。SIWC 只保留 ChatGPT 授权和单次 Responses 请求传输，不回退到 Codex 执行或 API-key 计费。新运行默认 `gpt-6-luna`；历史模型标签不改写。

单帖流程保持：来源一致性检查 → 两轮 Builder 与宿主确定性取证 → 独立 Reviewer → 最多一次业务修订 → 登记。完整主报告只来自 Builder 的三个 `builderLenses`，API/UI 不改写结论。冻结输入、方法和报告 SHA 继续校验；证据未完整读取、引用未绑定或候选位置无效时拒绝审阅回执。

技术校验失败可以在官方 SDK 历史中进行有限纠正；业务审阅失败不会伪装为通过。修订报告保留 `revised_unverified`，未经再次独立审阅不能继承原报告的通过状态。

历史 SQLite 只由显式导入脚本只读打开；导入保留 ID、状态、来源及原文件，不自动重放历史队列。配置及步骤见[分析工作台](../README.md)。

[官方 SDK 接入](official-agents-sdk-migration.md) · [验收与已知限制](postgres-sdk-retirement-20261012.md)
