import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Topic,
  Run,
  ResearchSnapshot,
  CollaborationEvent,
  Identity,
} from '../../../packages/contracts/index.js';
import type {
  SafeArtifact,
  StageDetails,
  StageView,
} from '@signal-room/workflow-read-model/contracts';
import {
  artifactTypeLabel,
  collaborationDraftKey,
  decisionLabel,
  label,
  mergeSnapshot,
  readerUrl,
  selectedArtifact,
  stageGroup,
} from './state.js';
import './style.css';

type Changes = Parameters<typeof mergeSnapshot>[1];
const A = '/api';
const uid = () => crypto.randomUUID();
type CollaborationDraft = {
  body: string;
  location: string;
  scope: 'whole' | 'partial';
  scopeLabel: string;
};
const emptyCollaborationDraft: CollaborationDraft = {
  body: '',
  location: '全文',
  scope: 'whole',
  scopeLabel: '整份报告',
};
const collaborationDrafts = new Map<string, CollaborationDraft>();
const showDate = (value?: string) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        hour12: false,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '时间未记录';
async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(A + path, { credentials: 'same-origin', signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || result.message || `请求失败（${response.status}）`);
  return result as T;
}
async function write<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(A + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || result.message || `请求失败（${response.status}）`);
  return result as T;
}
function Pill({ value, tone }: { value?: string; tone?: string }) {
  return <span className={`pill ${tone || ''}`}>{label(value)}</span>;
}
function StageSummary({
  stage,
  artifacts,
  titles,
  selectedId,
  onSelect,
  onDetail,
}: {
  stage: StageView;
  artifacts: SafeArtifact[];
  titles: Record<string, { title: string }>;
  selectedId?: string;
  onSelect: (id: string) => void;
  onDetail: (id: string) => void;
}) {
  const visible = artifacts.filter((item) => stage.artifactIds.includes(item.identity.id));
  return (
    <section className="stage-card">
      <div className="stage-card-top">
        <div>
          <span className="overline">阶段记录</span>
          <h3>{stage.title}</h3>
        </div>
        <Pill value={stage.state} />
      </div>
      {stage.purpose && <p>{stage.purpose}</p>}
      {visible.length ? (
        <div className="stage-assets">
          {visible.map((item) => (
            <button
              type="button"
              className={`asset-row ${selectedId === item.identity.id ? 'active' : ''}`}
              key={item.identity.id}
              onClick={() => onSelect(item.identity.id)}
            >
              <span className="asset-dot" />
              <span>
                {titles[item.identity.id]?.title || artifactTypeLabel(item.type)}
                <small title={`完整版本：${item.identity.revision}`}>
                  {artifactTypeLabel(item.type)} · 版本 {item.identity.revision.slice(0, 8)}
                </small>
              </span>
              <span aria-hidden>↗</span>
            </button>
          ))}
        </div>
      ) : (
        <small className="muted">暂无已发布资产</small>
      )}
      <button type="button" className="plain-link" onClick={() => onDetail(stage.id)}>
        查看执行记录 →
      </button>
    </section>
  );
}
function Reader({
  runId,
  artifact,
  title,
}: {
  runId: string;
  artifact?: SafeArtifact;
  title?: string;
}) {
  if (!artifact)
    return (
      <div className="reader-empty">
        <div className="empty-mark">◇</div>
        <h2>选择一份产物阅读</h2>
        <p>阶段产物一经发布，就会在这里按精确版本展示。</p>
      </div>
    );
  const source = readerUrl(runId, artifact);
  return (
    <div className="reader-paper">
      <div className="reader-paper-head">
        <span className="overline">当前阅读 · {artifactTypeLabel(artifact.type)}</span>
        <a className="reader-open" href={source} target="_blank" rel="noopener noreferrer">
          在新窗口阅读 ↗
        </a>
        <span
          className="mono hash"
          title={`版本 ${artifact.identity.revision} · SHA-256 ${artifact.identity.sha256}`}
        >
          {artifact.identity.revision.slice(0, 8)} · {artifact.identity.sha256.slice(0, 12)}
        </span>
      </div>
      <iframe
        key={source}
        title={title || artifactTypeLabel(artifact.type)}
        src={source}
        sandbox="allow-scripts allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}
function StartForm({
  topic,
  onStart,
  busy,
}: {
  topic: Topic;
  onStart: (payload: {
    title: string;
    goal: string;
    asOf: string;
    sourceIds: string[];
  }) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState(topic.title);
  const [goal, setGoal] = useState(topic.goal);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    setTitle(topic.title);
    setGoal(topic.goal);
    setIds([]);
  }, [topic.id]);
  return (
    <form
      className="start-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onStart({ title, goal, asOf, sourceIds: ids });
      }}
    >
      <div className="form-grid">
        <label>
          研究标题
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          信息截至
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
        </label>
      </div>
      <label>
        需要回答的问题
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          minLength={10}
          maxLength={12000}
          rows={4}
          required
        />
      </label>
      <div className="form-grid">
        <label>
          执行模型
          <input value="gpt-5.6-luna" readOnly aria-label="执行模型" />
        </label>
        <label>
          推理设置
          <input value="标准" readOnly aria-label="推理设置" />
        </label>
      </div>
      <fieldset>
        <legend>
          已登记材料 <span className="muted">已选 {ids.length} / 最多 30</span>
        </legend>
        <div className="source-tools">
          <span>请挑选与本次问题直接相关的来源</span>
          <button type="button" className="plain-link" onClick={() => setIds([])}>
            清空选择
          </button>
        </div>
        {topic.sources.length ? (
          topic.sources.map((source) => (
            <label className="source-choice" key={source.id}>
              <input
                type="checkbox"
                checked={ids.includes(source.id)}
                disabled={ids.length >= 30 && !ids.includes(source.id)}
                onChange={(e) =>
                  setIds((old) =>
                    e.target.checked
                      ? old.length < 30
                        ? [...old, source.id]
                        : old
                      : old.filter((id) => id !== source.id),
                  )
                }
              />
              <span>
                <b>{source.title}</b>
                <small>{source.provenance}</small>
              </span>
              <a
                href={`/api/topics/${encodeURIComponent(topic.id)}/sources/${encodeURIComponent(source.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                阅读 ↗
              </a>
            </label>
          ))
        ) : (
          <p className="muted">本选题尚无已登记材料。请先在项目中登记来源。</p>
        )}
      </fieldset>
      <button className="action primary" disabled={busy || !ids.length || ids.length > 30}>
        {busy ? '正在启动…' : '启动研究'} <span aria-hidden>↗</span>
      </button>
    </form>
  );
}
function FrozenInputs({ run }: { run?: Run }) {
  if (!run) return null;
  return (
    <details className="frozen-inputs" key={run.id}>
      <summary>
        本次问题与输入 <span>{run.sources?.length ?? 0} 份冻结材料</span>
      </summary>
      <div className="frozen-inputs-body">
        <div className="frozen-inputs-meta">
          <div>
            <small>截至日期</small>
            <time dateTime={run.asOf}>{run.asOf || '未记录'}</time>
          </div>
          <div>
            <small>读者</small>
            <span>{run.readers?.length ? run.readers.join('、') : '未记录'}</span>
          </div>
          <div>
            <small>模型</small>
            <span>{run.model || '未记录'}</span>
          </div>
        </div>
        <div className="frozen-inputs-goal">
          <small>本次问题</small>
          <p>{run.goal || '未记录'}</p>
        </div>
        <div className="frozen-inputs-sources">
          <small>已选材料及精确内容哈希</small>
          {run.sources?.length ? (
            <ul>
              {run.sources.map((source) => (
                <li key={source.id}>
                  <a
                    href={`/api/runs/${encodeURIComponent(run.id)}/inputs/${encodeURIComponent(source.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.title} ↗
                  </a>
                  <code title={`SHA-256 ${source.sha256}`}>{source.sha256.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">未记录已选材料</p>
          )}
        </div>
      </div>
    </details>
  );
}
function Collaboration({
  runId,
  artifact,
  title,
  onChanged,
  onEvents,
  onRepairRun,
  onInteract,
}: {
  runId: string;
  artifact?: SafeArtifact;
  title?: string;
  onChanged: () => void;
  onEvents: (events: CollaborationEvent[]) => void;
  onRepairRun: (id: string) => void;
  onInteract: (artifact: SafeArtifact) => void;
}) {
  const [events, setEvents] = useState<CollaborationEvent[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [, setDraftRevision] = useState(0);
  const [selectedFeedback, setSelectedFeedback] = useState<string[]>([]),
    [route, setRoute] = useState<'expression' | 'evidence'>('expression');
  const id = artifact?.identity;
  const identityKey = id ? `${id.id}:${id.revision}:${id.sha256}` : '';
  const draftKey = id ? collaborationDraftKey(runId, id) : '';
  const activeDraftKey = useRef(draftKey);
  activeDraftKey.current = draftKey;
  const draft = collaborationDrafts.get(draftKey) || emptyCollaborationDraft;
  const { body, location, scope, scopeLabel } = draft;
  function updateDraft(patch: Partial<CollaborationDraft>) {
    if (!artifact || !draftKey) return;
    collaborationDrafts.set(draftKey, { ...draft, ...patch });
    onInteract(artifact);
    setDraftRevision((revision) => revision + 1);
  }
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!id || activeDraftKey.current !== draftKey) return;
      setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams({
          artifactId: id.id,
          revision: id.revision,
          sha256: id.sha256,
        });
        const data = await read<{ events: CollaborationEvent[] }>(
          `/runs/${encodeURIComponent(runId)}/collaboration?${query}`,
          signal,
        );
        if (!signal?.aborted && activeDraftKey.current === draftKey) {
          setEvents(data.events);
          onEvents(data.events);
        }
      } catch (e) {
        if (!signal?.aborted && activeDraftKey.current === draftKey) setError((e as Error).message);
      } finally {
        if (!signal?.aborted && activeDraftKey.current === draftKey) setLoading(false);
      }
    },
    [runId, identityKey, onEvents],
  );
  useEffect(() => {
    const controller = new AbortController();
    setEvents([]);
    onEvents([]);
    setSelectedFeedback([]);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function submit(path: string, payload: unknown) {
    const commandDraftKey = draftKey;
    setBusy(true);
    setError('');
    try {
      const result = await write<{ runId?: string }>(
        `/runs/${encodeURIComponent(runId)}/${path}`,
        payload,
      );
      await load();
      onChanged();
      return result;
    } catch (e) {
      if (activeDraftKey.current === commandDraftKey) setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const versionEvents = events.filter(
    (event) =>
      event.identity.id === id?.id &&
      event.identity.revision === id?.revision &&
      event.identity.sha256 === id?.sha256,
  );
  const feedback = versionEvents.filter((event) => event.type === 'feedback');
  const validFeedbackIds = selectedFeedback.filter((feedbackId) =>
    feedback.some((event) => event.id === feedbackId),
  );
  return (
    <aside className="collab-panel">
      <div className="panel-intro">
        <span className="overline">版本协作</span>
        <h2>意见与决定</h2>
        <p title={artifact?.identity.revision}>
          {artifact
            ? `${title || artifactTypeLabel(artifact.type)} · ${artifact.identity.revision.slice(0, 8)}`
            : '请选择一份产物'}
        </p>
      </div>
      {!artifact ? (
        <p className="muted">选择产物后，可在精确版本上记录意见和决定。</p>
      ) : (
        <>
          <div className="identity-block">
            <span>确切版本</span>
            <code>{artifact.identity.sha256.slice(0, 20)}…</code>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="muted">正在读取记录…</p>
          ) : versionEvents.length ? (
            <div className="event-list">
              {versionEvents.map((event) => (
                <article key={event.id} className="event">
                  <div className="event-meta">
                    <b>
                      {event.type === 'feedback'
                        ? '意见'
                        : event.verdict === 'accept'
                          ? '接受'
                          : '退回'}
                    </b>
                    <time>{showDate(event.createdAt)}</time>
                  </div>
                  <p>{event.body || event.scopeLabel}</p>
                  {event.location && <small>位置：{event.location}</small>}
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">此版本还没有意见或决定。</p>
          )}
          <details className="collab-detail" open>
            <summary>提出意见</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const submittedKey = draftKey;
                const submittedBody = body;
                void submit('feedback', {
                  identity: id as Identity,
                  body,
                  location,
                  idempotencyKey: uid(),
                }).then((result) => {
                  if (result) {
                    const saved = collaborationDrafts.get(submittedKey);
                    if (saved?.body === submittedBody) {
                      collaborationDrafts.set(submittedKey, { ...saved, body: '' });
                      setDraftRevision((revision) => revision + 1);
                    }
                  }
                });
              }}
            >
              <label>
                具体意见
                <textarea
                  value={body}
                  onChange={(e) => updateDraft({ body: e.target.value })}
                  rows={4}
                  required
                  placeholder="哪里不清楚、证据还缺什么？"
                />
              </label>
              <label>
                位置
                <input
                  value={location}
                  onChange={(e) => updateDraft({ location: e.target.value })}
                  maxLength={1000}
                />
              </label>
              <button className="action" disabled={busy || !body.trim()}>
                保存意见
              </button>
            </form>
          </details>
          {artifact.type === 'research-report' && (
            <details className="collab-detail">
              <summary>根据意见修订</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit('repair', {
                    identity: id as Identity,
                    feedbackIds: validFeedbackIds,
                    route,
                    idempotencyKey: uid(),
                  }).then((result) => {
                    if (result?.runId) onRepairRun(result.runId);
                  });
                }}
              >
                <p className="muted">选中当前版本的意见，开启新的修订运行；原稿保留。</p>
                {feedback.map((item) => (
                  <label key={item.id} className="feedback-choice">
                    <input
                      type="checkbox"
                      checked={selectedFeedback.includes(item.id)}
                      onChange={(e) =>
                        setSelectedFeedback((old) =>
                          e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span>{item.body}</span>
                  </label>
                ))}
                <label>
                  返回哪一步
                  <select value={route} onChange={(e) => setRoute(e.target.value as typeof route)}>
                    <option value="expression">表达与解释</option>
                    <option value="evidence">证据与综合</option>
                  </select>
                </label>
                <button className="action" disabled={busy || !validFeedbackIds.length}>
                  启动修订
                </button>
              </form>
            </details>
          )}
          <details className="collab-detail">
            <summary>对此版本作决定</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit('decision', {
                  identity: id as Identity,
                  verdict:
                    ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ||
                    'return',
                  scope,
                  scopeLabel,
                  idempotencyKey: uid(),
                });
              }}
            >
              <label>
                决定范围
                <select
                  value={scope}
                  onChange={(e) => updateDraft({ scope: e.target.value as typeof scope })}
                >
                  <option value="whole">整份</option>
                  <option value="partial">局部</option>
                </select>
              </label>
              <label>
                范围说明
                <input
                  value={scopeLabel}
                  onChange={(e) => updateDraft({ scopeLabel: e.target.value })}
                  required
                  maxLength={1000}
                />
              </label>
              <div className="decision-actions">
                <button className="action" value="return" disabled={busy}>
                  退回修改
                </button>
                <button className="action primary" value="accept" disabled={busy}>
                  接受此范围
                </button>
              </div>
            </form>
          </details>
        </>
      )}
    </aside>
  );
}
function ProcessDrawer({
  runId,
  stageId,
  onClose,
}: {
  runId: string;
  stageId: string;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<StageDetails | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void read<StageDetails>(
      `/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}`,
      controller.signal,
    )
      .then(setDetails)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [runId, stageId]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section
        className="process-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="阶段执行记录"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <span className="overline">过程记录</span>
            <h2>阶段执行详情</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {loading ? (
          <p className="muted">正在读取…</p>
        ) : error ? (
          <p className="error">{error}</p>
        ) : (
          <>
            <p className="muted">真实调用与尝试，按执行账本记录。</p>
            {details?.calls.length ? (
              details.calls.map((call) => (
                <article className="call-card" key={call.id}>
                  <div>
                    <strong>{call.title || call.stepId}</strong>
                    <Pill value={call.state} />
                  </div>
                  <small>
                    {call.role} · {call.model || '模型未记录'} · {call.reused ? '已复用' : '新调用'}
                  </small>
                  {call.attempts.map((attempt) => (
                    <p key={attempt.id} className="attempt">
                      <b>{label(attempt.state)}</b>
                      {attempt.error ? ` · ${attempt.error}` : ''}
                      {attempt.usage?.inputTokens != null
                        ? ` · 输入 ${attempt.usage.inputTokens} tokens`
                        : ''}
                    </p>
                  ))}
                </article>
              ))
            ) : (
              <p className="muted">此阶段尚无调用记录。</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
function App() {
  const [topics, setTopics] = useState<Topic[]>([]),
    [topicId, setTopicId] = useState(''),
    [runs, setRuns] = useState<Run[]>([]),
    [runId, setRunId] = useState('');
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null),
    [preferredId, setPreferredId] = useState<string>(),
    [pinned, setPinned] = useState<{ runId: string; artifact: SafeArtifact }>(),
    [stageDetail, setStageDetail] = useState('');
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [startOpen, setStartOpen] = useState(false);
  const [versionEvents, setVersionEvents] = useState<CollaborationEvent[]>([]);
  const generation = useRef(0),
    snapshotRef = useRef<ResearchSnapshot | null>(null);
  const topic = topics.find((item) => item.id === topicId);
  const currentRun = runs.find((item) => item.id === runId);
  const artifact = useMemo(
    () =>
      pinned?.runId === runId
        ? pinned.artifact
        : snapshot
          ? selectedArtifact(snapshot, preferredId)
          : undefined,
    [snapshot, preferredId, pinned, runId],
  );
  const selectArtifact = useCallback((id: string) => {
    setPinned(undefined);
    setPreferredId(id);
  }, []);
  const pinOnDraft = useCallback(
    (item: SafeArtifact) => setPinned({ runId, artifact: item }),
    [runId],
  );
  const artifactTitle = artifact && snapshot?.ui.assets[artifact.identity.id]?.title;
  const loadTopics = useCallback(async () => {
    try {
      const data = await read<{ topics: Topic[] }>('/topics');
      setTopics(data.topics);
      setTopicId((id) => id || data.topics[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadTopics();
  }, [loadTopics]);
  useEffect(() => {
    if (!topicId) return;
    const version = ++generation.current;
    setRuns([]);
    setRunId('');
    setSnapshot(null);
    snapshotRef.current = null;
    setPreferredId(undefined);
    setPinned(undefined);
    setVersionEvents([]);
    setError('');
    void read<{ runs: Run[] }>(`/topics/${encodeURIComponent(topicId)}/runs`)
      .then((data) => {
        if (version !== generation.current) return;
        setRuns(data.runs);
        setRunId(data.runs[0]?.id || '');
      })
      .catch((e) => {
        if (version === generation.current) setError(e.message);
      });
  }, [topicId]);
  useEffect(() => {
    if (!topicId) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void read<{ runs: Run[] }>(`/topics/${encodeURIComponent(topicId)}/runs`)
        .then((data) => {
          if (!disposed) setRuns(data.runs);
        })
        .catch(() => {});
    }, 15000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [topicId]);
  useEffect(() => {
    if (!runId) return;
    const version = ++generation.current;
    const controller = new AbortController();
    setSnapshot(null);
    snapshotRef.current = null;
    setPreferredId(undefined);
    setPinned(undefined);
    setVersionEvents([]);
    setError('');
    void read<ResearchSnapshot>(`/runs/${encodeURIComponent(runId)}/snapshot`, controller.signal)
      .then((data) => {
        if (version === generation.current) {
          snapshotRef.current = data;
          setSnapshot(data);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && version === generation.current) setError(e.message);
      });
    return () => controller.abort();
  }, [runId]);
  useEffect(() => {
    if (!runId || !snapshot) return;
    let timer: number,
      disposed = false;
    const version = generation.current;
    async function poll() {
      const current = snapshotRef.current;
      if (!current) return;
      try {
        const change = await read<Changes>(
          `/runs/${encodeURIComponent(runId)}/changes?cursor=${encodeURIComponent(current.cursor)}`,
        );
        if (disposed || version !== generation.current) return;
        const next = mergeSnapshot(current, change);
        if (next) {
          snapshotRef.current = next;
          if (
            JSON.stringify({ ...current, cursor: '' }) !== JSON.stringify({ ...next, cursor: '' })
          )
            setSnapshot(next);
        } else {
          const fresh = await read<ResearchSnapshot>(`/runs/${encodeURIComponent(runId)}/snapshot`);
          if (disposed || version !== generation.current) return;
          snapshotRef.current = fresh;
          setSnapshot(fresh);
        }
      } catch (e) {
        if (!disposed && version === generation.current) setError((e as Error).message);
      } finally {
        if (!disposed && version === generation.current) timer = window.setTimeout(poll, 5000);
      }
    }
    timer = window.setTimeout(poll, 5000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [runId, !!snapshot]);
  const refresh = useCallback(() => {
    if (!runId) return;
    void read<ResearchSnapshot>(`/runs/${encodeURIComponent(runId)}/snapshot`)
      .then((data) => {
        snapshotRef.current = data;
        setSnapshot(data);
      })
      .catch((e) => setError(e.message));
  }, [runId]);
  async function start(payload: {
    title: string;
    goal: string;
    asOf: string;
    sourceIds: string[];
  }) {
    if (!topic) return;
    setBusy(true);
    setError('');
    try {
      const data = await write<{ runId: string }>('/runs', {
        topicId: topic.id,
        ...payload,
        idempotencyKey: uid(),
        model: 'gpt-5.6-luna',
        reasoningEffort: 'medium',
      });
      const list = await read<{ runs: Run[] }>(`/topics/${encodeURIComponent(topic.id)}/runs`);
      setRuns(list.runs);
      setStartOpen(false);
      setRunId(data.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const onEvents = useCallback((events: CollaborationEvent[]) => setVersionEvents(events), []);
  async function repairRun(newRunId: string) {
    if (!topicId) return;
    try {
      const list = await read<{ runs: Run[] }>(`/topics/${encodeURIComponent(topicId)}/runs`);
      setRuns(list.runs);
      setRunId(newRunId);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function command(name: 'resume' | 'cancel') {
    if (!runId) return;
    setBusy(true);
    setError('');
    try {
      await write(
        `/runs/${encodeURIComponent(runId)}/${name}`,
        name === 'resume' ? { idempotencyKey: uid() } : {},
      );
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const phases = ['A1', 'A2', 'A3'].map((key) => ({
    key,
    stages: snapshot?.stages.filter((stage) => stageGroup(stage) === key) || [],
  }));
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span>
            <b>研究工作台</b>
            <small>RESEARCH STUDIO</small>
          </span>
        </div>
        <div className="topbar-right">
          <span className="topbar-caption">从问题到可复验的报告</span>
          <span className="topbar-date">
            {new Date().toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        </div>
      </header>
      <div className="workarea">
        <nav className="rail" aria-label="研究导航">
          <div className="rail-heading">
            <span className="overline">研究空间</span>
            <h1>选题与阶段</h1>
          </div>
          <div className="rail-section-title">选题</div>
          {loading ? (
            <p className="muted">正在读取选题…</p>
          ) : topics.length ? (
            topics.map((item) => (
              <button
                className={`topic-button ${item.id === topicId ? 'active' : ''}`}
                key={item.id}
                onClick={() => setTopicId(item.id)}
              >
                <span className="topic-glyph">⌁</span>
                <span>
                  {item.title}
                  <small>{item.sources.length} 份已登记材料</small>
                </span>
              </button>
            ))
          ) : (
            <p className="muted">尚无已登记选题。</p>
          )}
          {topic && (
            <>
              <div className="rail-section-title with-action">
                <span>运行</span>
                <button
                  className="icon-button"
                  aria-label="开始新研究"
                  onClick={() => setStartOpen(true)}
                >
                  ＋
                </button>
              </div>
              {runs.length ? (
                runs.map((item) => (
                  <button
                    className={`run-button ${item.id === runId ? 'active' : ''}`}
                    key={item.id}
                    onClick={() => setRunId(item.id)}
                  >
                    <span className="run-line" />
                    <span>
                      {item.title}
                      <small>
                        {label(item.state || item.queueState)} · {showDate(item.createdAt)}
                      </small>
                    </span>
                  </button>
                ))
              ) : (
                <p className="muted rail-empty">还没有运行。开始后，任务书和报告会在这里留存。</p>
              )}
            </>
          )}
          {snapshot && (
            <>
              <div className="rail-section-title">研究路径</div>
              {phases.map(({ key, stages }) => (
                <div className="rail-phase" key={key}>
                  <b>{key}</b>
                  <span>
                    {
                      (
                        { A1: '目标对齐', A2: '证据综合', A3: '图文报告' } as Record<string, string>
                      )[key]
                    }
                  </span>
                  <small>{stages.length ? label(stages.at(-1)?.state) : '未开始'}</small>
                </div>
              ))}
            </>
          )}
          <div className="rail-footer">每份产物保留确切版本、执行依据与协作记录。</div>
        </nav>
        <main className="main">
          <div className="main-header">
            <div>
              <span className="overline">{topic ? 'CURRENT TOPIC' : 'RESEARCH'}</span>
              <h1>{topic?.title || '选择一个研究选题'}</h1>
              <p>{topic?.goal || '所有研究从明确的问题开始。'}</p>
            </div>
            {topic && (
              <button className="action primary" onClick={() => setStartOpen(true)}>
                ＋ 新研究
              </button>
            )}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                onClick={() => {
                  setError('');
                  refresh();
                }}
              >
                重试
              </button>
            </div>
          )}
          {topic && !runId && !startOpen && (
            <div className="welcome-card">
              <span className="overline">准备开始</span>
              <h2>把问题交给一条完整的研究路径</h2>
              <p>
                选择已登记材料，说明要回答的问题。运行中可随时阅读已经发布的任务书、证据与报告。
              </p>
              <button className="action primary" onClick={() => setStartOpen(true)}>
                开始研究 →
              </button>
            </div>
          )}
          {runId && (
            <>
              <div className="run-toolbar">
                <div>
                  <span className="overline">研究运行</span>
                  <h2>{runs.find((run) => run.id === runId)?.title || runId}</h2>
                </div>
                <div className="toolbar-actions">
                  <button
                    className="action subtle"
                    disabled={busy}
                    onClick={() => void command('resume')}
                  >
                    恢复
                  </button>
                  <button
                    className="action subtle"
                    disabled={busy}
                    onClick={() => void command('cancel')}
                  >
                    取消
                  </button>
                </div>
              </div>
              <FrozenInputs run={currentRun} />
              {snapshot ? (
                <>
                  <div className="status-strip">
                    <div>
                      <small>执行</small>
                      <Pill value={snapshot.runs.find((run) => run.id === runId)?.state} />
                    </div>
                    <div>
                      <small>校验</small>
                      <Pill value={artifact?.validation} />
                    </div>
                    <div>
                      <small>审核</small>
                      <Pill value={artifact?.effectiveReview} />
                    </div>
                    <div>
                      <small>交付</small>
                      <Pill value={snapshot.delivery?.state} />
                    </div>
                    <div>
                      <small>用户决定</small>
                      <Pill value={decisionLabel(versionEvents, artifact?.identity)} />
                    </div>
                  </div>
                  <div className="progress-line">
                    已完成 {snapshot.progress.completed} / 已登记 {snapshot.progress.registered}
                    {snapshot.progress.planned != null
                      ? ` · 已规划 ${snapshot.progress.planned}`
                      : ''}
                  </div>
                  <div className="content-grid">
                    <div className="stages-column">
                      <div className="section-caption">
                        <span className="overline">执行脉络</span>
                        <h2>阶段产物</h2>
                      </div>
                      {phases.map(({ key, stages }) => (
                        <div key={key} className="phase-group">
                          <div className="phase-title">
                            <span>{key}</span>
                            <h3>
                              {
                                (
                                  { A1: '对齐目标', A2: '证据与综合', A3: '图文报告' } as Record<
                                    string,
                                    string
                                  >
                                )[key]
                              }
                            </h3>
                          </div>
                          {stages.length ? (
                            stages.map((stage) => (
                              <StageSummary
                                key={stage.id}
                                stage={stage}
                                artifacts={snapshot.artifacts}
                                titles={snapshot.ui.assets}
                                selectedId={artifact?.identity.id}
                                onSelect={selectArtifact}
                                onDetail={setStageDetail}
                              />
                            ))
                          ) : (
                            <p className="muted phase-empty">尚未开始此阶段</p>
                          )}
                        </div>
                      ))}
                      {snapshot.artifacts.filter(
                        (item) =>
                          !snapshot.stages.some((stage) =>
                            stage.artifactIds.includes(item.identity.id),
                          ),
                      ).length > 0 && (
                        <div className="phase-group">
                          <div className="phase-title">
                            <span>＋</span>
                            <h3>其他产物</h3>
                          </div>
                          {snapshot.artifacts
                            .filter(
                              (item) =>
                                !snapshot.stages.some((stage) =>
                                  stage.artifactIds.includes(item.identity.id),
                                ),
                            )
                            .map((item) => (
                              <button
                                className="asset-row"
                                key={item.identity.id}
                                onClick={() => selectArtifact(item.identity.id)}
                              >
                                {snapshot.ui.assets[item.identity.id]?.title ||
                                  artifactTypeLabel(item.type)}{' '}
                                ↗
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    <div className="reading-column">
                      <div className="section-caption reading-caption">
                        <span className="overline">研究正文</span>
                        <h2>
                          {artifactTitle ||
                            (artifact ? artifactTypeLabel(artifact.type) : '选择一份产物')}
                        </h2>
                        {artifact && (
                          <small title={artifact.identity.revision}>
                            精确版本 {artifact.identity.revision.slice(0, 8)}
                          </small>
                        )}
                      </div>
                      <Reader runId={runId} artifact={artifact} title={artifactTitle} />
                    </div>
                    <Collaboration
                      runId={runId}
                      artifact={artifact}
                      title={artifactTitle}
                      onChanged={refresh}
                      onEvents={onEvents}
                      onRepairRun={(id) => void repairRun(id)}
                      onInteract={pinOnDraft}
                    />
                  </div>
                </>
              ) : (
                <div className="loading-card">正在读取研究运行…</div>
              )}
            </>
          )}
        </main>
      </div>
      {startOpen && topic && (
        <div className="modal-backdrop" onClick={() => setStartOpen(false)}>
          <section
            className="start-modal"
            role="dialog"
            aria-modal="true"
            aria-label="开始新研究"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <span className="overline">NEW RESEARCH</span>
                <h2>开始新研究</h2>
                <p>目标、时间边界与来源在启动时固定，供后续复验。</p>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setStartOpen(false)}>
                ×
              </button>
            </div>
            <StartForm topic={topic} onStart={start} busy={busy} />
          </section>
        </div>
      )}
      {stageDetail && runId && (
        <ProcessDrawer runId={runId} stageId={stageDetail} onClose={() => setStageDetail('')} />
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
