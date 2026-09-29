import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineAgent, workflow, type AgentRunner, type ArtifactRef, type WorkflowDefinition, type WorkflowTerminal } from '@signal-room/workflow';
import { CodexSdkRunner, snapshotSkill, type FrozenSkillBundle } from '@signal-room/workflow-codex';
import { z } from 'zod';
import {
  definitionSchema, draftSchema, executionConfigSchema, idSchema, materialSchema, reviewSchema,
  type ContentDefinition, type Draft, type Review, type WorkflowInput,
} from '../contracts/index.js';

const articleInputSchema = z.object({
  workId: idSchema,
  question: z.string().trim().min(1),
  audience: z.string().trim().min(1),
  purpose: z.enum(['explanation', 'opinion', 'narrative']),
  medium: z.literal('article'),
  accountPositioning: z.string().trim().min(1),
  constraints: z.string(),
  materials: z.array(materialSchema).max(20),
  revision: z.object({
    draft: draftSchema, definition: definitionSchema, feedback: z.string().trim().min(1),
    parentAssetId: idSchema, parentHash: z.string().regex(/^[a-f0-9]{64}$/), parentRevision: z.string().min(1),
  }).strict().optional(),
}).merge(executionConfigSchema).strict().superRefine((value, context) => {
  const materialIds = value.materials.map(material => material.id);
  if (new Set(materialIds).size !== materialIds.length) context.addIssue({ code: 'custom', message: 'Material IDs must be unique', path: ['materials'] });
  if (value.revision) {
    for (const sourceId of value.revision.draft.sourceIds) {
      if (!materialIds.includes(sourceId)) context.addIssue({ code: 'custom', message: `Revision source ${sourceId} is absent from frozen materials`, path: ['revision', 'draft', 'sourceIds'] });
    }
    for (const role of value.revision.definition.materialRoles) {
      if (!materialIds.includes(role.sourceId)) context.addIssue({ code: 'custom', message: `Definition source ${role.sourceId} is absent from frozen materials`, path: ['revision', 'definition', 'materialRoles'] });
    }
  }
});

export interface ArticleAsset<T> {
  kind: 'definition' | 'draft' | 'review'; content: string; payload: T;
  origin?: { kind: 'copied-from-parent-input'; parentArtifactId: string; parentHash: string };
}
export interface ArticleWorkflowSuccess {
  quality: 'passed';
  definition: ArtifactRef;
  candidate: ArtifactRef;
  review: ArtifactRef;
}
export type ArticleWorkflowOutput = ArticleWorkflowSuccess | WorkflowTerminal<never>;

const schemaObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const definitionOutputSchema = schemaObject({
  question: string, promise: string, audienceChange: string, accountFit: string,
  materialRoles: { type: 'array', items: schemaObject({ sourceId: string, use: string }, ['sourceId', 'use']) },
  scope: string, unknowns: strings,
}, ['question', 'promise', 'audienceChange', 'accountFit', 'materialRoles', 'scope', 'unknowns']);
const draftOutputSchema = schemaObject({ title: string, body: string, sourceIds: strings }, ['title', 'body', 'sourceIds']);
const reviewOutputSchema = schemaObject({
  verdict: { type: 'string', enum: ['pass', 'revise', 'blocked'] }, summary: string,
  findings: { type: 'array', items: schemaObject({ severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, message: string }, ['severity', 'message']) },
}, ['verdict', 'summary', 'findings']);

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.agents/skills/article-creation');
const permissionsRevision = 'read-only-v1';
const threadOptions = { sandboxMode: 'read-only', approvalPolicy: 'never' } as const;
const implementationHash = (() => {
  const moduleFile = fileURLToPath(import.meta.url);
  const contractsDirectory = path.resolve(path.dirname(moduleFile), '../contracts');
  const contractsFile = ['index.ts', 'index.js'].map(name => path.join(contractsDirectory, name)).find(existsSync);
  if (!contractsFile) throw new Error('Article contracts source is unavailable for revision fingerprinting');
  const hash = createHash('sha256');
  for (const file of [moduleFile, contractsFile]) hash.update(path.basename(file)).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
})();

function agent<Input, Output>(id: string, prompt: string, outputSchema: unknown, input: WorkflowInput, method: FrozenSkillBundle) {
  return defineAgent<Input, Output>({
    id, revision: '1', model: input.model, reasoningEffort: input.reasoningEffort,
    promptRevision: '1', skillsRevision: method.sha256, permissionsRevision,
    config: {
      prompt,
      skills: [method],
      outputSchema,
      threadOptions,
      timeoutMs: 300_000,
    },
  });
}

function dependency(ref: ArtifactRef) {
  return { artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 };
}

function sourceError(ids: readonly string[], available: ReadonlySet<string>): string | undefined {
  return ids.find(id => !available.has(id));
}

function definitionContent(value: ContentDefinition): string {
  return `# Content definition\n\n**Question:** ${value.question}\n\n**Promise:** ${value.promise}\n\n**Audience change:** ${value.audienceChange}\n\n**Account fit:** ${value.accountFit}\n\n**Scope:** ${value.scope}\n\n**Material roles:**\n${value.materialRoles.map(role => `- ${role.sourceId}: ${role.use}`).join('\n') || '- None'}\n\n**Unverified assumptions and unknowns:**\n${value.unknowns.map(item => `- ${item}`).join('\n') || '- None recorded'}\n`;
}
function draftContent(value: Draft): string { return `# ${value.title}\n\n${value.body}\n`; }
function reviewContent(value: Review): string {
  return `# Review: ${value.verdict}\n\n${value.summary}\n\n${value.findings.map(finding => `- ${finding.severity}: ${finding.message}`).join('\n') || 'No findings.'}\n`;
}
function valid<T>(schema: z.ZodType<T>, value: unknown, extra?: (value: T) => string | undefined) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { valid: false, details: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })) };
  const problem = extra?.(parsed.data);
  return problem ? { valid: false, details: problem } : { valid: true };
}
function isTerminal(value: unknown): value is WorkflowTerminal<never> {
  return !!value && typeof value === 'object' && 'ok' in value && (value as {ok?: unknown}).ok === false;
}

/** Definition is configured from a frozen job input; running it is the only model trigger. */
export function createArticleWorkflow(config: WorkflowInput): WorkflowDefinition<WorkflowInput, ArticleWorkflowOutput> {
  const frozen = articleInputSchema.parse(config);
  const available = new Set(frozen.materials.map(material => material.id));
  const method = snapshotSkill(skillDirectory);
  const defining = agent<WorkflowInput, ContentDefinition>(
    'article-definition',
    'Form one article content definition from the frozen request and materials. Preserve the creator’s question and value choice. Distinguish evidence from assumptions. Include each unresolved factual or audience assumption in unknowns. Use only supplied material IDs in materialRoles. Do not invent sources, popularity, technical facts, or authorization. Return only JSON matching the schema.',
    definitionOutputSchema, frozen, method,
  );
  const author = agent<unknown, Draft>(
    'article-author',
    'Write a complete readable article that delivers the content definition. Cite only frozen material IDs in sourceIds; make limitations and uncertain claims clear in the actual prose. A plan or placeholder is not a draft. Preserve the creator’s scope and constraints. Return only JSON matching the schema.',
    draftOutputSchema, frozen, method,
  );
  const reviewer = agent<unknown, Review>(
    'article-independent-reviewer',
    'Independently assess the exact candidate supplied, its definition, and frozen source materials. Check whether the actual full article fulfills the promise, whether factual and causal claims are supported, whether source IDs are valid, and whether significant unknowns remain visible. Mark pass only if there is no critical or major defect. Do not treat model output as user acceptance or publication approval. Return only JSON matching the schema.',
    reviewOutputSchema, frozen, method,
  );
  const reviser = agent<unknown, Draft>(
    'article-reviser',
    'Revise the supplied exact draft to address the bound review findings or explicit user feedback while preserving the definition and frozen materials. Write the full revised article, with valid sourceIds and unresolved assumptions visible. Do not invent material or silently change the goal. Return only JSON matching the schema.',
    draftOutputSchema, frozen, method,
  );

  const revisionHash = createHash('sha256').update(implementationHash).update(method.sha256).digest('hex');
  return workflow<WorkflowInput, ArticleWorkflowOutput>('creation.article', { revision: `1-${revisionHash.slice(0, 24)}` }, async (ctx, rawInput) => {
    const input = articleInputSchema.parse(rawInput);
    if (JSON.stringify(input) !== JSON.stringify(frozen)) throw new Error('Article workflow configuration and frozen input differ');
    const definitionPhase = await ctx.phase('content-definition', {
      title: 'Define content', purpose: 'Choose the article promise and evidence boundary',
      expectedArtifacts: [{ role: 'definition', required: true }],
    }, async phase => {
      const result = input.revision?.definition ?? await phase.agent('define', defining, input);
      const check = await phase.validate('check-definition', result, value => valid(definitionSchema, value,
        definition => sourceError(definition.materialRoles.map(role => role.sourceId), available)));
      if (!check.valid) return phase.blocked({ reason: 'invalid-definition', details: check.details });
      const ref = await phase.publish('definition', 'definition', {
        kind: 'definition', content: definitionContent(result), payload: result,
        ...(input.revision ? { origin: { kind: 'copied-from-parent-input' as const,
          parentArtifactId: input.revision.parentAssetId, parentHash: input.revision.parentHash } } : {}),
      } satisfies ArticleAsset<ContentDefinition>, {
        schemaVersion: 'v1', validation: 'valid', review: 'pending',
      });
      await phase.bindArtifact(ref, { role: 'definition', primary: true });
      return { value: result, ref };
    });
    if (isTerminal(definitionPhase)) return definitionPhase;
    const definition = definitionPhase.value;
    const definitionRef = definitionPhase.ref;

    const first = await ctx.phase('article-draft', {
      title: input.revision ? 'Revise article from user feedback' : 'Write complete article',
      purpose: 'Create a readable full article and check its source references',
      expectedArtifacts: [{ role: 'candidate', required: true }],
    }, async phase => {
      const result = input.revision
        ? await phase.agent('revise-from-feedback', reviser, {
          input, definition, parentDraft: input.revision.draft, parentAssetId: input.revision.parentAssetId,
          parentHash: input.revision.parentHash, feedback: input.revision.feedback,
        })
        : await phase.agent('write', author, { input, definition });
      const check = await phase.validate('check-draft', result, value => valid(draftSchema, value,
        draft => sourceError(draft.sourceIds, available)));
      if (!check.valid) return phase.blocked({ reason: 'invalid-draft', details: check.details });
      const ref = await phase.publish('draft', 'draft', {
        kind: 'draft', content: draftContent(result), payload: result,
      } satisfies ArticleAsset<Draft>, {
        schemaVersion: 'v1', validation: 'valid', review: 'pending', dependsOn: [
          dependency(definitionRef),
          ...(input.revision ? [{ artifactId: input.revision.parentAssetId,
            revision: input.revision.parentRevision, sha256: input.revision.parentHash }] : []),
        ],
      });
      await phase.bindArtifact(ref, { role: 'candidate', primary: true });
      return { value: result, ref };
    });
    if (isTerminal(first)) return first;
    let candidate = first.value;
    let candidateRef = first.ref;

    for (let round = 0; round <= input.maxRevisions; round++) {
      const reviewed = await ctx.phase(`article-review-${round}`, {
        title: `Review article version ${round + 1}`,
        purpose: 'Independently inspect the exact candidate and the complete article',
        expectedArtifacts: [{ role: 'review', required: true }],
      }, async phase => {
        const result = await phase.agent('review', reviewer, {
          definition, definitionRef: dependency(definitionRef), candidate, candidateRef: dependency(candidateRef),
          materials: input.materials, audience: input.audience, constraints: input.constraints,
        });
        const check = await phase.validate('check-review', result, value => valid(reviewSchema, value));
        if (!check.valid) return phase.blocked({ reason: 'invalid-review', candidate: dependency(candidateRef), details: check.details });
        const ref = await phase.publish('review', 'review', {
          kind: 'review', content: reviewContent(result), payload: result,
        } satisfies ArticleAsset<Review>, {
          schemaVersion: 'v1', validation: 'valid', review: 'not_applicable', dependsOn: [dependency(candidateRef)],
        });
        await phase.bindArtifact(ref, { role: 'review', primary: true });
        return { value: result, ref };
      });
      if (isTerminal(reviewed)) return reviewed;
      const review = reviewed.value;
      ctx.decide(`quality-route-${round}`, { verdict: review.verdict, candidate: dependency(candidateRef), review: dependency(reviewed.ref) });
      if (review.verdict === 'pass') return { quality: 'passed', definition: definitionRef, candidate: candidateRef, review: reviewed.ref };
      if (review.verdict === 'blocked' || round === input.maxRevisions) {
        return ctx.needsReview({ quality: 'unresolved', reason: review.verdict === 'blocked' ? 'review-blocked' : 'revision-budget-exhausted',
          definition: definitionRef, candidate: candidateRef, review: reviewed.ref });
      }
      const previous = candidateRef;
      const revision = await ctx.phase(`article-repair-${round + 1}`, {
        title: `Repair article version ${round + 1}`,
        purpose: 'Address the exact review findings in a new complete draft',
        expectedArtifacts: [{ role: 'candidate', required: true }],
      }, async phase => {
        const result = await phase.agent('repair', reviser, {
          input, definition, candidate, candidateRef: dependency(previous),
          review, reviewRef: dependency(reviewed.ref),
        });
        const check = await phase.validate('check-repair', result, value => valid(draftSchema, value,
          draft => sourceError(draft.sourceIds, available)));
        if (!check.valid) return phase.blocked({ reason: 'invalid-revision', candidate: dependency(previous), details: check.details });
        const ref = await phase.publish('draft', 'draft', {
          kind: 'draft', content: draftContent(result), payload: result,
        } satisfies ArticleAsset<Draft>, {
          schemaVersion: 'v1', validation: 'valid', review: 'pending',
          dependsOn: [dependency(definitionRef), dependency(previous), dependency(reviewed.ref)],
        });
        await phase.bindArtifact(ref, { role: 'candidate', primary: true });
        return { value: result, ref };
      });
      if (isTerminal(revision)) return revision;
      candidate = revision.value;
      candidateRef = revision.ref;
    }
    throw new Error('Unreachable article review state');
  });
}

/** Runs real Codex SDK agents. The trace root must be a private state directory. */
export function createArticleRunner(options: { traceRoot: string }): AgentRunner {
  if (!options.traceRoot || !path.isAbsolute(options.traceRoot)) throw new Error('An absolute private traceRoot is required');
  return new CodexSdkRunner(undefined, options.traceRoot);
}
