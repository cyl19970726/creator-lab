---
name: lapian-workflow
description: 通过现有拉片执行器与共享 Operator CLI 认识方法、阅读完整或失败案例、显式发起有界完整/局部试验，保存准确评价与下一步。
---

# 拉片的业务执行与调优

本技能只属于 analysis 项目。业务目标是让创作者从一条真实帖子理解其完整内容、编导选择和视觉剪辑，并知道哪些拍法在什么条件下可复用。主文和综合总结来自 Builder；Reviewer 是独立审阅层，宿主不补写结论。点赞等数据只按冻结采集口径解释，缺失不变成零，不把高赞归因到某一刀。

## 接手已有工作

宿主提供 `WORKFLOW_OPERATOR_BASE_URL`、`WORKFLOW_OPERATOR_SPACE_ID` 和私有 `WORKFLOW_OPERATOR_TOKEN_FILE`。在仓库根执行 `pnpm --silent --dir vendor/agent-workflow operator COMMAND`。先读 `space`、`understanding`、`cases`。不要从空 Space 重建历史，也不要从最新时间推断已采用。

选 Case 后用 `case ID` 找全 run；从 `run-evidence RUN_ID` 定位准确版本、输入、产物和缺口，再按返回命令读 `asset ID`、`process RUN_ID`、节点及原生证据。完整根流程中的 source-check、Builder、Reviewer、repair 是实际子运行；逐个子运行阅读，根成功不能替代子流程证据。历史 `executionMode:imported` 不是新 harness 运行；原 artifact SHA 与报告文件 SHA 各有作用，不混用。

对导入或 external-host run，可用普通 Operator 命令 `native-events RUN_ID [--after N] [--limit 1..100]` 读取原生账本白名单摘要；它不调用模型，也不生成假的 Space session/context。摘要只含序号、类型、时间、step/attempt、传输/工具摘要和有限响应元信息；`function_call` 是工具调用，不是最终回答。没有 `ws_session` 的 `occurrence-responses` 不等于没有原生记录。

从完整 root 的 native-events children 列表按真实 child runId 进入生产子流程，再读取其 `run-evidence`、`process` 与资产。child 的状态、parent step 和 binding 状态来自原生父子关系；资产仍归实际 producer run。不要伪造子流程或把 child 产物挪归 root。

当前方法由代码和实际 prompt、工具合同生成；`version ID`、`node VERSION_ID NODE_ID` 与普通工作台的 Archify 图共用定义。历史指令只在字节匹配保存的 SHA 时恢复，否则未知，绝不用当前 prompt 补造原方法。保存的业务理解是事后有来源的认识，不是最初设计史。

## 设计并发布当前方法

发布前先阅读 `space`、`understanding`、`cases` 和相关 run-evidence。将真实目标、停止条件、主/辅助产物和历史边界写入有来源的设计。私有 JSON 只填 `title`、`content`、`sources`、`changeReason`、`capability:null`；`design-prepare --file ABS_INPUT --out ABS_READY` 会自动取得当前理解的 revision/hash、作者身份和预期设计 revision。然后 `design-save --file ABS_READY` 保存设计。

```sh
pnpm --silent --dir vendor/agent-workflow operator design-prepare --file /absolute/private/design-input.json --out /absolute/private/design-ready.json
pnpm --silent --dir vendor/agent-workflow operator design-save --file /absolute/private/design-ready.json
pnpm --silent --dir vendor/agent-workflow operator method-preview --design <设计revision-id>
pnpm --silent --dir vendor/agent-workflow operator method-publish --design <设计revision-id> --expected <preview返回的versionId>
```

预览会用当前 analysis factory 读取实际 prompt、agent 配置、tool manifest、报告 schema、skill、实现文件与 SDK/lockfile hash。动态参数若无法从静态快照准确取得，只显示工具名及运行条件，不补造 schema。完整方法版本是 `post.analyze`（领域 code revision `v11`）；单独 Reviewer 版本是 `post.review`（领域 code revision `v6`）。共享 Space 的 method version revision/hash 是宿主版本身份，与领域 code revision 分开。

发布后读 `versions`、`version VERSION_ID`，再看 `node VERSION_ID source-check`、`builder`、`reviewer`、`repair`、`candidate-terminal`。完整方法是 source-check → Builder → Reviewer；有效 findings 才进入一次 repair。来源冲突/不确定及 Builder、Reviewer、repair 的失败或 needs-review 都会停止相应分支。默认只输出候选，不登记业务版本；repair 后状态为 `revised-unverified`，不做第二次 Reviewer。Reviewer-only 方法只有读取已有候选与冻结证据的 Reviewer，不执行 Builder、source-check、repair 或登记。方法定义只是声明，不是运行能力验证或质量结论。

共享版本把 Builder 报告标为 primary；内容还原、编导逻辑、视觉剪辑和 finalSummary 是连续主文。候选封装是 supporting；review 和 revision 是 auxiliary assessment/revision。历史案例和资产始终是 historical observation，不因发布新方法而改绑当前方法。

## 正文、失败和审阅

读三视角的连续正文及最后综合总结，再从专业 reader 返回原片、帧和字幕。核对关键主张实际引用哪段证据；结构合格或 Reviewer 无 findings 不代表正确。修订后未再独立审阅必须保留 `revised_unverified`。外部原片审计与 workflow Reviewer 分别阅读。

失败若留下三视角草稿，可读标为 `unpublished` 的证据文档；它不是正式集成候选。草稿文件不存在、缺保存 hash 或只有部分事件时明确保留缺口。不能用前期通过的单篇 draft 冒充完整交付。

## 有界业务与局部实验

先读 `execution-state`。宿主当前额度是一次完整 Case（60 分钟）和一次 Reviewer-only（15 分钟），`gpt-6-luna`、reasoning medium。固定 release 的额度不因重启、换案例或发布新方法而重置。准备不调用模型；start 才执行。已有使用选择与批次不会变化。

输入准备可能另有 program-only run；把它当作准备轨迹阅读，不能当成付费完整流程的 root。以 receipt 的 `nativeWorkflowRunId` 识别实际 root。

准备私有 JSON：

```json
{"operation":"inputs-freeze","input":{"kind":"full","sourceWorkflowRunId":"准确历史完整run","caseLabel":"harness-full"}}
```

执行 `method-command --file /absolute/private/request.json`。读回准备收据中的输入、候选 asset/report SHA、prompt、SDK、模型与预算，核对完整方法；此动作不算已经运行。局部试验以 `kind:"reviewer"` 和 `candidateArtifactId` 指向已读的准确候选；也可指定来源根 run ID 解析唯一候选，但不能同时提供这两项。不加 repair 或 repeat。命令格式以 `pnpm --silent --dir vendor/agent-workflow operator help` 为准。`inputs-freeze` 响应含 `receipt` 和 `binding`；核对来源、输入 hash、方法快照 hash、模型/时限，以及 binding 的 `spaceId`、`caseId`、`inputManifestId`、`workflowVersionId` 和 `methodHash`。scope 由宿主注入，不手填。

决定开始后提交：

```json
{"operation":"start","input":{"preparedId":"准备收据的准确ID"}}
```

仍用 `method-command --file`。宿主开始前复验冻结快照，漂移直接拒绝；不得用改 ID 绕过预算。`execution-state` 读 receipt；`pnpm --dir workbenches/analysis lapian:harness status PREPARED_ID` 无模型地 reconcile receipt、原生 run 与共享 Space 绑定/资产，可能补齐观察记录，但不会启动执行。需要跟踪时用 `pnpm --dir workbenches/analysis lapian:harness follow PREPARED_ID`；它每 4 秒无模型同步状态，只在状态、rootRunId 或 syncGap 变化时输出，离开 launching/running 后退出。

分别核对 `processOutcome`、`businessOutcome` 和 `qualityAcceptance`：宿主子进程退出成功不代表业务完整，原生 workflow 完整也不代表内容质量通过。`qualityAcceptance` 在原片与证据被独立审计并保存前应保持 unknown。

失败不会自动重试。仅在用户明确授权一次追加完整执行、宿主的一次性授权与原失败 receipt 匹配时可准备重跑；它复用原 Case、同一完整来源与冻结材料，最多 60 分钟，固定 `gpt-6-luna` / medium，授权不能再用于第二次追加。没有对应授权时停止并保留失败证据。当前宿主只支持 full 和 reviewer 两种执行入口，保留 analysis 既有 Builder-only benchmark 能力边界；不提升额度、不自动采用候选。Space UI 可查看同步后的 Case、run、process 与 assets。

## 判断下一步

沿共享 `case-run-evidence` 技能：`review-subjects RUN_ID` → 对准确 target `observe-asset`（或已支持的未发布响应入口）→ 亲读正文 → `review-save` 保存 good/bad/improvement/unresolved。用真实认证 Agent 身份和观察收据，不冒充人类。再保存 `disposition-save` 与 `diagnosis-save`，引用相同资产、方法和输入。

当前工作台仅对真实 `post.build`、`post.review`、`post.repair`、`post.source-check` run 显式开放观察评价、处置和诊断。其它 auxiliary workflow 默认只读；这不授予启动执行、修改方法或发布版本的权限。

将问题分成修本次稿、补材料、专业方法、评价者校准、harness故障或暂不改。可以不产生候选；有候选也不自动采用。诊断写观察、竞争解释、未知和最小辨别试验，不用单次耗时声称稳定提速。无法通过现有评价合同记录的失败文档，明确报告限制并保留准确来源，不能改成正式产物绕过合同。

运维初始化和历史迁入见 [接入说明](../../../docs/lapian-harness.md)。私有报告、trace、媒体、凭据与数据库不提交 Git。
