/** Typed content-script -> service-worker bridge. No cookies enter the page. */
import {allowedImageUrl} from './media.js';

export const MAX_BRIDGE_IMAGE_BYTES=32*1024*1024;

export async function blobToBase64(blob){
  if(!(blob instanceof Blob)||!blob.size)throw new Error('图片文件为空。');
  if(blob.size>MAX_BRIDGE_IMAGE_BYTES)throw new Error('单张图片超过插件当前 32MB 传输上限，请调整原图。');
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
}

export function base64ToBytes(value){
  if(typeof value!=='string'||!value.length||value.length%4!==0||value.length>Math.ceil(MAX_BRIDGE_IMAGE_BYTES/3)*4||/[^A-Za-z0-9+/=]/.test(value))throw new Error('图片传输数据无效或超出大小限制。');
  let binary;try{binary=atob(value);}catch{throw new Error('图片传输数据不是有效的 Base64。');}
  if(binary.length>MAX_BRIDGE_IMAGE_BYTES)throw new Error('图片超过插件当前 32MB 传输上限。');
  // Avoid Uint8Array.from(string, callback): its iterable conversion may build a
  // very large intermediate array before creating the final typed array.
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}

async function request(message,{sendMessage=message=>chrome.runtime.sendMessage(message),signal}={}){
  if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');
  let abort;
  const abortPromise=signal?new Promise((_,reject)=>{abort=()=>reject(signal.reason||new DOMException('已取消','AbortError'));signal.addEventListener('abort',abort,{once:true});}):null;
  let reply;
  try{
    const operation=Promise.resolve().then(()=>sendMessage(message));
    reply=await(abortPromise?Promise.race([operation,abortPromise]):operation);
  }catch(error){
    if(signal?.aborted)throw error;
    throw new Error(`插件后台连接中断，请刷新 B站页面后重试。${error?.message?` ${error.message}`:''}`);
  }finally{if(abort)signal.removeEventListener('abort',abort);}
  if(!reply||typeof reply.ok!=='boolean')throw new Error('插件后台没有返回有效结果，请刷新 B站页面后重试。');
  if(!reply.ok){
    const error=new Error(reply.error?.message||'插件后台操作失败。');
    for(const key of ['code','draftId','draftUrl','saveUncertain','retryAfterCheck'])if(reply.error?.[key]!==undefined)error[key]=reply.error[key];
    throw error;
  }
  return reply.data;
}

/** A restricted GET-only fetch substitute for downloadImage/verifyAnimation. */
export async function bridgeFetch(url,options={}){
  if((options.method||'GET').toUpperCase()!=='GET'||options.body!=null)throw new Error('图片下载通道仅支持读取图片。');
  if(!allowedImageUrl(url))throw new Error('图片地址不在允许的来源列表中。');
  const data=await request({type:'DOWNLOAD_IMAGE',url},{sendMessage:options.sendMessage,signal:options.signal});
  const response=new Response(base64ToBytes(data.base64),{status:data.status||200,headers:{'Content-Type':data.mime||'application/octet-stream'}});
  Object.defineProperty(response,'url',{value:data.url||url});
  return response;
}

export function createBridgeClient({sendMessage,jobKey=''}={}){
  const call=(method,payload={},extra={})=>request({type:'BILI_API',method,payload,...extra},{sendMessage});
  return {
    getLoginInfo:()=>call('getLoginInfo'),
    listCollections:()=>call('listCollections'),
    validateSourceLinks:urls=>call('validateSourceLinks',{urls}),
    async uploadImage(blob,{filename='image'}={}){
      return call('uploadImage',{base64:await blobToBase64(blob),mime:blob.type,filename});
    },
    async saveDraft(options){
      const {onSaved,jobKey:localJobKey,...payload}=options;
      const result=await call('saveDraft',payload,{jobKey:localJobKey||jobKey});
      // The background has already durably checkpointed this ID before readback.
      // This callback only updates the visible page; it cannot undo a saved draft.
      if(typeof onSaved==='function'){
        try{await onSaved({draftId:result.draftId,draftUrl:result.draftUrl});}
        catch{result.verified=false;result.verification={ok:false,issues:['草稿已保存，但页面状态更新失败，请打开已有草稿继续。',...(result.verification?.issues||[])]};}
      }
      return result;
    },
  };
}
