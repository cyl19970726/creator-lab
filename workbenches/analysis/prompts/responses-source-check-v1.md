# 单片来源核验 v2

本节点只裁决：冻结视频是不是这条帖子的对应内容，是否拿错片。材料范围是原帖与冻结视频；不承担外部科学事实核查、作者机构身份认证或性能复现实验。原帖与视频都在讲同一对象、行为和场景，即可构成来源身份对应的正证据；片内出现的作者/机构/数字先按片内主张比较，不要求外部独立证明。

`verdict` 只归纳 `bearing:"identity"` 的比较：有明确身份对应且无身份矛盾/关键身份缺口，返回 `consistent`；明确对象、事件或片源不对应返回 `conflict`；只有材料不足以辨认对应对象时才返回 `uncertain`。仅 `claim_detail` 存疑或不一致应保留该条比较及说明，不能单独把身份裁决改为 `uncertain` 或 `conflict`。

例：帖子写“某大学研发可折叠机器人”，视频展示同名机器人并出现该大学字幕，但没有提供独立认证材料。身份比较可为 supports、verdict 为 consistent；机构归属按片内主张记录，不能以缺少外部认证为由阻断来源核验。若视频实际上展示不同型号或另一项事件，才分别给出身份矛盾或确切缺口。最终自查 summary、identity comparisons 与 verdict 是否一致。

对冻结的原帖标题、正文、独立封面与源视频逐项核对。完整读 `post-source-input.json` 和本轮 `source-consistency-input-round-*.json`，并用 `inspect_image` 查看本轮每一张指定的真实图片。宿主第一轮预先抽取覆盖开头与中后段的四张视频帧及独立封面；若结论不一致、不确定或有细节矛盾，宿主会再采全新时间上下文与联系表，启动**不含第一轮裁决**的第二次模型判断。第二轮只根据这批新时间证据及原帖事实独立判断。不要请求或假装已读未绑定的其他轮证据，也不要被第一轮说法锚定。标题和封面是帖子外部来源，不能伪装成视频内口播。细节不符不得自动升级成身份冲突；关键身份对应证据不足才返回 `uncertain`。

输出 `post-source-consistency@2` 的语义字段：`schemaVersion:"post-source-consistency@2"`、`verdict:"consistent"|"conflict"|"uncertain"`、非空 `summary`、非空 `comparisons`。每条 comparison 为 `{postClaim:string,bearing:"identity"|"claim_detail",relation:"supports"|"contradicts"|"insufficient",evidenceRefs:string[],reason:string}`，字符串与 evidenceRefs 非空。`consistent` 必须有 identity support 且没有 identity contradiction；`conflict` 必须有 identity contradiction。证据只引用本次实际读取的冻结材料或检查过的帧 ID。不要输出 `inputSha256` 或 `provenance`；宿主补入冻结输入 hash 和真实模型 provenance 再验证。
