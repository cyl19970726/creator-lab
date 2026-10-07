import { SchemaRegistry } from '@signal-room/workflow-space-contracts';
import type { WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { registerCreationSchemas } from './contracts.js';
import { buildContentPresentation } from './presentation.js';

/** Display bindings are independent from the immutable CONTENT method and its fingerprints. */
export async function registerContentPresentation(service:WorkflowSpaceService,spaceId:string):Promise<void> {
  const definition=buildContentPresentation(registerCreationSchemas(new SchemaRegistry()));
  const data=await service.overview(spaceId);
  const versions=data.workflows.filter(value=>value.entrypoints.content);
  if(!versions.length)return;
  const unbound=[];
  for(const version of versions) {
    const prior=await service.resolvePresentation(spaceId,version.id,'content');
    if(prior?.presentation.id===definition.id&&prior.presentation.revision===definition.revision)continue;
    unbound.push(version);
  }
  if(!unbound.length)return;
  await service.registerPresentation(spaceId,definition);
  for(const version of unbound)await service.bindPresentation(spaceId,{workflowVersionId:version.id,entrypoint:'content',presentationId:definition.id,revision:definition.revision});
}
