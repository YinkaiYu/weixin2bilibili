import test from 'node:test';
import assert from 'node:assert/strict';
import {indexLocalFiles,normalizeURI,resolveLocalFile} from '../extension/lib/local-files.js';
import {downloadImage} from '../extension/lib/media.js';

const file = (name,relative) => ({name,webkitRelativePath:relative});

test('duplicate saved resource names never overwrite one another',()=>{
  const first=file('640','测试文章/甲_files/640');
  const second=file('640','测试文章/乙_files/640');
  const index=indexLocalFiles([first,second]);
  assert.equal(index.has('640'),false);
  assert.equal(resolveLocalFile('甲_files/640',index),first);
  assert.equal(resolveLocalFile('乙_files/640',index),second);
  assert.equal(resolveLocalFile('640',index),undefined);
  assert.equal(resolveLocalFile('unknown_files/640',index),undefined);
});

test('ambiguous path suffixes fail instead of choosing the last file',()=>{
  const a=file('640','甲/文章_files/640'),b=file('640','乙/文章_files/640');
  const index=indexLocalFiles([a,b]);
  assert.equal(resolveLocalFile('文章_files/640',index),undefined);
  assert.equal(resolveLocalFile('甲/文章_files/640',index),a);
});

test('a known wrong resource folder cannot match even a unique basename',()=>{
  const asset=file('640','wrong_files/640');
  assert.equal(resolveLocalFile('expected_files/640',indexLocalFiles([asset])),undefined);
  const loose=file('640','');
  assert.equal(resolveLocalFile('expected_files/640',indexLocalFiles([loose])),loose);
});

test('supports exact resource paths, encoded Unicode and localasset placeholders',()=>{
  const asset=file('图 片.png','文章_files/图 片.png');
  const index=indexLocalFiles([asset]);
  assert.equal(resolveLocalFile('./文章_files/图%20片.png#imgIndex=2',index),asset);
  assert.equal(resolveLocalFile('localasset:///'+encodeURIComponent('文章_files/图 片.png'),index),asset);
  assert.equal(resolveLocalFile('图%20片.png',index),asset);
});

test('rejects absolute paths, schemes and encoded path traversal',()=>{
  for(const value of ['https://example.com/640','file:///C:/secret','C:\\secret','../secret','%2e%2e/secret','localasset:///'+encodeURIComponent('../secret'),'//host/file','a/%00name']) assert.equal(normalizeURI(value),'',value);
});

test('a remotely named image is never replaced by a coincidental local basename',async()=>{
  let fetched='';
  const index=indexLocalFiles([file('640','wrong_files/640')]);
  await assert.rejects(downloadImage('https://mmbiz.qpic.cn/640',{localFiles:index,fetchImpl:async url=>{fetched=url;return {ok:false,status:404};}}),/下载图片失败/);
  assert.equal(fetched,'https://mmbiz.qpic.cn/640');
});

test('ambiguous explicit saved paths do not cause wrong bytes to be uploaded',async()=>{
  const url='https://mmbiz.qpic.cn/original';
  const index=indexLocalFiles([file('640','甲_files/640'),file('640','乙_files/640')]);
  let fetched=0;
  await assert.rejects(downloadImage(url,{localFiles:index,savedPaths:new Map([[url,'unknown_files/640']]),fetchImpl:async()=>{fetched++;return {ok:false,status:404};}}),/下载图片失败/);
  assert.equal(fetched,1);
});
