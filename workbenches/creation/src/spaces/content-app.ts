import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { ZodError } from 'zod';
import {
  createInteractiveSpaceConsole, InteractiveConsoleError, type InteractiveWorkflowHost, type WorkflowSpaceService,
} from '@signal-room/workflow-spaces';
import { contentStandardsPath, type ContentInput } from '../stages/content.js';
import { createContentWorkbench } from './content-workbench.js';
import { creationAssetReaders } from './readers.js';
import { createContentBusinessAdapter } from './presentation.js';
import { registerContentPresentation } from './presentation-registration.js';

type ContentWorkbench = ReturnType<typeof createContentWorkbench>;
type Fields = Record<string, string>;
const lines = (value = '') => value.split('\n').map(line => line.trim()).filter(Boolean);
const nodeTitles: Record<string, string> = {
  researcher: '研究编辑', author: '作者', coldReader: '普通读者', factChecker: '事实核查', editor: '主编',
};

/** Business form conversion; the shared console owns transport, rendering and CSRF protection. */
export function contentInputFromForm(caseId: string, objective: string, fields: Fields): ContentInput {
  const blocks = (fields.materials ?? '').split(/\n\s*---\s*\n/).map(block => block.trim()).filter(Boolean);
  const materials = blocks.map((block, index) => {
    const split = block.indexOf('\n');
    return { id: `source-${index + 1}`, title: split > 0 ? block.slice(0, split).trim() : `参考材料 ${index + 1}`,
      text: split > 0 ? block.slice(split + 1).trim() : block };
  });
  const maxRevisions = fields.maxRevisions?.trim() ? Number(fields.maxRevisions) : 1;
  return {
    topicId: caseId, opportunity: fields.opportunity?.trim() || objective,
    readerGoal: fields.readerGoal?.trim() || objective,
    requiredQuestions: lines(fields.requiredQuestions),
    account: { name: fields.accountName?.trim() || '我的创作账号',
      positioning: fields.accountPositioning?.trim() || '用清楚、有依据的内容回答读者的问题',
      currentAudience: fields.audience?.trim() || '对这个话题感兴趣的普通中文读者', referencePieces: [] },
    form: fields.form?.trim() || '中文视频口播稿，篇幅服从解释需要',
    materials, standards: readFileSync(contentStandardsPath, 'utf8'), webResearch: false, maxRevisions,
  };
}

export function createContentApp(options: {
  service: WorkflowSpaceService; workbench: ContentWorkbench; spaceId: string;
}): Server {
  const { service, workbench, spaceId } = options;
  const observe = (handle: { runId: string; completion: Promise<unknown> }) => {
    void handle.completion.catch(error => {
      console.error(`CONTENT ${handle.runId}: ${error instanceof Error ? error.message : 'execution failed'}`);
    });
    return { runId: handle.runId };
  };
  const host: InteractiveWorkflowHost = {
    spaceId, label: 'CONTENT · 形成完整稿件',
    validation: workbench.validation(spaceId),
    methods: { workflowId: 'creation.content', entrypoint: 'content',
      preview: () => workbench.preview(spaceId),
      publish: input => workbench.publishMethod(spaceId, input),
      availability: (versionId, entrypoint) => workbench.methodAvailability(spaceId, versionId, entrypoint) },
    execution: {
      list: () => workbench.tasks(spaceId),
      cancel: runId => workbench.cancel(spaceId, runId),
      dispatch: () => workbench.dispatch(spaceId),
    },
    caseFields: [
      { name: 'title', label: '这期内容的名称', kind: 'text', required: true },
      { name: 'objective', label: '希望读者看完理解什么', kind: 'textarea', required: true },
    ],
    runFields: [
      { name: 'opportunity', label: '为什么想做这期内容', kind: 'textarea', hint: '留空沿用案例目标。' },
      { name: 'readerGoal', label: '读者应获得的理解', kind: 'textarea', hint: '留空沿用案例目标。' },
      { name: 'requiredQuestions', label: '必须讲清楚的问题', kind: 'textarea', required: true, hint: '每行一个问题。' },
      { name: 'materials', label: '参考材料', kind: 'textarea', required: true,
        hint: '第一行写来源标题，后面粘贴材料正文与来源链接。多份材料之间单独写一行 ---。本入口只使用你提供的材料，不新增联网研究。' },
      { name: 'accountName', label: '账号名称', kind: 'text', defaultValue: '我的创作账号' },
      { name: 'accountPositioning', label: '账号希望提供的价值', kind: 'text', defaultValue: '用清楚、有依据的内容回答读者的问题' },
      { name: 'audience', label: '目标读者', kind: 'text', defaultValue: '对这个话题感兴趣的普通中文读者' },
      { name: 'form', label: '希望的表达形式', kind: 'text', defaultValue: '中文视频口播稿，篇幅服从解释需要' },
      { name: 'maxRevisions', label: '本轮最多自动改稿次数', kind: 'number', defaultValue: '1', hint: '0 到 5 次。用尽仍不通过时保留稿件与问题，交给你判断。' },
    ],
    async createCase(fields, commandId) {
      return workbench.createCase(spaceId, { id: `content-case-${commandId}`, title: fields.title,
        objective: fields.objective, constraints: ['仅使用明确提供的材料；本轮不联网补充资料'] });
    },
    async freezeInput(caseId, fields, commandId) {
      const overview = await service.overview(spaceId);
      const item = overview.cases.find(candidate => candidate.id === caseId);
      if (!item) throw new InteractiveConsoleError(404, '找不到这个内容案例。');
      try {
        const input = contentInputFromForm(caseId, item.objective, fields);
        const manifest = await workbench.freezeInput({ spaceId, caseId, input, idempotencyKey: commandId });
        return { id: manifest.id };
      } catch (error) {
        if (error instanceof ZodError) throw new InteractiveConsoleError(400, '请检查必答问题和参考材料是否完整，自动改稿次数须为 0 到 5 的整数。');
        throw error;
      }
    },
    async startRun(caseId, fields, command) {
      if (!command.workflowVersionId || command.entrypoint !== 'content') {
        throw new InteractiveConsoleError(400, '请明确选择本次 CONTENT 方法版本。');
      }
      const overview = await service.overview(spaceId);
      const item = overview.cases.find(candidate => candidate.id === caseId);
      if (!item) throw new InteractiveConsoleError(404, '找不到这个内容案例。');
      if (command.baselineRunId) {
        const review = overview.reviews.find(candidate => candidate.id === command.baselineReviewId);
        if (!review || review.runId !== command.baselineRunId || !command.baselineAssetVersionId ||
          !review.assetVersionIds.includes(command.baselineAssetVersionId)) throw new InteractiveConsoleError(400, '请先选择准确稿件的四问评价作为改稿基线。');
        const handle=await workbench.rerun({ spaceId, caseId, baselineRunId: command.baselineRunId,
          workflowVersionId: command.workflowVersionId,
          baselineDraftVersionId: command.baselineAssetVersionId, baselineReviewId: review.id,
          feedbackNotes: lines(command.feedback),
          hypothesis: command.hypothesis, idempotencyKey: command.commandId });
        await registerContentPresentation(service,spaceId);
        return observe(handle);
      }
      let handle: Awaited<ReturnType<ContentWorkbench['start']>>;
      try {
        const input = contentInputFromForm(caseId, item.objective, fields);
        // The selected deployment owns validation and normalization of this input.
        handle = await workbench.start({ spaceId, caseId, input, idempotencyKey: command.commandId,
          workflowVersionId: command.workflowVersionId, hypothesis: command.hypothesis });
      }
      catch (error) {
        if (error instanceof ZodError) throw new InteractiveConsoleError(400, '请检查必答问题和参考材料是否完整，自动改稿次数须为 0 到 5 的整数。');
        throw error;
      }
      await registerContentPresentation(service,spaceId);
      return observe(handle);
    },
    async saveReview(caseId, input) {
      return workbench.review({ spaceId, caseId, runId: input.runId, draftVersionId: input.assetVersionId,
        id: `content-review-${input.commandId}`, idempotencyKey: input.commandId, answers: input.answers,
        ...(input.baselineReviewId ? { baselineReviewId: input.baselineReviewId } : {}),
        standard: { id: 'creation-four-questions', revision: '1',
          content: '对照本案例读者目标与准确稿件，分别说明好、不好、相比基线的提升、仍不满意；无基线时明确是首轮。' },
        accept: input.accept, reason: input.accept ? '创作者通过工作台明确接受本版本稿件。' : undefined });
    },
    async runStatus(runId) {
      const status = await workbench.runStatus(spaceId, runId);
      if (status.binding.entrypoint !== 'content') throw new Error('找不到这次 CONTENT 执行。');
      const ledger = await service.runtimeLedger(spaceId);
      const { run } = status;
      // A CLI process may own this run. Absence from this HTTP process is not evidence of interruption.
      const steps = await ledger.listSteps(runId);
      const current = steps.find(step => step.phaseDefinition && step.state === 'running');
      const contexts = await service.runtimeContexts(spaceId, runId);
      const sessions = [...new Map(contexts.map(context => [context.sessionId,
        { sessionId: context.sessionId,
          label: `${nodeTitles[context.nodeId] ?? context.nodeId} · ${context.producer === 'agent' ? '执行记录' : '资产提交'}` }])).values()];
      const reason = (run.output as { details?: { reason?: string } } | undefined)?.details?.reason;
      let progress = run.state === 'needs_review'
        ? reason === 'not-converged'
          ? '自动改稿次数已用尽，仍有未解决问题。请阅读本轮最终稿并记录四问反馈。'
          : '本轮已完成，等待你的四问反馈；流程内审阅通过不代表你已接受稿件。'
        : current?.phaseDefinition?.title ?? `已完成 ${steps.filter(step => step.state === 'succeeded').length} 个步骤`;
      if (status.executionTask?.status === 'queued') progress = '已固定方法版本和输入，等待执行名额；不会改用后来发布的版本。';
      if (status.executionTask?.status === 'cancel_requested') progress = '已请求停止这次运行，正在等待执行器确认停止。';
      if (status.executionTask?.status === 'interrupted') progress = '执行器已失去联系，外部执行结果待核对；本任务不会自动重跑。';
      if (status.executionTask?.status === 'canceled') progress = '这次运行已停止；已有执行记录与资产继续保留。';
      return { state: run.state, error: run.error,
        progress,
        reviewableAssetVersionId: run.state === 'needs_review' ? status.draftVersionId ?? null : null,
        sessions };
    },
    isDeliverable: asset => asset.schema.namespace === 'creation/content-draft',
  };
  return createInteractiveSpaceConsole(service, { title: '内容创作', workflow: host, readers: creationAssetReaders, businessAdapter: createContentBusinessAdapter(service) });
}
