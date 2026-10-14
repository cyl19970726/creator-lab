# 单帖 Reviewer 调优

当前提示词为 v13，仍按实际候选和原片核对结果判断，不以空 findings 自动晋升。此前 v5 同片试验减少了一类误报，却未检出正文机制遗漏和可读字幕被降为未知的问题。整篇报告的分析深度需要单独评估 Builder 输出，不能由局部事实审阅代替。

v6 在一次候选复审中找到了主文机制遗漏，但随后对另一份明显摘要化、缺失中后段剪辑分析的候选返回零问题。这两次实测说明其召回仍不稳定，不能用它的零问题结果自动采用新版正文。具体候选、完整 trace、人工来源核对和结果 SHA 留在私有 runtime，不能把试验数据提交到仓库。

Reviewer 使用官方 OpenAI Agents SDK、`gpt-6-luna` 和现有 SIWC 授权。生产图仍是构建、独立审阅、有意见时定向修订；修订稿不继承原稿的审阅通过状态。正文始终由 Builder 产出，Reviewer 的意见单独保存。

## 当前方法

`prompts/responses-reviewer-v1.md` 文件内的方法版本为 v13。先分别比较“来源有而主文遗漏”和“主文主张缺少来源”，再判断三个视角是否解释了具体内容关系、组织选择与局部画面接力。另一个视角或知识索引提到某项信息，不算独立主文已经解释。可由图片检查的核心未知需要回到对应原帧，不能只看几个代表画面就结束。

完整上下文成功返回时，压缩后的字符数不代表分页断点，只按 readiness 中的真实缺项补读。原帧回查围绕具体未解问题组织，独立窗口同轮发送；不以固定秒数重扫全片。画内外文、译制字幕、后加标签和口播的声明分别核对，避免把邻近信息合并后错归到某一个载体。新报告末尾的综合总结也属于审阅对象，但不要求它重复每个细节。

每条意见需要对齐候选具体文字、同一对象/角色/时点的来源、可说明的差异和实际改法。片内署名与外部身份核实分别判断；机制已被准确还原时不再要求重复补写。每条图片引用必须支持对应结论，不能用已看过但无关的图片补引用。深度意见也必须指出哪项已有材料能支持的具体解释缺失，不按字数或模板判断。

宿主校验绑定、哈希、阅读记录和候选位置。证据引用带 JSON Pointer 时，必须指向完整读取过的冻结 JSON 中的真实字段；图像不能附加 JSON Pointer。Reviewer 只能读取冻结材料，不提供采集工具。上述校验不能判断图片是否真的支持结论，仍需要独立语义验收。

提交意见前，`compare_review_finding` 在同一 Agent 会话内并列返回准确候选字段、所引 JSON 字段和图片像素，并按完整 finding 记录核对回执。修改意见后须按最终版本重新核对，空 findings 无需调用。它不做语义裁决，也不是新的工作流阶段。独立的读取与核对可以在一轮中提交，避免每张图片单独往返。

## 只运行 Reviewer 的对比入口

在 Node 24 的根 pnpm workspace 中运行：

```sh
corepack pnpm --dir workbenches/analysis exec tsx scripts/benchmark-post-reviewer.ts \
  --source-workflow-run-id REVIEW_OR_CANDIDATE_RUN_ID \
  --case revised --dry-run
```

环境沿用分析工作台的 PostgreSQL 与 SIWC 配置。隔离 checkout 应将 `SELF_MEDIA_PROJECT_ROOT` 指向其分析工作台，将 `SELF_MEDIA_RUNTIME_DIR` 指向真实冻结证据所在的 runtime；可用 `DOTENV_CONFIG_PATH` 加载原工作台配置，不复制凭证。

- 可用 `--candidate-artifact-id` 明确指定候选，或 `--source-review-artifact-id` 取历史审阅绑定的候选。主流程包含多个候选时不能猜测版本。
- 删除 `--dry-run` 才会调用模型。每次独立运行建立新的 PostgreSQL trace；历史来源和候选不被改写。
- `--report-path` 指定受控变体，`--case` 标记实验，`--repeat` 重复独立试验，`--output` 保存私有结果 JSON。
- 默认只调用现有 `post.review` definition，不执行自动修订或注册，不改变当前选中的报告。新的方法快照单独发布，历史快照保留。

## 独立审阅后按意见修订

已有完整报告时可以只调优审阅和局部修订，避免重跑来源检查与两轮 Builder：

```sh
SELF_MEDIA_EVALUATOR_REASONING_EFFORT=high \
corepack pnpm --dir workbenches/analysis exec tsx scripts/benchmark-post-reviewer.ts \
  --candidate-artifact-id EXACT_CANDIDATE_ARTIFACT_ID \
  --repair-on-findings --case local-review-repair --dry-run
```

先检查候选身份和实际报告 SHA，再去掉 `--dry-run`。此选项只允许 `--repeat 1`；只有新审阅成功、精确绑定当前候选且确有意见时，才运行一次现有 `post.repair`。零意见不会触发修订。审阅与修订固定为 `gpt-6-luna`；上述例子显式测试 high 审阅，修订沿用 Builder 推理力度。冲突的 Builder 模型配置会报错。

私有结果分别保存审阅和修订运行、耗时、请求、候选、原审阅和修订记录。异常保留已产生的结果，不能把部分完成写成成功；成功修订仍标 `revised_unverified`。不注册候选、不修改当前报告选择，也不把局部迭代用时算作完整流程速度。新修订稿必须另外对照原片检查是否准确处理意见且保留既有分析。

首次真实局部实验完成：v13 + high 审阅用时7分18.489秒、12次请求，提出一条来源确实支持的应用状态转换遗漏；medium 修订用时1分40.750秒、6次请求。审阅仍漏掉独立核对已发现的载体归属错误，不能因提高推理力度就自动信任结果或设为默认。此次同时改变提示词和推理力度，也不能分离两者对速度与准确性的贡献。局部阶段合计8分59.239秒，只证明该入口可以完成真实审阅与修订，不代表整片可以在该时间内完成。

## 验收方式

固定视频、来源与目标帧，比较旧候选、修订候选和仅修改指定字段的错误变体。把预期错误及人工判定放在模型不可读的私有评估记录中，不注入 Reviewer 上下文。

同时记录：真实问题是否被发现、误报、图片/文字引用是否相关、修改建议是否与问题一致、模型请求数和墙钟耗时。没有意见不等于高质量；找到更多意见也不等于高质量。测试与构建通过只能证明实现合同，不代表模型审阅准确。一次同片试验不代表跨题材通过率。

通用提示词方法参考 [OpenAI Prompting](https://developers.openai.com/api/docs/guides/prompting)，评估时采用相同输入比较设置，参考 [Model selection](https://developers.openai.com/api/docs/guides/model-selection)。具体质量与速度以本项目实测为准。
