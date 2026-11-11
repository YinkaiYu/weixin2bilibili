/**
 * Native article-draft adapter, independently implemented from the public web
 * editor's request/response schema inspected on 2026-11-11.
 * Reference: https://member.bilibili.com/york/read-editor
 * Bundle: /bfs/static/sunflower/read-editor/assets/index-iVnxuzkp.js
 * Only uploads assets and saves drafts. There is deliberately no publish method.
 */
import {normalizeSourceLink} from './source-links.js';

export const BILIBILI_EDITOR_VERSION = 'eva3-4.0.0';
export const BILIBILI_ENDPOINTS = Object.freeze({
  login: '/x/web-interface/nav',
  upload: '/x/dynamic/feed/draw/upload_bfs',
  collections: '/x/article/creative/list/all',
  sourceLinks: '/x/v2/dynamic/sunflower/parse',
  save: '/x/dynamic/feed/article/draft/add',
  view: '/x/dynamic/feed/article/draft/view',
});

export class BilibiliError extends Error {
  constructor(message, {code, operation, draftId, draftUrl, saveUncertain, cause} = {}) {
    super(message, cause ? {cause} : undefined);
    this.name = 'BilibiliError';
    Object.assign(this, {code, operation, draftId, draftUrl, saveUncertain});
  }
}

export function normalizeBiliImageUrl(value) {
  let url;
  try { url = new URL(String(value).startsWith('//') ? `https:${value}` : value); }
  catch { throw new BilibiliError('图片地址无效，请重新上传图片。'); }
  const validHost = ['hdslb.com', 'biliimg.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  if (!validHost || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !url.pathname.startsWith('/bfs/')) {
    throw new BilibiliError('图片尚未成功转存到 B 站，已停止保存，避免非法图片链接或缺图。');
  }
  url.protocol = 'https:';
  url.hash = '';
  return url.href;
}

export function matchCollection(names, collections) {
  const normalized = new Set((names || []).map(value => String(value).trim()).filter(Boolean));
  const matches = (collections || []).filter(item => normalized.has(String(item.name).trim()));
  if (matches.length) return matches.length === 1 ? matches[0] : null;
  // Institution-specific collection alias, documented in README. Exact names
  // take priority; this mapping does not inspect article copy or asset URLs.
  const aliases = normalized.has('问答') ? new Set(['问答Q&A']) : new Set();
  const aliasMatches = (collections || []).filter(item => aliases.has(String(item.name).trim()));
  return aliasMatches.length === 1 ? aliasMatches[0] : null;
}

function numericId(value, label, allowZero = false) {
  const id = String(value ?? '');
  if (!/^\d+$/.test(id) || (!allowZero && /^0+$/.test(id))) throw new BilibiliError(`${label}无效。`);
  // The official editor uses numeric article/list IDs. Refuse precision loss.
  if (!Number.isSafeInteger(Number(id))) throw new BilibiliError(`${label}超出安全范围。`);
  return Number(id);
}

export function draftEditorUrl(draftId) {
  return `https://member.bilibili.com/york/read-editor?aid=${numericId(draftId, '草稿编号')}`;
}

function collectPictures(content) {
  const result = [];
  for (const para of content?.paragraphs || []) {
    for (const picture of para.pic?.pics || []) result.push(picture);
  }
  return result;
}

function validateContent(content,sourceLinks=[]) {
  if (!content || !Array.isArray(content.paragraphs) || content.paragraphs.length === 0) throw new BilibiliError('正文为空，不能保存草稿。');
  if(!Array.isArray(sourceLinks)||sourceLinks.some(url=>!normalizeSourceLink(url)))throw new BilibiliError('原文出处链接清单无效，已停止保存。');
  const allowedSources=new Set(sourceLinks.map(normalizeSourceLink));
  for (const picture of collectPictures(content)) {
    normalizeBiliImageUrl(picture.url);
    if (!(Number(picture.width) > 0) || !(Number(picture.height) > 0) || !(Number(picture.size) > 0)) {
      throw new BilibiliError('图片尺寸或文件大小缺失，请重新上传后再保存。');
    }
    // The native editor's CaptionManager limits plain captions to 100 UTF-16
    // code units. The converter preserves longer captions as body paragraphs.
    if (picture.comment != null && (typeof picture.comment !== 'string' || picture.comment.length > 100)) {
      throw new BilibiliError('图片注释不是有效的 100 字符以内纯文字，请保留为图片下方正文。');
    }
  }
  for (const para of content.paragraphs) {
    if(para.link_card)throw new BilibiliError('正文含未确认的链接卡片，已停止保存。');
    for (const node of para.text?.nodes || []) {
      if(node.node_type===2 && (typeof node.emote?.raw_text!=='string'||!/^\[[^\[\]\r\n]{1,80}\]$/.test(node.emote.raw_text)))throw new BilibiliError('正文含无效的原生表情，已停止保存。');
      if(node.link||node.node_type===4||node.node_type===3){
        const url=normalizeSourceLink(node.link?.link);
        if(node.node_type!==4||node.link?.link_type!==16||!url||!allowedSources.has(url)||typeof node.link.show_text!=='string'||!node.link.show_text.trim()) {
          throw new BilibiliError('正文含未确认或无效的原文出处链接，已停止保存。');
        }
      }
    }
  }
}

export function buildDraftPayload({title, content, coverUrl, collectionId = 0, original = true, draftId, summary = '',sourceLinks=[]}) {
  if (!String(title || '').trim()) throw new BilibiliError('请填写文章标题。');
  validateContent(content,sourceLinks);
  const arg = {
    type: 4, template_id: 1, category_id: 15,
    title: String(title).trim(), private_pub: 2,
    reprint: 0, original: original ? 1 : 0,
    list_id: numericId(collectionId || 0, '文集编号', true),
    comment_selected: 0, up_closed_reply: 0,
    timer_pub_time: 0, only_fans_level: 0, only_fans_dnd: 0,
    summary: String(summary).slice(0, 250),
    opus: {
      opus_source: 2, title: String(title).trim(), content,
      pub_info: {editor_version: BILIBILI_EDITOR_VERSION},
      attachments: {is_aigc: 0},
    },
  };
  if (draftId != null) arg.article_id = numericId(draftId, '草稿编号');
  // Explicit empty array also clears a previously selected cover on updates.
  arg.image_urls = coverUrl ? [normalizeBiliImageUrl(coverUrl)] : [];
  return {arg};
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function color(value) { return String(value || '').replace(/^#/, '').toLowerCase(); }

function imageIdentity(value) {
  const url = new URL(normalizeBiliImageUrl(value));
  // Observed on the live 2026-11-11 draft: Bilibili rewrites the uploaded cover
  // from i0.hdslb.com to article.biliimg.com without changing its BFS object path.
  // Keep the complete path/query, including resize suffixes; do not equate every
  // allowed hostname, image extension, or different transform with this object.
  if (url.hostname === 'i0.hdslb.com' || url.hostname === 'article.biliimg.com') url.hostname = 'i0.hdslb.com';
  return url.href;
}

function paragraphFormat(value) {
  const format = {...(value || {})};
  // Protobuf/default-field changes actually observed in live-draft-content.json.
  if (format.align === 0) delete format.align;
  if (format.indent && typeof format.indent === 'object' && !Array.isArray(format.indent) && Object.keys(format.indent).length === 0) delete format.indent;
  return stable(format);
}

function paletteColor(value = {}) {
  const light = color(value.color), dark = color(value.dark_color) || light;
  // The inspected public editor bundle has Ba0=#000000 in both palette maps.
  // A white colorValue plus Ba0 is NOT an equivalent white: the theme overrides
  // it. Resolve this proven palette entry, retaining unknown themes for checking.
  if (value.bili_theme === 'Ba0') return {light:'000000', dark:'000000', theme:''};
  return {light, dark, theme:value.bili_theme || ''};
}

function backgroundStyle(value) {
  if (!value) return null;
  const result = {...value};
  if (value.color && typeof value.color === 'object') result.color = paletteColor(value.color);
  return stable(result);
}

function canonicalSourceLink(node) {
  const link={...(node.link||{})},style={...(link.style||{})};
  const url=normalizeSourceLink(link.link);
  if(!url)throw new Error('原文出处链接无效');
  // Official convertTiptapToLinkNode creates these defaults; compare their
  // rendered meaning while retaining unknown/non-default business fields.
  for(const name of ['bold','italic','underline','strikethrough'])style[name]=!!style[name];
  style.font_size=Number(style.font_size||0);style.font_level=style.font_level||'regular';
  const result={...link,link:url,show_text:link.show_text??'',link_type:Number(link.link_type),
    icon:link.icon||'',icon_suffix:link.icon_suffix||'',biz_id:link.biz_id||'',pics:link.pics||[],
    style:stable(style),bg_style:backgroundStyle(link.bg_style)};
  const extra={...node};delete extra.node_type;delete extra.link;
  return {type:4,link:stable(result),extra:stable(extra)};
}

function canonicalContent(content) {
  const listHashes = new Set((content?.paragraphs || []).filter(para => [5,6].includes(Number(para.para_type)))
    .map(para => para.format?.combine_hash).filter(hash => typeof hash === 'string' && hash));
  const listGroups = new Map();
  return (content?.paragraphs || []).map(para => {
    const base = {type: Number(para.para_type), format: paragraphFormat(para.format)};
    // The live Q&A readback and the official CombineHashContext show that the
    // editor regenerates list IDs. Compare the grouping relation, not the
    // opaque ID: splitting, merging or moving members still changes this map.
    const hash = base.format.combine_hash;
    if ([1,5,6].includes(base.type) && listHashes.has(hash)) {
      if (!listGroups.has(hash)) listGroups.set(hash, listGroups.size + 1);
      base.format.combine_hash = `list-group-${listGroups.get(hash)}`;
    }
    if (para.text) base.text = (para.text.nodes || []).map(node => {
      if (node.node_type === 1) {
        const word = node.word || {};
        return {type: 1, text: word.words ?? '', font: Number(word.font_size || 17), level: word.font_level || 'regular', colors: paletteColor(word),
          style: ['bold', 'italic', 'underline', 'strikethrough'].map(key => !!word.style?.[key]), background: backgroundStyle(word.bg_style)};
      }
      if (node.node_type === 2) return {type:2,text:node.emote?.raw_text||'',background:backgroundStyle(node.emote?.bg_style)};
      if (node.node_type === 4) return canonicalSourceLink(node);
      if (node.node_type === 5) return {type: 5, latex: node.formula?.latex_content || ''};
      return stable(node);
    });
    if (para.pic) {
      base.pictureStyle = Number(para.pic.style ?? 0);
      base.pictures = (para.pic.pics || []).map(pic => ({url: imageIdentity(pic.url), width: Number(pic.width), height: Number(pic.height), comment: pic.comment || ''}));
    }
    if (para.line) base.line = stable(para.line);
    if (para.code) {
      const code = {...para.code};
      // The live Q&A API omits the protobuf default lang:"". Nonempty language
      // values and the complete code content (including newlines) stay strict.
      if (code.lang === '') delete code.lang;
      base.code = stable(code);
    }
    return base;
  });
}

/** Readback checks native text, native formulas, styles, image order, and settings. */
export function verifyDraft(expected, draft) {
  const arg = expected.arg || expected;
  const issues = [];
  if (!draft || typeof draft !== 'object') return {ok: false, issues: ['B 站未返回可核对的草稿内容。']};
  if (draft.title !== arg.title) issues.push('标题与保存内容不一致。');
  if (Number(draft.original) !== arg.original) issues.push('原创声明未按设置保留。');
  const actualCollection = Number(draft.list?.id ?? draft.list_id ?? 0);
  if (actualCollection !== arg.list_id) issues.push('文集未按设置保留。');
  // The current draft editor's custom-cover checkbox derives from image_urls.
  // An automatic article preview cover is not evidence that this setting is on.
  const cover = draft.image_urls?.[0];
  if (arg.image_urls?.[0]) {
    try { if (imageIdentity(cover) !== imageIdentity(arg.image_urls[0])) issues.push('自定义封面未按设置保留。'); }
    catch { issues.push('自定义封面缺失或地址无效。'); }
  } else if (cover) issues.push('已关闭自定义封面，但 B 站草稿仍保留旧封面。');
  if (!draft.opus?.content?.paragraphs) issues.push('B 站未返回原生正文，无法验证图片和格式。');
  else {
    try {
      const wanted = canonicalContent(arg.opus.content), actual = canonicalContent(draft.opus.content);
      if (JSON.stringify(wanted) !== JSON.stringify(actual)) {
        issues.push('B 站保存后的正文、图片顺序、公式或文字样式发生变化，请打开草稿核对。');
        const fonts = [], paletteChanges = [], captionChanges = [], sourceLinkChanges = [];
        for (let p=0;p<Math.min(wanted.length,actual.length);p++) {
          const beforePictures = wanted[p].pictures || [], afterPictures = actual[p].pictures || [];
          for (let n=0;n<Math.max(beforePictures.length,afterPictures.length);n++) {
            if ((beforePictures[n]?.comment || '') !== (afterPictures[n]?.comment || '')) captionChanges.push(p+1);
          }
          const before=wanted[p].text || [], after=actual[p].text || [];
          if(JSON.stringify(before.filter(node=>node.type===4))!==JSON.stringify(after.filter(node=>node.type===4)))sourceLinkChanges.push(p+1);
          for (let n=0;n<Math.min(before.length,after.length);n++) {
            if(before[n].type!==1 || after[n].type!==1 || before[n].text!==after[n].text) continue;
            if(before[n].font!==after[n].font || before[n].level!==after[n].level) fonts.push({paragraph:p+1,from:before[n].font,to:after[n].font});
            if(JSON.stringify(before[n].colors)!==JSON.stringify(after[n].colors)) paletteChanges.push(p+1);
          }
        }
        if(fonts.length) issues.push(`${fonts.length} 处文字字号发生变化（${fonts.slice(0,3).map(item=>`第 ${item.paragraph} 段 ${item.from}→${item.to}`).join('、')}${fonts.length>3?'…':''}）。`);
        if(paletteChanges.length) issues.push(`${paletteChanges.length} 处文字颜色或 B 站主题色发生变化（第 ${[...new Set(paletteChanges)].slice(0,5).join('、')} 段），请检查明暗模式下的显示。`);
        if(captionChanges.length) issues.push(`${captionChanges.length} 处图片注释发生变化（第 ${[...new Set(captionChanges)].slice(0,5).join('、')} 段），请检查图注是否完整并对应正确图片。`);
        if(sourceLinkChanges.length)issues.push(`原文出处链接的地址、文字或样式发生变化（第 ${sourceLinkChanges.slice(0,5).join('、')} 段），请检查链接是否仍可点击并指向原文。`);
      }
    } catch { issues.push('保存后的正文包含无法核对的图片或原文出处链接地址。'); }
  }
  return {ok: issues.length === 0, issues};
}

/** Parse GIF structure instead of counting raw separator bytes in compressed data. */
export function inspectGif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(ascii(0, 6))) throw new BilibiliError('动图文件不是有效 GIF，已停止上传。');
  let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let pendingDelay = 0;
  const delays = [];
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length) return;
      offset += length;
      if (offset > bytes.length) throw new BilibiliError('GIF 文件不完整。');
    }
    throw new BilibiliError('GIF 文件不完整。');
  };
  let finished = false;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) { finished = true; break; }
    if (block === 0x21) {
      const kind = bytes[offset++];
      if (kind === 0xf9) {
        if (bytes[offset] !== 4 || offset + 6 > bytes.length) throw new BilibiliError('GIF 控制信息损坏。');
        pendingDelay = (bytes[offset + 2] | bytes[offset + 3] << 8) * 10;
      }
      skipBlocks();
    } else if (block === 0x2c) {
      if (offset + 9 > bytes.length) throw new BilibiliError('GIF 图片数据不完整。');
      const packed = bytes[offset + 8];
      offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      offset++; // LZW minimum code size.
      skipBlocks();
      delays.push(pendingDelay);
      pendingDelay = 0;
    } else throw new BilibiliError('GIF 数据结构无法识别。');
  }
  if (!finished || !delays.length) throw new BilibiliError('GIF 文件缺少完整画面。');
  return {frames: delays.length, delays, durationMs: delays.reduce((sum, delay) => sum + delay, 0)};
}

async function sniffImage(blob) {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const starts = values => values.every((value, i) => head[i] === value);
  if (starts([0x47, 0x49, 0x46, 0x38])) return {mime: 'image/gif', extension: 'gif'};
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return {mime: 'image/png', extension: 'png'};
  if (starts([0xff, 0xd8, 0xff])) return {mime: 'image/jpeg', extension: 'jpg'};
  if (String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP') return {mime: 'image/webp', extension: 'webp'};
  throw new BilibiliError('图片不是可识别的 PNG、JPEG、GIF 或 WebP；不会将网页错误页当图片上传。');
}

async function browserCookie() {
  const cookie = await chrome.cookies.get({url: 'https://www.bilibili.com/', name: 'bili_jct'});
  return cookie?.value || '';
}

export function createBilibiliClient({fetchImpl = globalThis.fetch?.bind(globalThis), getCookie = browserCookie, timeoutMs = 30000} = {}) {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`https://api.bilibili.com${path}`, {
        credentials: 'include', ...options,
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) { throw new BilibiliError('连接 B 站失败或超时。请检查登录及网络后重试。', {operation: path.split('?')[0], cause}); }
    if (!response.ok) throw new BilibiliError(`B 站返回 HTTP ${response.status}，请稍后重试。`, {operation: path.split('?')[0]});
    let result;
    try { result = await response.json(); }
    catch (cause) { throw new BilibiliError('B 站未返回有效数据，可能需要在网页完成登录或验证。', {cause}); }
    if (result.code !== 0) {
      const tip = result.code === -101 ? '请先在 Edge 登录 B 站。' : result.code === -111 ? 'B 站登录状态已变化，请刷新登录后重试。' : `B 站操作失败：${result.message || result.msg || '未知错误'}（${result.code}）`;
      throw new BilibiliError(tip, {code: result.code, operation: path.split('?')[0]});
    }
    return result.data;
  }
  async function csrf() {
    const token = await getCookie();
    if (!token) throw new BilibiliError('请先在 Edge 登录 B 站，再重新检测登录状态。', {code: -101});
    return token;
  }
  async function getLoginInfo() {
    const data = await request(BILIBILI_ENDPOINTS.login);
    if (!data?.isLogin) throw new BilibiliError('请先在 Edge 登录 B 站。', {code: -101});
    await csrf();
    return {isAuthenticated: true, userId: String(data.mid), username: data.uname, avatar: data.face};
  }
  async function listCollections() {
    const data = await request(BILIBILI_ENDPOINTS.collections);
    if (!Array.isArray(data?.lists)) throw new BilibiliError('B 站文集返回格式已变化，请在 B 站草稿中手动选择文集。');
    return data.lists.map(item => ({id: numericId(item.id, '文集编号'), name: String(item.name || ''), count: Number(item.total || 0)}));
  }
  async function validateSourceLinks(urls) {
    if(!Array.isArray(urls)||urls.some(url=>!normalizeSourceLink(url)))throw new BilibiliError('原文出处链接清单无效。');
    const sources=[...new Set(urls.map(normalizeSourceLink))],result={accepted:[],rejected:[],failed:[]};
    // The official link ValidationQueue sends at most 50 URLs per batch. Only
    // marked citation URLs reach here; no request is made to the source host.
    for(let index=0;index<sources.length;index+=50){
      const batch=sources.slice(index,index+50);
      try{
        const token=await csrf();
        const data=await request(`${BILIBILI_ENDPOINTS.sourceLinks}?csrf=${encodeURIComponent(token)}`,{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({raw_texts:batch}),
        });
        const parsed=data?.parsed_items;
        for(const url of batch){
          const item=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.hasOwn(parsed,url)?parsed[url]:null;
          if(!item||!Number.isInteger(item.type)||!Number.isInteger(item.link_type))result.failed.push(url);
          else if(item.type===1&&item.link_type===16)result.accepted.push(url);
          else if(item.type===0)result.rejected.push(url);
          else result.failed.push(url);
        }
      }catch{result.failed.push(...batch);}
    }
    return result;
  }
  async function uploadImage(blob, {filename = 'image', signal, verifyAnimation = true} = {}) {
    if (!(blob instanceof Blob) || blob.size === 0) throw new BilibiliError('图片为空，无法上传。');
    const {mime, extension} = await sniffImage(blob);
    const sourceGif = mime === 'image/gif' ? inspectGif(await blob.arrayBuffer()) : null;
    const name = `${String(filename).replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N}_.-]/gu, '_') || 'image'}.${extension}`;
    const form = new FormData();
    // Relabel MIME only. Never re-encode, draw to canvas, or strip animation frames.
    form.append('file_up', blob.type === mime ? blob : new Blob([blob], {type: mime}), name);
    form.append('biz', 'new_dyn');
    form.append('category', 'daily');
    form.append('csrf', await csrf());
    const data = await request(BILIBILI_ENDPOINTS.upload, {method: 'POST', body: form, signal});
    const result = {
      url: normalizeBiliImageUrl(data?.image_url),
      width: Number(data.image_width), height: Number(data.image_height),
      size: Number(data.image_size ?? data.img_size ?? blob.size / 1024),
      mime, bytes: blob.size, animation: sourceGif,
    };
    if (!(result.width > 0) || !(result.height > 0) || !(result.size > 0)) throw new BilibiliError('B 站上传结果缺少图片尺寸，请重新上传。');
    if (sourceGif && verifyAnimation) {
      let returned;
      try {
        const response = await fetchImpl(result.url, {credentials: 'omit', signal: signal || AbortSignal.timeout(timeoutMs)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        returned = inspectGif(await response.arrayBuffer());
      } catch (cause) { throw new BilibiliError('动图已上传，但无法验证 B 站返回文件仍是完整 GIF；已停止保存。', {cause}); }
      if (JSON.stringify(sourceGif) !== JSON.stringify(returned)) throw new BilibiliError('B 站返回的 GIF 帧数或播放时长发生变化，已停止保存，避免动图变成静图。');
      result.animationVerified = true;
    }
    return result;
  }
  async function getDraft(draftId) {
    const id = numericId(draftId, '草稿编号');
    const data = await request(`${BILIBILI_ENDPOINTS.view}?article_id=${id}`);
    if (!data?.draft) throw new BilibiliError('草稿读取结果为空。');
    return data.draft;
  }
  async function saveDraft(options) {
    const payload = buildDraftPayload(options);
    const token = await csrf();
    let data;
    try {
      data = await request(`${BILIBILI_ENDPOINTS.save}?csrf=${encodeURIComponent(token)}`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
      });
    } catch (error) {
      if (options.draftId) {
        error.draftId = String(options.draftId);
        error.draftUrl = draftEditorUrl(options.draftId);
      }
      // Network/HTTP/JSON failures cannot prove that the server did not save.
      // Do not automatically retry a create operation with an unknown result.
      if (error.code == null) {
        error.saveUncertain = true;
        error.message = `${error.message} 保存结果暂不确定，请先检查 B 站草稿箱，避免重复创建。`;
      }
      throw error;
    }
    let draftId;
    try { draftId = numericId(data?.article_id, 'B 站返回的草稿编号'); }
    catch (cause) {
      throw new BilibiliError('B 站报告保存成功，但没有返回有效草稿编号。请先检查草稿箱，避免重复创建。', {
        saveUncertain: true, draftId: options.draftId ? String(options.draftId) : undefined,
        draftUrl: options.draftId ? draftEditorUrl(options.draftId) : undefined, cause,
      });
    }
    const draftUrl = draftEditorUrl(draftId);
    let checkpointIssue = '';
    // Let the UI durably store the confirmed ID before the potentially slow readback.
    if (typeof options.onSaved === 'function') {
      try { await options.onSaved({draftId: String(draftId), draftUrl}); }
      catch { checkpointIssue = '草稿已保存，但本地草稿编号备份失败；请记下草稿编号，避免重复创建。'; }
    }
    let draft;
    let verification;
    try {
      draft = await getDraft(draftId);
      verification = verifyDraft(payload, draft);
    } catch (error) {
      // A draft already exists: do not throw a generic failure that encourages duplicates.
      verification = {ok: false, issues: [`草稿已保存，但重新读取校验失败：${error.message}`]};
    }
    if (checkpointIssue) verification = {ok: false, issues: [checkpointIssue, ...verification.issues]};
    return {draftId: String(draftId), draftUrl, verified: verification.ok, verification, draft};
  }
  return {getLoginInfo, listCollections, validateSourceLinks, uploadImage, getDraft, saveDraft};
}
