import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

/**
 * Renders the repository's Markdown docs into one browsable site at docs/site/ (git-ignored).
 * Markdown stays the source; this only adds navigation, diagrams and link checking.
 *   pnpm docs:build && pnpm docs:serve   →  http://127.0.0.1:4340/docs/site/index.html
 * Links between .md pages become links between .html pages; links to other repository files point at
 * the file itself, so serve the repository root. Any broken internal link or anchor fails the build.
 */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, 'docs/site');

/** Reading order: [source, level, sidebar label]. Level 1 entries are indented under the entry above them. */
const NAV = [
  { title: 'Creator Lab', pages: [['docs/README.md', 0, '导览'], ['docs/overview.md', 0, '三个工作台'], ['README.md', 0, '仓库使用说明'], ['docs/migration.md', 0, '迁移记录']] },
  { title: 'Agent Workflow', pages: [['vendor/agent-workflow/docs/documentation.md', 0, '产品全貌与任务导览'], ['vendor/agent-workflow/README.md', 0, '仓库与运行说明']], folders: [
    { title: "产品目标与原则", overview: ["vendor/agent-workflow/docs/product.md", "目标、原则与正式定义"], pages: [
    ] },
    { title: "产品架构", overview: ["vendor/agent-workflow/docs/product-architecture.md", "对象、责任与生命周期"], pages: [
    ] },
    { title: "前端与交互设计", overview: ["vendor/agent-workflow/docs/interaction-design.md", "交互设计导览"], pages: [
      ["vendor/agent-workflow/docs/workbench-presentation.md", "正式交互合同"],
      ["vendor/agent-workflow/docs/archify-viewer.md", "Archify 查看器使用"],
      ["docs/product-design/README.md", "设计方案导览"],
      ["docs/product-design/layout.md", "整体布局推导"],
      ["docs/product-design/wireframes.md", "十二张页面线框"],
      ["docs/product-design/decisions-and-states.md", "关键决定与状态"],
      ["docs/product-design/walkthroughs.md", "场景走查"],
    ] },
    { title: "系统技术架构", overview: ["vendor/agent-workflow/docs/architecture.md", "总览：一次业务怎样穿过系统"], pages: [
      ["vendor/agent-workflow/docs/workflow-spaces.md", "1. Space、schema 与节点合同"],
      ["vendor/agent-workflow/docs/workflow-process-assets.md", "2. 方法、执行与资产关系"],
      ["vendor/agent-workflow/docs/postgres-sdk-plan.md", "3. 执行 harness 与执行器"],
      ["vendor/agent-workflow/docs/storage-architecture.md", "4. 存储与一致性"],
      ["vendor/agent-workflow/docs/space-frontend-architecture.md", "5. 工作台与 API"],
    ] },
    { title: "工作流设计与调优", overview: ["vendor/agent-workflow/docs/workflow-practice.md", "从首版到持续服务"], pages: [
      ["vendor/agent-workflow/docs/designing-workflows.md", "设计方法"],
      ["vendor/agent-workflow/docs/evaluating-workflows.md", "评价与稳定窗口复盘"],
      ["vendor/agent-workflow/docs/optimizing-workflows.md", "诊断、候选与采用"],
      ["vendor/agent-workflow/docs/tuning-loop.md", "一轮调优操作"],
    ] },
    { title: "使用与开发接入", overview: ["vendor/agent-workflow/docs/usage-and-integration.md", "接入任务导览"], pages: [
      ["vendor/agent-workflow/docs/getting-started.md", "快速开始"],
      ["vendor/agent-workflow/docs/operator-cli.md", "最小只读 Operator CLI"],
      ["vendor/agent-workflow/docs/writing-workflows.md", "编写工作流与 API"],
      ["vendor/agent-workflow/docs/codex-and-skills.md", "Codex 与 Skills"],
      ["vendor/agent-workflow/packages/agent-sdk/README.md", "官方 Agents SDK 执行器"],
      ["vendor/agent-workflow/docs/space-storage.md", "Space 服务与运行接入"],
      ["vendor/agent-workflow/docs/postgres-storage.md", "PG 执行账本"],
      ["vendor/agent-workflow/docs/integration.md", "宿主集成"],
      ["vendor/agent-workflow/docs/frontend-integration.md", "前端读模型"],
    ] },
    { title: "建设状态与路线", overview: ["vendor/agent-workflow/docs/harness-roadmap.md", "唯一实现状态与缺口"], pages: [
      ["vendor/agent-workflow/docs/space-frontend-implementation-plan.md", "分批实施与验收安排"],
    ] },
    { title: "认知方法与设计依据", overview: ["docs/product-understanding.md", "推导、检验与修正"], pages: [
      ["docs/product-understanding/goals-and-paradigm.md", "目标与范式的推导"],
      ["docs/product-understanding/lifecycle-and-methods.md", "方法形成与生命周期论证"],
      ["docs/product-understanding/responsibilities-and-objects.md", "场景、责任与对象论证"],
      ["docs/product-understanding/decisions-and-evidence.md", "判断与证据"],
      ["docs/product-understanding/learning-and-dogfood.md", "调优与 Dogfood 分流"],
      ["docs/product-understanding/review-and-validation.md", "认知审阅与验证"],
      ["docs/documentation-architecture.md", "文档架构依据与实施"],
    ] },
    { title: "历史与验证证据", overview: ["vendor/agent-workflow/docs/history-and-evidence.md", "历史与证据导览"], pages: [
      ["vendor/agent-workflow/docs/harness-roadmap-history-2026-10-09.md", "10-09 建设路线历史快照"],
      ["vendor/agent-workflow/docs/cognition-execution-loop.md", "认知实用审查"],
      ["vendor/agent-workflow/docs/workbench-implementation-2026-10-05.md", "10-05 页面交付"],
      ["vendor/agent-workflow/docs/workbench-method-implementation-2026-10-05.md", "10-05 方法图交付"],
      ["vendor/agent-workflow/docs/workbench-process-implementation-2026-10-05.md", "10-05 过程资产交付"],
      ["vendor/agent-workflow/docs/workbench-process-implementation-plan-2026-10-05.md", "过程资产原计划"],
      ["vendor/agent-workflow/docs/workbench-execution-implementation-2026-10-06.md", "10-06 执行管理交付"],
      ["vendor/agent-workflow/docs/workbench-validation-implementation-2026-10-06.md", "10-06 验证比较交付"],
      ["vendor/agent-workflow/docs/workbench-validation-plan-2026-10-06.md", "验证比较原计划"],
      ["vendor/agent-workflow/docs/archify-integration-plan.md", "Archify 接入记录"],
      ["vendor/agent-workflow/docs/skill-package-verification.md", "Skill 包加载验证"],
      ["docs/product-design/prototype-round.md", "历史原型与走查"],
      ["vendor/agent-workflow/docs/architecture-history-2026-10-10.md", "架构整理前：系统总览"],
      ["vendor/agent-workflow/docs/workflow-spaces-history-2026-10-10.md", "架构整理前：Space合同"],
      ["vendor/agent-workflow/docs/workflow-process-assets-history-2026-10-10.md", "架构整理前：流程与资产"],
      ["vendor/agent-workflow/docs/postgres-sdk-plan-history-2026-10-10.md", "架构整理前：执行与SDK"],
      ["vendor/agent-workflow/docs/storage-architecture-history-2026-10-10.md", "架构整理前：存储"],
      ["vendor/agent-workflow/docs/space-frontend-architecture-history-2026-10-10.md", "架构整理前：前端"],
      ["vendor/agent-workflow/docs/space-storage-history-2026-10-10.md", "架构整理前：Space接入"],
    ] },
  ] },
  { title: '创作工作台', pages: [
    ['workbenches/creation/docs/README.md', 0, '导览'],
    ['workbenches/creation/docs/01-principles.md', 0, '核心思想'],
    ['workbenches/creation/docs/02-product.md', 0, '产品'],
    ['workbenches/creation/docs/03-architecture/README.md', 0, '架构'],
    ['workbenches/creation/docs/03-architecture/runtime-options-report.md', 1, '接入共享底座'],
    ['workbenches/creation/docs/03-architecture/business-workbench.md', 1, '本地原型与运行'],
    ['workbenches/creation/docs/workbench-implementation-plan.md', 1, '接入计划与差距'],
    ['workbenches/creation/docs/03-architecture/brief-and-handoff.md', 1, '作品档案与交接'],
    ['workbenches/creation/docs/03-architecture/article-app.md', 1, '文章应用合同'],
    ['workbenches/creation/docs/04-workflows/README.md', 0, '工作流'],
    ['workbenches/creation/docs/04-workflows/content.md', 1, '内容迭代'],
    ['workbenches/creation/docs/04-workflows/b1.md', 1, '历史 B1 定题'],
    ['workbenches/creation/docs/04-workflows/b2.md', 1, '历史 B2 成稿'],
    ['workbenches/creation/docs/04-workflows/b3.md', 1, 'B3 成片'],
    ['workbenches/creation/docs/04-workflows/after-publish.md', 1, '发布后'],
    ['workbenches/creation/docs/04-workflows/skills-map.md', 1, '创作方法 skills'],
    ['workbenches/creation/docs/05-tuning.md', 0, '调优手册'],
    ['workbenches/creation/docs/06-decisions.md', 0, '决策与历史'],
    ['workbenches/creation/docs/archive/README.md', 0, '归档'],
    ['workbenches/creation/docs/archive/creation-platform-design-v0.3.md', 1, '平台设计 v0.3'],
    ['workbenches/creation/docs/archive/article-platform-first-pr.md', 1, '文章平台首个 PR'],
    ['workbenches/creation/docs/archive/video-method.md', 1, '旧视频方法'],
    ['workbenches/creation/docs/archive/migration-from-token-economics.md', 1, '迁入记录'],
    ['workbenches/creation/README.md', 0, '工作台 README'],
  ] },
  { title: '研究与分析工作台', pages: [
    ['workbenches/research/README.md', 0, '研究工作台'],
    ['workbenches/research/docs/architecture.md', 1, '架构'],
    ['workbenches/research/docs/development.md', 1, '开发'],
    ['workbenches/research/docs/storage.md', 1, '存储'],
    ['workbenches/analysis/README.md', 0, '分析工作台'], ['workbenches/analysis/docs/storage-execution-migration.md', 1, '存储与执行迁移'],
    ['workbenches/analysis/docs/postgres-discovery-20261010.md', 1, 'PostgreSQL 接入调查'],
    ['workbenches/analysis/docs/agent-sdk-discovery-20261010.md', 1, 'Agent SDK 接入调查'],
    ['workbenches/analysis/docs/official-agents-sdk-migration.md', 1, '官方 SDK 迁移与验收'],
    ['workbenches/analysis/docs/postgres-sdk-retirement-20261012.md', 1, 'PostgreSQL 与官方 SDK 验收'],
  ] },
];

const SPECIAL_OUTPUT = { 'docs/README.md': 'index.html', 'README.md': 'repository.html' };
const outputOf = source => SPECIAL_OUTPUT[source]
  ?? source.replace(/(^|\/)README\.md$/, '$1index.html').replace(/\.md$/, '.html');

const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** GitHub-style heading ids, so anchors written for GitHub also work here. */
function slugger() {
  const seen = new Map();
  return text => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

const md = new MarkdownIt({ html: true, linkify: true });
md.core.ruler.push('heading_ids', state => {
  const slug = slugger();
  state.tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return;
    const text = state.tokens[index + 1].children.filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content).join('');
    token.attrSet('id', slug(text));
  });
});

const pages = NAV.flatMap(group => [
  ...group.pages.map(([source, level, label]) => ({ source, level, label, group: group.title })),
  ...(group.folders ?? []).flatMap(folder => [
    { source: folder.overview[0], level: 0, label: folder.overview[1], group: group.title, folder: folder.title },
    ...folder.pages.map(([source, label]) => ({ source, level: 1, label, group: group.title, folder: folder.title })),
  ]),
]);
const pageBySource = new Map(pages.map(page => [page.source, page]));
const problems = [];

// Pass 1: read every page, its title and its heading ids.
for (const page of pages) {
  const file = path.join(root, page.source);
  if (!existsSync(file)) { problems.push(`missing page in NAV: ${page.source}`); continue; }
  page.markdown = await readFile(file, 'utf8');
  const tokens = md.parse(page.markdown, {});
  page.ids = new Set(tokens.filter(t => t.type === 'heading_open').map(t => t.attrGet('id')));
  // Explicit anchors keep existing deep links valid when a section is reorganized.
  for (const token of tokens) {
    const htmlTokens = [token, ...(token.children ?? [])];
    for (const item of htmlTokens) {
      if (item.type !== 'html_block' && item.type !== 'html_inline') continue;
      for (const match of item.content.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
        page.ids.add(match[1] ?? match[2]);
      }
    }
  }
  const h1 = tokens.findIndex(t => t.type === 'heading_open' && t.tag === 'h1');
  page.title = h1 >= 0 ? tokens[h1 + 1].content : path.basename(page.source, '.md');
}
if (problems.length) fail();

/** Where a link written in `page` should point on the site, or a problem. */
function resolveLink(page, href) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return { href };
  const [target, hash = ''] = href.split('#');
  if (!target) {
    if (hash && !page.ids.has(decodeURIComponent(hash))) return { problem: `missing anchor #${hash}` };
    return { href };
  }
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), decodeURIComponent(target)));
  const linked = pageBySource.get(repoPath) ?? pageBySource.get(path.posix.join(repoPath, 'README.md'));
  const fromDir = path.posix.dirname(outputOf(page.source));
  if (linked) {
    if (hash && !linked.ids.has(decodeURIComponent(hash))) return { problem: `missing anchor ${repoPath}#${hash}` };
    return { href: `${path.posix.relative(fromDir, outputOf(linked.source)) || path.posix.basename(outputOf(linked.source))}${hash ? `#${hash}` : ''}` };
  }
  if (!existsSync(path.join(root, repoPath))) return { problem: `broken link: ${repoPath}` };
  // Documentation pages must be in the site; other Markdown (skills, method bundles) is linked as a raw file.
  if (/(^|\/)(docs\/.*|README)\.md$/.test(repoPath)) return { problem: `linked page is not in the site NAV: ${repoPath}` };
  // Other repository files are served as-is from the repository root.
  return { href: `/${repoPath}${hash ? `#${hash}` : ''}` };
}

const defaultLink = md.renderer.rules.link_open ?? ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const resolved = resolveLink(env.page, tokens[i].attrGet('href'));
  if (resolved.problem) problems.push(`${env.page.source}: ${resolved.problem}`);
  else tokens[i].attrSet('href', resolved.href);
  return defaultLink(tokens, i, options, env, self);
};
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, i, options, env, self) => {
  const resolved = resolveLink(env.page, tokens[i].attrGet('src'));
  if (resolved.problem) problems.push(`${env.page.source}: image ${resolved.problem}`);
  else tokens[i].attrSet('src', resolved.href);
  return defaultImage(tokens, i, options, env, self);
};
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, i, options, env, self) => tokens[i].info.trim() === 'mermaid'
  ? `<pre class="mermaid">${escapeHtml(tokens[i].content)}</pre>\n`
  : defaultFence(tokens, i, options, env, self);
md.renderer.rules.table_open = () => '<div class="table"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

const CSS = `
:root{--bg:#f7f6f2;--panel:#fff;--text:#1f2420;--muted:#5d665f;--line:#dcdfd8;--accent:#2b6a4a;--code:#f0f1ec;--active:#e4efe8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161917;--panel:#1d211e;--text:#e3e7e2;--muted:#9aa39c;--line:#333a35;--accent:#7cc4a0;--code:#252a26;--active:#26352c}}
:root[data-theme="dark"]{--bg:#161917;--panel:#1d211e;--text:#e3e7e2;--muted:#9aa39c;--line:#333a35;--accent:#7cc4a0;--code:#252a26;--active:#26352c}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.75 system-ui,-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif}
a{color:var(--accent)}
.layout{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
.sidebar{border-right:1px solid var(--line);padding:24px 18px;position:sticky;top:0;height:100vh;overflow-y:auto;font-size:14px;line-height:1.5}
.brand{display:block;font-weight:700;font-size:15px;color:var(--text);text-decoration:none;margin-bottom:18px}
.group{margin:0 0 18px}.group>p{margin:0 0 6px;font-size:12px;letter-spacing:.08em;color:var(--muted)}
.group a{display:block;padding:4px 8px;border-radius:5px;color:var(--text);text-decoration:none}
.group a.l1{padding-left:22px;color:var(--muted)}
.group details{margin:2px 0}.group summary{padding:4px 8px;border-radius:5px;color:var(--text);cursor:pointer;list-style-position:inside}
.group summary:hover{background:var(--active)}.group details a{padding-left:25px}.group details a.l1{padding-left:39px}
.group a:hover{background:var(--active)}.group a.current{background:var(--active);color:var(--accent);font-weight:600}
main{padding:40px 48px 60px;max-width:960px;width:100%}
article h1{font-size:30px;line-height:1.3;margin:0 0 20px}
article h2{font-size:22px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}
article h3{font-size:18px;margin:28px 0 8px}
article p,article li{max-width:46em}
article img{max-width:100%;height:auto}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.9em}
pre{background:var(--code);padding:14px 16px;border-radius:6px;overflow-x:auto;font-size:13.5px;line-height:1.55}
pre code{background:none;padding:0}
pre.mermaid{background:var(--panel);border:1px solid var(--line);text-align:center}
.table{overflow-x:auto;margin:16px 0}
table{border-collapse:collapse;font-size:14.5px;line-height:1.6;min-width:60%}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--code)}
td:first-child,th:first-child{min-width:5.5em}
blockquote{margin:16px 0;padding:4px 16px;border-left:3px solid var(--accent);color:var(--muted)}
footer{margin-top:48px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.menu{display:none}
@media (max-width:860px){
 .layout{display:block}
 .sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px}
 .sidebar nav{display:none}.sidebar.open nav{display:block;margin-top:12px}
 .menu{display:inline-block;float:right;background:none;border:1px solid var(--line);border-radius:5px;color:var(--text);padding:2px 10px;font:inherit}
 .brand{display:inline-block;margin:0}
 main{padding:20px 16px 40px}
 article h1{font-size:25px}
}`;

function nav(current) {
  const fromDir = path.posix.dirname(outputOf(current.source));
  const link = (source, label, level = 0) => {
    const page = pageBySource.get(source);
    const href = path.posix.relative(fromDir, outputOf(source)) || path.posix.basename(outputOf(source));
    const isCurrent = source === current.source;
    return `<a class="l${level}${isCurrent ? ' current' : ''}" href="${href}"${isCurrent ? ' aria-current="page"' : ''}>${escapeHtml(label ?? page.title)}</a>`;
  };
  return NAV.map(group => `<div class="group"><p>${escapeHtml(group.title)}</p>${group.pages.map(([source, level, label]) => link(source, label, level)).join('')}${(group.folders ?? []).map(folder => {
    const folderSources = [folder.overview[0], ...folder.pages.map(([source]) => source)];
    const open = folderSources.includes(current.source) ? ' open' : '';
    return `<details${open}><summary>${escapeHtml(folder.title)}</summary>${link(...folder.overview)}${folder.pages.map(([source, label]) => link(source, label, 1)).join('')}</details>`;
  }).join('')}</div>`).join('');
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'assets'), { recursive: true });
await copyFile(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), path.join(out, 'assets/mermaid.min.js'));

for (const page of pages) {
  const body = md.render(page.markdown, { page });
  const target = path.join(out, outputOf(page.source));
  const toRoot = path.posix.relative(path.posix.dirname(outputOf(page.source)), '.') || '.';
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(page.title === 'Creator Lab 文档' ? page.title : `${page.title} · Creator Lab 文档`)}</title><style>${CSS}</style></head>
<body><div class="layout"><aside class="sidebar"><a class="brand" href="${toRoot}/index.html">Creator Lab 文档</a><button class="menu" onclick="this.parentNode.classList.toggle('open')">目录</button><nav>${nav(page)}</nav></aside>
<main><article>${body}</article><footer>源文件：<a href="/${page.source}">${page.source}</a> · 由 <code>pnpm docs:build</code> 生成</footer></main></div>
<script src="${toRoot}/assets/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true,securityLevel:'strict',theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'neutral',flowchart:{useMaxWidth:true,htmlLabels:true}});</script>
</body></html>\n`);
}
if (problems.length) fail();
console.log(`Built ${pages.length} pages into docs/site/. Serve the repository root: pnpm docs:serve → http://127.0.0.1:4340/docs/site/index.html`);

function fail() {
  console.error(`Documentation site has ${problems.length} problem(s):\n${problems.map(p => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
