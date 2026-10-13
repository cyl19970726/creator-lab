import {createBusinessUnderstandingStore,createMethodCapabilityStore,createMethodDesignStore,
  type SpacePrincipal,type WorkflowSpaceService} from '@signal-room/workflow-spaces';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';
import type {MethodDesignDefinitionDto} from '@signal-room/workflow-space-api/contracts';
import {buildExplanatoryMethodCandidate} from './explanatory-method-provider.js';

export interface ExplanatoryDesignHostOptions {
  service:WorkflowSpaceService;
  ownerService:WorkflowSpaceService;
  principal:SpacePrincipal;
  spaceId:string;
  scope:{workflowId:string;entrypoint:string};
  canWrite:boolean;
  withPublicationLock:<T>(work:()=>Promise<T>)=>Promise<T>;
}

/** Trusted domain composition. Stored packages can select only this installed provider. */
export function createExplanatoryMethodDesignHost(options:ExplanatoryDesignHostOptions):Pick<SpaceApiHost,'methodDesign'> {
  const {service,ownerService,spaceId,scope,principal,canWrite}=options;
  if(scope.workflowId!=='content.explanatory-method'||scope.entrypoint!=='content')
    throw new Error('This provider does not own the selected design Space scope');
  const designStore=createMethodDesignStore(service);
  const capabilityStore=createMethodCapabilityStore(service);
  const understandingStore=createBusinessUnderstandingStore(service);
  const requireSpace=(selected:string)=>{if(selected!==spaceId)throw new Error('Method design belongs to another Space');};
  const read=async(selected:string,revisionId:string)=>{
    requireSpace(selected);const design=await designStore.read(selected,revisionId);
    if(design.workflowId!==scope.workflowId||design.entrypoint!==scope.entrypoint)throw new Error('Method design scope mismatch');
    return design;
  };
  const compile=async(selected:string,revisionId:string)=>{
    const design=await read(selected,revisionId);
    if(!design.capability)throw new Error('Save an exact professional capability package before compiling this design');
    const [capability,understanding]=await Promise.all([
      capabilityStore.read(selected,design.capability.revisionId),
      understandingStore.read(selected,design.understanding.revisionId),
    ]);
    return buildExplanatoryMethodCandidate(capability,design,understanding);
  };
  const requireOwnDesign=(design:Awaited<ReturnType<typeof read>>)=>{
    const agent=principal.externalAgent;
    if(!canWrite||principal.kind!=='service'||agent?.role!=='design'||design.recordedBy!==principal.id||
      design.authorship.kind!=='agent'||design.authorship.name!==agent.id||design.authorship.sessionId!==agent.sessionId)
      throw new Error('Publication requires the authenticated design Agent and its exact saved design');
  };
  return {methodDesign:{
    current:async selected=>{requireSpace(selected);return designStore.current(selected,scope.workflowId);},
    read,
    history:async selected=>{requireSpace(selected);return designStore.history(selected,scope.workflowId);},
    basis:async(selected,versionId)=>{requireSpace(selected);return designStore.readBasis(selected,versionId);},
    ...(canWrite?{save:async(selected:string,input:Parameters<typeof designStore.save>[1])=>{
      requireSpace(selected);
      if(input.workflowId!==scope.workflowId||input.entrypoint!==scope.entrypoint)throw new Error('Method design scope mismatch');
      // Schema setup belongs to this explicit mutation, never to startup or reads.
      await createMethodDesignStore(ownerService).ensure(selected);
      return designStore.save(selected,input);
    }}:{}),
    definition:async(selected,revisionId)=>JSON.parse(JSON.stringify(await compile(selected,revisionId))) as MethodDesignDefinitionDto,
    preview:async(selected,revisionId)=>{
      const candidate=await compile(selected,revisionId);
      return {versionId:candidate.candidateId,workflowId:candidate.workflowId,entrypoint:candidate.entrypoint,
        designRevisionId:candidate.designRevisionId,designHash:candidate.designPayloadHash,
        understandingRevisionId:candidate.understandingRevisionId,understandingHash:candidate.understandingPayloadHash,
        availability:candidate.availability.state,blockers:[candidate.availability.reason]};
    },
    ...(canWrite?{publish:async(selected:string,input:{designRevisionId:string;expectedCandidateId:string})=>{
      requireSpace(selected);
      return options.withPublicationLock(async()=>{
        requireOwnDesign(await read(selected,input.designRevisionId));
        const candidate=await compile(selected,input.designRevisionId);
        if(candidate.candidateId!==input.expectedCandidateId)throw new Error('Method candidate changed; read the exact definition again');
        const existing=(await service.overview(selected)).workflows.filter(version=>
          version.entrypoints[scope.entrypoint]?.workflowId===scope.workflowId);
        if(!candidate.version.predecessorId&&existing.some(version=>version.id!==candidate.candidateId))
          throw new Error('A successor package must name its exact predecessor version');
        if(candidate.version.predecessorId&&!existing.some(version=>version.id===candidate.version.predecessorId))
          throw new Error('Method predecessor is not a published version in this Space scope');
        await ownerService.registerSchemas(selected,candidate.schemas);
        const published=await ownerService.publishWorkflow(selected,candidate.version);
        const presentation=await ownerService.registerPresentation(selected,candidate.presentation);
        const binding=await service.resolvePresentation(selected,published.id,scope.entrypoint);
        if(binding&&(binding.presentation.hash!==presentation.hash||binding.presentation.id!==presentation.id||
          binding.presentation.revision!==presentation.revision))throw new Error('Exact method presentation binding differs');
        if(!binding)await ownerService.bindPresentation(selected,{workflowVersionId:published.id,entrypoint:scope.entrypoint,
          presentationId:presentation.id,revision:presentation.revision});
        return {versionId:published.id,designRevisionId:candidate.designRevisionId,
          understandingRevisionId:candidate.understandingRevisionId};
      });
    }}:{}),
  }};
}
