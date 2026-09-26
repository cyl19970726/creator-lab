// Teaching request: labels are not a measured tokenizer result or model output.
const ink = "#efe7d5",
  muted = "#abb59d",
  gold = "#d5ad65";
const scenes = {
  overview: [
    [
      "先确定一条请求与一套分工",
      "我们用「算力？」作为贯穿示例。x₀「算」、x₁「力」、x₂「？」以及后面的输出，都是人为教学标签，不是真实分词或模型回答。",
      "示例请求：算力？（尚未提交）",
      "服务尚未启动",
      "尚无请求",
      "未开始",
      "用户尚未收到输出",
    ],
    [
      "两个进程组成同一层的计算队伍",
      "vLLM是组织加载、调度与GPU计算的推理软件。rank是进程编号。TP=2让两台分担同一层的张量计算；PP=1表示这里不按前后层把模型分成两段。",
      "示例请求等待服务就绪",
      "rank 0 入口 / rank 1 协作",
      "尚无请求",
      "建立并行与通信关系",
      "准备加载权重",
    ],
  ],
  load: [
    [
      "权重起初是磁盘上的文件",
      "权重是训练后固定下来的数值参数。启动加载器根据进程编号读取自己负责的数据；此时还没有这条请求的历史。",
      "示例请求等待加载",
      "模型文件在SSD",
      "尚无请求",
      "读取 / 转换 / 放置",
      "仍未产生回答",
    ],
    [
      "两台各自装入需要的权重布局",
      "选定配方中，每台持有每个专家的一部分矩阵。不是A装前128个完整专家、B装后128个。非专家张量按各自算子规则放置，不能统统画成对半。",
      "请求尚未进入模型",
      "SSD → 本机统一内存",
      "尚无请求",
      "建立可计算的本地参数",
      "加载中的临时空间可能变化",
    ],
    [
      "常驻权重就位，服务可以接请求",
      "后续步骤反复读本机权重。两机内存各自独立，跨机结果必须显式通信；一次请求结束并不要求卸载整份模型。",
      "提交示例请求：算力？",
      "模型权重常驻",
      "为本请求建立状态",
      "等待输入数值表示",
      "下一步：文本进入模型",
    ],
  ],
  prefill: [
    [
      "文本先变成多行数值表示",
      "分词器把文本变成ID，嵌入表再把每个ID变成一行数字。这里的三行只是教学简化。Prefill处理整段输入，不能把它理解成单独存一份文本缓存。",
      "算力？ → x₀「算」 x₁「力」 x₂「？」",
      "模型权重常驻",
      "初始：本请求尚无已处理历史",
      "ID → 嵌入 → h₀、h₁、h₂",
      "尚无首个输出 y₀",
    ],
    [
      "这些表示依次走过模型层",
      "一层是一轮更新表示的计算：注意力利用允许看到的上下文，MoE等算子继续改变数值。两台按同一并行配方协作。接下来的两页，放大此刻x₂在一个动态路由层里的计算。",
      "x₀、x₁、x₂ 的当前层表示",
      "模型权重常驻",
      "逐层建立后续计算所需历史",
      "注意力 → MoE → 后续层",
      "仍在prefill内部，y₀尚未产生",
    ],
    [
      "走到末端，才选出第一份回答",
      "输入走完后，输出头给出下一token的分数，采样规则选择y₀。教学中把y₀标为「计算」。此刻它可以显示给用户，但还没有作为新输入走过模型。",
      "输入已处理：x₀、x₁、x₂",
      "模型权重常驻",
      "逻辑历史：x₀ x₁ x₂",
      "末层 → 输出分数 → 采样",
      "新增 y₀「计算」；尚未送回模型",
    ],
  ],
  decode: [
    [
      "把刚显示的「计算」送回入口",
      "普通decode的一轮输入是上一轮生成的token。把y₀重新变为数值表示，再走全部模型层；已有历史参与注意力计算，权重保持。",
      "送回模型输入：y₀「计算」",
      "模型权重常驻",
      "之前：x₀ x₁ x₂",
      "y₀ → 所有层（含双机协作）",
      "用户此前已看到：计算",
    ],
    [
      "本轮处理y₀，输出新的y₁",
      "本轮结束时，各层状态已包含处理y₀所需的更新；教学采样得到y₁「能力」。新增输出与已经经过模型的输入始终差一个送回模型步骤。",
      "本轮已处理：y₀",
      "模型权重常驻",
      "之后：x₀ x₁ x₂ y₀",
      "输出头 / 采样 → y₁",
      "累计输出：计算 能力；y₁尚未送回模型",
    ],
    [
      "再把「能力」送回模型，循环重复",
      "y₁再次走所有层，读取并更新历史。不是只在屏幕上追加文字：每轮都有新表示、专家计算和并行通信。假设本轮达到停止条件，最后一章看资源回收；下一章先对照实际配方的DSpark分支。",
      "送回模型输入：y₁「能力」",
      "模型权重常驻",
      "之后：x₀ x₁ x₂ y₀ y₁",
      "再次走模型 → 停止条件成立",
      "示例回答结束：计算 能力",
    ],
  ],
  dspark: [
    [
      "实际配方：先产生待验证候选",
      "前页是普通decode基线。所选配方实际使用DSpark推测解码，并配置5个候选；这一页只展示逻辑区别。候选不等于正式回答，不能直接显示给用户。",
      "已确认上下文 → 候选 c₁…c₅",
      "模型权重常驻",
      "正式历史 / 候选临时状态分开",
      "草拟：c₁ c₂ c₃ c₄ c₅",
      "正式输出暂不增加",
    ],
    [
      "假设前两个接受，第三个拒绝",
      "这是人为假设的一次验证结果：d₁、d₂接受，d₃拒绝，后续d₄、d₅不能继续采用。候选状态仍与正式历史分开；不是先把5个词发给用户再撤回。",
      "目标模型验证候选",
      "模型权重常驻",
      "只接受连续前缀",
      "d₁✓ d₂✓ d₃× d₄— d₅—",
      "拒绝点还需按校正规则产生新token",
    ],
    [
      "提交确认结果，再从新上下文继续",
      "本假设推进d₁、d₂及拒绝位置的校正token t₃。未接受的草稿失去有效身份，不表示物理缓存立刻清零。若全部接受，还可能有额外token；实际数量也受停止条件限制。",
      "新正式上下文 → 下一轮草拟",
      "模型权重常驻",
      "正式：d₁ d₂ t₃",
      "提交确认结果；舍弃无效草稿",
      "正式输出：d₁ d₂ t₃",
    ],
  ],
  finish: [
    [
      "停止的是这条请求",
      "达到停止条件或请求终止后，服务不再为本请求继续生成。已交付的文本留在客户端；服务把该请求从正在执行的工作中移出。",
      "示例请求已完成",
      "服务仍运行，权重常驻",
      "本请求不再继续计算",
      "停止调度本请求的新token",
      "客户端保留：计算 能力",
    ],
    [
      "归还可复用资源，权重继续服务下一条请求",
      "本请求不再需要的缓存和临时资源按运行时规则解除占用或回收。缓存池可以留在进程中供复用；这不等于内存清零、退还操作系统或所有物理字节立即消失。",
      "下一条请求可进入同一服务",
      "模型权重继续驻留",
      "请求占用解除；可复用资源留池",
      "结束请求 → 回收 / 后续复用",
      "前缀缓存等保留策略另受配置控制",
    ],
  ],
};
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const text = (x, y, value, size = 16, color = ink) =>
  `<text x="${x}" y="${y}" text-anchor="middle" fill="${color}" font-size="${size}" font-family="system-ui">${esc(value)}</text>`;
const box = (x, y, w, h, fill = "#303629", stroke = "#626b55") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}"/>`;
function draftDiagram(beat) {
  const tokens = ["d₁", "d₂", "d₃", "d₄", "d₅"];
  const tile = (value, i, y, fill, stroke = gold) =>
    box(245 + i * 115, y, 96, 55, fill, stroke) +
    text(293 + i * 115, y + 34, value, 20);
  return `<svg viewBox="0 0 1040 475" role="img" aria-label="候选验证与正式提交，第${beat + 1}拍">
    ${text(520, 33, "同一服务的DSpark逻辑分支 · 假设一次验证结果", 19)}
    ${text(115, 105, "待验证草稿", 16, muted)}${tokens.map((v, i) => tile(v, i, 73, "#34392d")).join("")}
    ${text(520, 162, "↓ 目标模型验证；候选尚未直接显示给用户", 15, gold)}
    ${text(115, 239, "验证结果", 16, muted)}${tokens.map((v, i) => tile(beat === 0 ? "等待" : v + (i < 2 ? " ✓" : i === 2 ? " ×" : " —"), i, 207, beat === 0 ? "#30352b" : i < 2 ? "#496047" : i === 2 ? "#704b38" : "#30352b")).join("")}
    ${text(520, 302, beat === 0 ? "尚未确认" : "↓ 连续接受前缀 + 拒绝位置产生校正token t₃", 16, gold)}
    ${text(115, 379, "正式推进", 16, muted)}${(beat < 2 ? ["等待确认"] : ["d₁", "d₂", "t₃"]).map((v, i) => tile(v, i, 347, beat < 2 ? "#30352b" : "#65542e")).join("")}
    ${text(520, 452, "灰色草稿不等于正式输出；图示不规定设备缓存如何逐字节回滚。", 13, muted)}</svg>`;
}
function diagram(scene, beat, frame) {
  if (scene === "dspark") return draftDiagram(beat);
  const [, , input, weights, state, compute, output] = frame;
  const sampling =
    (scene === "prefill" && beat === 2) || (scene === "decode" && beat > 0);
  const loaded =
    !["overview"].includes(scene) && !(scene === "load" && beat === 0);
  const request = !["overview", "load", "finish"].includes(scene);
  return `<svg viewBox="0 0 1040 475" role="img" aria-label="${esc(frame[0])}"><defs><marker id="journey-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="${gold}"/></marker></defs>
  ${box(160, 8, 720, 42, "#373a2e", gold)}${text(520, 35, input, 17)}
  <path d="M450 50V69H235V91" stroke="${gold}" fill="none" marker-end="url(#journey-arrow)"/><path d="M590 50V69H805V91" stroke="${gold}" fill="none" marker-end="url(#journey-arrow)"/>
  ${[30, 605].map((x, r) => `${box(x, 92, 405, 253, "#272d24")}${text(x + 202, 120, `Spark ${r ? "B" : "A"} · rank ${r}`, 22)}${text(x + 202, 141, r ? "协作进程 · 本机统一内存" : "HTTP入口 · 本机统一内存", 12, muted)}${box(x + 17, 154, 371, 45, loaded ? "#4b452c" : "#31352a", loaded ? gold : "#626b55")}${text(x + 202, 182, weights, 16, loaded ? gold : muted)}${box(x + 17, 211, 371, 45, request ? "#394a3a" : "#31352a")}${text(x + 202, 239, state, 14)}${box(x + 17, 268, 371, 57, request ? "#625030" : "#31352a", request ? gold : "#626b55")}${text(x + 202, 292, "本机计算 / 临时对象", 12, muted)}${text(x + 202, 313, sampling ? "本rank参与前向与输出头计算" : compute, 14)}`).join("")}
  <path d="M435 290H605" stroke="${request ? gold : "#626b55"}" stroke-width="2" fill="none" marker-start="${request ? "url(#journey-arrow)" : "none"}" marker-end="${request ? "url(#journey-arrow)" : "none"}"/>
  ${text(520, 267, request ? "结果张量协作" : scene === "finish" ? "互联保持 / 收尾" : "建立通信", 12, gold)}${text(520, 310, "不是共享内存", 11, muted)}
  ${sampling ? `<path d="M235 345V358H250M805 345V358H790" stroke="${gold}" fill="none"/><g>${box(250, 347, 540, 39, "#62502e", gold)}${text(520, 372, "逻辑采样 / 确认token（不指定物理采样rank）", 15)}</g><path d="M520 386V405" stroke="${gold}" marker-end="url(#journey-arrow)"/>${box(90, 406, 860, 42, "#41432e", gold)}${text(520, 432, `rank 0 HTTP入口返回客户端：${output}`, 14)}` : `<path d="M235 345V367H455V388" stroke="${gold}" fill="none" marker-end="url(#journey-arrow)"/><path d="M805 345V367H585V388" stroke="${gold}" fill="none" marker-end="url(#journey-arrow)"/>${box(130, 389, 780, 47, "#41432e", gold)}${text(520, 419, output, 17)}`}
  ${text(520, 461, "同一教学请求 · 状态文字表示逻辑处理范围，不是等大小的物理KV槽或设备trace。", 12, muted)}</svg>`;
}
function historyStrip(scene, beat) {
  if (!["prefill", "decode"].includes(scene)) return "";
  const count =
    scene === "prefill"
      ? beat === 0
        ? 0
        : 3
      : beat === 0
        ? 3
        : beat === 1
          ? 4
          : 5;
  const labels = [
    "x₀「算」",
    "x₁「力」",
    "x₂「？」",
    "y₀「计算」",
    "y₁「能力」",
  ];
  return `<div class="history-strip"><b>${scene === "prefill" && beat === 1 ? "本轮输入 · 各层逐步处理" : "本拍结束的逻辑已处理范围"}</b><div>${labels.map((v, i) => `<span class="${i < count ? "processed" : "pending"}">${v}<small>${i < count ? (scene === "prefill" && beat === 1 ? "当前层处理中" : "已处理 / 建立状态") : "尚未送回模型或未处理"}</small></span>`).join("")}</div><small>这里只标输入身份；物理状态按层和并行布局保存，不是一标签一缓存槽。</small></div>`;
}
export function mountJourney(host, scene, initial = 0, onChange = () => {}) {
  const frames = scenes[scene];
  if (!frames) return;
  let beat = Number.isFinite(initial)
    ? Math.max(0, Math.min(frames.length - 1, Math.trunc(initial)))
    : 0;
  const draw = () => {
    onChange(beat);
    const frame = frames[beat];
    host.innerHTML = `<div class="representative-head"><h3>${esc(frame[0])}</h3><p>${esc(frame[1])}</p></div><div class="representative-controls" role="group" aria-label="分拍查看"><button data-journey-prev ${beat === 0 ? "disabled" : ""}>←</button>${frames.map((f, i) => `<button data-beat="${i}" aria-pressed="${i === beat}" title="${esc(f[0])}">${i + 1}</button>`).join("")}<button data-journey-next ${beat === frames.length - 1 ? "disabled" : ""}>下一拍 →</button><span>同一请求 / ${beat + 1} 共 ${frames.length} 拍</span></div><div class="representative-canvas">${diagram(scene, beat, frame)}</div>${historyStrip(scene, beat)}<p class="journey-boundary">${scene === "dspark" ? "DSpark逻辑示意，不是候选验证的设备trace；不能据此推算吞吐。" : scene === "prefill" || scene === "decode" ? "已处理历史的范围 ≠ 实际缓存的形状。短例子没有达到近期窗口边界，不能据此声称发生了窗口淘汰。" : "教学文本、分词标签与输出均为人工示例。完整模型驻留和资源边界见下方展开。"}</p>`;
    host.querySelectorAll("[data-beat]").forEach(
      (b) =>
        (b.onclick = () => {
          beat = Number(b.dataset.beat);
          draw();
        }),
    );
    host.querySelector("[data-journey-prev]").onclick = () => {
      if (beat > 0) {
        beat--;
        draw();
      }
    };
    host.querySelector("[data-journey-next]").onclick = () => {
      if (beat < frames.length - 1) {
        beat++;
        draw();
      }
    };
  };
  draw();
}
