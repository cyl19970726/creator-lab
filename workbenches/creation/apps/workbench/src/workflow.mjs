// The eight reader-facing steps map to existing artifact keys and preserve URLs.
export const phases = [
  { id: "video", title: "表达清楚", caption: "B1 定位 → B2 设计 → B3 样片与成品", steps: ["positioning", "architecture", "final"] },
  { id: "publish", title: "交付与反馈", caption: "C1 平台交付 → C2 反馈与改进", steps: ["publish", "learning"] },
  { id: "research", title: "输入资料 · 可选", caption: "保留历史来源阅读；不执行研究或作为创作前置", steps: ["goal", "evidence", "report"] },
];
export const steps = [
  [
    "goal",
    "A1",
    "对齐目的与必要边界",
    "选题任务书",
    "为何做、帮助谁，以及本次需要回答什么",
  ],
  [
    "evidence",
    "A2",
    "分题研究并汇合证据",
    "分题研究与证据汇合",
    "模型特性、配法实测、修改版与来源如何共同支撑结论",
  ],
  [
    "report",
    "A3",
    "架构、图文与疑问闭环",
    "完整报告",
    "原理能否理解、结论是否有依据、修改是否闭合",
  ],
  [
    "positioning",
    "B1",
    "内容定位",
    "内容定位与工作流报告",
    "整合主题、读者、内容价值与载体；商业交付适用时明确价格与权益",
  ],
  [
    "architecture",
    "B2",
    "表达设计",
    "表达设计与关键画面",
    "文章、口播、画面与包装能否共同讲清一个问题",
  ],
  [
    "final",
    "B3",
    "制作与视听复验",
    "视频交付包",
    "真实声音、画面、节奏，以及各版本的审阅范围",
  ],
  [
    "publish",
    "C1",
    "平台包装与交付",
    "平台发布包与回执",
    "具体账号、内容版本、交付权益与真实发布状态",
  ],
  [
    "learning",
    "C2",
    "接住反馈并决定下一轮",
    "效果回顾稿",
    "真实反馈、失败原因、用户投入与下一轮修改",
  ],
  ["feedback", "", "旧版反馈", "旧版反馈依据", "已有反馈如何影响当前任务"],
  ["outline", "", "报告大纲", "报告架构稿", "因果关系与章节安排"],
  ["mechanism", "", "机制推导", "机制与计算", "因果、单位、假设与复算"],
  ["questions", "", "读者复读", "读者疑问", "哪些解释仍然不清楚"],
  [
    "research-review",
    "",
    "报告审阅记录",
    "报告审阅包",
    "独立意见、修改回应与接受范围",
  ],
  ["video-evidence", "", "证据转译", "视频证据底稿", "表达是否超出报告依据"],
  ["opening", "", "开头声画", "开头声画稿", "开头承诺与核心问题是否一致"],
  ["package", "", "标题与封面", "标题封面稿", "实际标题、封面与联合审核"],
  [
    "design",
    "",
    "设计审阅",
    "视频设计审阅",
    "独立意见、修改回应与具体接受范围",
  ],
  ["sample", "", "实际样片", "有声样片", "能否听懂、看清、跟上"],
  [
    "comments",
    "",
    "评论获取与互动",
    "评论与回复记录",
    "原文、采集范围与实际互动",
  ],
].map(([id, code, title, artifactTitle, question]) => ({
  id,
  code,
  title,
  artifactTitle,
  question,
}));
export const groups = {
  goal: ["goal", "feedback"],
  evidence: ["evidence", "mechanism"],
  report: ["outline", "report", "questions", "research-review"],
  positioning: ["positioning"],
  architecture: [
    "video-evidence",
    "architecture",
    "opening",
    "package",
    "design",
  ],
  final: ["sample", "final"],
  publish: ["publish"],
  learning: ["comments", "learning"],
};
export const membersFor = (id) =>
  groups[id] || Object.values(groups).find((ids) => ids.includes(id)) || [id];
export const groupFor = (id) =>
  Object.entries(groups).find(([, ids]) => ids.includes(id))?.[0] || id;
export const phaseFor = (id) =>
  phases.find((p) => p.steps.includes(groupFor(id)))?.id || "research";
export const stageStatus = (rev, id) =>
  rev?.coreIds?.[id]
    ? rev.stageStates?.[id]?.label || "有产物"
    : rev?.inputCoreIds?.[id]
      ? "沿用输入"
      : rev?.stageStates?.[id]?.productionState === "in_progress"
        ? "制作中"
        : "未登记";
export const groupStatus = (rev, id) => {
  const available = membersFor(id).filter((step) => rev?.coreIds?.[step]);
  const inputs = inputsFor(rev, id);
  return (
    [
      available.length ? `${available.length} 项关键资产` : "",
      inputs.length ? `${inputs.length} 项沿用输入` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "查看依据"
  );
};
export const coreIdFor = (rev, id) =>
  rev?.coreIds?.[id] || rev?.inputCoreIds?.[id] || null;
export const inputsFor = (rev, id = null) =>
  (rev?.inputRefs || []).filter(
    (ref) => !id || membersFor(id).includes(ref.step),
  );
export const workflowDiagram = `flowchart LR
B1[内容定位] --> B2[表达设计] --> B3[样片与成品]
B3 --> C1[平台包装与交付] --> C2[反馈与改进]
C2 -. 有依据的修改 .-> B1
I[已有稿件与输入资料 · 可选] -. 按需引用 .-> B2
classDef expression fill:#e5eee7,stroke:#7e9e86,color:#28543a
classDef delivery fill:#f2ecdf,stroke:#ad9569,color:#665231
class B1,B2,B3 expression
class C1,C2 delivery`;
