# Analysis 执行器迁移探索（2026-10-10）

> 本文保留 2026-10-10 的发现与当时实现。2026-10-12 已接入官方 SDK；当前状态见[官方 SDK 迁移记录](official-agents-sdk-migration.md)，不以本文旧依赖说明判断现行代码。

范围：只读核对现有实现与共享执行器；未运行真实模型、未更换执行路径。本文把“可复用接口”与“尚未验证的替代能力”分开。

## 先决结论

`vendor/agent-workflow/packages/agent-sdk` 名称容易误导：它是项目自有的 **SIWC Responses API `AgentRunner` 适配器**，不是通用 OpenAI Agents SDK。它使用应用自己的 Continue with ChatGPT 连接，不读取 Codex 登录，不接收 Platform API key，不自动切换计费方式。代码直接 `fetch(https://api.openai.com/v1/responses)`；包的唯一依赖是 `@signal-room/workflow`。证据：`packages/agent-sdk/README.md`、`package.json`、`src/responses.ts`；共享 `docs/architecture.md` 的“一般 SDK 与 Codex 如何共存”也明确区分两者。

现有分析生产运行是 `ProductionResearchRunner` 适配 `AgentRunner`，其节点再委派到 Codex SDK/CLI 和项目本地 skill 方法文件，不能把 `AgentRunner` 接口存在误认为 SIWC 已可无损替换。`production-research-runner.ts` 的注释和 `agent.delegate` 事件明确它调用完整生产 operator；`research/src/workflows/agents.ts` 中的 `config.prompt` 多为委派说明，真正提示词在下游执行器组装。

## 当前角色与方法依赖

| 节点 / 角色 | 当前执行与输入 | 输出、校验及隔离 | 关键源码 |
| --- | --- | --- | --- |
| `post-source-checker` | Codex SDK，两轮图像核验；宿主用 ffprobe/ffmpeg 取封面、稀疏帧及疑点上下文，加载 `source-consistency.md` | `post-source-consistency@2`；图像引用与源媒体 hash 核对，冲突/不确定会挡住后续 Builder；每轮 180 秒，独立私有 trace | `workflow/source-consistency-checker.ts` |
| `post-builder` / repair | Codex SDK/CLI 运行在输出目录，加载 `builder-operator.md`、`single-post-depth.md` 及协议/重建 schema；宿主预处理视频、音频、转写、证据包，Builder 再探针、定向取证、OCR/UI 阅读 | 写 `probe.json`、`capture-protocol.json`、`targeted-evidence/`、`reconstruction.json`；宿主校验 schema、三 Lens、来源与完整性；不得改 evaluator 文件 | `platform/video/codex-video-reconstruction-executor.ts`、`video-reconstruction-media-preparer.ts`、`video-builder-integrity.ts` |
| `post-reviewer` | 原完整 Evaluator 是新进程，加载 `evaluator-operator.md`、`evaluation.schema.json` 与三 Lens 合同；当前生产 workflow 可走另一个 `simpleReview`，只读候选、证据与 `reviewer-operator.md` | 完整 Evaluator 写 `evaluation.json`、三 Lens rule arrays 和 gate；simple review 返回 `research-review@1`，强制 JSON Pointer、证据引用、候选 hash 不变，10 分钟限制 | `platform/video/codex-video-reconstruction-executor.ts`、`workflow/simple-review-runner.ts`、`workflow/production-research-runner.ts` |
| `creator-synthesis-builder` / repair | Codex SDK/CLI；读冻结 portfolio、corpus、surface annotation、selection、public detail、重建批次与逐帖成果；把项目本地 `creator-synthesis/SKILL.md`、`references/method.md` 的内容及 hash 嵌入 prompt | 写 `creator-analysis.json` 或复用场景下 `research-draft.json`；TS schema、跨帖证据、分层分类校验；原始候选/独立评估分开；Builder 最长 90 分钟 | `platform/synthesis/codex-creator-synthesis-executor.ts` |
| `creator-synthesis-reviewer` | 新独立进程，固定候选 fingerprint，读同一冻结材料及 specificity 诊断；完整 Evaluator 最长 30 分钟；另有 simple review 路径 | `creator-synthesis-independent-evaluation@1`、gate；证据引用绑精确资产，程序验证并决定是否发布 | `platform/synthesis/codex-creator-synthesis-executor.ts`、`workflow/simple-review-runner.ts` |

以上并非说所有运行都经过所有可选 Evaluator：`production-research-runner.ts` 可选 `simpleReview`，单片重建也有跳过/单次评估策略。迁移需按当前注册版本和每条 run 的实际配置界定，而不是概括为单一固定流水线。

## 共享 SIWC adapter 实有能力与缺口

`SiwcResponsesRunner` 可接受 `AgentDefinition.config.instructions`（developer instructions）、字符串或 JSON 输入，输出 `text` 或经过 `JSON.parse` 的 `json`。宿主在 **每个 attempt** 注入 function 工具及其参数声明，模型不能自行注册；默认最多 8 turns/16 calls（可配置，参数限 1–100）；传入 `AbortSignal` 到 fetch 和工具。事件包含 `siwc.started/request/text_delta/response/tool_call/tool_result/tool_failed/provider_error`，记录可见消息、参数/结果、hash、用量和 provider ID；隐藏推理不在 trace。`store:false`，每轮重送本次完整历史，不使用 provider 会话恢复。证据：`packages/agent-sdk/src/responses.ts`、测试 `src/responses.test.ts`。

缺口直接影响分析替代：

1. `outputFormat=json` 只做语法解析，没有向模型提交 JSON Schema，也不做 schema 验证。现有 Codex source-check/simple reviewer 使用 `outputSchema`，且业务有多层 Zod、JSON Pointer、cross-post 和三 Lens gate；必须在 SIWC 结果后保留同样的宿主校验和有界返工。
2. 当前输入是一个文本字符串，工具结果是 JSON；没有图像/音频内容、视频帧、媒体附件的请求编码。因此即便宿主能返回帧路径，模型仍看不到画面，也听不到音轨；来源核验和视觉编辑 Lens 无法据此验收。需先验证该 SIWC route 的多模态输入能力并实现受控传送，或实现可审计的独立视觉/听觉工具与证据产物；不能用 OCR 文本代替视频观察。
3. Adapter 有工具/轮次/流大小界限（16 MB），但**自身无总时限**，只遵循调用方的 `AbortSignal`；宿主须设节点级超时并传播取消，同时明确工具已产生外部副作用后的结果未知处理。现有 Codex 路径在 source-check、simple review、视频 Builder/Evaluator、博主 Builder/Evaluator 中分别设了时限。
4. 工具 callback 只是注入接口，不附赠 analysis 的资产读取、精确版本引用、帧/音频检查、OCR、草稿提交、schema 诊断或临时目录沙箱。`docs/space-storage.md` 明说节点能力约束不会自动沙箱化执行器已有的本机文件/shell 旁路。
5. adapter 的 JSON 工具调用、可见正文与完整 instructions 会进入 `request.emit`；宿主必须用受限 trace 存储、脱敏和授权投影。`store:false` 不等于本地无敏感 trace。

## 认证现状（未读取凭据内容）

共享 `SiwcAuth` 默认从用户级 `~/.config/creator-lab/workflow-siwc.json` 加载单账号连接，检查所有者及 `0600` 权限，刷新时加锁；CLI 可做 login/status/logout。本文只记录认证机制，不记录任何机器上的凭据文件状态。分析现有 Codex 路径从 `SELF_MEDIA_CODEX_BIN`（默认 `codex`）选择二进制，Codex SDK 路径通过共享 `workflow-codex` 传入 Codex 环境；这不是 SIWC 的凭据来源。证据：`packages/agent-sdk/src/auth.ts`、`README.md`、`adapters/src/workflow/codex-sdk-runner.ts`、视频/综合执行器。

## 最小完整替代切面

不需要立刻引入真正的 OpenAI Agents SDK 才能走向用户期望的“prompt + tools”控制：保留共享 `AgentRunner`/workflow/校验合同，以 SIWC Responses adapter 作为候选模型循环，但必须做完以下闭环才称得上替代 Codex + skill：

1. 将每个角色的**有效方法内容**从隐式 skill 文件/目录命令转成版本化的节点 instructions、有限的工具声明、输入/输出 schema 和权限快照；记录 hash 与当次生效内容。用户要求替换的是运行依赖，不等于删掉方法知识；先保留 Builder、Evaluator、source-check、creator-synthesis 的语义合同，再做可比较的新 revision。
2. 宿主按冻结资产版本绑定工具：`read_artifact`（限定清单、分页/片段）、`inspect_frame`/必要听觉证据（返回模型可实际感知的内容或可核验结论）、`request_targeted_capture`、`run_ocr`、`submit_candidate`、`validate_candidate`。媒体与大文件先由受控宿主处理，模型只得到该节点获准的证据；写工具只写本次候选，Evaluator 必须只读。工具调用参数/输出加 schema、大小、次数、时限和证据 hash；不暴露任意文件路径、shell、网络或数据库。
3. 对 source-check、单片 Builder、独立 Reviewer、博主 Builder/Reviewer 分别写桥接器；模型 JSON 经过现有 Zod 与业务 gate，原候选 hash、输入版本和 evidenceRefs 在提交前再验证。程序装配、OCR 缓存、来源防串线、三 Lens 完整性、跨帖分层/证据校验继续由宿主负责，不能搬进 prompt 当“完成”凭据。
4. 把 SIWC 事件和工具收据映射到现有 run/step/attempt 及 PG Space trace；配置中明确模型、reasoning effort、instruction hash、tool profile hash、方法版本、schema、节点时限和凭据引用。完成/失败/超时/取消/输出未通过业务验证分别落账；Reviewer 使用独立 attempt 和固定 candidate fingerprint。
5. 先以一个冻结的真实单片案例做**成对基线**：同一材料分别跑旧 Codex 和新实现，核对来源、三 Lens、视觉/听觉关键事实、证据引用、未知边界、独立评估及 trace 可回放性；再做博主综合与分层案例。必须先验证账户在该 SIWC route 上的所需模型、图像/音频通道、工具形态和最大输入容量；README 的 2026-10-04 文本＋工具合成探针只证明当时那个账号与 route，不证明视频分析质量或今日可用性。

若 route 无可用多模态能力，可先替换纯文本的博主综合或 simple review 作技术试点；**不可宣称完整单片视频 Builder/source-check 已迁移**。真正 OpenAI Agents SDK 的集成是另一项选择，当前仓库架构文档也标为未交付目标。

## 建议实施边界

共享 `vendor/agent-workflow` 负责 SIWC adapter 能力、通用 attempt 工具注入/取消/trace/PG Space 合同；`workbenches/analysis` 负责视频与博主专用 prompts、媒体/证据工具、Zod/schema 和业务 gate。逐节点切换并保留旧实现作对照，既不复制 vendor，也不让 analysis 的私有文件路径成为 PG 资产身份。此分工符合项目 `AGENTS.md` 与共享 `docs/postgres-sdk-plan.md`，但上述工具及多模态支持目前只是迁移建议，尚非已实现 API。
