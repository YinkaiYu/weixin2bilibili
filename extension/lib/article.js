/** Article extraction and loss-aware cleanup. No requests or page scripts are executed. */
const HTML_TAGS = new Set('p div section article main header footer span strong b em i u s strike del sup sub br hr img h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr td th caption colgroup col'.split(' '));
const SVG_TAGS = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs clippath mask lineargradient radialgradient stop title desc'.split(' '));
const MATH_TAGS = new Set('math mrow mi mn mo mtext mspace ms mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd mfenced menclose semantics annotation'.split(' '));
const UNSUPPORTED_MEDIA = new Set('iframe video audio canvas object embed mpvoice qqmusic mp-common-videosnap mp-common-mpaudio mp-common-profile mp-common-product'.split(' '));
const DROP_TAGS = new Set('script style link meta base noscript template form input button select textarea'.split(' '));
const EMPTY_BLOCKS = new Set('p div section article header footer span h1 h2 h3 h4 h5 h6 blockquote li pre'.split(' '));
const STYLE_PROPS = new Set('color background-color background-position background-repeat background-size background-attachment font-weight font-style text-decoration text-decoration-line font-size font-family vertical-align text-align line-height letter-spacing white-space width height min-width min-height max-width max-height box-sizing margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right border border-top border-bottom border-left border-right border-color border-width border-style border-radius display justify-content align-content align-items align-self flex flex-basis flex-grow flex-shrink flex-direction flex-wrap gap row-gap column-gap order'.split(' '));
// Chromium can enumerate expanded longhands even when the original inline style
// used a permitted shorthand. Keep their equivalent forms as well (JSDOM does
// not expand the same declarations during tests).
for (const corner of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) STYLE_PROPS.add(`border-${corner}-radius`);
for (const side of ['top', 'right', 'bottom', 'left']) {
  for (const component of ['width', 'style', 'color']) STYLE_PROPS.add(`border-${side}-${component}`);
}
STYLE_PROPS.add('background-position-x');
STYLE_PROPS.add('background-position-y');
const SVG_ATTRS = new Set('viewbox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-opacity opacity transform font-size font-family text-anchor dominant-baseline dx dy offset stop-color stop-opacity preserveaspectratio'.split(' '));
const MATH_ATTRS = new Set('display mathvariant mathsize mathcolor mathbackground stretchy fence separator form lspace rspace linethickness numalign denomalign rowalign columnalign rowspacing columnspacing notation open close separators encoding'.split(' '));
const IMAGE_ATTRS = new Set('src alt title width height data-type data-formula data-latex data-w data-h data-local-path data-sync-formula-image'.split(' '));
const TRANSPARENT_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
const TRANSPARENT_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const FORMULA_SELECTOR = '[data-formula],[data-latex]';
const IMAGE_SOURCE_ATTRS = ['src', 'data-src', 'data-original', 'data-actualsrc', 'srcset', 'data-srcset', 'data-lazy-src', 'data-url', 'data-back', 'data-croporisrc'];
const EMPTY_IMAGE_METADATA = new Set(['class', 'data-index', 'data-order', 'data-lazy', 'data-loaded', 'data-status', 'data-state', 'data-lazyloaded', 'data-load-status', 'loading', 'decoding', 'fetchpriority']);

function removeHiddenContent(body) {
  let removed = 0;
  // Inspect explicit HTML visibility before sanitizing attributes or cutting the
  // footer. Otherwise a hidden tracking image/heading can become visible content.
  for (const element of [body, ...body.querySelectorAll('*')]) {
    if (element !== body && !body.contains(element)) continue;
    if (!element.hasAttribute('hidden') && element.style?.display.toLowerCase() !== 'none') continue;
    if (element.matches(FORMULA_SELECTOR) || element.querySelector(FORMULA_SELECTOR)) {
      // A declared LaTeX source is semantic content, even when its source carrier
      // is hidden. Keep only formula branches and their styling ancestors; do not
      // expose unrelated hidden text, images, or fallback markup alongside them.
      const retainFormulaBranches = parent => {
        if (parent.matches(FORMULA_SELECTOR)) return;
        for (const child of [...parent.childNodes]) {
          if (child.nodeType === 1 && (child.matches(FORMULA_SELECTOR) || child.querySelector(FORMULA_SELECTOR))) retainFormulaBranches(child);
          else child.remove();
        }
      };
      retainFormulaBranches(element);
      element.removeAttribute('hidden');
      element.style?.removeProperty('display');
    } else {
      if (element === body) element.replaceChildren(); else element.remove();
      removed++;
    }
  }
  return removed;
}

function knownTransparentImage(value) {
  const match = String(value || '').trim().match(/^data:image\/(png|gif);base64,([a-z\d+/=\s]+)$/i);
  if (!match) return false;
  const bytes = match[2].replace(/\s/g, '');
  return bytes === (match[1].toLowerCase() === 'png' ? TRANSPARENT_PIXEL : TRANSPARENT_GIF);
}

function isEmptyWeChatImage(element) {
  if (!/\bwxw-img\b/.test(element.className || '')) return false;
  if (element.matches(FORMULA_SELECTOR) || ['latex'].includes(element.getAttribute('data-type')) || element.getAttribute('type') === 'latex') return false;
  if (['alt', 'title'].some(name => normalizedText(element.getAttribute(name)))) return false;
  // A known original asset or a larger declared intrinsic size signals authored
  // content whose lazy URL may be temporarily missing, not an empty editor shell.
  if (['data-imgfileid', 'data-fileid'].some(name => normalizedText(element.getAttribute(name))) || ['data-w', 'data-h'].some(name => Number(element.getAttribute(name)) > 1)) return false;
  const sources = IMAGE_SOURCE_ATTRS.map(name => element.getAttribute(name)?.trim()).filter(Boolean);
  if (sources.length) {
    // Exact verified transparent bytes plus explicit WeChat placeholder classes.
    // A real lazy source, unknown tiny image, or unmarked data URI is never guessed
    // away. In particular, prefer a data-src photograph over its transparent src.
    return /\b(?:js_img_placeholder|wx_img_placeholder)\b/.test(element.className || '') && sources.every(knownTransparentImage);
  }
  return [...element.attributes].every(attr => EMPTY_IMAGE_METADATA.has(attr.name) || IMAGE_SOURCE_ATTRS.includes(attr.name) || (['alt', 'title', 'style'].includes(attr.name) && !attr.value.trim()));
}

const DECORATION_CONTENT = 'img,svg,math,table,video,audio,iframe,canvas,object,embed,[data-formula],[data-latex]';

function cssColor(value) {
  const text = String(value || '').trim().toLowerCase();
  const named = {black:[0,0,0,1],white:[255,255,255,1],red:[255,0,0,1],blue:[0,0,255,1],green:[0,128,0,1],gray:[128,128,128,1],grey:[128,128,128,1],transparent:[0,0,0,0]};
  if (named[text]) return named[text];
  if (/^#[\da-f]{3}$/i.test(text)) return [...text.slice(1)].map(char=>parseInt(char+char,16)).concat(1);
  if (/^#[\da-f]{6}$/i.test(text)) return [1,3,5].map(start=>parseInt(text.slice(start,start+2),16)).concat(1);
  const rgb = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  return rgb ? [Number(rgb[1]),Number(rgb[2]),Number(rgb[3]),rgb[4]===undefined?1:Number(rgb[4])] : null;
}

function luminance(rgb) {
  const linear = rgb.slice(0,3).map(channel=>{const value=channel/255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;});
  return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722;
}

function blend(foreground, background) {
  return foreground.slice(0,3).map((channel,index)=>channel*foreground[3]+background[index]*(1-foreground[3])).concat(1);
}

function textReadableWithoutImage(element) {
  const walker = element.ownerDocument.createTreeWalker(element,4);
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (!normalizedText(text.textContent)) continue;
    const ancestors = [];
    for (let parent=text.parentElement;parent;parent=parent.parentElement) ancestors.unshift(parent);
    let foreground = [0,0,0,1], background = [255,255,255,1];
    for (const ancestor of ancestors) {
      const color = ancestor.style?.color;
      if (color && !['inherit','currentcolor'].includes(color.toLowerCase())) foreground=cssColor(color);
      const solid = ancestor.style?.backgroundColor;
      if (solid && solid!=='inherit') {
        const parsed=cssColor(solid);
        if (!parsed) return false;
        background=blend(parsed,background);
      }
    }
    if (!foreground) return false;
    const ink=luminance(blend(foreground,background)), paper=luminance(background);
    // Be conservative when the image may supply the contrast for the text.
    if ((Math.max(ink,paper)+0.05)/(Math.min(ink,paper)+0.05)<3) return false;
  }
  return true;
}

function smallBackgroundTile(element) {
  const parts = element.style.backgroundSize.trim().split(/\s+/);
  if (!parts.length || parts.length>2) return false;
  const small = value => {
    const match=value?.match(/^([\d.]+)(px|%)$/);
    return Boolean(match && Number(match[1])>0 && Number(match[1])<=(match[2]==='%'?50:160));
  };
  return small(parts[0]) && (parts.length===1 || parts[1]==='auto' || small(parts[1]));
}

function decorativeBackgroundKind(element) {
  if (element.matches(DECORATION_CONTENT) || element.querySelector(DECORATION_CONTENT)) return '';
  const text=normalizedText(element.textContent);
  if (!text) {
    const dimensions=['width','height'].map(name=>element.style[name].match(/^([\d.]+)px$/));
    const semantic=['alt','title','aria-label'].some(name=>normalizedText(element.getAttribute(name))) || element.getAttribute('role')==='img';
    return !semantic && dimensions.every(match=>match && Number(match[1])>0 && Number(match[1])<=48) ? 'empty' : '';
  }
  const label = /^[qa]\d{1,4}[.:：、)）]?$/i.test(text);
  const shortHeading = /^h[1-6]$/.test(element.localName) && text.length<=40 && smallBackgroundTile(element);
  const textureCard = text.length>=30 && /(?:^|\s)repeat(?:-[xy])?(?:\s|$)/.test(element.style.backgroundRepeat) && smallBackgroundTile(element);
  return (label || shortHeading || textureCard) && textReadableWithoutImage(element) ? 'background' : '';
}

function clearDecorativeBackground(element) {
  // Keep the solid background at every ancestor level: native text can inherit
  // it as a highlight, which is essential for white labels on colored cards.
  const solid=element.style.backgroundColor;
  for (const property of Array.from(element.style)) if (property==='background' || property.startsWith('background-')) element.style.removeProperty(property);
  if (solid) element.style.backgroundColor=solid;
  element.removeAttribute('data-lazy-bgimg');
  element.removeAttribute('data-sync-background-url');
  if (element.getAttribute('data-sync-unsupported')==='CSS 背景图') element.removeAttribute('data-sync-unsupported');
}

function parseDocument(html, options = {}) {
  const Parser = options.document?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error('文章解析需要浏览器 DOMParser。');
  return new Parser().parseFromString(String(html || ''), 'text/html');
}

function normalizedText(value) {
  return String(value || '').replace(/[\s\u200B-\u200D\uFEFF\u00AD]+/g, '').trim();
}

function safeUrl(raw, base = '', { image = false } = {}) {
  if (!raw) return '';
  const value = String(raw).trim();
  if (image && /^localasset:\/\/\/[^\s]+$/i.test(value)) return value;
  if (image && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);(?:base64,|charset=[^,]+,|utf8,)/i.test(value)) return value;
  if (image && /^data:image\/svg\+xml,/i.test(value)) return value;
  try {
    const url = new URL(value, base || undefined);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function localAssetPath(raw) {
  if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return '';
  let path;
  try { path = decodeURIComponent(raw).replace(/\\/g, '/').replace(/^\.\//, ''); } catch { return ''; }
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) return '';
  return path;
}

function localAssetUrl(path) { return `localasset:///${encodeURIComponent(path)}`; }

function inferSavedSource(html) {
  return safeUrl(String(html).match(/<!--\s*saved from url=\(\d+\)(https?:\/\/[^\s<>]+)\s*-->/i)?.[1]);
}

function decodeSourceString(raw, document) {
  const decoded = String(raw || '')
    .replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([/"'\\])/g, '$1')
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  const textarea = document.createElement('textarea');
  textarea.innerHTML = decoded;
  return textarea.value;
}

function scriptStrings(document, keys) {
  const output = [];
  const pattern = new RegExp(`(?<![\\w$])(?:["']?(?:${keys.join('|')})["']?)\\s*[:=]\\s*(["'])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`, 'g');
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    for (const match of text.matchAll(pattern)) output.push(decodeSourceString(match[2], document));
  }
  return output;
}

function extractCover(document, sourceUrl) {
  const candidates = [
    ...scriptStrings(document, ['msg_cdn_url', 'cdn_url', 'cover_img_url', 'cover_url']),
    document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
  ];
  return candidates.map(value => safeUrl(value, sourceUrl, { image: true })).find(Boolean) || '';
}

function extractCollections(document) {
  const names = [];
  const selectors = '#js_album_name, .js_album_title, .album_read_title, .album__name, .album_name_title, .js_album_directory__name, .album_tag_name, [data-album-title], [data-album-name], [data-column-name]';
  for (const element of document.querySelectorAll(selectors)) {
    names.push(element.getAttribute('data-album-title') || element.getAttribute('data-album-name') || element.getAttribute('data-column-name') || element.textContent);
  }
  names.push(...scriptStrings(document, ['album_name', 'album_title', 'column_name']));
  return [...new Set(names.map(value => String(value || '').replace(/^(?:合集|专栏|文集)\s*[:：]\s*/, '').replace(/^#/, '').replace(/\s*[·•]\s*目录\s*$/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()).filter(value => value && value.length <= 80))];
}

function isTailHeading(element) {
  if (element.querySelector('img,svg,math,video,audio')) return false;
  let text = normalizedText(element.textContent).toLowerCase();
  text = text.replace(/^[\-—–·•|｜:：【】\[\]《》「」『』<>()（）]+|[\-—–·•|｜:：【】\[\]《》「」『』<>()（）]+$/g, '');
  return ['上期回顾', '往期回顾', '近期热门文章top10'].includes(text);
}

function trimTail(body) {
  const candidates = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,section,div,span,strong,b')].filter(isTailHeading);
  const found = candidates.find(element => ![...element.querySelectorAll('*')].some(isTailHeading));
  if (!found) return false;
  let boundary = found;
  while (boundary.parentElement && boundary.parentElement !== body && isTailHeading(boundary.parentElement)) boundary = boundary.parentElement;
  const range = body.ownerDocument.createRange();
  range.setStartBefore(boundary);
  range.setEnd(body, body.childNodes.length);
  range.deleteContents();
  return true;
}

function sanitizeStyle(element) {
  const original = element.getAttribute('style') || '';
  element.removeAttribute('style');
  const probe = element.ownerDocument.createElement('span');
  probe.setAttribute('style', original);
  for (const property of Array.from(probe.style)) {
    const value = probe.style.getPropertyValue(property).trim();
    if (property === 'background-image' && element.hasAttribute('data-sync-background-url')) {
      element.style.setProperty('background-image', `url("${element.getAttribute('data-sync-background-url').replace(/"/g, '%22')}")`);
      continue;
    }
    if (!STYLE_PROPS.has(property) || /url\s*\(|expression\s*\(|@import|javascript:|behavior:|var\s*\(/i.test(value)) continue;
    element.style.setProperty(property, value);
  }
  if (!element.getAttribute('style')) element.removeAttribute('style');
}

function summarize(body) {
  const images = [...body.querySelectorAll('img')];
  const formulaNodes = [...body.querySelectorAll('[data-formula],[data-latex]')].filter(node => !node.parentElement?.closest('[data-formula],[data-latex]'));
  return {
    images: images.length,
    gifs: images.filter(img => /gif/i.test(`${img.getAttribute('data-type') || ''} ${img.getAttribute('src') || ''}`)).length,
    formulas: formulaNodes.length + images.filter(img => !img.closest('[data-formula],[data-latex]') && (img.hasAttribute('data-sync-formula-image') || /(?:formula|latex|math|equation)/i.test(img.getAttribute('alt') || ''))).length + [...body.querySelectorAll('math')].filter(node => !node.closest('[data-formula],[data-latex]')).length,
    backgrounds: body.querySelectorAll('[data-sync-background-url]').length,
    superscripts: body.querySelectorAll('sup').length,
    subscripts: body.querySelectorAll('sub').length,
  };
}

function getBlockingIssues(body) {
  const issues = new Set();
  if ([...body.querySelectorAll('svg')].some(node => !node.closest('[data-formula],[data-latex]'))) issues.add('原文含 SVG 图形或公式，需要先转成图片才能可靠同步到 B 站。');
  if ([...body.querySelectorAll('math')].some(node => !node.closest('[data-formula],[data-latex]'))) issues.add('原文含 MathML 公式，需要先转换为 B 站可用的公式或图片。');
  if (body.querySelector('table')) issues.add('原文含表格，B 站的原生排版兼容性需处理后再同步。');
  for (const node of body.querySelectorAll('[data-sync-unsupported]')) issues.add(`原文含暂不支持的 ${node.getAttribute('data-sync-unsupported')} 内容，已保留位置提示，请处理后同步。`);
  if (body.querySelector('[data-sync-background-url]')) issues.add('原文含 CSS 背景图，需要转换对应局部排版后同步。');
  for (const img of body.querySelectorAll('img')) {
    if (!img.getAttribute('src')) issues.add('有图片没有可读取的原始链接，请补充或删除该图片。');
    if (/^data:image\/svg\+xml/i.test(img.getAttribute('src') || '')) issues.add('原文含 SVG 图片，需要先转换成 PNG 等 B 站支持的图片格式。');
    if (/^localasset:/i.test(img.getAttribute('src') || '')) issues.add('有图片只保存在本地资源目录，请选择文章的资源文件夹后继续。');
  }
  return [...issues];
}

export function cleanArticle(html, options = {}) {
  const document = parseDocument(html, options);
  const body = document.body;
  const warnings = [];
  const stats = { removedLinks: 0, removedEmptyBlocks: 0, removedImagePlaceholders: 0, removedEmptySvg: 0, removedTransparentBackgrounds: 0, removedDecorativeBackgrounds: 0, removedSmallDecorations: 0, removedHiddenElements: removeHiddenContent(body), trimmedTail: trimTail(body) ? 1 : 0 };
  if (stats.trimmedTail) warnings.push('已删除回顾／近期热门文章标题及其后面的内容。');

  for (let element of [...body.querySelectorAll('*')]) {
    if (!body.contains(element)) continue;
    let tag = element.localName.toLowerCase();
    if (DROP_TAGS.has(tag)) { element.remove(); continue; }
    if (tag === 'svg' && element.childElementCount === 0 && !normalizedText(element.textContent) && /^0\s+0\s+1\s+1$/.test(element.getAttribute('viewBox') || '')) {
      element.remove(); stats.removedEmptySvg++; continue;
    }
    if (UNSUPPORTED_MEDIA.has(tag)) {
      const placeholder = document.createElement('span');
      placeholder.setAttribute('data-sync-unsupported', tag);
      placeholder.textContent = `[原文含 ${tag} 内容，请处理后同步]`;
      element.replaceWith(placeholder);
      continue;
    }
    if (tag === 'a') {
      stats.removedLinks++;
      const retained = ['style','title','dir','lang','data-formula','data-latex'].filter(name=>element.hasAttribute(name));
      if (!retained.length) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const span = document.createElement('span');
      for (const name of retained) span.setAttribute(name,element.getAttribute(name));
      span.append(...element.childNodes);
      element.replaceWith(span);
      element = span;
      tag = 'span';
    }
    if (!HTML_TAGS.has(tag) && !SVG_TAGS.has(tag) && !MATH_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    if (tag === 'img') {
      // WeChat may attach lazy-loader metadata to its otherwise empty shells.
      // Authored or unknown images with a failed URL remain blockers.
      if (isEmptyWeChatImage(element)) {
        element.remove(); stats.removedImagePlaceholders++; continue;
      }
      const savedPath = localAssetPath(element.getAttribute('src'));
      const isLocal = savedPath && (options.localFile || /(?:^|\/)[^/]*_files\//i.test(savedPath));
      if (isLocal) element.setAttribute('data-local-path', savedPath);
      const source = element.getAttribute('data-src') || element.getAttribute('data-original') || element.getAttribute('data-actualsrc') || element.getAttribute('src');
      const resolved = isLocal && source === element.getAttribute('src') ? localAssetUrl(savedPath) : safeUrl(source, options.sourceUrl, { image: true });
      if (resolved) element.setAttribute('src', resolved); else element.removeAttribute('src');
      const formulaClass = /(?:formula|latex|math|equation)/i.test(element.className || '');
      // A class or alt text identifies an image, not trustworthy LaTeX source.
      if (formulaClass) element.setAttribute('data-sync-formula-image', 'true');
    }
    const backgroundValue = element.style?.backgroundImage || '';
    const lazyBackground = element.getAttribute('data-lazy-bgimg')?.trim() || '';
    // Resolve lazy metadata before classifying decoration so saved and already-
    // loaded articles make the same content-first decision.
    const backgroundRaw = lazyBackground || backgroundValue.match(/^url\(["']?(.*?)["']?\)$/i)?.[1];
    if (backgroundRaw) {
      const decoration = decorativeBackgroundKind(element);
      if (decoration==='empty') {
        element.remove(); stats.removedSmallDecorations++; continue;
      } else if (decoration==='background') {
        clearDecorativeBackground(element); stats.removedDecorativeBackgrounds++;
      } else if (backgroundRaw.endsWith(`;base64,${TRANSPARENT_PIXEL}`)) {
        element.style.removeProperty('background-image'); stats.removedTransparentBackgrounds++;
      } else {
        const safeBackground = safeUrl(backgroundRaw, options.sourceUrl, {image: true});
        if (safeBackground) element.setAttribute('data-sync-background-url', safeBackground);
        else element.setAttribute('data-sync-unsupported', 'CSS 背景图');
      }
    }
    sanitizeStyle(element);
    for (const attribute of [...element.attributes]) {
      const key = attribute.name.toLowerCase();
      let keep = key === 'style' || key === 'title' || key === 'dir' || key === 'lang';
      if (tag === 'img' && IMAGE_ATTRS.has(key)) keep = true;
      if (SVG_TAGS.has(tag) && SVG_ATTRS.has(key)) keep = true;
      if (MATH_TAGS.has(tag) && MATH_ATTRS.has(key)) keep = true;
      if (['td', 'th'].includes(tag) && ['colspan', 'rowspan'].includes(key)) keep = true;
      if (tag === 'ol' && key === 'start') keep = true;
      if (key === 'data-sync-unsupported') keep = true;
      if (['data-formula', 'data-latex', 'data-sync-background-url'].includes(key)) keep = true;
      if (key.startsWith('on') || /javascript:|expression\s*\(/i.test(attribute.value) && key !== 'src' || /url\s*\(/i.test(attribute.value) && !['src','style'].includes(key)) keep = false;
      if (!keep) element.removeAttribute(attribute.name);
    }
  }

  const walker = document.createTreeWalker(body, 4 /* SHOW_TEXT */);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    if (node.parentElement?.closest('svg, math')) continue;
    node.textContent = node.textContent.replace(/(?:https?:\/\/|www\.)[^\s<>"“”‘’\u3000]+/gi, match => {
      stats.removedLinks++;
      const trailing = match.match(/[，。！？、；：）】》」』,.!?;:]+$/)?.[0] || '';
      return trailing;
    });
    node.textContent = node.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  // Work from leaves to roots so nested empty WeChat spacer sections also disappear.
  for (const element of [...body.querySelectorAll('*')].reverse()) {
    if (EMPTY_BLOCKS.has(element.localName) && !normalizedText(element.textContent) && !element.querySelector('img,svg,math,hr,[data-sync-unsupported],[data-sync-background-url]') && !element.matches('[data-sync-background-url],[data-formula],[data-latex]')) {
      element.remove(); stats.removedEmptyBlocks++;
    }
  }
  // Preserve line breaks within a text paragraph, while collapsing blank lines.
  for (const br of [...body.querySelectorAll('br')]) {
    let previous = br.previousSibling;
    while (previous?.nodeType === 3 && !normalizedText(previous.textContent)) previous = previous.previousSibling;
    if (previous?.nodeType === 1 && previous.localName === 'br') { br.remove(); stats.removedEmptyBlocks++; }
  }
  if (stats.removedLinks) warnings.push(`已清除 ${stats.removedLinks} 处外链（保留链接文字和图片）。`);
  if (stats.removedImagePlaceholders) warnings.push(`已清除 ${stats.removedImagePlaceholders} 个没有内容的微信图片占位标签。`);
  if (stats.removedDecorativeBackgrounds || stats.removedSmallDecorations) warnings.push(`已略去 ${stats.removedDecorativeBackgrounds+stats.removedSmallDecorations} 处装饰背景，保留正文文字和内容图片。`);
  const localAssets = [...body.querySelectorAll('img[data-local-path]')].map(img => ({sourceUrl: img.getAttribute('src'), localPath: img.getAttribute('data-local-path')}));
  return { html: body.innerHTML.trim(), warnings, blockingIssues: getBlockingIssues(body), stats: { ...stats, ...summarize(body) }, localAssets };
}

export function parseArticle(html, options = {}) {
  const document = parseDocument(html, options);
  const savedSource = inferSavedSource(html);
  options = {...options, sourceUrl: options.sourceUrl || savedSource, localFile: options.localFile || Boolean(savedSource)};
  const root = document.querySelector('#js_content') || document.querySelector('article') || document.querySelector('main') || document.body;
  const title = (document.querySelector('#activity-name')?.textContent || document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || '').trim();
  const cleaned = cleanArticle(root.innerHTML, options);
  if (!document.querySelector('#js_content')) cleaned.warnings.unshift('未找到微信公众号正文容器，已使用文章区域提取，请核对正文范围。');
  return {
    title,
    ...cleaned,
    coverUrl: extractCover(document, options.sourceUrl),
    collectionNames: extractCollections(document),
    sourceUrl: options.sourceUrl || '',
  };
}

/** Inspect without changing text; callers can use blockers before any upload. */
export function inspectArticle(html, options = {}) {
  const document = parseDocument(html, options);
  return { stats: summarize(document.body), blockingIssues: getBlockingIssues(document.body), warnings: [] };
}

/** Map original image URLs to uploaded Bilibili URLs, keeping inline order. */
export function rewriteImageSources(html, mapping, options = {}) {
  const document = parseDocument(html, options);
  for (const img of document.body.querySelectorAll('img')) {
    const source = img.getAttribute('src') || '';
    const replacement = mapping instanceof Map ? mapping.get(source) : mapping[source];
    if (replacement) img.setAttribute('src', typeof replacement === 'string' ? replacement : replacement.url);
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
  }
  return document.body.innerHTML;
}
