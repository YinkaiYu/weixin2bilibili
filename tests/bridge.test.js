import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeClient,bridgeFetch,blobToBase64,base64ToBytes} from '../extension/lib/bridge.js';
import {createBackgroundHandler,isTrustedNativeSender} from '../extension/lib/background-handlers.js';

const extensionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sender={id:extensionId,frameId:0,url:'https://member.bilibili.com/york/read-editor?aid=12',tab:{id:1,url:'https://member.bilibili.com/york/read-editor?aid=12'}};
const gif=Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'));
const gifBlob=()=>new Blob([gif],{type:'image/gif'});
const imageUrl='https://i0.hdslb.com/bfs/new_dyn/image.gif';
const content={paragraphs:[{para_type:1,text:{nodes:[{node_type:1,word:{words:'原文'}}]}}]};

function fixture({saveImpl,getDraftImpl,fetchImpl}={}){
  const records={};const calls=[],reads=[],drafts=new Map();
  const storage={get:async key=>({[key]:records[key]}),set:async values=>Object.assign(records,structuredClone(values))};
  const client={
    getLoginInfo:async()=>({isAuthenticated:true,userId:'1001',username:'测试用户'}),
    listCollections:async()=>[{id:42,name:'正经玩'}],
    validateSourceLinks:async urls=>{calls.push({method:'validateSourceLinks',urls});return {accepted:urls,rejected:[],failed:[]};},
    uploadImage:async(blob,options)=>{calls.push({method:'uploadImage',blob,options});return {url:imageUrl,width:1,height:1,size:.1,animationVerified:true};},
    getDraft:async draftId=>{reads.push(draftId);return getDraftImpl?getDraftImpl(draftId):structuredClone(drafts.get(draftId));},
    saveDraft:async options=>{
      calls.push({method:'saveDraft',options});
      if(saveImpl)return saveImpl(options,{records});
      const draftId=String(options.draftId||123);const draftUrl=`https://member.bilibili.com/york/read-editor?aid=${draftId}`;
      drafts.set(draftId,{title:options.title,original:options.original===false?0:1,list_id:options.collectionId||0,image_urls:options.coverUrl?[options.coverUrl]:[],opus:{content:options.content}});
      await options.onSaved({draftId,draftUrl});
      assert.equal(records['draftCheckpoint:1001:article-1'].draftId,draftId);
      return {draftId,draftUrl,verified:true,verification:{ok:true,issues:[]}};
    },
  };
  const handler=createBackgroundHandler({client,fetchImpl:fetchImpl||(async()=>new Response(gif,{headers:{'Content-Type':'image/gif'}})),storage,extensionId});
  const sendMessage=message=>handler(message,sender);
  return {records,calls,reads,storage,handler,sendMessage,bridge:createBridgeClient({sendMessage,jobKey:'article-1'})};
}

test('trusts only this extension top-frame native editor sender',()=>{
  assert.equal(isTrustedNativeSender(sender,extensionId),true);
  for(const path of ['/platform/upload/text/new-edit','/platform/upload/text/edit?aid=12']){
    const url='https://member.bilibili.com'+path;
    assert.equal(isTrustedNativeSender({...sender,url,tab:{...sender.tab,url}},extensionId),true);
  }
  for(const bad of [
    {...sender,id:'other-extension'},
    {...sender,frameId:1},
    {...sender,tab:undefined},
    {...sender,url:'https://member.bilibili.com.evil.test/york/read-editor'},
    {...sender,url:'https://member.bilibili.com/platform/home'},
    {...sender,url:'https://member.bilibili.com/platform/upload/text'},
    {...sender,url:'https://member.bilibili.com/platform/upload/text/new-edit/other'},
    {...sender,url:'https://member.bilibili.com/york/read-editor-extra'},
    {...sender,url:'https://u:p@member.bilibili.com/york/read-editor'},
    {...sender,tab:{...sender.tab,url:'https://mp.weixin.qq.com/s/article'}},
  ])assert.equal(isTrustedNativeSender(bad,extensionId),false);
});

test('wrapper editor can call named methods while nested editor frames remain denied',async()=>{
  const app=fixture();const url='https://member.bilibili.com/platform/upload/text/new-edit';
  const top={...sender,url,tab:{...sender.tab,url}};
  const ok=await app.handler({type:'BILI_API',method:'listCollections'},top);
  assert.equal(ok.ok,true);assert.equal(ok.data[0].name,'正经玩');
  const nested=await app.handler({type:'BILI_API',method:'listCollections'},{...top,url:sender.url,frameId:1});
  assert.equal(nested.ok,false);
});

test('exposes only named methods and does not turn into a generic API proxy',async()=>{
  const app=fixture();
  assert.equal((await app.bridge.getLoginInfo()).userId,'1001');
  assert.equal((await app.bridge.listCollections())[0].name,'正经玩');
  for(const message of [{type:'BILI_API',method:'publish'},{type:'FETCH',url:'https://api.bilibili.com/x/dynamic/feed/create/opus'},{type:'BILI_API',method:'__proto__'}]){
    const reply=await app.handler(message,sender);assert.equal(reply.ok,false);
  }
  const denied=await app.handler({type:'BILI_API',method:'getLoginInfo'},{...sender,id:'other'});
  assert.equal(denied.ok,false);assert.equal(app.calls.length,0);
});

test('upload bridge preserves GIF bytes, MIME and filename without transferring cookies',async()=>{
  const app=fixture();const result=await app.bridge.uploadImage(gifBlob(),{filename:'动画.gif'});
  assert.equal(result.animationVerified,true);
  assert.deepEqual(new Uint8Array(await app.calls[0].blob.arrayBuffer()),gif);
  assert.equal(app.calls[0].blob.type,'image/gif');assert.equal(app.calls[0].options.filename,'动画.gif');
  assert.equal('cookies' in result,false);assert.equal('csrf' in result,false);
});

test('download bridge returns a Response and background uses credential-free known image hosts',async()=>{
  const network=[];
  const app=fixture({fetchImpl:async(url,options)=>{network.push({url,options});return new Response(gif,{headers:{'Content-Type':'image/gif'}});}});
  const response=await bridgeFetch('https://res.wx.qq.com/emoji.gif',{sendMessage:app.sendMessage});
  assert.equal(response.ok,true);assert.equal(response.url,'https://res.wx.qq.com/emoji.gif');
  assert.equal(response.headers.get('Content-Type'),'image/gif');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),gif);
  assert.equal(network[0].options.credentials,'omit');
  assert.equal(network[0].options.referrerPolicy,'no-referrer');
  await assert.rejects(bridgeFetch('https://evil.test/image.gif',{sendMessage:app.sendMessage}),/允许/);
  await assert.rejects(bridgeFetch(imageUrl,{method:'POST',sendMessage:app.sendMessage}),/仅支持读取/);
  assert.equal(network.length,1);
});

test('background rejects a redirect to an unapproved host even if source is allowed',async()=>{
  const response=new Response(gif);Object.defineProperty(response,'url',{value:'https://evil.test/image.gif'});
  const app=fixture({fetchImpl:async()=>response});
  const reply=await app.handler({type:'DOWNLOAD_IMAGE',url:'https://mmbiz.qpic.cn/a.gif'},sender);
  assert.equal(reply.ok,false);assert.match(reply.error.message,/跳转/);
});

test('save checkpoint survives page recreation and retries only read the account-owned draft',async()=>{
  const app=fixture();let callbackCount=0;
  const result=await app.bridge.saveDraft({title:'测试',content,onSaved:async()=>callbackCount++});
  assert.equal(result.draftId,'123');assert.equal(callbackCount,1);
  assert.equal(app.records['draftCheckpoint:1001:article-1'].draftId,'123');
  const recreated=createBridgeClient({sendMessage:app.sendMessage,jobKey:'article-1'});
  const recovered=await recreated.saveDraft({title:'修订',content});
  assert.equal(app.calls.length,1,'retry must never update a draft the user may have edited');
  assert.deepEqual(app.reads,['123']);
  assert.equal(recovered.recovered,true);assert.equal(recovered.verified,false);
  assert.equal(recovered.draft.title,'测试');
  assert.match(recovered.verification.issues.join(' '),/未覆盖/);
  assert.equal(app.records['draftCheckpoint:1001:article-1'].title,'测试');
});

test('a recovered draft remains available when readback fails, without posting an update',async()=>{
  const app=fixture({getDraftImpl:async()=>{throw new Error('暂时无法连接');}});
  const first=await app.bridge.saveDraft({title:'测试',content});
  const recovered=await app.bridge.saveDraft({title:'测试',content});
  assert.equal(app.calls.length,1);assert.deepEqual(app.reads,['123']);
  assert.equal(recovered.draftId,first.draftId);assert.equal(recovered.draftUrl,first.draftUrl);
  assert.equal(recovered.recovered,true);assert.equal(recovered.verified,false);
  assert.match(recovered.verification.issues.join(' '),/暂时无法连接/);
});

test('functions and caller-controlled endpoint properties never cross the save bridge',async()=>{
  let transmitted;const app=fixture();
  const bridge=createBridgeClient({jobKey:'article-1',sendMessage:message=>{transmitted=structuredClone(message);return app.sendMessage(message);}});
  await bridge.saveDraft({title:'测试',content:{paragraphs:[]},endpoint:'https://evil.test',onSaved:()=>{}});
  assert.equal(transmitted.payload.onSaved,undefined);
  assert.equal(app.calls[0].options.endpoint,undefined);
});

test('confirmed source-link allowlist survives the bridge and recovery without reaching unrelated fields',async()=>{
  const app=fixture(),sourceLinks=['https://example.org/paper'];
  const linked={paragraphs:[{para_type:1,text:{nodes:[{node_type:4,link:{show_text:'原文',link:sourceLinks[0],link_type:16}}]}}]};
  const result=await app.bridge.saveDraft({title:'原文链接',content:linked,sourceLinks,externalEndpoint:'https://example.org/'});
  assert.equal(result.verified,true);
  assert.deepEqual(app.calls[0].options.sourceLinks,sourceLinks);
  assert.equal(app.calls[0].options.externalEndpoint,undefined);
  const recovered=await app.bridge.saveDraft({title:'原文链接',content:linked,sourceLinks});
  assert.equal(recovered.verified,true);assert.equal(recovered.recovered,true);
  assert.equal(app.calls.length,1,'recovery only reads and checks the existing link');
});

test('source link validation crosses the trusted bridge only as the named operation',async()=>{
  const app=fixture(),urls=['https://example.org/paper'];
  assert.deepEqual(await app.bridge.validateSourceLinks(urls),{accepted:urls,rejected:[],failed:[]});
  assert.deepEqual(app.calls,[{method:'validateSourceLinks',urls}]);
  const denied=await app.handler({type:'BILI_API',method:'validateSourceLinks',payload:{urls}},{...sender,id:'other-extension'});
  assert.equal(denied.ok,false);assert.equal(app.calls.length,1);
});

test('unknown create result blocks blind retries but permits continuing from a found draft ID',async()=>{
  let attempts=0;
  const app=fixture({
    saveImpl:async()=>{attempts++;const error=new Error('save outcome uncertain');error.saveUncertain=true;throw error;},
    getDraftImpl:async()=>({title:'测试',original:1,list_id:0,image_urls:[],opus:{content}}),
  });
  await assert.rejects(app.bridge.saveDraft({title:'测试'}),error=>error.saveUncertain===true);
  await assert.rejects(app.bridge.saveDraft({title:'测试'}),/避免重复/);
  assert.equal(attempts,1);
  const recovered=await app.bridge.saveDraft({title:'测试',content,draftId:123});
  assert.equal(recovered.draftId,'123');assert.equal(recovered.recovered,true);assert.equal(recovered.verified,true);
  assert.equal(attempts,1);assert.deepEqual(app.reads,['123']);
  assert.equal(app.records['draftCheckpoint:1001:article-1'].saveUncertain,false);
});

test('concurrent requests for the same article cannot create two drafts',async()=>{
  let release,entered;
  const started=new Promise(resolve=>entered=resolve);
  const app=fixture({saveImpl:async options=>{
    entered();await new Promise(resolve=>release=resolve);
    await options.onSaved({draftId:'123',draftUrl:'https://member.bilibili.com/york/read-editor?aid=123'});
    return {draftId:'123',verified:true,verification:{ok:true,issues:[]}};
  }});
  const first=app.bridge.saveDraft({title:'测试'});await started;
  await assert.rejects(app.bridge.saveDraft({title:'测试'}),/正在保存/);
  release();await first;assert.equal(app.calls.length,1);
});

test('base64 transport rejects malformed payloads and recovers exact bytes',async()=>{
  assert.deepEqual(base64ToBytes(await blobToBase64(gifBlob())),gif);
  for(const invalid of ['bad!','a','AAAA===A',''])assert.throws(()=>base64ToBytes(invalid));
});

for(const size of [1024*1024,8*1024*1024]){
  test(`base64 transport preserves every byte of a realistic ${size/(1024*1024)} MB image payload`,async()=>{
    const bytes=new Uint8Array(size);
    for(let i=0;i<size;i++)bytes[i]=(i*131+(i>>>8)+(i>>>16))&255;
    const encoded=await blobToBase64(new Blob([bytes],{type:'image/png'}));
    assert.equal(encoded.length,4*Math.ceil(size/3));
    const restored=base64ToBytes(encoded);
    assert.equal(restored.byteLength,size);
    assert.equal(Buffer.from(restored).equals(Buffer.from(bytes)),true);
    // A bad byte at the end must be rejected too, without regex recursion.
    assert.throws(()=>base64ToBytes(encoded.slice(0,-1)+'!'),/无效/);
  });
}

test('a visible-page callback failure does not hide a draft already saved by background',async()=>{
  const app=fixture();
  const result=await app.bridge.saveDraft({title:'测试',onSaved:()=>{throw new Error('page closed');}});
  assert.equal(result.draftId,'123');assert.equal(result.verified,false);
  assert.match(result.verification.issues[0],/草稿已保存/);
});
