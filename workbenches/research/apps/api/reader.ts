import MarkdownIt from 'markdown-it';
const md = new MarkdownIt({ html: false, linkify: false });
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
md.renderer.rules.image = () => '<span>外部图片请通过来源链接查看。</span>';
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  const href = tokens[i].attrGet('href') || '';
  if (!/^https?:\/\//i.test(href) && !href.startsWith('#')) tokens[i].attrSet('href', '#');
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, i, options);
};
export const readerCsp =
  "sandbox allow-scripts allow-popups; default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'";
type ReadablePayload = { title?: string; document?: string; [key: string]: unknown };
function structuredSections(payload: ReadablePayload) {
  const sections: string[] = [];
  if (typeof payload.decision === 'string') {
    const verdict: Record<string, string> = {
      pass: '独立审核通过',
      revise: '需要修订',
      'insufficient-evidence': '需要补证',
      'human-decision': '需要用户判断',
    };
    sections.push(
      `<section><h2>审核结论</h2><p>${esc(verdict[payload.decision] || payload.decision)}</p><p>此结论来自审核角色，不代表用户接受。</p></section>`,
    );
  }
  if (Array.isArray(payload.findings))
    sections.push(
      `<section><h2>具体发现</h2>${payload.findings.length ? payload.findings.map((f) => `<article><h3>${esc(f.id)} · ${esc(f.location)}</h3><p>${esc(f.issue)}</p></article>`).join('') : '<p>未列出未解决发现。</p>'}</section>`,
    );
  if (Array.isArray(payload.gaps) && payload.gaps.length)
    sections.push(
      `<section><h2>待补证问题</h2><ul>${payload.gaps.map((g) => `<li><b>${esc(g.problemId)}</b>：${esc(g.question)}</li>`).join('')}</ul></section>`,
    );
  if (Array.isArray(payload.findingResponses) && payload.findingResponses.length)
    sections.push(
      `<details><summary>综合者对审核意见的回应（仍需独立复验）</summary>${payload.findingResponses.map((r) => `<article><h3>${esc(r.findingId)} · ${r.status === 'addressed' ? '已作处理' : '仍未解决'}</h3><p>${esc(r.explanation)}</p></article>`).join('')}</details>`,
    );
  for (const [key, title] of [
    ['facts', '事实摘录'],
    ['inferences', '推断及适用条件'],
    ['unknowns', '尚不能确定'],
  ]) {
    const values = payload[key];
    if (Array.isArray(values) && values.length)
      sections.push(
        `<details><summary>${title}（${values.length}）</summary><ul>${values.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></details>`,
      );
  }
  return sections.join('');
}
export function renderReader(payload: ReadablePayload) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(payload.title)}</title><style>body{font:16px/1.95 system-ui,sans-serif;color:#263e3a;margin:0;padding:32px;background:#fffdf8;overflow-wrap:anywhere}main{max-width:820px;margin:auto}h1{font-size:28px;line-height:1.4}h2{font-size:23px;margin-top:2em}a{color:#0b7566}pre{white-space:pre-wrap;background:#f2f2ed;padding:16px;border-radius:8px}table{display:block;overflow:auto;border-collapse:collapse}td,th{padding:10px;border:1px solid #ddd}svg{max-width:100%;height:auto}.diagram-error{background:#fff0cc;padding:12px}@media(max-width:500px){body{padding:18px}}</style></head><body><main><h1>${esc(payload.title)}</h1>${md.render(payload.document || '暂无正文')}${structuredSections(payload)}</main><script type="module" src="/reader.js"></script></body></html>`;
}
