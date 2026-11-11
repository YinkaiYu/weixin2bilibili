import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {zipSync,unzipSync} from 'fflate';
import {buildPackage,verifyArchive,createReleaseNotes} from '../scripts/package.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const prefix=path.join(tmpdir(),'weixin2bilibili-package-'),root=await mkdtemp(prefix);
  t.after(async()=>{
    assert.ok(path.isAbsolute(root)&&root.startsWith(prefix),'cleanup stays in the temporary fixture');
    await rm(root,{recursive:true,force:true});
  });
  const project={name:'weixin2bilibili',version:'0.1.9'};
  const files={
    'manifest.json':JSON.stringify({manifest_version:3,name:'测试扩展',version:project.version}),
    'LICENSE.txt':'Synthetic license fixture\n',
    'THIRD_PARTY_NOTICES.txt':'Synthetic notices fixture\n',
    'lib/example.js':'export const value="正文";\n',
    'icons/icon.png':new Uint8Array([0,1,2,127,128,254,255]),
    '使用说明.md':'# 使用说明\n直接加载解压后的目录。\n',
  };
  for(const [name,value]of Object.entries(files)){
    const target=path.join(root,'extension',...name.split('/'));
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,value);
  }
  await writeFile(path.join(root,'package.json'),JSON.stringify(project));
  await writeFile(path.join(root,'package-lock.json'),JSON.stringify({...project,lockfileVersion:3,packages:{'':project}}));
  await writeFile(path.join(root,'CHANGELOG.md'),'# 更新记录\n\n## 0.1.9\n\n- 当前版本公开说明。\n\n## 0.1.8\n\n- 历史内部调试记录。\n');
  return {root,files};
}

test('package contains only extension files at the ZIP root and ships an accurate checksum',async t=>{
  const {root,files}=await fixture(t);
  await writeFile(path.join(root,'private-account.json'),'not for distribution');
  const result=await buildPackage({root,tag:'v0.1.9'}),bytes=await readFile(result.archivePath),entries=unzipSync(bytes);
  assert.equal(result.filename,'weixin2bilibili-v0.1.9.zip');
  assert.equal(result.fileCount,Object.keys(files).length);
  assert.deepEqual(Object.keys(entries).sort(),Object.keys(files).sort());
  for(const [name,value]of Object.entries(files))assert.deepEqual(Buffer.from(entries[name]),Buffer.from(value));
  assert.equal(JSON.parse(Buffer.from(entries['manifest.json']).toString()).version,'0.1.9');
  assert.equal(await readFile(result.checksumPath,'utf8'),`${digest(bytes)}  ${result.filename}\n`);
  const notes=await readFile(result.notesPath,'utf8');
  assert.ok(notes.includes(result.filename)&&notes.includes('当前版本公开说明'));
  assert.ok(!notes.includes('历史内部调试记录'));
  assert.equal(entries['release-notes.md'],undefined,'release notes are not an extension installation file');
});

test('archive output is reproducible despite source timestamps and process timezone',async t=>{
  const {root}=await fixture(t),first=await buildPackage({root});
  await utimes(path.join(root,'extension','manifest.json'),new Date(),new Date());
  const moduleUrl=new URL('../scripts/package.mjs',import.meta.url).href;
  for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
    const source=`import {buildPackage} from ${JSON.stringify(moduleUrl)};console.log((await buildPackage({root:${JSON.stringify(root)}})).sha256);`;
    const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{env:{...process.env,TZ:zone},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),first.sha256);
  }
});

test('packaging rejects version drift and a tag that names another release',async t=>{
  const {root}=await fixture(t);
  await assert.rejects(buildPackage({root,tag:'v0.1.8'}),/Release tag/);
  await writeFile(path.join(root,'package.json'),JSON.stringify({name:'weixin2bilibili',version:'0.1.8'}));
  await assert.rejects(buildPackage({root}),/versions must match/);
});

test('packaging refuses hidden files, unsupported files and directory links inside the extension',async t=>{
  const {root}=await fixture(t),extension=path.join(root,'extension');
  for(const name of ['.env','unexpected.zip']){
    await writeFile(path.join(extension,name),'private or accidental file');
    await assert.rejects(buildPackage({root}),/Unexpected extension path|Unsupported extension file/);
    await rm(path.join(extension,name));
  }
  const target=path.join(root,'outside-extension');await mkdir(target);
  await writeFile(path.join(target,'private.txt'),'do not follow');
  await symlink(target,path.join(extension,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(buildPackage({root}),/symbolic link/);
});

test('archive verification detects missing, added and changed files before distribution',()=>{
  const files={'manifest.json':Buffer.from('{"version":"0.1.9"}'),'main.js':Buffer.from('original')};
  assert.throws(()=>verifyArchive(zipSync({'main.js':files['main.js']}),files,'0.1.9'),/file list/);
  assert.throws(()=>verifyArchive(zipSync({...files,'private.txt':Buffer.from('extra')}),files,'0.1.9'),/file list/);
  assert.throws(()=>verifyArchive(zipSync({...files,'main.js':Buffer.from('changed')}),files,'0.1.9'),/content differs/);
  assert.throws(()=>verifyArchive(zipSync(files),files,'0.2.0'),/manifest/);
});

test('release notes require one nonempty matching changelog section and exclude adjacent versions',()=>{
  const text='# Changelog\r\n\r\n## 1.0.0\r\nFuture\r\n\r\n## 0.1.9\r\n\r\nPublic change\r\n### Details\r\nUseful detail\r\n\r\n## 0.1.8\r\nOld debugging\r\n';
  const result=createReleaseNotes(text,'0.1.9','weixin2bilibili-v0.1.9.zip');
  assert.ok(result.includes('Public change')&&result.includes('Useful detail'));
  assert.ok(!result.includes('Future')&&!result.includes('Old debugging')&&!result.includes('\r'));
  for(const invalid of ['## 0.1.8\nOld','## 0.1.9\n\n## 0.1.8\nOld','## 0.1.9\nFirst\n## 0.1.9\nSecond'])assert.throws(()=>createReleaseNotes(invalid,'0.1.9','release.zip'),/CHANGELOG/);
});
