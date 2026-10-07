import type { ArtifactRef } from '@signal-room/workflow';
import type { AssetVersion, BusinessPresentationAdapter, BusinessRunResolution, ResolvedAssetSource,
  WorkflowPresentationDraft, WorkflowSpaceService } from '@signal-room/workflow-spaces';
import type { CreationSchemaRefs } from './contracts.js';
import { creationPresentationReaderIds } from './readers.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const assessmentTypes = new Set(['content-reader', 'content-fact-check', 'content-review']);

/** Presentation revisions are independent of CONTENT's execution method and schema revisions. */
export function buildContentPresentation(refs: CreationSchemaRefs): WorkflowPresentationDraft {
  return {
    id: 'creation.content.workbench', revision: '2', entrypoint: 'content', label: '形成完整内容',
    purpose: '围绕读者的问题研究、成稿，并结合冷读、事实核查与主编意见修订。',
    assetViews: [
      { schema: refs.materials, label: '冻结材料包', reader: creationPresentationReaderIds.materials, sections: [] },
      { schema: refs.research, label: '研究问答', reader: creationPresentationReaderIds.research, sections: [] },
      { schema: refs.draft, label: '完整稿件', reader: creationPresentationReaderIds.draft, sections: [],
        compare: { fields: ['/decision/coreQuestion', '/decision/audienceChange', '/script/title', '/script/changesFromPrevious'],
          labels:{'/decision/coreQuestion':'核心问题','/decision/audienceChange':'读者获得的理解','/script/title':'稿件标题','/script/changesFromPrevious':'作者自述的改动'},
          sections:[
            {path:'/script/segments',label:'连续口播',kind:'paragraphs',fields:['/voiceover']},
            {path:'/script/segments',label:'画面、屏幕文字与节拍',kind:'items',fields:['/time','/visual','/onScreenText'],labels:{'/time':'时段','/visual':'画面','/onScreenText':'屏幕文字'}},
          ] } },
      { schema: refs.reader, label: '模拟冷读', reader: creationPresentationReaderIds.reader, sections: [] },
      { schema: refs.factCheck, label: '事实核查', reader: creationPresentationReaderIds.factCheck, sections: [] },
      { schema: refs.review, label: '主编意见', reader: creationPresentationReaderIds.review, sections: [] },
    ],
    results: { primary: 'final-draft', supporting: ['research'], assessments: ['cold-read', 'fact-check', 'editorial-review'] },
    stages: [
      { id: 'researcher', label: '研究', description: '回答读者问题，注明准确依据与缺口。' },
      { id: 'author', label: '写完整稿', description: '沿用研究不计为重新研究；失败重试不增加业务轮次。' },
      { id: 'coldReader', label: '模拟冷读', description: '与事实核查并行，仅阅读给定观众视图。' },
      { id: 'factChecker', label: '事实核查', description: '与冷读并行，核对给定材料。' },
      { id: 'editor', label: '主编审阅', description: '综合稿件、研究、冷读、核查与程序检查。' },
      { id: 'route', label: '路由与停止判断', description: '通过、返工、阻塞或轮次用尽，从准确决策记录读取。' },
      { id: 'creatorDraftGate', label: '用户评价与接受', description: '流程内审阅通过不等于用户接受。' },
      { id: 'stop', label: '停止自动执行', description: '保留结果与仍未解决的问题。' },
    ],
  };
}

/** Single-run status projection for a listing. Never scans run artifacts or events. */
export function createContentRunSummary(service: Pick<WorkflowSpaceService,
  'runtimeEvidence' | 'resolveRuntimeArtifact' | 'getExecutionTask'>) {
  return async ({spaceId, run, version}: {spaceId:string;run:import('@signal-room/workflow-spaces').SpaceRun;version:import('@signal-room/workflow-spaces').WorkflowVersion;case:import('@signal-room/workflow-spaces').SpaceCase}):Promise<BusinessRunResolution> => {
    const entry=version.entrypoints[run.entrypoint];
    if(!entry||run.workflowVersionId!==version.id||version.spaceId!==spaceId||run.spaceId!==spaceId)throw new Error('CONTENT run version identity mismatch');
    const ledger=await service.runtimeEvidence(spaceId);
    const native=await ledger.getRun(run.runId);
    if(!native||native.id!==run.runId||native.workflowId!==entry.workflowId||native.workflowRevision!==entry.codeRevision)throw new Error('CONTENT native run identity mismatch');
    const output=object(native.output),details=object(output.details),receipt=object(details.draft);
    const reason=text(details.reason)||native.error||'';
    let primaryAssetVersionId:string|null=null;
    if(Object.keys(receipt).length){
      const id=text(receipt.id),sha=text(receipt.sha256);
      if(!id||!sha||output.ok!==false||output.state!=='needs_review'||native.state!=='needs_review')throw new Error('CONTENT terminal draft receipt is invalid');
      const ref=await ledger.getArtifact(id);
      if(!ref||ref.id!==id||ref.type!=='content-draft'||ref.schemaVersion!=='v1'||ref.sha256!==sha||ref.producedBy.workflowRunId!==run.runId)throw new Error('CONTENT terminal draft receipt is inconsistent');
      const asset=await service.resolveRuntimeArtifact(spaceId,id);
      if(asset.spaceId!==spaceId||asset.source.kind!=='node'||asset.source.runId!==run.runId||asset.payloadHash!==ref.sha256||asset.schema.namespace!=='creation/content-draft'||asset.schema.revision!=='1')throw new Error('CONTENT terminal draft asset is inconsistent');
      primaryAssetVersionId=asset.id;
    }
    const task=await service.getExecutionTask(spaceId,run.runId);
    return {state:native.state,reason,primaryAssetVersionId,
      progress:reason==='not-converged'?'自动改稿次数用尽，尚未收敛':reason==='awaiting-human-review'?'流程内审阅通过，等待创作者评价':reason==='blocked'?'内容仍有阻塞问题，等待判断':native.state==='failed'?'本次执行失败；已生成过程稿仍可阅读':native.state==='queued'?(task?.status==='running'?'已派发，准备执行':'等待派发'):native.state==='running'?'正在执行':primaryAssetVersionId?'本次结果可阅读':'本次尚无最终稿收据'};
  };
}

/** Only authenticated service reads are available to this adapter. No model or business writes. */
export function createContentBusinessAdapter(service: Pick<WorkflowSpaceService,
  'runtimeEvidence' | 'resolveRuntimeArtifact' | 'readContext' | 'readAsset' | 'readManifest'>): BusinessPresentationAdapter {
  return {
    async resolveRun({ data, run }): Promise<BusinessRunResolution> {
      if (run.entrypoint !== 'content') return { state: 'recorded', progress: '此运行未配置 CONTENT 结果角色。' };
      const ledger = await service.runtimeEvidence(data.space.id);
      const nativeRun = await ledger.getRun(run.runId);
      if (!nativeRun) throw new Error('Native CONTENT run is missing');
      const workflow = data.workflows.find(value => value.id === run.workflowVersionId)?.entrypoints.content;
      if (nativeRun.id !== run.runId || (workflow && (nativeRun.workflowId !== workflow.workflowId ||
        nativeRun.workflowRevision !== workflow.codeRevision))) throw new Error('CONTENT native run identity mismatch');
      const artifacts = await ledger.listArtifacts(run.runId);
      const startedAt = (await ledger.listEvents(run.runId)).filter(event => event.type === 'workflow.started')
        .sort((left, right) => left.seq - right.seq)[0]?.timestamp;
      const byId = new Map(artifacts.map(value => [value.id, value]));
      const assets = new Map<string, AssetVersion>();
      const exact = async (ref: ArtifactRef): Promise<AssetVersion> => {
        if (ref.producedBy.workflowRunId !== run.runId) throw new Error('CONTENT artifact is outside the exact run');
        const value = await service.resolveRuntimeArtifact(data.space.id, ref.id);
        if (value.spaceId !== data.space.id || value.source.kind !== 'node' || value.source.runId !== run.runId ||
          value.payloadHash !== ref.sha256 || value.schema.namespace !== `creation/${ref.type}` || value.schema.revision !== '1' || ref.schemaVersion !== 'v1' ||
          !data.assets.some(asset => asset.id === value.id && asset.payloadHash === value.payloadHash && asset.schema.hash === value.schema.hash)) {
          throw new Error('CONTENT native artifact and Space version disagree');
        }
        assets.set(ref.id, value);
        return value;
      };
      const relevant = artifacts.filter(ref => ['content-draft', 'content-research', ...assessmentTypes].includes(ref.type));
      await Promise.all(relevant.map(exact));
      const dependency = (ref: ArtifactRef, target: ArtifactRef): boolean => ref.dependsOn.some(dep => {
        if (dep.artifactId !== target.id) return false;
        if (dep.sha256 !== target.sha256 || dep.revision !== target.revision) throw new Error('CONTENT dependency hash or revision mismatch');
        if (!assets.get(ref.id)?.dependencies.includes(assets.get(target.id)!.id)) throw new Error('CONTENT native dependency is missing its Space relation');
        return true;
      });
      const drafts = relevant.filter(ref => ref.type === 'content-draft');
      // A draft's exact predecessor establishes business order, regardless of storage version or timestamps.
      const ordered: ArtifactRef[] = [];
      const remaining = new Set(drafts);
      while (remaining.size) {
        const next = [...remaining].filter(ref => !drafts.some(prior => remaining.has(prior) && dependency(ref, prior)));
        if (next.length !== 1) throw new Error('CONTENT draft order is ambiguous or cyclic');
        ordered.push(next[0]!); remaining.delete(next[0]!);
      }
      const assessmentPriority: Record<string, number> = { 'content-review': 0, 'content-fact-check': 1, 'content-reader': 2 };
      const assessmentsFor = (draft: ArtifactRef) => relevant.filter(ref => assessmentTypes.has(ref.type) && dependency(ref, draft))
        .sort((left, right) => assessmentPriority[left.type]! - assessmentPriority[right.type]!)
        .map(ref => assets.get(ref.id)!.id);
      const output = object(nativeRun.output), details = object(output.details), receipt = object(details.draft);
      let primary: ArtifactRef | undefined;
      let terminalReview: ArtifactRef | undefined;
      let terminalResearch: ArtifactRef | undefined;
      if (Object.keys(receipt).length) {
        if (output.ok !== false || output.state !== 'needs_review' || nativeRun.state !== 'needs_review' ||
          !text(receipt.id) || !text(receipt.sha256)) throw new Error('CONTENT terminal draft receipt is invalid');
        primary = await ledger.getArtifact(text(receipt.id));
        if (!primary || primary.type !== 'content-draft' || primary.sha256 !== receipt.sha256 || !byId.has(primary.id)) {
          throw new Error('CONTENT final draft receipt is inconsistent');
        }
        await exact(primary);
        for (const [slot, type] of [['research', 'content-research'], ['review', 'content-review']] as const) {
          const related = object(details[slot]);
          if (!Object.keys(related).length) continue;
          const ref = await ledger.getArtifact(text(related.id));
          if (!ref || ref.type !== type || ref.sha256 !== related.sha256 || !byId.has(ref.id)) {
            throw new Error(`CONTENT final ${slot} receipt is inconsistent`);
          }
          await exact(ref);
          if (slot === 'review') {
            if (!dependency(ref, primary)) throw new Error('CONTENT terminal review targets another draft');
            terminalReview = ref;
          } else {
            if (!dependency(primary, ref)) throw new Error('CONTENT terminal research does not support the draft');
            terminalResearch = ref;
          }
        }
        if (terminalReview && terminalResearch && !dependency(terminalReview, terminalResearch)) {
          throw new Error('CONTENT terminal review lacks the exact research receipt');
        }
      }
      const finalAssessments = primary ? assessmentsFor(primary).filter(id => {
        if (!terminalReview) return true;
        if (id === assets.get(terminalReview.id)!.id) return true;
        const ref = relevant.find(value => assets.get(value.id)?.id === id)!;
        return ref.type !== 'content-review' && dependency(terminalReview, ref);
      }) : [];
      const process: NonNullable<BusinessRunResolution['process']> = [], researchSeen = new Set<string>();
      for (const [index, draft] of ordered.entries()) {
        const research = relevant.filter(ref => ref.type === 'content-research' && dependency(draft, ref));
        if (research.length !== 1) throw new Error('CONTENT draft lacks one exact research dependency');
        const source = research[0]!;
        if (!researchSeen.has(source.id)) {
          process.push({ label: researchSeen.size ? '补充研究' : '研究', assetVersionId: assets.get(source.id)!.id, assessmentAssetVersionIds: [] });
          researchSeen.add(source.id);
        }
        process.push({ label: `${primary?.id === draft.id ? '本次最终稿' : `第 ${index + 1} 次稿件`}${index && researchSeen.has(source.id) && ordered[index - 1]!.dependsOn.some(dep => dep.artifactId === source.id) ? ' · 沿用同一研究' : ''}`,
          assetVersionId: assets.get(draft.id)!.id, assessmentAssetVersionIds: primary?.id === draft.id ? finalAssessments : assessmentsFor(draft) });
      }
      const manifest = await service.readManifest(data.space.id, run.inputManifestId);
      if (manifest.caseId !== run.caseId || manifest.spaceId !== data.space.id) throw new Error('CONTENT input manifest is outside this case');
      const opportunity = manifest.assets.opportunity ? object((await service.readAsset(data.space.id, manifest.assets.opportunity)).payload) : {};
      const reason = text(details.reason) || nativeRun.error || '';
      return { state: nativeRun.state, startedAt, reason, primaryAssetVersionId: primary ? assets.get(primary.id)!.id : null,
        supportingAssetVersionIds: primary ? relevant.filter(ref => ref.type === 'content-research' && dependency(primary!, ref)).map(ref => assets.get(ref.id)!.id)
          : [...researchSeen].map(id => assets.get(id)!.id),
        assessmentAssetVersionIds: finalAssessments, process,
        progress: reason === 'not-converged' ? '自动改稿次数用尽，尚未收敛' : reason === 'awaiting-human-review' ? '流程内审阅通过，等待创作者评价' : reason === 'blocked' ? '内容仍有阻塞问题，等待判断' : nativeRun.state === 'failed' ? '本次执行失败；已生成过程稿仍可阅读' : '本次尚无最终稿收据',
        inputSummary: [text(opportunity.readerGoal) && `读者目标：${text(opportunity.readerGoal)}`, '原始材料已冻结', opportunity.webResearch === false ? '未新增联网研究' : '研究条件见执行证据'].filter(Boolean),
        methodLabel: data.workflows.find(value => value.id === run.workflowVersionId)?.revision ?? run.workflowVersionId,
      };
    },
    async resolveSources({ data, asset }): Promise<ResolvedAssetSource[]> {
      const isResearch=asset.schema.namespace==='creation/content-research',isDraft=asset.schema.namespace==='creation/content-draft';
      if ((!isResearch&&!isDraft) || asset.source.kind !== 'node') return [];
      const refs = [...new Set((isResearch?array(object(asset.payload).questions).flatMap(value => array(object(value).materialRefs).map(text)):
        [...array(object(object(asset.payload).script).sourcesUsed).map(text),...array(object(object(asset.payload).decision).beats).flatMap(value=>array(object(value).evidence).map(text))]).filter(Boolean))];
      const contextId = asset.source.generatedByContextId ?? asset.source.contextId;
      const context = await service.readContext(data.space.id, contextId);
      if (context.spaceId !== data.space.id || context.runId !== asset.source.runId || context.nodeId !== (isResearch?'researcher':'author')) {
        throw new Error('CONTENT research source context is inconsistent');
      }
      const candidates = new Map<string, ResolvedAssetSource[]>();
      const add = (item: unknown, parent: string, pointer:string, note = false) => {
        const value = object(item), id = text(value.id);
        if (!id) return;
        const source = { ref: id, label: text(value.title) || id,
          excerpt: note ? array(value.keyPoints).map(text).filter(Boolean).join('\n') : text(value.text), assetVersionId: parent, pointer, resolved: true };
        candidates.set(id, [...(candidates.get(id) ?? []), source]);
      };
      const materials = context.inputs.materials;
      if (materials) {
        const bound = await service.readAsset(data.space.id, materials.assetVersionId);
        if (bound.schema.namespace !== 'creation/content-materials' || bound.payloadHash !== materials.payloadHash) throw new Error('CONTENT frozen materials mismatch');
        array(bound.payload).forEach((item,index) => add(item, bound.id,`/${index}`));
      }
      // Notes are part of this exact research version, including notes carried forward by the workflow.
      const noteParent=isResearch?asset:context.inputs.research?await service.readAsset(data.space.id,context.inputs.research.assetVersionId):undefined;
      if(noteParent&&!isResearch&&noteParent.payloadHash!==context.inputs.research!.payloadHash)throw new Error('CONTENT frozen research note parent mismatch');
      if(noteParent)array(object(noteParent.payload).notes).forEach((item,index) => add(item, noteParent.id,`/notes/${index}`, true));
      return refs.map(ref => {
        const matches = candidates.get(ref) ?? [];
        return matches.length === 1 ? matches[0]! : { ref, label: `${ref} · 来源未解析${matches.length > 1 ? '（标识冲突）' : ''}`, resolved: false };
      });
    },
  };
}
