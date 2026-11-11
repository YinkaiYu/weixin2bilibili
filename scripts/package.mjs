import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {zipSync,unzipSync} from 'fflate';

const PROJECT_ROOT=fileURLToPath(new URL('../',import.meta.url));
const ALLOWED_EXTENSIONS=new Set(['.js','.json','.png','.jpg','.jpeg','.gif','.webp','.svg','.html','.css','.md','.txt']);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function createReleaseNotes(changelog,version,filename){
  const text=changelog.replace(/\r\n?/g,'\n'),headings=[...text.matchAll(/^##\s+([^\n]+)$/gm)];
  const matches=headings.filter(heading=>heading[1].trim()===version);
  if(matches.length!==1)throw new Error(`CHANGELOG.md must contain exactly one section for ${version}.`);
  const heading=matches[0],index=headings.indexOf(heading),next=headings[index+1]?.index??text.length;
  const body=text.slice(heading.index+heading[0].length,next).trim();
  if(!body)throw new Error(`CHANGELOG.md section for ${version} is empty.`);
  return `下载下方的 \`${filename}\` 并解压，在 Edge 扩展管理页开启开发者模式，选择“加载解压缩的扩展”。\n\n${body}\n`;
}

async function collectFiles(directory,prefix=''){
  const files=[];
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const name=prefix+entry.name;
    if(entry.name.startsWith('.')||/[\\\u0000-\u001f]/u.test(entry.name))throw new Error(`Unexpected extension path: ${name}`);
    if(entry.isDirectory())files.push(...await collectFiles(path.join(directory,entry.name),name+'/'));
    else if(entry.isFile()&&ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))files.push(name);
    else throw new Error(`Unsupported extension file or symbolic link: ${name}`);
  }
  return files;
}

/** Verify names and every byte without writing archive paths to the filesystem. */
export function verifyArchive(bytes,files,version){
  const actual=unzipSync(bytes),expectedNames=Object.keys(files).sort(),actualNames=Object.keys(actual).sort();
  if(JSON.stringify(actualNames)!==JSON.stringify(expectedNames))throw new Error('ZIP file list differs from extension/.');
  for(const name of expectedNames){
    if(sha256(actual[name])!==sha256(files[name]))throw new Error(`ZIP content differs: ${name}`);
  }
  if(!actual['manifest.json']||JSON.parse(Buffer.from(actual['manifest.json']).toString('utf8')).version!==version)throw new Error('ZIP must contain the expected manifest.json at its root.');
  return actualNames.length;
}

/** All runtime files come from extension/; development dependencies stay outside. */
export async function buildPackage({root=PROJECT_ROOT,outputDir=path.join(root,'dist'),tag}={}){
  const readJson=async file=>JSON.parse((await readFile(path.join(root,file),'utf8')).replace(/^\uFEFF/,''));
  const [project,lock,manifest]=await Promise.all(['package.json','package-lock.json','extension/manifest.json'].map(readJson));
  const version=manifest.version;
  if(typeof version!=='string'||!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)||version.split('.').some(part=>Number(part)>65535)||version==='0.0.0')throw new Error('Invalid extension release version.');
  if([project.version,lock.version,lock.packages?.['']?.version].some(value=>value!==version))throw new Error('Package, lockfile and extension versions must match.');
  if(!/^[a-z0-9][a-z0-9.-]*$/.test(project.name)||lock.name!==project.name||lock.packages?.['']?.name!==project.name)throw new Error('Package and lockfile names must match a safe archive basename.');
  if(tag!==undefined&&tag!==`v${version}`)throw new Error(`Release tag must be v${version}, got ${tag}.`);
  const filename=`${project.name}-v${version}.zip`;
  const notes=createReleaseNotes(await readFile(path.join(root,'CHANGELOG.md'),'utf8'),version,filename);
  const extensionRoot=path.join(root,'extension'),extensionInfo=await lstat(extensionRoot);
  if(extensionInfo.isSymbolicLink()||!extensionInfo.isDirectory())throw new Error('extension/ must be a real directory.');
  const names=await collectFiles(extensionRoot),files=Object.create(null);
  for(const name of names)files[name]=new Uint8Array(await readFile(path.join(extensionRoot,...name.split('/'))));
  for(const name of ['manifest.json','LICENSE.txt','THIRD_PARTY_NOTICES.txt'])if(!files[name])throw new Error(`Required release file missing: ${name}`);
  // The ZIP format stores local calendar fields. Construct the same local date
  // in every timezone so identical input bytes produce identical archives.
  const entries=Object.create(null),mtime=new Date(1980,0,1,0,0,0);
  for(const name of names)entries[name]=[files[name],{level:/\.(?:png|jpe?g|gif|webp)$/i.test(name)?0:9}];
  const bytes=zipSync(entries,{mtime,os:3,attrs:0o100644<<16});
  const fileCount=verifyArchive(bytes,files,version);
  const checksum=`${sha256(bytes)}  ${filename}\n`;
  await mkdir(outputDir,{recursive:true});
  const archivePath=path.join(outputDir,filename),checksumPath=archivePath+'.sha256',notesPath=path.join(outputDir,'release-notes.md');
  await writeFile(archivePath,bytes);
  await writeFile(checksumPath,checksum,'utf8');
  await writeFile(notesPath,notes,'utf8');
  // Re-read both deliverables to check the files that will actually be uploaded.
  const persisted=await readFile(archivePath);
  verifyArchive(persisted,files,version);
  if(await readFile(checksumPath,'utf8')!==`${sha256(persisted)}  ${filename}\n`)throw new Error('Written SHA-256 checksum does not match the archive.');
  return {version,filename,archivePath,checksumPath,notesPath,sha256:sha256(persisted),fileCount};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);
    if(args.length&&!(args.length===2&&args[0]==='--tag'))throw new Error('Usage: npm run package -- [--tag vX.Y.Z]');
    const result=await buildPackage({tag:args[1]});
    console.log(`${result.filename}: ${result.fileCount} verified files\nSHA-256: ${result.sha256}\n${result.archivePath}\n${result.checksumPath}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
