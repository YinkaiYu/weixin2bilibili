// Local UI scenarios exercise the production controller without external requests.
(() => {
  const scenario=new URLSearchParams(location.search).get('scenario');
  const enabled=['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&['success','warning','error'].includes(scenario);
  const runtime={id:'local-preview',onMessage:{addListener(){}},getURL:p=>new URL('/'+p,location.href).href,
    sendMessage:async()=>({ok:false,error:{message:'这是本地界面测试，请使用安装后的扩展。'}})};
  window.chrome={runtime};
  if(!enabled)return;

  const state={},messages=[],png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6kAAAAASUVORK5CYII=';
  const imageUrl='https://mmbiz.qpic.cn/local-preview/cover.png';
  const uploadedUrl='https://i0.hdslb.com/bfs/new_dyn/local-preview.png';
  const html=`<!doctype html><html><head><script>var msg_cdn_url="${imageUrl}";var album_name="正经玩";</script></head><body><h1 id="activity-name">本地导入预览 | 正经玩</h1><div id="js_content"><p><strong>实验里的物理</strong>：H<sub>2</sub>O</p><p><img src="${imageUrl}"></p><h2>往期回顾</h2><p>本段应由真实清理流程删除。</p></div></body></html>`;
  window.__localPreview={scenario,messages};
  window.chrome.storage={local:{
    get:async key=>({[key]:state[key]===undefined?undefined:structuredClone(state[key])}),
    set:async values=>Object.assign(state,structuredClone(values)),
    remove:async key=>{delete state[key];},
  }};
  const originalFetch=window.fetch?.bind(window);
  window.fetch=(input,options)=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.origin!==location.origin)return Promise.reject(new Error('本地预览禁止外部请求。'));
    if(!originalFetch)return Promise.reject(new Error('本地预览没有网络通道。'));
    return originalFetch(input,options);
  };
  runtime.sendMessage=async message=>{
    messages.push(structuredClone(message));
    if(message.type==='LOAD_ARTICLE')return {ok:true,data:{html}};
    if(message.type==='DOWNLOAD_IMAGE')return {ok:true,data:{base64:png,mime:'image/png',url:message.url}};
    if(message.type==='OPEN_SAVED_DRAFT')return {ok:true};
    if(message.type==='DOWNLOAD_COVER')return {ok:true,downloadId:1};
    if(message.type==='BILI_API'){
      if(message.method==='getLoginInfo')return {ok:true,data:{userId:1,name:'本地预览'}};
      if(message.method==='listCollections')return {ok:true,data:scenario==='warning'?[]:[{id:1,name:'正经玩'}]};
      if(message.method==='uploadImage')return {ok:true,data:{url:uploadedUrl,width:1,height:1,size:68/1024}};
      if(message.method==='saveDraft')return {ok:true,data:{
        draftId:'999999',draftUrl:'https://member.bilibili.com/york/read-editor?aid=999999',verified:scenario!=='error',
        warnings:['一处带颜色的图注已保留为正文，请检查图片下方文字。'],
        verification:scenario==='error'?{ok:false,issues:['保存后的图片注释与导入内容不一致，请核对草稿。']}:{ok:true,issues:[]},
      }};
    }
    return {ok:false,error:{message:'本地预览不支持此操作。'}};
  };
})();
