import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Text has one source. Diagrams are editorial views of that design, not runtime state.
const root = new URL('../', import.meta.url);
const require = createRequire(new URL('workbenches/creation/package.json', root));
const MarkdownIt = require('markdown-it');
const base = new URL('workbenches/creation/docs/workflows/', root);
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const palette = { paper: '#f6f5f0', ink: '#202620', green: '#296347', pale: '#edf4ee', muted: '#606b63', line: '#ccd6ca' };
const font = '-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif';
const text = (x, y, value, size = 18, fill = palette.ink, weight = 400, anchor = 'start') => `<text x="${x}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
function box(x, y, w, h, name, lines = [], kind = 'normal') {
  const fill = kind === 'focus' ? palette.green : kind === 'optional' ? palette.paper : '#ffffff';
  const ink = kind === 'focus' ? '#ffffff' : palette.ink;
  const detail = kind === 'focus' ? '#e3eee4' : palette.muted;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${kind === 'focus' ? palette.green : palette.line}" stroke-width="1.5"${kind === 'optional' ? ' stroke-dasharray="5 4"' : ''}/>`
    + text(x + 20, y + 32, name, 21, ink, 600)
    + lines.map((line, index) => text(x + 20, y + 60 + index * 24, line, 16, detail)).join('');
}
function route(points) {
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i], [px, py] = points[i - 1], [nx, ny] = points[i + 1];
    const r = Math.min(8, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const before = [x - Math.sign(x - px) * r, y - Math.sign(y - py) * r];
    const after = [x + Math.sign(nx - x) * r, y + Math.sign(ny - y) * r];
    d += ` L ${before[0]} ${before[1]} Q ${x} ${y} ${after[0]} ${after[1]}`;
  }
  return d + ` L ${points.at(-1)[0]} ${points.at(-1)[1]}`;
}
const arrow = (id, points, optional = false) => `<path d="${route(points)}" fill="none" stroke="${palette.green}" stroke-width="1.8"${optional ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#${id}-arrow)"/>`;
const label = (x, baseline, value) => {
  const width = value.length * 15 + 14;
  return `<rect x="${x - width / 2}" y="${baseline - 17}" width="${width}" height="24" rx="3" fill="${palette.paper}"/>${text(x, baseline, value, 15, palette.green, 500, 'middle')}`;
};
function figure(id, title, description, height, body, legend = '实线：主要流向　　虚线：按需触发或返回　　绿色：当前核心交接资产') {
  return `<figure id="figure-${id}"><div class="diagram-scroll" tabindex="0" aria-label="${esc(title)}，窄屏可横向滚动"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${height}" width="960" height="${height}" role="img" aria-labelledby="${id}-title ${id}-desc" style="min-width:960px"><title id="${id}-title">${esc(title)}</title><desc id="${id}-desc">${esc(description)}</desc><defs><marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="${palette.green}" stroke-width="1.5"/></marker></defs><rect width="960" height="${height}" fill="${palette.paper}"/>${body}<line x1="32" y1="${height - 58}" x2="928" y2="${height - 58}" stroke="${palette.line}"/>${text(32, height - 28, legend, 15, palette.muted)}</svg></div><figcaption><strong>${esc(title)}</strong> · ${esc(description)}</figcaption></figure>`;
}

const diagrams = {};
{
  const id = 'responsibilities';
  let body = text(32, 38, '同一份作品，三种质量责任；执行路线按实际需要选择', 22, palette.ink, 600);
  body += arrow(id, [[308, 137], [356, 137]]) + arrow(id, [[620, 137], [668, 137]]);
  body += arrow(id, [[748, 198], [748, 240], [488, 240], [488, 198]], true);
  body += arrow(id, [[428, 198], [428, 280], [160, 280], [160, 198]], true);
  body += label(606, 224, '表达问题返回') + label(290, 264, '承诺问题返回');
  body += box(44, 82, 264, 116, 'B1 内容定义', ['值得做什么，为谁做', '内容定义与证据边界']);
  body += box(356, 82, 264, 116, 'B2 创作与表达', ['实际讲什么，如何表达', '可审的正文、图文或声画']);
  body += box(668, 82, 248, 116, 'B3 制作与验证', ['实际成品是否成立', '当前完整资产与检查']);
  body += text(44, 348, '简单文字：一次写作与修订可同时覆盖 B2 / B3', 20, palette.ink, 600);
  body += arrow(id, [[308, 409], [356, 409]]);
  body += box(44, 372, 264, 88, '简要内容定义', ['沿用已确认背景']);
  body += box(356, 372, 560, 88, '实际写作 → 修订 → 最终正文检查', ['一个执行单元，保留表达与成品两种责任'], 'focus');
  body += text(44, 514, '媒体内容：在值得独立判断、复用或降低返工成本处拆开', 20, palette.ink, 600);
  body += arrow(id, [[308, 575], [356, 575]]) + arrow(id, [[620, 575], [668, 575]]);
  body += box(44, 538, 264, 88, '内容定义', ['价值、依据与可行路径']);
  body += box(356, 538, 264, 88, '实际表达草案', ['按需调用低成本原型']);
  body += box(668, 538, 248, 88, '制作与完整检查', ['成品可交付候选']);
  diagrams[id] = figure(id, '01 · 职责与执行单元', '下方是两条示例配置，不是每篇都要完成的三次批准。', 712, body, '实线：示例主流向　　虚线：按原因返回　　绿色：B2 / B3 合并执行示例');
}
{
  const id = 'b1';
  let body = text(32, 38, 'B1 把材料与机会转成一个有依据的创作决定', 22, palette.ink, 600);
  for (const y of [160, 296, 432, 568]) body += arrow(id, [[480, y], [480, y + 40]]);
  body += arrow(id, [[250, 508], [164, 508], [164, 248], [250, 248]], true);
  body += label(111, 380, '补依据');
  body += box(250, 64, 460, 96, '恢复当前上下文', ['目的、账号定位、材料、已有决定和限制']);
  body += box(250, 200, 460, 96, '只查关键未知', ['按需看需求 / 供给、材料和可行性']);
  body += box(250, 336, 460, 96, '形成内容定义', ['受众变化、承诺、证据用途和范围取舍']);
  body += box(250, 472, 460, 96, '挑战核心假设并修订', ['检查价值、问题前提、证据与兑现能力']);
  body += box(250, 608, 460, 120, '选择当前内容定义', ['推进、补充、调整或暂缓：保留理由', '记录版本与未知，交给实际创作'], 'focus');
  body += text(750, 221, '需要时可以并行', 17, palette.green, 600);
  body += text(750, 248, '不要求每篇做全套', 16, palette.muted);
  body += text(750, 493, '表达可行性不明', 17, palette.green, 600);
  body += text(750, 520, '可请求 B2 小样', 16, palette.muted);
  diagrams[id] = figure(id, '02 · B1 内容定义', '热度、账号与材料都服务于创作决定。已有主题可直接检查变化，事实前提仍须检验。', 808, body);
}
{
  const id = 'b2';
  let body = text(32, 38, 'B2 的交接物已经是观众可感知的内容', 22, palette.ink, 600);
  for (const y of [160, 296, 432, 568]) body += arrow(id, [[460, y], [460, y + 40]]);
  body += arrow(id, [[220, 376], [160, 376], [160, 248], [220, 248]], true);
  body += label(104, 324, '改表达');
  body += arrow(id, [[700, 228], [820, 228], [820, 268]], true);
  body += arrow(id, [[848, 364], [848, 400], [700, 400]], true);
  body += label(766, 211, '按需制作');
  body += box(220, 64, 480, 96, '选择本次最需要验证的表达', ['当前定义、证据、目的方法与载体要求']);
  body += box(220, 200, 480, 96, '产出真实草案', ['正文、代表图文、实际口播或声画设计']);
  body += box(748, 268, 184, 96, '媒介原型', ['看、听、试读'], 'optional');
  body += box(220, 336, 480, 96, '审实际内容', ['事实与表达检查；读者不预先得到答案']);
  body += box(220, 472, 480, 96, '按原因修订并完成适用全稿', ['修订 / 扩展后复验；主问题失败回 B1']);
  body += box(220, 608, 480, 120, '当前创作草案与制作依赖', ['简单文字可在此完成 B3 最终检查', '媒体内容交给完整制作与验证'], 'focus');
  diagrams[id] = figure(id, '03 · B2 创作与表达设计', '原型为消除不确定性而做。审阅通过的片段不能替代新增部分和完整作品检查。', 808, body);
}
{
  const id = 'b3';
  let body = text(32, 38, 'B3 记录真实制作、恢复和检查，最终交付实际成品', 22, palette.ink, 600);
  for (const y of [160, 296, 432, 568]) body += arrow(id, [[460, y], [460, y + 40]]);
  body += arrow(id, [[220, 508], [148, 508], [148, 252], [220, 252]], true);
  body += label(100, 382, '修制作');
  body += arrow(id, [[700, 368], [828, 368], [828, 412]], true);
  body += arrow(id, [[852, 508], [852, 552], [700, 552]], true);
  body += label(770, 351, '能力缺口');
  body += label(778, 584, '补齐后');
  body += box(220, 64, 480, 96, '确定制作与检查计划', ['当前草案、素材、规格、能力和授权']);
  body += box(220, 200, 480, 96, '执行实际工具步骤', ['记录输入、调用、结果与文件；支持恢复']);
  body += box(220, 336, 480, 96, '直接检查当前实际成品', ['适用技术检查 + 看、听、读的范围']);
  body += box(748, 412, 184, 96, '待检查交接', ['记录缺口与接续'], 'optional');
  body += box(220, 472, 480, 96, '修复、复验与判断去向', ['制作问题定向修；表达 / 承诺回上游']);
  body += box(220, 608, 480, 120, '当前可交付候选', ['完整资产、适用工程与当前版本检查', '接受、交付选择、公开发布另行记录'], 'focus');
  diagrams[id] = figure(id, '04 · B3 制作与成品验证', '等待外部检查时保留可恢复任务，未补足检查不进入可交付候选。正文中的分支条件优先于示例主线。', 808, body);
}
{
  const id = 'architecture';
  let body = text(32, 38, '全新 TypeScript 产品：交互、业务与持久执行分工', 22, palette.ink, 600);
  body += arrow(id, [[300, 152], [384, 152]]) + label(342, 135, '命令');
  body += arrow(id, [[384, 184], [300, 184]]) + label(342, 215, '投影');
  body += arrow(id, [[624, 152], [704, 152]]) + label(664, 135, '持久任务');
  body += arrow(id, [[824, 224], [824, 296], [502, 296], [502, 364]]) + label(663, 280, '领取后执行');
  body += arrow(id, [[164, 364], [164, 260], [424, 260], [424, 224]]) + label(290, 244, '按范围读取');
  body += arrow(id, [[632, 424], [704, 424]]) + label(668, 407, '调用');
  body += arrow(id, [[372, 424], [300, 424]]) + label(336, 407, '文件');
  body += box(32, 92, 268, 132, 'React / Vite 工作台', ['目标、当前资产、意见、变化', '安全合同与实际状态']);
  body += box(384, 92, 240, 132, 'Fastify / 应用服务', ['作品、版本与决定', '命令校验与安全查询']);
  body += box(704, 92, 224, 132, '独立 worker', ['领取、恢复、取消', '持久任务与等待事项']);
  body += box(704, 364, 224, 144, 'agent-workflow', ['agent / task / call', '执行账本与恢复内核', '通用缺口可修改']);
  body += box(372, 364, 260, 144, 'Creation 业务路线', ['B1 / B2 / B3 按需组合', '模型与媒体适配器', '实际创作 / 修订 / 验证'], 'focus');
  body += box(32, 364, 268, 144, '资产与协作依据', ['正文 / 媒体是内容真值', '目录：归属与当前选择', '账本：运行、意见与决定']);
  body += text(32, 570, '分开记录：定义　→　实际执行　→　作品质量　→　接受 / 交付 / 发布', 21, palette.green, 600);
  body += text(32, 606, '新实现不保留旧 UI / CLI 兼容层；历史资产与证据另行保全。此图不是已实现状态。', 17, palette.muted);
  diagrams[id] = figure(id, '05 · 全新产品与共享执行内核', '箭头表示主要关系，省略部分查询与登记连接。任务通过持久记录交接；worker 不驻留在 HTTP 请求里。', 712, body, '实线：标注的命令 / 调用 / 数据关系　　绿色：项目负责的业务组合');
}
{
  const id = 'workbench';
  let body = text(32, 38, '回到一份作品时，先恢复目标与当前资产，再决定下一步', 22, palette.ink, 600);
  body += `<rect x="32" y="72" width="896" height="628" rx="8" fill="#ffffff" stroke="${palette.line}"/>`;
  body += `<rect x="32" y="72" width="196" height="628" rx="8" fill="${palette.pale}"/>`;
  body += text(52, 111, '工作区 / 账号', 20, palette.green, 600);
  body += text(52, 148, '长期定位与渠道', 16, palette.muted);
  body += text(52, 212, '候选与进行中', 20, palette.ink, 600);
  body += text(52, 250, '当前作品', 17, palette.green, 600);
  body += text(52, 283, '暂缓 / 历史版本', 16, palette.muted);
  body += text(52, 630, '跨区复用有来源', 16, palette.muted);
  body += text(52, 657, '不继承原接受状态', 16, palette.muted);
  body += box(252, 92, 652, 120, '为什么做：当前内容定义', ['问题 / 受众变化 / 核心承诺 / 关键未知', '目的 × 载体；已有决定与当前版本'], 'focus');
  body += box(252, 236, 652, 96, '实际路线与状态', ['显示真正执行的步骤、合并职责、等待原因；旧资产可无 run']);
  body += box(252, 356, 376, 176, '当前实际资产', ['正文 / 图文 / 声音 / 视频', '已检查的版本与范围', '点击意见定位到对应资产', '来源和旧版本按需展开']);
  body += box(648, 356, 256, 176, '意见与变化', ['谁提出了什么', '改了什么，为什么', '受影响的下游', '复验与范围决定']);
  body += box(252, 556, 652, 120, '下一步', ['继续创作 / 补充依据 / 修改 / 等待具体检查', '明确当前版本、投入与授权；刷新不会触发运行']);
  diagrams[id] = figure(id, '06 · 工作台信息结构草图', '这是待实施的页面结构，不是当前界面截图。首屏服务用户接续；运行细节在需要时展开。', 784, body, '绿色：先恢复的创作上下文　　白色：资产、协作与动作区域　　不表示真实运行状态');
}

const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });
const toc = [];
const defaultHeading = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.tag === 'h2') {
    const title = tokens[idx + 1].content;
    const id = `section-${toc.length + 1}`;
    token.attrSet('id', id);
    toc.push({ id, title });
  }
  return defaultHeading ? defaultHeading(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};
let source = await readFile(new URL('creation-platform-design.md', base), 'utf8');
source = source.replace(/<!-- diagram:([\w-]+) -->/g, (_, id) => {
  if (!diagrams[id]) throw new Error(`Unknown diagram: ${id}`);
  return diagrams[id];
});
const body = markdown.render(source).replaceAll('<table>', '<div class="table-scroll"><table>').replaceAll('</table>', '</table></div>');
const nav = toc.map(({ id, title }) => `<a href="#${id}">${esc(title)}</a>`).join('');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Creation · 创作工作流与工作台设计</title><style>
:root{color-scheme:light;--paper:#f6f5f0;--ink:#202620;--green:#296347;--muted:#606b63;--line:#ccd6ca}*{box-sizing:border-box}html{scroll-behavior:auto;scroll-padding-top:24px}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}a{color:var(--green);text-underline-offset:4px}a:focus-visible,summary:focus-visible,.diagram-scroll:focus-visible{outline:3px solid var(--green);outline-offset:4px}.layout{max-width:1432px;margin:auto;padding:40px 28px 80px;display:grid;grid-template-columns:224px minmax(0,1fr);gap:36px}aside{position:sticky;top:24px;align-self:start;max-height:92vh;overflow:auto}aside p{font-size:13px;letter-spacing:.08em;color:var(--muted)}nav a{display:block;text-decoration:none;font-size:14px;line-height:1.6;padding:8px 8px;border-left:2px solid var(--line)}nav a:hover{background:#edf4ee;border-color:var(--green)}.source{display:block;font-size:13px;margin:24px 8px}main{min-width:0;background:#fff;border:1px solid #d9dfd6;border-radius:10px;padding:36px 32px}h1{font-size:clamp(29px,3.3vw,44px);line-height:1.3;letter-spacing:-.02em;margin:4px 0 28px;max-width:850px}h2{font-size:28px;line-height:1.45;margin:68px 0 22px;padding-top:24px;border-top:1px solid var(--line);scroll-margin-top:20px}h3{font-size:21px;margin:32px 0 12px}p{margin:15px 0}blockquote{margin:24px 0;padding:4px 20px;border-left:3px solid var(--green);background:#f4f7f1;color:#465548;font-size:15px}li{margin:10px 0}strong{font-weight:650}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.84em;overflow-wrap:anywhere;background:#f2f4ef;padding:2px 4px;border-radius:3px}pre{padding:22px;background:#f2f4ef;border-radius:8px;overflow:auto;line-height:1.6}pre code{padding:0;white-space:pre;font-size:13px;overflow-wrap:normal}.table-scroll{overflow-x:auto;margin:24px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.75;min-width:680px}th,td{text-align:left;vertical-align:top;padding:14px 12px;border-bottom:1px solid #dce2d8}th{background:#edf4ee;font-weight:650}td:first-child{min-width:116px}tr:nth-child(even){background:#fafbf8}figure{margin:28px 0 36px;border:1px solid #d9dfd6;border-radius:8px;background:var(--paper);overflow:clip}.diagram-scroll{overflow-x:auto;max-width:100%;padding:0}svg{display:block;width:100%;height:auto}figcaption{padding:16px 24px;border-top:1px solid var(--line);font-size:14px;line-height:1.8;color:#536156}footer{margin:45px 0 0;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}@media(max-width:1100px){.layout{display:block;padding:20px 16px 60px}aside{position:static;max-height:none;margin-bottom:24px}nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.source{margin:16px 8px}main{padding:24px 20px}}@media(max-width:600px){nav{grid-template-columns:1fr}h2{font-size:24px}main{padding:20px 16px}figure{margin-inline:-4px}body{font-size:16px}ul,ol{padding-left:22px}}@media print{body{background:#fff;font-size:11pt}.layout{display:block;padding:0}aside{display:none}main{border:0;padding:0}h2{break-before:auto;margin-top:30px}figure{break-inside:avoid;overflow:visible}.diagram-scroll,.table-scroll{overflow:visible}svg{min-width:0!important;width:100%!important;height:auto}table{min-width:0;font-size:9pt}a{color:inherit}pre{white-space:pre-wrap}pre code{white-space:pre-wrap}footer{font-size:9pt}}
</style></head><body><div class="layout"><aside><p>CREATOR LAB · 设计与迁移</p><nav aria-label="报告目录">${nav}</nav><a class="source" href="creation-platform-design.md">文字正本 ↗</a><a class="source" href="../../README.md">当前能力与运行说明 ↗</a></aside><main>${body}<footer>文字来源：creation-platform-design.md · 图与页面由根脚本统一生成 · 本页离线可读，无外部字体或运行脚本。<br>图示是候选设计，不是执行证据；实施状态以本文第 12 节为准。</footer></main></div></body></html>`;
await writeFile(new URL('creation-platform-design.html', base), html);
console.log(`Built creation-platform-design.html (${toc.length} sections, ${Object.keys(diagrams).length} diagrams).`);
