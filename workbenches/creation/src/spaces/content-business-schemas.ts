import { z } from 'zod';
import { JSON_SCHEMA_DIALECT, type SchemaDefinition, type SchemaRef } from '@signal-room/workflow-space-contracts';
import type { FrozenSchemaRevision } from '@signal-room/workflow-space-contracts';

const id=z.string().trim().min(1).max(240);
const text=z.string().trim().min(1);
export const contentBusinessRequestSchema=z.object({
  title:text, objective:text, requiredQuestions:z.array(text).min(1),
  accountName:text, positioning:text, currentAudience:text, form:text, standards:text,
  materials:z.array(z.object({id,title:text,source:text,text}).strict()).min(1),
  maxSeconds:z.number().int().positive().optional(),
}).strict().superRefine((value,ctx)=>{
  const seen=new Set<string>();
  for(const [index,item] of value.materials.entries()){
    if(!id.safeParse(item.id).success||seen.has(item.id))ctx.addIssue({code:'custom',path:['materials',index,'id'],message:'Material ID is missing, invalid, or duplicated'});
    seen.add(item.id);
  }
});
export type ContentBusinessRequest=z.infer<typeof contentBusinessRequestSchema>;

export const contentBusinessPreparationSchema=z.object({
  caseId:id,versionId:id,inputManifestId:id,inputManifestHash:text,
  conditions:z.array(text),input:contentBusinessRequestSchema,
}).strict();
export const contentHandlingNotePayloadSchema=z.object({
  caseId:id,runId:id,subjectAssetId:id,
  author:z.object({kind:z.literal('external-agent'),name:text,threadId:id}).strict(),
  answers:z.object({good:z.string(),bad:z.string(),improvement:z.string(),unresolved:z.string()}).strict(),
  recommendation:z.enum(['needs_revision','pending_human_review','defer']),
  nextStep:text,referencedAssetIds:z.array(id).max(50),verification:z.literal('declared-external'),
}).strict();

const definition=(namespace:string,shape:z.ZodType):SchemaDefinition=>({
  namespace,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{...(z.toJSONSchema(shape,{target:'draft-2020-12'}) as Record<string,unknown>),$schema:JSON_SCHEMA_DIALECT} as unknown as SchemaDefinition['schema'],
});
export const contentBusinessSchemaDefinitions=()=>[
  definition('creation/content-business-preparation',contentBusinessPreparationSchema),
  definition('creation/content-handling-note',contentHandlingNotePayloadSchema),
];
export function contentBusinessSchemaRefs(rows:FrozenSchemaRevision[]):{preparation:SchemaRef;note:SchemaRef}{
  const find=(namespace:string)=>{const value=rows.find(row=>row.namespace===namespace&&row.revision==='1');if(!value)throw new Error(`Business schema missing: ${namespace}`);return {namespace:value.namespace,revision:value.revision,hash:value.hash};};
  return {preparation:find('creation/content-business-preparation'),note:find('creation/content-handling-note')};
}
