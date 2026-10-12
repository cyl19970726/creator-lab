# 单博主综合 Builder 方法 v1

从本次冻结的 portfolio、corpus、全部浅标、实际 selection、公开详情、批次和每篇已构建的完整单帖 `builderLenses` 建立认知。必须读取每篇当前版本的内容还原、编导逻辑、画面剪辑与审阅边界，不只读标题、摘要或高赞帖子。旧综合、旧 evaluator 或未冻结材料不是新事实源。只使用绑定的 `read_evidence`、`inspect_image`，不得联网、运行 shell 或读取技能文件。模型给完整 JSON 候选；宿主负责 schema、分类、跨帖来源和 gate 校验。不要自称独立审核通过。

先在内部为每篇整理：它具体讲了哪些问题、概念、步骤、条件、数字、例子和限制；如何开头、推进和证明，哪些画面真正解释内容；发布时间、在冻结分布中的位置、分层口径；它对跨帖判断的支持、补充或反例。全量清单与浅标用于分布和表层分类，不替代深读。单帖原证据有但 Builder 漏掉的内容是单帖还原缺口，应定位回单帖修订；新版本未登记前不可暗中升格成跨帖深度事实。确实超出材料范围才标未知。OCR 失败不等于图中文字不可读。

按实际问题建立跨帖关系：共同条件、互补机制、适用场景不同、立场随时间改变、明确矛盾、尚未比较。不要硬说始终一致，也不要把不同任务下的说法强行定为冲突。每条跨帖 finding 的 statement 需具体到概念、机制、条件和方法；support 说明这篇实际提供了什么、绑定它自己的当前 reconstruction；counterexamples 必须真实限制或反驳该判断，不拿无关主题充数。反例推翻原断言时收窄 statement 与 boundary。找不到反例可以明说没有足够反证，不虚构。

`crossPostResearch` 的五个互补部分各做一次：`value` 说明持续价值、受众与边界；`knowledge` 展开真实知识与问题地图，不能停在“介绍了五项能力/某方法”；`patterns` 连结具体内容与选题、论证、编导、画面、剪辑模式及例外；`performance` 并置高、基准/均值附近、低的实际样本与混杂因素，只讨论观察相关性；`next_questions` 从已知内容提出具体后续问题，分别区分素材缺口、单帖遗漏与跨帖未比较，不能全写成技术真假核查或我们的创作计划。每条 finding 保留事实类别、置信度、逐帖支持、实际反例、边界、开放问题。

自适配 `portfolioClassification` 由本次综合 Builder 形成：从实际内容发现紧凑标签表，对冻结 corpus 每条一帖一行，可多标签，可证据不足而空并说明未知。三轴为 `topic`、`format`、`commercial_signal`；标签定义、依据、边界清楚，不根据博主昵称或简介猜。`surface_title` 只用该帖标题/可见文本，format 可用媒介类型但不能由此推断口播或剪辑；已深读样本用 `deep_builder` 引自己的 reconstruction。标签登记的 evidenceRefs 只能指向当前冻结 corpus 或批次重建，旧 annotations 不能作为分类根据。标签交叠占比无需总和 100%，写清分母、未分类数与证据层级。资金、众筹、营收、销量不是同一个信号；标题出现数字只证明标题如此写。

返回完整 `creatorSynthesisSchema` 候选，顶层含 `schemaVersion:"1.0.0"`、`creatorRunId`、`generatedAt`、`inputs`、`identity`、`contentSystem`、`performance`、`postAnalyses`、`portfolioClassification`、`crossPostResearch`、`boundaries`。`inputs` 精确列出冻结 `portfolioArtifactRef`、可空 `portfolioAnnotationsArtifactRef`、`selectionArtifactRef`、`detailArtifactRef`、`reconstructionBatchArtifactRef`。`identity` 包含 `positioning`、非空 `audience[]`、`problemsAddressed[]`、`valueProvided[]`、`trustSources[]`、`lifecycleStage`、`commercialPaths[]`；`contentSystem` 包含非空 `topicClusters[]`、`formatClusters[]`、`visualLanguage[]`、`recurringStructure[]` 与 `publishingRhythm[]`；`performance` 包含非空 `baseline[]`、`high[]`、`low[]`、`confounds[]` 及 `timing[]`。这些 claim 都写 `{statement,factClass:"observed"|"author_claim"|"inference"|"unknown",confidence:"high"|"medium"|"low",evidenceRefs:[...],caveat:string|null}`，至少一条真实证据。

`postAnalyses` 与冻结 selection 的帖子 ID、tier 与 rank 完全对应；每项为 `{postExternalId,tier:"high"|"base"|"low",tierRank,title,evidenceStatus:"deep_validated"|"deep_provisional"|"surface_only",contentRole,contentForm,performanceInterpretation,evidenceRefs,unknowns}`。实际列表的 21 行是当前产品 schema 约束，不是所有博主永远应选 21 条；不得把某次运行的默认 12 深读样本当全量。高、中、均值附近、低及重叠分层按实际 selection 解释，同一帖子只深读一次。每条深度观察须引用其自己的当前 reconstruction，全部已构建深读样本在支持或反例中可回查；不可跨帖借证。

完整嵌套输出契约如下，取自 `packages/research/src/creator-synthesis/contracts.ts` 的 `creatorSynthesisSchema`、`portfolioClassificationSchema` 和 `packages/contracts/src/cross-post-research.ts` 的 `crossPostResearchSchema`。`?` 表示 Zod 结构层面可省略；本工作流仍必须输出 `portfolioClassification` 与 `crossPostResearch`，宿主会另外校验真实来源、分类和五节覆盖。所有未标 `?` 的字段必填；`string+` 为非空字符串，`T+` 为至少一项的 T 数组，`T[]` 可为空数组。数组元素是否非空以及数组的最小长度，以旁边的注释为准。不要将这份字段表当成证据或据此补造结论。

```text
creatorSynthesis = {
  schemaVersion: "1.0.0", creatorRunId: UUID, generatedAt: string,
  inputs: { portfolioArtifactRef: string, portfolioAnnotationsArtifactRef?: string|null,
    selectionArtifactRef: string, detailArtifactRef: string, reconstructionBatchArtifactRef: string },
  identity: { positioning: claim, audience: claim+, problemsAddressed: claim+,
    valueProvided: claim+, trustSources: claim+, lifecycleStage: claim, commercialPaths: claim[] },
  contentSystem: { topicClusters: claim+, formatClusters: claim+, visualLanguage: claim+,
    publishingRhythm: claim[], recurringStructure: claim+ },
  performance: { baseline: claim+, high: claim+, low: claim+, timing: claim[], confounds: string[] /* 至少一项 */ },
  postAnalyses: postAnalysis[21], portfolioClassification?: classification,
  crossPostResearch?: crossPostResearch, boundaries: string[] /* 至少一项 */
}
claim = { statement: string+, factClass: "observed"|"author_claim"|"inference"|"unknown",
  confidence: "high"|"medium"|"low", evidenceRefs: string[] /* 至少一项 */, caveat: string|null }
postAnalysis = { postExternalId: string, tier: "high"|"base"|"low", tierRank: positive_integer,
  title: string|null, evidenceStatus: "deep_validated"|"deep_provisional"|"surface_only",
  contentRole: string+, contentForm: string[] /* 至少一项 */, performanceInterpretation: string+,
  evidenceRefs: string[] /* 至少一项 */, unknowns: string[] }
classification = {
  schemaVersion: "creator-portfolio-classification@1", sourceCorpusArtifactRef: string+,
  observedPosts: nonnegative_integer,
  labelRegistry: [{ id: lower_case_alphanumeric_with_optional_hyphen_or_underscore,
    axis: "topic"|"format"|"commercial_signal", name: string+, definition: string+,
    evidenceRefs: string+[] /* 至少一项 */, boundary: string+ }],
  rows: [{ postExternalId: string+, memberships: [{ labelId: string+,
    sourceLevel: "surface_title"|"deep_builder", evidenceRefs: string+[] /* 至少一项 */, boundary: string+ }],
    unknowns: string+[] /* 可为空；零 membership 时宿主要求说明未知 */ }],
  boundaries: string+[] /* 至少一项 */
}
crossPostResearch = { sections: [{
  id: "value"|"knowledge"|"patterns"|"performance"|"next_questions", title: string+,
  findings: [{ id: string+, statement: string+,
    factClass: "observed"|"author_claim"|"inference"|"unknown",
    confidence: "high"|"medium"|"low", support: support+,
    counterexamples: support[], boundary: string+, openQuestions: string+[] /* 可为空 */ }]+
}] }
support = { postExternalId: string+, observation: string+, evidenceRefs: string+[] /* 至少一项 */ }
```

分类的 `labelRegistry.id` 唯一，同轴标签名不能重名；`rows` 必须逐帖唯一且数量等于 `observedPosts`，每行 `memberships.labelId` 必须已登记且不重复。零 membership 的行需在 `unknowns` 说明原因。五个 `crossPostResearch.sections.id` 各出现一次，每节至少一条 finding；finding ID 唯一。每条深读 support / counterexample 只能用该帖的当前 reconstruction 与允许的共同输入引用，不能用别帖重建。

普通构建直接返回完整 `creatorSynthesis` JSON 对象。修订构建返回 `{"candidate": researchDraft, "revisionResponse": [...]}`；`researchDraft` **只**含 `identity`、`contentSystem`、`performance`、`crossPostResearch`、`boundaries`，必须完整遵守上表这些研究字段的嵌套契约。不得在修订草稿中输出 `schemaVersion`、`creatorRunId`、`generatedAt`、`inputs`、`portfolioClassification`、`postAnalyses`；宿主从已核对的同源前稿保留这些字段，结合本次冻结 batch 追加各帖自己的评估引用。`revisionResponse` 对每条 review finding 恰有一个 `{id,status:"changed"|"disputed"|"missing_evidence",reason:string+}`。若 finding 的 `location` 指向上述任一固定字段或其子字段，本轮不能修它，绝不能写 `status:"changed"`；用现有状态诚实说明未解决的原因，不把有证据但本轮不可改误写成“证据缺失”，也不把回执当作独立复审通过。

保留审阅状态：`completed_no_findings` 仅表示原稿未发现修改项，`revised_unverified` 是修订后未复审，`failed/review_incomplete` 是审阅过程失败，不等于正文错误。综合要声明实际引用的报告版本，不能继承旧版通过状态或静默丢失未复审样本后称完整。可见互动数不证明曝光、完播、转化、投放或销售；所有统计声明冻结观察范围和分母，已构建与已验证数分开。主页总数与冻结清单的差值不能直接断言精确缺失量；预算截断不得称全量。不同评价策略可一起研究内容，但不要比较其通过率和警告数。零已验证时仍可形成暂定认知，不能称已验证知识。

交回前检查：读者能否说出这个博主具体讲了什么、跨帖知识如何联系、表达模式有哪些例外、还有哪些问题；每项都能追到准确的当前帖子版本。单帖缺失交回单帖，跨帖关系问题在此修订，页面不可达交展示层。修订模式按本次 review 的每条 finding 输出 `revisionResponse:[{id,status:"changed"|"disputed"|"missing_evidence",reason}]`，不能覆盖原审阅或把自查当独立通过。
