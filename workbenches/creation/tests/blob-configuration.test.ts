import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {PostgresBlobStore,RoutedBlobStore} from '@signal-room/workflow-spaces';
import {openConfiguredContentBlobs} from '../src/spaces/blob-configuration.js';

const directories:string[]=[];
const pool={} as Pool;
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function configFile(value:unknown,mode=0o600){const dir=await mkdtemp(join(tmpdir(),'workflow-blob-config-'));directories.push(dir);const path=join(dir,'config.json');await writeFile(path,JSON.stringify(value),{mode});return path;}
it('keeps the PG baseline without storage configuration and routes only explicit private R2 configuration',async()=>{
  const baseline=await openConfiguredContentBlobs(pool,'');expect(baseline.blobs).toBeInstanceOf(PostgresBlobStore);
  const path=await configFile({provider:'r2',endpoint:'https://fixture.r2.cloudflarestorage.com',bucket:'isolated-fixture',accessKeyId:'fixture-key',secretAccessKey:'fixture-secret'});
  const configured=await openConfiguredContentBlobs(pool,path);expect(configured.blobs).toBeInstanceOf(RoutedBlobStore);expect(configured.legacy).toBeInstanceOf(PostgresBlobStore);
});
it('rejects nonprivate configuration and unsupported providers before network or storage activity',async()=>{
  await expect(openConfiguredContentBlobs(pool,'relative.json')).rejects.toThrow('absolute');
  await expect(openConfiguredContentBlobs(pool,await configFile({provider:'r2'},0o644))).rejects.toThrow('private');
  await expect(openConfiguredContentBlobs(pool,await configFile({provider:'unknown'}))).rejects.toThrow('Unsupported');
  await expect(openConfiguredContentBlobs(pool,await configFile({provider:'r2'}))).rejects.toThrow('requires endpoint');
});
