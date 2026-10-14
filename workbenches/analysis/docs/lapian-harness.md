# 拉片共享工作台接入

本页说明如何把真实拉片方法投影到共享 Space，再通过当前有界执行器发起一次完整分析或 Reviewer-only 观察。它不会把导入历史伪装成新执行，也不会把方法声明、流程成功或 Reviewer 无 findings 当作质量通过。

## 初始化与历史阅读

使用 Node 24 和仓库根 pnpm workspace。运行时数据库地址、运行目录和 Operator 凭据只放在本机私有环境文件中；不要把地址、令牌、数据库、trace、媒体或私人报告写进仓库。

```sh
pnpm build:workflow
pnpm --dir workbenches/creation exec vite build --config apps/space-workbench/web/vite.config.ts
pnpm --dir workbenches/analysis lapian:harness setup
pnpm --dir workbenches/analysis lapian:harness import <准确的原生根运行ID> <案例标题>
pnpm --dir workbenches/analysis lapian:harness serve
```

`setup` 从私有 `SELF_MEDIA_DATABASE_URL`、`SELF_MEDIA_RUNTIME_DIR` 建立独立 Space 和本地凭据文件。默认 Space 为 `lapian-harness-20261014`，默认运行时目录是仓库下被忽略的 `.local/lapian-harness`；需要覆盖时使用 `LAPIAN_SPACE_ID`、`LAPIAN_HARNESS_DIR`。工作台默认仅监听 `127.0.0.1:4417`，可通过 `LAPIAN_HARNESS_PORT` 改端口。

Operator CLI 使用 `WORKFLOW_OPERATOR_BASE_URL`、`WORKFLOW_OPERATOR_SPACE_ID`，并从私有 `WORKFLOW_OPERATOR_TOKEN_FILE` 读取认证。`setup` 返回的本地凭据文件可作为 token file；只传路径，不打印或复制凭据内容。Operator CLI 的完整当前命令以 `pnpm --silent --dir vendor/agent-workflow operator help` 为准。

`import` 接收准确原生根 run ID。它保留历史 run、方法版本和 artifact 身份，失败运行会尽力导入原有 Builder 未发布草稿；缺失材料会作为缺口记录。导入不会调用模型。`serve` 后可在 `http://127.0.0.1:4417/space-workbench/lapian-harness-20261014` 阅读 Space。历史方法只在真实保存字节与 hash 对得上时恢复 prompt；无法恢复时保持未知。

## 独立读取复验

既有 Space 可为认知负责人单独配置 observer，不需要再次 `setup` 或迁移数据库：

```sh
pnpm --dir workbenches/analysis lapian:harness observer-setup
LAPIAN_HARNESS_READ_ONLY=true pnpm --dir workbenches/analysis lapian:harness serve
```

`observer-setup` 必须使用既有有效 implementation 凭据，新增私有 `observer.json`，只给既有 Space 的独立身份授予 `operator`。原凭据保留；observer 的 agent 为 `lapian-cognition-owner`，session 为认知负责人的既有会话。Operator 使用此文件作为 `WORKFLOW_OPERATOR_TOKEN_FILE` 后，可独立读取并保存观察、评价、处置和诊断，不能执行或发布方法。不得以 implementation 或无认证本机身份替代独立观察者。

读取模式停止周期同步并移除执行、业务理解保存、方法保存和发布入口，保留现有状态、证据与观察评价接口，不启动模型或重跑流程。恢复服务时使用本机私有环境文件与原运行目录；启动器、日志和凭据留在被忽略的私有目录。专业报告前端与 API 分开核验，健康 API 不必重启；API 初始化可能迁移或 materialize 资产，不能把重新启动 API 当作纯读取恢复。

宿主可用 `LAPIAN_DEFAULT_METHOD_VERSION_ID` 指定准确已登记的主方法作为阅读默认值。API 校验它属于主 workflow 和 entrypoint，并排除历史/执行观察和辅助方法；此显示偏好不修改最新登记版本或采用记录。显式观察版本链接仍打开原快照；业务理解的“阅读准确方法”明确跳主方法，避免最新运行快照只有一个观察节点时遮住真实设计。

## 准备并发布当前方法

先读 `space`、`understanding`、`cases`，选定真实案例后用 `case ID`、`run-evidence RUN_ID`、`asset ID` 和 `process RUN_ID` 阅读原始输入、完整子流程、产物及失败证据。业务理解应有材料来源，不要根据时间或历史结果猜测它何时被采用。

准备一份私有设计输入 JSON。`design-prepare` 会读取当前理解版本及准确 hash、作者身份和预期设计版本；不要手填这些派生身份字段。

```json
{
  "title": "单帖拉片：以 Builder 主报告为中心",
  "content": "描述要解决的业务问题、完整主流程、输出物和停止边界。明确 Builder 的内容还原、编导逻辑、视觉剪辑及 finalSummary 是主报告；Reviewer 是辅助审阅，修订后不做第二次复核。",
  "sources": [
    {"kind": "document", "ref": "<准确材料引用>", "title": "<材料标题>", "excerpt": "<支持该判断的原文>"}
  ],
  "changeReason": "将当前真实单帖方法接入共享 Space，保留完整执行与 Reviewer-only 入口的边界。",
  "capability": null
}
```

```sh
pnpm --silent --dir vendor/agent-workflow operator design-prepare \
  --file /absolute/private/design-input.json --out /absolute/private/design-ready.json
pnpm --silent --dir vendor/agent-workflow operator design-save \
  --file /absolute/private/design-ready.json
```

保存结果给出设计 revision ID。以这个 ID 预览并发布生成的准确候选版本：

```sh
pnpm --silent --dir vendor/agent-workflow operator method-preview --design <设计revision-id>
pnpm --silent --dir vendor/agent-workflow operator method-publish \
  --design <设计revision-id> --expected <preview返回的versionId>
```

预览/发布使用 analysis 的当前 method factory，从磁盘读取准确 prompt、agent 配置、生产工具合同、报告 schema、skill、实现文件和依赖锁文件并计算 hash。动态工具只声明真实工具名称和运行条件；方法快照没有动态参数 schema 时不伪造输入合同。声明的 schema、tool capability 和流程图描述方法，不证明运行时具备所有能力，也不证明运行或质量结果。

核对发布版本和节点定义：

```sh
pnpm --silent --dir vendor/agent-workflow operator versions
pnpm --silent --dir vendor/agent-workflow operator version <version-id>
pnpm --silent --dir vendor/agent-workflow operator node <version-id> source-check
pnpm --silent --dir vendor/agent-workflow operator node <version-id> builder
pnpm --silent --dir vendor/agent-workflow operator node <version-id> reviewer
pnpm --silent --dir vendor/agent-workflow operator node <version-id> repair
pnpm --silent --dir vendor/agent-workflow operator node <version-id> candidate-terminal
```

完整 `post.analyze` 方法顺序为 source-check → Builder → Reviewer；只有有效审阅 findings 才进入一次 repair。来源冲突/不确定、Builder/Reviewer/repair 失败或 needs-review 都会停止相应分支。默认终态只保留候选，不登记业务版本。Repair 后的版本标为 `revised-unverified`，没有第二次 Reviewer。单独发布的 `post.review` 当前方法只有 Reviewer 节点，读取一个已存在候选与冻结证据；它不构建、不修订、不登记。历史运行依旧是 historical observation，不会绑定到当前版本来冒充同一方法。

## 阅读原生事件与真实子流程

Operator 的 `native-events` 从导入或 external-host run 的原生账本读取白名单摘要，不调用模型，也不伪造 Space session/context：

```sh
pnpm --silent --dir vendor/agent-workflow operator native-events <run-id> [--after <seq>] [--limit <1..100>]
```

输出保留事件序号、类型、时间、step/attempt 身份、传输错误摘要、工具名称/状态，以及响应是否含文本、是否有最终文本和 text hash；原始回答、工具参数和请求头不返回。`function_call` 表示一次工具调用，不是最终回答。没有 `ws_session` 的 `occurrence-responses` 不代表原生账本没有事件；用 `native-events` 核对真实记录。

从完整 root 的 `native-events` children 列表沿实际 child `runId` 进入生产子流程，再对准确 child 执行 `run-evidence`、`process` 和 `asset` 阅读。child 的状态、父 step 和 `bound/pending` 是实际关系；不要合成子流程 ID。产物和资产始终归其原生 `producer` run，不因从 root 进入阅读而改归 root。

## 固定额度执行

执行额度由宿主固定：本批次最多 1 次完整执行（60 分钟）和 1 次 Reviewer-only（15 分钟），模型为 `gpt-6-luna`、reasoning medium。准备不调用模型；只有 `start` 执行。额度不会因重启、换案例或再次发布而重置。先查看 `execution-state`，也可在 Space UI 检查状态。

准备输入时可能同时出现一个 program-only 的输入准备 run。它是冻结输入/绑定的准备轨迹，可在 `runs` 中按自己的类型阅读，但不能当成付费完整流程的 root。付费 root 身份以 execution receipt 的 `nativeWorkflowRunId` 为准。

完整流程只接受一个准确已存在的原生根 run ID，作为输入和冻结材料来源：

```json
{
  "operation": "inputs-freeze",
  "input": {"kind": "full", "sourceWorkflowRunId": "<准确原生根run-id>", "caseLabel": "lapian-full-01"}
}
```

Reviewer-only 可指定一个准确候选 artifact ID；或者指定准确来源根 run ID，让执行器从该 run 解析唯一候选。不要同时提供候选 ID 与来源根 run ID。

```json
{
  "operation": "inputs-freeze",
  "input": {"kind": "reviewer", "candidateArtifactId": "<已读候选artifact-id>", "caseLabel": "lapian-reviewer-01"}
}
```

将其中一种请求保存在私有 JSON，再提交 Operator：

```sh
pnpm --silent --dir vendor/agent-workflow operator method-command --file /absolute/private/freeze.json
```

响应包含 `receipt` 和 `binding`。核对 `receipt` 的准确来源、输入 hash、方法快照 hash、固定模型与时限；核对 `binding` 的 `spaceId`、`caseId`、`inputManifestId`、`workflowVersionId` 和 `methodHash`。宿主固定 scope，不由调用者选择。准备收据 ID 用作下一步 `preparedId`。

只有核验准备收据无误后才提交 start：

```json
{"operation":"start","input":{"preparedId":"<准确准备收据ID>"}}
```

```sh
pnpm --silent --dir vendor/agent-workflow operator method-command --file /absolute/private/start.json
pnpm --silent --dir vendor/agent-workflow operator execution-state
pnpm --dir workbenches/analysis lapian:harness status <准备收据ID>
```

`status` 会通过共享宿主读取/同步真实执行，并返回 rootRunId、methodVersionId、inputManifestId、run/asset 列表及原收据。可在 Space UI 打开对应 Case、run、process 和 assets 阅读完整证据。成功的进程、完整业务结果和内容质量是三项不同判断；失败先读已保存证据，不自动重试。当前宿主只支持上述 full 与 reviewer 两种固定执行入口，不提供 Builder-only 执行，不提升额度，也不自动采用候选。

`status` 会无模型地 reconcile receipt、原生 run、Case/manifest 绑定和 assets；它可能补齐共享 Space 的观察记录，但不会启动或重试执行。运行中的收据可用 `pnpm --dir workbenches/analysis lapian:harness follow <准备收据ID>` 观测；`follow` 每 4 秒无模型地同步一次状态，只在状态、rootRunId 或 syncGap 变化时输出，并在不再处于 launching/running 时退出。它也不启动执行。

分别读取三种结果：`processOutcome` 描述宿主子进程是否启动、退出、失败、超时或中断；`businessOutcome` 依据原生 workflow 和完整业务回执判断 completed/incomplete；`qualityAcceptance` 保持 unknown，直到按原片与证据完成独立质量评价并保存。进程退出成功不代表业务完整，业务完整也不代表内容质量通过。

首次完整执行失败后，只有用户明确授权**一次**追加完整执行，且宿主持有与原失败 receipt 匹配的授权，才可准备重跑。重跑绑定原 Case、复用同一完整来源及冻结材料，最多 60 分钟，固定 `gpt-6-luna` / medium；授权仅允许一次追加 launch。无有效授权时拒绝，任何失败都不会自动重试。Reviewer-only 额度不会因完整执行失败而改变。

## 评价与继续调优

对准确案例先用 `review-subjects RUN_ID` 找观察对象，再用 `observe-asset` 或已支持的未发布响应观察入口亲读正文、原片、帧和字幕，并用 `review-save` 保存 good/bad/improvement/unresolved。外部审计与 workflow Reviewer 分开记录；引用同一准确资产、方法和输入，再保存 `disposition-save` 与 `diagnosis-save`。诊断记录观察、竞争解释、未知和最小辨别试验。一个案例、一次耗时或 Reviewer 无 findings 都不足以声称方法稳定或质量通过。

当前工作台显式允许对 `post.build`、`post.review`、`post.repair`、`post.source-check` 的真实运行记录评价并保存处置/诊断。其它 auxiliary workflow 默认只读；这项观察评价范围不增加执行权限，不允许修改或发布方法。
