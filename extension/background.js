import {createBackgroundHandler,isTrustedNativeSender} from './lib/background-handlers.js';
const handleAPI=createBackgroundHandler();
const EDITOR='https://member.bilibili.com/york/read-editor';
const isEditor=value=>{try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='member.bilibili.com'&&!url.port&&!url.username&&!url.password&&/^(?:\/york\/read-editor|\/platform\/upload\/text\/(?:new-edit|edit))\/?$/.test(url.pathname);}catch{return false;}};
async function configureRules(){
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[10],addRules:[{id:10,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'origin',operation:'set',value:'https://member.bilibili.com'},{header:'referer',operation:'set',value:'https://member.bilibili.com/'}]},condition:{urlFilter:'||api.bilibili.com/',resourceTypes:['xmlhttprequest'],initiatorDomains:[chrome.runtime.id]}}]});
}
chrome.runtime.onInstalled.addListener(configureRules);chrome.runtime.onStartup.addListener(configureRules);
chrome.action.onClicked.addListener(async tab=>{
  await configureRules();
  if(isEditor(tab.url)){
    try{await chrome.tabs.sendMessage(tab.id,{type:'SHOW_IMPORT'});}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['vendor/html2canvas.min.js','native-ui.js']});await chrome.tabs.sendMessage(tab.id,{type:'SHOW_IMPORT'});}return;
  }
  const sourceUrl=tab.url?.startsWith('https://mp.weixin.qq.com/')?tab.url:'';
  await chrome.tabs.create({url:EDITOR+'#wechat-import'+(sourceUrl?'?source='+encodeURIComponent(sourceUrl):'')});
});
function trusted(sender){return isTrustedNativeSender(sender,chrome.runtime.id);}
async function downloadCover(message){
  let url;try{url=new URL(message.url);}catch{throw new Error('封面地址无效。');}
  if(url.protocol!=='https:'||url.port||url.username||url.password||!url.pathname.startsWith('/bfs/')||!/(^|\.)(hdslb\.com|biliimg\.com)$/.test(url.hostname))throw new Error('仅可下载已转存到 B站的封面。');
  const requested=String(message.filename||'文章封面.jpg');
  const extension=requested.match(/\.(jpe?g|png|gif|webp|avif)$/i)?.[1]?.toLowerCase();
  if(!extension)throw new Error('封面文件格式无效。');
  let base=requested.slice(0,-extension.length-1).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'').trim();
  base=Array.from(base).slice(0,100).join('')||'文章封面';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base))base='封面-'+base;
  try{
    const downloadId=await chrome.downloads.download({url:url.href,filename:`${base}.${extension}`,saveAs:true,conflictAction:'uniquify'});
    return {ok:true,downloadId};
  }catch(error){
    if(/cancel(?:ed|led)|USER_CANCELED|用户.*取消/i.test(String(error?.message||'')))return {ok:false,cancelled:true};
    throw new Error('封面下载未能开始，请重试。');
  }
}
async function loadArticle(sourceUrl){
  let url;try{url=new URL(sourceUrl);}catch{throw new Error('文章链接无效。');}
  if(url.protocol!=='https:'||url.hostname!=='mp.weixin.qq.com'||url.username||url.password||!/^\/s(?:\/|$)/.test(url.pathname))throw new Error('仅支持微信公众号文章链接。');
  const tabs=await chrome.tabs.query({url:'https://mp.weixin.qq.com/*'});
  const existing=tabs.find(t=>t.url?.split('#')[0]===url.href.split('#')[0]);
  if(existing){const result=await chrome.scripting.executeScript({target:{tabId:existing.id},func:()=>document.documentElement.outerHTML});if(/id=["']js_content["']/.test(result[0]?.result||''))return {html:result[0].result};}
  const response=await fetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`读取文章失败（${response.status}），请先在 Edge 打开原文后重试。`);
  const html=await response.text();if(!/id=["']js_content["']/.test(html))throw new Error('未读取到正文。请在 Edge 打开原文完成验证，或导入本地网页。');
  return {html};
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!['BILI_API','DOWNLOAD_IMAGE','DOWNLOAD_COVER','LOAD_ARTICLE','OPEN_SAVED_DRAFT'].includes(message?.type))return;
  (async()=>{
    if(!trusted(sender))throw new Error('不允许从此页面调用导入功能。');
    if(message.type==='DOWNLOAD_COVER')return downloadCover(message);
    if(message.type==='BILI_API'||message.type==='DOWNLOAD_IMAGE')return handleAPI(message,sender);
    if(message.type==='LOAD_ARTICLE')return {ok:true,data:await loadArticle(message.sourceUrl)};
    let draft;try{draft=new URL(message.draftUrl);}catch{throw new Error('草稿地址无效。');}
    if(draft.origin!=='https://member.bilibili.com'||draft.pathname!=='/york/read-editor'||!/^\d+$/.test(draft.searchParams.get('aid')||''))throw new Error('草稿地址无效。');
    // The current page may now contain unsaved native edits, even if we opened it.
    await chrome.tabs.create({url:draft.href});
    return {ok:true,data:{opened:true}};
  })().then(sendResponse,error=>sendResponse({ok:false,error:{message:error.message}}));return true;
});
