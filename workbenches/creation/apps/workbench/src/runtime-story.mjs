import { mountCache } from "./runtime-cache.mjs";
import { mountJourney } from "./runtime-journey.mjs";
import { mountRepresentative } from "./runtime-beats.mjs";
const e = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const experts = [
    0, 1, 7, 16, 31, 48, 64, 88, 110, 128, 143, 160, 192, 219, 240, 255,
  ],
  chosen = [1, 7, 31, 88, 143, 219];
function computation(rank, step) {
  const active = ["moe", "exchange"].includes(step);
  if (!active)
    return `<div class="gpu"><b>${step === "overview" ? "GPU等待运行时配置" : "GPU 本地计算"}</b><span>${step === "decode" ? "新token重新走各层算子" : "各层算子使用本机权重和请求状态"}</span></div>`;
  return `<div class="gpu computing"><div class="layer-input">x₂在第ℓ层的表示 hℓ</div><div class="branch-arrows">↙　同一行表示分两路　↘</div><div class="compute-branches"><div><b>Router · 本机复制权重</b><span>打分 → 本例选6个专家</span><i>↓</i><b>读六个专家的本地分片</b><span>计算并按路由权重加权</span></div><div><b>共享专家支路</b><span>本机矩阵分片</span><i>↓</i><b>共享专家本地贡献</b><span>不属于左边top6选择</span></div></div><div class="branch-arrows">↘　两支路本地相加　↙</div><div class="local-output">本地贡献 ${rank === 0 ? "a" : "b"} = 路由专家加权和 + 共享支路</div></div>`;
}
function flowTrack(step) {
  if (step === "prefill")
    return `<div class="logical-flow"><b>整轮逻辑数据流</b><div><span>文本 → 分词ID</span><i>→</i><span>x₀ x₁ x₂ → 嵌入表示</span><i>→</i><span>第1层 → … → 末层</span><i>→</i><span>输出头 / 采样 → y₀</span></div><small>下一两页放大其中x₂的一个MoE层；不是y₀输出后才补做MoE。</small></div>`;
  if (step === "decode")
    return `<div class="logical-flow"><b>生成循环：显示过的token，下一轮才送回模型计算</b><div><span>上一轮已显示 y₀</span><i>↴ 送回模型输入</i><span>第1层 → … → 末层</span><i>→</i><span>输出头 / 采样 → 显示 y₁</span></div><div class="feedback-loop">↶ 下一轮：把 y₁ 送回模型入口，再走全部层；不是只追加字幕</div><small>本轮完成后的逻辑已处理范围：x₀、x₁、x₂、y₀。y₁此时还未经过模型。</small></div>`;
  if (["moe", "exchange"].includes(step))
    return `<div class="zoom-context">层内放大：回到prefill中x₂的第ℓ层。此刻首个输出y₀尚未生成。</div>`;
  return "";
}
function machine(rank, step) {
  const loaded = step !== "overview",
    active = ["moe", "exchange"].includes(step);
  return `<section class="spark-unit"><header><span class="machine-icon">▰</span><div><b>Spark ${rank === 0 ? "A" : "B"}</b><small>本机进程 rank ${rank} · ${rank === 0 ? "HTTP入口" : "headless工作进程"}</small></div><span class="rank-pill">TP ${rank + 1}/2</span></header><div class="disk ${step === "load" ? "lit" : ""}"><span>SSD / 模型文件</span><small>${step === "load" ? "读取本rank需要的数据 ↓" : "加载完成后不按每token重读"}</small></div><div class="memory"><div class="memory-title">本机统一内存 <small>CPU / GPU共享，跨机不共享</small></div><div class="weight-bank ${loaded ? "resident" : ""}"><div class="bank-title">模型权重 <span>${loaded ? "驻留 · 跨步保持" : "等待加载"}</span></div><div class="weight-other">注意力 / 路由 / 输出头等 <small>各张量切法不同，未在此一律对半画</small></div><div class="expert-label">每个路由专家的矩阵分片 ${rank === 0 ? "A" : "B"} <small>两台不是各放一半完整专家</small></div><div class="expert-bank">${experts.map((n) => `<span class="expert ${active && chosen.includes(n) ? "selected" : ""}">E${n}<small>${rank === 0 ? "A" : "B"}片</small></span>`).join("")}</div><div class="expert-legend">${!loaded ? "未加载：格子仅表示将要装入的布局" : active ? "亮：本例选中　暗：仍驻留、此token未选中" : "全为中性色：本页未展开每个token的路由，不能读成没有专家参与"}</div><div class="shared-weight ${active ? "active" : ""}">共享专家权重 · 本机分片<br><small>本层还会走共享支路</small></div></div><div class="state-row"><div class="request-state ${["prefill", "decode"].includes(step) ? "writing" : ""}"><b>请求历史</b><span>${["overview", "load"].includes(step) ? "此请求尚未建立" : step === "decode" ? "本轮已处理到 y₀" : active ? "由本层注意力路径维护" : "已处理输入 x₀…x₂"}</span><small>按层/并行布局保存的状态<br>不是每个标签都对应一个完整KV槽</small></div><div class="temporary-state ${active ? "writing" : ""}"><b>临时张量</b><span>${active ? "局部输出 " + (rank === 0 ? "a" : "b") : "当前层表示 / 中间值"}</span><small>随本轮计算更新、复用<br>与长期权重分开</small></div></div></div><div class="local-arrow">本地读权重与历史 ↓　计算后写结果 ↑</div>${computation(rank, step)}</section>`;
}
export function mountRuntimeStory(target, story) {
  if (
    story.schemaVersion !== 1 ||
    !Array.isArray(story.steps) ||
    !story.steps.length
  ) {
    target.textContent = "图解数据格式尚未支持";
    return;
  }
  let current = Math.max(
    0,
    story.steps.findIndex(
      (s) => s.id === new URLSearchParams(location.search).get("scene"),
    ),
  );
  const locate = (scene, beat) => {
    const url = new URL(location.href);
    url.searchParams.set("scene", scene);
    url.searchParams.set("beat", String(beat));
    history.replaceState(null, "", url);
  };
  const selectScene = (index) => {
    current = index;
    locate(story.steps[current].id, 0);
    render();
  };
  function render() {
    const s = story.steps[current];
    target.innerHTML = `<article class="runtime-story" aria-label="双Spark运行机制交互图解"><header class="runtime-heading"><div class="runtime-kicker">RUNTIME ATLAS / 双机运行图解</div><h2>${e(story.title)}</h2><p>${e(story.subtitle)}</p><div class="runtime-status">${e(story.version)} · ${e(story.status)}</div></header><div class="runtime-tabs" role="tablist" aria-label="运行步骤">${story.steps.map((x, i) => `<button role="tab" aria-selected="${i === current}" data-runtime-step="${i}"><span>0${i + 1}</span>${e(x.short)}</button>`).join("")}</div><section class="runtime-explanation" aria-live="polite"><div class="runtime-kicker">${e(s.eyebrow)}</div><h3>${e(s.title)}</h3><p>${e(s.lead)}</p></section><div class="runtime-topology"><div class="recipe-strip"><b>软件配置决定分工</b><span>${e(story.recipe)}</span></div><div class="request-track"><div><small>这一刻的输入</small><b>${e(s.input)}</b></div><span class="gold-arrow">→</span><div><small>这一刻的输出</small><b>${e(s.output)}</b></div></div>${flowTrack(s.id)}<div class="machine-pair">${machine(0, s.id)}${machine(1, s.id)}</div><div class="network-bus ${s.id === "exchange" ? "transferring" : ""}"><span class="bus-arrow">⇄</span><div><b>两机互联 / 显式通信</b><p>${e(s.network)}</p></div>${s.id === "exchange" ? '<div class="reduce-result">a + b<br><small>↑ 返回A　返回B ↑</small></div>' : ""}</div><p class="diagram-note">${e(story.diagramNote)}</p></div><div class="state-delta"><div><span>本步改变</span><p>${e(s.changed)}</p></div><div><span>跨步保持</span><p>${e(s.kept)}</p></div><div><span>释放 / 复用</span><p>${e(s.released)}</p></div></div><details class="runtime-detail"><summary>展开：实现边界与容易误解的地方</summary><p class="journey-boundary">固定对照说明：${e({ prefill: "第3拍结束，y₀刚显示", decode: "第2拍结束，y₁刚显示", moe: "局部计算完成", exchange: "合并完成", load: "加载结束", overview: "配置关系", dspark: "验证与提交逻辑", finish: "请求完成与资源管理" }[s.id])}。以下文字不随上方分拍变化。</p><p>${e(s.detail)}</p><dl><dt>请求历史</dt><dd>${e(s.history)}</dd><dt>临时计算</dt><dd>${e(s.temporary)}</dd></dl></details><div class="runtime-pager"><button class="button" data-runtime-prev ${current === 0 ? "disabled" : ""}>← 上一步</button><span>${current + 1} / ${story.steps.length} · 章节导航 · 可回看与层内放大</span><button class="button" data-runtime-next ${current === story.steps.length - 1 ? "disabled" : ""}>下一步 →</button></div><details class="runtime-sources"><summary>本图使用的第一手资料</summary>${(story.sources || []).map((x) => `<p>${/^https:\/\//.test(x.url) ? `<a href="${e(x.url)}" target="_blank" rel="noopener noreferrer">${e(x.title)}</a>` : e(x.title)} — ${e(x.supports)}</p>`).join("") || "<p>来源核验正在整理，本稿未获技术审核通过。</p>"}</details></article>`;
    {
      const diagram = target.querySelector(".runtime-topology"),
        intro = target.querySelector(".runtime-explanation");
      const focused = document.createElement("section");
      focused.className = "representative";
      diagram.before(focused);
      const initialBeat = Number(
        new URLSearchParams(location.search).get("beat") || 0,
      );
      if (["moe", "exchange"].includes(s.id)) {
        mountRepresentative(
          focused,
          initialBeat,
          (beat) => locate(s.id, beat),
          s.id === "moe" ? [0, 2] : [3, 4],
        );
      } else {
        mountJourney(focused, s.id, initialBeat, (beat) => locate(s.id, beat));
      }
      if (["prefill", "decode"].includes(s.id)) {
        const cache = document.createElement("details");
        cache.className = "runtime-detail";
        focused.after(cache);
        mountCache(cache);
      }
      const more = document.createElement("details");
      more.className = "runtime-detail";
      more.innerHTML = "<summary>展开完整驻留布局、状态与实现边界</summary>";
      diagram.before(more);
      const anchor = {
        overview: "配置关系",
        load: "加载结束",
        prefill: "第3拍结束：y₀刚显示，尚未送回模型",
        moe: "本层局部计算完成",
        exchange: "合并完成",
        decode: "第2拍结束：已处理y₀，y₁刚显示",
      }[s.id];
      const note = document.createElement("p");
      note.className = "journey-boundary";
      note.textContent = `固定对照图 · ${anchor || "逻辑边界"}。本图不随上方分拍变化，不代表正在查看的每一拍状态。`;
      more.append(note, diagram);
      target.querySelector(".state-delta")?.remove();
      if (["dspark", "finish"].includes(s.id)) more.remove();
      intro.classList.add("compact-explanation");
    }
    target.querySelectorAll("[data-runtime-step]").forEach(
      (b) =>
        (b.onclick = () => {
          selectScene(Number(b.dataset.runtimeStep));
        }),
    );
    target.querySelector("[data-runtime-prev]").onclick = () => {
      if (current > 0) {
        selectScene(current - 1);
        target
          .querySelector(".runtime-tabs")
          .scrollIntoView({ block: "start", behavior: "smooth" });
      }
    };
    target.querySelector("[data-runtime-next]").onclick = () => {
      if (current < story.steps.length - 1) {
        selectScene(current + 1);
        target
          .querySelector(".runtime-tabs")
          .scrollIntoView({ block: "start", behavior: "smooth" });
      }
    };
    target.querySelector("[role=tablist]").onkeydown = (ev) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) {
        ev.preventDefault();
        current =
          ev.key === "Home"
            ? 0
            : ev.key === "End"
              ? story.steps.length - 1
              : Math.max(
                  0,
                  Math.min(
                    story.steps.length - 1,
                    current + (ev.key === "ArrowRight" ? 1 : -1),
                  ),
                );
        selectScene(current);
        target.querySelector(`[data-runtime-step="${current}"]`).focus();
      }
    };
  }
  render();
}
