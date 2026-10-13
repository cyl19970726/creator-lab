import { fixture as f } from './fixture.mjs';

const storageKey = 'creator-lab-workflow-prototype-01';
const byId = (items, id) => items.find(item => item.id === id);
const version = id => byId(f.versions, id) || f.versions[0];
const run = id => byId(f.runs, id);
const asset = id => byId(f.assets, id);
const caseItem = id => byId(f.cases, id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const freshState = () => ({ requests: [], supplements: {}, decisions: [], draft: null });
let saved;
try { saved = { ...freshState(), ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; } catch { saved = freshState(); }
let route;
const navExpansion = { workflow: true, current: true };
let noticeTimer;
const pageTitles = { goal: '设计目标与改动', versions: '版本总览', method: '方法与产出图', cases: '案例与资产', evaluation: '评价与分析', tuning: '调优与后续版本', lineage: '版本遗传图谱', service: '服务与复盘', business: '全部业务案例', assets: '资产库', purpose: '业务目标与问题', new: '准备一项业务', first: '从业务目标形成首版' };
const relationNames = { delivered: '交付记录', declared: '声明依赖', revised: '修订', review: '评价', responds: '回应缺口', compares: '对照关联' };
function readRoute() {
  const query = new URLSearchParams(location.hash.slice(1));
  return { page: pageTitles[query.get('page')] ? query.get('page') : 'goal', v: version(query.get('v')).id, case: query.get('case') || '', scope: query.get('scope') === 'all' ? 'all' : 'version', run: query.get('run') || '', detail: query.get('detail') || '', tab: query.get('tab') || '' };
}
function url(patch = {}) {
  const next = { ...route, ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) if (value) params.set(key, value);
  return `#${params}`;
}
function navTo(page, patch = {}) { return url({ page, case: '', run: '', detail: '', tab: '', ...patch }); }
function link(label, patch, css = '') { return `<a class="${css}" href="${url(patch)}">${esc(label)}</a>`; }
function detailLink(label, type, id, css = '') { return link(label, { detail: `${type}:${id}` }, css); }
function badge(label, tone = '') { return `<span class="badge ${tone}">${esc(label)}</span>`; }
function table(headers, rows) { return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`; }
function row(cells) { return `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`; }
function heading(title, description = '') { return `<h1>${esc(title)}</h1>${description ? `<p class="lead">${esc(description)}</p>` : ''}`; }
function section(title, body) { return `<section class="section"><h2>${esc(title)}</h2>${body}</section>`; }
function kv(items) { return `<dl class="kv">${items.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value}</dd>`).join('')}</dl>`; }
function stat(items) { return `<div class="stat-row">${items.map(([count, label]) => `<div><strong>${count}</strong><span>${esc(label)}</span></div>`).join('')}</div>`; }
function persist(message) { localStorage.setItem(storageKey, JSON.stringify(saved)); render(); notify(message); }
function notify(message) { const el = document.querySelector('#notice'); el.textContent = message; el.classList.add('show'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => el.classList.remove('show'), 6500); }
function versionRuns(id = route.v) { return f.runs.filter(item => item.versionId === id); }
function runState(item) { return item.status === 'failed' ? badge('执行失败', 'bad') : item.evaluationIds.length ? badge('完成 · 有评价') : badge('完成 · 未评价', 'warn'); }
function reference(id) {
  if (asset(id)) return detailLink(`${id} · ${asset(id).name}`, 'asset', id);
  if (run(id)) return link(`${id} · ${run(id).summary}`, { page: 'cases', v: run(id).versionId, case: run(id).caseId, run: id, scope: 'version', detail: '' });
  const ev = byId(f.evaluations, id);
  return ev ? detailLink(`${id} · 原始评价`, 'evaluation', id) : esc(id);
}
function nav() {
  const item = (label, page, extra = {}) => `<a class="nav-item ${route.page === page ? 'current' : ''}" href="${navTo(page, extra)}">${label}</a>`;
  return `<div class="nav-label">SPACE</div><div class="space-name">社区内容工作台</div><p class="purpose">从有依据的作品，积累可持续的方法。</p>${item('业务目标与问题', 'purpose')}<details data-nav="workflow" ${navExpansion.workflow ? 'open' : ''}><summary>工作流 · CONTENT</summary><div class="subnav">${item('版本总览', 'versions')}${item('版本遗传图谱', 'lineage')}<details class="version-nav" data-nav="current" ${navExpansion.current ? 'open' : ''}><summary>当前查看 · ${route.v}</summary><label for="version-select">查看版本，不改变采用</label><select id="version-select">${f.versions.map(v => `<option value="${v.id}" ${v.id === route.v ? 'selected' : ''}>${v.id} · ${esc(v.name)}</option>`).join('')}</select>${item('设计目标与改动', 'goal')}${item('方法与产出图', 'method')}${item('案例与资产', 'cases')}${item('评价与分析', 'evaluation')}${item('调优与后续版本', 'tuning')}</details>${item('服务与复盘', 'service')}</div></details><div class="nav-divider"></div>${item('全部业务案例', 'business')}${item('资产库', 'assets')}<div class="nav-divider"></div>${item('＋ 从新目标形成首版', 'first')}<p class="scope">本草案保留对象与决定的关系。当前节点、输入、作品和评价均为合成材料。</p>`;
}
function context() {
  const v = version(route.v);
  let scope = `CONTENT / ${v.id}`;
  let badges = badge(`查看 ${v.id}`) + badge(v.adopted ? '已采用 · 社区短文' : '候选 · 未采用') + badge(v.executable ? '执行绑定可用（模拟）' : '当前不可执行', v.executable ? '' : 'warn');
  if (['purpose', 'business', 'assets', 'new', 'service'].includes(route.page)) {
    scope = '业务与方法';
    badges = badge('既有采用：CONTENT v1') + badge('新委托需检查执行条件', 'warn');
  }
  if (route.page === 'first' || (route.page === 'new' && route.tab === 'draft')) {
    scope = '新业务 / 独立首版草案';
    badges = badge(saved.draft?.id || '尚未保存') + badge('尚未绑定执行器', 'warn');
  }
  if (route.page === 'cases' && route.case) {
    scope = `Case ${route.case} / ${route.scope === 'all' ? '跨版本历史' : route.v}`;
    const selected = run(route.run);
    badges = badge(route.scope === 'all' ? '范围：跨版本' : `范围：${route.v}`) + (selected ? badge(`聚焦 ${selected.id} / ${selected.versionId}`) : badge('范围内全部运行'));
  }
  return `<div><div class="crumb">社区内容工作台 / ${esc(scope)}</div><div class="context-title">${esc(pageTitles[route.page])}${route.case ? ` / Case ${esc(route.case)}` : ''}</div></div><div class="context-badges">${badges}</div>`;
}
function goalView() {
  const v = version(route.v), runs = versionRuns();
  return heading(`${v.id} · ${v.name}`, v.motivation) + `<div class="panel"><div class="eyebrow">要解决的问题</div><h2>${esc(v.hypothesis)}</h2><p>${esc(v.change)}</p><div class="actions"><a class="button primary" href="${navTo('method')}">阅读完整方法</a><a class="button" href="${navTo('cases')}">查看实际案例与资产</a></div></div>` + stat([[new Set(runs.map(r => r.caseId)).size, '已记录 Case'], [runs.length, '实际运行'], [runs.filter(r => r.status === 'failed').length, '执行失败'], [runs.filter(r => r.evaluationIds.length).length, '有评价的运行']]) + `<div class="split"><section>${section('来路与改动', kv([['业务目的', esc(f.space.purpose)], ['版本前驱', v.predecessor ? link(`${v.predecessor} · ${version(v.predecessor).name}`, { page: 'goal', v: v.predecessor, detail: '' }) : '首版；来自业务目的与设计假设'], ['改动依据', v.predecessor ? f.change.evidenceIds.map(reference).join('<br>') : '希望将已提供材料变成可审阅短文；尚不宣称已验证通用性']]))}</section><section>${section('使用范围与当前条件', `<p>${esc(v.scope)}</p><div class="callout">${esc(v.conditions)}</div><ul>${v.unknowns.map(u => `<li>${esc(u)}</li>`).join('')}</ul><a href="${navTo('service')}">查看下一项业务如何继续 →</a>`)}</section></div><p class="scope">完整运行记录不等于充分验证。${link('阅读验证覆盖与原始评价', { page: 'evaluation', detail: '' })}；评分规则尚未定义。</p>`;
}
function versionsView() {
  return heading('版本总览', '每个版本是一份有动机、有范围、可以追溯证据的方法。查看和采用是不同动作。') + table(['版本与动机', '实际证据', '采用与执行', '继续'], f.versions.map(v => {
    const runs = versionRuns(v.id);
    return row([`<strong>${esc(v.id)} · ${esc(v.name)}</strong><p>${esc(v.motivation)}</p>`, `${new Set(runs.map(r => r.caseId)).size} 个 Case / ${runs.length} 次运行<br>${runs.filter(r => r.evaluationIds.length).length} 次有评价`, `${badge(v.adopted ? '已采用' : '候选')}${badge(v.executable ? '绑定可用' : '不可执行', v.executable ? '' : 'warn')}`, link('认识这一版', { page: 'goal', v: v.id, detail: '' })]);
  })) + `<div class="actions"><a class="button" href="${navTo('lineage')}">读版本关系及改动依据</a></div>`;
}
function methodView() {
  const v = version(route.v);
  return heading(`${v.id} 的方法与预期产出`, '图中是设计声明，虚线框是预期资产类型；点击节点查看职责、授权范围与执行条件。') + `<div class="graph-scroll"><div class="method-flow">${v.nodes.map(n => `<div class="method-node"><a href="${url({ detail: `node:${n.id}` })}"><strong>${esc(n.name)}</strong><p class="muted">${esc(n.role)}</p></a><div class="expected">预期交付${n.outputs.map(o => `<span>${esc(o)}</span>`).join('')}</div></div>`).join('')}</div><div class="graph-legend"><span>节点：Agent 的责任边界</span><span>虚线框：尚未代表实际产生的资产</span><span>前进、条件与返回：以下声明为准</span></div></div>` + table(['从哪一步', '到哪一步', '控制与交接条件'], v.process.edges.map(e => row([esc(byId(v.nodes, e.from)?.name), esc(byId(v.nodes, e.to)?.name), esc(e.label)]))) + `<div class="split"><div class="panel"><h3>返工怎样发生</h3><p>${esc(v.process.returnRule)}</p></div><div class="panel"><h3>何时结束或升级</h3><p>${esc(v.process.stopRule)}</p></div></div><a href="${navTo('cases')}">从预期方法进入本版实际案例 →</a>`;
}
function runsTable(runs) {
  return table(['运行与版本', '实际结果', '输入与评价', '阅读'], runs.map(r => row([`<strong>${r.id} · ${r.versionId}</strong><br>${runState(r)}`, esc(r.summary), `${esc(r.actualConditions)}<p>${r.evaluationIds.map(reference).join('<br>') || '尚无业务评价'}</p>`, link('查看运行与全部资产', { page: 'cases', v: route.scope === 'all' ? route.v : r.versionId, case: r.caseId, run: r.id, detail: '' })])));
}
function caseView() {
  const runs = versionRuns();
  if (!route.case) return heading(`${route.v} 的实际案例`, '仅纳入这一准确版本已记录的运行。验证计划中未开始的项另行对账。') + stat([[new Set(runs.map(r => r.caseId)).size, '实际 Case'], [runs.length, '全部运行 · 含失败']]) + table(['案例', '运行与结果', '继续'], f.cases.filter(c => runs.some(r => r.caseId === c.id)).map(c => row([`<strong>Case ${c.id} · ${esc(c.title)}</strong><p>${esc(c.brief)}</p>`, runs.filter(r => r.caseId === c.id).map(r => `${r.id} ${runState(r)}`).join('<br>'), link('打开案例', { case: c.id, scope: 'version', run: '', detail: '' })]))) + `<p class="scope">截至 ${f.meta.asOf} · 全部合成记录，无分页或隐藏筛选。${link('检查未开始的验证项', { page: 'evaluation', tab: 'coverage', detail: '' })}</p>`;
  const c = caseItem(route.case);
  if (!c) return `<div class="empty">未找到该案例。<a href="${navTo('business')}">返回全部业务案例</a></div>`;
  const scopeRuns = f.runs.filter(r => r.caseId === c.id && (route.scope === 'all' || r.versionId === route.v));
  const selected = scopeRuns.find(r => r.id === route.run);
  const activeRuns = selected ? [selected] : scopeRuns;
  const inputIds = [...new Set(activeRuns.flatMap(r => r.inputIds || []))];
  const ids = [...new Set([...inputIds, ...activeRuns.flatMap(r => r.assetIds)])];
  const assets = ids.map(asset).filter(Boolean);
  const outside = [...new Set(assets.flatMap(a => a.relations.map(rel => rel.targetId)).filter(id => !ids.includes(id)))].map(asset).filter(Boolean);
  return heading(`Case ${c.id} · ${c.title}`, c.brief) + `<div class="tabs">${link(`只看 ${route.v}`, { scope: 'version', run: '', detail: '' }, route.scope === 'version' ? 'selected' : '')}${link('跨版本完整历史', { scope: 'all', run: '', detail: '' }, route.scope === 'all' ? 'selected' : '')}</div><p class="scope">当前：${route.scope === 'all' ? '跨版本' : route.v} · ${scopeRuns.length} 次运行。${selected ? `资产图已聚焦 ${selected.id}。` : '资产图包含此范围全部运行。'}${selected ? link('取消运行聚焦', { run: '', detail: '' }) : ''}</p>` + runsTable(scopeRuns) + (selected ? `<section class="panel"><h2>${selected.id} · 本次事实</h2><p>${esc(selected.actualConditions)}</p><p><strong>人工参与：</strong>${esc(selected.intervention)}</p>${selected.issue ? `<div class="callout">${esc(selected.issue)}</div>` : ''}${selected.id === 'R1' ? detailLink('处理本次材料缺口', 'material', selected.id, 'button') : ''}${saved.supplements[selected.id] ? `<div class="notice">已另存追加材料，原 ${selected.id} 未改变。后续尝试仍未启动。${detailLink('阅读追加记录', 'material', selected.id)}</div>` : ''}</section>` : '') + section('实际资产关系', `<p class="scope">${assets.length} 份本范围已保存资产${outside.length ? `，另显示 ${outside.length} 份范围外关联资产（灰色）` : ''}。预期但未生成的产物不在实际图中。</p>${assetGraph(assets, outside, activeRuns)}${assetTable(assets)}<p class="scope">列表与图读取同一集合。点击资产读正文；点击关系读依据。输入交付不证明模型已理解或正确引用。</p>`) + section('本范围原始评价', activeRuns.flatMap(r => r.evaluationIds).map(id => evaluationCard(byId(f.evaluations, id))).join('') || '<p class="muted">尚无业务评价；未评不等于质量零分。</p>');
}
function assetTable(assets) { return table(['准确资产', '归属', '内容'], assets.map(a => row([detailLink(`${a.id} · ${a.name}`, 'asset', a.id, 'entry-name'), a.runId ? `${a.runId} / ${run(a.runId).versionId}` : '业务材料；交付范围按每次运行记录', detailLink('阅读正文与来源', 'asset', a.id)]))); }
function assetGraph(assets, outside, runs) {
  const all = [...assets, ...outside];
  const columns = [null, ...runs.map(r => r.id), 'outside'];
  const positions = new Map(), counts = new Map();
  for (const a of all) {
    const col = outside.includes(a) ? columns.length - 1 : Math.max(0, columns.indexOf(a.runId));
    const index = counts.get(col) || 0;
    counts.set(col, index + 1);
    positions.set(a.id, { x: 25 + col * 225, y: 55 + index * 100 });
  }
  const height = 100 + Math.max(1, ...counts.values()) * 100;
  const width = Math.max(650, (outside.length ? columns.length : columns.length - 1) * 225 + 30);
  const edges = assets.flatMap(a => a.relations.map((rel, index) => ({ a, rel, index }))).filter(e => positions.has(e.rel.targetId));
  return `<div class="graph-scroll"><svg class="asset-graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-label="当前范围的实际资产关系图"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#a2af99"/></marker></defs>${columns.slice(0, outside.length ? undefined : -1).map((col, i) => `<text x="${25 + i * 225}" y="26">${col === null ? '本次交付材料' : col === 'outside' ? '范围外关联资产' : `${col} · ${run(col).versionId}`}</text>`).join('')}${edges.map(({ a, rel, index }) => {
    const from = positions.get(rel.targetId), to = positions.get(a.id);
    const same = from.x === to.x;
    const d = same ? `M${from.x + 187},${from.y + 26} C${from.x + 216},${from.y + 26} ${to.x + 216},${to.y + 26} ${to.x + 187},${to.y + 26}` : `M${from.x + 185},${from.y + 26} C${from.x + 209},${from.y + 26} ${to.x - 24},${to.y + 26} ${to.x},${to.y + 26}`;
    const color = rel.type === 'compares' ? '#9481ab' : rel.type === 'responds' ? '#ae8b54' : '#75906e';
    const dash = rel.type === 'declared' ? '5 3' : rel.type === 'compares' ? '8 5' : rel.type === 'responds' ? '2 3' : '';
    return `<a href="${url({ detail: `edge:${a.id}:${index}` })}"><title>${esc(relationNames[rel.type])}：${esc(rel.basis)}</title><path d="${d}" fill="none" stroke="${color}" stroke-dasharray="${dash}" stroke-width="1.5" ${rel.type === 'compares' ? '' : 'marker-end="url(#arrow)"'}/><path d="${d}" fill="none" stroke="transparent" stroke-width="14"/></a>`;
  }).join('')}${all.map(a => { const p = positions.get(a.id); return `<a href="${url({ detail: `asset:${a.id}` })}"><rect x="${p.x}" y="${p.y}" width="187" height="57" rx="5" fill="${outside.includes(a) ? '#eeeeea' : a.kind === 'output' ? '#eaf0e3' : '#f9fbf6'}" stroke="#b5c4ac"/><text x="${p.x + 10}" y="${p.y + 21}" font-size="11">${esc(a.id)}</text><text x="${p.x + 10}" y="${p.y + 42}" font-size="12">${esc(a.name.length > 13 ? `${a.name.slice(0, 13)}…` : a.name)}</text></a>`; }).join('')}</svg><div class="graph-legend"><span class="edge-key"><i></i>交付记录</span><span class="edge-key declared"><i></i>声明依赖</span><span class="edge-key responds"><i></i>回应缺口</span><span class="edge-key compares"><i></i>对照关联 · 不代表生产或引用</span></div></div><details><summary>关系明细 · ${edges.length} 条有记录的关联</summary>${table(['来源 → 当前资产', '关系', '证据'], edges.map(({ a, rel, index }) => row([`${esc(asset(rel.targetId).name)} → ${esc(a.name)}`, esc(relationNames[rel.type]), detailLink('查看关系依据', 'edge', `${a.id}:${index}`)])))}</details>`;
}
function evaluationCard(e) { return `<div class="record"><strong>${esc(e.id)} · ${esc(e.author)}</strong><p>${esc(e.conclusion)}</p>${detailLink('读原始评价、对象与范围', 'evaluation', e.id)}</div>`; }
function evaluationView() {
  const runs = versionRuns(), slots = f.plan.slots.filter(s => s.versionId === route.v);
  const all = route.tab === 'all';
  const visible = all ? f.plan.slots : slots;
  const evaluationIds = runs.flatMap(r => r.evaluationIds);
  return heading(`${route.v} 的评价与分析`, '先看结论适用于哪些材料和条件，再决定是否值得继续验证。版本总评分机制尚未定义。') + `<div class="callout"><strong>${route.v === 'v2' ? '目前不足以判断候选可替代 v1' : '历史成果有评价，当前执行条件另有阻塞'}</strong><p>${esc(route.v === 'v2' ? f.change.verification : version('v1').conditions)}</p></div>` + section('验证计划 P · 预期与实际对账', `<p>${esc(f.plan.goal)}</p><div class="tabs">${link(`只看 ${route.v} 计划项`, { tab: 'coverage', detail: '' }, !all ? 'selected' : '')}${link('两版计划对照', { tab: 'all', detail: '' }, all ? 'selected' : '')}</div>${stat([[visible.length, '计划项'], [visible.filter(s => s.runId).length, '已启动'], [visible.filter(s => run(s.runId)?.status === 'completed').length, '执行完成'], [visible.filter(s => run(s.runId)?.evaluationIds.length).length, '有评价']])}${table(['计划项', '实际运行', '状态', '证据'], visible.map(s => { const r = run(s.runId); return row([`Case ${s.caseId} × ${s.versionId} · 计划 1 项`, r ? `${r.id} · 实际 1 次` : '实际 0 次', r ? runState(r) : badge('未开始', 'warn'), r ? reference(r.id) : detailLink('阅读尚未开始的计划项', 'plan', s.id)]); }))}<p class="scope">${esc(f.plan.conditions)} R2 在计划外，不能静默替代 R1。</p>`) + section('原始评价 · 所有本版实际运行', evaluationIds.map(id => evaluationCard(byId(f.evaluations, id))).join('') || '<p class="muted">此版本尚无业务评价。内部节点复核不等于独立评价。</p>') + section('综合判断的边界', `<ul><li>R1 和 R3 的输入不同；R3 完成不能直接归因为新增关口。</li><li>R2 的评价只适用于后来补材后的 R2，不覆盖 R1。</li><li>时间费用与长期人工负担尚未测量；代表性业务覆盖仍待检验。</li></ul><a class="button" href="${navTo('tuning')}">沿证据决定下一步</a>`);
}
function tuningView() {
  const c = f.change;
  return heading('从问题到候选，再到决定', '产生了下一版，不代表这项改动已经被证明有效。') + kv([['发现的问题', esc(c.problem)], ['原始依据', c.evidenceIds.map(reference).join('<br>')], ['竞争解释', '缺材料可能来自委托准备不足；输入补齐也可能解释成稿改善；显式关口的独立贡献尚未知。'], ['候选假设', esc(c.hypothesis)], ['选择的改动', esc(c.change)], ['验证进展', `${esc(c.verification)} ${link('检查计划 P', { page: 'evaluation', v: 'v2', tab: 'all', detail: '' })}`], ['当前决定', esc(c.decision)]]) + `<div class="actions">${link('读 v2 完整方法', { page: 'method', v: 'v2', detail: '' }, 'button')}${link('在遗传图谱中定位', { page: 'lineage', detail: '' }, 'button')}</div>` + section('记录下一步判断（模拟）', `<form id="decision-form" class="form"><label for="decision-type">根据现有证据，下一步做什么</label><select id="decision-type" name="type"><option>补充验证与评价</option><option>提出方法候选</option><option>关联项目 dogfood 问题</option><option>继续旧版，不采用候选</option><option>停止本次改进投入</option></select><label for="decision-reason">依据与尚未解决的问题</label><textarea id="decision-reason" name="reason" required placeholder="写出证据、原因假设及下一步要验证什么"></textarea><button class="primary" type="submit">保存模拟判断</button></form>${saved.decisions.map(d => `<div class="record">${esc(d.type)} · ${esc(d.v)}<p>${esc(d.reason)}</p><small>本地模拟记录；没有创建真实版本或仓库 issue。</small></div>`).join('')}`);
}
function lineageView() {
  return heading('版本遗传图谱', '连线来自明确的前驱与改动记录；不是按时间排列后推断出的继承。') + `<div class="lineage"><div class="panel"><div class="eyebrow">首版</div><h2>v1 · ${esc(version('v1').name)}</h2><p>${esc(version('v1').hypothesis)}</p>${badge('既有采用')}${badge('当前不可执行', 'warn')}<p>${link('完整认识 v1', { page: 'goal', v: 'v1', detail: '' })}</p></div><div class="between"><p>→</p>${detailLink('改动依据与验证', 'change', 'v1-v2', 'button')}<p class="scope">来源：前驱 v1、问题证据与候选记录</p></div><div class="panel"><div class="eyebrow">后继候选</div><h2>v2 · ${esc(version('v2').name)}</h2><p>${esc(version('v2').hypothesis)}</p>${badge('未采用')}${badge('验证未完成', 'warn')}<p>${link('完整认识 v2', { page: 'goal', v: 'v2', detail: '' })}</p></div></div><p class="scope">此合成集合只有一条后继关系；没有其它失败分支记录，不补造谱系。候选不会覆盖历史资产或 v1 的采用记录。</p>`;
}
function businessView() {
  return heading('全部业务案例', '从一次具体委托进入，可以查看它在不同方法版本上的完整历史。') + `<div class="actions"><a class="button primary" href="${navTo('new')}">准备新委托</a></div>` + table(['案例与要求', '完整历史', '打开'], f.cases.map(c => row([`<strong>Case ${c.id} · ${esc(c.title)}</strong><p>${esc(c.brief)}</p>`, f.runs.filter(r => r.caseId === c.id).map(r => `${r.id} / ${r.versionId} ${runState(r)}`).join('<br>'), link('打开跨版本历史', { page: 'cases', case: c.id, scope: 'all', run: '', detail: '' })]))) + requestList();
}
function requestList() { return saved.requests.length ? section('本地新委托 · 尚无实际运行', saved.requests.map((r, i) => `<div class="record"><strong>${esc(r.title)}</strong> ${badge(r.choice === 'v1' ? '等待恢复' : r.choice === 'draft' ? '等待首版方法准备' : '试跑意图已记录', 'warn')}<p>选择 ${esc(r.draftSnapshot ? `${r.draftSnapshot.id} · ${r.draftSnapshot.purpose}` : r.choice)} · ${esc(r.reason)}</p>${detailLink('阅读委托与决定', 'request', String(i))}</div>`).join('')) : ''; }
function serviceView() {
  return heading('服务与复盘', '日常使用与候选研发可以并行；当前应使用哪版，需要同时看采用范围和执行条件。') + `<div class="panel"><h2>社区服务短文 → 既有采用 v1</h2><p>${esc(version('v1').scope)}</p><div class="callout"><strong>采用仍有效，但新委托当前无法执行</strong><p>${esc(version('v1').conditions)}</p></div><p>v2 是可试跑候选，未采用。它不会因为当前可执行就接管 v1 的业务。</p><div class="actions"><a class="button primary" href="${navTo('new')}">准备新委托并决定下一步</a><a class="button" href="${navTo('evaluation', { v: 'v2', tab: 'all' })}">检查候选的验证依据</a></div></div>` + requestList() + section('观察窗口与未知', `<p>当前只有 4 次合成运行，不能证明持续服务质量。人工补材在运行记录中可读；真实时间、成本、用户采用后的收益未测量。历史成果仍可阅读。</p><a href="${navTo('business')}">回到业务与成果 →</a>`);
}
function newView() {
  return heading('准备一项新业务', '先保存业务要求，再明确所用方法。当前没有任何选择会启动真实模型。') + `<form id="request-form" class="form"><label for="request-title">业务要求</label><input id="request-title" name="title" required placeholder="例如：为社区活动整理一则报名提醒"><label for="request-materials">已有材料</label><textarea id="request-materials" name="materials" required placeholder="录入用于模拟的材料与来源说明"></textarea><label for="request-method">本次方法选择</label><select id="request-method" name="method"><option value="v1" ${route.tab !== 'draft' ? 'selected' : ''}>v1 · 既有采用，但当前不可执行</option><option value="v2">v2 · 单独候选试跑，不改变采用</option>${saved.draft ? `<option value="draft" ${route.tab === 'draft' ? 'selected' : ''}>${esc(saved.draft.id || 'draft-1')} · 新业务首版草案 · 尚未绑定执行器</option>` : ''}</select><div id="dispatch-condition"></div><label for="request-reason">本次选择依据</label><textarea id="request-reason" name="reason" required placeholder="为何等待恢复，或为何允许这次候选试跑？"></textarea><button class="primary" type="submit" id="save-request">保存委托，等待 v1 恢复</button></form><p class="scope">保存后只留下委托与决定，不生成运行或产物，也不改变已有 run 的版本。</p>`;
}
function purposeView() { return heading('业务目标与问题', f.space.purpose) + section('为谁，以及什么结果有用', `<p>${esc(f.space.audience)}</p><ul>${f.space.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ul><p>当前原型用社区内容作为示例，底座的目标是让业务方法能够真实执行、被检验并持续改进。更少人工救场与跨业务复用尚需真实任务证明。</p>`) + section('当前方法怎样服务目标', `<div class="actions"><a class="button" href="${navTo('versions')}">阅读现有方法版本</a><a class="button" href="${navTo('business')}">从具体业务开始</a><a class="button" href="${navTo('first')}">为新业务形成首版</a></div>`); }
function firstView() {
  const d = saved.draft;
  return heading('从新业务目标形成首版', '这一步保留目的、样例、交付边界与未决问题。下面是可编辑设计草案，不是 Agent 已经完成的方法设计。') + `<form id="draft-form" class="form"><label for="draft-purpose">业务目的与用途</label><textarea id="draft-purpose" name="purpose" required>${esc(d?.purpose || '')}</textarea><label for="draft-materials">现有样例或材料</label><textarea id="draft-materials" name="materials" required>${esc(d?.materials || '')}</textarea><label for="draft-criteria">怎样检查成果是否可用</label><textarea id="draft-criteria" name="criteria" required>${esc(d?.criteria || '')}</textarea><label for="draft-boundary">允许自主决定什么；缺口怎样交给人</label><textarea id="draft-boundary" name="boundary" required>${esc(d?.boundary || '')}</textarea><button class="primary" type="submit">保存并整理首版草案</button></form>` + (d ? section(`${d.id || 'draft-1'} · 首版草案 · 尚未具备执行绑定`, `<p><strong>设计目标：</strong>${esc(d.purpose)}</p><p><strong>为什么这样分工：</strong>先检查材料是否支撑用途，再制作交付物，最后按你的标准审阅。这是本原型提供的起始结构，需结合业务修订。</p><div class="draft-nodes"><div class="panel"><h3>检查材料</h3><p>预期交付：依据与缺口清单</p><p>关键材料缺失时交给负责人。</p></div><div class="panel"><h3>完成业务成果</h3><p>预期交付：候选成果及来源说明</p><p>${esc(d.boundary)}</p></div><div class="panel"><h3>审阅与决定</h3><p>预期交付：按标准的意见及后续决定</p><p>${esc(d.criteria)}</p></div></div><div class="callout">还缺：业务专用节点方法、工具与资产合同的确认、实际执行绑定，以及首个真实 Case 的检验。当前不能宣称可运行或已产生资产。</div><a class="button" href="${navTo('new', { tab: 'draft' })}">准备第一项业务委托</a>`) : `<div class="notice">尚无首版。材料不足可以在已有材料中明确写“缺失”，并在边界中说明需要补什么；不会因为保存了表单就变为可执行。</div>`);
}
function inspectorView() {
  const [type, id, index] = route.detail.split(':');
  let title = '', body = '';
  if (type === 'asset' && asset(id)) {
    const a = asset(id), r = run(a.runId);
    title = a.name;
    body = `<div class="eyebrow">${esc(a.id)} · ${esc(a.kind)}</div><div class="asset-content">${esc(a.content)}</div>${kv([['实际归属', r ? `${r.id} / ${r.versionId} / Case ${r.caseId}` : '业务原始材料；是否交付按 run 核对'], ['生产者', a.producer ? detailLink(f.versions.flatMap(v => v.nodes).find(n => n.id === a.producer)?.name || a.producer, 'node', a.producer) : '委托者提供'], ['相关原始评价', f.evaluations.filter(e => e.assetId === id).map(e => detailLink(e.id, 'evaluation', e.id)).join('<br>') || '无独立业务评价']])}${section('关系依据', a.relations.map((rel, i) => `<div class="record">${esc(relationNames[rel.type])} → ${detailLink(asset(rel.targetId)?.name || rel.targetId, 'asset', rel.targetId)}<p>${esc(rel.basis)}</p>${detailLink('阅读该关系的证据边界', 'edge', `${id}:${i}`)}</div>`).join('') || '<p>没有已记录的来源边，不补造关系。</p>')}`;
  } else if (type === 'node') {
    const v = f.versions.find(v => v.nodes.some(n => n.id === id));
    const n = v && byId(v.nodes, id);
    if (n) {
      title = n.name;
      const r = run(route.run);
      body = `<p>${esc(n.role)}</p>${section('设计声明', kv([['输入', n.inputs.map(esc).join('、')], ['预期资产', n.outputs.map(esc).join('、')], ['方法指令', esc(n.instructions)], ['自主范围', esc(n.autonomy)], ['缺口与升级', esc(n.escalation)], ['工具 / Skill', `${n.tools.map(esc).join('、')} / ${esc(n.skill || '未依赖 skill；使用直接指令与工具')}`]]))}${section('执行绑定', `<p>${esc(n.executor)}</p><div class="callout">${esc(v.conditions)}</div><small>外部资源完整冻结状态未提供；不能据此保证历史可原样重跑。</small>`)}${section('本次记录', r && r.versionId === v.id ? `<p>${esc(r.actualConditions)}</p><p>${esc(r.intervention)}</p><p>精确工具读取事件与提供者实际参数未在此合成样本中给出，保持未知。</p>` : '<p>尚未选择该版的一次运行。方法声明不当作实际行为。</p>')}`;
    }
  } else if (type === 'evaluation' && byId(f.evaluations, id)) {
    const e = byId(f.evaluations, id);
    title = `${e.id} · 原始评价`;
    body = kv([['评价对象', detailLink(asset(e.assetId).name, 'asset', e.assetId)], ['判者', esc(e.author)], ['标准', esc(e.standard)], ['结论', esc(e.conclusion)], ['依据', esc(e.evidence)], ['范围与限制', esc(e.limits)]]);
  } else if (type === 'edge' && asset(id)?.relations[Number(index)]) {
    const a = asset(id), rel = a.relations[Number(index)];
    title = relationNames[rel.type];
    body = kv([['关联资产', `${detailLink(asset(rel.targetId).name, 'asset', rel.targetId)} → ${detailLink(a.name, 'asset', id)}`], ['记录依据', esc(rel.basis)], ['支持到什么程度', esc(rel.detail)]]) + '<div class="notice">没有读取事件不等于没有得到材料；输入也可能直接装配。关系记录不能证明模型的内部理解。</div>';
  } else if (type === 'plan' && byId(f.plan.slots, id)) {
    const s = byId(f.plan.slots, id);
    title = `Case ${s.caseId} × ${s.versionId} · 计划项`;
    body = `<p>${esc(caseItem(s.caseId).brief)}</p>${badge('实际运行 0 次', 'warn')}<p class="section">此项尚未开始，没有对应 run 或实际产物。它仍属于计划 P 的覆盖分母。</p><p>${esc(f.plan.conditions)}</p><p>下一步需确认准确输入与执行条件，再安排尝试；当前点击不会伪造已完成结果。</p>`;
  } else if (type === 'material' && id === 'R1') {
    title = '处理 R1 的材料缺口';
    body = `<p>${esc(run(id).issue)}</p><p>R1 当时只收到 ${detailLink('原始简报', 'asset', 'A-brief')}。现有历史中的 ${detailLink('补交时间表', 'asset', 'A-schedule')} 是 R1 结束后提供，并已用于 R2、R3。</p><div class="callout">本次不允许联网。R1 已结束；追加材料将单独保存，不恢复或覆盖旧尝试。</div><form id="material-form"><label for="supplement">另行补充的材料或处理决定</label><textarea id="supplement" name="material" required>${esc(saved.supplements[id] || '')}</textarea><button class="primary" type="submit">保存追加记录，准备后续尝试</button></form>${saved.supplements[id] ? '<p class="notice">追加记录已保存（模拟）。后续尝试尚未启动，R1 仍保持原输入与失败状态。</p>' : ''}`;
  } else if (type === 'change') {
    title = 'v1 → v2 · 有依据的变更';
    body = kv([['问题', esc(f.change.problem)], ['原始证据', f.change.evidenceIds.map(reference).join('<br>')], ['假设', esc(f.change.hypothesis)], ['改动', esc(f.change.change)], ['验证', esc(f.change.verification)], ['采用决定', esc(f.change.decision)]]);
  } else if (type === 'request' && saved.requests[Number(id)]) {
    const r = saved.requests[Number(id)]; title = r.title;
    body = kv([['委托材料', esc(r.materials)], ['所选方法', esc(r.draftSnapshot ? `${r.draftSnapshot.id} · ${r.draftSnapshot.purpose}` : r.choice)], ['所保存的草案', r.draftSnapshot ? `${esc(r.draftSnapshot.criteria)}<p>${esc(r.draftSnapshot.boundary)}</p><small>随委托保存当时草案；后续编辑不会改写这份记录。</small>` : '本次没有关联新业务草案'], ['决定依据', esc(r.reason)], ['后果', r.choice === 'v1' ? '保留委托，等待执行绑定恢复；尚无运行。' : r.choice === 'draft' ? '保留与这份首版草案关联的委托，等待方法与执行条件准备；尚无运行，也没有使用 CONTENT v1。' : '只保存试跑意图，尚无运行；没有改变 v1 采用或任何历史记录。']]);
  }
  if (!title) return '<h2>未找到此详情</h2><p>可能是链接已失效或本地模拟记录已重置。</p>';
  return `<div class="inspector-heading"><div><div class="eyebrow">保留当前工作范围</div><h2>${esc(title)}</h2></div><a class="button" aria-label="关闭详情" href="${url({ detail: '' })}">关闭</a></div>${body}`;
}
function updateDispatch() {
  const select = document.querySelector('#request-method');
  if (!select) return;
  const choice = select.value;
  document.querySelector('#dispatch-condition').innerHTML = `<div class="callout">${choice === 'draft' ? `<strong>本次关联 ${esc(saved.draft.id || 'draft-1')}：${esc(saved.draft.purpose)}</strong><br>` : ''}${choice === 'v1' ? 'v1 仍是此范围采用版，但旧模板资源已下线。当前不能启动；可以先保存委托等待恢复。' : choice === 'v2' ? '你明确选择的是一次候选试跑。v2 绑定可用，但验证未完成；保存不会改变采用决定。' : '这是新业务的首版设计草案，尚未确认方法与执行绑定；只能保存第一项委托，不能启动。'}</div>`;
  document.querySelector('#save-request').textContent = choice === 'v1' ? '保存委托，等待 v1 恢复' : choice === 'v2' ? '记录本次候选试跑决定' : '保存首项委托，等待方法准备';
}
function render() {
  for (const el of document.querySelectorAll('[data-nav]')) navExpansion[el.dataset.nav] = el.open;
  const previous = route;
  const scroll = document.querySelector('#main').scrollTop;
  route = readRoute();
  document.querySelector('#navigation').innerHTML = nav();
  document.querySelector('#context').innerHTML = context();
  const views = { goal: goalView, versions: versionsView, method: methodView, cases: caseView, evaluation: evaluationView, tuning: tuningView, lineage: lineageView, service: serviceView, business: businessView, assets: () => heading('资产库', '从材料与成果进入，沿来源回到准确运行、方法与评价。') + assetTable(f.assets), purpose: purposeView, new: newView, first: firstView };
  document.querySelector('#main').innerHTML = views[route.page]();
  const inspector = document.querySelector('#inspector');
  inspector.hidden = !route.detail;
  inspector.innerHTML = route.detail ? inspectorView() : '';
  inspector.scrollTop = 0;
  document.querySelector('#main').scrollTop = previous && ['page', 'v', 'case', 'scope', 'run', 'tab'].every(key => previous[key] === route[key]) ? scroll : 0;
  document.querySelector('#version-select').addEventListener('change', event => { location.hash = url({ v: event.target.value, run: '', detail: '' }); });
  document.querySelector('#request-method')?.addEventListener('change', updateDispatch);
  updateDispatch();
  document.querySelector('#decision-form')?.addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.target); saved.decisions.push({ v: route.v, type: data.get('type'), reason: data.get('reason') }); persist('已保存模拟判断；没有自动产生下一版或创建项目 issue。'); });
  document.querySelector('#material-form')?.addEventListener('submit', event => { event.preventDefault(); saved.supplements.R1 = new FormData(event.target).get('material'); persist('已单独保存追加记录；R1 的原输入与状态保持不变。'); });
  document.querySelector('#draft-form')?.addEventListener('submit', event => { event.preventDefault(); saved.draft = { ...Object.fromEntries(new FormData(event.target)), id: `draft-${(saved.draftRevision || 0) + 1}` }; saved.draftRevision = (saved.draftRevision || 0) + 1; persist('首版草案已保存；仍需确认方法并建立执行绑定。'); document.querySelector('.draft-nodes')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  document.querySelector('#request-form')?.addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.target); saved.requests.push({ title: data.get('title'), materials: data.get('materials'), choice: data.get('method'), reason: data.get('reason'), draftSnapshot: data.get('method') === 'draft' ? { ...saved.draft, id: saved.draft.id || 'draft-1' } : null }); persist('已保存本地委托与决定；尚无实际运行。'); location.hash = navTo('business', { detail: `request:${saved.requests.length - 1}` }); });
}
document.querySelector('#reset').addEventListener('click', () => { saved = freshState(); localStorage.removeItem(storageKey); location.hash = '#page=goal&v=v1'; render(); notify('本地模拟操作已重置，合成历史保持原样。'); });
window.addEventListener('hashchange', render);
render();
