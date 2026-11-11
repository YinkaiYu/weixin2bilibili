/** All privileged network work stays in the extension service worker. */
import {createBilibiliClient,buildDraftPayload,verifyDraft,draftEditorUrl} from './bilibili.js';
import {allowedImageUrl} from './media.js';
import {blobToBase64,base64ToBytes,MAX_BRIDGE_IMAGE_BYTES} from './bridge.js';

const METHODS=new Set(['getLoginInfo','listCollections','validateSourceLinks','uploadImage','saveDraft']);
const SAVED_FIELDS=new Set(['title','content','sourceLinks','coverUrl','collectionId','original','draftId','summary']);

export function isTrustedNativeSender(sender,extensionId){
  if(!extensionId||sender?.id!==extensionId||!Number.isInteger(sender.tab?.id)||sender.frameId!==0)return false;
  try{
    const page=new URL(sender.url),tab=new URL(sender.tab.url);
    const allowed=url=>url.protocol==='https:'&&url.hostname==='member.bilibili.com'&&!url.port&&!url.username&&!url.password&&/^(?:\/york\/read-editor|\/platform\/upload\/text\/(?:new-edit|edit))\/?$/.test(url.pathname);
    return allowed(page)&&allowed(tab);
  }catch{return false;}
}

function publicError(error){
  const result={message:String(error?.message||'插件后台操作失败。')};
  for(const key of ['code','draftId','draftUrl','saveUncertain','retryAfterCheck'])if(error?.[key]!==undefined)result[key]=error[key];
  return result;
}

export function createBackgroundHandler({client,fetchImpl=globalThis.fetch?.bind(globalThis),storage,extensionId}={}){
  client=client||createBilibiliClient({fetchImpl});
  storage=storage||globalThis.chrome?.storage?.local;
  extensionId=extensionId||globalThis.chrome?.runtime?.id;
  const saveLocks=new Set();

  async function download(url){
    if(typeof url!=='string'||!allowedImageUrl(url))throw new Error('图片地址不在允许的来源列表中。');
    const target=url.startsWith('http://')?'https://'+url.slice(7):url;
    const response=await fetchImpl(target,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw new Error(`图片下载失败（${response.status}）。`);
    if(response.url&&!allowedImageUrl(response.url))throw new Error('图片跳转到了未授权的来源。');
    const declared=Number(response.headers.get('Content-Length'));
    if(Number.isFinite(declared)&&declared>MAX_BRIDGE_IMAGE_BYTES)throw new Error('图片超过插件当前 32MB 传输上限。');
    const blob=await response.blob();
    return {base64:await blobToBase64(blob),mime:blob.type,status:response.status,url:response.url||target};
  }

  async function save(payload,jobKey){
    if(typeof jobKey!=='string'||!jobKey.trim()||jobKey.length>256||/[\u0000-\u001f\u007f]/.test(jobKey))throw new Error('缺少有效的文章任务编号，请重新导入文章。');
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('草稿内容无效。');
    const clean={};for(const [key,value]of Object.entries(payload))if(SAVED_FIELDS.has(key))clean[key]=value;
    const account=await client.getLoginInfo();
    if(!/^\d+$/.test(String(account.userId||'')))throw new Error('无法确认当前 B站账号，请重新登录。');
    const key=`draftCheckpoint:${account.userId}:${jobKey}`;
    if(saveLocks.has(key))throw new Error('这篇文章正在保存，请等待当前操作完成。');
    saveLocks.add(key);
    try{
      const saved=(await storage.get(key))[key];
      if(!clean.draftId&&saved?.draftId)clean.draftId=saved.draftId;
      if(!clean.draftId&&saved?.saveUncertain){
        const error=new Error('上次保存结果不确定，请先在 B站草稿箱查找这篇文章；找到后从该草稿继续，避免重复创建。');
        error.saveUncertain=true;throw error;
      }
      if(clean.draftId){
        // A confirmed draft may have been edited in B站 since the last import.
        // Recovery only reads it; a new conversion must use a new job explicitly.
        const draftId=String(clean.draftId),draftUrl=draftEditorUrl(draftId);
        let draft,verification;
        try{
          draft=await client.getDraft(draftId);
          if(!saved?.draftId)await storage.set({[key]:{draftId,draftUrl,title:draft.title,userId:account.userId,updatedAt:Date.now(),saveUncertain:false}});
          verification=verifyDraft(buildDraftPayload(clean),draft);
        }catch(error){
          verification={ok:false,issues:[`已有草稿核对失败：${error.message}`]};
        }
        if(!verification.ok)verification.issues.unshift('已有草稿已保留，未覆盖其中的修改。');
        return {draftId,draftUrl,recovered:true,verified:verification.ok,verification,draft};
      }
      return await client.saveDraft({...clean,onSaved:async checkpoint=>{
        await storage.set({[key]:{...checkpoint,title:clean.title,userId:account.userId,updatedAt:Date.now(),saveUncertain:false}});
      }});
    }catch(error){
      if(error.saveUncertain&&!error.draftId){
        // Preserve uncertainty across tab closure; never automatically create again.
        await storage.set({[key]:{title:clean.title,userId:account.userId,updatedAt:Date.now(),saveUncertain:true}}).catch(()=>{});
      }
      throw error;
    }finally{saveLocks.delete(key);}
  }

  return async function handleBackgroundMessage(message,sender){
    try{
      if(!isTrustedNativeSender(sender,extensionId))throw new Error('仅允许本扩展在 B站原生专栏编辑页执行此操作。');
      if(message?.type==='DOWNLOAD_IMAGE')return {ok:true,data:await download(message.url)};
      if(message?.type!=='BILI_API'||!METHODS.has(message.method))throw new Error('不支持的插件操作。');
      const payload=message.payload||{};
      let data;
      if(message.method==='getLoginInfo')data=await client.getLoginInfo();
      else if(message.method==='listCollections')data=await client.listCollections();
      else if(message.method==='validateSourceLinks')data=await client.validateSourceLinks(payload.urls);
      else if(message.method==='uploadImage'){
        const bytes=base64ToBytes(payload.base64);
        const blob=new Blob([bytes],{type:typeof payload.mime==='string'?payload.mime:'application/octet-stream'});
        data=await client.uploadImage(blob,{filename:String(payload.filename||'image')});
      }else data=await save(payload,message.jobKey);
      return {ok:true,data};
    }catch(error){return {ok:false,error:publicError(error)};}
  };
}
