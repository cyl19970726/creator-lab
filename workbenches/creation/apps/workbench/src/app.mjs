import { publicationView } from "./publication-view.mjs";
import { mountContentContext } from "./shared-context-ui.mjs";
import {
  workspaceSelector,
  bindWorkspaceSelector,
  mountAccount,
} from "./account-ui.mjs";
import { apiPath, currentWorkspaceId } from "./workspace-api.mjs";
import { mountCollaboration } from "./collaboration-ui.mjs";
import { createImageViewer } from "./image-viewer.mjs";
import {
  phases,
  steps,
  phaseFor,
  membersFor,
  stageStatus,
  groupFor,
  groupStatus,
  coreIdFor,
  inputsFor,
  workflowDiagram,
} from "./workflow.mjs";
const app = document.querySelector("#app");
const openImage = createImageViewer(document.querySelector("#image-dialog"));
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let workspaces = [];
let data,
  topic,
  tab = "overview",
  phase = "video",
  revisionChoice = {},
  selectedStage = "positioning",
  selectedArtifact = null,
  request = 0,
  pendingLocation = null,
  pendingSeek = null,
  pendingHeading = null,
  assetContext = null;
const statusLabel = {
  match: "输入版本一致",
  stale: "输入已变更",
  missing: "有输入缺失",
  unverifiable: "版本未能核对",
};
const verdictLabel = {
  accepted: "接受",
  accepted_with_limits: "限定范围接受",
  pass: "通过",
  revise: "需修改",
  changes_required: "需修改",
  "insufficient-evidence": "证据不足",
};
const fmtDate = (x) =>
  x ? new Date(x).toLocaleString("zh-CN", { hour12: false }) : "未记录";
const bytes = (n) =>
  n > 1e6
    ? (n / 1e6).toFixed(1) + " MB"
    : Math.max(1, Math.round(n / 1024)) + " KB";
function asset(id) {
  return (
    topic.artifacts.find((a) => a.id === id) ||
    data.docs.find((a) => a.id === id)
  );
}
function chip(text, cls = "") {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}
function versionChip(rv) {
  return chip(
    statusLabel[rv.version],
    rv.version === "match" ? "consistent" : "warn",
  );
}
function findingCard(f, i, reviewId) {
  const independentlyRechecked =
    f.recheck_status === "resolved_by_independent_recheck";
  const closed =
    independentlyRechecked ||
    f.resolved === true ||
    ["resolved", "closed"].includes(f.status);
  const title = esc(f.title || f.location || "意见 " + (i + 1));
  const body = `<p>${esc(f.evidence || f.description || f.message || "")}</p>${f.repair ? `<p>${closed ? "修复记录" : "建议修改"}：${esc(f.repair)}</p>` : ""}${f.recheck || f.recheck_status ? `<p>复验记录：${esc(f.recheck || f.recheck_status)}</p>` : ""}${f.recheck_evidence ? `<p>复验证据：${esc(f.recheck_evidence)}</p>` : ""}<button class="text-button" data-location="${esc(f.location || "")}" data-review="${esc(reviewId)}">定位这条意见 →</button>`;
  return closed
    ? `<details class="finding finding-resolved" data-finding-id="${esc(f.id || i)}"><summary>${independentlyRechecked ? "已修复并复核" : "原记录标为已解决"} · ${title}</summary>${body}</details>`
    : `<section class="finding" data-finding-id="${esc(f.id || i)}"><b>${title}</b>${body}</section>`;
}
function reviewCards(reviews, compact = false) {
  if (!reviews.length)
    return '<div class="empty"><b>本轮尚无可用的审核结论</b><p>先审阅当前产物。代理的批改、独立检查与用户确认分开记录。</p></div>';
  return reviews
    .map(
      (rv) =>
        `<article class="review-card"><h3>${rv.mode === "simulated_reader" ? "模拟读者 · " : ""}${esc(verdictLabel[rv.decision] || rv.decision)}</h3><p class="review-purpose">${rv.version === "match" ? "该记录对应的输入版本仍一致。" : "这份记录的输入已变化或未能核对，只作历史依据。"}</p>${rv.findings.length ? rv.findings.map((f, i) => findingCard(f, i, rv.id)).join("") : '<p class="meta">此记录没有新增问题；不代表代理或用户已经接受内容。</p>'}${rv.limits.length ? `<details><summary>检查范围与保留限制</summary><ul>${rv.limits.map((l) => `<li>${esc(typeof l === "string" ? l : JSON.stringify(l))}</li>`).join("")}</ul></details>` : ""}<details><summary>审核来源与版本依据</summary><p>${esc(rv.reviewer)} · ${fmtDate(rv.date)}</p><p class="meta">${esc(rv.stage)} · ${esc(rv.mode)}<br>${esc(rv.native || "原生执行引用未记录")}</p>${versionChip(rv)}${rv.inputs.map((i) => `<div class="input-row">${i.artifactId ? `<button class="text-button" data-artifact="${i.artifactId}">${esc(i.path)}</button>` : esc(i.path)} ${chip(i.state)}</div>`).join("")}<p class="meta">哈希只核对版本，不验证语义正确或独立身份。</p><button class="text-button" data-artifact="${rv.id}">查看原始审核文件 ↗</button></details></article>`,
    )
    .join("");
}
function revisionKind() {
  return phase === "video" && selectedStage !== "positioning"
    ? "video"
    : "report";
}
function currentRevision() {
  const kind = revisionKind();
  const id =
    revisionChoice[topic.id + ":" + kind] ||
    (kind === "video" ? topic.currentVideo : topic.currentReport);
  return topic.revisions?.find((r) => r.id === id) || null;
}
function stepInfo() {
  return steps.find((s) => s.id === selectedStage) || steps[0];
}
function phaseInfo() {
  return phases.find((p) => p.id === phase) || phases[0];
}
function relevantFiles() {
  const rev = currentRevision();
  if (phase === "publish")
    return topic.artifacts.filter(
      (a) => a.area === "feedback" || a.stage === "publish",
    );
  return topic.artifacts.filter((a) => a.revisionId === rev?.id);
}
function coreFor(step = selectedStage) {
  return (
    coreIdFor(currentRevision(), step) ||
    keyAssets(currentRevision(), groupFor(step))[0]?.id ||
    null
  );
}
function decisionSummary(rev) {
  if (!rev) return "版本尚未登记";
  if (rev.editorialStatus) return rev.editorialStatus;
  if (rev?.state === "rejected-direction") return "方向已否定 · 历史材料";
  if (rev?.state === "not-produced") return "尚未制作 · 设计需重新确认";
  if (rev?.state === "historical")
    return [topic.currentReport, topic.currentVideo].includes(rev.id)
      ? "本轮参照 · 沿用具体版本的原接受范围"
      : "历史版本 · 可回看原产物与决定";
  return rev.state === "candidate"
    ? "当前候选 · 用户确认未记录"
    : "当前报告 · 用户确认未记录";
}
// Read-only publication projection; receipts retain their own platform/version evidence.
function publicationItems() {
  return publicationView(data, topic);
}
function historicalReceipts() {
  return topic.artifacts.filter(
    (a) =>
      a.coreStep === "publish" ||
      /(?:发布回执|publish-log|publish-receipt)/.test(a.name),
  );
}
function currentPublicationItems() {
  return publicationItems().filter(
    (item) =>
      item.video_version === topic.currentVideo ||
      item.video_version?.startsWith(topic.currentVideo + "/"),
  );
}
function publicationStatus() {
  if (data.publication?.error) return "状态未知";
  const currentVideo = topic.revisions.find(
    (revision) => revision.id === topic.currentVideo,
  );
  const rows = currentPublicationItems(),
    history = publicationItems().length || historicalReceipts().length;
  if (currentVideo?.state === "not-produced")
    return history ? "本版未发布 · 可查历史回执" : "本版未发布";
  const published = rows.filter((row) => row.status === "published").length;
  const unread = rows.some(
    (row) => row.state_path && !data.publicationReceipts?.[row.state_path],
  );
  if (rows.length && rows.every((row) => row.observationOnly))
    return "已有本版提交回执 · 历史观察";
  if (published)
    return !unread && published === rows.length
      ? "本版已发布"
      : "本版部分已发布";
  return rows.length
    ? "本版发布处理中"
    : history
      ? "本版无核验记录 · 可查历史回执"
      : "未登记";
}

function publishStepStatus(id) {
  if (id === "publish") return publicationStatus();
  const records = (data.publication?.items || []).filter(
    (i) => (i.topic_id || i.topicId) === topic.id,
  );
  if (records.length && records.every((i) => i.enabled === false))
    return "后续协议 / 未启动";
  if (id === "comments")
    return topic.comments?.data?.rows?.length
      ? "已有样本 · 核对版本"
      : "后续协议 / 未启动";
  return topic.metrics?.length ? "已有数据 · 核对版本" : "后续协议 / 未启动";
}
function workUrl(value) {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
const platformName = (p) =>
  ({ xiaohongshu: "小红书", douyin: "抖音", channels: "视频号" })[p] || p;
const publicationState = (s) =>
  ({
    published: "已发布",
    submitted: "已提交",
    reviewing: "审核中",
    submission_intent_recorded: "准备提交",
    pending: "待处理",
    pending_review: "待审核",
    pending_approval: "待发布审阅",
    pending_publish: "待发布",
    preparing: "准备中",
    uploading: "上传中",
    uploaded: "已上传，待核对",
    processing: "平台处理中",
    draft: "草稿",
    ready: "待提交",
    scheduled: "已定时",
    failed: "发布失败",
    rejected: "审核未通过",
    blocked_subtitle_overlay: "字幕安全区修复中",
  })[s] || (s ? "状态待核实" : "未记录");
function releaseReviewSummary(item) {
  if (!item.release_review)
    return item.review
      ? "已有独立审阅记录 · 原文见回执"
      : item.visualDecision === "user-accepted-for-this-release"
        ? "用户接受本期原版 · 后续布局问题保留"
        : "尚无可读取的发布判定记录";
  // Only explicit positive release decisions earn a positive headline.
  return /明确最终通过|最终有限通过/.test(item.release_review)
    ? "代理审阅通过 · 成片与平台预览已核对"
    : "已有代理审阅记录 · 请查看判定原文";
}

async function loadPublicationReceipts(catalog) {
  catalog.publicationReceipts = {};
  const artifacts = catalog.topics.flatMap((t) => t.artifacts);
  await Promise.all(
    [
      ...new Set(
        (catalog.publication?.items || [])
          .map((i) => i.state_path)
          .filter(Boolean),
      ),
    ].map(async (path) => {
      const artifact = artifacts.find((a) => a.logicalUri === path);
      if (!artifact) return;
      try {
        const response = await fetch(apiPath("artifact/") + artifact.id);
        if (!response.ok) return;
        const result = await response.json();
        if (result.kind === "json" && result.data?.platforms)
          catalog.publicationReceipts[path] = {
            id: artifact.id,
            data: result.data,
          };
      } catch {
        /* The register stays visible; no approval is inferred. */
      }
    }),
  );
}
function workspaceURL(artifactId = null) {
  const url = new URL(location.href);
  url.searchParams.set("workspace", currentWorkspaceId());
  url.searchParams.set("case", topic.id);
  url.searchParams.delete("view");
  const hash = new URLSearchParams();
  if (artifactId) {
    hash.set("artifact", artifactId);
    if (assetContext?.assetId === artifactId) {
      hash.set("context", assetContext.revisionId);
      hash.set("step", assetContext.stepId);
    }
  }
  url.hash = hash.toString();
  return url.pathname + url.search + url.hash;
}
const panelOffsets = new Map();
function selectMobilePanel(mode) {
  if (mode === "review" && !document.querySelector(".review-panel")) {
    const id =
      mainReport()?.id ||
      topic.revisions.find((r) => r.id === topic.currentReport)?.coreIds
        ?.report;
    if (id) navigateArtifact(id);
  }
  const previous = document.body.dataset.mobile || "artifact";
  const repeated = previous === mode;
  if (!repeated)
    panelOffsets.set(
      (selectedArtifact || topic.id) + ":" + previous,
      window.scrollY,
    );
  document.body.dataset.mobile = mode;
  document
    .querySelectorAll(".mobile-mode [data-mobile]")
    .forEach((button) =>
      button.classList.toggle("selected", button.dataset.mobile === mode),
    );
  if (!window.matchMedia("(max-width: 800px)").matches) return;
  requestAnimationFrame(() => {
    const target =
      mode === "review"
        ? document.querySelector(".review-panel")
        : mode === "steps"
          ? document.querySelector(".phase-nav")
          : document.querySelector(".reader");
    const saved = panelOffsets.get((selectedArtifact || topic.id) + ":" + mode);
    if (mode === "artifact" && saved !== undefined && !repeated)
      window.scrollTo({ top: saved });
    else target?.scrollIntoView({ block: "start" });
  });
}
function layout() {
  document.body.classList.remove("account-empty-shell");
  document.body.dataset.view = tab;
  const current = phaseInfo(),
    rev = currentRevision();
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="#" id="home-link"><span class="brand-mark">t.</span><span>内容工作台<small>CONTENT STUDIO</small></span></a>${workspaceSelector(workspaces, currentWorkspaceId())}<label class="select-label" for="topic-select">当前选题</label><select id="topic-select">${data.topics.map((t) => `<option value="${esc(t.id)}" ${t.id === topic.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}</select><button data-view="overview" class="overview-link ${tab === "overview" ? "active" : ""}">选题总览 <span>↗</span></button><nav class="phase-nav" aria-label="创作阶段与可选输入">${phases
    .map(
      (p, i) =>
        `<section class="phase-section"><button class="phase-button ${p.id === phase && tab === "artifacts" ? "active" : ""}" data-phase="${p.id}" aria-expanded="${p.id === phase}"><span class="phase-number">0${i + 1}</span><b>${esc(p.title)}</b><span>${p.id === phase ? "−" : "+"}</span></button>${
          p.id === phase
            ? `<div class="step-nav">${p.steps
                .map((id) => {
                  const st = steps.find((s) => s.id === id);
                  return `<button data-stage="${id}" class="step-link ${id === groupFor(selectedStage) && tab === "artifacts" ? "selected" : ""}" ${id === groupFor(selectedStage) ? 'aria-current="step"' : ""}><span class="step-dot"></span><span class="step-name">${esc(st.code)} ${esc(st.title)}</span><small class="step-status">${phase === "publish" ? esc(publishStepStatus(id)) : esc(stepSummary(currentRevision(), id))}</small></button>`;
                })
                .join("")}</div>`
            : ""
        }</section>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><button class="text-button" data-view="docs">文档与方法 ↗</button><p>每份产物都有版本与依据<br>意见绑定版本，决定保留范围</p></div></aside><div class="shell"><header class="topbar"><div class="breadcrumb">${esc(tab === "account" ? data.workspace.name : topic.title)} <span>/</span> ${tab === "account" ? "账号与内容" : tab === "overview" ? "选题总览" : tab === "document" ? (isCollaborationAsset(asset(selectedArtifact)) ? "当前协作 / 文档" : "文档与方法") : tab === "docs" ? "文档与方法"  : esc(current.title)}</div><div class="top-actions"><span class="snapshot">${data.index?.stale ? "索引更新失败 · 显示上次数据" : "资料读取于 " + fmtDate(data.generatedAt)}</span><button id="refresh" class="button">刷新 ↻</button></div></header><main id="workspace" tabindex="-1"><div class="mobile-mode" aria-label="移动端面板"><button data-mobile="steps">步骤</button><button data-mobile="artifact" class="selected">产物</button>${'<button data-mobile="review">意见</button>'}</div>${tab === "account" ? "" : contextBand()}${data.index?.error ? `<div class="notice">资料索引更新失败：${esc(data.index.error)}。保留上次成功快照，请核对资料时间。</div>` : ""}<div id="content"></div></main></div>`;
  bindWorkspaceSelector(app, openAccount);
  document.querySelector("#topic-select").onchange = (e) => {
    topic = data.topics.find((t) => t.id === e.target.value);
    phase = "video";
    tab = "overview";
    selectedStage = "positioning";
    selectedArtifact = null;
    history.replaceState(null, "", workspaceURL());
    layout();
    render();
  };
  document.querySelector("#refresh").onclick = () => load(false);
  document.querySelector("#home-link").onclick = (e) => {
    e.preventDefault();
    tab = "overview";
    history.replaceState(null, "", workspaceURL());
    layout();
    render();
  };
  bind(app);
  document
    .querySelectorAll(".mobile-mode [data-mobile]")
    .forEach((button) =>
      button.classList.toggle(
        "selected",
        button.dataset.mobile === (document.body.dataset.mobile || "artifact"),
      ),
    );
}
function fileRows(files) {
  return files
    .map(
      (a) =>
        `<button class="file-row ${a.id === selectedArtifact ? "selected" : ""}" data-artifact="${a.id}"><span class="file-type">${esc(a.ext.toUpperCase())}</span><span><b>${esc(namedAsset(a))}</b><small>${esc(a.name)} · ${bytes(a.size)}</small></span><span>↗</span></button>`,
    )
    .join("");
}
function isCollaborationAsset(file) {
  return (
    !!file &&
    (topic.collaboration?.artifactUris || []).includes(file.displayPath)
  );
}
function namedAsset(file) {
  if (!file) return "资产未登记";
  const registeredName = topic.revisions?.find(
    (revision) => revision.id === file.revisionId,
  )?.assetLabels?.[file.logicalUri || file.displayPath];
  if (typeof registeredName === "string" && registeredName.trim())
    return registeredName.trim();
  const source = topic.collaboration?.sources?.find(
    (s) => s.path === file.displayPath,
  );
  if (source) return source.label;
  if (topic.id === "minimax-h3" && file.coreStep === "publish") {
    if (file.revisionId === "shorts-v3") return "三条短片 v3 · 历史回执";
    if (file.revisionId === "video-v1") return "早期 EP02 · 历史回执";
  }
  if (/review-sheet\.(jpg|png)$/.test(file.name)) return "关键帧联审图";
  if (
    file.coreStep === "sample" &&
    ["png", "jpg", "jpeg", "webp", "svg"].includes(file.ext)
  )
    return "样片设计参考图";
  if (/01-payback/.test(file.name)) return "短视频 1 · 本地部署多久回本";
  if (/02-workload/.test(file.name)) return "短视频 2 · 双 Spark 的速度差";
  if (/03-offload/.test(file.name)) return "短视频 3 · 双卡怎样装下 H3";
  if (/model-characteristics/.test(file.name)) return "模型特性研究";
  if (/route-benchmarks/.test(file.name)) return "部署路线与实测依据";
  if (/ecosystem-addendum/.test(file.name)) return "修改版与生态补查";
  if (/verification-round/.test(file.name)) return "关键事实复核";
  if (file.name === "runtime-story.json") return "双 Spark 运行图解";
  if (file.coreStep)
    return (
      steps.find((s) => s.id === file.coreStep)?.artifactTitle || file.name
    );
  return file.name;
}
function contextBand() {
  const context = topic.collaboration || {};
  const account = data.workspace?.kind === "account";
  const purpose = data.workspace?.positioning?.purpose;
  const longTerm = account
    ? purpose?.value || "本账号的长期目的尚未确认"
    : context.longTermGoal || topic.direction;
  return `<section class="context-band" aria-label="共享上下文"><details class="context-details" ${window.matchMedia("(max-width: 800px)").matches ? "" : "open"}><summary>共享上下文<span> · ${esc(topic.title)}</span></summary><div class="context-full"><div><span>${account ? "账号长期目的" : "长期目的"}</span><p>${esc(longTerm)}</p></div><div><span>本期承诺</span><p>${esc(context.currentCommitment || topic.direction)}</p></div><div><span>当前阶段</span><p>${esc(context.currentStageGoal || context.title || phaseInfo().title)}</p></div><div><span>本轮任务</span><p>${esc(context.currentTask || context.next || topic.currentWork?.next || "查看当前关键资产与已有决定")}</p></div><details><summary>近期变化与接下来</summary><p><b>最近：</b>${esc(context.recent || "尚未记录")}</p><p><b>结果：</b>${esc(context.result || "尚未记录")}</p><p><b>下一步：</b>${esc(context.next || topic.currentWork?.next || "尚未记录")}</p><small>上下文更新于 ${esc(context.updatedAt || "未记录")}</small><div class="context-sources">${(
    context.sources || []
  )
    .map((source) => {
      const file = data.docs.find((a) => a.displayPath === source.path);
      return file
        ? `<button class="text-button" data-artifact="${file.id}">${esc(source.label)} ↗</button>`
        : "";
    })
    .join(" · ")}</div></details></div></details></section>`;
}
function mainReport() {
  const source = topic.collaboration?.sources?.find((s) =>
    /workflow-report\.md$/.test(s.path),
  );
  return data.docs.find((a) => a.displayPath === source?.path);
}
function positioningEntry() {
  const source = topic.collaboration?.positioningSource;
  if (source) {
    const file = [...topic.artifacts, ...data.docs].find(
      (file) => file.displayPath === source.path,
    );
    return {
      file,
      heading: source.heading,
      label: source.label || "本版内容定位",
    };
  }
  return {
    file: mainReport(),
    heading: "B1：完整内容定位",
    label: "完整定位建议",
  };
}
function openPositioning() {
  const entry = positioningEntry();
  if (!entry.file) return false;
  pendingHeading = entry.heading || null;
  navigateArtifact(entry.file.id, {
    contextRevisionId: topic.currentReport,
    stepId: "positioning",
  });
  return true;
}
function keyAssets(revision = null, group = null) {
  const revisions = revision
    ? [revision]
    : topic.revisions.filter((r) =>
        [topic.currentReport, topic.currentVideo].includes(r.id),
      );
  const ids = new Set(
    revisions.flatMap((r) =>
      Object.entries(r.coreIds || {})
        .filter(([key]) => !group || membersFor(group).includes(key))
        .map(([, id]) => id),
    ),
  );
  // Several deliverables can belong to the same production step.
  for (const file of topic.artifacts)
    if (
      revisions.some((r) => r.id === file.revisionId) &&
      file.ext === "mp4" &&
      (!group || groupFor(group) === "final")
    )
      ids.add(file.id);
  if (groupFor(group) === "evidence") {
    for (const file of topic.artifacts) {
      if (
        revisions.some((r) => r.id === file.revisionId) &&
        file.ext === "md" &&
        /model-characteristics|route-|ecosystem-addendum|verification-round|mechanism|source|claim|benchmark/.test(
          file.name,
        )
      )
        ids.add(file.id);
    }
  }
  if (groupFor(group) === "publish") {
    ids.clear();
    const current = currentPublicationItems();
    const paths = new Set(current.map((i) => i.state_path));
    for (const file of topic.artifacts)
      if (paths.has(file.logicalUri)) ids.add(file.id);
    if (!ids.size) for (const file of historicalReceipts()) ids.add(file.id);
  }
  const files = [...ids].map(asset).filter(Boolean);
  if (!revision && !group) {
    const finalId = topic.revisions.find((r) => r.id === topic.currentVideo)
      ?.coreIds?.final;
    const finalFile = asset(finalId);
    const family = (name) =>
      name
        .split("/")
        .pop()
        .replace(/-v\d+(?=\.)/i, "");
    return files.filter(
      (file) =>
        file.coreStep === "report" ||
        (file.ext === "mp4" &&
          !/sample/.test(file.name) &&
          (file.id === finalId ||
            (!/(?:draft|-r\d+)\.mp4$/.test(file.name) &&
              (!finalFile || family(file.name) !== family(finalFile.name))))),
    );
  }
  return files;
}
function stepSummary(rev, id) {
  const outputs = keyAssets(rev, id).length;
  const inputs = inputsFor(rev, id).length;
  return (
    [
      outputs ? `${outputs} 项关键资产` : "",
      inputs ? `${inputs} 项沿用输入` : "",
    ]
      .filter(Boolean)
      .join(" · ") || groupStatus(rev, id)
  );
}
function inputCards(rev, refs, group) {
  if (!refs.length) return "";
  return `<section class="reused-inputs" aria-label="本版沿用输入"><p>沿用输入 · 保留来源版本与原资产的意见和接受范围</p><div class="step-assets">${refs
    .map((ref) => {
      const file = asset(ref.assetId);
      const source = topic.revisions.find((r) => r.id === ref.sourceRevisionId);
      return file
        ? `<button class="key-asset ${file.id === selectedArtifact ? "selected" : ""}" data-artifact="${file.id}" data-input-revision="${rev.id}" data-input-step="${ref.step || group || "evidence"}"><span class="asset-kind">沿用输入</span><b>${esc(ref.label || namedAsset(file))}</b><small>来源：${esc(source?.label || ref.sourceRevisionId)}</small></button>`
        : "";
    })
    .join("")}</div></section>`;
}
function reportStateNote(file) {
  return file?.coreStep === "report" && file.ext === "md"
    ? `<div class="report-state-note"><span>正文保留交付时状态；最新审阅与接受范围见意见面板。</span><button class="text-button" data-latest-decisions>查看最新决定 →</button></div>`
    : "";
}
function inputSourceNote(rev, file) {
  const ref = rev?.inputRefs?.find((ref) => ref.assetId === file?.id);
  if (!ref) return "";
  const source = topic.revisions.find((r) => r.id === ref.sourceRevisionId);
  return `<div class="input-source-note">沿用输入 · 来源：${esc(source?.label || ref.sourceRevisionId)}。本页意见和接受范围仍绑定这份原资产，不代表本版整体已接受。</div>`;
}
function assetCards(files) {
  return files
    .map(
      (file) =>
        `<button class="key-asset ${file.id === selectedArtifact ? "selected" : ""}" data-artifact="${file.id}"><span class="asset-kind">${esc(file.ext === "mp4" ? "视频" : file.ext === "md" ? "文档" : file.ext === "json" && file.name === "runtime-story.json" ? "交互图解" : "资产")}</span><b>${esc(file.coreStep === "report" && file.revisionId === topic.currentReport ? "本轮内容报告" : namedAsset(file))}</b><small>${esc(topic.revisions.find((r) => r.id === file.revisionId)?.label || "协作报告")}</small></button>`,
    )
    .join("");
}
function routeOverview() {
  return `<section class="workflow-route" aria-label="完整阶段与步骤">${phases
    .map(
      (p) =>
        `<div class="route-phase ${p.id}"><h2>${esc(p.title)}</h2>${p.steps
          .map((id) => {
            const st = steps.find((s) => s.id === id);
            const rev = topic.revisions.find(
              (r) =>
                r.id ===
                (p.id === "video" ? topic.currentVideo : topic.currentReport),
            );
            return `<button data-stage="${id}" aria-label="${esc(st.code + " " + st.title)}"><b>${st.code}</b><span>${esc(st.title)}<small>${p.id === "publish" ? esc(publishStepStatus(id)) : id === "positioning" && positioningEntry().file ? positioningEntry().label : esc(stepSummary(rev, id))}</small></span><span>→</span></button>`;
          })
          .join("")}</div>`,
    )
    .join("")}</section>`;
}
function mountReview(file, legacyHTML = "") {
  const node = document.querySelector(".review-panel");
  if (node && file)
    mountCollaboration(node, {
      topicId: topic.id,
      file,
      stepId:
        file.area === "docs"
          ? undefined
          : steps.find((s) => s.id === groupFor(selectedStage))?.code,
      title: namedAsset(file),
      onNavigate: navigateArtifact,
      legacyHTML,
      onBind: bind,
      onRefresh: () => showArtifact(file),
      onDrawDiagram: drawDiagram,
    });
}
function render() {
  const c = document.querySelector("#content"),
    s = stepInfo(),
    rev = currentRevision();
  if (tab === "account") {
    renderAccount(c);
  } else if (tab === "overview") {
    const reportDocument = mainReport();
    c.innerHTML = `<div class="page-heading"><div><div class="eyebrow">当前选题</div><h1>${esc(topic.title)}</h1><p>${esc(topic.direction)}</p></div>${reportDocument ? `<button class="primary-button" data-artifact="${reportDocument.id}">工作流与协作说明 →</button>` : ""}</div>${routeOverview()}<section class="key-assets-section"><div class="section-heading"><h2>关键资产</h2><span>${esc(topic.currentWork?.status || "接受范围见具体版本记录")}</span></div><div class="key-assets">${assetCards(keyAssets())}</div></section><details class="panel map-details"><summary>流程中的返回与修改关系</summary><div id="flow-diagram" class="flow-frame"></div></details><div id="content-collaboration"></div>`;
    mountContentContext(
      document.querySelector("#content-collaboration"),
      topic,
      () => load(false),
      navigateArtifact,
    );
    drawDiagram(document.querySelector("#flow-diagram"), workflowDiagram);
  } else if (tab === "document") {
    const file = asset(selectedArtifact);
    const collaboration = isCollaborationAsset(file);
    const note = topic.collaboration?.documentNotes?.[file?.displayPath];
    c.innerHTML = `<div class="page-heading"><div><div class="eyebrow">${collaboration ? "共同依据" : "文档与方法"}</div><h1 id="document-title">${esc(namedAsset(file))}</h1></div><button class="button" data-view="${collaboration ? "overview" : "docs"}">${collaboration ? "返回选题全貌" : "返回文档与方法"}</button></div>${note ? `<details class="asset-note"><summary>用途与版本说明</summary><p>${esc(note)}</p></details>` : ""}<div class="artifact-layout"><section class="reader panel document-reader"><div class="reader-bar"><span>${esc(namedAsset(file))}</span><button class="text-button" id="review-toggle">展开／收起意见</button>${file ? `<a href="${apiPath("asset/" + file.id)}" target="_blank" rel="noopener">原始文件 ↗</a>` : ""}</div><div id="reader-content"></div></section><aside class="review-panel"></aside></div>`;
    document.querySelector("#review-toggle").onclick = () =>
      document
        .querySelector(".artifact-layout")
        .classList.toggle("hide-review");
    if (file) {
      showArtifact(file);
      if (collaboration) mountReview(file);
      else
        document.querySelector(".artifact-layout").classList.add("hide-review");
    }
  } else if (tab === "docs") {
    c.innerHTML = `<div class="page-heading"><div><div class="eyebrow">REFERENCE</div><h1>文档与方法</h1><p>产品意图、生产流程与实际实现分开记录。</p></div></div><section class="panel">${fileRows(data.docs)}</section>`;
  } else {
    let files = relevantFiles();
    if (!selectedArtifact && phase !== "publish") {
      selectedArtifact = coreFor();
      const input = rev?.inputRefs?.find(
        (ref) => ref.assetId === selectedArtifact,
      );
      assetContext = input
        ? {
            assetId: selectedArtifact,
            revisionId: rev.id,
            stepId: selectedStage,
          }
        : null;
      if (selectedArtifact)
        history.replaceState(null, "", workspaceURL(selectedArtifact));
    }
    const f = asset(selectedArtifact);
    const related = topic.reviews.filter(
      (r) => r.inputs.some((i) => i.artifactId === f?.id) || r.id === f?.id,
    );
    const stageReviews = topic.reviews.filter(
      (r) =>
        r.revisionId === rev?.id &&
        (selectedStage === "research-review" ||
          selectedStage === "design" ||
          r.stage ===
            {
              "video-evidence": "evidence",
              architecture: "architecture",
              opening: "hook",
              package: "package",
              sample: "sample",
              final: "final",
              outline: "outline",
            }[selectedStage]),
    );
    const reviews = related.length ? related : stageReviews;
    const options =
      topic.revisions?.filter((r) => r.kind === revisionKind()) || [];
    c.innerHTML = `<div class="page-heading artifact-heading"><div><div class="eyebrow">${esc(phaseInfo().title)} / ${esc(s.title)}</div><h1>${esc(currentRevision()?.id === "runtime-v1" && selectedStage === "report" ? "双 Spark 运行图解" : s.artifactTitle)}</h1><p>${esc(s.question)}</p></div>${phase !== "publish" && selectedStage !== "positioning" ? `<div class="version-control"><label for="revision-select">${phase === "research" ? "报告与关联产物" : "查看版本"}</label><select id="revision-select">${options.map((r) => `<option value="${r.id}" ${r.id === rev?.id ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></div>` : ""}</div>${`<div class="step-assets" aria-label="本步骤关键资产">${assetCards(keyAssets(rev, groupFor(selectedStage)))}</div>`}${inputCards(rev, inputsFor(rev, groupFor(selectedStage)), groupFor(selectedStage))}${phase !== "publish" ? `<div class="version-ribbon ${rev?.state === "rejected-direction" ? "rejected" : ""}"><span>${esc(decisionSummary(rev))}</span>${rev?.decision?.sourceId ? `<button class="text-button" data-artifact="${rev.decision.sourceId}">查看决定记录 ↗</button>` : ""}</div>` : ""}${rev?.contextNotice ? `<details class="asset-note"><summary>用途与版本说明</summary><p>${esc(rev.contextNotice)}</p></details>` : ""}<div class="artifact-layout "><section class="reader panel"><div class="reader-bar"><span>${esc(f ? namedAsset(f) : s.artifactTitle)}</span><button class="text-button" id="review-toggle">展开／收起意见</button>${f ? `<a href="${apiPath("asset/" + f.id)}" target="_blank" rel="noopener">原始文件 ↗</a>` : ""}</div>${inputSourceNote(rev, f)}${reportStateNote(f)}<div id="reader-content"></div></section><aside class="review-panel"><div class="panel-title"><h2>审阅与修改</h2><span>当前产物关联</span></div><div class="user-decision">${rev?.stageStates?.[selectedStage] ? `<div class="eyebrow">当前阶段执行记录</div><p>生产：${esc(rev.coreIds?.[selectedStage] ? rev.stageStates[selectedStage].production : "文件缺失")}<br>独立审阅：${esc(rev.stageStates[selectedStage].independent || "未记录")}<br>代理审阅：${esc(rev.stageStates[selectedStage].proxy || "未记录")}</p>` : ""}<div class="eyebrow">用户方向与确认</div><b>${esc(rev?.decision?.label || "尚无确认记录")}</b><p>${rev?.decision ? esc(rev.decision.provenance) : "可以审阅这份产物；可在这里记录意见与具体接受范围。"}</p></div><div class="review-question"><b>本轮请判断</b><p>${esc((rev?.id === topic.currentWork?.version ? topic.currentWork?.next : null) || s.question)}</p><small>代理批改不等于用户本人确认</small></div>${reviewCards(
      reviews.filter((r) => r.version === "match"),
      true,
    )}${
      reviews.some((r) => r.version !== "match")
        ? `<details class="history-reviews"><summary>历史审核 · ${reviews.filter((r) => r.version !== "match").length} 份</summary>${reviewCards(
            reviews.filter((r) => r.version !== "match"),
            true,
          )}</details>`
        : ""
    }${
      phase === "research" && rev
        ? `<details class="history-reviews"><summary>本报告其他审核与读者记录</summary>${reviewCards(
            topic.reviews.filter(
              (r) => r.revisionId === rev.id && !reviews.includes(r),
            ),
            true,
          )}</details>`
        : ""
    }</aside></div><details class="source-drawer"><summary>依据与过程材料 · ${files.length} 份 <span>原始探索、数据、图表与执行记录</span></summary><div class="source-grid">${fileRows(files)}</div></details>${inputCards(
      rev,
      (rev?.inputRefs || []).filter((ref) => !ref.step),
      "evidence",
    )}`;
    if (phase !== "publish" && selectedStage !== "positioning")
      document.querySelector("#revision-select").onchange = (e) => {
        revisionChoice[topic.id + ":" + revisionKind()] = e.target.value;
        selectedArtifact = null;
        history.replaceState(null, "", workspaceURL());
        layout();
        render();
      };
    document.querySelector("#review-toggle").onclick = () =>
      document
        .querySelector(".artifact-layout")
        .classList.toggle("hide-review");
    const target = document.querySelector("#reader-content");
    if (phase === "publish" && !f) {
      renderFeedback(target);
    } else if (selectedStage === "positioning" && !f) {
      const report = mainReport();
      target.innerHTML = `<div class="empty-state"><h2>在完整报告中审阅定位</h2><p>主题、读者、内容价值与交付方案集中在同一份报告。</p>${report ? `<button class="primary-button" data-artifact="${report.id}">工作流与协作说明 →</button>` : "<p>本选题尚未登记定位报告。</p>"}</div>`;
    } else if (selectedStage === "design" && !f) {
      const ids = ["video-evidence", "architecture", "opening", "package"].map(
        (id) => ({ id, artifact: asset(rev?.coreIds[id]) }),
      );
      target.innerHTML = `<div class="design-intro"><h2>完整视频设计审阅包</h2><p>证据、主线、开头和包装共同构成一份设计。依据已记录的接受范围继续样片制作。</p></div>${ids.map(({ id, artifact }) => `<section class="design-part"><h3>${esc(steps.find((s) => s.id === id).artifactTitle)}</h3>${artifact ? fileRows([artifact]) : '<p class="empty">当前版本尚未生成</p>'}</section>`).join("")}<div class="notice">请查看意见与决定，核对设计的具体接受范围。</div>`;
    } else if (f) {
      showArtifact(f);
    } else {
      target.innerHTML = `<div class="empty-state"><span class="empty-symbol">◇</span><h2>${esc(s.artifactTitle)}${rev?.missingCores?.some((m) => m.step === selectedStage) ? "文件缺失" : rev?.stageStates?.[selectedStage]?.productionState === "in_progress" ? "制作中" : "尚未生成"}</h2><p>本步骤需要：${esc(s.question)}。</p>${phase === "video" ? "<p>先核对相关报告、设计与已记录的接受范围，再继续制作。</p>" : ""}${phase === "video" && topic.revisions?.some((r) => r.id === "video-v2") ? '<button class="button" data-history-video>查看已被否定的历史视频材料</button>' : ""}</div>`;
    }
  }
  bind(c);
  if (tab === "artifacts" && selectedArtifact) {
    const panel = document.querySelector(".review-panel");
    mountReview(asset(selectedArtifact), panel?.innerHTML || "");
  }
}
function renderFeedback(target) {
  if (selectedStage === "publish") {
    const pub = data.publication || {},
      items = publicationItems(),
      receipts = historicalReceipts();
    target.innerHTML = `<h2>发布登记与实际回执</h2>${chip(publicationStatus())}${
      pub.error
        ? '<div class="notice">登记表无法读取，发布状态未知。</div>'
        : items.length
          ? `<div class="publication-list">${items
              .map((item) => {
                const url = workUrl(item.public_url || item.url);
                return `<article class="publication-card"><h3>${esc(platformName(item.platform))} ${!(item.video_version === topic.currentVideo || item.video_version?.startsWith(topic.currentVideo + "/")) ? chip("历史作品") : ""} ${chip(publicationState(item.status), item.status === "published" ? "consistent" : "warn")}</h3><p>账号：${esc(item.account_name || "")} ${esc(item.account_id || "未记录")}</p><p>${item.observationOnly ? "历史观察时间" : "发布时间"}：${esc(item.observationOnly ? fmtDate(item.observedAt || item.published_at) : item.published_at_platform || (item.published_at ? fmtDate(item.published_at) : "未记录"))}</p>${item.lastObserved ? `<p>${esc(item.lastObserved)}</p>` : ""}${item.observationOnly ? `<p class="meta">${esc(item.receipt?.platformStatus || "")} · 当前平台状态未重新核验</p>` : ""}${url ? `<a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看作品 ↗</a>` : '<span class="meta">作品链接尚未核实</span>'}<details><summary>版本与依据</summary>${item.receiptId ? `<button class="text-button" data-artifact="${esc(item.receiptId)}">查看实际回执 ↗</button>` : "<p>回执正文未能读取；仅显示登记信息。</p>"}<pre class="raw-text">${esc(JSON.stringify(item, null, 2))}</pre></details></article>`;
              })
              .join("")}</div>`
          : receipts.length
            ? `<div class="historical-receipts"><p>已有登记的历史发布回执。当前平台状态未重新核验，请查看具体版本、账号和当时记录。</p>${assetCards(receipts)}</div>`
            : '<div class="empty-state"><h3>本选题尚无可关联的发布登记</h3><p>空登记不能证明未发布。</p></div>'
    }<div class="life"><div><b>0–48h</b><p>评论获取与互动</p></div><div><b>48h</b><p>数据与学习 Review</p></div><div><b>72 / 96h</b><p>补测与收尾</p></div></div><p class="notice">后续协议 / 未启动。此处展示已有发布记录；没有启动排程或自动回复评论。</p>`;
    const panel = document.querySelector(".review-panel");
    panel.innerHTML = `<div class="panel-title"><h2>发布审阅依据</h2><span>逐平台记录</span></div>${items.map((item) => `<article class="review-card"><h3>${esc(platformName(item.platform))}</h3><p>${esc(releaseReviewSummary(item))}</p>${/明确最终通过|最终有限通过/.test(item.release_review || "") ? '<p class="meta">主观听音未审</p>' : ""}${item.release_review ? `<details><summary>完整发布判定</summary><p>${esc(item.release_review)}</p></details>` : ""}${item.receiptId ? `<button class="text-button" data-artifact="${esc(item.receiptId)}">查看判定来源与回执 ↗</button>` : ""}</article>`).join("")}<p class="notice">代理发布判定与用户本人确认分开记录。已发布仅依据实际回执，不由审核通过推定。</p>`;
    return;
  }
  const raw = topic.comments?.data,
    rows = raw?.rows || [];
  if (selectedStage === "comments") {
    target.innerHTML = `<div class="capture-info"><h2>实际评论样本</h2><p>采集于 ${fmtDate(raw?.captured_at)} · ${esc(raw?.sort || "排序未记录")} · ${rows.length} 条原始行</p><details><summary>来源、覆盖与去重说明</summary><pre>${esc(JSON.stringify({ url: raw?.url, coverage: raw?.coverage, filters: raw?.filters }, null, 2))}</pre></details></div>${rows.length ? rows.map((r, i) => `<article class="comment ${r.is_reply ? "reply" : ""}"><div>${chip(r.id || i + 1)} ${chip(r.is_reply ? "回复行" : "评论")} <span class="meta">${esc(r.time || "时间未记录")}</span></div><p>${esc(r.text || r.content || "原文缺失")}</p><small>点赞 ${esc(r.likes ?? "未知")} · ${r.duplicate_of ? "重复来源 " + esc(r.duplicate_of) : "去重信息见原始数据"} · 自动回复发送状态未记录</small></article>`).join("") : '<div class="empty-state">尚无已采集评论；未知不计为0。</div>'}`;
    return;
  }
  target.innerHTML = `<div class="feedback-actions"><button class="button" data-stage="comments">查看实际评论与回复 →</button></div><h2>指标与修改依据</h2><div class="summary-strip">${topic.metrics.map((m) => `<div><span>${esc(m.label)}</span><strong>${esc(m.value)}</strong><small>${esc(m.context)}</small><button class="text-button" data-artifact="${m.sourceId}">查看来源</button></div>`).join("") || "<p>结构化指标尚未登记，请查看原始材料。</p>"}</div>${fileRows(topic.artifacts.filter((a) => a.area === "feedback" && /feedback-brief|change-map|old-video/.test(a.name)))}<div class="notice">总体指标不能证明某个Hook的因果效果。反馈可能属于旧版发布作品，不表示新视频已经发布。</div>${reviewCards(
    topic.reviews.filter((r) => r.stage === "learning"),
    true,
  )}`;
}

async function drawDiagram(element, source) {
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        fontFamily: "system-ui",
        primaryColor: "#f3f5f2",
        primaryTextColor: "#26332f",
        primaryBorderColor: "#a0b1a5",
        lineColor: "#7a8b80",
        tertiaryColor: "#fbf6eb",
      },
      flowchart: { useMaxWidth: true, htmlLabels: false },
    });
    const { svg } = await mermaid.render(
      "diagram" + Math.random().toString(36).slice(2),
      source,
    );
    if (element.isConnected) {
      element.innerHTML = svg;
      if (element.classList.contains("embedded-diagram")) {
        const diagram = element.querySelector("svg");
        const width = diagram?.viewBox.baseVal.width;
        // Preserve label size on narrow screens; the wrapper provides scrolling.
        if (width) diagram.style.minWidth = `${width}px`;
        element.tabIndex = 0;
        element.setAttribute("role", "region");
        element.setAttribute("aria-label", "流程图，可左右滚动");
      }
    }
  } catch {
    if (element.isConnected)
      element.innerHTML = `<pre>${esc(source)}</pre><small>图形渲染失败，保留可读源图。</small>`;
  }
}
function jsonView(value) {
  if (Array.isArray(value)) {
    if (!value.length) return '<p class="empty">空数组</p>';
    const keys = [
      ...new Set(
        value.flatMap((r) =>
          typeof r === "object" && r !== null ? Object.keys(r) : [],
        ),
      ),
    ];
    if (keys.length && keys.length <= 16)
      return `<div class="table-scroll"><table><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${value.map((row) => `<tr>${keys.map((k) => `<td>${typeof row?.[k] === "object" && row[k] !== null ? `<details><summary>展开</summary><pre>${esc(JSON.stringify(row[k], null, 2))}</pre></details>` : esc(row?.[k] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.entries(value)
      .map(
        ([k, v]) =>
          `<details class="json-field" open><summary>${esc(k)}</summary>${typeof v === "object" && v !== null ? jsonView(v) : `<p>${esc(v)}</p>`}</details>`,
      )
      .join("");
  return `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
}
async function showArtifact(f) {
  const token = ++request;
  const target = document.querySelector("#reader-content");
  if (!target) return;
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(f.ext)) {
    target.innerHTML = `<div class="image-view"><img src="${apiPath("asset/" + f.id)}" data-zoom="${f.id}" alt="${esc(f.name)}"><p>点击图片放大</p></div>`;
    bind(target);
    return;
  }
  if (["mp4", "mp3", "wav"].includes(f.ext)) {
    const tag = f.ext === "mp4" ? "video" : "audio";
    target.innerHTML = `<${tag} controls preload="metadata" src="${apiPath("asset/" + f.id)}"></${tag}><p class="notice">这是当前文件的实际播放。存在媒体文件不代表样片或成片已经审核通过。</p>`;
    if (pendingSeek !== null) {
      const media = target.querySelector(tag),
        time = pendingSeek;
      pendingSeek = null;
      media.addEventListener(
        "loadedmetadata",
        () => {
          media.currentTime = Math.min(time, Math.max(0, media.duration - 0.1));
        },
        { once: true },
      );
    }
    pendingLocation = null;
    offerReadingPosition(f);
    return;
  }
  try {
    const res = await fetch(apiPath("artifact/") + f.id);
    if (!res.ok) throw Error("读取失败");
    const result = await res.json();
    if (token !== request || !target.isConnected) return;
    const documentTitle = document.querySelector("#document-title");
    if (documentTitle && result.headings?.length)
      documentTitle.textContent = result.headings[0].title;
    const review =
      tab === "document" ? null : topic.reviews.find((r) => r.id === f.id);
    if (review) target.innerHTML = reviewCards([review]);
    else if (result.kind === "markdown")
      target.innerHTML = `<details class="document-meta"><summary>版本与来源</summary>${esc(f.displayPath)}<br>当前文件更新于 ${fmtDate(result.mtime)}</details><details class="toc"><summary>目录 · ${result.headings.length} 节</summary>${result.headings.map((h) => `<a href="#${h.id}" style="padding-left:${Math.min(h.level - 1, 3) * 12}px" data-heading="${h.id}">${esc(h.title)}</a>`).join("")}</details><article class="prose">${result.html}</article>`;
    else if (result.kind === "json" && result.data?.kind === "runtime-story") {
      const { mountRuntimeStory } = await import("./runtime-story.mjs");
      if (token !== request || !target.isConnected) return;
      mountRuntimeStory(target, result.data);
    } else if (result.kind === "json")
      target.innerHTML = `<div class="document-meta">结构化原始数据 · ${esc(f.displayPath)}</div>${jsonView(result.data)}`;
    else
      target.innerHTML = `<pre class="raw-text">${esc(result.text || result.message)}</pre>`;
    const previews =
      tab === "document"
        ? []
        : currentRevision()?.previewIds?.[f.coreStep] || [];
    if (previews.length)
      target.insertAdjacentHTML(
        "afterbegin",
        `<section class="cover-previews"><h2>实际封面预览</h2>${previews.map((id) => `<img src="${apiPath("asset/" + id)}" data-zoom="${id}" alt="当前所选历史版本的封面">`).join("")}</section>`,
      );
    bind(target);
    offerReadingPosition(f);
    if (pendingHeading) {
      const wanted = pendingHeading;
      ((pendingHeading = null), (assetContext = null));
      const heading = [...target.querySelectorAll("h1,h2,h3,h4")].find(
        (node) =>
          node.textContent.trim() === wanted ||
          node.textContent.includes(wanted),
      );
      if (heading) {
        heading.classList.add("highlight");
        requestAnimationFrame(() => heading.scrollIntoView({ block: "start" }));
      }
    }
    if (pendingLocation) {
      const loc = pendingLocation;
      ((pendingLocation = null), (pendingSeek = null));
      const note = document.createElement("p");
      note.className = "location-note";
      note.textContent = "审核位置：" + loc;
      target.prepend(note);
      const section = loc.match(/\b([A-Z]\d+(?:\.\d+)?)\b/);
      const heading =
        section &&
        [...target.querySelectorAll("h1,h2,h3,h4")].find((h) =>
          h.textContent.includes(section[1]),
        );
      if (heading) {
        heading.classList.add("highlight");
        heading.scrollIntoView({ block: "center" });
      } else note.append(" · 已定位文件；原记录未提供可匹配的精确锚点。");
    }
    target.querySelectorAll("code.language-mermaid").forEach((code) => {
      const div = document.createElement("div");
      div.className = "embedded-diagram";
      const source = code.textContent;
      code.parentElement.replaceWith(div);
      drawDiagram(div, source);
    });
  } catch (e) {
    if (token === request)
      target.innerHTML = `<p class="empty">暂时无法读取：${esc(e.message)}。文件可能正在更新，请刷新。</p>`;
  }
}
function offerReadingPosition(file) {
  let saved;
  try {
    saved = JSON.parse(
      localStorage.getItem("workbench-position:" + file.id) || "null",
    );
  } catch {}
  if (!saved || saved.y < 180 || saved.mtime !== file.mtime) return;
  const bar = document.querySelector(".reader-bar");
  if (!bar || bar.querySelector("[data-resume-reading]")) return;
  const button = document.createElement("button");
  button.className = "text-button";
  button.dataset.resumeReading = "true";
  button.textContent = "回到本机停留位置";
  button.title = "仅为此浏览器的滚动位置，不是阅读或接受记录";
  button.onclick = () => {
    window.scrollTo({ top: saved.y, behavior: "smooth" });
    button.remove();
  };
  bar.append(button);
}
let readingTimer;
window.addEventListener(
  "scroll",
  () => {
    clearTimeout(readingTimer);
    if (!selectedArtifact || !document.querySelector("#reader-content")) return;
    const file = asset(selectedArtifact);
    readingTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          "workbench-position:" + file.id,
          JSON.stringify({ y: window.scrollY, mtime: file.mtime }),
        );
      } catch {}
    }, 250);
  },
  { passive: true },
);
function navigateArtifact(id, options = {}) {
  id = data.aliases?.[id] || id;
  let f = data.docs.find((a) => a.id === id);
  if (!f)
    for (const t of data.topics) {
      f = t.artifacts.find((a) => a.id === id);
      if (f) {
        topic = t;
        break;
      }
    }
  if (!f) return;
  if (f.area === "docs" && !isCollaborationAsset(f)) {
    const owner = data.topics.find((t) =>
      (t.collaboration?.artifactUris || []).includes(f.displayPath),
    );
    if (owner) topic = owner;
  }
  const contextRevision = topic.revisions?.find(
    (r) => r.id === options.contextRevisionId,
  );
  const contextInput = contextRevision?.inputRefs?.find(
    (ref) => ref.assetId === id,
  );
  const positioning =
    options.stepId === "positioning" && positioningEntry().file?.id === id;
  const keepContext = !!contextRevision && (contextInput || positioning);
  assetContext = keepContext
    ? {
        assetId: id,
        revisionId: contextRevision.id,
        stepId: positioning
          ? "positioning"
          : options.stepId || contextInput.step || "evidence",
      }
    : null;
  selectedArtifact = id;
  document.body.dataset.mobile = "artifact";
  if (f.area === "docs" && !keepContext) {
    pendingLocation = null;
    pendingSeek = null;
    tab = "document";
    layout();
    render();
    history.replaceState(null, "", workspaceURL(id));
    return;
  }
  const rev = keepContext
    ? contextRevision
    : topic.revisions?.find((r) => r.id === f.revisionId);
  if (rev) {
    revisionChoice[topic.id + ":" + rev.kind] = rev.id;
    phase = rev.kind === "video" ? "video" : "research";
  } else phase = f.area === "feedback" ? "publish" : "research";
  selectedStage =
    f.coreStep ||
    (steps.some((s) => s.id === f.stage)
      ? f.stage
      : phase === "video"
        ? "architecture"
        : phase === "publish"
          ? "comments"
          : "report");
  if (keepContext) {
    selectedStage = assetContext.stepId;
    phase = phaseFor(selectedStage);
    if (positioning) pendingHeading = positioningEntry().heading || null;
  }
  if (
    groupFor(selectedStage) === "publish" ||
    groupFor(selectedStage) === "learning"
  )
    phase = "publish";
  tab = "artifacts";
  layout();
  render();
  history.replaceState(null, "", workspaceURL(id));
}
function bind(container) {
  container.querySelectorAll("[data-phase]").forEach(
    (b) =>
      (b.onclick = () => {
        phase = b.dataset.phase;
        selectedStage =
          phase === "research"
            ? "report"
            : phase === "video"
              ? "positioning"
              : "publish";
        if (selectedStage === "positioning" && openPositioning()) return;
        selectedArtifact = null;
        tab = "artifacts";
        history.replaceState(null, "", workspaceURL());
        layout();
        render();
      }),
  );
  container.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.view;
        selectedArtifact = null;
        history.replaceState(null, "", workspaceURL());
        layout();
        render();
      }),
  );
  container.querySelectorAll("[data-mobile]").forEach(
    (b) =>
      (b.onclick = () => {
        selectMobilePanel(b.dataset.mobile);
      }),
  );
  container.querySelectorAll("[data-history-video]").forEach(
    (b) =>
      (b.onclick = () => {
        revisionChoice[topic.id + ":video"] = "video-v2";
        selectedArtifact = null;
        render();
      }),
  );

  container.querySelectorAll("[data-stage]").forEach(
    (b) =>
      (b.onclick = () => {
        selectedStage = b.dataset.stage;
        if (selectedStage === "positioning" && openPositioning()) return;
        phase = phaseFor(selectedStage);
        document.body.dataset.mobile = "artifact";
        history.replaceState(null, "", workspaceURL());
        selectedArtifact = null;
        tab = "artifacts";
        if (selectedStage === "publish") {
          const receiptId = topic.revisions.find(
            (r) => r.id === topic.currentVideo,
          )?.coreIds?.publish;
          if (receiptId) {
            navigateArtifact(receiptId);
            return;
          }
        }
        layout();
        render();
      }),
  );
  container.querySelectorAll("[data-artifact]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        navigateArtifact(b.dataset.artifact, {
          contextRevisionId: b.dataset.inputRevision,
          stepId: b.dataset.inputStep,
        });
      }),
  );
  container.querySelectorAll("[data-unavailable]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        b.textContent += "（未纳入读取范围）";
      }),
  );
  container.querySelectorAll("[data-heading]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(b.dataset.heading)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
  );
  container.querySelectorAll("[data-latest-decisions]").forEach((button) => {
    button.onclick = () => {
      document
        .querySelector(".artifact-layout")
        ?.classList.remove("hide-review");
      selectMobilePanel("review");
      document.querySelector('.review-panel [data-tab="decisions"]')?.click();
    };
  });
  container.querySelectorAll("[data-zoom]").forEach(
    (b) =>
      (b.onclick = () => {
        openImage(
          apiPath("asset/") + b.dataset.zoom,
          b.alt || namedAsset(asset(b.dataset.zoom)),
        );
      }),
  );
  container.querySelectorAll("[data-location]").forEach(
    (b) =>
      (b.onclick = () => {
        const rv = topic.reviews.find((r) => r.id === b.dataset.review),
          loc = b.dataset.location;
        const timestamp = String(loc).match(/(?:^|[^\d])(\d{1,2}):(\d{2})/);
        const mediaInput =
          timestamp &&
          rv?.inputs.find((i) => i.artifactId && /\.mp4$/.test(i.path));
        if (mediaInput) {
          pendingSeek = Number(timestamp[1]) * 60 + Number(timestamp[2]);
          navigateArtifact(mediaInput.artifactId);
          return;
        }
        const input = rv?.inputs.find(
          (i) => i.artifactId && loc.includes(i.path.split("/").pop()),
        );
        const fallback = rv?.inputs.find(
          (i) =>
            i.artifactId && /report\.md$|SCRIPT\.md$|opening\.md$/.test(i.path),
        );
        if (input || fallback) {
          pendingLocation = loc;
          navigateArtifact((input || fallback).artifactId);
        } else {
          navigateArtifact(rv.id);
        }
      }),
  );
}
function renderAccount(node) {
  return mountAccount(node, {
    workspaces,
    onTopic: (id) => {
      topic = data.topics.find((t) => t.id === id);
      if (!topic) return;
      tab = "overview";
      selectedArtifact = null;
      phase = "video";
      history.replaceState(null, "", workspaceURL());
      layout();
      render();
    },
    onAsset: navigateArtifact,
    onReload: () => load(false),
  });
}
function openAccount() {
  tab = "account";
  selectedArtifact = null;
  const url = new URL(location.href);
  url.searchParams.set("workspace", currentWorkspaceId());
  url.searchParams.set("view", "account");
  url.searchParams.delete("case");
  url.hash = "";
  history.replaceState(null, "", url.pathname + url.search);
  if (topic) {
    layout();
    render();
  } else emptyAccount();
}
function emptyAccount() {
  document.body.classList.add("account-empty-shell");
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">t.</span>内容工作台</div>${workspaceSelector(workspaces, currentWorkspaceId())}<p class="meta">定位和内容按创作者身份保留。</p></aside><div class="shell"><header class="topbar"><span>账号与内容</span><button id="account-refresh" class="button">刷新 ↻</button></header><main id="workspace"><div id="content"></div></main></div>`;
  bindWorkspaceSelector(app, openAccount);
  document.querySelector("#account-refresh").onclick = () => load(false);
  renderAccount(document.querySelector("#content"));
}
let loadGeneration = 0;
async function load(restoreHash = true) {
  const generation = ++loadGeneration;
  try {
    const selectorResponse = await fetch("/api/workspaces");
    if (!selectorResponse.ok) throw Error("无法读取工作区清单");
    const nextWorkspaces = (await selectorResponse.json()).workspaces;
    if (generation !== loadGeneration) return;
    workspaces = nextWorkspaces;
    const normalized = new URL(location.href);
    if (!normalized.searchParams.has("workspace")) {
      const requestedCase = normalized.searchParams.get("case") || "";
      normalized.searchParams.set(
        "workspace",
        requestedCase.startsWith("minimax")
          ? "history-unassigned"
          : workspaces[0]?.id || "creation",
      );
      if (!normalized.searchParams.has("case") && !normalized.hash)
        normalized.searchParams.set("view", "account");
      history.replaceState(
        null,
        "",
        normalized.pathname + normalized.search + normalized.hash,
      );
    }
    const linkedTopic = normalized.searchParams.get("case");
    const topicOwner =
      linkedTopic &&
      workspaces.find((w) =>
        w.topicIds?.some(
          (id) => id === linkedTopic || id.startsWith(linkedTopic),
        ),
      );
    if (
      topicOwner &&
      normalized.searchParams.get("workspace") === "history-unassigned"
    ) {
      normalized.searchParams.set("workspace", topicOwner.id);
      history.replaceState(
        null,
        "",
        normalized.pathname + normalized.search + normalized.hash,
      );
    }
    const requestedWorkspace = normalized.searchParams.get("workspace");
    const canonicalWorkspace = workspaces.find(
      (w) =>
        w.id === requestedWorkspace || w.aliases?.includes(requestedWorkspace),
    );
    if (canonicalWorkspace && canonicalWorkspace.id !== requestedWorkspace) {
      normalized.searchParams.set("workspace", canonicalWorkspace.id);
      history.replaceState(
        null,
        "",
        normalized.pathname + normalized.search + normalized.hash,
      );
    }
    if (normalized.searchParams.get("view") === "account") tab = "account";
    const res = await fetch(apiPath("catalog"));
    if (!res.ok) throw Error("无法读取产物目录");
    const nextData = await res.json();
    await loadPublicationReceipts(nextData);
    if (generation !== loadGeneration) return;
    data = nextData;
    const requestedCase = new URLSearchParams(location.search).get("case");
    topic =
      data.topics.find((t) => t.id === topic?.id) ||
      data.topics.find(
        (t) =>
          requestedCase &&
          (t.id === requestedCase || t.id.startsWith(requestedCase)),
      ) ||
      data.topics[0];
    if (!topic) {
      emptyAccount();
      return;
    }
    layout();
    render();
    const id = new URLSearchParams(location.hash.slice(1)).get("artifact");
    if (id && restoreHash) restoreArtifactLocation();
  } catch (e) {
    if (generation !== loadGeneration) return;
    data = null;
    topic = null;
    selectedArtifact = null;
    app.innerHTML = `<main><h1>工作台暂时无法读取</h1><p>${esc(e.message)}</p><button id="reload">重新加载</button></main>`;
    document.querySelector("#reload").onclick = () => location.reload();
  }
}
function restoreArtifactLocation() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const id = hash.get("artifact");
  if (id && data)
    navigateArtifact(id, {
      contextRevisionId: hash.get("context"),
      stepId: hash.get("step"),
    });
}
load();
window.addEventListener("hashchange", restoreArtifactLocation);

window.matchMedia("(max-width: 800px)").addEventListener("change", (event) => {
  const context = document.querySelector(".context-details");
  if (context) context.open = !event.matches;
});
