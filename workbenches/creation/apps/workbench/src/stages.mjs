export const stages = [
  [
    "goal",
    "目标与选题",
    "研究",
    "brief.md、project.md",
    "研究主编",
    "受众、核心问题与交付边界",
    "research-report-workflow",
  ],
  [
    "feedback",
    "旧版反馈 · 可选",
    "研究",
    "feedback-brief.md、change-map.md",
    "反馈分析Agent",
    "来源、窗口、评论样本与修改依据",
    "video-learning-loop",
  ],
  [
    "outline",
    "原理大纲",
    "研究",
    "outline.md、原理关系图",
    "主编 / 机制研究员",
    "大纲Review与读者理解",
    "research-report-architecture",
  ],
  [
    "evidence",
    "实证与来源",
    "研究",
    "sources.json、claims.json、benchmarks.json",
    "实证研究员",
    "独立性、比较条件与缺口",
    "research-evidence-synthesis",
  ],
  [
    "mechanism",
    "机制与计算",
    "研究",
    "mechanisms.md、calculations.json",
    "机制研究员",
    "因果、单位、假设与独立复算",
    "research-mechanism-analysis",
  ],
  [
    "report",
    "报告与原理图",
    "研究",
    "report.md、实际配图、release.md",
    "图文作者",
    "当前全文与实际图的独立定稿Review",
    "research-report-composition",
  ],
  [
    "questions",
    "读者疑问与复读",
    "研究",
    "questions.json、reader-*",
    "独立疑问者",
    "已答待复核与真实闭合分开",
    "research-reader-questioner",
  ],
  [
    "research-review",
    "报告审核记录",
    "研究",
    "review-outline / foundation / final",
    "独立报告Reviewer",
    "意见、修复与输入版本核对",
    "research-report-review",
  ],
  [
    "video-evidence",
    "视频证据底稿",
    "视频",
    "evidence-brief.md",
    "视频主编",
    "表达没有超过研究依据",
    "video-evidence-brief",
  ],
  [
    "architecture",
    "视频内容架构",
    "视频",
    "architecture.md、SCRIPT.md、时间估计",
    "编导",
    "主线、声画、删留与自然试读",
    "video-content-architecture",
  ],
  [
    "opening",
    "钩子与开头",
    "视频",
    "opening.md、expectation.md",
    "编导",
    "前10秒认题与至30秒价值兑现",
    "video-hook-opening",
  ],
  [
    "package",
    "标题与封面",
    "视频",
    "package.md、封面实物",
    "视觉作者",
    "点击承诺与开头联合核对",
    "video-title-cover",
  ],
  [
    "sample",
    "有声样片",
    "视频",
    "样片MP4、字幕与时间表",
    "制作Agent",
    "实际声音、画面和节奏Review",
    "video-production-handoff",
  ],
  [
    "final",
    "完整视频",
    "视频",
    "最终MP4、字幕与工程索引",
    "制作Agent",
    "最终导出的独立视听Review",
    "video-production-handoff",
  ],
  [
    "publish",
    "发布与互动",
    "发布",
    "发布回执、登记、评论回复记录",
    "发布负责人",
    "逐平台真实状态与48h互动",
    "video-publish-closeout",
  ],
  [
    "learning",
    "效果回顾",
    "反馈",
    "指标、评论、learning Review",
    "独立反馈分析 / Reviewer",
    "48h预期对照与72/96h补测",
    "video-learning-loop",
  ],
].map(([id, title, group, expected, owner, review, skill]) => ({
  id,
  title,
  group,
  expected,
  owner,
  review,
  skill,
}));
export function stageFor(name, area) {
  const n = name.toLowerCase();
  if (area === "docs") return "docs";
  if (n.includes("review") && n.endsWith(".json"))
    return area === "feedback"
      ? "learning"
      : area === "research"
        ? "research-review"
        : "video-review";
  if (area === "feedback")
    return /feedback-brief|change-map|old-video|intake|input-hash/.test(n)
      ? "feedback"
      : "learning";
  if (area === "publication") return "publish";
  if (area === "media") {
    if (/references|cover|package/.test(n)) return "package";
    if (/sample/.test(n)) return "sample";
    if (/\.mp4$|\.srt$|script|caption|timeline/.test(n)) return "final";
    return "sample";
  }
  if (area === "research") {
    if (/question|reader/.test(n)) return "questions";
    if (/outline/.test(n)) return "outline";
    if (/^(brief|project)\.md/.test(n)) return "goal";
    if (/mechanism|calculation/.test(n)) return "mechanism";
    if (/source|claim|benchmark|gap|verification|route-/.test(n))
      return "evidence";
    return "report";
  }
  if (/evidence/.test(n)) return "video-evidence";
  if (/opening|expectation/.test(n)) return "opening";
  if (/package|cover/.test(n)) return "package";
  if (/sample/.test(n)) return "sample";
  if (/publish|receipt/.test(n)) return "publish";
  if (/final|\.mp4$/.test(n)) return "final";
  return "architecture";
}
export const flow = `flowchart TD
G[目标与选题] --> O[原理大纲]
FB[旧版评论与数据 · 可选] --> O
O --> E[实证研究 ↔ 机制推导]
E --> R[图文报告]
R --> RR{疑问者与独立审核}
RR -->|修复| E
RR --> V[视频证据底稿]
V --> A[内容架构与口播]
A --> AR{架构Review}
AR -->|调整| A
AR --> H[钩子与开头]
AR --> P[标题与封面]
H --> HP{联合Review}
P --> HP
HP --> S[实际有声样片]
S --> SR{样片Review}
SR -->|修改| A
SR --> F[完整制作]
F --> FR{最终MP4 Review}
FR --> PUB[授权发布与回执]
PUB --> C[0–48小时评论互动]
C --> L[48小时效果Review]
L --> FB`;
