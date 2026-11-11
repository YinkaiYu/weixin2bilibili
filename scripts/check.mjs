import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));
const packageInfo=JSON.parse((await readFile('package.json','utf8')).replace(/^\uFEFF/,''));
if(manifest.manifest_version!==3)throw new Error('Must use MV3');
if(packageInfo.version!==manifest.version)throw new Error('package.json and manifest.json versions differ');
const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(f.endsWith('.js'))files.push(f);}}await walk('extension');
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status)throw new Error(file+': '+r.stderr);}
for(const script of manifest.content_scripts.flatMap(c=>c.js))await readFile(path.join('extension',script));
await readFile(path.join('extension',manifest.background.service_worker));
const client=await readFile('extension/lib/bilibili.js','utf8');
if(/https:\/\/[^'"\s]+\/(?:publish|submit)/.test(client))throw new Error('Unexpected publish endpoint');
console.log(`Manifest, ${files.length} JavaScript files, local assets and draft-only boundary checked.`);
