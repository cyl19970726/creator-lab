import type { ResearchSnapshot } from '../../../packages/contracts/index.js';
import type { WorkflowChanges, SafeArtifact } from '@signal-room/workflow-read-model/contracts';

type ResearchChanges = WorkflowChanges & { changed?: ResearchSnapshot };
const idOf = (item: { id?: string; identity?: { id: string } }) => item.id ?? item.identity?.id;
function upsert<T extends { id?: string; identity?: { id: string } }>(
  old: T[],
  incoming: T[],
  removed: string[],
) {
  const map = new Map(old.map((item) => [idOf(item), item]));
  for (const id of removed) map.delete(id);
  for (const item of incoming) map.set(idOf(item), item);
  return [...map.values()];
}
export function mergeSnapshot(
  previous: ResearchSnapshot,
  update: ResearchChanges,
): ResearchSnapshot | null {
  if (update.resetRequired) return null;
  const changed = update.changed;
  const removed = update.removed;
  const assets = { ...previous.ui.assets, ...(changed.ui?.assets || {}) };
  for (const id of removed.artifacts) delete assets[id];
  return {
    ...previous,
    cursor: update.cursor,
    runs: upsert(previous.runs, changed.runs, removed.runs),
    stages: upsert(previous.stages, changed.stages, removed.stages),
    calls: upsert(previous.calls, changed.calls, removed.calls),
    artifacts: upsert(previous.artifacts, changed.artifacts, removed.artifacts),
    progress: changed.progress,
    delivery: changed.delivery,
    relations: changed.relations,
    diagnostics: changed.diagnostics,
    ui: { assets, primaryByStage: changed.ui?.primaryByStage ?? previous.ui.primaryByStage },
  };
}
export function selectedArtifact(
  snapshot: ResearchSnapshot,
  preferredId?: string,
): SafeArtifact | undefined {
  const get = (id?: string) => snapshot.artifacts.find((item) => item.identity.id === id);
  if (preferredId) return get(preferredId);
  const selected = [
    ...new Set(
      snapshot.relations
        .filter((item) => item.kind === 'selected' && item.validity === 'valid')
        .map((item) => item.to.id),
    ),
  ];
  if (snapshot.delivery?.state === 'ambiguous' || selected.length > 1) return undefined;
  if (selected.length === 1) return get(selected[0]);
  const primary = snapshot.ui.primaryByStage;
  for (const group of ['A3', 'A2', 'A1']) {
    const stages = snapshot.stages.filter(
      (stage) => stageGroup(stage) === group && stage.audience !== 'audit' && primary[stage.id],
    );
    if (!stages.length) continue;
    const highestOrder = Math.max(
      ...stages.map((stage) => stage.order ?? Number.NEGATIVE_INFINITY),
    );
    const candidates = [
      ...new Set(
        stages
          .filter((stage) => (stage.order ?? Number.NEGATIVE_INFINITY) === highestOrder)
          .map((stage) => primary[stage.id]),
      ),
    ];
    if (candidates.length !== 1) return undefined;
    return get(candidates[0]);
  }
  return undefined;
}
export function readerUrl(runId: string, artifact: SafeArtifact): string {
  const id = artifact.identity;
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id.id)}?revision=${encodeURIComponent(id.revision)}&sha256=${encodeURIComponent(id.sha256)}`;
}
export const stateLabel: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  waiting: '等待中',
  blocked: '受阻',
  needs_review: '待审阅',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  unknown: '未知',
  pending: '待处理',
  valid: '有效',
  invalid: '无效',
  passed: '通过',
  findings: '有发现',
  not_applicable: '不适用',
  missing: '缺失',
  ambiguous: '待选择',
  selected: '已选定',
};
export const label = (state?: string) => stateLabel[state || 'unknown'] || state || '未知';

export function stageGroup(stage: {
  path: string[];
  phaseKey: string;
}): 'A1' | 'A2' | 'A3' | undefined {
  const first = stage.path[0]?.toLowerCase() || stage.phaseKey.toLowerCase();
  if (/^(?:phase:[^:]+:)?a1(?:-|\.|$)/.test(first)) return 'A1';
  if (/^(?:phase:[^:]+:)?a2(?:-|\.|$)/.test(first)) return 'A2';
  if (/^(?:phase:[^:]+:)?a3(?:-|\.|$)/.test(first)) return 'A3';
}

export function decisionLabel(
  events: import('../../../packages/contracts/index.js').CollaborationEvent[],
  identity?: { id: string; revision: string; sha256: string },
): string {
  if (!identity) return 'unknown';
  const event = events
    .filter(
      (item) =>
        item.type === 'decision' &&
        item.identity.id === identity.id &&
        item.identity.revision === identity.revision &&
        item.identity.sha256 === identity.sha256,
    )
    .at(-1);
  if (!event) return 'unknown';
  if (event.verdict === 'return') return '已退回';
  if (event.verdict === 'accept')
    return event.scope === 'partial' ? `局部接受：${event.scopeLabel || '范围未注明'}` : '整份接受';
  return 'unknown';
}

export function collaborationDraftKey(
  runId: string,
  identity: { id: string; revision: string; sha256: string },
): string {
  return JSON.stringify([runId, identity.id, identity.revision, identity.sha256]);
}

const artifactLabels: Record<string, string> = {
  'research-brief': '研究任务书',
  'research-plan': '研究计划',
  'research-evidence': '证据包',
  'research-note': '研究笔记',
  'research-synthesis': '研究综合',
  'research-sample': '解释样例',
  'research-report': '图文报告',
  'research-review': '独立审阅',
  'reader-review': '读者审阅',
  'fact-review': '事实审阅',
  'research-change': '修订说明',
  'research-release': '交付记录',
};
export function artifactTypeLabel(type: string): string {
  return artifactLabels[type.toLowerCase().replaceAll('_', '-')] || '研究产物';
}
