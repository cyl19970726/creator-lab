const ink = "#efe7d5",
  muted = "#a9b39a",
  gold = "#d5ad65",
  line = "#666a55";
export const toy = {
  uA: [2, 1],
  uB: [3, 4],
  a: [2, 1],
  b: [-1, 7],
  sum: [1, 8],
};
const labels = [
  "Router选择专家，两台点亮对应分片",
  "同一个专家，拆开中间通道",
  "各自算出局部贡献",
  "带着a和b经过互联",
  "两端拿到合并结果",
];
const captions = [
  "Router依据当前表示选择路由专家。本例从256个中选6个；两台使用这6个专家各自的矩阵分片。没选的权重仍驻留，共享专家走独立支路。下一拍只放大其中一个专家。",
  "只放大一个已选专家的输出投影。中间通道是专家前半段计算出的数值项；uA/uB是两台各自算出的中间数值，不是把h直接对半切，也不是权重。",
  "用4个教学通道替代真实宽度：A处理[2,1]，B处理[3,4]，经过各自输出矩阵块后得到a=[2,1]和b=[−1,7]。",
  "a、b是待合并的数值行，不是权重。图中亮线表示all-reduce的逻辑归约与分发；实际通信库可能分块多轮。",
  "A和B最终都拿到a+b=[1,8]。单个专家的分片贡献先可这样理解；真实MoE会结合路由权重、其他选中专家与共享支路的本地和再归约。",
];
const text = (x, y, t, size = 16, fill = ink, anchor = "start") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-family="system-ui">${t}</text>`;
const rect = (x, y, w, h, fill, stroke = line) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}"/>`;
function routingFrame() {
  const chosen = [1, 7, 31, 88, 143, 219];
  return `<svg viewBox="0 0 1040 475" role="img" aria-label="代表段第1拍：路由选择、双机分片与常驻权重"><defs><marker id="route-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="${gold}"/></marker></defs>
 ${rect(340, 6, 360, 48, "#373a2e", gold)}${text(520, 34, "同一 x₂「？」的本层数值表示 h", 18, ink, "middle")}
 ${rect(335, 84, 370, 49, "#62502e", gold)}${text(520, 115, "Router：本例选6 / 256个路由专家", 17, ink, "middle")}
 <path d="M520 54V84" fill="none" stroke="${gold}" stroke-width="2" marker-end="url(#route-arrow)"/><path d="M335 108H235V155" fill="none" stroke="${gold}" stroke-width="2" marker-end="url(#route-arrow)"/><path d="M705 108H805V155" fill="none" stroke="${gold}" stroke-width="2" marker-end="url(#route-arrow)"/>
 ${[30, 605]
   .map(
     (x, r) =>
       `${rect(x, 155, 405, 184, "#272d24")}${text(x + 202, 182, `Spark ${r ? "B" : "A"} · 每个专家均有本地分片`, 18, ink, "middle")}${chosen
         .map((n, i) => {
           const xx = x + 18 + (i % 3) * 123,
             yy = 196 + Math.floor(i / 3) * 45;
           return (
             rect(xx, yy, 113, 36, "#72582d", gold) +
             text(
               xx + 56,
               yy + 24,
               `E${n} · ${r ? "B" : "A"}片`,
               14,
               ink,
               "middle",
             )
           );
         })
         .join(
           "",
         )}${rect(x + 18, 291, 359, 30, "#343a2e")}${text(x + 197, 311, "其余250个专家分片：仍驻留，本次不选", 13, muted, "middle")}`,
   )
   .join("")}
 <path d="M340 30H15V383H75" stroke="${gold}" fill="none" marker-end="url(#route-arrow)"/><path d="M700 30H1025V383H965" stroke="${gold}" fill="none" marker-end="url(#route-arrow)"/>
 ${rect(75, 357, 320, 51, "#4b5132", gold)}${rect(645, 357, 320, 51, "#4b5132", gold)}${text(235, 379, "共享专家 · A本地分片", 16, ink, "middle")}${text(805, 379, "共享专家 · B本地分片", 16, ink, "middle")}${text(235, 397, "直接读h，不属于上面的6选中专家", 11, muted, "middle")}${text(805, 397, "直接读h，不属于上面的6选中专家", 11, muted, "middle")}
 ${text(520, 435, "一处逻辑Router示意；路由权重在各rank复制。两台不是各装一半完整专家。", 12, muted, "middle")}${text(520, 463, "动态路由层的教学选择；具体专家编号非trace。前三层另有token-ID查表路由。", 12, muted, "middle")}</svg>`;
}
export function representativeFrame(beat) {
  if (beat === 0) return routingFrame();
  const local = beat >= 2,
    traffic = beat >= 3,
    merged = beat >= 4;
  return `<svg viewBox="0 0 1040 475" role="img" aria-label="代表段第${beat + 1}拍：${labels[beat]}"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="${gold}"/></marker></defs>
 ${rect(365, 6, 310, 49, "#373a2e", gold)}${text(520, 28, "当前token → 一行数值表示 h", 16, ink, "middle")}${text(520, 46, "此处 h 是示例 x₂「？」在一层里的表示", 11, muted, "middle")}
 <path d="M435 55V73H235V92" fill="none" stroke="${gold}" stroke-width="2" marker-end="url(#flow-arrow)"/>
 <path d="M605 55V73H805V92" fill="none" stroke="${gold}" stroke-width="2" marker-end="url(#flow-arrow)"/>
 ${[0, 1]
   .map((r) => {
     const x = r ? 605 : 30,
       v = r ? "B" : "A";
     return `${rect(x, 92, 405, 265, "#272d24", line)}${text(x + 18, 119, "Spark " + v, 23)}${text(x + 387, 117, "本机内存与GPU", 12, muted, "end")}${rect(x + 17, 135, 371, 59, "#333628", beat === 1 ? gold : line)}${text(x + 29, 159, "已选专家的矩阵分片 " + v + " · 常驻", 15, gold)}${text(x + 29, 180, "其他专家分片也仍驻留；此处只放大一个专家", 11, muted)}${text(x + 202, 217, beat === 0 ? "同一层，两台一起算" : r ? "中间数值 uB = [3, 4]" : "中间数值 uA = [2, 1]", 17, ink, "middle")}${text(x + 202, 240, r ? "输出矩阵块 WB = [[1,1], [−1,1]]" : "输出矩阵块 WA = [[1,0], [0,1]]", 13, muted, "middle")}${text(x + 202, 264, r ? "[3,4] × WB = [3−4, 3+4]" : "[2,1] × WA = [2,1]", 13, muted, "middle")}${rect(x + 54, 283, 297, 51, local ? "#6a532c" : "#353b2d", local ? gold : line)}${text(x + 202, 315, local ? (r ? "局部贡献 b = [−1, 7]" : "局部贡献 a = [2, 1]") : "等待本地计算", 18, local ? "#fff0c7" : muted, "middle")}`;
   })
   .join("")}
 ${rect(442, 190, 156, 132, traffic ? "#58462a" : "#303327", traffic ? gold : line)}${text(520, 218, "两机互联", 16, gold, "middle")}${text(520, 245, traffic ? "归约：a + b" : "等待结果", 16, ink, "middle")}${text(520, 269, traffic ? "[1, 8]" : "尚未合并", 21, gold, "middle")}${text(520, 292, "逻辑合并点", 11, muted, "middle")}${text(520, 310, "不是第三台设备", 10, muted, "middle")}
 <path d="M381 307H426V258H442" fill="none" stroke="${traffic ? gold : "#424936"}" stroke-width="${traffic ? 3 : 1}" marker-end="${traffic ? "url(#flow-arrow)" : "none"}"/>
 <path d="M659 307H614V258H598" fill="none" stroke="${traffic ? gold : "#424936"}" stroke-width="${traffic ? 3 : 1}" marker-end="${traffic ? "url(#flow-arrow)" : "none"}"/>
 ${traffic ? text(411, 299, "a", 16, gold, "middle") + text(629, 299, "b", 16, gold, "middle") : ""}
 <path d="M490 322V380H235V399" fill="none" stroke="${merged ? gold : "#424936"}" stroke-width="${merged ? 3 : 1}" marker-end="${merged ? "url(#flow-arrow)" : "none"}"/>
 <path d="M550 322V380H805V399" fill="none" stroke="${merged ? gold : "#424936"}" stroke-width="${merged ? 3 : 1}" marker-end="${merged ? "url(#flow-arrow)" : "none"}"/>
 ${rect(75, 400, 320, 49, merged ? "#5c532f" : "#252a23", merged ? gold : line)}${rect(645, 400, 320, 49, merged ? "#5c532f" : "#252a23", merged ? gold : line)}${text(235, 431, merged ? "A得到完整结果 [1, 8]" : "A等待完整结果", 17, merged ? ink : muted, "middle")}${text(805, 431, merged ? "B得到完整结果 [1, 8]" : "B等待完整结果", 17, merged ? ink : muted, "middle")}
 ${text(520, 468, "教学数值与尺寸，仅解释一个专家的分片输出相加；不是实际运行trace或通信包路径。", 11, muted, "middle")}
 </svg>`;
}
export function mountRepresentative(
  host,
  initial = 0,
  onChange = () => {},
  range = [0, 4],
) {
  const [from, to] = range;
  let beat = Number.isFinite(initial)
    ? Math.max(from, Math.min(to, Math.trunc(initial)))
    : from;
  function draw() {
    onChange(beat);
    host.innerHTML = `<div class="representative-head"><span class="layer-position">层内回看：Prefill中x₂的一个动态MoE层；首个输出y₀尚未产生</span><h3>${labels[beat]}</h3><p>${captions[beat]}</p></div><div class="representative-controls" role="group" aria-label="分拍查看"><button data-beat-prev ${beat === from ? "disabled" : ""}>←</button>${labels.map((_, i) => (i < from || i > to ? "" : `<button data-beat="${i}" aria-pressed="${i === beat}">${i + 1}</button>`)).join("")}<button data-beat-next ${beat === to ? "disabled" : ""}>下一拍 →</button><span>${from === 0 && to === 2 ? "本章1–3拍：局部计算；下一章继续合并" : from === 3 ? "接上章第3拍：局部结果已就绪；现在合并" : "5拍解释一个专家如何跨两机计算"}</span></div><div class="representative-canvas">${representativeFrame(beat)}</div><details class="representative-boundary"><summary>把这个教学例子放回真实MoE层</summary><p>真实动态路由层选择6个路由专家，另外还有共享专家支路。本例只放大其中一个专家，尚未乘路由权重。真实实现先形成每台的局部加权专家与共享支路之和，再做all-reduce；因此实际a/b可能是这些支路的合计。选中专家的分片在两台都有，未选中的权重也不离开内存。</p><p>数值来源是人为教学矩阵：uA×WA=[2,1]；uB×WB=[−1,7]；求和=[1,8]。这里只演示中间通道已得到后怎样通过输出矩阵块合成一份结果，未声称演示完整专家门控或实际模型权重。</p></details>`;
    host.querySelectorAll("[data-beat]").forEach(
      (b) =>
        (b.onclick = () => {
          beat = Number(b.dataset.beat);
          draw();
        }),
    );
    host.querySelector("[data-beat-prev]").onclick = () => {
      beat--;
      draw();
    };
    host.querySelector("[data-beat-next]").onclick = () => {
      beat++;
      draw();
    };
  }
  draw();
}
