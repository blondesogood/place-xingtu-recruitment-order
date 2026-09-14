#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const release=JSON.parse(readFileSync(join(root,'references/release.json'),'utf8'));
const files=[...release.artifactFiles].sort().map(file=>{const bytes=readFileSync(join(root,file));return {file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
writeFileSync(join(root,'CONTENT-MANIFEST.json'),JSON.stringify({schemaVersion:2,scope:'RUNTIME_ARTIFACTS',skillName:release.skillName,version:release.candidateVersion,files},null,2)+'\n');
