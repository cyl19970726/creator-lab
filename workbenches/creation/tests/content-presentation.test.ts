import { describe, expect, it, vi } from 'vitest';
import { artifactPayloadSha256, type ArtifactRef, type RunRecord } from '@signal-room/workflow';
import { SchemaRegistry } from '@signal-room/workflow-space-contracts';
import { getAssetSources, resolveWorkbenchRun, validateWorkflowPresentation,
  type AssetVersion, type NodeContext, type SpaceOverview } from '@signal-room/workflow-spaces';
import { registerCreationSchemas } from '../src/spaces/contracts.js';
import { buildContentPresentation, createContentBusinessAdapter } from '../src/spaces/presentation.js';
import { creationAssetReaders, creationPresentationReaderIds } from '../src/spaces/readers.js';

async function fixture() {
  const registry = new SchemaRegistry(), refs = registerCreationSchemas(registry);
  const data: SpaceOverview = { space: { id: 'space', purpose: '内容', owner: 'owner', status: 'active', createdAt: '' },
    workflows: [], cases: [{ id: 'case', spaceId: 'space', title: '测试', objective: '解释清楚', constraints: [] }],
    runs: [{ runId: 'run', spaceId: 'space', workflowVersionId: 'workflow', entrypoint: 'content', caseId: 'case', inputManifestId: 'manifest', effectiveConfig: {}, configHash: 'config' }],
    assets: [], reviews: [], comparisons: [], iterations: [], adoptions: [], sessions: [], knowledge: [] };
  const artifacts: ArtifactRef[] = [];
  async function add(id: string, type: string, payload: unknown, dependencies: ArtifactRef[] = []) {
    const hash = await artifactPayloadSha256(payload);
    const ref: ArtifactRef = { id, type, schemaVersion: 'v1', revision: hash, sha256: hash, uri: '',
      producedBy: { workflowRunId: 'run', stepRunId: id, attemptId: id },
      dependsOn: dependencies.map(dep => ({ artifactId: dep.id, revision: dep.revision, sha256: dep.sha256 })), validation: 'valid', review: 'not_applicable' };
    const schema = Object.values(refs).find(value => value.namespace === `creation/${type}`)!;
    const asset: AssetVersion & { state: string } = { id: `asset-${id}`, spaceId: 'space', assetId: id, version: 1,
      schema: { namespace: schema.namespace, revision: schema.revision, hash: schema.hash }, payload, payloadHash: hash,
      source: { kind: 'node', runId: 'run', nodeId: type === 'content-research' ? 'researcher' : 'author', stepRunId: id,
        attemptId: id, contextId: 'publication', generatedByContextId: 'research-agent', producer: 'program', sessionId: 'session' },
      dependencies: dependencies.map(dep => `asset-${dep.id}`), attachments: [], initialState: 'candidate', state: 'candidate', createdAt: '2026-01-01' };
    artifacts.push(ref); data.assets.push(asset);
    return ref;
  }
  const research = await add('research', 'content-research', { questions: [{ question: '为何', answer: '解释', materialRefs: ['m', 'n', 'missing'], gap: '' }],
    notes: [{ id: 'n', title: '本次研究来源', keyPoints: ['确切片段'] }], remainingGaps: [] });
  const draft1 = await add('draft1', 'content-draft', { script: { title: '初稿', segments: [{ voiceover: '首段' }] } }, [research]);
  const cold1 = await add('cold1', 'content-reader', { retell: '一' }, [draft1]);
  const draft2 = await add('draft2', 'content-draft', { script: { title: '二稿' } }, [research, draft1]);
  const fact2 = await add('fact2', 'content-fact-check', { summary: '二' }, [draft2, research]);
  const draft3 = await add('draft3', 'content-draft', { script: { title: '最终稿' } }, [research, draft2]);
  const cold3 = await add('cold3', 'content-reader', { retell: '三' }, [draft3]);
  const fact3 = await add('fact3', 'content-fact-check', { summary: '三' }, [draft3, research]);
  const review3 = await add('review3', 'content-review', { verdict: 'revise', summary: '仍需修改' }, [draft3, research, cold3, fact3]);
  const material: AssetVersion & {state: string} = { ...data.assets[0]!, id: 'materials', assetId: 'materials', schema: refs.materials,
    source: { kind: 'import', actorId: 'owner', description: 'frozen' }, payload: [{ id: 'm', title: '冻结材料', text: '原始证据' }],
    payloadHash: await artifactPayloadSha256([{ id: 'm', title: '冻结材料', text: '原始证据' }]), dependencies: [] };
  data.assets.push(material, { ...material, id: 'current-materials', payload: [{ id: 'missing', title: '当前库同名资料', text: '不可引用' }] });
  const context = { id: 'research-agent', spaceId: 'space', runId: 'run', nodeId: 'researcher',
    inputs: { materials: { assetVersionId: material.id, payloadHash: material.payloadHash, schema: material.schema, payload: material.payload } } } as unknown as NodeContext;
  const native: RunRecord = { id: 'run', workflowId: 'creation.content', workflowRevision: 'content-v2', inputFingerprint: '', state: 'needs_review',
    output: { ok: false, state: 'needs_review', details: { reason: 'not-converged', draft: draft3, review: review3, research } } };
  const service = {
    runtimeEvidence: vi.fn(async () => ({ getRun: vi.fn(async () => native), listArtifacts: vi.fn(async () => [...artifacts].reverse()),
      listEvents: vi.fn(async () => [{ type: 'workflow.started', seq: 1, timestamp: '2026-10-05T00:00:00Z' }]),
      getArtifact: vi.fn(async (id: string) => artifacts.find(ref => ref.id === id)) })),
    resolveRuntimeArtifact: vi.fn(async (_space: string, id: string) => data.assets.find(asset => asset.id === `asset-${id}`)!),
    readContext: vi.fn(async () => context),
    readAsset: vi.fn(async (_space: string, id: string) => id === 'opportunity' ? { payload: { readerGoal: '解释清楚', webResearch: false } } as AssetVersion : data.assets.find(asset => asset.id === id)!),
    readManifest: vi.fn(async () => ({ id: 'manifest', spaceId: 'space', caseId: 'case', hash: '', assets: { opportunity: 'opportunity', materials: material.id } })),
  };
  return { registry, refs, data, artifacts, research, draft1, draft2, draft3, cold1, fact2, review3, native, context, service };
}

describe('CONTENT presentation', () => {
  it('validates five exact frozen schemas and deployed readers, including draft comparison fields', async () => {
    const { registry, refs } = await fixture(), presentation = buildContentPresentation(refs);
    expect(presentation.assetViews).toHaveLength(6);
    expect(presentation.assetViews.every(view => view.schema.hash.length === 64)).toBe(true);
    await expect(validateWorkflowPresentation(presentation, registry, Object.values(creationPresentationReaderIds))).resolves.toMatch(/^[a-f0-9]{64}$/);
    const invalid = structuredClone(presentation); invalid.assetViews[0]!.schema.hash = '0'.repeat(64);
    await expect(validateWorkflowPresentation(invalid, registry, Object.values(creationPresentationReaderIds))).rejects.toThrow();
  });

  it('uses terminal receipt and exact draft dependencies; storage version 1 does not determine draft order', async () => {
    const f = await fixture(), result = await createContentBusinessAdapter(f.service as never).resolveRun({ data: f.data, run: f.data.runs[0]! });
    const resolved = resolveWorkbenchRun(f.data, f.data.runs[0]!, 1, result);
    expect(resolved.primary?.id).toBe('asset-draft3');
    expect(result.progress).toContain('尚未收敛');
    expect(result.startedAt).toBe('2026-10-05T00:00:00Z');
    expect(result.process?.map(row => row.assetVersionId)).toEqual(['asset-research', 'asset-draft1', 'asset-draft2', 'asset-draft3']);
    expect(result.process?.map(row => row.assessmentAssetVersionIds)).toEqual([[], ['asset-cold1'], ['asset-fact2'], ['asset-review3', 'asset-fact3', 'asset-cold3']]);
    expect(result.assessmentAssetVersionIds).toEqual(['asset-review3', 'asset-fact3', 'asset-cold3']);
    expect(result.process?.[2]!.label).toContain('第 2 次稿件');
    expect(result.process?.[2]!.label).toContain('沿用同一研究');
    expect(resolved.reviews).toEqual([]);
    expect(f.service.readAsset).toHaveBeenCalledWith('space', 'opportunity');
  });

  it('does not guess a final result when a failed run has process drafts', async () => {
    const f = await fixture(); f.native.state = 'failed'; f.native.output = undefined;
    const result = await createContentBusinessAdapter(f.service as never).resolveRun({ data: f.data, run: f.data.runs[0]! });
    expect(result.primaryAssetVersionId).toBeNull();
    expect(result.assessmentAssetVersionIds).toEqual([]);
    expect(result.process).toHaveLength(4);
  });

  it('rejects a terminal editorial receipt targeting an earlier draft', async () => {
    const f = await fixture();
    f.review3.dependsOn[0] = { artifactId: f.draft1.id, revision: f.draft1.revision, sha256: f.draft1.sha256 };
    f.data.assets.find(asset => asset.id === 'asset-review3')!.dependencies = ['asset-draft1', 'asset-research'];
    await expect(createContentBusinessAdapter(f.service as never).resolveRun({ data: f.data, run: f.data.runs[0]! })).rejects.toThrow('terminal review');
  });

  it.each(['hash', 'run', 'type', 'dependency'] as const)('rejects inconsistent native %s evidence', async failure => {
    const f = await fixture();
    if (failure === 'hash') (f.native.output as { details: { draft: { sha256: string } } }).details.draft = { ...f.draft3, sha256: 'wrong' };
    if (failure === 'run') f.draft3.producedBy.workflowRunId = 'other-run';
    if (failure === 'type') f.draft3.type = 'content-research';
    if (failure === 'dependency') f.review3.dependsOn[0]!.sha256 = 'wrong';
    await expect(createContentBusinessAdapter(f.service as never).resolveRun({ data: f.data, run: f.data.runs[0]! })).rejects.toThrow();
  });

  it('resolves package IDs only inside bound materials and exact research notes', async () => {
    const f = await fixture(), adapter = createContentBusinessAdapter(f.service as never);
    const sources = await getAssetSources(f.service as never, f.data, f.data.assets[0]!, adapter);
    expect(sources).toEqual([
      { ref: 'm', label: '冻结材料', excerpt: '原始证据', assetVersionId: 'materials', pointer:'/0', resolved: true },
      { ref: 'n', label: '本次研究来源', excerpt: '确切片段', assetVersionId: 'asset-research', pointer:'/notes/0', resolved: true },
      { ref: 'missing', label: 'missing · 来源未解析', resolved: false },
    ]);
    expect(f.service.readContext).toHaveBeenCalledWith('space', 'research-agent');
    expect(f.service.readAsset).not.toHaveBeenCalledWith('space', 'current-materials');
  });

  it('leaves a conflicting source identifier explicitly unresolved', async () => {
    const f = await fixture(); (f.data.assets[0]!.payload as {notes: unknown[]}).notes.push({ id: 'm', title: '冲突来源', keyPoints: ['内容'] });
    const result = await createContentBusinessAdapter(f.service as never).resolveSources!({ data: f.data, asset: f.data.assets[0]! });
    expect(result[0]).toMatchObject({ resolved: false, label: expect.stringContaining('标识冲突') });
  });

  it('provides plain-text readers and keeps consecutive voiceovers and cautious assessment wording', async () => {
    const f = await fixture();
    const asset = { ...f.data.assets[1]!, payload: { decision: { coreQuestion: '问题' }, script: { title: '<script>danger</script>',
      segments: [{ voiceover: '第一段', visual: '画面' }, { voiceover: '第二段', visual: '另一画面' }] } } };
    const reading = await creationAssetReaders[creationPresentationReaderIds.draft]!(asset);
    expect(reading.title).toBe('<script>danger</script>');
    expect(reading.sections.find(section => section.title === '连续口播')!.text).toBe('第一段\n\n第二段');
    const facts = await creationAssetReaders[creationPresentationReaderIds.factCheck]!({ ...asset, payload: { summary: '限定材料', issues: [] } });
    expect(facts.sections[1]!.text).toBe('给定材料下未报告问题。');
    expect(Object.values(creationPresentationReaderIds).every(id => typeof creationAssetReaders[id] === 'function')).toBe(true);
    const researchReading = await creationAssetReaders[creationPresentationReaderIds.research]!(f.data.assets[0]!);
    expect(researchReading.sections[0]).toMatchObject({ title: '为何', text: expect.stringContaining('解释'), sourceRefs: ['m', 'n', 'missing'] });
  });
});
