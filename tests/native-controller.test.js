import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {runImport,resetPendingImport} from '../extension/lib/native-controller.js';
import {createBackgroundHandler} from '../extension/lib/background-handlers.js';
import {createBilibiliClient} from '../extension/lib/bilibili.js';

const sourceUrl='https://mp.weixin.qq.com/s/native-import-test';
const originalImage='https://mmbiz.qpic.cn/example/cover.png';
const uploadedImage='https://i0.hdslb.com/bfs/new_dyn/transferred.png';
// Complete 1px PNG; byte parsing and upload are real, actual raster decoding is not required.
const validPng=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6kAAAAASUVORK5CYII=','base64'));
const articleHtml=({extraImage='',title='原生导入测试',collectionName='正经玩'}={})=>`<!doctype html><html><head><script>var msg_cdn_url="${originalImage}";${collectionName===null?'':`var album_name=${JSON.stringify(collectionName)};`}</script></head><body><h1 id="activity-name">${title}</h1><div id="js_content"><p><strong>加粗文字</strong><span style="color:#e00000">彩色文字</span> H<sub>2</sub>O</p><p><img data-src="${originalImage}" src="${originalImage}"></p>${extraImage?`<p><img src="${extraImage}"></p>`:''}<h2>往期回顾</h2><p>不应同步这段内容</p></div></body></html>`;

function setup({collections=[{id:42,name:'正经玩',total:1},{id:84,name:'其他栏目',total:2}],sourceHtml=articleHtml(),media=[]}={}){
  const previous={chrome:globalThis.chrome,document:globalThis.document,DOMParser:globalThis.DOMParser,createImageBitmap:globalThis.createImageBitmap};
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://member.bilibili.com/york/read-editor'});
  globalThis.document=dom.window.document;globalThis.DOMParser=dom.window.DOMParser;
  globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
  const state={},messages=[],apiCalls=[],uploads=[],savedPayloads=[],drafts=new Map();
  const switches={failReadback:false,failUpload:false,sourceLinkState:'accepted'};let nextId=4000;
  const storage={
    get:async key=>({[key]:state[key]===undefined?undefined:structuredClone(state[key])}),
    set:async values=>Object.assign(state,structuredClone(values)),
    remove:async key=>{delete state[key];},
  };
  const json=data=>new Response(JSON.stringify({code:0,data}),{headers:{'Content-Type':'application/json'}});
  const fetchImpl=async(url,init={})=>{
    apiCalls.push({url,init});
    const sourceMedia=media.find(item=>item.sourceUrl===url);
    if(sourceMedia)return new Response(sourceMedia.bytes,{headers:{'Content-Type':'image/png'}});
    if(url===originalImage)return new Response(validPng,{headers:{'Content-Type':'image/png'}});
    if(url==='https://mmbiz.qpic.cn/example/broken.png')return new Response('not found',{status:404});
    if(url.endsWith('/x/web-interface/nav'))return json({isLogin:true,mid:8080,uname:'测试账号',face:''});
    if(url.endsWith('/x/article/creative/list/all'))return json({lists:collections});
    if(url.includes('/x/v2/dynamic/sunflower/parse?')){
      if(switches.sourceLinkState==='failed')return new Response('unavailable',{status:503});
      const {raw_texts:urls}=JSON.parse(init.body);
      return json({parsed_items:Object.fromEntries(urls.map(source=>[source,switches.sourceLinkState==='accepted'?{type:1,link_type:16}:{type:0,link_type:0,unknown:{reason_text:''}}]))});
    }
    if(url.endsWith('/x/dynamic/feed/draw/upload_bfs')){
      if(switches.failUpload)return new Response(JSON.stringify({code:-400,message:'模拟图片上传失败'}));
      const file=init.body.get('file_up');uploads.push(new Uint8Array(await file.arrayBuffer()));
      if(media.length){
        const uploadedMedia=media.find(item=>Buffer.from(item.bytes).equals(Buffer.from(uploads.at(-1))));
        assert.ok(uploadedMedia,'upload must contain one of the independent source PNGs');
        return json(uploadedMedia.response);
      }
      return json({image_url:uploadedImage,image_width:1,image_height:1,image_size:validPng.length/1024});
    }
    if(url.includes('/x/dynamic/feed/article/draft/add?')){
      const payload=JSON.parse(init.body);savedPayloads.push(payload);
      const id=payload.arg.article_id||++nextId;
      drafts.set(id,{...structuredClone(payload.arg),article_id:id,list:{id:payload.arg.list_id}});
      return json({article_id:id});
    }
    if(url.includes('/x/dynamic/feed/article/draft/view?')){
      if(switches.failReadback)return new Response('temporarily unavailable',{status:503});
      return json({draft:drafts.get(Number(new URL(url).searchParams.get('article_id')))});
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  };
  const extensionId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const sender={id:extensionId,frameId:0,url:dom.window.location.href,tab:{id:10,url:dom.window.location.href}};
  const nativeClient=createBilibiliClient({fetchImpl,getCookie:async()=> 'test-csrf'});
  const handler=createBackgroundHandler({client:nativeClient,fetchImpl,storage,extensionId});
  globalThis.chrome={storage:{local:storage},runtime:{id:extensionId,sendMessage:async message=>{
    messages.push(structuredClone(message));
    if(message.type==='LOAD_ARTICLE')return {ok:true,data:{html:sourceHtml}};
    return handler(message,sender);
  }}};
  const pending=()=>Object.entries(state).filter(([key])=>key.startsWith('pendingJob:'));
  return {state,messages,apiCalls,uploads,savedPayloads,drafts,switches,pending,close(){dom.window.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}};
}

test('native import uses real parsing/conversion, uploads PNG once for body and cover, and sets collection/original',async()=>{
  const app=setup();try{
    const progress=[];const result=await runImport({sourceUrl},value=>progress.push(value));
    assert.equal(result.verified,true);assert.equal(result.title,'原生导入测试');
    assert.deepEqual(result.cover,{url:uploadedImage,filename:'原生导入测试-封面.png'});
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.warnings,[]);
    assert.ok(result.info.some(message=>message.includes('上下标已转换')));
    assert.ok(result.notices.every(item=>item.severity==='info'));
    assert.match(result.draftUrl,/york\/read-editor\?aid=4001$/);
    assert.equal(app.uploads.length,1,'body image and identical cover must share upload');
    assert.deepEqual(app.uploads[0],validPng,'image bytes must not be re-encoded');
    const arg=app.savedPayloads[0].arg;
    assert.equal(arg.original,1);assert.equal(arg.list_id,42);assert.deepEqual(arg.image_urls,[uploadedImage]);
    const nodes=arg.opus.content.paragraphs.flatMap(p=>p.text?.nodes||[]);
    assert.ok(nodes.some(n=>n.word?.style?.bold));assert.ok(nodes.some(n=>n.word?.color==='#e00000'));
    assert.ok(nodes.some(n=>n.node_type===5&&n.formula.latex_content.includes('2')),'subscript uses native formula');
    assert.equal(arg.opus.content.paragraphs.filter(p=>p.para_type===2).length,1);
    assert.ok(!JSON.stringify(arg).includes('不应同步这段内容'));
    assert.ok(progress.length>2&&progress.every(p=>typeof p==='string'));
    assert.equal(app.pending().length,0,'completed job is cleared');
  }finally{app.close();}
});

test('saved pictures use actual upload metadata in source order, including repeats, without preflight placeholders',async()=>{
  // Two complete PNGs with different pixels and dimensions. Expected metadata
  // comes from the simulated upload responses, never from the converted output.
  const secondSource='https://mmbiz.qpic.cn/example/second-image.png';
  const first={url:'https://i0.hdslb.com/bfs/new_dyn/uploaded-orange.png',width:13,height:7,size:12.75};
  const second={url:'https://i0.hdslb.com/bfs/new_dyn/uploaded-blue.png',width:7,height:11,size:23.125};
  const media=[
    {sourceUrl:originalImage,bytes:Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAAAFUlEQVR4nGP8WqHBQARgIkbRMFIHAMFqAaNlnEefAAAAAElFTkSuQmCC','base64')),response:{image_url:first.url,image_width:13,image_height:7,image_size:12.75}},
    {sourceUrl:secondSource,bytes:Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAcAAAALCAIAAAA88gD/AAAAFElEQVR4nGOUjLrEgAGYMIWGjSgAO14BW6FerdsAAAAASUVORK5CYII=','base64')),response:{image_url:second.url,image_width:7,image_height:11,image_size:23.125}},
  ];
  const sourceHtml=articleHtml({extraImage:secondSource})
    .replace(`<img src="${secondSource}">`,`<img src="${secondSource}" data-w="999" data-h="777">`)
    .replace('<h2>往期回顾</h2>',`<p><img src="${originalImage}"></p><h2>往期回顾</h2>`);
  const app=setup({sourceHtml,media});try{
    const result=await runImport({sourceUrl});
    assert.equal(result.verified,true);
    assert.equal(app.savedPayloads.length,1);
    const arg=app.savedPayloads[0].arg;
    const pictures=arg.opus.content.paragraphs.flatMap(paragraph=>paragraph.pic?.pics||[]);
    assert.deepEqual(pictures.map(({url,width,height,size})=>({url,width,height,size})),[first,second,first]);
    assert.deepEqual(arg.image_urls,[first.url],'cover also uses its actual uploaded URL');
    assert.deepEqual(app.uploads,media.map(item=>item.bytes),'repeated body image and cover reuse the same upload without re-encoding');
    assert.doesNotMatch(JSON.stringify(arg),/preflight-|mmbiz\.qpic\.cn/);
    assert.ok(pictures.every(picture=>picture.width!==640&&picture.height!==480&&picture.size!==1),'preflight defaults must never reach save');
  }finally{app.close();}
});

test('direct import carries a grey image caption through cleanup upload save and readback exactly once',async()=>{
  const caption='显微镜下的实验样品';
  const sourceHtml=articleHtml().replace('<h2>往期回顾</h2>',`<p style="color:#888;font-size:14px;text-align:center">${caption}</p><p>下一段正文保持可编辑。</p><h2>往期回顾</h2>`);
  const app=setup({sourceHtml});try{
    const result=await runImport({sourceUrl});
    assert.equal(result.verified,true);
    const content=app.savedPayloads[0].arg.opus.content;
    const pictures=content.paragraphs.flatMap(p=>p.pic?.pics||[]);
    assert.deepEqual(pictures.map(p=>({url:p.url,comment:p.comment})),[{url:uploadedImage,comment:caption}]);
    const text=content.paragraphs.flatMap(p=>p.text?.nodes||[]).map(n=>n.word?.words||'').join('');
    assert.ok(!text.includes(caption),'图注只保留在图片注释中');
    assert.ok(text.includes('下一段正文保持可编辑。'));
    assert.equal(app.uploads.length,1,'图注不能触发额外图片上传或局部截图');
  }finally{app.close();}
});

for(const state of ['accepted','rejected','failed'])test(`direct import source link ${state} validation preserves an editable citation and never fetches its destination`,async()=>{
  const citationUrl='https://example.org/original-paper?edition=2';
  const sourceHtml=articleHtml().replace('<h2>往期回顾</h2>',`<p>原文链接：<a href="${citationUrl}">Original paper</a></p><p><a href="https://example.org/unrelated">其他推广</a></p><h2>往期回顾</h2>`);
  const app=setup({sourceHtml});
  try{
    app.switches.sourceLinkState=state;
    const result=await runImport({sourceUrl});
    assert.equal(result.verified,true);
    const validationCalls=app.apiCalls.filter(call=>call.url.includes('/sunflower/parse'));
    assert.equal(validationCalls.length,1);assert.deepEqual(JSON.parse(validationCalls[0].init.body),{raw_texts:[citationUrl]});
    assert.ok(app.apiCalls.every(call=>!call.url.startsWith('https://example.org/')));
    const nodes=app.savedPayloads[0].arg.opus.content.paragraphs.flatMap(para=>para.text?.nodes||[]);
    const links=nodes.filter(node=>node.node_type===4);
    const body=nodes.map(node=>node.word?.words||node.link?.show_text||'').join('');
    assert.ok(body.includes('Original paper'));
    assert.ok(body.includes('其他推广'));
    assert.equal(links.length,state==='accepted'?1:0);
    if(state==='accepted')assert.equal(links[0].link.link,citationUrl);
    else {assert.ok(body.includes(citationUrl));assert.ok(result.warnings.some(message=>message.includes('原文链接')));}
    assert.equal(JSON.stringify(app.savedPayloads[0]).includes('sourceLinks'),false);
  }finally{app.close();}
});

const collectionCases=[
  {name:'half-width title suffix when source metadata is absent',title:'手机的清晰度 | 正经玩',collectionName:null,expectedId:42},
  {name:'full-width suffix with normalized spacing',title:'手机的清晰度｜ 正 经 玩 ',collectionName:null,expectedId:42},
  {name:'explicit source collection takes precedence over title',title:'手机的清晰度 | 正经玩',collectionName:'其他栏目',expectedId:84},
  {name:'unmatched explicit collection cannot fall back to title',title:'手机的清晰度 | 正经玩',collectionName:'源专栏未建立',expectedId:0,warning:'源专栏未建立'},
  {name:'ambiguous normalized collection names remain unselected',title:'手机的清晰度 | 正经玩',collectionName:null,collections:[{id:42,name:'正经玩'},{id:43,name:'正 经玩'}],expectedId:0,warning:'正经玩'},
  {name:'title suffix does not use substring matching',title:'手机的清晰度 | 其他正经玩',collectionName:null,expectedId:0,warning:'其他正经玩'},
  {name:'only the final title suffix is a candidate',title:'手机的清晰度 | 正经玩 | 未知栏目',collectionName:null,expectedId:0,warning:'未知栏目'},
  {name:'title without a suffix delimiter is not a collection hint',title:'正经玩',collectionName:null,expectedId:0},
  {name:'verified question-and-answer alias uses its unique native collection',title:'为什么只睡20分钟 | No. 537',collectionName:'问答',collections:[{id:19,name:'问答Q&A'}],expectedId:19},
  {name:'exact question-and-answer name takes precedence over its alias',collectionName:'问答',collections:[{id:18,name:'问答'},{id:19,name:'问答Q&A'}],expectedId:18},
  {name:'ambiguous normalized aliases remain unselected',collectionName:'问答',collections:[{id:19,name:'问答Q&A'},{id:20,name:'问答 Q&A'}],expectedId:0,warning:'问答'},
];
for(const fixture of collectionCases)test(`direct-link collection matching: ${fixture.name}`,async()=>{
  const app=setup({collections:fixture.collections,sourceHtml:articleHtml(fixture)});try{
    const result=await runImport({sourceUrl});
    assert.equal(result.verified,true);
    assert.equal(app.savedPayloads[0].arg.list_id,fixture.expectedId);
    const collectionWarnings=result.warnings.filter(w=>w.includes('文集'));
    if(fixture.warning){
      assert.equal(collectionWarnings.length,1);
      assert.ok(collectionWarnings[0].includes(fixture.warning));
      assert.match(collectionWarnings[0],/未找到唯一对应.*请在发布设置中选择/);
    }else assert.deepEqual(collectionWarnings,[]);
  }finally{app.close();}
});

test('each fully successful import creates a new job and draft while reusing uploaded image cache',async()=>{
  const app=setup();try{
    const first=await runImport({sourceUrl,html:articleHtml()});
    const second=await runImport({sourceUrl,html:articleHtml()});
    assert.notEqual(first.draftId,second.draftId);
    const jobs=app.messages.filter(m=>m.type==='BILI_API'&&m.method==='saveDraft').map(m=>m.jobKey);
    assert.equal(jobs.length,2);assert.notEqual(jobs[0],jobs[1]);
    assert.equal(app.savedPayloads[1].arg.article_id,undefined);
    assert.equal(app.uploads.length,1,'second independent import reuses verified upload metadata');
  }finally{app.close();}
});

test('readback interruption keeps the same job and confirms the saved ID with a read-only retry',async()=>{
  const app=setup();try{
    app.switches.failReadback=true;
    const first=await runImport({sourceUrl,html:articleHtml()});
    assert.equal(first.verified,false);assert.equal(app.pending().length,1);
    assert.ok(first.notices.some(item=>item.severity==='error'&&item.message.includes('核验未通过')));
    assert.ok(first.notices.some(item=>item.severity==='warning'&&item.message.includes('503')));
    assert.ok(first.info.some(message=>message.includes('上下标已转换')));
    const pendingJob=app.pending()[0][1].jobKey;
    app.switches.failReadback=false;
    const recovered=await runImport({sourceUrl,html:articleHtml()});
    assert.equal(recovered.verified,true);assert.equal(recovered.recovered,true);assert.equal(recovered.draftId,first.draftId);
    const jobs=app.messages.filter(m=>m.type==='BILI_API'&&m.method==='saveDraft').map(m=>m.jobKey);
    assert.deepEqual(jobs,[pendingJob,pendingJob]);
    assert.equal(app.savedPayloads.length,1,'readback retry cannot resubmit or create a draft');
    assert.equal(app.pending().length,0);
  }finally{app.close();}
});

test('recovery preserves user edits and only an explicit new job creates another draft',async()=>{
  const app=setup();try{
    app.switches.failReadback=true;
    const first=await runImport({sourceUrl,html:articleHtml()});
    const edited=app.drafts.get(Number(first.draftId));
    edited.title='用户修改的标题';
    edited.opus.content.paragraphs[0].text.nodes[0].word.words='用户修改的正文';
    edited.image_urls=['https://i0.hdslb.com/bfs/new_dyn/user-cover.png'];
    const preserved=structuredClone(edited);
    app.switches.failReadback=false;
    const recovered=await runImport({sourceUrl,html:articleHtml()});
    assert.equal(recovered.draftId,first.draftId);assert.equal(recovered.recovered,true);assert.equal(recovered.verified,false);
    assert.match(recovered.warnings.join(' '),/未覆盖/);
    assert.equal(app.savedPayloads.length,1);assert.equal(app.pending().length,1);
    assert.deepEqual(app.drafts.get(Number(first.draftId)),preserved);
    await resetPendingImport({sourceUrl,html:articleHtml()});
    const fresh=await runImport({sourceUrl,html:articleHtml()});
    assert.notEqual(fresh.draftId,first.draftId);assert.equal(fresh.verified,true);
    assert.equal(app.savedPayloads.length,2);assert.equal(app.savedPayloads[1].arg.article_id,undefined);
    assert.deepEqual(app.drafts.get(Number(first.draftId)),preserved,'new import leaves the edited draft intact');
    assert.equal(app.pending().length,0);
  }finally{app.close();}
});

test('interrupted image upload retains job and never saves a partial article',async()=>{
  const app=setup();try{
    app.switches.failUpload=true;
    await assert.rejects(runImport({sourceUrl,html:articleHtml()}),error=>{
      assert.match(error.message,/图片处理失败/);
      assert.equal(error.severity,'error');
      assert.ok(error.notices.some(item=>item.severity==='error'&&item.message.includes('图片处理失败')));
      assert.equal(error.imageDiagnostic.stage,'upload');
      assert.ok(error.cause);
      return true;
    });
    assert.equal(app.savedPayloads.length,0);assert.equal(app.pending().length,1);
    const job=app.pending()[0][1].jobKey;
    app.switches.failUpload=false;
    const result=await runImport({sourceUrl,html:articleHtml()});
    assert.equal(result.verified,true);
    assert.equal(app.messages.find(m=>m.type==='BILI_API'&&m.method==='saveDraft').jobKey,job);
  }finally{app.close();}
});

test('any image download failure prevents saving even after another image was uploaded',async()=>{
  const app=setup();try{
    await assert.rejects(runImport({sourceUrl,html:articleHtml({extraImage:'https://mmbiz.qpic.cn/example/broken.png'})}),/第 2 张图片处理失败/);
    assert.equal(app.uploads.length,1);assert.equal(app.savedPayloads.length,0);
    assert.equal(app.messages.filter(m=>m.type==='BILI_API'&&m.method==='saveDraft').length,0);
  }finally{app.close();}
});
