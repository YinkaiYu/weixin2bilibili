import {parseArticle,cleanArticle} from './article.js';
import {toOpus} from './opus.js';
import {prepareForNative} from './raster.js';
import {downloadImage,migrateImages} from './media.js';
import {indexLocalFiles} from './local-files.js';
import {createBridgeClient,bridgeFetch} from './bridge.js';

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
function chooseCollection(names,collections){
  const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').trim();
  const found=collections.filter(c=>names.some(n=>normalize(n)===normalize(c.name)));
  return found.length===1?found[0]:null;
}
export async function runImport({sourceUrl='',html='',localFiles:files=[]},onProgress=()=>{}){
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
  const collections=await client.listCollections();const collection=chooseCollection(article.collectionNames,collections);
  const cacheKey='uploadCache:'+account.userId;
  let cache=(await chrome.storage.local.get(cacheKey))[cacheKey]||{};
  const migrated=await migrateImages(cleaned.html,{coverUrl:article.coverUrl,client,cache,cacheKey:account.userId,localFiles,savedPaths,fetchImpl:bridgeFetch,onCache:async value=>{
    cache=value;const entries=Object.entries(cache);if(entries.length>1500)cache=Object.fromEntries(entries.slice(-1500));await chrome.storage.local.set({[cacheKey]:cache});
  },onProgress:p=>onProgress(p.state==='error'?p.message:`正在转存图片 ${p.index+1}/${p.total}${p.state==='done'?' · 完成':''}`)});
  const native=toOpus(migrated.html,{images:migrated.images});
  if(native.blockingIssues.length)throw new Error(native.blockingIssues.join('\n'));
  onProgress('正在保存并核对草稿…');
  const result=await client.saveDraft({jobKey,title:article.title,content:native.content,summary:native.summary,coverUrl:migrated.coverUrl,collectionId:collection?.id,original:true});
  const warnings=[...prepared.warnings,...native.warnings];
  if(!collection&&article.collectionNames.length)warnings.push(`未找到唯一对应的文集（${article.collectionNames.join('、')}），请在发布设置中选择。`);
  if(result.verified===false){warnings.unshift(...(result.verification?.issues||['草稿已保存，读回检查未通过，请核对。']));}
  else await chrome.storage.local.remove(pendingKey);
  return {...result,warnings:[...new Set(warnings)],title:article.title};
}

/** Only called after the user explicitly confirms that no draft was created. */
export async function resetPendingImport({sourceUrl='',html=''}){
  const article=html?parseArticle(html,{sourceUrl}):{sourceUrl,title:'',html:''};
  const sourceKey=await hashText(article.sourceUrl||article.title+'\n'+article.html);
  await chrome.storage.local.remove('pendingJob:'+sourceKey);
}
