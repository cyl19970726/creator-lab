---
name: lapian-workflow
description: 通过现有拉片执行器与共享 Operator CLI 认识方法、阅读完整或失败案例、显式发起有界完整/局部试验，保存准确评价与下一步。
---

# 拉片的业务执行与调优

本技能只属于 analysis 项目。业务目标是让创作者从一条真实帖子理解其完整内容、编导选择和视觉剪辑，并知道哪些拍法在什么条件下可复用。主文和综合总结来自 Builder；Reviewer 是独立审阅层，宿主不补写结论。点赞等数据只按冻结采集口径解释，缺失不变成零，不把高赞归因到某一刀。

## 接手已有工作

宿主提供 `WORKFLOW_OPERATOR_BASE_URL`、`WORKFLOW_OPERATOR_SPACE_ID` 和私有 `WORKFLOW_OPERATOR_TOKEN_FILE`。在仓库根执行 `pnpm --silent --dir vendor/agent-workflow operator COMMAND`。先读 `space`、`understanding`、`cases`。不要从空 Space 重建历史，也不要从最新时间推断已采用。

选 Case 后用 `case ID` 找全 run；从 `run-evidence RUN_ID` 定位准确版本、输入、产物和缺口，再按返回命令读 `asset ID`、`process RUN_ID`、节点及原生证据。完整根流程中的 source-check、Builder、Reviewer、repair 是实际子运行；逐个子运行阅读，根成功不能替代子流程证据。历史 `executionMode:imported` 不是新 harness 运行；原 artifact SHA 与报告文件 SHA 各有作用，不混用。

当前方法由代码和实际 prompt、工具合同生成；`version ID`、`node VERSION_ID NODE_ID` 与普通工作台的 Archify 图共用定义。历史指令只在字节匹配保存的 SHA 时恢复，否则未知，绝不用当前 prompt 补造原方法。保存的业务理解是事后有来源的认识，不是最初设计史。

## 正文、失败和审阅

读三视角的连续正文及最后综合总结，再从专业 reader 返回原片、帧和字幕。核对关键主张实际引用哪段证据；结构合格或 Reviewer 无 findings 不代表正确。修订后未再独立审阅必须保留 `revised_unverified`。外部原片审计与 workflow Reviewer 分别阅读。

失败若留下三视角草稿，可读标为 `unpublished` 的证据文档；它不是正式集成候选。草稿文件不存在、缺保存 hash 或只有部分事件时明确保留缺口。不能用前期通过的单篇 draft 冒充完整交付。

## 有界业务与局部实验

先读 `execution-state`。宿主当前初轮额度是一个完整 Case（60 分钟）和一个 Reviewer-only（15 分钟），Luna medium。固定 release 的额度不因重启或换请求重置。准备不调用模型；start 才执行。已有使用选择与批次不会变化。

准备私有 JSON：

```json
{"operation":"inputs-freeze","input":{"kind":"full","sourceWorkflowRunId":"准确历史完整run","caseLabel":"harness-full"}}
```

执行 `method-command --file /absolute/private/request.json`。读回准备收据中的输入、候选 asset/report SHA、prompt、SDK、模型与预算，核对完整方法；此动作不算已经运行。局部试验以 `kind:"reviewer"` 和 `candidateArtifactId` 指向已读的准确候选；不加 repair 或 repeat。

决定开始后提交：

```json
{"operation":"start","input":{"preparedId":"准备收据的准确ID"}}
```

仍用 `method-command --file`。宿主开始前复验冻结快照，漂移直接拒绝；不得用改 ID 绕过预算。`pnpm --dir workbenches/analysis lapian:harness status PREPARED_ID` 读终态。进程成功、完整业务成功与内容质量分别判断；超时或失败先读保存证据，不自动重跑。

## 判断下一步

沿共享 `case-run-evidence` 技能：`review-subjects RUN_ID` → 对准确 target `observe-asset`（或已支持的未发布响应入口）→ 亲读正文 → `review-save` 保存 good/bad/improvement/unresolved。用真实认证 Agent 身份和观察收据，不冒充人类。再保存 `disposition-save` 与 `diagnosis-save`，引用相同资产、方法和输入。

将问题分成修本次稿、补材料、专业方法、评价者校准、harness故障或暂不改。可以不产生候选；有候选也不自动采用。诊断写观察、竞争解释、未知和最小辨别试验，不用单次耗时声称稳定提速。无法通过现有评价合同记录的失败文档，明确报告限制并保留准确来源，不能改成正式产物绕过合同。

运维初始化和历史迁入见 [接入说明](../../../docs/lapian-harness.md)。私有报告、trace、媒体、凭据与数据库不提交 Git。
