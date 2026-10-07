import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { CaseInput, ControlRun, StoredArtifact, Review, WorkflowId } from '../../../../src/workbench/contracts.js';
import { api, type CaseResponse, type Execution, type Session, type WorkflowList } from './api.js';

type View = 'home' | 'artifact' | 'compare' | 'experiment' | 'execution';
type Obj = Record<string, unknown>;
const obj = (value:unknown):Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const str = (value:unknown) => value == null ? '' : String(value);
const arr = (value:unknown):unknown[] => Array.isArray(value) ? value : [];
const short = (value:string) => value.length > 12 ? `${value.slice(0,8)}…` : value;
const when = (value:string|null|undefined) => value ? new Date(value).toLocaleString('zh-CN') : '—';
const status:Record<string,string> = {queued:'排队中',running:'运行中',succeeded:'已完成',failed:'失败',interrupted:'已中断',canceled:'已取消',blocked:'受阻',needs_review:'待审阅'};
const artifactNames:Record<string,string> = {'content-draft':'完整内容稿','content-research':'研究材料与缺口','content-review':'主编审阅','content-fact-check':'事实核查','content-cold-reader':'冷读体验','b3-video':'完整成片','b3-design':'制作设计','b3-inspection':'成片检查'};
const isDeliverable = (artifact:StoredArtifact) => artifact.nativeRef.type==='content-draft'||artifact.nativeRef.type==='b3-video';
const artifactName = (artifact:StoredArtifact) => str(obj(artifact.payload).script && obj(obj(artifact.payload).script).title || obj(artifact.nativeRef).title || artifactNames[artifact.nativeRef.type] || artifact.nativeRef.type);
function uiError(message:string):string{
  const translations:Array<[string,string]>=[
    ['B3 template and reference directories are not configured','服务器尚未配置 B3 制作模板和参考作品目录。'],
    ['Configured B3 template or reference directory is missing','服务器配置的 B3 模板或参考作品目录不存在。'],
    ['Configured B3 template or reference files are incomplete','B3 模板或参考作品文件不完整。'],
    ['B3 template and reference directories must be configured on the server','服务器必须先配置 B3 模板和参考作品目录。'],
    ['Configured B3 template has no scripts/new-episode.sh','B3 模板缺少生成新作品的脚本。'],
    ['B3 template did not create an episode directory','B3 模板未能建立本次制作目录。'],
    ['Linux production needs a configured supported TTS voice','Linux 服务器尚未配置可用的配音服务。'],
    ['B3 placeholder voice uses macOS say and cannot run on Linux','Linux 服务器不能使用本机占位配音，请配置可用的配音服务。'],
    ['B3 minimax voice requires server-side MINIMAX_API_KEY','服务器缺少 MiniMax 配音凭证。'],
    ['Run has no final, converged creator gate','本轮还未通过完整内容检查，请查看运行记录并完成修订。'],
    ['Content feedback requires an exact baseline run','提供上轮反馈前，请选择一轮有完整内容稿的基线运行。'],
    ['Feedback baseline has no content draft','所选基线运行没有完整内容稿。'],
    ['Feedback baseline draft is incomplete','所选基线稿件不完整，无法用于本轮反馈。'],
  ];
  return translations.find(([source])=>message.includes(source))?.[1]||message;
}
const passingHumanReview = (reviews:Review[],artifact:StoredArtifact) => reviews.filter(r=>r.artifactId===artifact.id&&r.sha256===artifact.sha256&&r.actor.kind==='user'&&r.verdict==='pass').at(-1);
function activeArtifact(detail:CaseResponse,workflowId:WorkflowId):StoredArtifact|undefined{
  let current:StoredArtifact|undefined;
  for(const decision of detail.decisions){const input=decision.input;if(input.kind!=='artifact')continue;const artifact=detail.artifacts.find(a=>a.id===input.artifactId&&a.sha256===input.sha256);if(!artifact||detail.runs.find(r=>r.id===artifact.runId)?.workflowId!==workflowId)continue;if(input.action==='adopt')current=artifact;if(input.action==='reject'&&current?.id===artifact.id)current=undefined;}
  return current;
}
function activeWorkflowRevision(detail:CaseResponse,workflowId:WorkflowId):string|undefined{
  let current:string|undefined;
  for(const decision of detail.decisions){const input=decision.input;if(input.kind!=='workflow'||!detail.runs.some(r=>r.workflowId===workflowId&&r.revisionId===input.revisionId))continue;if(input.action==='adopt'||input.action==='rollback')current=input.revisionId;}
  return current;
}
function exactReviewBaseline(detail:CaseResponse,artifact:StoredArtifact):StoredArtifact|undefined{
  const run=detail.runs.find(item=>item.id===artifact.runId);
  const baselineRunId=run?.config.baselineRunId;
  if(!baselineRunId)return undefined;
  const baselineRun=detail.runs.find(item=>item.id===baselineRunId&&item.workflowId===run.workflowId);
  if(!baselineRun)return undefined;
  const matching=detail.artifacts.filter(item=>item.runId===baselineRun.id&&item.nativeRef.type===artifact.nativeRef.type);
  if(artifact.nativeRef.type==='content-draft'){
    const finalId=str(obj(obj(baselineRun.terminal).details).draft&&obj(obj(obj(baselineRun.terminal).details).draft).id);
    return matching.find(item=>item.id===finalId)||matching.at(-1);
  }
  return matching.at(-1);
}
function Field({label,children,hint}: {label:string;children:ReactNode;hint?:string}) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Empty({children}: {children:ReactNode}) { return <p className="empty">{children}</p>; }
function Notice({error}: {error:string|null}) { return error && <p className="notice error" role="alert">{error}</p>; }
function Text({value}: {value:unknown}) { return <span className="prewrap">{str(value) || '—'}</span>; }
function Details({title,children}: {title:string;children:ReactNode}) { return <details className="details"><summary>{title}</summary><div className="detailBody">{children}</div></details>; }
function Kv({items}: {items:Array<[string,unknown]>}) { return <dl className="kv">{items.map(([k,v])=><div key={k}><dt>{k}</dt><dd><Text value={v}/></dd></div>)}</dl>; }
function JsonDetail({title,value}: {title:string;value:unknown}) { return <Details title={title}><pre className="json">{JSON.stringify(value,null,2)}</pre></Details>; }

function ArtifactBody({artifact,compact=false}: {artifact:StoredArtifact;compact?:boolean}) {
  const payload=obj(artifact.payload), script=obj(payload.script);
  const decision=obj(payload.decision);
  const segments=arr(script.segments);
  const role=artifactNames[artifact.nativeRef.type]||artifact.nativeRef.type;
  if (segments.length) return <article className="manuscript">
    <div className="eyebrow">{role} · {short(artifact.id)} · {when(artifact.createdAt)}</div>
    <h2>{str(script.title) || '未命名稿件'}</h2>
    <p className="cover">封面文字　{str(script.coverText)}</p>
    <p className="muted">预计 {str(script.estimatedSeconds)} 秒 · 版本校验 {short(artifact.sha256)}</p>
    <div className="segments">{segments.map((entry,index)=>{const s=obj(entry);return <section className="segment" key={index}><span className="segmentIndex">{String(index+1).padStart(2,'0')}<br/><small>{str(s.time)}</small></span><div><h3>口播</h3><p><Text value={s.voiceover}/></p><div className="segmentMeta"><p><b>屏幕文字</b><br/><Text value={s.onScreenText}/></p><p><b>画面意图</b><br/><Text value={s.visual}/></p></div></div></section>;})}</div>
    {!compact && <><Details title="内容决定与表达设计"><Kv items={[
      ['核心问题',decision.coreQuestion],['一句话答案',decision.oneLineAnswer],['目标读者',decision.audience],['读者看完后的变化',decision.audienceChange],['开头',decision.hook],['账号角度',decision.accountAngle],['形式',decision.form],['最大风险',decision.biggestRisk],['本版变化',script.changesFromPrevious]
    ]}/>{arr(decision.beats).length>0 && <div className="subList"><h4>表达节拍</h4>{arr(decision.beats).map((beat,i)=>{const b=obj(beat);return <p key={i}><b>{str(b.beat)}</b>　{str(b.says)} <span className="muted">{str(b.visualIdea)}</span></p>;})}</div>}</Details><Details title="来源与未解问题"><Kv items={[["使用的来源",arr(script.sourcesUsed).join('、')],["未解问题",arr(decision.openQuestions).join('、')],["没有展开",arr(decision.notSaying).join('、')]]}/></Details></>}
  </article>;
  const type=artifact.nativeRef.type;
  const label=artifactNames;
  const names:Record<string,string>={questions:'问题与证据',notes:'核实的来源',remainingGaps:'剩余证据缺口',verdict:'结论',route:'返工路径',criteria:'标准逐项检查',questionCoverage:'必答问题覆盖',mustChange:'必须修改',summary:'结论摘要',issues:'事实问题',retell:'复述',oneLineAnswerAsUnderstood:'理解的一句话答案',unansweredQuestions:'仍未解答的问题',lostAt:'理解断点',boredAt:'节奏断点',mostMemorable:'最深印象'};
  return <article className="manuscript"><div className="eyebrow">{label[type]||role} · {short(artifact.id)} · {when(artifact.createdAt)}</div><h2>{str(payload.title || obj(artifact.nativeRef).title || label[type] || '运行产物')}</h2>{type==='b3-video' && <video className="video" src={api.media(artifact.id,0)} controls preload="metadata"/>}{Object.entries(payload).map(([key,value])=><Details key={key} title={names[key]||key}>{typeof value==='string' || typeof value==='number' ? <p><Text value={value}/></p> : Array.isArray(value) ? value.map((entry,index)=><div className="material" key={index}>{typeof entry==='string'?<p>{entry}</p>:<Kv items={Object.entries(obj(entry)).map(([k,v])=>[names[k]||k,typeof v==='object'?JSON.stringify(v):v])}/>}</div>):<pre className="json">{JSON.stringify(value,null,2)}</pre>}</Details>)}</article>;
}

function NewCase({onCreate}: {onCreate:(input:CaseInput)=>Promise<void>}) {
  const [form,setForm]=useState({title:'',opportunity:'',readerGoal:'',requiredQuestions:'',accountName:'',positioning:'',audience:'',form:'短视频',materials:'',webResearch:false,maxSeconds:''});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const set=(key:keyof typeof form,value:string|boolean)=>setForm(current=>({...current,[key]:value}));
  async function submit(event:FormEvent) { event.preventDefault();setBusy(true);setError(null);try {const input:CaseInput={title:form.title.trim(),opportunity:form.opportunity.trim(),readerGoal:form.readerGoal.trim(),requiredQuestions:form.requiredQuestions.split('\n').map(x=>x.trim()).filter(Boolean),account:{name:form.accountName.trim(),positioning:form.positioning.trim(),currentAudience:form.audience.trim(),referencePieces:[]},form:form.form.trim(),materials:form.materials.trim()? [{id:'material-1',title:'初始材料',text:form.materials.trim()}]:[],webResearch:form.webResearch,...(form.maxSeconds?{maxSeconds:Number(form.maxSeconds)}:{})};await onCreate(input);}catch(e){setError(String(e instanceof Error?e.message:e));}finally{setBusy(false);} }
  return <form className="form" onSubmit={submit}><h3>建立内容案例</h3><p className="muted">保存业务输入，不会启动模型。可以稍后从案例里明确发起第一轮。</p><div className="formGrid"><Field label="案例标题"><input required value={form.title} onChange={e=>set('title',e.target.value)}/></Field><Field label="内容形式"><input required value={form.form} onChange={e=>set('form',e.target.value)}/></Field></div><Field label="这次机会是什么"><textarea required rows={3} value={form.opportunity} onChange={e=>set('opportunity',e.target.value)}/></Field><Field label="读者看完应获得什么"><textarea required rows={2} value={form.readerGoal} onChange={e=>set('readerGoal',e.target.value)}/></Field><Field label="必须回答的问题" hint="每行一个，至少一个"><textarea required rows={3} value={form.requiredQuestions} onChange={e=>set('requiredQuestions',e.target.value)}/></Field><div className="formGrid"><Field label="账号名称"><input required value={form.accountName} onChange={e=>set('accountName',e.target.value)}/></Field><Field label="当前受众"><input required value={form.audience} onChange={e=>set('audience',e.target.value)}/></Field></div><Field label="账号定位"><textarea required rows={2} value={form.positioning} onChange={e=>set('positioning',e.target.value)}/></Field><Field label="已有材料" hint="粘贴可供工作流使用的原始材料。首轮至少提供一份材料。"><textarea required rows={5} value={form.materials} onChange={e=>set('materials',e.target.value)}/></Field><div className="inlineFields"><label className="check"><input type="checkbox" checked={form.webResearch} onChange={e=>set('webResearch',e.target.checked)}/>允许联网研究</label><Field label="最长时长（秒，可选）"><input type="number" min="1" value={form.maxSeconds} onChange={e=>set('maxSeconds',e.target.value)}/></Field></div><Notice error={error}/><button disabled={busy}>{busy?'保存中…':'建立案例'}</button></form>;
}

function ReviewForm({artifact,baseline,onSave}: {artifact:StoredArtifact;baseline?:StoredArtifact;onSave:(value:{good:string;bad:string;improvement:string;unsatisfied:string;verdict:'pass'|'fail'|'uncertain';standardVersion:string;visibleMaterials:string[]})=>Promise<void>}) {
  const [form,setForm]=useState({good:'',bad:'',improvement:baseline?'':'建立基线：本轮没有上一版可比。',unsatisfied:'',verdict:'uncertain' as 'pass'|'fail'|'uncertain',standardVersion:'creator-v1',visibleMaterials:''});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const set=(k:keyof typeof form,v:string)=>setForm(f=>({...f,[k]:v}));
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError(null);try{await onSave({...form,visibleMaterials:form.visibleMaterials.split('\n').map(x=>x.trim()).filter(Boolean)});}catch(e){setError(String(e instanceof Error?e.message:e));}finally{setBusy(false);}}
  return <form className="form reviewForm" onSubmit={submit}><h3>四问评价</h3><p className="muted">评价绑定当前确切产物 {short(artifact.id)}。请写明段落、时间点或具体表达；保存评价不会采用产物。</p><Field label="好在哪里 · 要保留什么"><textarea required rows={3} placeholder="例如：第 2 段的机制解释…" value={form.good} onChange={e=>set('good',e.target.value)}/></Field><Field label="不好在哪里 · 影响是什么"><textarea required rows={3} value={form.bad} onChange={e=>set('bad',e.target.value)}/></Field><Field label="相对上一版提升、退步或无法判断"><textarea required rows={3} value={form.improvement} onChange={e=>set('improvement',e.target.value)}/></Field><Field label="仍不满意或还没有证据判断的地方"><textarea required rows={3} value={form.unsatisfied} onChange={e=>set('unsatisfied',e.target.value)}/></Field><div className="formGrid"><Field label="结论"><select value={form.verdict} onChange={e=>set('verdict',e.target.value)}><option value="uncertain">待定</option><option value="pass">通过</option><option value="fail">不通过</option></select></Field><Field label="评价标准版本"><input required value={form.standardVersion} onChange={e=>set('standardVersion',e.target.value)}/></Field></div><Details title="评价时可见的材料"><Field label="材料范围，每行一项"><textarea rows={2} value={form.visibleMaterials} onChange={e=>set('visibleMaterials',e.target.value)}/></Field></Details><Notice error={error}/><button disabled={busy}>{busy?'保存中…':'保存人工评价'}</button></form>;
}

function AdoptionControl({artifact,reviews,current,onDecide}: {artifact:StoredArtifact;reviews:Review[];current:boolean;onDecide:(action:'adopt'|'reject',reviewId:string,reason:string)=>Promise<void>}){
  const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const humanReview=passingHumanReview(reviews,artifact);
  async function decide(action:'adopt'|'reject'){
    if(!humanReview)return;
    setBusy(true);setError(null);
    try{await onDecide(action,humanReview.id,reason.trim());setReason('');}catch(e){setError(uiError(String(e instanceof Error?e.message:e)));}finally{setBusy(false);}
  }
  return <section className="section adoption"><h2>产物采用</h2><p>采用只作用于这份确切产物；评价不会自动启动制作或发布。</p>{current&&<p className="notice success">当前采用的是这份产物。</p>}<Field label={current?'撤回采用的理由':'采用理由'}><textarea rows={3} value={reason} onChange={e=>setReason(e.target.value)}/></Field><button disabled={busy||!reason.trim()||!humanReview} onClick={()=>void decide(current?'reject':'adopt')}>{current?'明确撤回这份产物':'明确采用这份产物'}</button>{!humanReview&&<small>需要这份确切产物的人工“通过”评价；外部 Agent A 或未通过的评价不能代替。</small>}<Notice error={error}/></section>;
}

function ExperimentForm({detail,capabilities,onStart}: {detail:CaseResponse;capabilities:WorkflowList['capabilities'];onStart:(input:Omit<import('../../../../src/workbench/contracts.js').RunRequest,'commandId'>)=>Promise<void>}) {
  const [workflowId,setWorkflowId]=useState<WorkflowId>('creation.content');
  const [baselineRunId,setBaselineRunId]=useState('');
  const [hypothesis,setHypothesis]=useState(''),[feedback,setFeedback]=useState('');
  const [model,setModel]=useState('gpt-6-sol');
  const [workerEffort,setWorkerEffort]=useState<'low'|'medium'|'high'>('medium');
  const [judgeEffort,setJudgeEffort]=useState<'low'|'medium'|'high'>('high');
  const [maxRevisions,setMaxRevisions]=useState(2);
  const [scope,setScope]=useState<'sample'|'full'>('full');
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const baselineRuns=detail.runs.filter(run=>run.workflowId===workflowId&&detail.artifacts.some(a=>a.runId===run.id&&isDeliverable(a)));
  const selectedBaseline=baselineRuns.find(run=>run.id===baselineRunId);
  const adoptedContent=activeArtifact(detail,'creation.content')?.nativeRef.type==='content-draft';
  const b3Ready=adoptedContent&&capabilities.productionAvailable;
  function selectWorkflow(next:WorkflowId){setWorkflowId(next);setBaselineRunId('');setFeedback('');}
  function selectBaseline(next:string){setBaselineRunId(next);if(!next)setFeedback('');}
  async function submit(event:FormEvent){
    event.preventDefault();setBusy(true);setError(null);
    try{await onStart({workflowId,model:model.trim(),workerEffort,judgeEffort,maxRevisions,hypothesis:hypothesis.trim(),...(selectedBaseline?{baselineRunId:selectedBaseline.id}:{}),...(workflowId==='creation.content'&&selectedBaseline&&feedback.trim()?{feedback:feedback.trim()}:{}),...(workflowId==='creation.b3'?{production:{scope,voice:capabilities.placeholderVoice?'placeholder':'minimax'}}:{})});}
    catch(e){setError(uiError(String(e instanceof Error?e.message:e)));}finally{setBusy(false);}
  }
  return <form className="form" onSubmit={submit}>
    <h3>发起下一轮</h3><p className="muted">选择基线，写出一个主要改善假设。只有点击“启动”才会运行工作流。</p>
    <div className="formGrid">
      <Field label="工作流"><select value={workflowId} onChange={e=>selectWorkflow(e.target.value as WorkflowId)}><option value="creation.content">内容形成</option><option value="creation.b3" disabled={!b3Ready}>B3 制作{!b3Ready?' · 尚不可用':''}</option></select></Field>
      <Field label="比较基线"><select value={selectedBaseline?.id||''} onChange={e=>selectBaseline(e.target.value)}><option value="">首轮：建立基线</option>{baselineRuns.map(run=><option key={run.id} value={run.id}>{short(run.id)} · {when(run.createdAt)} · {status[run.state]||run.state}</option>)}</select></Field>
    </div>
    {workflowId==='creation.b3'&&<Field label="制作范围"><select value={scope} onChange={e=>setScope(e.target.value as 'sample'|'full')}><option value="full">完整制作</option><option value="sample">样片</option></select></Field>}
    {!b3Ready&&<p className="notice">B3 需先有明确采用的内容稿，且服务器制作模板可用。{capabilities.productionReason?uiError(capabilities.productionReason):''}</p>}
    <Field label="这轮要验证的改善假设"><textarea required rows={3} value={hypothesis} onChange={e=>setHypothesis(e.target.value)}/></Field>
    {workflowId==='creation.content'&&selectedBaseline&&<Field label="上轮反馈或修订依据"><textarea rows={3} value={feedback} onChange={e=>setFeedback(e.target.value)}/></Field>}
    <Details title="高级设置 · 模型与执行配置"><div className="formGrid"><Field label="模型"><input required value={model} onChange={e=>setModel(e.target.value)} placeholder="输入当前服务器可用的模型"/></Field><Field label="最多修订轮数"><input type="number" min="0" max="5" value={maxRevisions} onChange={e=>setMaxRevisions(Number(e.target.value))}/></Field><Field label="执行强度"><select value={workerEffort} onChange={e=>setWorkerEffort(e.target.value as 'low'|'medium'|'high')}>{['low','medium','high'].map(value=><option key={value}>{value}</option>)}</select></Field><Field label="审阅强度"><select value={judgeEffort} onChange={e=>setJudgeEffort(e.target.value as 'low'|'medium'|'high')}>{['low','medium','high'].map(value=><option key={value}>{value}</option>)}</select></Field></div></Details>
    <Notice error={error}/><button disabled={busy||(workflowId==='creation.b3'&&!b3Ready)}>{busy?'启动中…':'明确启动本轮'}</button>
  </form>;
}

function mergeEvents(existing:unknown[],incoming:unknown[]):unknown[]{
  const bySeq=new Map<number,unknown>();
  for(const event of [...existing,...incoming])bySeq.set(Number(obj(event).seq),event);
  return [...bySeq.entries()].sort((a,b)=>a[0]-b[0]).map(([,event])=>event);
}

function ExecutionView({run}: {run:ControlRun}) {
  const [data,setData]=useState<Execution|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [trace,setTrace]=useState<Record<string,string>>({});
  const [loading,setLoading]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [moreBusy,setMoreBusy]=useState(false);
  const reload=useCallback(async()=>{
    try{
      const page=await api.execution(run.id);
      setData(current=>current?{...page,events:mergeEvents(current.events,page.events),hasMoreEvents:current.events.length>=page.events.length?current.hasMoreEvents:page.hasMoreEvents}:page);
      setError(null);
    }catch(e){setError(String(e instanceof Error?e.message:e));}
  },[run.id]);
  useEffect(()=>{void reload();},[reload]);
  useEffect(()=>{if(run.state!=='running'&&run.state!=='queued')return;const timer=window.setInterval(()=>{void reload();},8000);return()=>window.clearInterval(timer);},[run.state,reload]);
  async function loadMore(){
    if(!data||moreBusy)return;
    setMoreBusy(true);
    try{
      const afterSeq=Number(obj(data.events.at(-1)).seq||0);
      const page=await api.execution(run.id,afterSeq);
      setData(current=>current?{...page,events:mergeEvents(current.events,page.events)}:page);
      setError(null);
    }catch(e){setError(String(e instanceof Error?e.message:e));}finally{setMoreBusy(false);}
  }
  async function action(kind:'cancel'|'resume'){
    setBusy(true);
    try{if(kind==='cancel')await api.cancel(run.id);else await api.resume(run.id);await reload();}
    catch(e){setError(String(e instanceof Error?e.message:e));}
    finally{setBusy(false);}
  }
  async function openTrace(stepId:string,attemptId:string,file:string){
    const key=[stepId,attemptId,file].join('/');setLoading(key);
    try{const result=await api.trace(run.id,stepId,attemptId,file);setTrace(x=>({...x,[key]:result.content+(result.truncated?'\n\n[记录已截断]':'')}));}
    catch(e){setError(String(e instanceof Error?e.message:e));}
    finally{setLoading(null);}
  }
  return <div className="reading">
    <div className="eyebrow">运行记录 · {short(run.id)}</div>
    <h2>{run.workflowId==='creation.content'?'内容形成':'B3 制作'} · {status[run.state]||run.state}</h2>
    <Kv items={[["开始",when(run.startedAt)],["完成",when(run.finishedAt)],["本次流程版本",short(run.revisionId)],["本次目标",run.config.hypothesis],["错误",run.error]]}/>
    {['queued','running'].includes(run.state)&&<button className="secondary" disabled={busy} onClick={()=>void action('cancel')}>取消运行</button>}
    {['failed','interrupted'].includes(run.state)&&<button className="secondary" disabled={busy} onClick={()=>void action('resume')}>尝试恢复</button>}
    <Notice error={error}/>
    {!data&&!error&&<Empty>正在读取运行记录…</Empty>}
    {data&&<>
      <h3>步骤与尝试</h3>
      {data.steps.length===0?<Empty>还没有步骤记录。</Empty>:data.steps.map((step,index)=><JsonDetail key={index} title={`步骤 ${index+1} · ${str(obj(step).title||obj(step).id||'')}`} value={step}/>)}
      <h3>故障</h3>
      {data.incidents.length===0?<Empty>没有记录到故障。</Empty>:data.incidents.map((item,index)=><JsonDetail key={index} title={`故障 ${index+1}`} value={item}/>)}
      <Details title={`事件记录 · 已读取 ${data.events.length} 条`}>
        {data.events.map((item,index)=><JsonDetail key={str(obj(item).id||index)} title={`事件 ${str(obj(item).seq||index+1)}`} value={item}/>)}
        {data.hasMoreEvents&&<button className="secondary" disabled={moreBusy} onClick={()=>void loadMore()}>{moreBusy?'读取中…':'继续读取事件'}</button>}
      </Details>
      <Details title="会话与操作记录"><p className="muted">按需读取原始记录。页面默认只显示文件索引。</p>
        {data.traces.map((item,index)=><div className="traceRow" key={index}><b>{short(item.stepId)} / {short(item.attemptId)}</b>{item.files.map(file=>{const key=[item.stepId,item.attemptId,file.name].join('/');return <div key={file.name}><button className="linkButton" disabled={loading===key} onClick={()=>void openTrace(item.stepId,item.attemptId,file.name)}>{file.name} · {file.bytes} B</button>{trace[key]&&<pre className="json trace">{trace[key]}</pre>}</div>;})}</div>)}
      </Details>
      <JsonDetail title="原生运行索引" value={data.nativeRun}/>
    </>}
  </div>;
}

export default function App(){
  const [session,setSession]=useState<Session|null>(null),[loginToken,setLoginToken]=useState(''),[loginBusy,setLoginBusy]=useState(false),[loginError,setLoginError]=useState<string|null>(null);
  const [catalog,setCatalog]=useState<WorkflowList|null>(null),[cases,setCases]=useState<CaseResponse['case'][]>([]),[detail,setDetail]=useState<CaseResponse|null>(null),[caseId,setCaseId]=useState<string|null>(null),[view,setView]=useState<View>('home'),[artifactId,setArtifactId]=useState(''),[runId,setRunId]=useState(''),[baselineId,setBaselineId]=useState(''),[globalError,setGlobalError]=useState<string|null>(null),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[workflowReason,setWorkflowReason]=useState(''),[compareConclusion,setCompareConclusion]=useState(''),[compareDifferences,setCompareDifferences]=useState(''),[comparisonId,setComparisonId]=useState('');
  useEffect(()=>{api.session().then(setSession).catch(e=>setLoginError(String(e instanceof Error?e.message:e)));},[]);
  const load=useCallback(async(selected:string|null)=>{setRefreshing(true);try{const [list,caseList,selectedCase]=await Promise.all([api.workflows(),api.cases(),selected?api.case(selected):Promise.resolve(null)]);setCatalog(list);setCases(caseList);setDetail(selectedCase);setGlobalError(null);}catch(e){setGlobalError(String(e instanceof Error?e.message:e));}finally{setRefreshing(false);}},[]);
  useEffect(()=>{if(session?.authenticated) void load(caseId);},[session?.authenticated,caseId,load]);
  useEffect(()=>{if(!detail?.runs.some(r=>r.state==='running'||r.state==='queued')) return;const timer=window.setInterval(()=>{void api.case(detail.case.id).then(setDetail).catch(()=>{});},8000);return ()=>window.clearInterval(timer);},[detail?.case.id,detail?.runs.map(r=>r.id+':'+r.state).join('|')]);
  const deliverables=detail?.artifacts.filter(isDeliverable)||[];
  const artifact=detail?.artifacts.find(a=>a.id===artifactId)||(view==='artifact'?deliverables.at(-1):undefined), baseline=detail?.artifacts.find(a=>a.id===baselineId),run=detail?.runs.find(r=>r.id===runId);
  const artifactRun=artifact&&detail?.runs.find(item=>item.id===artifact.runId);
  const reviewBaseline=artifact&&detail?exactReviewBaseline(detail,artifact):undefined;
  const reviewsFor=useCallback((a:StoredArtifact)=>detail?.reviews.filter(r=>r.artifactId===a.id&&r.sha256===a.sha256)||[],[detail]);
  const adopted=useCallback((a:StoredArtifact)=>{if(!detail)return undefined;const workflowId=detail.runs.find(r=>r.id===a.runId)?.workflowId;if(!workflowId||activeArtifact(detail,workflowId)?.id!==a.id)return undefined;return detail.decisions.slice().reverse().find(d=>d.input.kind==='artifact'&&d.input.action==='adopt'&&d.input.artifactId===a.id&&d.input.sha256===a.sha256);},[detail]);
  const contentWorkflowAdoption=detail?activeWorkflowRevision(detail,'creation.content'):undefined;
  const productionWorkflowAdoption=detail?activeWorkflowRevision(detail,'creation.b3'):undefined;
  const perform=async (action:()=>Promise<unknown>)=>{setBusy(true);setGlobalError(null);try{await action();await load(caseId);}catch(e){setGlobalError(uiError(String(e instanceof Error?e.message:e)));throw e;}finally{setBusy(false);}};
  const selectedComparison=detail?.comparisons.find(item=>item.id===comparisonId);
  const validWorkflowTarget=(action:'adopt'|'rollback')=>{
    if(!detail||!selectedComparison)return false;
    const reviewId=action==='rollback'?selectedComparison.baselineReviewId:selectedComparison.candidateReviewId;
    const targetId=action==='rollback'?selectedComparison.baselineArtifactId:selectedComparison.candidateArtifactId;
    const review=detail.reviews.find(item=>item.id===reviewId&&item.artifactId===targetId);
    return review?.actor.kind==='user'&&review.verdict==='pass';
  };
  async function decideWorkflow(action:'adopt'|'rollback'){
    if(!detail||!selectedComparison||!workflowReason.trim()||!validWorkflowTarget(action))return;
    const targetId=action==='rollback'?selectedComparison.baselineArtifactId:selectedComparison.candidateArtifactId;
    const target=detail.artifacts.find(item=>item.id===targetId);
    const revisionId=target&&detail.runs.find(item=>item.id===target.runId)?.revisionId;
    if(!revisionId){setGlobalError('比较记录没有对应的流程版本。');return;}
    await perform(()=>api.decision(detail.case.id,{kind:'workflow',action,revisionId,comparisonId:selectedComparison.id,reason:workflowReason.trim()}));
    setWorkflowReason('');
  }
  if(!session) return <main className="center"><p>正在连接工作台…</p><Notice error={loginError}/></main>;
  if(!session.authenticated) return <main className="loginPage"><div className="loginPanel"><p className="eyebrow">创作工作台 / 私有入口</p><h1>回到作品，继续改进。</h1><p>查看完整稿件、运行依据和每一轮评价。登录后只读取现有记录。</p><form onSubmit={async e=>{e.preventDefault();setLoginBusy(true);setLoginError(null);try{setSession(await api.login(loginToken));setLoginToken('');}catch(error){setLoginError(String(error instanceof Error?error.message:error));}finally{setLoginBusy(false);}}}><Field label="访问令牌"><input type="password" autoComplete="current-password" required value={loginToken} onChange={e=>setLoginToken(e.target.value)}/></Field><Notice error={loginError}/><button disabled={loginBusy}>{loginBusy?'登录中…':'进入工作台'}</button></form></div></main>;
  const pickCase=(id:string)=>{setCaseId(id);setView('home');setArtifactId('');};
  const selectArtifact=(id:string)=>{setArtifactId(id);setView('artifact');};
  return <div className="appShell"><header className="topbar"><div className="brand"><span className="brandMark">创</span><div><strong>创作工作台</strong><small>作品 · 评价 · 改进</small></div></div><div className="topActions"><span className="actor">{session.actor?.kind==='agent'?'外部 Agent A':'人工'} · {session.actor?.id||'已登录'}</span><button className="textButton" onClick={()=>void load(caseId)} disabled={refreshing}>刷新</button><button className="textButton" onClick={async()=>{await api.logout();setSession({authenticated:false,authRequired:true});setDetail(null);setCatalog(null);}}>退出</button></div></header><div className="workspace"><aside className="sidebar"><p className="sideLabel">业务案例</p><button className={`sideItem ${!caseId?'active':''}`} onClick={()=>{setCaseId(null);setView('home');}}>全部案例 <span>{cases.length}</span></button>{cases.map(item=><button className={`sideItem ${caseId===item.id?'active':''}`} key={item.id} onClick={()=>pickCase(item.id)}><span>{item.input.title}</span><small>{when(item.createdAt)}</small></button>)}<div className="sideFoot">内容工作流与 B3 制作<br/>研究、分析可作为独立输入</div></aside><main className="main"><Notice error={globalError}/>{!detail ? <><div className="pageIntro"><div className="eyebrow">WORKFLOW / 创作</div><h1>让每一轮都有依据。</h1><p>选择案例阅读作品与改进记录，或建立一个新的内容案例。</p></div><div className="overview"><section><h2>案例</h2>{cases.length===0?<Empty>还没有案例。建立案例只保存输入，不会运行模型。</Empty>:cases.map(item=><button key={item.id} className="listRow" onClick={()=>pickCase(item.id)}><span><strong>{item.input.title}</strong><small>{item.input.readerGoal}</small></span><span>查看 →</span></button>)}</section><section><h2>当前工作流</h2>{catalog?.workflows.map(w=><div className="listRow static" key={w.workflowId}><span><strong>{w.title}</strong><small>服务版本：{w.deployedRevisionId?short(w.deployedRevisionId):'未载入'} · 定义：{w.revision}</small></span></div>)}</section></div><NewCase onCreate={async input=>{let created:CaseResponse['case']|null=null;await perform(async()=>{created=await api.createCase(input);});if(created)pickCase((created as CaseResponse['case']).id);}}/></> : <><div className="pageIntro caseIntro"><button className="back" onClick={()=>{setCaseId(null);setView('home');}}>← 全部案例</button><div className="eyebrow">案例 / {short(detail.case.id)}</div><h1>{detail.case.input.title}</h1><p>{detail.case.input.readerGoal}</p><div className="statusLine"><span>本案例采用内容流程：{contentWorkflowAdoption?short(contentWorkflowAdoption):'尚未采用'}</span><span>本案例采用制作流程：{productionWorkflowAdoption?short(productionWorkflowAdoption):'尚未采用'}</span><span>当前服务版本：{catalog?.workflows.find(w=>w.workflowId==='creation.content')?.deployedRevisionId ? short(catalog.workflows.find(w=>w.workflowId==='creation.content')!.deployedRevisionId!) : '未载入'}</span><span>运行 {detail.runs.length} 轮 · 产物 {detail.artifacts.length} 份</span></div></div><nav className="tabs" aria-label="案例视图">{([['home','概览'],['artifact','完整作品'],['compare','本轮比较'],['experiment','下一轮实验'],['execution','运行记录']] as const).map(([key,label])=><button key={key} className={view===key?'active':''} onClick={()=>setView(key)}>{label}</button>)}</nav>
  {view==='home' && <div className="reading"><section className="section"><h2>业务目的</h2><Kv items={[["这次机会",detail.case.input.opportunity],["读者目标",detail.case.input.readerGoal],["必答问题",detail.case.input.requiredQuestions.join('；')],["账号定位",detail.case.input.account.positioning],["当前受众",detail.case.input.account.currentAudience]]}/><Details title={`输入材料 · ${detail.case.input.materials.length} 份`}>{detail.case.input.materials.map(m=><div className="material" key={m.id}><b>{m.title}</b><p><Text value={m.text}/></p></div>)}</Details></section><section className="section"><div className="sectionHead"><h2>作品与资产</h2><span>{detail.artifacts.length} 份</span></div>{detail.artifacts.length===0?<Empty>暂无产物。可以在“下一轮实验”明确启动内容工作流。</Empty>:detail.artifacts.slice().reverse().map(a=><button className="listRow" key={a.id} onClick={()=>selectArtifact(a.id)}><span><strong>{artifactName(a)}</strong><small>{when(a.createdAt)} · {short(a.id)} · {adopted(a)?'已采用':'未采用'}</small></span><span>阅读 →</span></button>)}</section><section className="section"><h2>运行与改进历史</h2>{detail.runs.length===0?<Empty>还没有运行。</Empty>:detail.runs.slice().reverse().map(r=><button className="listRow" key={r.id} onClick={()=>{setRunId(r.id);setView('execution');}}><span><strong>{r.workflowId==='creation.content'?'内容形成':'B3 制作'} · {status[r.state]||r.state}</strong><small>{when(r.createdAt)} · 草稿轮次在产物中查看 · 流程 {short(r.revisionId)}</small></span><span>查看 →</span></button>)}<Details title={`评价与采用决定 · ${detail.reviews.length} / ${detail.decisions.length}`}><div className="historyList">{detail.reviews.map(r=><p key={r.id}><b>{r.actor.kind==='agent'?'外部 Agent A':'人工'}评价</b> · {when(r.createdAt)} · {short(r.artifactId)} · {r.verdict}</p>)}{detail.decisions.map(d=><p key={d.id}><b>{d.input.kind==='artifact'?'产物':'流程'}{d.input.action==='adopt'?'采用':d.input.action==='rollback'?'回退':d.input.action==='reject'?'撤回':'观察'}</b> · {when(d.createdAt)} · {d.input.reason}</p>)}</div></Details></section></div>}
  {view==='artifact' && <div className="reading"><div className="picker"><Field label="选择确切产物"><select value={artifact?.id||''} onChange={e=>setArtifactId(e.target.value)}><option value="">选择产物</option>{detail.artifacts.slice().reverse().map(a=><option key={a.id} value={a.id}>{short(a.id)} · {when(a.createdAt)} · {artifactNames[a.nativeRef.type]||a.nativeRef.type}</option>)}</select></Field></div>{!artifact?<Empty>尚无交付产物。可以从上方选择内部证据查看。</Empty>:<><ArtifactBody artifact={artifact}/><section className="section"><h2>评价</h2>{reviewsFor(artifact).map(r=><div className="reviewRecord" key={r.id}><div className="eyebrow">{r.actor.kind==='agent'?'外部 Agent A':'人工'} · {when(r.createdAt)} · {r.verdict}</div><Kv items={[["好在哪里",r.good],["不好在哪里",r.bad],["相对提升",r.improvement],["仍不满意",r.unsatisfied]]}/></div>)}{isDeliverable(artifact)?<>{reviewBaseline&&<p className="notice">本轮基线：{artifactName(reviewBaseline)} · {short(reviewBaseline.id)} · {when(reviewBaseline.createdAt)}　<button className="linkButton" onClick={()=>{setBaselineId(reviewBaseline.id);setArtifactId(artifact.id);setView('compare');}}>并排比较 →</button></p>}{artifactRun?.config.baselineRunId&&!reviewBaseline?<p className="notice error">这轮指定的基线运行没有可用的同类交付产物，暂不能提交与上一轮绑定的评价。</p>:<ReviewForm key={`${artifact.id}:${reviewBaseline?.id||'first'}`} artifact={artifact} baseline={reviewBaseline} onSave={async value=>{await perform(()=>api.review(detail.case.id,{artifactId:artifact.id,sha256:artifact.sha256,...(reviewBaseline?{baselineArtifactId:reviewBaseline.id,baselineSha256:reviewBaseline.sha256}:{}),...value}));}}/>}</>:<p className="muted">这是工作流内部证据；人工四问评价只针对完整内容稿或成片。</p>}</section>{isDeliverable(artifact)&&<AdoptionControl key={artifact.id} artifact={artifact} reviews={detail.reviews} current={Boolean(adopted(artifact))} onDecide={async(action,reviewId,reason)=>{await perform(()=>api.decision(detail.case.id,{kind:'artifact',action,artifactId:artifact.id,sha256:artifact.sha256,reviewId,reason}));}}/>}</>}</div>}
  {view==='compare' && <div className="reading"><div className="eyebrow">确切版本 / 双栏比较</div><h2>比较两份完整产物</h2><p className="muted">首轮可以只做基线评价；多轮时请确认输入、目标、标准、模型和运行条件是否一致。</p><div className="formGrid"><Field label="基线产物"><select value={baselineId} onChange={e=>setBaselineId(e.target.value)}><option value="">选择基线</option>{deliverables.map(a=><option key={a.id} value={a.id}>{short(a.id)} · {when(a.createdAt)}</option>)}</select></Field><Field label="候选产物"><select value={artifactId} onChange={e=>setArtifactId(e.target.value)}><option value="">选择候选</option>{deliverables.map(a=><option key={a.id} value={a.id}>{short(a.id)} · {when(a.createdAt)}</option>)}</select></Field></div>{baseline&&artifact&&baseline.id!==artifact.id&&<><div className="comparison"><div><div className="compareLabel">基线 · {short(baseline.id)}</div><ArtifactBody artifact={baseline} compact/></div><div><div className="compareLabel">候选 · {short(artifact.id)}</div><ArtifactBody artifact={artifact} compact/></div></div><Details title="比较条件"><Kv items={[["同一案例",baseline.caseId===artifact.caseId?'是':'否'],["基线运行",short(baseline.runId)],["候选运行",short(artifact.runId)],["基线流程版本",short(detail.runs.find(r=>r.id===baseline.runId)?.revisionId||'')],["候选流程版本",short(detail.runs.find(r=>r.id===artifact.runId)?.revisionId||'')],["基线输入哈希",detail.runs.find(r=>r.id===baseline.runId)?.inputHash],["候选输入哈希",detail.runs.find(r=>r.id===artifact.runId)?.inputHash]]}/>{detail.runs.find(r=>r.id===baseline.runId)?.inputHash!==detail.runs.find(r=>r.id===artifact.runId)?.inputHash&&<p className="notice">输入不同：这是方案比较，不能把变化单独归因于流程。</p>}</Details><div className="compareReviews"><ReviewForm key={baseline.id} artifact={baseline} onSave={async value=>{await perform(()=>api.review(detail.case.id,{artifactId:baseline.id,sha256:baseline.sha256,...value}));}}/><ReviewForm key={artifact.id} artifact={artifact} baseline={baseline} onSave={async value=>{await perform(()=>api.review(detail.case.id,{artifactId:artifact.id,sha256:artifact.sha256,baselineArtifactId:baseline.id,baselineSha256:baseline.sha256,...value}));}}/></div><section className="section"><h2>比较结论</h2><Field label="条件差异与归因限制"><textarea rows={3} value={compareDifferences} onChange={e=>setCompareDifferences(e.target.value)}/></Field><Field label="这轮的结论"><textarea rows={3} value={compareConclusion} onChange={e=>setCompareConclusion(e.target.value)}/></Field><button disabled={busy||!compareConclusion.trim()||!compareDifferences.trim()||!reviewsFor(baseline).some(r=>r.actor.kind==='user')||!reviewsFor(artifact).some(r=>r.actor.kind==='user')} onClick={()=>void perform(async()=>{await api.comparison(detail.case.id,{baselineArtifactId:baseline.id,baselineSha256:baseline.sha256,candidateArtifactId:artifact.id,candidateSha256:artifact.sha256,baselineReviewId:reviewsFor(baseline).filter(r=>r.actor.kind==='user').at(-1)!.id,candidateReviewId:reviewsFor(artifact).filter(r=>r.actor.kind==='user').at(-1)!.id,conditions:{baselineInputHash:detail.runs.find(r=>r.id===baseline.runId)?.inputHash,candidateInputHash:detail.runs.find(r=>r.id===artifact.runId)?.inputHash,baselineRevisionId:detail.runs.find(r=>r.id===baseline.runId)?.revisionId,candidateRevisionId:detail.runs.find(r=>r.id===artifact.runId)?.revisionId},differences:compareDifferences.trim(),conclusion:compareConclusion.trim()});setCompareConclusion('');setCompareDifferences('');})}>保存比较</button><p className="muted">两份产物都需先有人工四问评价。保存比较不会采用流程版本。</p></section></>}{detail.comparisons.length>0&&<section className="section"><h2>已有比较与流程采用</h2>{detail.comparisons.slice().reverse().map(c=><div className="comparisonRecord" key={c.id}><b>{short(c.baselineArtifactId)} → {short(c.candidateArtifactId)}</b><p>{c.conclusion}</p><small>{c.differences}</small></div>)}<Field label="选择比较记录"><select value={comparisonId} onChange={e=>setComparisonId(e.target.value)}><option value="">选择比较</option>{detail.comparisons.map(c=><option value={c.id} key={c.id}>{short(c.id)} · {when(c.createdAt)}</option>)}</select></Field><Field label="流程采用理由"><textarea rows={3} value={workflowReason} onChange={e=>setWorkflowReason(e.target.value)}/></Field><div className="decisionActions"><button disabled={busy||!comparisonId||!workflowReason.trim()||!validWorkflowTarget('adopt')} onClick={()=>void decideWorkflow('adopt')}>本案例采用候选流程</button><button className="secondary" disabled={busy||!comparisonId||!workflowReason.trim()||!validWorkflowTarget('rollback')} onClick={()=>void decideWorkflow('rollback')}>本案例回退到基线流程</button></div>{comparisonId&&(!validWorkflowTarget('adopt')||!validWorkflowTarget('rollback'))&&<p className="muted">相应一侧需有人工“通过”评价且满足原生产物关口，才能采用或回退。</p>}<p className="muted">流程版本的采用是独立决定；服务当前载入的版本由服务单独记录。单案例改善只说明在此案例观察到改善。</p></section>}</div>}
  {view==='experiment' && <div className="reading"><ExperimentForm detail={detail} capabilities={catalog?.capabilities||{productionAvailable:false,productionReason:'尚未读取服务器能力',placeholderVoice:false}} onStart={async input=>{let created:ControlRun|null=null;await perform(async()=>{created=await api.startRun(detail.case.id,input);});if(created){setRunId((created as ControlRun).id);setView('execution');}}}/></div>}
  {view==='execution' && <div className="reading"><Field label="选择运行"><select value={runId} onChange={e=>setRunId(e.target.value)}><option value="">选择运行</option>{detail.runs.slice().reverse().map(r=><option key={r.id} value={r.id}>{short(r.id)} · {status[r.state]||r.state} · {when(r.createdAt)}</option>)}</select></Field>{run?<ExecutionView key={run.id} run={run}/>:<Empty>选择一轮查看步骤、尝试、故障与按需展开的会话记录。</Empty>}</div>}
  </>}</main></div></div>;
}
