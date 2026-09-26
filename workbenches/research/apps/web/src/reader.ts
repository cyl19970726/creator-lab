import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

const style = document.createElement('style');
style.textContent = `
  .diagram-reader { margin: 1.4em 0; border: 1px solid #dce5df; border-radius: 9px; overflow: hidden; background: #fff; }
  .diagram-controls { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #e8ede8; color: #5c776d; font: 12px/1.4 system-ui, sans-serif; }
  .diagram-controls button { border: 1px solid #aaccc0; background: #f8fbf8; border-radius: 6px; padding: 5px 9px; color: #246d60; font: inherit; cursor: pointer; }
  .diagram-controls button[aria-pressed="true"] { background: #dcefe4; border-color: #6aa992; font-weight: 700; }
  .diagram-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .diagram-viewport { overflow: auto; max-height: min(70vh, 680px); padding: 12px; }
  .diagram-viewport:focus-visible { outline: 3px solid #167367; outline-offset: -3px; border-radius: 5px; }
  .diagram-viewport .mermaid { width: max-content; min-width: 100%; }
  .diagram-reader[data-view="fit"] .diagram-viewport .mermaid { width: 100%; }
  .diagram-error { white-space: pre-wrap; overflow-wrap: anywhere; }
`;
document.head.append(style);

// MarkdownIt emits Mermaid fences as pre > code.language-mermaid.
// Keep the original code block so a malformed diagram remains readable.
const blocks: Array<{ renderNode: HTMLElement; original: HTMLElement }> = [];
for (const code of document.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
  const original = code.parentElement;
  if (!original) continue;
  const renderNode = document.createElement('div');
  renderNode.className = 'mermaid';
  renderNode.textContent = code.textContent || '';
  original.replaceWith(renderNode);
  blocks.push({ renderNode, original });
}
for (const node of document.querySelectorAll<HTMLElement>('.mermaid, pre.mermaid')) {
  if (blocks.some((block) => block.renderNode === node)) continue;
  blocks.push({ renderNode: node, original: node.cloneNode(true) as HTMLElement });
}

function diagramWidth(svg: SVGSVGElement): number {
  const viewBox = svg.viewBox?.baseVal;
  if (viewBox?.width) return Math.ceil(viewBox.width);
  const width = Number.parseFloat(svg.getAttribute('width') || '');
  return Number.isFinite(width) ? Math.ceil(width) : 0;
}

function addDiagramControls(node: HTMLElement, svg: SVGSVGElement) {
  const naturalWidth = diagramWidth(svg);
  const reader = document.createElement('div');
  reader.className = 'diagram-reader';
  reader.dataset.view = 'actual';
  const controls = document.createElement('div');
  controls.className = 'diagram-controls';
  const caption = document.createElement('span');
  caption.textContent = '图解 · 可滚动查看细节';
  const actions = document.createElement('div');
  actions.className = 'diagram-actions';
  const actual = document.createElement('button');
  actual.type = 'button';
  actual.textContent = '原尺寸';
  const fit = document.createElement('button');
  fit.type = 'button';
  fit.textContent = '查看全图';
  const viewport = document.createElement('div');
  viewport.className = 'diagram-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', '图解内容，可使用方向键滚动查看');
  const setView = (view: 'actual' | 'fit') => {
    reader.dataset.view = view;
    actual.setAttribute('aria-pressed', String(view === 'actual'));
    fit.setAttribute('aria-pressed', String(view === 'fit'));
    svg.style.setProperty('max-width', view === 'fit' ? '100%' : 'none', 'important');
    svg.style.setProperty('width', view === 'fit' ? '100%' : `${naturalWidth}px`, 'important');
    svg.style.setProperty('height', 'auto', 'important');
    if (view === 'fit') viewport.scrollLeft = 0;
  };
  actual.addEventListener('click', () => setView('actual'));
  fit.addEventListener('click', () => setView('fit'));
  actions.append(actual, fit);
  controls.append(caption, actions);
  node.replaceWith(reader);
  viewport.append(node);
  reader.append(controls, viewport);
  if (naturalWidth && naturalWidth > viewport.clientWidth - 24) {
    setView('actual');
  } else {
    controls.remove();
    reader.dataset.view = 'fit';
    svg.style.setProperty('max-width', '100%', 'important');
    svg.style.setProperty('width', '100%', 'important');
    svg.style.setProperty('height', 'auto', 'important');
  }
}

void (async () => {
  for (const { renderNode, original } of blocks) {
    try {
      await mermaid.run({ nodes: [renderNode] });
      const svg = renderNode.querySelector<SVGSVGElement>('svg');
      if (!svg) throw new Error('Diagram did not render');
      addDiagramControls(renderNode, svg);
    } catch {
      original.classList.add('diagram-error');
      renderNode.replaceWith(original);
    }
  }
})();
