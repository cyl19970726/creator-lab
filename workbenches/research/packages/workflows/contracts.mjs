import { createHash } from 'node:crypto';

export const isText = value => typeof value === 'string' && value.trim().length > 0;
export const identity = ref => ({ id: ref.id, revision: ref.revision, sha256: ref.sha256 });
export const dependency = ref => ({ artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 });
export const sameIdentity = (a, b) => Boolean(a && b && a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256);
export const validIdentity = value => Boolean(value && isText(value.id) && isText(value.revision) && /^[a-f0-9]{64}$/i.test(value.sha256));
export const documentCheck = value => ({ valid: Boolean(value && isText(value.title) && isText(value.document)), details: { reason: 'document-contract-invalid' } });
export const sourceHash = content => createHash('sha256').update(content, 'utf8').digest('hex');
const priorArtifact = item => Boolean(item && validIdentity(item.identity) && documentCheck(item.payload).valid);

export function inputCheck(input) {
  const sourceIds = new Set();
  const valid = input && ['workspaceId', 'topicId', 'title', 'goal', 'asOf'].every(key => isText(input[key]))
    && Array.isArray(input.readers) && input.readers.length > 0 && input.readers.every(isText)
    && Array.isArray(input.sources) && input.sources.length > 0
    && input.sources.every(source => {
      if (!source || !isText(source.id) || sourceIds.has(source.id) || !isText(source.title)
        || !isText(source.content) || sourceHash(source.content) !== source.sha256) return false;
      sourceIds.add(source.id);
      return source.url === undefined || typeof source.url === 'string';
    })
    && (!input.repair || (validIdentity(input.repair.candidate?.identity)
      && documentCheck(input.repair.candidate.payload).valid
      && ['expression', 'evidence'].includes(input.repair.route)
      && Array.isArray(input.repair.feedback) && input.repair.feedback.length > 0
      && input.repair.feedback.every(item => item && isText(item.id) && isText(item.body) && isText(item.location))
      && (input.repair.route !== 'expression' || (input.repair.prior
        && (!input.repair.prior.brief || priorArtifact(input.repair.prior.brief))
        && priorArtifact(input.repair.prior.synthesis)
        && Array.isArray(input.repair.prior.synthesis.payload.gaps)
        && input.repair.prior.synthesis.payload.gaps.length === 0
        && Array.isArray(input.repair.prior.evidence)
        && input.repair.prior.evidence.length > 0
        && input.repair.prior.evidence.every(priorArtifact)))));
  return { valid: Boolean(valid), details: valid ? undefined : { reason: 'research-input-invalid' } };
}

export function planCheck(value) {
  const base = documentCheck(value).valid;
  const ids = new Set();
  const valid = base && Array.isArray(value.problems) && value.problems.length > 0
    && value.problems.every(problem => {
      if (!problem || !isText(problem.id) || ids.has(problem.id) || !isText(problem.question)) return false;
      ids.add(problem.id);
      return true;
    });
  return { valid: Boolean(valid), details: valid ? undefined : { reason: 'research-plan-invalid' } };
}

export function gapsCheck(value, plan, foundationReviews = []) {
  const ids = new Set(plan.problems.map(item => item.id));
  const valid = documentCheck(value).valid && Array.isArray(value.gaps)
    && value.gaps.every(item => item && isText(item.problemId) && ids.has(item.problemId) && isText(item.question))
    && Array.isArray(value.findingResponses)
    && value.findingResponses.every(item => item && isText(item.reviewId) && isText(item.findingId)
      && ['addressed', 'unresolved'].includes(item.status) && isText(item.explanation));
  const required = foundationReviews.flatMap(review => review.value.findings.map(finding =>
    ({ reviewId: review.ref.id, findingId: finding.id })));
  const missing = valid ? required.filter(requiredItem => !value.findingResponses.some(response =>
    response.reviewId === requiredItem.reviewId && response.findingId === requiredItem.findingId)) : required;
  return { valid: Boolean(valid && missing.length === 0), details: valid && missing.length === 0
    ? undefined : { reason: 'research-gaps-or-finding-closure-invalid', missing } };
}

export function reviewCheck(value, target) {
  const valid = documentCheck(value).valid && sameIdentity(value.target, target)
    && ['pass', 'revise', 'insufficient-evidence', 'human-decision'].includes(value.decision)
    && Array.isArray(value.findings)
    && value.findings.every(item => item && isText(item.id) && isText(item.location) && isText(item.issue))
    && (value.decision !== 'pass' || value.findings.length === 0);
  return { valid: Boolean(valid), details: valid ? undefined : { reason: 'research-review-or-binding-invalid', target } };
}
