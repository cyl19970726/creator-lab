import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { WorkbenchStore } from '../src/workbench/store.js';
import { acquireWorkerLock } from '../src/infrastructure/process-lock.js';
import { backupWorkbench, restoreWorkbench } from '../scripts/workbench-backup.js';

const roots: string[]=[];
afterEach(()=> { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'wb-backup-test-')); roots.push(root);
  const state=path.join(root,'state'), backup=path.join(root,'backup'), restored=path.join(root,'restored');
  const store=new WorkbenchStore(state);
  const created=store.createCase({commandId:'case',title:'Article',opportunity:'Explain',readerGoal:'Understand',requiredQuestions:['Why?'],account:{name:'A',positioning:'P',currentAudience:'Beginners',referencePieces:[]},form:'article',materials:[{id:'m',title:'Source',text:'Evidence'}],webResearch:false},{kind:'user',id:'creator'});
  store.close();
  mkdirSync(path.join(state,'runs','one'),{recursive:true});
  writeFileSync(path.join(state,'runs','one','input.json'),'private data',{mode:0o600});
  writeFileSync(path.join(state,'auth.json'),'should not copy',{mode:0o600});
  return {root,state,backup,restored,created};
}

test('offline backup and restore roundtrip preserve control records and private files',async()=>{
  const f=fixture();
  const manifest=await backupWorkbench(f.state,f.backup);
  expect(manifest.schema).toBe('workbench-state-v1');
  expect(manifest.files.some(file=>file.path==='workbench.sqlite')).toBe(true);
  expect(manifest.files.some(file=>file.path==='auth.json')).toBe(false);
  expect(manifest.files.some(file=>file.path.endsWith('worker.lock'))).toBe(false);
  await restoreWorkbench(f.backup,f.restored);
  expect(readFileSync(path.join(f.restored,'runs','one','input.json'),'utf8')).toBe('private data');
  const restored=new WorkbenchStore(f.restored);
  try {expect(restored.getCase(f.created.id).input.title).toBe('Article');} finally {restored.close();}
});

test('backup refuses live API or worker lock',async()=>{
  const f=fixture();
  const api=await acquireWorkerLock(path.join(f.state,'.api-process'));
  try {await expect(backupWorkbench(f.state,f.backup)).rejects.toThrow(/owns this state root/);} finally {await api.release();}
  const worker=await acquireWorkerLock(f.state);
  try {await expect(backupWorkbench(f.state,f.backup)).rejects.toThrow(/owns this state root/);} finally {await worker.release();}
  expect(await backupWorkbench(f.state,f.backup)).toBeDefined();
});

test('restore verifies every file before touching a fresh target and preserves a nonempty target',async()=>{
  const f=fixture(); await backupWorkbench(f.state,f.backup);
  writeFileSync(path.join(f.backup,'runs','one','input.json'),'tampered');
  await expect(restoreWorkbench(f.backup,f.restored)).rejects.toThrow(/hash mismatch/);
  mkdirSync(f.restored); writeFileSync(path.join(f.restored,'keep.txt'),'keep');
  await expect(restoreWorkbench(f.backup,f.restored)).rejects.toThrow();
  expect(readFileSync(path.join(f.restored,'keep.txt'),'utf8')).toBe('keep');
});

test('backup rejects source-contained destination and symlinks; restore rejects destination inside backup',async()=>{
  const f=fixture();
  await expect(backupWorkbench(f.state,path.join(f.state,'nested'))).rejects.toThrow(/separate/);
  symlinkSync(path.join(f.root,'outside'),path.join(f.state,'runs','one','escape'));
  await expect(backupWorkbench(f.state,f.backup)).rejects.toThrow(/Symlink/);
  rmSync(path.join(f.state,'runs','one','escape'));
  await backupWorkbench(f.state,f.backup);
  await expect(restoreWorkbench(f.backup,path.join(f.backup,'nested'))).rejects.toThrow(/separate/);
});
