import { apiPath } from "./workspace-api.mjs";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const actors = {
  user: "用户",
  proxy: "代理审阅",
  agent: "执行者",
  technical: "技术审阅",
};
const actorField = `<label>记录来源<select name="actorType">${Object.entries(
  actors,
)
  .map(([value, label]) => `<option value="${value}">${label}</option>`)
  .join("")}</select></label>`;
const labels = {
  currentCommitment: "本期内容承诺",
  currentStageGoal: "当前阶段目标",
  currentTask: "本轮任务",
  currentActor: "当前负责人",
  recent: "最近发生了什么",
  result: "已经形成的结果",
  next: "下一步",
  unresolved: "仍需讨论的问题",
};
async function read(route) {
  const r = await fetch(apiPath(route));
  const body = await r.json();
  if (!r.ok) throw Error(body.error || "读取失败");
  return body;
}
async function save(route, body) {
  const r = await fetch(apiPath(route), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok)
    throw Error(
      r.status === 409
        ? "这份记录已被更新。你的输入仍在这里，请先重新读取最新记录再合并。"
        : result.error || "保存失败",
    );
  return result;
}
export async function mountPositioningEditor(node, onSaved) {
  if (!node) return;
  try {
    const response = await read("identity"),
      identity = response.identity || response;
    if (!node.isConnected) return;
    node.innerHTML = `<details class="context-editor"><summary>调整账号定位</summary><p class="meta">这里维护跨期沿用的共同依据。每次保存保留版本，建议和确认分别记录。</p><form class="account-form">${actorField}<div>${Object.entries(
      { purpose: "长期目的", readers: "目标读者", promise: "持续内容承诺" },
    )
      .map(([key, label]) => {
        const p = identity.positioning[key];
        return `<label>${label}<textarea name="${key}" maxlength="4000">${esc(p.value)}</textarea><select name="${key}Status" aria-label="${label}状态">${["unknown", "proposed", "confirmed"].map((s) => `<option value="${s}" ${p.status === s ? "selected" : ""}>${{ unknown: "尚未确认", proposed: "建议", confirmed: "已确认" }[s]}</option>`).join("")}</select></label>`;
      })
      .join(
        "",
      )}</div><label>本次调整的依据<textarea name="reason" required maxlength="2000" placeholder="记录讨论或用户原话，说明为什么调整。"></textarea></label><button class="primary-button">保存定位</button><p role="status"></p></form><details><summary>定位版本与来源</summary><p>当前版本 ${identity.positioningRevision} · ${esc(identity.updatedAt || "来自已登记历史")}</p><div data-profile-history></div></details></details>`;
    const form = node.querySelector("form");
    let op = crypto.randomUUID(),
      previous = "";
    form.onsubmit = async (e) => {
      e.preventDefault();
      const button = form.querySelector("button"),
        status = form.querySelector('[role="status"]');
      button.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        const positioning = Object.fromEntries(
          ["purpose", "readers", "promise"].map((key) => [
            key,
            {
              value: values[key],
              status: values[key + "Status"],
              sources: [
                ...(identity.positioning[key].sources || []),
                { label: values.reason },
              ],
            },
          ]),
        );
        const body = {
          expectedRevision: identity.positioningRevision,
          positioning,
          actorType: values.actorType,
        };
        const signature = JSON.stringify(body);
        if (signature !== previous) {
          op = crypto.randomUUID();
          previous = signature;
        }
        await save("identity", { ...body, clientOperationId: op });
        status.textContent = "已保存到工作台。";
        await onSaved();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    };
    const history = response.history || identity.history || [];
    node.querySelector("[data-profile-history]").innerHTML = history.length
      ? history
          .map(
            (h) =>
              `<details><summary>版本 ${esc(h.revision)} · ${esc(h.updatedAt || h.at)} · ${esc(actors[h.actorType] || h.actorType || "记录来源见依据")}</summary>${Object.entries(
                h.positioning || {},
              )
                .map(
                  ([key, p]) =>
                    `<p><b>${esc({ purpose: "长期目的", readers: "目标读者", promise: "持续内容承诺" }[key] || key)}</b> · ${esc(p.value)}</p>`,
                )
                .join("")}</details>`,
          )
          .join("")
      : '<p class="meta">原始定位的来源保留在上方各项记录中。</p>';
  } catch (error) {
    if (node.isConnected)
      node.innerHTML = `<p class="notice">定位编辑暂时不可用：${esc(error.message)}</p>`;
  }
}
export async function mountContentContext(node, topic, onSaved, onAsset) {
  if (!node) return;
  node.innerHTML = '<p class="meta" role="status">正在读取协作脉络…</p>';
  try {
    const [summaryResult, review] = await Promise.all([
      read("collaboration-summary/" + encodeURIComponent(topic.id)),
      read("collaboration/" + encodeURIComponent(topic.id)),
    ]);
    if (!node.isConnected) return;
    const summary = summaryResult.summary || summaryResult,
      fields = summary.fields || {};
    const opinions = review.opinions || [],
      pending = opinions.filter((o) => o.status !== "resolved");
    node.innerHTML = `<section class="content-context"><div class="section-heading"><h2>协作脉络</h2><span>${review.events.length} 条正式记录 · ${pending.length} 条尚未标记解决</span></div><p class="meta">回看意见怎样带来修改。摘要帮助接续工作，接受范围以具体资产的决定为准。</p><details class="context-editor"><summary>更新本期共同上下文</summary><form class="account-form">${actorField}${Object.entries(
      labels,
    )
      .map(
        ([key, label]) =>
          `<label>${label}<textarea name="${key}" maxlength="8000">${esc(fields[key] || "")}</textarea></label>`,
      )
      .join(
        "",
      )}<button class="primary-button">保存本期上下文</button><p role="status"></p></form><p class="meta">版本 ${summary.revision} · ${esc(summary.updatedAt || "历史登记")}</p><details><summary>上下文修订记录 · ${summary.history?.length || 0}</summary>${(
      summary.history || []
    )
      .map(
        (h) =>
          `<details><summary>版本 ${h.revision} · ${esc(h.updatedAt)} · ${esc(actors[h.actorType])}</summary>${Object.entries(
            h.fields,
          )
            .map(([k, v]) => `<p><b>${esc(labels[k] || k)}</b> · ${esc(v)}</p>`)
            .join("")}</details>`,
      )
      .join(
        "",
      )}</details></details><details class="context-opinions" ${pending.length ? "open" : ""}><summary>需要接住的意见 · ${pending.length}</summary>${
      pending
        .slice(-8)
        .reverse()
        .map(
          (o) =>
            `<article class="context-event"><span class="eyebrow">${esc(actors[o.actor] || o.actor)} · ${o.stale ? "对应历史版本" : "版本仍可核对"}</span><p>${esc(o.text)}</p>${o.responses?.length ? `<blockquote>${esc(o.responses.at(-1).text)}</blockquote>` : ""}<button class="text-button" data-context-asset="${esc(o.assetId)}">查看资产、修改和决定 →</button></article>`,
        )
        .join("") ||
      '<p class="meta">暂无未解决的正式意见；这不等同于整期自动通过。</p>'
    }${pending.length > 8 ? '<p class="meta">这里显示最近八条，其余保留在下面的完整记录中。</p>' : ""}</details><details class="context-history"><summary>完整协作记录 · ${review.events.length}</summary><div class="context-timeline">${
      review.events
        .slice()
        .reverse()
        .map(
          (e) =>
            `<article class="context-event"><small>${esc(new Date(e.at).toLocaleString("zh-CN"))} · ${esc(actors[e.actor] || e.actor)} · ${esc({ feedback: "提出意见", response: "回应意见", revision: "登记修改", decision: "作出决定" }[e.type] || e.type)}</small><p>${esc(e.text)}</p><small>${esc(e.scope?.label)}${e.scopeChanged ? " · 工作区归属已调整，原审核范围保留" : ""}</small><button class="text-button" data-context-asset="${esc(e.assetId)}">查看对应版本 →</button></article>`,
        )
        .join("") || "<p>尚无正式协作记录。</p>"
    }</div></details></section>`;
    node
      .querySelectorAll("[data-context-asset]")
      .forEach((b) => (b.onclick = () => onAsset(b.dataset.contextAsset)));
    const form = node.querySelector("form");
    let operationId = crypto.randomUUID(),
      last = "";
    form.onsubmit = async (e) => {
      e.preventDefault();
      const b = form.querySelector("button"),
        s = form.querySelector('[role="status"]');
      b.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        const { actorType, ...fields } = values;
        const body = { expectedRevision: summary.revision, actorType, fields };
        const signature = JSON.stringify(body);
        if (signature !== last) {
          operationId = crypto.randomUUID();
          last = signature;
        }
        await save("collaboration-summary/" + encodeURIComponent(topic.id), {
          ...body,
          clientOperationId: operationId,
        });
        await onSaved();
      } catch (error) {
        s.textContent = error.message;
        b.disabled = false;
      }
    };
  } catch (error) {
    if (node.isConnected)
      node.innerHTML = `<p class="notice">协作脉络未能读取：${esc(error.message)}</p>`;
  }
}
