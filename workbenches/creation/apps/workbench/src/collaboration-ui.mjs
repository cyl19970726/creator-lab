import { apiPath, currentWorkspaceId } from "./workspace-api.mjs";
import { openVersionReader, relatedTextVersions } from "./version-reader.mjs";
import { sourceQuote, visibleQuote } from "./review-location.mjs";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const drafts = new Map();
let selectionController;
const roles = {
  user: "用户本人",
  proxy: "代理审阅",
  agent: "制作 Agent",
  technical: "技术检查",
};
const states = {
  open: "待处理",
  addressed: "已修改 · 待复验",
  resolved: "处理完成",
};
const date = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "时间未记录";
function draftFor(key) {
  if (!drafts.has(key)) {
    let saved = {};
    try {
      saved = JSON.parse(
        sessionStorage.getItem("workbench-draft:" + key) || "{}",
      );
    } catch {}
    drafts.set(key, {
      actor: "proxy",
      dimension: "未分类",
      text: "",
      scope: "whole",
      range: "整份资产",
      quote: "",
      action: "feedback",
      advance: false,
      seconds: null,
      ...saved,
    });
  }
  return drafts.get(key);
}
export function mountCollaboration(
  node,
  {
    topicId,
    file,
    stepId,
    title,
    onNavigate,
    onBind = () => {},
    onRefresh = () => {},
    onDrawDiagram,
    legacyHTML = "",
  },
) {
  if (!node || !file) return;
  selectionController?.abort();
  selectionController = new AbortController();
  let selectedQuote = "";
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = window.getSelection();
      const reader = document.querySelector("#reader-content");
      if (
        selection?.toString().trim() &&
        reader?.contains(selection.anchorNode) &&
        reader?.contains(selection.focusNode)
      )
        selectedQuote = selection.toString().trim();
    },
    { signal: selectionController.signal },
  );
  const formDrafts = new Map();
  const key = currentWorkspaceId() + ":" + topicId + ":" + file.id;
  const draft = draftFor(key);
  if (draft.action === "feedback" && draft.range === "当前段落或问题") {
    draft.scope = "whole";
    draft.range = "整份资产";
  }
  let state,
    pending = false,
    error = "",
    operation = null,
    activeTab = "opinions";
  const persist = () => {
    try {
      sessionStorage.setItem("workbench-draft:" + key, JSON.stringify(draft));
    } catch {}
  };
  const endpoint = apiPath("collaboration/") + encodeURIComponent(topicId);
  const currentAsset = () => state?.assets?.find((item) => item.id === file.id);
  function locate(location) {
    const target = document.querySelector("#reader-content");
    if (location?.kind === "time") {
      const media = target?.querySelector("video,audio");
      if (media) {
        media.currentTime = location.seconds;
        document.body.dataset.mobile = "artifact";
        media.scrollIntoView({ block: "center" });
      }
      return;
    }
    if (location?.kind === "quote") {
      const quote = visibleQuote(location.quote);
      const candidates = [
        ...(target?.querySelectorAll(
          ".prose p,.prose li,.prose h1,.prose h2,.prose h3,.raw-text,td,figcaption",
        ) || []),
      ];
      const match = candidates.find((n) =>
        visibleQuote(n.textContent).includes(quote),
      );
      if (match) {
        match.classList.add("highlight");
        match.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => match.classList.remove("highlight"), 8000);
        document.body.dataset.mobile = "artifact";
        return;
      }
      error = "原引用在当前正文中未找到，请打开原版本或重新选择位置。";
      render();
    } else {
      document.body.dataset.mobile = "artifact";
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  function locationHTML(item) {
    return `<button class="opinion-location text-button" data-locate="${escape(item.id)}">${escape(item.location?.label || (item.location?.kind === "quote" ? item.location.quote : "整份资产"))}</button>`;
  }
  function opinionHTML(item) {
    return `<article class="opinion-card"><div class="opinion-meta"><b>${escape(states[item.status] || item.status)}</b><span>${escape(roles[item.actor] || item.actor)} · ${date(item.at || item.createdAt || item.timestamp)}</span></div>${item.stale ? '<p class="stale-note">正文版本已有变化，需结合原引用复验。</p>' : ""}${locationHTML(item)}<p class="opinion-text">${escape(item.text)}</p><small>${escape(item.scope?.label || "")}</small>${(item.responses || []).map((response) => `<div class="opinion-response"><b>${escape(roles[response.actor] || response.actor)} · ${escape(states[response.status] || "回复")}</b><p>${escape(response.text)}</p></div>`).join("")}<details class="opinion-reply"><summary>回复或更新处理状态</summary><form data-response="${escape(item.id)}"><label>处理说明<textarea name="text" rows="3" required placeholder="改了什么、仍需复验什么"></textarea></label><label>状态<select name="status"><option value="open">仍待处理</option><option value="addressed">已修改，待复验</option><option value="resolved">处理完成</option></select></label><button class="button" type="submit" ${pending ? "disabled" : ""}>保存回复</button></form></details></article>`;
  }
  function decisionHTML(item) {
    return `<article class="opinion-card"><div class="opinion-meta"><b>${item.verdict === "accept" ? "接受" : "退回修改"} · ${item.scope?.kind === "partial" ? "局部范围" : "本资产"}</b><span>${escape(roles[item.actor] || item.actor)}</span></div><p>${escape(item.scope?.label)}</p><p>${escape(item.text)}</p>${item.stale ? '<p class="stale-note">版本或关联输入已变，接受范围需复验。</p>' : item.canProceed ? '<p class="decision-proceed">此版本与范围可以继续推进。</p>' : ""}<small>${date(item.at || item.createdAt || item.timestamp)}${item.userConfirmed ? " · 用户本人确认" : ""}</small></article>`;
  }
  function savedVersions(currentFile = file) {
    return relatedTextVersions(
      currentFile.id,
      state.assets.find((asset) => asset.id === currentFile.id)?.hash,
      state.versions || [],
      state.revisions || [],
    );
  }
  function openSavedVersion(version, currentFile = file) {
    if (!version || typeof version.text !== "string") return;
    openVersionReader({
      file: currentFile,
      title: currentFile.id === file.id ? title : currentFile.name,
      versions: savedVersions(currentFile),
      revisions: state.revisions || [],
      selectedHash: version.hash,
      selectedAssetId: version.assetId,
      currentHash: state.assets.find((asset) => asset.id === currentFile.id)
        ?.hash,
      assets: state.assets,
      onNavigate,
      onDrawDiagram,
    });
  }
  function parentVersionHTML(revision) {
    const parent = state.versions?.find(
      (version) =>
        version.assetId === revision.parent?.assetId &&
        version.hash === revision.parent?.hash,
    );
    const name =
      parent?.name ||
      state.assets.find((asset) => asset.id === revision.parent?.assetId)
        ?.name ||
      "已记录版本";
    return typeof parent?.text === "string"
      ? `<button class="text-button" data-parent-version="${escape(revision.id)}">原版本：${escape(name)} · 保存于 ${date(parent.recordedAt)} · 对照正文 →</button>`
      : `<p>原版本：${escape(name)}</p><small>未保存可对照正文；媒体的版本标识不等于历史文件副本。</small>`;
  }
  function changesHTML() {
    const changes = (state.revisions || []).filter(
      (item) =>
        item.assetId === file.id ||
        item.parent?.assetId === file.id ||
        item.impactAssetIds?.includes(file.id),
    );
    const versions = savedVersions();
    const allParents = (state.versions || []).filter(
      (item) => item.assetId !== file.id || item.hash !== currentAsset()?.hash,
    );
    const assets = state.assets.filter(
      (item) => item.id !== file.id && item.available,
    );
    return `<p class="review-help">修改关联旧版本与意见；受影响的下游需要重新核对。</p>${changes.length ? changes.map((item) => `<article class="opinion-card"><b>修订记录</b><p>${escape(item.text)}</p>${parentVersionHTML(item)}${item.impactAssetIds?.length ? `<p>受影响的下游：</p>${item.impactAssetIds.map((id) => `<button class="text-button" data-go="${id}">${escape(state.assets.find((a) => a.id === id)?.name || id)} →</button>`).join("")}` : "<small>未登记额外下游</small>"}</article>`).join("") : '<p class="empty">尚无关联的修订记录。</p>'}${versions.length ? `<details><summary>查看保留的正文版本 · ${versions.length} 份</summary>${versions.map((v, i) => `<button class="text-button" data-version="${i}">${v.assetId === file.id && v.hash === currentAsset()?.hash ? "当前正文的留存" : "修订前正文"} · ${escape(v.name)} · ${date(v.recordedAt)}</button>`).join("")}</details>` : '<p class="review-help">首次保存意见或决定时保留版本依据。媒体保留索引与哈希，原文件不在这里复制。</p>'}<details class="revision-form"><summary>登记当前文件的修改与影响</summary><form id="revision-form"><label>原版本<select name="parent" required><option value="">选择已保留的原版本</option>${allParents.map((v, i) => `<option value="${i}">${escape(v.name)} · ${escape(v.hash?.slice(0, 8))}</option>`).join("")}</select></label><label>本次改动<textarea name="text" required rows="3"></textarea></label><fieldset><legend>这次处理的意见</legend>${
      state.opinions
        .filter((o) => o.status !== "resolved")
        .map(
          (o) =>
            `<label class="checkbox-row"><input type="checkbox" name="feedback" value="${o.id}">${escape(o.text.slice(0, 60))}</label>`,
        )
        .join("") || "<small>没有待处理意见</small>"
    }</fieldset><label>受影响的下游<select name="impact" multiple size="4">${assets.map((a) => `<option value="${a.id}">${escape(a.name)}</option>`).join("")}</select></label><button class="button" type="submit" ${pending || !allParents.length ? "disabled" : ""}>保存修改关系</button></form></details>`;
  }
  function render() {
    if (!node.isConnected) return;
    node.querySelectorAll("[data-response],#revision-form").forEach((form) => {
      const id = form.dataset.response || "revision";
      formDrafts.set(id, [...new FormData(form).entries()]);
    });
    if (!state) {
      node.innerHTML = `<div class="panel-title"><h2>意见与决定</h2></div><p role="status">${error ? escape(error) : "正在读取协作记录…"}</p>${error ? '<button class="button" data-reload>重试读取</button>' : ""}`;
      node.querySelector("[data-reload]")?.addEventListener("click", refresh);
      return;
    }
    const opinions = state.opinions.filter((item) => item.assetId === file.id);
    const decisions = state.decisions.filter(
      (item) => item.assetId === file.id,
    );
    const available = !!currentAsset()?.hash;
    node.innerHTML = `<div class="panel-title"><h2>意见与决定</h2><span>绑定当前资产与版本</span></div><div class="review-tabs"><button data-tab="opinions" class="${activeTab === "opinions" ? "selected" : ""}">审阅 ${opinions.length}</button><button data-tab="changes" class="${activeTab === "changes" ? "selected" : ""}">变化与影响</button><button data-tab="decisions" class="${activeTab === "decisions" ? "selected" : ""}">决定 ${decisions.length}</button></div><div class="review-error" role="status" ${error ? "" : "hidden"}>${escape(error)}${error ? '<button class="text-button" data-reload>刷新版本与记录（保留输入）</button>' : ""}</div>${
      activeTab === "opinions"
        ? `<form id="opinion-form"><div class="form-row"><label>记录来源<select name="actor">${Object.entries(
            roles,
          )
            .map(
              ([value, label]) =>
                `<option value="${value}" ${draft.actor === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></label><label>本次操作<select name="action"><option value="feedback" ${draft.action === "feedback" ? "selected" : ""}>提出意见</option><option value="accept" ${draft.action === "accept" ? "selected" : ""}>接受此范围</option><option value="return" ${draft.action === "return" ? "selected" : ""}>退回修改</option></select></label></div><label>审阅维度<select name="dimension">${["未分类", "理解与解释", "事实与依据", "主题与价值", "视觉与阅读", "视频与声音", "平台与交付", "流程与协作", "其他"].map((value) => `<option ${value === draft.dimension ? "selected" : ""}>${value}</option>`).join("")}</select></label><div class="location-control"><b>位置</b>${["mp4", "mp3", "wav"].includes(file.ext) ? '<button type="button" class="text-button" id="use-time">使用当前播放位置</button>' : ""}<button type="button" class="text-button" id="use-selection">使用正文选中内容</button><p class="quote-preview">${escape(draft.seconds !== null ? "播放时间 " + draft.seconds.toFixed(1) + " 秒" : draft.quote || "整份资产 · 可先在正文选择一段")}</p>${draft.quote || draft.seconds !== null ? '<button type="button" class="text-button" id="clear-quote">取消引用</button>' : ""}</div><label>意见或决定<textarea name="text" required rows="4" placeholder="哪里不满意，或接受了什么具体范围">${escape(draft.text)}</textarea></label><div class="form-row"><label>范围<select name="scope"><option value="partial" ${draft.scope === "partial" ? "selected" : ""}>局部</option><option value="whole" ${draft.scope === "whole" ? "selected" : ""}>整份资产</option></select></label><label>具体范围<input name="range" value="${escape(draft.range)}" required placeholder="例如：第二节机制解释"></label></div>${draft.action === "accept" ? `<label class="checkbox-row"><input name="advance" type="checkbox" ${draft.advance ? "checked" : ""} ${!["user", "proxy"].includes(draft.actor) || (draft.actor === "proxy" && !state.authorization.proxyMayAdvance) ? "disabled" : ""}>接受后继续此范围的工作</label>` : ""}<button class="primary-button" type="submit" ${pending || !available ? "disabled" : ""}>${pending ? "正在保存…" : "保存到当前版本"}</button><p class="review-help">${draft.actor === "proxy" ? "记录为代理审阅；用户本人确认单独保留。" : "来源按本次选择记录。"}${!available ? " 文件当前不可读取，暂不能保存。" : ""}</p></form><div class="opinion-list">${opinions.length ? [...opinions].reverse().map(opinionHTML).join("") : '<div class="empty">还没有在这里保存的意见。可从正文选中一段开始。</div>'}</div><details class="legacy-review"><summary>此前的审核与接受依据</summary>${legacyHTML}</details>`
        : activeTab === "changes"
          ? changesHTML()
          : decisions.length
            ? [...decisions].reverse().map(decisionHTML).join("")
            : '<p class="empty">尚无在这里保存的决定。此前的接受范围仍保留在原始记录中。</p>'
    }`;
    onBind(node);
    node.querySelectorAll("[data-response],#revision-form").forEach((form) => {
      const saved = formDrafts.get(form.dataset.response || "revision");
      if (!saved) return;
      for (const control of form.elements) {
        const values = saved
          .filter(([name]) => name === control.name)
          .map(([, value]) => value);
        if (control.type === "checkbox")
          control.checked = values.includes(control.value);
        else if (control.multiple)
          [...control.options].forEach(
            (option) => (option.selected = values.includes(option.value)),
          );
        else if (values.length) control.value = values[0];
      }
    });
    node.querySelectorAll("[data-tab]").forEach(
      (button) =>
        (button.onclick = () => {
          activeTab = button.dataset.tab;
          render();
        }),
    );
    node.querySelector("[data-reload]")?.addEventListener("click", refresh);
    node
      .querySelectorAll("[data-go]")
      .forEach(
        (button) => (button.onclick = () => onNavigate(button.dataset.go)),
      );
    node
      .querySelectorAll("[data-locate]")
      .forEach(
        (button) =>
          (button.onclick = () =>
            locate(
              opinions.find((o) => o.id === button.dataset.locate)?.location,
            )),
      );
    node
      .querySelectorAll("[data-version]")
      .forEach(
        (button) =>
          (button.onclick = () =>
            openSavedVersion(savedVersions()[Number(button.dataset.version)])),
      );
    node.querySelectorAll("[data-parent-version]").forEach(
      (button) =>
        (button.onclick = () => {
          const revision = state.revisions.find(
            (item) => item.id === button.dataset.parentVersion,
          );
          const parent = state.versions.find(
            (version) =>
              version.assetId === revision?.parent?.assetId &&
              version.hash === revision?.parent?.hash,
          );
          const next = state.assets.find(
            (asset) => asset.id === revision?.assetId,
          );
          if (!next) return;
          openSavedVersion(
            parent,
            next.id === file.id
              ? file
              : { ...next, ext: next.name.split(".").at(-1).toLowerCase() },
          );
        }),
    );
    const form = node.querySelector("#opinion-form");
    if (form) {
      const textLabel = form
        .querySelector('textarea[name="text"]')
        .closest("label");
      form.prepend(textLabel);
      const advanced = document.createElement("details");
      advanced.className = "review-options";
      advanced.open =
        draft.action !== "feedback" || !!draft.quote || draft.seconds !== null;
      advanced.innerHTML = `<summary>${draft.action === "feedback" ? "补充位置、维度与范围（可选）" : "明确本次决定的范围"}</summary>`;
      advanced.append(
        form.querySelector('[name="dimension"]').closest("label"),
        form.querySelector(".location-control"),
        form.querySelector('[name="range"]').closest(".form-row"),
      );
      advanced.querySelector('[name="range"]').required =
        draft.action !== "feedback";
      form.insertBefore(advanced, form.querySelector('button[type="submit"]'));
      form.addEventListener("input", (event) => {
        const control = event.target;
        if (control.name)
          draft[control.name] =
            control.type === "checkbox" ? control.checked : control.value;
        operation = null;
        persist();
      });
      form.addEventListener("change", (event) => {
        if (["action", "actor"].includes(event.target.name)) {
          if (
            event.target.name === "action" &&
            draft.action !== "feedback" &&
            draft.range === "整份资产"
          ) {
            draft.scope = "partial";
            draft.range = "";
          }
          if (
            event.target.name === "action" &&
            draft.action === "feedback" &&
            !draft.range
          ) {
            draft.scope = "whole";
            draft.range = "整份资产";
          }
          if (
            draft.action !== "accept" ||
            !["user", "proxy"].includes(draft.actor)
          )
            draft.advance = false;
          persist();
          render();
        }
      });
      node.querySelector("#use-time")?.addEventListener("click", () => {
        const media = document.querySelector(
          "#reader-content video,#reader-content audio",
        );
        if (media) {
          draft.seconds = Math.round(media.currentTime * 10) / 10;
          draft.scope = "partial";
          draft.quote = "";
          draft.range = "播放时间 " + draft.seconds + " 秒";
          persist();
          render();
        }
      });
      node.querySelector("#use-selection").onmousedown = (event) =>
        event.preventDefault();
      node.querySelector("#use-selection").onclick = async () => {
        const selection = window.getSelection();
        const reader = document.querySelector("#reader-content");
        const liveQuote =
          selection?.toString().trim() &&
          reader?.contains(selection.anchorNode) &&
          reader?.contains(selection.focusNode)
            ? selection.toString().trim()
            : selectedQuote;
        if (!liveQuote) {
          error = "请先在当前正文中选中一段文字，再点此按钮。";
          render();
          return;
        }
        draft.seconds = null;
        try {
          const response = await fetch(apiPath("asset/") + file.id);
          if (!response.ok) throw new Error("原文暂时无法读取，请重试。");
          const quoted = sourceQuote(await response.text(), liveQuote);
          if (!quoted)
            throw new Error(
              "这段选择无法精确映回原文。请缩短到一段文字，或取消引用后按资产记录。",
            );
          draft.quote = quoted;
          draft.scope = "partial";
        } catch (issue) {
          error = issue.message;
          render();
          return;
        }
        draft.range = draft.quote.slice(0, 45);
        error = "";
        persist();
        render();
      };
      node.querySelector("#clear-quote")?.addEventListener("click", () => {
        draft.quote = "";
        draft.seconds = null;
        persist();
        render();
      });
      form.onsubmit = (event) => {
        event.preventDefault();
        send(
          {
            type: draft.action === "feedback" ? "feedback" : "decision",
            actor: draft.actor,
            assetId: file.id,
            expectedHash: currentAsset().hash,
            location:
              draft.seconds !== null
                ? {
                    kind: "time",
                    seconds: draft.seconds,
                    label: "播放时间 " + draft.seconds.toFixed(1) + " 秒",
                  }
                : draft.quote
                  ? { kind: "quote", quote: draft.quote, label: draft.range }
                  : { kind: "file" },
            text: draft.text,
            scope: {
              kind: draft.scope,
              label: draft.dimension + " · " + (draft.range || title),
            },
            stepId,
            ...(draft.action === "feedback"
              ? {}
              : {
                  verdict: draft.action,
                  advance: draft.action === "accept" && draft.advance,
                }),
          },
          true,
        );
      };
    }
    node.querySelectorAll("[data-response]").forEach(
      (form) =>
        (form.onsubmit = (event) => {
          event.preventDefault();
          const source = opinions.find((o) => o.id === form.dataset.response);
          const values = new FormData(form);
          send({
            type: "response",
            actor: draft.actor,
            assetId: source.assetId,
            expectedHash: source.expectedHash,
            location: source.location,
            text: values.get("text"),
            scope: source.scope,
            stepId,
            feedbackId: source.id,
            status: values.get("status"),
          });
        }),
    );
    node
      .querySelector("#revision-form")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = new FormData(event.target);
        const parents = state.versions.filter(
          (item) =>
            item.assetId !== file.id || item.hash !== currentAsset()?.hash,
        );
        const parent = parents[Number(values.get("parent"))];
        send({
          type: "revision",
          actor: draft.actor,
          assetId: file.id,
          expectedHash: currentAsset().hash,
          location: { kind: "file" },
          text: values.get("text"),
          scope: { kind: "whole", label: title },
          stepId,
          parent: { assetId: parent.assetId, hash: parent.hash },
          feedbackIds: values.getAll("feedback"),
          impactAssetIds: values.getAll("impact"),
        });
      });
  }
  async function send(payload, clear = false) {
    if (pending) return;
    const fingerprint = JSON.stringify(payload);
    if (operation?.fingerprint !== fingerprint)
      operation = { fingerprint, id: crypto.randomUUID() };
    pending = true;
    error = "";
    render();
    try {
      const response = await fetch(endpoint + "/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientOperationId: operation.id, ...payload }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          (response.status === 409
            ? "版本或记录已变化，输入已保留。请刷新并核对后重新保存。 "
            : "") + (result.error || "保存失败"),
        );
      operation = null;
      if (clear) {
        draft.text = "";
        draft.quote = "";
        draft.seconds = null;
        draft.range = "整份资产";
        draft.scope = "whole";
        draft.dimension = "未分类";
        draft.action = "feedback";
        draft.advance = false;
        selectedQuote = "";
        window.getSelection()?.removeAllRanges();
        persist();
      }
      await read();
    } catch (e) {
      error = e.message;
    }
    pending = false;
    render();
  }
  async function read() {
    const response = await fetch(
      endpoint + "?assetId=" + encodeURIComponent(file.id),
    );
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "无法读取协作记录");
    state = result;
  }
  async function refresh(redraw = true) {
    error = "";
    try {
      await read();
      if (redraw !== false) onRefresh();
      operation = null;
    } catch (e) {
      error = e.message;
    }
    render();
  }
  render();
  refresh(false);
}
