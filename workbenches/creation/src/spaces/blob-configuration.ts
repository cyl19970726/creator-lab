import {readFile,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {Pool} from 'pg';
import {PostgresBlobStore,createR2BlobStore,RoutedBlobStore} from '@signal-room/workflow-spaces';

/** Host-only configuration. Storage credentials never enter assets, node inputs or logs. */
export async function openConfiguredContentBlobs(pool:Pool,configPath=process.env.WORKFLOW_BLOB_CONFIG){
  const legacy=new PostgresBlobStore(pool);
  if(!configPath)return {blobs:legacy,legacy};
  if(!isAbsolute(configPath))throw new Error('WORKFLOW_BLOB_CONFIG must be an absolute private file path');
  const info=await stat(configPath);
  if(!info.isFile()||(info.mode&0o077)!==0)throw new Error('Workflow blob configuration must be a private file');
  let config:Record<string,unknown>;
  try{config=JSON.parse(await readFile(configPath,'utf8'));}
  catch{throw new Error('Invalid workflow blob configuration');}
  if(!config||typeof config!=='object'||Array.isArray(config)||config.provider!=='r2')throw new Error('Unsupported workflow blob provider');
  const required=(key:string)=>{const value=config[key];if(typeof value!=='string'||!value.trim())throw new Error(`Workflow blob configuration requires ${key}`);return value;};
  if(config.keyPrefix!==undefined&&typeof config.keyPrefix!=='string'||config.maxBytes!==undefined&&(typeof config.maxBytes!=='number'||!Number.isSafeInteger(config.maxBytes)||config.maxBytes<1))throw new Error('Invalid workflow blob limits or prefix');
  const r2=await createR2BlobStore({endpoint:required('endpoint'),bucket:required('bucket'),
    accessKeyId:required('accessKeyId'),secretAccessKey:required('secretAccessKey'),
    ...(typeof config.keyPrefix==='string'?{keyPrefix:config.keyPrefix}:{}),
    ...(typeof config.maxBytes==='number'?{maxBytes:config.maxBytes}:{})});
  return {blobs:new RoutedBlobStore(legacy,r2),legacy};
}
