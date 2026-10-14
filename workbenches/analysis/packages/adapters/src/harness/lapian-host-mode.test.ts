import {describe,expect,it} from 'vitest';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';
import {lapianHostMode} from '../../../../scripts/lapian-host-mode.js';

type Sections=Required<Pick<SpaceApiHost,'understanding'|'methodDesign'|'methodExecution'>>;
const read=async()=>null as never;
const history=async()=>[] as never;
const sections:Sections={
 understanding:{current:read,read,history,save:async()=>({}) as never},
 methodDesign:{current:read,read,history,basis:read,preview:async()=>({}) as never,
  save:async()=>({}) as never,publish:async()=>({}) as never},
 methodExecution:{status:async()=>({operations:['inputs-freeze','start']}),command:async()=>({state:'prepared'})},
};

describe('lapian observation host mode',()=>{
 it('removes implementation, understanding and method mutation while preserving saved reads',()=>{
  const limited=lapianHostMode(true,sections);
  expect(limited.methodExecution.status).toBe(sections.methodExecution.status);
  expect(limited.methodExecution).not.toHaveProperty('command');
  expect(limited.methodDesign.current).toBe(sections.methodDesign.current);
  expect(limited.methodDesign.preview).toBe(sections.methodDesign.preview);
  expect(limited.methodDesign).not.toHaveProperty('save');
  expect(limited.methodDesign).not.toHaveProperty('publish');
  expect(limited.understanding.history).toBe(sections.understanding.history);
  expect(limited.understanding).not.toHaveProperty('save');
  // The API's methodExecutionWrite/methodPublish capability checks require these absent hooks.
  expect(Boolean(limited.methodExecution.command)).toBe(false);
  expect(Boolean(limited.methodDesign.publish)).toBe(false);
 });
 it('keeps the existing execution host intact unless the mode is explicitly enabled',()=>{
  expect(lapianHostMode(false,sections)).toBe(sections);
 });
});
