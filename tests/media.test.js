import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {allowedImageUrl,biliImageUrl,sniffImage,inspectBlob,downloadImage,verifyAnimation,migrateImages} from '../extension/lib/media.js';

globalThis.DOMParser=new JSDOM('').window.DOMParser;
const gif=Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'));
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6kAAAAASUVORK5CYII=','base64'));
const sourceUrl='https://mmbiz.qpic.cn/example/image.gif';
const biliUrl='https://i0.hdslb.com/bfs/new_dyn/image.gif';
function animatedGif(delay=2){
  const control=[0x21,0xf9,4,0,delay,0,0,0];
  return new Uint8Array([...gif.slice(0,19),...control,...gif.slice(19,-1),...control,...gif.slice(19,-1),0x3b]);
}
const blob=bytes=>new Blob([bytes],{type:'image/gif'});
const asset=()=>({url:biliUrl,width:1,height:1,size:.1});

test('only allows known image hosts, data bitmap images, and the exact WeChat emoji host',()=>{
  for(const url of ['https://mmbiz.qpic.cn/a/0?wx_fmt=gif','http://mmbiz.qpic.cn/a','https://res.wx.qq.com/mpres/emoji.png','data:image/gif;base64,R0lGODlh','https://i0.hdslb.com/bfs/new_dyn/a.png'])assert.equal(allowedImageUrl(url),true,url);
  for(const url of ['https://qpic.cn.evil.test/a','https://res.wx.qq.com.evil.test/a','https://other.wx.qq.com/a','https://u:p@mmbiz.qpic.cn/a','https://mmbiz.qpic.cn:9876/a','https://evil.test/?qpic.cn','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=','file:///secret','blob:https://example.com/a'])assert.equal(allowedImageUrl(url),false,url);
  assert.equal(biliImageUrl('https://i0.hdslb.com/not-bfs/a.png'),false);
  assert.equal(biliImageUrl('https://u:p@i0.hdslb.com/bfs/a.png'),false);
  assert.equal(biliImageUrl('https://i0.hdslb.com/bfs/new_dyn/a.png'),true);
});

test('sniffs bytes rather than MIME or extension and reports real GIF frames and timing',()=>{
  assert.equal(sniffImage(gif).mime,'image/gif');
  assert.equal(sniffImage(gif).frames,1);
  assert.equal(sniffImage(png).mime,'image/png');
  assert.equal(sniffImage(png).width,1);
  const info=sniffImage(animatedGif(5));
  assert.equal(info.frames,2);assert.equal(info.animated,true);
  assert.deepEqual(info.delays,[50,50]);assert.equal(info.durationMs,100);
  assert.throws(()=>sniffImage(new TextEncoder().encode('<html>Access denied</html>')),/错误网页/);
});

test('rejects truncated GIF and PNG before an upload can start',()=>{
  assert.throws(()=>sniffImage(gif.slice(0,-1)),/完整/);
  assert.throws(()=>sniffImage(animatedGif().slice(0,-5)),/完整/);
  assert.throws(()=>sniffImage(png.slice(0,-5)),/完整/);
});

test('normalizes mislabeled GIF MIME without changing any bytes',async()=>{
  const bytes=animatedGif();const info=await inspectBlob(new Blob([bytes],{type:'image/jpeg'}));
  assert.equal(info.mime,'image/gif');assert.equal(info.blob.type,'image/gif');
  assert.deepEqual(new Uint8Array(await info.blob.arrayBuffer()),bytes);
  assert.equal(info.hash.length,64);
});

test('fetches original images without account credentials and rejects external redirect destinations',async()=>{
  const calls=[];
  const info=await downloadImage(sourceUrl,{fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(gif);}});
  assert.equal(info.frames,1);assert.equal(calls[0].init.credentials,'omit');assert.equal(calls[0].init.referrerPolicy,'no-referrer');
  const response=new Response(gif);Object.defineProperty(response,'url',{value:'https://evil.test/image.gif'});
  await assert.rejects(downloadImage(sourceUrl,{fetchImpl:async()=>response}),/跳转/);
  await assert.rejects(downloadImage('https://evil.test/a.png',{fetchImpl:async()=>assert.fail('must not fetch')}),/不可读取/);
});

test('stale local basename cannot silently replace a remote image',async()=>{
  let fetched=false;
  const localFiles=new Map([['image.gif',blob(animatedGif())]]);
  const info=await downloadImage(sourceUrl,{localFiles,fetchImpl:async()=>{fetched=true;return new Response(gif);}});
  assert.equal(fetched,true);assert.equal(info.frames,1);
});

test('explicit saved-page mapping and localasset reference can resolve basename offline',async()=>{
  const localFiles=new Map([['image.gif',blob(animatedGif())]]);
  const fetchImpl=async()=>assert.fail('mapped local images need no network');
  const info=await downloadImage(sourceUrl,{localFiles,savedPaths:new Map([[sourceUrl,'article_files/image.gif']]),fetchImpl});
  assert.equal(info.frames,2);
  assert.equal((await downloadImage('localasset:///article_files/image.gif',{localFiles,fetchImpl})).frames,2);
});

test('GIF label cannot be silently converted to a static bitmap',async()=>{
  await assert.rejects(downloadImage('https://mmbiz.qpic.cn/a/0?wx_fmt=gif',{fetchImpl:async()=>new Response(png)}),/静态图片/);
});

test('verifies animation timing as well as frame count, including cached assets',async()=>{
  const info=sniffImage(animatedGif(3));
  await verifyAnimation(biliUrl,info,{fetchImpl:async()=>new Response(animatedGif(3))});
  await assert.rejects(verifyAnimation(biliUrl,info,{fetchImpl:async()=>new Response(gif)}),/帧数/);
  await assert.rejects(verifyAnimation(biliUrl,info,{fetchImpl:async()=>new Response(animatedGif(9))}),/时序/);
  await assert.rejects(verifyAnimation(biliUrl,info,{fetchImpl:async()=>new Response(animatedGif(3).slice(0,-1))}),/完整/);
  await assert.rejects(verifyAnimation('https://evil.test/a.gif',info,{fetchImpl:async()=>assert.fail('must not fetch')}),/B站图片地址/);
});

test('migration deduplicates body and cover, removes old image attributes, and preserves order',async()=>{
  let uploads=0;const progress=[];const cache={};
  const html=`<p>正文</p><img src="${sourceUrl}" data-src="https://old.test/image.gif" srcset="https://old.test/a.gif 2x"><p>图注</p><img src="${sourceUrl}">`;
  const result=await migrateImages(html,{coverUrl:sourceUrl,cache,cacheKey:'account',fetchImpl:async()=>new Response(gif),client:{uploadImage:async()=>{uploads++;return asset();}},onProgress:value=>progress.push(value)});
  assert.equal(uploads,1);assert.equal(result.coverUrl,biliUrl);assert.equal(result.images.size,1);
  const doc=new DOMParser().parseFromString(result.html,'text/html');
  assert.deepEqual([...doc.querySelectorAll('img')].map(img=>img.src),[biliUrl,biliUrl]);
  assert.equal(doc.querySelectorAll('[data-src],[srcset]').length,0);
  assert.deepEqual([...doc.body.children].map(node=>node.tagName),['P','IMG','P','IMG']);
  assert.equal(progress.at(-1).state,'done');
  assert.equal(Object.keys(cache).length,1);
});

test('a failed image blocks the whole migration instead of deleting it',async()=>{
  let uploads=0;const progress=[];
  await assert.rejects(migrateImages(`<img src="${sourceUrl}"><img src="https://mmbiz.qpic.cn/broken.gif">`,{
    fetchImpl:async url=>new Response(url.includes('broken')?'error page':gif),client:{uploadImage:async()=>{uploads++;return asset();}},onProgress:value=>progress.push(value)
  }),/第 2 张图片处理失败/);
  assert.equal(uploads,1);assert.equal(progress.at(-1).state,'error');
});

test('cached animation gets checked again and changed timing blocks reuse',async()=>{
  const original=await inspectBlob(blob(animatedGif(2)));
  const cache={['account:'+original.hash]:{...asset(),animationVerified:true}};
  await assert.rejects(migrateImages(`<img src="${sourceUrl}">`,{cache,cacheKey:'account',
    fetchImpl:async url=>new Response(url===sourceUrl?animatedGif(2):animatedGif(3)),
    client:{uploadImage:async()=>assert.fail('valid cache should not upload again')}
  }),/时序/);
});

test('upload response outside B站 CDN is never inserted into the document',async()=>{
  await assert.rejects(migrateImages(`<img src="${sourceUrl}">`,{fetchImpl:async()=>new Response(gif),client:{uploadImage:async()=>({...asset(),url:'https://evil.test/hdslb.com/a.gif'})}}),/非站内/);
});
