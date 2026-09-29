import { useEffect, useMemo, useState } from 'react';
import type { Artifact, ContentDefinition, Draft, ExecutionConfig, Job, Review, Work, WorkDetail, Workspace } from '../../../src/contracts/index.js';
import { api } from './api.js';

type Purpose = Work['purpose'];
type MaterialInput = { id: string; title: string; text: string; url: string };
const purposeLabels: Record<Purpose, string> = { explanation: '解释机制', opinion: '提出观点', narrative: '讲述故事' };
const stateLabels: Record<Job['state'], string> = {
  queued: '等待执行', running: '执行中', succeeded: '执行完成', needs_review: '等待人工判断',
  blocked: '执行受阻', failed: '执行失败', canceled: '已取消',
};
const short = (value: string) => value.slice(0, 10);
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const readableError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const safeSourceUrl = (value: string) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function WorkspaceCreator({ onCreate, onCancel, busy }: { onCreate: (name: string, positioning: string) => Promise<void>; onCancel?: () => void; busy: boolean }) {
  const [name, setName] = useState('');
  const [positioning, setPositioning] = useState('');
  return <form className="form-card" onSubmit={async e => { e.preventDefault(); await onCreate(name, positioning); }}>
    <div className="eyebrow">01 / 创建工作区</div>
    <h2>先说明你是谁，创作从哪里出发。</h2>
    <p className="muted">工作区保存长期的账号定位；每篇作品仍可细化自己的受众和目标。</p>
    <Field label="工作区名称"><input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的科普账号" /></Field>
    <Field label="账号定位"><textarea required maxLength={3000} rows={4} value={positioning} onChange={e => setPositioning(e.target.value)} placeholder="写给谁，长期关心什么，以及你希望坚持的表达方式" /></Field>
    <div className="form-actions">{onCancel && <button type="button" className="secondary" onClick={onCancel}>返回当前工作区</button>}<button className="primary" disabled={busy}>创建工作区</button></div>
  </form>;
}

function WorkCreator({ workspace, onCreate, onCancel, busy }: { workspace: Workspace; onCreate: (data: Record<string, unknown>) => Promise<void>; onCancel: () => void; busy: boolean }) {
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [audience, setAudience] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('explanation');
  const [accountPositioning, setAccountPositioning] = useState(workspace.positioning);
  const [constraints, setConstraints] = useState('');
  const [materials, setMaterials] = useState<MaterialInput[]>([]);
  const updateMaterial = (id: string, field: keyof MaterialInput, value: string) => setMaterials(items => items.map(item => item.id === id ? { ...item, [field]: value } : item));
  return <form className="form-card work-form" onSubmit={async e => {
    e.preventDefault();
    await onCreate({ title, question, audience, purpose, medium: 'article', accountPositioning, constraints,
      materials: materials.map(({ id, title, text, url }) => ({ id, title, text, ...(url.trim() ? { url: url.trim() } : {}) })) });
  }}>
    <div className="section-heading"><div><div className="eyebrow">新作品 / 文章</div><h2>这篇内容为什么值得做？</h2></div><button type="button" className="quiet" onClick={onCancel}>返回作品列表</button></div>
    <p className="muted">先把问题、读者和材料放进同一份上下文。创建作品不会自动调用模型。</p>
    <div className="form-grid">
      <Field label="作品名称"><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="方便自己识别的标题" /></Field>
      <Field label="内容目的"><select value={purpose} onChange={e => setPurpose(e.target.value as Purpose)}>{Object.entries(purposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    </div>
    <Field label="要回答的核心问题"><textarea required maxLength={3000} rows={3} value={question} onChange={e => setQuestion(e.target.value)} placeholder="读者此刻真正困惑的是什么？" /></Field>
    <Field label="目标读者"><textarea required maxLength={1000} rows={2} value={audience} onChange={e => setAudience(e.target.value)} placeholder="他们已有怎样的认识，读完希望发生什么变化？" /></Field>
    <Field label="本篇沿用或调整的账号定位"><textarea required maxLength={3000} rows={3} value={accountPositioning} onChange={e => setAccountPositioning(e.target.value)} /></Field>
    <Field label="边界与要求"><textarea maxLength={3000} rows={2} value={constraints} onChange={e => setConstraints(e.target.value)} placeholder="例如事实边界、篇幅、语气、不能省略的争议。可以留空。" /></Field>
    <div className="materials-heading"><div><h3>材料与来源</h3><p className="muted">粘贴材料原文或摘录；链接只用于记录出处。</p></div><button type="button" className="secondary" disabled={materials.length >= 20} onClick={() => setMaterials(items => [...items, { id: crypto.randomUUID(), title: '', text: '', url: '' }])}>添加材料</button></div>
    {materials.map((item, index) => <div className="material-form" key={item.id}>
      <div className="section-heading"><strong>材料 {index + 1}</strong><button type="button" className="quiet" onClick={() => setMaterials(items => items.filter(m => m.id !== item.id))}>移除</button></div>
      <Field label="名称"><input required maxLength={200} value={item.title} onChange={e => updateMaterial(item.id, 'title', e.target.value)} /></Field>
      <Field label="来源链接（可选）"><input type="url" maxLength={2000} value={item.url} onChange={e => updateMaterial(item.id, 'url', e.target.value)} placeholder="https://" /></Field>
      <Field label="材料内容"><textarea required maxLength={40000} rows={4} value={item.text} onChange={e => updateMaterial(item.id, 'text', e.target.value)} /></Field>
    </div>)}
    <div className="form-actions"><button type="button" className="secondary" onClick={onCancel}>取消</button><button className="primary" disabled={busy}>保存作品</button></div>
  </form>;
}

function ExecutionOptions({ value, onChange }: { value: ExecutionConfig; onChange: (value: ExecutionConfig) => void }) {
  return <div className="execution-options">
    <div className="form-grid three">
      <Field label="模型"><input required maxLength={100} value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} placeholder="例如 gpt-6-sol" /></Field>
      <Field label="推理强度"><select value={value.reasoningEffort} onChange={e => onChange({ ...value, reasoningEffort: e.target.value as ExecutionConfig['reasoningEffort'] })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field>
      <Field label="自动修订上限"><select value={value.maxRevisions} onChange={e => onChange({ ...value, maxRevisions: Number(e.target.value) })}><option value={0}>0 次</option><option value={1}>1 次</option><option value={2}>2 次</option></select></Field>
    </div>
    <p className="small muted">配置会随本次执行冻结。运行结束后由你决定是否选择或接受稿件。</p>
  </div>;
}

function Definition({ artifact }: { artifact?: Artifact }) {
  if (!artifact) return <p className="muted">内容定义尚未生成。</p>;
  const value = isObject(artifact.payload) ? artifact.payload as Partial<ContentDefinition> : null;
  if (!value) return <p className="prose">{artifact.content}</p>;
  return <div className="definition-grid">
    {([['核心问题', value.question], ['内容承诺', value.promise], ['读者变化', value.audienceChange], ['账号适配', value.accountFit], ['范围取舍', value.scope]] as const).map(([label, content]) => <div key={label}><span className="micro-label">{label}</span><p className="prose">{content || '尚未记录'}</p></div>)}
    <div><span className="micro-label">材料用途</span>{Array.isArray(value.materialRoles) && value.materialRoles.length ? <ul>{value.materialRoles.map((role, index) => <li key={index}><code>{role.sourceId}</code>：{role.use}</li>)}</ul> : <p className="muted">没有关联材料。</p>}</div>
    <div><span className="micro-label">仍需确认</span>{Array.isArray(value.unknowns) && value.unknowns.length ? <ul>{value.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul> : <p className="muted">没有列出未解问题。</p>}</div>
  </div>;
}

function Quality({ artifact }: { artifact?: Artifact }) {
  if (!artifact) return <p className="muted">尚无针对当前执行的审阅记录。</p>;
  const review = isObject(artifact.payload) ? artifact.payload as Partial<Review> : null;
  if (!review) return <p className="prose">{artifact.content}</p>;
  const label = review.verdict === 'pass' ? '审阅通过' : review.verdict === 'revise' ? '建议修订' : '审阅受阻';
  return <div><span className={`status ${review.verdict === 'pass' ? 'ok' : 'warn'}`}>{label}</span><p className="prose">{review.summary}</p>
    {Array.isArray(review.findings) && review.findings.length > 0 && <ul className="findings">{review.findings.map((finding, index) => <li key={index}><span className="micro-label">{{ critical: '严重', major: '重要', minor: '局部' }[finding.severity]}</span>{finding.message}</li>)}</ul>}
    <p className="small muted">这是模型审阅结论，不能替代你的选择或接受。</p></div>;
}

function ExecutionDetails({ workspaceId, job }: { workspaceId: string; job: Job }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Awaited<ReturnType<typeof api.execution>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: number;
    const read = async () => {
      try { setView(await api.execution(workspaceId, job.id, controller.signal)); setError(''); }
      catch (e) { if (!controller.signal.aborted) setError(readableError(e)); }
      if (!controller.signal.aborted && ['queued','running'].includes(job.state)) timer = window.setTimeout(read, 4000);
    };
    void read();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [workspaceId, job.id, job.state, open]);
  return <div className="execution-detail"><button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起运行详情 ↑' : '查看运行详情 ↓'}</button>
    {open && <div className="execution-body">{error && <p className="error" role="alert">{error}</p>}{!view && !error && <p className="muted">正在读取…</p>}{view && <>
      <div className="run-meta"><span>原生状态：{view.state}</span><span>运行 ID：{view.runId || '尚未分配'}</span>{view.workflowId && <span>方法：{view.workflowId} · {view.workflowRevision}</span>}</div>
      {view.error && <p className="error">{view.error}</p>}
      {view.steps.length ? <ol className="steps">{view.steps.map(step => <li key={step.id}><strong>{step.key}</strong><span>{step.kind} · {step.state} · 尝试 {step.attempts} 次</span></li>)}</ol> : <p className="muted">尚无执行步骤。</p>}
    </>}</div>}</div>;
}

function WorkPage({ workspaceId, detail, onCommand, busy }: { workspaceId: string; detail: WorkDetail; onCommand: (action: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const { work, jobs, artifacts, decisions } = detail;
  const drafts = useMemo(() => artifacts.filter(a => a.kind === 'draft').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [artifacts]);
  const [viewDraftId, setViewDraftId] = useState<string | null>(null);
  const draft = drafts.find(a => a.id === viewDraftId) || drafts.find(a => a.id === work.selectedArtifactId) || drafts[0];
  const relatedJob = jobs.find(j => j.id === draft?.jobId);
  const definition = [...artifacts].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).find(a => a.kind === 'definition' && (draft ? a.jobId === draft.jobId : true));
  const review = [...artifacts].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).find(a => a.kind === 'review' && !!draft && a.dependencies.some(id => id === draft.vendorRef.id || id === draft.id));
  const latestJob = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const [config, setConfig] = useState<ExecutionConfig>({ model: '', reasoningEffort: 'medium', maxRevisions: 1 });
  const [feedback, setFeedback] = useState('');
  const [decisionReason, setDecisionReason] = useState('');
  const exactDecisions = decisions.filter(d => d.artifactId === draft?.id && d.sha256 === draft.sha256);
  const accepted = [...exactDecisions].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]?.action === 'accept';
  const selected = work.selectedArtifactId === draft?.id;
  const reviewPassed = isObject(review?.payload) && review.payload.verdict === 'pass' && relatedJob?.state === 'succeeded';
  const currentStatus = !latestJob ? '尚未开始创作' : stateLabels[latestJob.state];
  const next = !latestJob ? '配置模型并开始文章创作。' : latestJob.state === 'running' || latestJob.state === 'queued' ? '等待当前执行完成；初稿出现后即可阅读。' : !draft && latestJob.state === 'failed' ? '查看失败原因；可以更换模型新建执行，或恢复原任务。' : !draft && ['blocked','canceled'].includes(latestJob.state) ? '查看停因，确认配置后从原始输入发起新执行。' : !draft ? '查看执行详情与停因。' : !review ? '阅读当前稿件，等待或检查审阅记录。' : !accepted ? '阅读稿件与审阅意见，提出修订或作出精确版本决定。' : '当前版本已接受。交付与发布仍需单独处理。';
  const canStart = !latestJob || ['blocked','canceled'].includes(latestJob.state) || (latestJob.state === 'failed' && !draft);
  const draftTitle = isObject(draft?.payload) && typeof draft.payload.title === 'string' ? draft.payload.title : '文章草稿';
  return <div className="work-page">
    <div className="work-top"><div><div className="eyebrow">{purposeLabels[work.purpose]} / 文章</div><h2>{work.title}</h2><p className="muted">创建于 {date(work.createdAt)} · 作品 {short(work.id)}</p></div><span className="status neutral">{currentStatus}</span></div>
    <section className="summary-panel" aria-label="作品概览"><div><span className="micro-label">为什么做</span><p>{work.question}</p><p className="small muted">面向 {work.audience}</p></div><div><span className="micro-label">现在有什么</span><p>{draft ? `${draftTitle} · 版本 ${short(draft.sha256)}` : '尚无实际稿件'}</p><p className="small muted">{draft ? `${drafts.length} 个稿件版本 · ${review ? '已有审阅' : '审阅未到达'}` : '创建作品不自动生成内容'}</p></div><div><span className="micro-label">下一步</span><p>{next}</p></div></section>
    <div className="work-columns"><div className="main-column">
      <section className="card"><div className="section-heading"><div><span className="eyebrow">创作依据</span><h3>内容定义</h3></div>{definition && <span className="tiny-id" title={definition.sha256}>版本 {short(definition.sha256)}</span>}</div><Definition artifact={definition} /></section>
      <section className="card article-card"><div className="section-heading"><div><span className="eyebrow">当前阅读</span><h3>实际文章</h3></div>{draft && <span className="tiny-id" title={draft.sha256}>SHA-256 {short(draft.sha256)}</span>}</div>
        {draft ? <><div className="version-strip" aria-label="文章版本">{drafts.map((item, index) => <button type="button" key={item.id} className={item.id === draft.id ? 'active' : ''} onClick={() => setViewDraftId(item.id)} aria-pressed={item.id === draft.id}>版本 {drafts.length - index}{item.id === work.selectedArtifactId ? ' · 已选' : ''}</button>)}</div>
          <div className="article-meta"><span>{date(draft.createdAt)}</span><span>稿件 {short(draft.id)}</span>{relatedJob?.parentArtifactId && <span>修订自 {short(relatedJob.parentArtifactId)}</span>}{accepted && <span className="status ok">用户已接受此版本</span>}{selected && !accepted && <span className="status neutral">用户已选择此版本</span>}</div>
          {isObject(draft.payload) && typeof draft.payload.title === 'string' && typeof draft.payload.body === 'string' ? <article className="article-body"><h2>{(draft.payload as unknown as Draft).title}</h2><div className="prose">{(draft.payload as unknown as Draft).body}</div></article> : <article className="article-body prose">{draft.content}</article>}
          {isObject(draft.payload) && Array.isArray(draft.payload.sourceIds) && draft.payload.sourceIds.length > 0 && <p className="small muted">引用材料：{draft.payload.sourceIds.join('、')}</p>}
        </> : <p className="empty-note">正文生成后会在这里出现。页面仅读取真实资产。</p>}
      </section>
      <section className="card"><span className="eyebrow">质量复核</span><h3>针对当前稿件的审阅</h3><Quality artifact={review} /></section>
      <section className="card"><span className="eyebrow">材料与边界</span><h3>创作输入</h3><p><strong>账号定位：</strong>{work.accountPositioning}</p>{work.constraints && <p><strong>边界：</strong>{work.constraints}</p>}{work.materials.length ? <div className="materials-list">{work.materials.map(m => { const url = m.url && safeSourceUrl(m.url); return <details key={m.id}><summary>{m.title}{url && <span> · 来源链接</span>}</summary>{url && <p><a href={url} target="_blank" rel="noopener noreferrer">打开来源 ↗</a></p>}<p className="prose">{m.text}</p></details>; })}</div> : <p className="muted">本篇没有附加材料。</p>}</section>
    </div><aside className="side-column">
      <section className="card action-card"><span className="eyebrow">创作执行</span><h3>{jobs.length ? '再次修订前确认配置' : '开始第一稿'}</h3><ExecutionOptions value={config} onChange={setConfig} />
        {canStart && <><button className="primary full" disabled={busy || !config.model.trim()} onClick={() => void onCommand(() => api.start(workspaceId, work.id, config))}>{latestJob?.state === 'failed' ? '用当前配置重新开始创作' : latestJob ? '从原始输入新建执行' : '开始创作'}</button>{latestJob && <p className="small muted">这会启动一条新任务；先前的稿件和执行记录仍可查看。</p>}</>}
        {draft && <><hr /><Field label={`对版本 ${short(draft.sha256)} 的修订意见`}><textarea rows={5} maxLength={6000} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="写出需要保留、修正或补证的具体内容" /></Field><button className="primary full" disabled={busy || !feedback.trim() || !config.model.trim() || ['queued','running'].includes(latestJob?.state || '')} onClick={() => void onCommand(async () => { await api.revise(workspaceId, work.id, { ...config, artifactId: draft.id, sha256: draft.sha256, feedback }); setFeedback(''); })}>提交修订</button><p className="small muted">修订将建立关联的新执行，不覆盖现有版本。</p></>}
      </section>
      {draft && <section className="card action-card"><span className="eyebrow">用户决定</span><h3>针对这个精确版本</h3><p className="small muted">稿件 ID {short(draft.id)} · 哈希 {short(draft.sha256)}。选择、接受与退回分别记录，不由审阅结果自动替你决定。</p>
        <Field label="决定理由"><textarea rows={3} maxLength={3000} value={decisionReason} onChange={e => setDecisionReason(e.target.value)} placeholder="为什么选择、接受或退回这一版？" /></Field>
        <div className="decision-buttons">{([['select','选择此稿'], ['accept','接受此版'], ['return','退回修改']] as const).map(([action, label]) => <button type="button" key={action} className={action === 'accept' ? 'primary' : 'secondary'} disabled={busy || !decisionReason.trim() || (action === 'accept' && !reviewPassed)} title={action === 'accept' && !reviewPassed ? '接受需要已完成的执行与针对当前稿件的通过审阅' : undefined} onClick={() => void onCommand(async () => { await api.decide(workspaceId, work.id, { artifactId: draft.id, sha256: draft.sha256, action, reason: decisionReason }); setDecisionReason(''); })}>{label}</button>)}</div>
        {!reviewPassed && <p className="small muted">接受此版需等待执行完成，且这篇稿件的审阅通过。</p>}
        {exactDecisions.length > 0 && <div className="decision-history"><span className="micro-label">这个版本的决定</span>{exactDecisions.map(d => <p key={d.id}><strong>{{ select: '选择', accept: '接受', return: '退回' }[d.action]}</strong> · {date(d.createdAt)}<br />{d.reason}</p>)}</div>}
      </section>}
      <section className="card"><span className="eyebrow">执行历史</span><h3>运行与停因</h3>{jobs.length ? [...jobs].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(job => <div className="job" key={job.id}>
        <div className="section-heading"><strong>{stateLabels[job.state]}</strong><span className="tiny-id">{date(job.createdAt)}</span></div><p className="small muted">{job.model} · {job.reasoningEffort} · 最多 {job.maxRevisions} 次自动修订</p>{job.parentArtifactId && <p className="small muted">关联稿件 {short(job.parentArtifactId)}</p>}{job.error && <p className="error">{job.error}</p>}{job.cancelRequested && job.state === 'running' && <p className="small muted">已请求取消，等待当前步骤停止。</p>}
        <div className="job-actions">{['queued','running'].includes(job.state) && !job.cancelRequested && <button className="quiet" disabled={busy} onClick={() => void onCommand(() => api.cancel(workspaceId, job.id))}>取消执行</button>}{job.state === 'failed' && <button className="quiet" disabled={busy} onClick={() => void onCommand(() => api.resume(workspaceId, job.id))}>尝试恢复</button>}</div><ExecutionDetails workspaceId={workspaceId} job={job} />
      </div>) : <p className="muted">还没有执行记录。</p>}</section>
    </aside></div>
  </div>;
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem('creation-workspace') || '');
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [creatingWork, setCreatingWork] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const workspace = workspaces.find(w => w.id === workspaceId);
  const reload = () => setRefresh(value => value + 1);
  const command = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); reload(); }
    catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { const controller = new AbortController(); api.workspaces(controller.signal).then(items => { setWorkspaces(items); if (items.length && !items.some(item => item.id === workspaceId)) setWorkspaceId(items[0].id); }).catch(e => { if (!controller.signal.aborted) setError(readableError(e)); }); return () => controller.abort(); }, [refresh]);
  useEffect(() => { localStorage.setItem('creation-workspace', workspaceId); setWorkId(''); setDetail(null); setCreatingWork(false); if (!workspaceId) { setWorks([]); return; } const controller = new AbortController(); api.works(workspaceId, controller.signal).then(setWorks).catch(e => { if (!controller.signal.aborted) setError(readableError(e)); }); return () => controller.abort(); }, [workspaceId]);
  useEffect(() => { if (!workspaceId || !workId) { setDetail(null); return; } const controller = new AbortController(); let timer: number; const read = async () => { try { setDetail(await api.detail(workspaceId, workId, controller.signal)); } catch (e) { if (!controller.signal.aborted) setError(readableError(e)); } if (!controller.signal.aborted) timer = window.setTimeout(read, 4000); }; void read(); return () => { controller.abort(); window.clearTimeout(timer); }; }, [workspaceId, workId, refresh]);
  const createWorkspace = async (name: string, positioning: string) => { await command(async () => { const created = await api.createWorkspace(name, positioning); setCreatingWorkspace(false); setWorkspaceId(created.id); reload(); }); };
  const createWork = async (data: Record<string, unknown>) => { await command(async () => { const created = await api.createWork(workspaceId, data); setWorks(items => [created, ...items]); setCreatingWork(false); setWorkId(created.id); }); };
  return <div className="shell"><header className="topbar"><div className="brand"><span className="brand-mark">C<span>·</span></span><div><strong>Creator Lab</strong><small>创作工作台</small></div></div><div className="topbar-right"><span className="medium-badge">文章工作流 · 视频待后续里程碑</span><span className="topbar-date">从问题到作品</span></div></header>
    <div className="layout"><nav className="sidebar" aria-label="工作区与作品"><div className="sidebar-top"><div className="eyebrow">WORKSPACE</div><h1>你的创作空间</h1><p>把目的、材料、稿件和决定放在一起。</p></div>
      {workspaces.length > 0 && <><Field label="当前工作区"><select value={workspaceId} onChange={e => { setWorkspaceId(e.target.value); setCreatingWorkspace(false); }}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>{workspace && <p className="positioning">{workspace.positioning}</p>}<button type="button" className="new-workspace" onClick={() => { setCreatingWorkspace(true); setCreatingWork(false); setWorkId(''); }}>＋ 新建工作区</button></>}
      {workspace && <div className="sidebar-works"><div className="section-heading"><span className="micro-label">作品</span><button type="button" className="add-button" onClick={() => { setCreatingWorkspace(false); setCreatingWork(true); setWorkId(''); }} aria-label="创建新作品">＋</button></div><button className={`work-link ${!workId && !creatingWork && !creatingWorkspace ? 'current' : ''}`} onClick={() => { setCreatingWorkspace(false); setWorkId(''); setCreatingWork(false); }}>作品总览</button>{works.map(work => <button key={work.id} className={`work-link ${work.id === workId && !creatingWorkspace ? 'current' : ''}`} onClick={() => { setCreatingWorkspace(false); setWorkId(work.id); setCreatingWork(false); }}><span>{work.title}</span><small>{purposeLabels[work.purpose]} · 文章</small></button>)}</div>}
      <div className="sidebar-bottom">真实资产 · 精确版本 · 明确决定</div></nav>
      <main className="content"><div className="page-intro"><div><span className="eyebrow">CREATION / LAB</span><h1>{creatingWorkspace ? '创建新的工作区' : detail ? '继续这篇作品' : creatingWork ? '开启一篇作品' : workspace ? '先从值得做的问题出发' : '欢迎来到创作工作台'}</h1></div><div className="intro-line" /></div>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" className="quiet" onClick={() => setError('')}>关闭</button></div>}
        {(!workspace || creatingWorkspace) && <WorkspaceCreator onCreate={createWorkspace} onCancel={workspace ? () => setCreatingWorkspace(false) : undefined} busy={busy} />}
        {workspace && !creatingWorkspace && creatingWork && <WorkCreator key={workspace.id} workspace={workspace} onCreate={createWork} onCancel={() => setCreatingWork(false)} busy={busy} />}
        {workspace && !creatingWorkspace && !creatingWork && workId && detail?.work.id === workId && <WorkPage key={workId} workspaceId={workspaceId} detail={detail} onCommand={command} busy={busy} />}
        {workspace && !creatingWorkspace && !creatingWork && workId && !detail && <p className="empty-note">正在读取作品…</p>}
        {workspace && !creatingWorkspace && !creatingWork && !workId && <div className="overview"><section className="overview-hero"><div className="eyebrow">YOUR NEXT STORY</div><h2>把一个问题，做成值得阅读的作品。</h2><p>先明确读者要理解什么，再对照真实材料写出内容定义和文章。草稿、审阅、修订与选择都有可追溯的版本。</p><button className="primary" onClick={() => setCreatingWork(true)}>＋ 创建文章作品</button></section><section className="card overview-list"><div className="section-heading"><div><span className="eyebrow">作品目录</span><h3>{works.length ? `${works.length} 篇作品` : '还没有作品'}</h3></div></div>{works.length ? works.map(work => <button className="overview-work" key={work.id} onClick={() => setWorkId(work.id)}><span><strong>{work.title}</strong><small>{work.question}</small></span><span>打开 ↗</span></button>) : <p className="muted">创建第一篇作品后，这里会显示真实的创作记录。</p>}</section></div>}
      </main></div>
  </div>;
}
