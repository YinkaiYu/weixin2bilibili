import {parseArticle,cleanArticle} from './article.js';
import {toOpus} from './opus.js';
import {prepareForNative} from './raster.js';
import {downloadImage,migrateImages} from './media.js';
import {indexLocalFiles} from './local-files.js';
import {createBridgeClient,bridgeFetch} from './bridge.js';
import {classifyImportMessages,noticeFields,importFailure} from './import-notices.js';
import {matchCollection} from './bilibili.js';

async function hashText(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function loadSource(url){
  const response=await chrome.runtime.sendMessage({type:'LOAD_ARTICLE',sourceUrl:url});
  if(!response?.ok)throw new Error(response?.error?.message||'读取文章失败，请在 Edge 打开文章后重试。');
  return response.data.html;
}
function preflight(html){
  const doc=new DOMParser().parseFromString(html,'text/html'),images=new Map();
  [...doc.querySelectorAll('img')].forEach((img,i)=>{const url=`https://i0.hdslb.com/bfs/new_dyn/preflight-${i}.png`;img.src=url;images.set(url,{url,width:Number(img.getAttribute('data-w')||img.width)||640,height:Number(img.getAttribute('data-h')||img.height)||480,size:1});});
  return toOpus(doc.body.innerHTML,{images});
}
function chooseCollection(names,collections,title=''){
  const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').trim();
  const explicitNames=Array.isArray(names)?names.filter(name=>normalize(name)):[];
  // Some directly loaded WeChat pages omit album metadata. A final title label
  // is only a fallback candidate; it cannot override explicit source metadata.
  const suffix=String(title||'').match(/[|｜]([^|｜]+)$/u)?.[1]?.trim();
  const candidates=explicitNames.length?explicitNames:suffix?[suffix]:[];
  const collection=matchCollection(candidates.map(normalize),collections.map(item=>({...item,name:normalize(item.name)})));
  return {collection,candidates};
}
function downloadableCover(title,migrated){
  const mime=migrated.images.get(migrated.coverUrl)?.mime;
  const extension=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'})[mime];
  if(!migrated.coverUrl||!extension)return null;
  const name=String(title||'公众号文章').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().replace(/[. ]+$/,'').slice(0,100)||'公众号文章';
  return {url:migrated.coverUrl,filename:`${name}-封面.${extension}`};
}
async function importArticle({sourceUrl='',html='',localFiles:files=[]},onProgress=()=>{}){
  if(!html){let url;try{url=new URL(sourceUrl);}catch{throw new Error('请输入微信公众号文章链接。');}
    if(url.protocol!=='https:'||url.hostname!=='mp.weixin.qq.com'||!/^\/s(?:\/|$)/.test(url.pathname))throw new Error('请输入 https://mp.weixin.qq.com/s/ 开头的文章链接。');
    onProgress('正在读取文章…');html=await loadSource(url.href);
  }
  const article=parseArticle(html,{sourceUrl});
  if(!article.title||!article.html.trim())throw new Error('没有读取到文章标题或正文，请检查原网页。');
  if(!article.coverUrl)throw new Error('没有识别到公众号封面，已停止。请使用原始文章链接或保存完整网页后导入。');
  const localFiles=indexLocalFiles(files),savedPaths=new Map(article.localAssets.map(a=>[a.sourceUrl,a.localPath]));
  onProgress('正在检查排版…');
  const prepared=await prepareForNative(article.html,{localFiles,savedPaths,onProgress:p=>onProgress(p.state==='error'?p.message:`正在转换局部排版 ${p.index+1}/${p.total}`),downloadImageImpl:(url,opts)=>downloadImage(url,{...opts,fetchImpl:bridgeFetch,localFiles,savedPaths})});
  const cleaned=cleanArticle(prepared.html,{sourceUrl:article.sourceUrl});
  const nativeCheck=preflight(cleaned.html);
  const blockers=[...(prepared.blockingIssues||[]),...cleaned.blockingIssues,...nativeCheck.blockingIssues];
  if(blockers.length)throw new Error([...new Set(blockers)].join('\n'));
  const sourceKey=await hashText(article.sourceUrl||article.title+'\n'+article.html);
  const pendingKey='pendingJob:'+sourceKey;
  const old=(await chrome.storage.local.get(pendingKey))[pendingKey];
  const jobKey=old?.jobKey||crypto.randomUUID();
  await chrome.storage.local.set({[pendingKey]:{jobKey,startedAt:Date.now()}});
  const client=createBridgeClient({jobKey});
  onProgress('正在匹配 B站文集…');const account=await client.getLoginInfo();
  const collections=await client.listCollections();const {collection,candidates}=chooseCollection(article.collectionNames,collections,article.title);
  const requestedSourceLinks=nativeCheck.requestedSourceLinks||nativeCheck.sourceLinks||[];
  let sourceLinkValidation={accepted:[],rejected:[],failed:[]};
  if(requestedSourceLinks.length){
    onProgress('正在核对原文链接…');
    try{sourceLinkValidation=await client.validateSourceLinks(requestedSourceLinks);}
    catch{sourceLinkValidation={accepted:[],rejected:[],failed:requestedSourceLinks};}
  }
  const cacheKey='uploadCache:'+account.userId;
  let cache=(await chrome.storage.local.get(cacheKey))[cacheKey]||{};
  const migrated=await migrateImages(cleaned.html,{coverUrl:article.coverUrl,client,cache,cacheKey:account.userId,localFiles,savedPaths,fetchImpl:bridgeFetch,onCache:async value=>{
    cache=value;const entries=Object.entries(cache);if(entries.length>1500)cache=Object.fromEntries(entries.slice(-1500));await chrome.storage.local.set({[cacheKey]:cache});
  },onProgress:p=>onProgress(p.state==='error'?p.message:`正在转存图片 ${p.index+1}/${p.total}${p.state==='done'?' · 完成':''}`)});
  const native=toOpus(migrated.html,{images:migrated.images,sourceLinkValidation});
  if(native.blockingIssues.length)throw new Error(native.blockingIssues.join('\n'));
  onProgress('正在保存并核对草稿…');
  const result=await client.saveDraft({jobKey,title:article.title,content:native.content,sourceLinks:native.sourceLinks||[],summary:native.summary,coverUrl:migrated.coverUrl,collectionId:collection?.id,original:true});
  const outcome=[];
  if(!collection&&candidates.length)outcome.push({severity:'warning',message:`未找到唯一对应的文集（${candidates.join('、')}），请在发布设置中选择。`});
  if(result.verified!==true){
    outcome.push({severity:'error',message:result.verified===false?'草稿已保存，但核验未通过。':'草稿已保存，但尚未确认核验结果。'});
    outcome.push(...(result.verification?.issues||[]).map(message=>({severity:'warning',message})));
  }else await chrome.storage.local.remove(pendingKey);
  const notices=classifyImportMessages(article.warnings,article.notices,prepared.warnings,prepared.notices,cleaned.warnings,cleaned.notices,native.warnings,native.notices,result.warnings,result.notices,outcome);
  return {...result,...noticeFields(notices),title:article.title,cover:downloadableCover(article.title,migrated)};
}

export async function runImport(options,onProgress=()=>{}){
  try{return await importArticle(options,onProgress);}
  catch(error){throw importFailure(error);}
}

/** Only called after the user explicitly confirms that no draft was created. */
export async function resetPendingImport({sourceUrl='',html=''}){
  const article=html?parseArticle(html,{sourceUrl}):{sourceUrl,title:'',html:''};
  const sourceKey=await hashText(article.sourceUrl||article.title+'\n'+article.html);
  await chrome.storage.local.remove('pendingJob:'+sourceKey);
}
