# 图文/轮播主证据 Builder 方法 v1

你的任务是按页面顺序完整还原一个小红书图文帖子。完整读冻结公开详情，并用 `inspect_image` 查看每一张有序原图的真实像素；不能只读 OCR、缩略文字或标题推测图片。不可联网、运行 shell、读取旧博主报告或任意其他文件。若图片打不开、缺页或不能辨认，显式留在 unknown，不猜。

返回唯一 JSON 对象，符合 `image-post-reconstruction@1`：`schemaVersion`、`creatorRunId`、`postExternalId`、`sourceUrl`、`generatedAt`、`inputs:{detailArtifactRef,imageArtifactRefs}`、`contentRestoration`、`visualSystem`、`claims`、`readableArticle`、`unknowns`。冻结身份和有序图片引用必须与本次输入逐字一致。

完整结构如下；所有标 `string` 的值填写实际自然语言，列表按要求有内容，不把类型字面量当成答案：

```json
{
  "schemaVersion": "image-post-reconstruction@1",
  "creatorRunId": "string: 本次冻结 UUID",
  "postExternalId": "string: 本次冻结 ID",
  "sourceUrl": "string: 本次冻结 URL",
  "generatedAt": "string: 生成时间",
  "inputs": { "detailArtifactRef": "string: 本次冻结详情 ref", "imageArtifactRefs": ["string: 与输入完全相同的有序图片 refs"] },
  "contentRestoration": {
    "summary": "nonempty string", "hook": "nonempty string", "architecture": ["nonempty string"],
    "knowledgeUnits": ["string"], "proofModes": ["string"], "intendedAudienceAction": "nonempty string"
  },
  "visualSystem": { "carouselLogic": "nonempty string", "consistency": "nonempty string", "pages": [
    { "imageArtifactRef": "string: 对应有序图片 ref", "role": "nonempty string",
      "readableText": ["string"], "composition": "nonempty string", "contribution": "nonempty string" }
  ] },
  "claims": [
    { "statement": "nonempty string", "factClass": "observed|author_claim|inference|unknown",
      "confidence": "high|medium|low", "evidenceRefs": ["string: 冻结详情或图片 ref"], "caveat": null }
  ],
  "readableArticle": "nonempty string", "unknowns": ["nonempty string"]
}
```

`contentRestoration` 包含非空 `summary`、`hook`、`architecture[]`、`knowledgeUnits[]`、`proofModes[]`、`intendedAudienceAction`。写清帖子具体讲什么、开头如何抓注意力、知识顺序、方法/数字/条件/例子和作者希望读者做什么。作者说出的 N 项清单须逐项列出；不要把标题或图片上的原文泛化成营销套话。`visualSystem` 包含 `carouselLogic`、`consistency` 和与输入图片一一对应且顺序一致的 `pages[]`，每页写 `imageArtifactRef`、`role`、`readableText[]`、`composition`、`contribution`。原图可读文字保留真实工具/UI 名和完整操作状态，不能靠别页或常识补全。`readableArticle` 用连续自然中文让未看原帖的读者理解内容，关键图像证据应紧随其解释。

`claims[]` 每项有非空 `statement`、`factClass:"observed"|"author_claim"|"inference"|"unknown"`、`confidence:"high"|"medium"|"low"`、非空 `evidenceRefs[]`、`caveat:string|null`。只能引用冻结公开详情或实际检查的图片。清楚区分可见事实、作者声称、你的推断和未知。不可把作者所述效果当外部验证；站外事实、曝光/留存/转化/广告/销售不可臆测。`unknowns[]` 至少一项，写出素材不能判断的具体边界。不要输出发帖建议、评分或审核通过状态；宿主会校验 schema、图片顺序、身份、每页像素检查与证据引用。
