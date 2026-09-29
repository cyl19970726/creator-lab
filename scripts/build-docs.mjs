import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const sections = [
  ['research', '研究工作台', '对齐问题 → 研究与综合 → 图文报告与审阅', '沿用 research-workbench：研究问题、来源、图文报告、意见与修订。', 'React / Vite · Fastify · SQLite · 独立 worker', ['research', 'research-roles']],
  ['analysis', '分析工作台', '单帖分析 + 单博主分析', '沿用 self-media：单帖的内容还原、编导逻辑、画面与剪辑，以及博主内容系统归纳。', 'React / Vite · Express · SQLite · 分析 worker', ['analysis-post', 'analysis-creator']],
  ['creation', '创作工作台', '全新实现设计 · B1 / B2 / B3 按职责组合', '新文章路线已连接 TypeScript、React/Vite、Fastify 与独立 worker，通过共享 agent-workflow 执行创作和审阅。下图保留历史视频方法；完整目标、实际实现范围与待办见新设计。', 'TypeScript / React / API / worker', ['creation-stages', 'creation']],
];
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const content = await Promise.all(sections.map(async ([id, title, stages, description, stack, flows]) => {
  const diagrams = await Promise.all(flows.map(async (flow, i) => {
    const text = escape(await readFile(new URL(`docs/flows/${flow}.mmd`, root), 'utf8'));
    const title = flow === 'research-roles' ? '研究角色与方法（原图）' : flow === 'analysis-post' ? '单帖流程' : flow === 'analysis-creator' ? '博主流程' : '核心阶段';
    const figure = `<h3>${title}</h3><pre class="mermaid">${text}</pre>`;
    return i > 0 && id !== 'analysis' ? `<details><summary>${id === 'research' ? '展开原有研究角色图' : '展开原有设计、样片与复验图'}</summary>${figure}</details>` : figure;
  }));
  const designLink = id === 'creation' ? '<p><a href="../workbenches/creation/docs/workflows/creation-platform-design.html">新创作平台：完整设计、六张图与迁移计划 →</a></p>' : '';
  return `<section id="${id}"><p class="eyebrow">${id.toUpperCase()}</p><h2>${title}</h2><p class="stages">${stages}</p><p>${description}</p>${designLink}${diagrams.join('')}<p class="stack">${stack}</p><a href="../workbenches/${id}/README.md">使用说明与迁移边界 →</a></section>`;
}));
const bundled = await build({stdin: {contents: 'import mermaid from "mermaid"; mermaid.initialize({startOnLoad:true,securityLevel:"strict",theme:"neutral",flowchart:{useMaxWidth:true,htmlLabels:true}});', resolveDir: root.pathname}, bundle:true, write:false, format:'iife', minify:true});
await mkdir(new URL('docs/', root), {recursive:true});
await writeFile(new URL('docs/index.html', root), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Creator Lab · 三个工作台</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f5f0;color:#202620;font:17px/1.75 system-ui,-apple-system,sans-serif}main{max-width:1120px;margin:auto;padding:55px 28px}h1{font-size:42px;margin:0}h2{font-size:30px;margin:0 0 8px}h3{font-size:18px;margin-top:30px}p{max-width:880px}a{color:#296347}nav{display:flex;gap:25px;flex-wrap:wrap;margin:30px 0 45px;padding:16px 0;border-block:1px solid #ccd2c9}section{background:white;border:1px solid #d9dfd6;border-radius:8px;padding:32px;margin:28px 0}.eyebrow{font-size:13px;letter-spacing:.12em;color:#51705a;margin:0 0 5px}.stages{font-size:20px;font-weight:600}.stack,footer{font-size:14px;color:#5f6a61}.mermaid{margin:24px 0;overflow-x:auto;white-space:pre-wrap;background:#fafbf8;padding:20px}.mermaid svg{height:auto}summary{cursor:pointer;color:#296347}footer{padding:15px 0 40px}@media(max-width:650px){main{padding:25px 16px}h1{font-size:32px}section{padding:20px}.mermaid{padding:6px}.mermaid svg{min-width:640px}}
</style></head><body><main><header><p class="eyebrow">CREATOR LAB</p><h1>三个现有工作台，迁到一个仓库。</h1><p>研究、分析、创作各自独立。研究与分析保留原流程；创作按新设计重建，三者通过明确材料与资产协作。</p></header><nav><a href="#research">研究工作台</a><a href="#analysis">分析工作台</a><a href="#creation">创作工作台</a></nav>${content.join('')}<footer>研究与创作图摘自原 research-shared-context 报告；创作入口调整为可独立输入。分析图按现有代码阶段绘制。图示说明流程，不代表模型运行已全部通过。<br><a href="flows/README.md">图的来源</a> · <a href="migration.md">本次迁移记录</a> · <a href="../README.md">仓库使用说明</a></footer></main><script>${bundled.outputFiles[0].text.replace(/[ \t]+$/gm, '').replaceAll('</script', '<\\/script')}</script></body></html>`);
console.log('Built docs/index.html from existing workflow diagrams.');
