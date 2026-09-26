import { mountPositioningEditor } from "./shared-context-ui.mjs";
import { apiPath, currentWorkspaceId } from "./workspace-api.mjs";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const states = {
  confirmed: "已确认",
  proposed: "建议 · 待确认",
  unknown: "尚未确认",
  inbox: "待判断",
  consider: "值得考虑",
  research: "建议研究",
  hold: "暂存",
  discard: "不做",
  published: "历史记录已发布",
  submitted: "已提交",
  reviewing: "审核中",
  scheduled: "已预约",
  draft: "草稿",
  failed: "失败",
  "submission-unconfirmed": "提交未确认",
  historical: "历史资料",
};
const external = (url) => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};
const sources = (rows) =>
  (rows || []).length
    ? `<details class="account-sources"><summary>来源与记录</summary>${rows.map((s) => `<p>${esc(s.label)}${s.path ? `<small>${esc(s.path)}</small>` : ""}${external(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">查看网页 ↗</a>` : ""}</p>`).join("")}</details>`
    : '<small class="meta">尚未提供依据</small>';
export function workspaceSelector(workspaces, id) {
  return `<section class="account-select"><label for="workspace-select">创作者身份</label><select id="workspace-select">${workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select><button class="overview-link" data-account-home>账号与内容 <span>↗</span></button></section>`;
}
export function bindWorkspaceSelector(node, onHome) {
  const select = node.querySelector("#workspace-select");
  if (select)
    select.onchange = () => {
      // A new document drops in-flight reader state, account-specific draft bindings and media.
      const url = new URL(location.href);
      url.search = new URLSearchParams({
        workspace: select.value,
        view: "account",
      }).toString();
      url.hash = "";
      location.assign(url);
    };
  node.querySelector("[data-account-home]")?.addEventListener("click", onHome);
}
async function get(route, id) {
  const response = await fetch(apiPath(route, id));
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "读取失败");
  return data;
}
async function post(route, payload, id) {
  const response = await fetch(apiPath(route, id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "保存失败");
  return data;
}
export async function mountAccount(
  node,
  { workspaces, onTopic, onAsset, onReload },
) {
  const id = currentWorkspaceId();
  node.innerHTML = '<p role="status">正在读取本工作区…</p>';
  let data;
  try {
    data = await get("inventory", id);
  } catch (error) {
    if (node.isConnected)
      node.innerHTML = `<p class="notice">${esc(error.message)}</p>`;
    return;
  }
  if (!node.isConnected) return;
  const w = data.workspace;
  let recentImport;
  try {
    const saved = JSON.parse(
      sessionStorage.getItem("workbench-import-success:" + id) || "null",
    );
    recentImport = data.imports.find((r) => r.id === saved?.id);
  } catch {}
  const success = recentImport
    ? `<div class="notice import-success" role="status"><b>已导入 ${esc(recentImport.title)} · ${recentImport.assets.length} 份资产</b><p>已在本区保留冻结副本。原账号的接受和发布记录没有继承。</p><button class="text-button" data-account-asset="${recentImport.assets[0].id}">打开本次导入的主资产 →</button><button class="text-button" data-dismiss-import>收起</button></div>`
    : "";

  const topicCards = data.topics
    .map(
      (t) =>
        `<button class="account-topic" data-account-topic="${esc(t.id)}"><span class="eyebrow">${t.id === "deepseek-v4-flash" ? "本期内容 · 已形成完整片" : "内容档案"}</span><b>${esc(t.title)}</b><p>${esc(t.direction || "沿完整阶段查看资产、意见与版本")}</p><small>查看研究、表达、交付与反馈 →</small></button>`,
    )
    .join("");
  node.innerHTML = `<div class="page-heading"><div><div class="eyebrow">${w.kind === "unassigned" ? "保留历史，归属待确认" : "一个创作者身份，一份持续上下文"}</div><h1>${esc(w.name)}</h1><p>${w.kind === "unassigned" ? "原选题、资产与意见保留在这里。复用到账号时，明确选择版本并导入。" : `研究与制作在这里汇合，小红书、抖音和视频号分别交付。`}</p>${w.channels?.length ? `<div class="identity-channels" aria-label="发布渠道">${w.channels.map((c) => `<span>${esc({ xiaohongshu: "小红书", douyin: "抖音", channels: "视频号" }[c.platform] || c.platform || c.name)}<small>${esc(c.accountId || c.account?.accountId || "身份待核")}</small></span>`).join("")}</div>` : ""}</div></div>
  ${success}<section class="account-profiles" aria-label="账号与读者">${Object.entries(
    {
      purpose: "长期目的",
      readers: "目标读者",
      promise: "持续内容承诺",
    },
  )
    .map(([key, label]) => {
      const p = w.positioning[key];
      return `<article class="panel"><span class="eyebrow">${label}</span><span class="account-status ${p.status}">${states[p.status]}</span><p>${esc(p.value || "尚未确认；导入其他账号的作品不会代替这里的定位。")}</p>${sources(p.sources)}</article>`;
    })
    .join("")}</section>
  <div id="positioning-editor"></div><nav class="account-jump" aria-label="工作区内容"><a href="#account-topics">选题与资产 ${data.topics.length}</a><a href="#account-inventory">历史发布库存 ${data.records.length}</a><a href="#account-candidates">选题收件箱 ${data.candidates.length}</a><a href="#account-import">显式导入</a></nav>
  <section id="account-topics" class="account-section"><div class="section-heading"><h2>内容与持续进展</h2></div><div class="account-topic-grid">${topicCards || '<div class="empty">这里还没有已登记的制作内容。账号定位与历史资料保留在本工作区，新一期待讨论后启动。</div>'}</div>${data.imports.length ? `<details class="panel"><summary>导入来源与冻结版本 · ${data.imports.length}</summary>${data.imports.map((r) => `<article class="account-import-record"><b>${esc(r.title)}</b><p>来自 ${esc(workspaces.find((w) => w.id === r.sourceWorkspaceId)?.name || r.sourceWorkspaceId)} · ${esc(r.sourceRevisionId || "原版本未标明")}</p><p class="meta">副本只读；改写需另建本区版本。原审核与发布没有继承。</p>${r.assets.map((a) => `<button class="text-button" data-account-asset="${a.id}">${esc(a.name)} ↗</button>`).join(" · ")}<details><summary>版本指纹</summary><code>${esc(r.sourceHash)}</code></details></article>`).join("")}</details>` : ""}</section>
  <details id="account-inventory" class="account-section"><summary>已有内容与发布记录 · ${data.records.length}</summary><p class="meta">以下是历史记录，不是当前实时核验；也不代表当前新版已发布。</p><div class="account-inventory">${data.records.map((r) => `<article class="panel"><div class="eyebrow">${esc(states[r.status] || r.status)}</div><h3>${esc(r.title)}</h3><p>${esc(r.note || "")}</p><small>记录于 ${esc(r.observedAt || r.publishedAt || "时间未记录")} ${r.sourceAccountId ? "· 原账号 " + esc(r.sourceAccountId) : ""}</small><p class="meta">${esc(r.sourceVersion || "版本未记明")}${r.observedStatus ? " · 原状态：" + esc(r.observedStatus) : ""}${r.scheduledAt ? " · 预约：" + esc(r.scheduledAt) : ""}</p>${external(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">查看平台记录 ↗</a>` : ""}${r.sourceHash ? `<details><summary>仅绑定此旧版本</summary><code>${esc(r.sourceHash)}</code></details>` : ""}${sources(r.evidence)}</article>`).join("") || '<p class="empty">尚无有来源的发布库存记录。</p>'}</div></details>
  <details id="account-candidates" class="account-section"><summary>选题收件箱 · ${data.candidates.length}</summary><p>先判断对本账号的读者有什么价值，再决定是否研究、适合什么载体。当前手工登记，尚未连接 RSS 或自动生产。</p><div class="account-candidate-list">${data.candidates.map((c) => `<article class="panel"><span class="account-status">${esc(states[c.status])}</span><h3>${esc(c.title)}</h3><p>${esc(c.summary)}</p><p>${esc(c.reason || "尚未判断")}</p>${c.recommendedCarrier ? `<p>载体建议：${esc(c.recommendedCarrier)}（未确认）</p>` : ""}<small>${esc(c.source)} · ${esc(c.updatedAt)}</small>${external(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">来源 ↗</a>` : ""}<button class="text-button" data-edit-candidate="${c.id}">更新判断</button><details><summary>判断记录 ${c.judgments.length}</summary>${c.judgments.map((j) => `<p>${esc(states[j.status])} · ${esc(j.reason || "登记候选")}<small>${esc(j.at)}</small></p>`).join("")}</details></article>`).join("")}</div>
  <form id="candidate-form" class="account-form panel"><h3 id="candidate-form-title">登记一个候选</h3><label>标题<input name="title" required maxlength="180"></label><label>来源名称<input name="source" maxlength="500" placeholder="例如：某研究机构 RSS（手工摘录）"></label><label>来源链接<input name="url" type="url" maxlength="2000"></label><label>摘要<textarea name="summary" maxlength="4000"></textarea></label><div class="account-form-row"><label>判断<select name="status">${["inbox", "consider", "research", "hold", "discard"].map((s) => `<option value="${s}">${states[s]}</option>`).join("")}</select></label><label>可能适合的载体<input name="recommendedCarrier" maxlength="500" placeholder="建议，不是已确认的制作任务"></label></div><label>判断理由<textarea name="reason" maxlength="2000" placeholder="它解决谁的什么问题？依据够不够？"></textarea></label><div><button class="primary-button" type="submit">保存候选与判断</button> <button class="text-button" type="reset">新建另一条</button></div><p class="account-form-result" role="status"></p></form></details>
  <details id="account-import" class="account-section"><summary>跨身份复用 · 明确导入</summary><p>选择一份具体版本，以及需要一起保留的图或附件。会保存本区冻结副本；原账号定位、接受和发布记录不会随之继承。</p><form id="import-form" class="account-form panel"><label>来源工作区<select name="sourceWorkspaceId"><option value="">请选择来源</option>${workspaces
    .filter((w) => w.id !== id)
    .map((w) => `<option value="${w.id}">${esc(w.name)}</option>`)
    .join(
      "",
    )}</select></label><label>查找资料<input name="sourceSearch" placeholder="优先当前关键资产；输入关键词查找"></label><label class="companion-option"><input type="checkbox" name="showAll">查看全部历史资料与过程文件</label><label>来源资产<select name="sourceAssetId" required disabled><option value="">先选择来源工作区</option></select></label><p id="import-version" class="meta"></p><details><summary>选择同时导入的图片或附件</summary><div id="import-companions"></div></details><label>目标选题<select name="targetTopicId"><option value="">在本区新建选题</option>${data.topics.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}</select></label><label>新选题名称<input name="targetTitle" maxlength="180" placeholder="本账号准备表达的选题"></label><button class="primary-button" type="submit">导入选定版本</button><p class="account-form-result" role="status"></p></form></details>`;
  mountPositioningEditor(node.querySelector("#positioning-editor"), onReload);
  node
    .querySelectorAll("[data-account-topic]")
    .forEach((b) => (b.onclick = () => onTopic(b.dataset.accountTopic)));
  node
    .querySelectorAll("[data-account-asset]")
    .forEach((b) => (b.onclick = () => onAsset(b.dataset.accountAsset)));
  node.querySelector("[data-dismiss-import]")?.addEventListener("click", () => {
    sessionStorage.removeItem("workbench-import-success:" + id);
    node.querySelector(".import-success")?.remove();
  });
  const operationIds = new Map();
  const operationPayload = (kind, payload) => {
    const signature = JSON.stringify(payload),
      last = operationIds.get(kind);
    if (!last || last.signature !== signature)
      operationIds.set(kind, { signature, id: crypto.randomUUID() });
    return { ...payload, clientOperationId: operationIds.get(kind).id };
  };
  const form = node.querySelector("#candidate-form");
  let editing = null;
  node.querySelectorAll("[data-edit-candidate]").forEach(
    (b) =>
      (b.onclick = () => {
        const c = data.candidates.find((c) => c.id === b.dataset.editCandidate);
        editing = c.id;
        for (const k of [
          "title",
          "source",
          "url",
          "summary",
          "status",
          "reason",
          "recommendedCarrier",
        ])
          form.elements[k].value = c[k] || "";
        form.querySelector("h3").textContent = "更新候选的判断";
        form.closest("details").open = true;
        form.scrollIntoView({ block: "start", behavior: "smooth" });
      }),
  );
  form.onreset = () => {
    editing = null;
    form.querySelector("h3").textContent = "登记一个候选";
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await post(
        "candidates",
        operationPayload("candidate", {
          ...Object.fromEntries(new FormData(form)),
          ...(editing ? { candidateId: editing } : {}),
        }),
        id,
      );
      await mountAccount(node, { workspaces, onTopic, onAsset, onReload });
      node
        .querySelector("#account-candidates")
        ?.scrollIntoView({ block: "start" });
    } catch (error) {
      form.querySelector('[role="status"]').textContent = error.message;
      button.disabled = false;
    }
  };
  const importer = node.querySelector("#import-form");
  let sourceFiles = [],
    generation = 0,
    selectedVersion = null;
  const populateSources = () => {
    selectedVersion = null;
    const query = importer.elements.sourceSearch.value.toLocaleLowerCase();
    const showAll = importer.elements.showAll.checked;
    const list = sourceFiles.filter(
      (a) =>
        (showAll || a.keyAsset) &&
        (!query ||
          (a.label + " " + a.name + " " + a.topicTitle + " " + a.revisionId)
            .toLocaleLowerCase()
            .includes(query)),
    );
    importer.elements.sourceAssetId.innerHTML =
      '<option value="">选择实际文件与版本</option>' +
      list
        .map(
          (a) =>
            `<option value="${a.id}">${esc(a.topicTitle || "历史文档")} · ${esc(a.label || a.name)} · ${esc(a.revisionLabel || a.revisionId || "")}</option>`,
        )
        .join("");
    node.querySelector("#import-version").textContent =
      `${showAll ? "全部资料" : "当前关键资产"} · ${list.length} 份可选；历史过程文件可切换查看。`;
    node.querySelector("#import-companions").innerHTML = "";
  };
  importer.elements.showAll.onchange = populateSources;
  importer.elements.sourceSearch.oninput = populateSources;
  importer.elements.sourceWorkspaceId.onchange = async () => {
    const turn = ++generation;
    const sourceId = importer.elements.sourceWorkspaceId.value;
    sourceFiles = [];
    importer.elements.sourceAssetId.disabled = true;
    node.querySelector("#import-companions").innerHTML = "";
    if (!sourceId) return;
    try {
      const c = await get("catalog", sourceId);
      if (turn !== generation || !node.isConnected) return;
      sourceFiles = [
        ...c.topics.flatMap((t) =>
          t.artifacts.map((a) => {
            const r = t.revisions.find((r) => r.id === a.revisionId);
            const current = [t.currentReport, t.currentVideo].includes(
              a.revisionId,
            );
            const labels = {
              brief: "选题简报",
              outline: "报告大纲",
              questions: "关键问题",
              evidence: "研究依据",
              opening: "开头表达",
              script: "完整口播稿",
              report: "完整报告",
              architecture: "视频表达设计",
              sample: "有声样片",
              final: "完整视频",
              package: "标题与封面",
            };
            return {
              ...a,
              topicTitle: t.title,
              revisionLabel: r?.label,
              label:
                r?.assetLabels?.[a.logicalUri || a.displayPath] ||
                (a.coreStep ? labels[a.coreStep] : null) ||
                (/cover|封面/.test(a.name) ? "封面 · " + a.name : a.name),
              keyAsset:
                current &&
                (!!a.coreStep ||
                  /cover.*\.(png|jpg|svg)$/.test(a.name) ||
                  Object.values(r?.previewIds || {})
                    .flat()
                    .includes(a.id)),
            };
          }),
        ),
        ...c.docs,
      ];
      populateSources();
      importer.elements.sourceAssetId.disabled = false;
    } catch (error) {
      importer.querySelector('[role="status"]').textContent = error.message;
    }
  };
  importer.elements.sourceAssetId.onchange = async () => {
    selectedVersion = null;
    const selectedId = importer.elements.sourceAssetId.value;
    const sourceWorkspaceId = importer.elements.sourceWorkspaceId.value;
    const fingerprintGeneration = generation;
    const a = sourceFiles.find(
      (a) => a.id === importer.elements.sourceAssetId.value,
    );
    node.querySelector("#import-version").textContent = a
      ? `${a.name} · ${a.revisionId || "原版本未标明"} · 点击导入时核对当前文件并冻结`
      : "";
    node.querySelector("#import-companions").innerHTML = sourceFiles
      .filter(
        (b) =>
          a &&
          b.id !== a.id &&
          b.topicId === a.topicId &&
          b.revisionId === a.revisionId,
      )
      .map(
        (b) =>
          `<label class="companion-option"><input type="checkbox" value="${b.id}">${esc(b.name)}</label>`,
      )
      .join("");
    if (a) {
      try {
        const version = await get(
          "fingerprint/" + a.id,
          importer.elements.sourceWorkspaceId.value,
        );
        if (
          node.isConnected &&
          generation === fingerprintGeneration &&
          importer.elements.sourceWorkspaceId.value === sourceWorkspaceId &&
          importer.elements.sourceAssetId.value === selectedId
        ) {
          selectedVersion = { ...version, workspaceId: sourceWorkspaceId };
          node.querySelector("#import-version").textContent =
            `${a.label || a.name} · ${a.revisionLabel || a.revisionId || "未标明版本"} · 此版本已核对，导入时再次验证`;
        }
      } catch (error) {
        importer.querySelector('[role="status"]').textContent = error.message;
      }
    }
  };
  importer.onsubmit = async (e) => {
    e.preventDefault();
    const b = importer.querySelector('[type="submit"]');
    b.disabled = true;
    const result = importer.querySelector('[role="status"]');
    result.textContent = "正在核对并复制选定版本…";
    try {
      const sourceId = importer.elements.sourceWorkspaceId.value,
        assetId = importer.elements.sourceAssetId.value;
      const selected = [
        assetId,
        ...[...node.querySelectorAll("#import-companions input:checked")].map(
          (x) => x.value,
        ),
      ];
      if (
        !assetId ||
        !selectedVersion ||
        selectedVersion.workspaceId !== sourceId
      )
        throw Error("请先选择来源资产并等待版本核对");
      const versions = [
        selectedVersion,
        ...(await Promise.all(
          selected.slice(1).map(async (assetId) => ({
            assetId,
            ...(await get("fingerprint/" + assetId, sourceId)),
          })),
        )),
      ];
      const payload = {
        sourceWorkspaceId: sourceId,
        sourceAssetId: assetId,
        sourceHash: versions[0].hash,
        companions: versions
          .slice(1)
          .map((v) => ({ assetId: v.assetId, hash: v.hash })),
        targetTitle:
          importer.elements.targetTitle.value ||
          sourceFiles.find((a) => a.id === assetId).name,
      };
      if (importer.elements.targetTopicId.value)
        payload.targetTopicId = importer.elements.targetTopicId.value;
      const saved = await post(
        "imports",
        operationPayload("import", payload),
        id,
      );
      try {
        sessionStorage.setItem(
          "workbench-import-success:" + id,
          JSON.stringify({ id: saved.import.id }),
        );
      } catch {}
      await onReload();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      result.textContent = error.message;
      b.disabled = false;
    }
  };
}
