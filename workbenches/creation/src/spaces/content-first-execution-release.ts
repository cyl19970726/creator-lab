import type {InputManifest} from '@signal-room/workflow-spaces';
import type {ContentInput} from '../stages/content.js';
import type {StageModel} from '../stages/runtime.js';
import type {ContentBusinessExecutionRelease} from './content-business-commands.js';

export const CONTENT_FIRST_EXECUTION_BUDGET={maxAgentCalls:15,maxDurationMs:3_600_000,perAgentTimeoutMs:900_000} as const;
export interface ContentFirstExecutionRelease extends ContentBusinessExecutionRelease {
  authorizedAction:'one-frontend-start';
  executionBudget:typeof CONTENT_FIRST_EXECUTION_BUDGET;
}
export interface ContentFirstExecutionSubject {
  caseId:string;versionId:string;manifest:InputManifest;parsed:ContentInput;runId?:string;
}
export interface ContentFirstExecutionGateOptions {
  spaceId:string;principalId:string;models:{worker:StageModel;judge:StageModel};
  loadRelease:()=>Promise<ContentFirstExecutionRelease|null>;
  verifyExclusive:(release:ContentFirstExecutionRelease)=>Promise<boolean>;
  now?:()=>number;
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const same=(left:unknown,right:unknown):boolean=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));

/** A host execution restriction, separate from the immutable method's design record. */
export function createContentFirstExecutionGate(options:ContentFirstExecutionGateOptions) {
  return async (subject:ContentFirstExecutionSubject):Promise<typeof CONTENT_FIRST_EXECUTION_BUDGET>=>{
    if(subject.parsed.webResearch!==false)throw new Error('本次首版只允许给定材料；联网输入不会排队或派发。');
    if(subject.parsed.prior||subject.parsed.maxRevisions!==2||subject.parsed.topicId!==subject.caseId)
      throw new Error('本次输入必须是无先前稿的独立 Case，最多修订 2 次。');
    const value=await options.loadRelease();
    const manifest=subject.manifest;
    if(!value||value.revision!==1||value.authorizedAction!=='one-frontend-start'||
      value.spaceId!==options.spaceId||value.principalId!==options.principalId||value.caseId!==subject.caseId||
      value.versionId!==subject.versionId||value.inputManifestId!==manifest.id||value.inputManifestHash!==manifest.hash||
      manifest.spaceId!==options.spaceId||manifest.caseId!==subject.caseId||
      value.webResearch!==false||value.maxRevisions!==2||!same(value.models,options.models)||
      !same(value.executionBudget,CONTENT_FIRST_EXECUTION_BUDGET)||
      !Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=(options.now??Date.now)())
      throw new Error('准确 Case、版本、输入、模型与有界执行核验未匹配，不能启动调用。');
    if(!value.exclusive||!Number.isFinite(Date.parse(value.exclusive.confirmedAt))||!(await options.verifyExclusive(value)))
      throw new Error('本次执行的独占条件未通过核对。');
    return {...CONTENT_FIRST_EXECUTION_BUDGET};
  };
}
