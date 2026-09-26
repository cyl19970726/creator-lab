export function mountCache(target) {
  let n = 126;
  const draw = () => {
    target.innerHTML = `<summary>长输入补充：第127–129个token时，窗口和压缩状态怎样变化？</summary><div class="cache-example"><p>独立边界示例：假设已有126个输入token，继续处理到129。不是把上面的3-token短请求冒充长上下文，也不表示每层都采用相同压缩率。</p><div class="representative-controls">${[126, 127, 128, 129].map((x) => `<button data-cache="${x}" aria-pressed="${n === x}">累计 ${x}</button>`).join("")}</div><div class="cache-lanes"><section><b>近期窗口 · 最近128个位置</b><div class="cache-window ${n === 129 ? "shifted" : ""}"><span>${n === 129 ? "窗口左边界向前移" : "尚未超过窗口"}</span><strong>${n === 128 ? "1 … 128" : n === 129 ? "最近128个位置" : `1 … ${n}`}</strong></div><small>${n === 129 ? "最旧位置离开近期窗口，不等于更长历史贡献被删除或物理块立刻释放。" : "这里展示逻辑窗口；还未发生跨128边界的推进。"}</small></section><section><b>压缩层 · 与近期窗口同时存在</b><div class="cache-compression ${n === 128 ? "active" : ""}">${n === 128 ? "部分状态 → 新压缩表示" : n === 129 ? "新一组开始积累部分状态" : "部分状态继续积累，等待分组边界"}</div><small>ratio=4层与ratio=128层在第128个位置都达到各自边界；它们是不同层的例子。4倍压缩存在重叠处理，不是把4项简单求平均。</small></section></div><p>压缩的是数值表示，不是中文摘要；图中不计算物理槽数、字节或立即释放量。第129步开始下一组积累，已经得到的长历史压缩表示可以继续保留。</p></div>`;
    target.querySelectorAll("[data-cache]").forEach(
      (b) =>
        (b.onclick = () => {
          n = Number(b.dataset.cache);
          draw();
          target.open = true;
        }),
    );
  };
  draw();
}
