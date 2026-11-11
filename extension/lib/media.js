/** Byte-preserving image handling: never draw GIFs onto canvas. */
import {inspectGif,normalizeBiliImageUrl} from './bilibili.js';
import {resolveLocalFile} from './local-files.js';
const IMAGE_HOSTS = ['qpic.cn','qlogo.cn','hdslb.com','biliimg.com'];
export function allowedImageUrl(value) {
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)) return true;
  try { const u=new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password && !u.port && (u.hostname==='res.wx.qq.com'||IMAGE_HOSTS.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))); } catch {return false;}
}
export function biliImageUrl(value) {
  try {const u=new URL(value);normalizeBiliImageUrl(value);return u.protocol==='https:'&&!u.port;}catch{return false;}
}
function ascii(b,start,n){return String.fromCharCode(...b.slice(start,start+n));}
function u16(b,p){return b[p]|b[p+1]<<8;}
function u32(b,p){return (b[p]|b[p+1]<<8|b[p+2]<<16|b[p+3]<<24)>>>0;}
export function sniffImage(bytes) {
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(ascii(b,0,3)==='GIF'){
    const animation=inspectGif(b);
    return {mime:'image/gif',extension:'gif',width:u16(b,6),height:u16(b,8),...animation,animated:animation.frames>1};
  }
  if(b[0]===137&&ascii(b,1,3)==='PNG'){
    if(b.length<33||![137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)||ascii(b,12,4)!=='IHDR')throw new Error('PNG 数据不完整');
    let frames=1,complete=false;for(let p=8;p+12<=b.length;){const len=new DataView(b.buffer,b.byteOffset+p,4).getUint32(0);if(p+len+12>b.length)throw new Error('PNG 数据不完整');const type=ascii(b,p+4,4);if(type==='acTL'&&len>=8)frames=new DataView(b.buffer,b.byteOffset+p+8,4).getUint32(0);if(type==='IEND'){complete=true;break;}p+=len+12;}
    if(!complete)throw new Error('PNG 数据不完整');
    return {mime:'image/png',extension:'png',width:new DataView(b.buffer,b.byteOffset+16,8).getUint32(0),height:new DataView(b.buffer,b.byteOffset+16,8).getUint32(4),frames,animated:frames>1};
  }
  if(b[0]===255&&b[1]===216&&b[2]===255)return {mime:'image/jpeg',extension:'jpg',frames:1,animated:false};
  if(ascii(b,0,4)==='RIFF'&&ascii(b,8,4)==='WEBP'){
    if(b.length<20||u32(b,4)+8>b.length)throw new Error('WebP 数据不完整');
    let frames=0,width,height,animationFlag=false;for(let p=12;p+8<=b.length;){const type=ascii(b,p,4),n=u32(b,p+4);if(p+8+n>b.length)throw new Error('WebP 数据不完整');if(type==='VP8X'&&n>=10){animationFlag=!!(b[p+8]&2);width=1+(b[p+12]|b[p+13]<<8|b[p+14]<<16);height=1+(b[p+15]|b[p+16]<<8|b[p+17]<<16);}if(type==='ANMF')frames++;p+=8+n+(n%2);}
    if(animationFlag&&!frames)throw new Error('WebP 动画缺少画面数据');
    return {mime:'image/webp',extension:'webp',width,height,frames:frames||1,animated:frames>1};
  }
  throw new Error('不是可识别的 PNG/JPEG/GIF/WebP 图片，可能返回了错误网页；未上传。');
}
export async function inspectBlob(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());const info=sniffImage(bytes);
  const normalized=new Blob([bytes],{type:info.mime});
  if(!info.width||!info.height){const bitmap=await createImageBitmap(normalized);info.width=bitmap.width;info.height=bitmap.height;bitmap.close();}
  if(!info.width||!info.height)throw new Error('图片尺寸无效');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  return {...info,blob:normalized,bytes,size:bytes.length,hash};
}
export async function downloadImage(url,{fetchImpl=fetch,localFiles=new Map(),savedPaths=new Map()}={}){
  const localPath=savedPaths.get(url)||url;
  const hasLocalMapping=savedPaths.has(url)||url.startsWith('localasset:///');
  const local=localFiles.get(url)||(hasLocalMapping&&resolveLocalFile(localPath,localFiles));
  if(local)return inspectBlob(local);
  if(!allowedImageUrl(url))throw new Error(`图片地址不可读取，请选择保存网页的资源文件夹或重新插入原图：${url.slice(0,160)}`);
  const normalized=url.startsWith('http://')?'https://'+url.slice(7):url;
  const response=await fetchImpl(normalized,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw new Error(`下载图片失败（${response.status}）：${url.slice(0,120)}`);
  if(response.url&&!response.url.startsWith('data:')&&!allowedImageUrl(response.url))throw new Error('图片跳转到未支持的域名');
  const blob=await response.blob();
  if(blob.size>50*1024*1024)throw new Error('单张图片超过工具当前 50MB 处理上限，请调整原图。');
  const info=await inspectBlob(blob);
  if(/[?&]wx_fmt=gif\b/i.test(url)&&info.mime!=='image/gif'&&!info.animated)throw new Error('原地址标记为动图，但下载结果为静态图片；已停止。');
  return info;
}
export async function verifyAnimation(uploadedUrl,source,{fetchImpl=fetch}={}){
  if(!source.animated)return;
  if(!biliImageUrl(uploadedUrl))throw new Error('动图校验地址不是 B站图片地址，已停止。');
  const response=await fetchImpl(uploadedUrl,{credentials:'omit',signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw new Error('无法检查上传后动图，暂不保存草稿。');
  const actual=sniffImage(new Uint8Array(await response.arrayBuffer()));
  if(!actual.animated||actual.mime!==source.mime||actual.frames!==source.frames)throw new Error(`动图上传后格式或帧数发生变化（${source.frames} → ${actual.frames}），暂不保存草稿。`);
  if(source.mime==='image/gif'&&JSON.stringify(actual.delays)!==JSON.stringify(source.delays))throw new Error('动图上传后播放时序发生变化，暂不保存草稿。');
}
export async function migrateImages(html,{coverUrl='',client,cache={},cacheKey='',localFiles=new Map(),savedPaths=new Map(),fetchImpl=fetch,onProgress=()=>{},onCache=()=>{}}){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const sources=[...new Set([...doc.querySelectorAll('img')].map(n=>n.getAttribute('src')).concat(coverUrl||[]))];
  const replacements=new Map(),images=new Map();
  for(let index=0;index<sources.length;index++){
    const src=sources[index];if(!src)throw new Error('正文包含缺少地址的图片');
    onProgress({index,total:sources.length,source:src,state:'loading'});
    try{
      const original=await downloadImage(src,{fetchImpl,localFiles,savedPaths});
      const key=cacheKey+':'+original.hash;let uploaded=cache[key];
      if(uploaded&&!biliImageUrl(uploaded.url))uploaded=null;
      if(!uploaded){
        uploaded=await client.uploadImage(original.blob,{filename:original.hash.slice(0,16)+'.'+original.extension});
        if(!biliImageUrl(uploaded.url))throw new Error('B站返回了非站内图片地址，已停止。');
        if(!uploaded.animationVerified)await verifyAnimation(uploaded.url,original,{fetchImpl});
        uploaded={...uploaded,width:uploaded.width||original.width,height:uploaded.height||original.height,size:uploaded.size??original.size/1024,bytes:original.size,mime:original.mime,frames:original.frames,animated:original.animated};
        cache[key]=uploaded;await onCache(cache);
      }else if(original.animated){await verifyAnimation(uploaded.url,original,{fetchImpl});}
      replacements.set(src,uploaded.url);images.set(uploaded.url,uploaded);
      onProgress({index,total:sources.length,source:src,state:'done',animated:original.animated,frames:original.frames});
    }catch(error){onProgress({index,total:sources.length,source:src,state:'error',message:error.message});throw new Error(`第 ${index+1} 张图片处理失败：${error.message}`);}
  }
  for(const node of doc.querySelectorAll('img')){
    const src=node.getAttribute('src');node.setAttribute('src',replacements.get(src));
    for(const attr of [...node.attributes])if(/^(?:data-src|srcset|data-back|data-original|data-url|data-srcset)$/i.test(attr.name))node.removeAttribute(attr.name);
  }
  return {html:doc.body.innerHTML,coverUrl:coverUrl?replacements.get(coverUrl):'',images,cache};
}
