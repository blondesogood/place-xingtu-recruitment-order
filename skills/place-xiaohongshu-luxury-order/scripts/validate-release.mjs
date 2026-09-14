#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const json=file=>JSON.parse(readFileSync(join(root,file),'utf8'));
const digest=value=>createHash('sha256').update(value).digest('hex');
try{
  const release=json('references/release.json'),rules=json('references/'+release.rulesFile);
  if(release.skillName!=='place-xiaohongshu-luxury-order'||!/^\d+\.\d+\.\d+$/.test(release.version??'')||release.status!=='RELEASED'||release.writeGate!=='EXPLICIT_BATCH_AUTHORIZATION_AND_FINAL_FACT_CHECK'||release.state?.storage!=='CONFIGURABLE_ATOMIC_JSON'||release.runtime?.operations?.join(',')!=='ORDER,PAYMENT'||rules.rulesVersion!==release.rulesVersion||rules.payment?.trigger!=='EXPLICIT_PAYMENT_CAPABILITY')throw new Error('CONTRACT_INVALID');
  const files=[...release.artifactFiles].sort();
  if(new Set(files).size!==files.length||files.some(file=>file.startsWith('/')||file.split('/').includes('..')))throw new Error('ARTIFACT_PATH_INVALID');
  for(const file of files){
    if(!existsSync(join(root,file)))throw new Error('ARTIFACT_FILE_MISSING:'+file);
    if(file.endsWith('.test.mjs')||file.includes('test/'))throw new Error('DEVELOPMENT_FILE_IN_ARTIFACT');
    if(!file.endsWith('.mjs'))continue;
    const text=readFileSync(join(root,file),'utf8');
    if(file!=='scripts/validate-release.mjs'&&['node:sqlite','keychain-helper','private-secret-store','/Users/'].some(token=>text.includes(token)))throw new Error('PRIVATE_DEPENDENCY_PRESENT:'+file);
    for(const match of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g))if(!files.includes(posix.normalize(posix.join(posix.dirname(file),match[1]))))throw new Error('UNPACKAGED_IMPORT:'+file);
  }
  const manifest=json('CONTENT-MANIFEST.json');
  if(manifest.schemaVersion!==2||manifest.scope!=='RUNTIME_ARTIFACTS'||manifest.version!==release.version||JSON.stringify(manifest.files.map(v=>v.file))!==JSON.stringify(files))throw new Error('CONTENT_MANIFEST_INVALID');
  for(const entry of manifest.files){const bytes=readFileSync(join(root,entry.file));if(entry.bytes!==bytes.length||entry.sha256!==digest(bytes))throw new Error('CONTENT_MANIFEST_INVALID:'+entry.file);}
  process.stdout.write(JSON.stringify({ok:true,version:release.version,status:release.status,artifactFiles:files.length,artifactDigest:digest(manifest.files.map(e=>e.sha256).join(''))})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,reason:error.message})+'\n');process.exitCode=2;}
