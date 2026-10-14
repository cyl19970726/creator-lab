import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';

type Sections=Required<Pick<SpaceApiHost,'understanding'|'methodDesign'|'methodExecution'>>;

/** Read-only hosting still permits independently authenticated observation and assessment elsewhere. */
export function lapianHostMode(readOnly:boolean,sections:Sections):Sections{
 if(!readOnly)return sections;
 const {understanding,methodDesign,methodExecution}=sections;
 return {
  understanding:{current:understanding.current,read:understanding.read,history:understanding.history},
  methodDesign:{current:methodDesign.current,read:methodDesign.read,history:methodDesign.history,
   basis:methodDesign.basis,...(methodDesign.preview?{preview:methodDesign.preview}:{}),
   ...(methodDesign.definition?{definition:methodDesign.definition}:{})},
  methodExecution:{status:methodExecution.status},
 };
}
