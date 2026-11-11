/**
 * Small, original HTML -> Bilibili Opus converter. Wire shapes were inspected in
 * the public read-editor bundle on 2026-11-11; see docs/bilibili-protocol.md.
 * This module never downloads content, uploads, or publishes anything.
 */
import {normalizeSourceLink} from './source-links.js';

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'UL', 'OL', 'LI', 'PRE', 'HR']);
const UNSUPPORTED = new Set(['SVG', 'MATH', 'TABLE', 'VIDEO', 'AUDIO', 'IFRAME', 'CANVAS', 'OBJECT', 'EMBED']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
// The current native editor disables arbitrary fontSize. Paragraph text supports
// only 13/small and 17/regular; the other three levels belong to whole headings.
const HEADINGS = [{ size: 24, level: 'xxLarge' }, { size: 22, level: 'xLarge' }, { size: 20, level: 'large' }];
const HTML_HEADING_SIZES = [24, 22, 20, 18, 16, 14];
// Official CaptionManager and normalizeImageCaption use String.slice(0, 100).
// Keep longer text as a paragraph instead of allowing native editing to cut it.
const IMAGE_CAPTION_MAX_LENGTH = 100;
const ADAPTED_HEADING = Symbol('adapted-heading');
const MIN_TEXT_CONTRAST = 4.5;
const NATIVE_PAGE_COLOR = [255,255,255,1];

function colorValue(value) {
  const v = String(value || '').trim();
  if (!v || v === 'inherit' || v === 'initial') return '';
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m && (m[4] === undefined || Number(m[4]) === 1)) return `#${m.slice(1, 4).map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  if (/^#[\da-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('');
  return v;
}

function stylesFor(el, parent) {
  const style = { ...parent };
  if (!el || el.nodeType !== 1) return style;
  const css = el.style || {};
  const tag = el.tagName.toUpperCase();
  if (/^H[1-6]$/.test(tag)) {
    style.size = HTML_HEADING_SIZES[Number(tag[1]) - 1];
    style.bold = true;
  }
  if (tag === 'STRONG' || tag === 'B') style.bold = true;
  if (tag === 'EM' || tag === 'I') style.italic = true;
  if (tag === 'U') style.underline = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') style.strikethrough = true;
  if (tag === 'MARK') style.background = '#ffff00';
  if (css.fontWeight) style.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600;
  if (css.fontStyle) style.italic = css.fontStyle === 'italic' || css.fontStyle === 'oblique';
  const decoration = css.textDecorationLine || css.textDecoration;
  if (decoration) {
    style.underline = decoration.includes('underline');
    style.strikethrough = decoration.includes('line-through');
  }
  if (css.color && css.color !== 'inherit') style.color = colorValue(css.color);
  if (css.backgroundColor && !['inherit','initial','unset','transparent'].includes(css.backgroundColor) && !/^rgba\([^)]*,\s*0\s*\)$/i.test(css.backgroundColor)) {
    style.background = colorValue(css.backgroundColor);
    // A block's white paper on the default/white page is not an inline
    // highlight. Keep the provenance: a white span, or white over a colored
    // ancestor, is meaningful styling and must not be silently discarded.
    style.pageBackground = /^(?:#ffffff|white)$/i.test(style.background) && BLOCK.has(tag) && (!parent.background || parent.pageBackground);
  }
  if (el[ADAPTED_HEADING]) { style.background = ''; style.pageBackground = false; }
  const font = String(css.fontSize || '').match(/^([\d.]+)(px|pt|em|rem|%)$/i);
  if (font) {
    const n = Number(font[1]);
    const unit = font[2].toLowerCase();
    style.size = unit === 'px' ? n : unit === 'pt' ? n * 4 / 3 : unit === '%' ? (parent.size || 17) * n / 100 : unit === 'em' ? (parent.size || 17) * n : n * 17;
  }
  if (css.textAlign) style.align = css.textAlign;
  return style;
}

function nativeColor(value) {
  // Theme variables take precedence over colorValue in native rendering. Select
  // the official white swatch explicitly instead of relying on case-sensitive
  // palette inference, including the editor's corresponding dark theme color.
  if (/^(?:#ffffff|white)$/i.test(value || '')) return { color: '#ffffff', dark_color: '#17181A', bili_theme: 'Wh0' };
  return { color: value || '', dark_color: '' };
}

function wordNode(text, style) {
  const word = {
    words: text,
    font_size: Number.isFinite(style.size) && style.size > 0 ? style.size : 17,
    font_level: 'regular',
    ...nativeColor(style.color),
    style: Object.fromEntries(['bold', 'italic', 'strikethrough', 'underline'].filter(k => style[k]).map(k => [k, true]))
  };
  if (style.background && !style.pageBackground) word.bg_style = { style: 1, color: nativeColor(style.background) };
  return { node_type: 1, word };
}

function latexEscape(text) {
  const escaped = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
  return String(text).replace(/[\\{}%$&#_^~]/g, c => escaped[c]);
}

function latexText(text, style = {}) {
  let out = `\\text{${latexEscape(text)}}`;
  if (style.bold) out = `\\boldsymbol{${out}}`;
  if (style.italic) out = `\\mathit{${out}}`;
  if (style.underline) out = `\\underline{${out}}`;
  if (safeLatexColor(style.color)) out = `\\color{${style.color}}{${out}}`;
  return out;
}

// Native text accepts CSS color strings, but TeX color arguments do not accept
// arbitrary CSS such as rgba(...), var(...), or CSS eight-digit alpha hex.
function safeLatexColor(color) { return Boolean(color) && /^(?:#[0-9a-f]{6}|#[0-9a-f]{3}|[a-z]+)$/i.test(color); }

function explicitLatex(el) {
  if (el.nodeType !== 1) return null;
  let text = el.getAttribute('data-formula') || el.getAttribute('data-latex');
  const declared = el.getAttribute('type') === 'latex' || el.getAttribute('data-type') === 'latex';
  if (!text && declared) text = el.getAttribute('alt');
  if (!text && !declared) return null;
  text = text || '';
  if (/%[\da-f]{2}/i.test(text)) {
    try { text = decodeURIComponent(text); } catch { /* Keep literal percent expressions. */ }
  }
  return text;
}

function nativeImageUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['hdslb.com', 'biliimg.com'].some(d => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch { return false; }
}

function simpleFormat(style, el) {
  const format = {};
  if (style.align && style.align !== 'justify') format.align = ({ left: 0, center: 1, right: 2 })[style.align] ?? 0;
  return format;
}

function preformattedText(el) {
  const clone = el.cloneNode(true);
  for (const br of clone.querySelectorAll('br')) br.replaceWith(el.ownerDocument.createTextNode('\n'));
  return clone.textContent || '';
}

function questionNavigationLines(el) {
  const code = el.querySelector('code') || el;
  if (/(?:language|lang)-[\w+-]+/.test(code.className || '') || code.querySelector('img,svg,math,table,[data-formula],[data-latex]')) return null;
  const breaks = [...code.querySelectorAll('br')];
  if (breaks.length < 2) return null;
  const lines = [];
  let previous = null;
  for (const next of [...breaks, null]) {
    const range = el.ownerDocument.createRange();
    if (previous) range.setStartAfter(previous); else range.setStart(code, 0);
    if (next) range.setEndBefore(next); else range.setEnd(code, code.childNodes.length);
    const fragment = range.cloneContents();
    const text = (fragment.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) lines.push({fragment, text});
    previous = next;
  }
  // The source uses PRE for a styled article directory, not executable code.
  // Require the observed heading and a consecutive question sequence so genuine
  // code blocks and arbitrary prose keep their existing treatment.
  if (lines.length < 3 || lines[0].text !== '问答导航' || !lines.slice(1).every((line, index) => new RegExp(`^Q${index + 1}\\s+\\S`).test(line.text))) return null;
  return {code, lines};
}

function rgbaColor(value) {
  const text = colorValue(value).toLowerCase();
  if (text === 'white') return [...NATIVE_PAGE_COLOR];
  if (text === 'black') return [0,0,0,1];
  if (text === 'transparent') return [0,0,0,0];
  const hex = text.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i);
  if (hex) return [...hex.slice(1,4).map(v=>parseInt(v,16)),hex[4]?parseInt(hex[4],16)/255:1];
  const rgb = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (rgb) return [...rgb.slice(1,4).map(v=>Math.min(255,Number(v))),rgb[4]===undefined?1:Number(rgb[4])];
  return null;
}

function luminance(color) {
  const channels = color.slice(0,3).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
  return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
}
function composite(foreground,background) { return foreground.slice(0,3).map((v,i)=>v*foreground[3]+background[i]*(1-foreground[3])).concat(1); }
function contrast(a,b) { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
function sameColor(a,b) { return a && b && a.every((value,index)=>value===b[index]); }
function visibleText(node) { return (node.textContent||'').replace(/\s+/g,' ').trim(); }
function paintedBackground(element) {
  const css=element.style||{},raw=css.backgroundColor||'';
  const image=Boolean(css.backgroundImage&&!['none','initial','unset'].includes(css.backgroundImage));
  const color=element.tagName==='MARK'&&!raw?[255,255,0,1]:rgbaColor(raw);
  const painted=image||Boolean(color?color[3]>0:raw&&!['initial','unset','inherit'].includes(raw));
  return {painted,image,color};
}
function ancestorsOf(element) { const result=[];for(let p=element.parentElement;p;p=p.parentElement)result.unshift(p);return result; }
function textRuns(element,inherited={}) {
  const result=[];
  function visit(node,carry) {
    if(node.nodeType===3) {if(node.textContent.trim())result.push({element:node.parentElement,style:carry});return;}
    if(node.nodeType!==1||SKIP.has(node.tagName))return;
    const style=stylesFor(node,carry);
    for(const child of node.childNodes)visit(child,style);
  }
  visit(element,inherited);return result;
}
function pageBackdrop(element) {
  let background=[...NATIVE_PAGE_COLOR];
  for(const ancestor of ancestorsOf(element)) {
    const paint=paintedBackground(ancestor);
    if(paint.image||/var\s*\(/i.test(ancestor.style.background)||ancestor.style.opacity&&Number(ancestor.style.opacity)!==1)return null;
    if(paint.painted) {if(!paint.color)return null;background=composite(paint.color,background);}
  }
  return background;
}

/** Ancestor paint composited onto the native white page; excludes the element's own paint. */
export function getCompositePageBackground(element) {
  const color=pageBackdrop(element);
  return color?'#'+color.slice(0,3).map(channel=>Math.round(channel).toString(16).padStart(2,'0')).join(''):null;
}

function editableHeadingColor(element) {
  const paint=paintedBackground(element);
  if(!paint.color||paint.color[3]!==1||paint.image)return null;
  const text=visibleText(element);
  if(!text||[...text].length>120)return null;
  const descendants=[element,...element.querySelectorAll('*')];
  if(descendants.some(el=>UNSUPPORTED.has(el.tagName)||['IMG','A','SUP','SUB','BR','MARK','UL','OL','LI','FIGURE','FIGCAPTION','PRE','CODE','BLOCKQUOTE'].includes(el.tagName)||
      explicitLatex(el)!==null||el.hasAttribute('data-sync-unsupported')||el.hasAttribute('data-wb-unsupported')||
      el.style.opacity&&Number(el.style.opacity)!==1||el.style.mixBlendMode&&el.style.mixBlendMode!=='normal'))return null;
  const semantic=/^H[1-6]$/.test(element.tagName)||[...element.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(el=>visibleText(el)===text);
  const badge=['inline-block','inline-flex'].includes(element.style.display)||['fit-content','max-content'].includes(element.style.width);
  if(!semantic&&!badge)return null;
  // A compact badge is a heading only when it occupies its own text block;
  // never recolor an emphasized phrase embedded in a body sentence.
  let line=element.parentElement;
  while(line&&line.tagName!=='BODY'&&!BLOCK.has(line.tagName))line=line.parentElement;
  if(!semantic&&line&&line.tagName!=='BODY'&&visibleText(line)!==text)return null;
  if(!semantic&&line?.tagName==='BODY') {
    let branch=element;while(branch.parentElement!==line)branch=branch.parentElement;
    for(const direction of ['previousSibling','nextSibling']) {
      for(let sibling=branch[direction];sibling;sibling=sibling[direction]) {
        if(sibling.nodeType===1&&BLOCK.has(sibling.tagName)&&!['inline','inline-block','inline-flex'].includes(sibling.style.display))break;
        if(visibleText(sibling)||sibling.nodeType===1&&(sibling.matches('img,svg,math')||sibling.querySelector('img,svg,math')))return null;
      }
    }
  }
  const inherited=ancestorsOf(element).reduce((style,parent)=>stylesFor(parent,style),{}),runs=textRuns(element,inherited);
  const blocks=new Set(runs.map(run=>{let p=run.element;while(p!==element&&!BLOCK.has(p.tagName))p=p.parentElement;return p;}));
  if(!runs.length||blocks.size!==1||!runs.every(run=>run.style.bold))return null;
  const foreground=rgbaColor(runs[0].style.color);
  if(!foreground||foreground[3]!==1||luminance(foreground)<.5||!runs.every(run=>sameColor(rgbaColor(run.style.color),foreground)))return null;
  if(descendants.some(el=>{const local=paintedBackground(el);return local.image||local.painted&&!sameColor(local.color,paint.color);}))return null;
  const page=pageBackdrop(element);
  if(!page||contrast(foreground,paint.color)<MIN_TEXT_CONTRAST||contrast(paint.color,page)<MIN_TEXT_CONTRAST||contrast(paint.color,NATIVE_PAGE_COLOR)<MIN_TEXT_CONTRAST)return null;
  return '#'+paint.color.slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
}

function isScriptElement(element) {
  return ['SUP','SUB'].includes(element.tagName)||['super','sub'].includes(element.style.verticalAlign);
}
function precedingScriptBase(element) {
  // subSup consumes only the immediately preceding word's trailing Latin,
  // numeric or Greek base. Do not cross paragraph, formula or media boundaries.
  let node=element;
  while(node) {
    if(node.previousSibling) {
      node=node.previousSibling;
      while(node.nodeType===1) {
        if(BLOCK.has(node.tagName)||explicitLatex(node)!==null||isScriptElement(node)||UNSUPPORTED.has(node.tagName)||['IMG','BR'].includes(node.tagName))return null;
        if(SKIP.has(node.tagName)||!node.lastChild)break;
        node=node.lastChild;
      }
      if(node.nodeType===3)return /[A-Za-z0-9\u0370-\u03ff]+$/u.test(node.textContent)?node.parentElement:null;
    } else {
      node=node.parentElement;
      if(!node||BLOCK.has(node.tagName))return null;
    }
  }
  return null;
}
function effectiveBackground(element) {
  const chain=[...ancestorsOf(element),element];
  return {style:chain.reduce((style,node)=>stylesFor(node,style),{}),element:chain.filter(node=>paintedBackground(node).painted).at(-1)||null};
}

/** Read-only plan shared with the local raster layer; DOM references belong to input. */
export function analyzeNativeTextBackgrounds(input) {
  const body=input.body||input,headings=[],unsupported=[];
  for(const element of [body,...body.querySelectorAll('*')]) {
    if(headings.some(item=>item.element.contains(element)))continue;
    const color=editableHeadingColor(element);
    if(color)headings.push({element,color});
  }
  const reported=new Set();
  function report(element,backgroundElement,reason) {
    if(!reported.has(element)){reported.add(element);unsupported.push({element,backgroundElement,reason});}
  }
  function visit(node,carry,backgroundElement) {
    if(node.nodeType===3) {
      if(!node.textContent.trim()||!backgroundElement)return;
      const foreground=rgbaColor(carry.color||'#000000');
      // Full backgrounds become half-height native markers. Light ink that
      // relies on the upper half must be rendered locally or reported, while
      // ordinary dark text/highlights keep their original editable styling.
      const nativeContrast=foreground&&contrast(composite(foreground,NATIVE_PAGE_COLOR),NATIVE_PAGE_COLOR);
      if(nativeContrast>=MIN_TEXT_CONTRAST)return;
      const paint=paintedBackground(backgroundElement);
      if(paint.color&&sameColor(paint.color,NATIVE_PAGE_COLOR)&&!paint.image)return;
      // A muted caption on pale paper gains contrast on white; it does not
      // depend on a dark backdrop. Mid-gray ink on a dark block does depend on
      // it even though its luminance is below the heading's light-ink cutoff.
      const under=paint.color&&!paint.image&&pageBackdrop(backgroundElement);
      if(foreground&&under) {
        const sourceBackground=composite(paint.color,under);
        if(contrast(composite(foreground,sourceBackground),sourceBackground)<=nativeContrast)return;
      }
      const element=node.parentElement;
      report(element,backgroundElement,foreground?'full-background-required':'unresolved-text-color');
      return;
    }
    if(node.nodeType!==1||SKIP.has(node.tagName)||headings.some(item=>item.element===node))return;
    const paint=paintedBackground(node);
    const style=stylesFor(node,carry);
    const owner=paint.painted?node:backgroundElement;
    if(explicitLatex(node)!==null) {
      if(style.background&&!style.pageBackground)report(node,owner,'formula-background');
      return;
    }
    if(isScriptElement(node)) {
      if(style.background&&!style.pageBackground)report(node,owner,'formula-background');
      for(const run of textRuns(node,carry)) {
        if(run.style.background&&!run.style.pageBackground)report(node,effectiveBackground(run.element).element,'formula-background');
      }
      const base=precedingScriptBase(node),baseBackground=base&&effectiveBackground(base);
      if(baseBackground?.style.background&&!baseBackground.style.pageBackground)report(node,baseBackground.element,'formula-background');
    }
    for(const child of node.childNodes)visit(child,style,owner);
  }
  const ancestors=ancestorsOf(body);
  const inherited=ancestors.reduce((style,element)=>stylesFor(element,style),{});
  const inheritedBackground=ancestors.filter(element=>paintedBackground(element).painted).at(-1)||null;
  visit(body,inherited,inheritedBackground);
  return {headings,unsupported};
}

function applyHeadingAdaptations(headings) {
  for(const {element,color} of headings) {
    for(const child of [element,...element.querySelectorAll('*')]) {
      child.style.removeProperty('background');child.style.removeProperty('background-color');
      if(child.style.color)child.style.color=color;
    }
    element.style.color=color;element.style.fontWeight='bold';element[ADAPTED_HEADING]=true;
  }
}

/**
 * @param {string} html Cleaned HTML with uploaded Bilibili image URLs.
 * @param {{images?: Map<string, object>|object, document?: Document, sourceLinkValidation?: {accepted?:string[],rejected?:string[],failed?:string[]}}} options
 * @returns {{content: {paragraphs: object[]}, warnings: string[], blockingIssues: string[], stats: object, summary: string}}
 */
export function toOpus(html, { images = new Map(), document: owner, sourceLinkValidation } = {}) {
  const Parser = owner?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error('需要浏览器 DOMParser 才能转换文章。');
  const doc = new Parser().parseFromString(String(html || ''), 'text/html');
  const paragraphs = [], warnings = [], blockingIssues = [], notices = [], sourceLinks = new Set(), requestedSourceLinks = new Set();
  const acceptedSourceLinks = new Set((sourceLinkValidation?.accepted || []).map(normalizeSourceLink).filter(Boolean));
  const rejectedSourceLinks = new Set((sourceLinkValidation?.rejected || []).map(normalizeSourceLink).filter(Boolean));
  const stats = { paragraphs: 0, images: 0, formulaImages: 0, formulas: 0, superscripts: 0, subscripts: 0, characters: 0 };
  const summaryParts = [];
  let listCounter = 0;
  const adjustedSizes = new Set();
  let adaptedHeadings = false;
  const issue = message => { if (!blockingIssues.includes(message)) blockingIssues.push(message); };
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const inform = message => { if (!notices.some(item => item.message === message)) notices.push({severity:'info',message}); };
  const backgroundPlan=analyzeNativeTextBackgrounds(doc);
  applyHeadingAdaptations(backgroundPlan.headings);
  if(backgroundPlan.headings.length)inform('已将浅色字配深色底的独立标题改为背景色加粗文字，保持原生可编辑。');
  if(backgroundPlan.unsupported.some(item=>item.reason!=='formula-background'))issue('部分浅色文字依赖完整背景，B 站原生半高底纹无法保持可读；请将这些局部转为图片或调整文字与背景后再导入。');
  const lookupImage = url => images instanceof Map ? images.get(url) : images[url];
  const imageCaptions = new Map(), consumedCaptions = new Set();

  function captionText(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return '';
    if (node.tagName === 'BR') return '\n';
    const text = Array.from(node.childNodes).map(captionText).join('');
    return BLOCK.has(node.tagName) ? `\n${text}\n` : text;
  }
  const normalizedCaption = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  function neutralCaptionColor(value) {
    if (!value || /^(?:black|gray|grey|darkgray|darkgrey|dimgray|dimgrey|lightgray|lightgrey|silver)$/i.test(value)) return true;
    const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    const channels = hex ? hex.slice(1).map(v => parseInt(v, 16)) : rgba ? rgba.slice(1, 4).map(Number) : null;
    if (!channels || (rgba?.[4] !== undefined && Number(rgba[4]) < 0.7)) return false;
    const range = Math.max(...channels) - Math.min(...channels), mean = channels.reduce((a, b) => a + b, 0) / 3;
    // Match the parser's ordinary gray-caption classification, including the
    // muted warm/cool grays used by the supplied article templates.
    return (range === 0 && mean < 255) || (range <= 40 && mean >= 90 && mean <= 190);
  }
  function hasCaptionFormatting(el) {
    const ancestors = [];
    for (let parent = el.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
    const inherited = ancestors.reduce((style, parent) => stylesFor(parent, style), {});
    const visit = (node, carry) => {
      const background = carry.background && !/^(?:#ffffff|white)$/i.test(carry.background);
      if (node.nodeType === 3) return Boolean(node.textContent.trim()) && Boolean(carry.bold || carry.italic || carry.underline || carry.strikethrough || background || !neutralCaptionColor(carry.color));
      if (node.nodeType !== 1) return false;
      const style = stylesFor(node, carry);
      return Array.from(node.childNodes).some(child => visit(child, style));
    };
    return visit(el, inherited);
  }
  for (const figure of doc.querySelectorAll('figure')) {
    const captions = Array.from(figure.querySelectorAll('figcaption')).filter(el => el.closest('figure') === figure);
    const pictures = Array.from(figure.querySelectorAll('img')).filter(el => el.closest('figure') === figure && explicitLatex(el) === null);
    // A group caption has no verified one-to-one native image association.
    if (captions.length !== 1 || pictures.length !== 1) continue;
    const caption = captions[0], text = normalizedCaption(captionText(caption));
    if (!text) continue;
    const descendants = [caption, ...caption.querySelectorAll('*')];
    const complex = descendants.some(el => explicitLatex(el) !== null || UNSUPPORTED.has(el.tagName) ||
      ['IMG', 'SUP', 'SUB'].includes(el.tagName) || ['super', 'sub'].includes(el.style.verticalAlign) ||
      (el.tagName === 'A' && el.getAttribute('data-sync-source-link') === 'true') ||
      el.hasAttribute('data-wb-unsupported') || el.hasAttribute('data-sync-unsupported'));
    if (complex || text.length > IMAGE_CAPTION_MAX_LENGTH) {
      imageCaptions.set(pictures[0], null);
      warn(complex ? '含公式、上下标或复杂内容的图注已保留为图片下方正文，避免转为纯文字后丢失含义。' : '超过 100 字符的图注已完整保留为图片下方正文，避免 B 站原生图片注释截断。');
      continue;
    }
    if (hasCaptionFormatting(caption)) {
      imageCaptions.set(pictures[0], null);
      warn('含强调样式或彩色文字的图注已保留为图片下方正文，避免 B 站原生纯文字图注丢失加粗、颜色或装饰。');
      continue;
    }
    imageCaptions.set(pictures[0], text);
    consumedCaptions.add(caption);
  }

  function checkScriptStyle(style) {
    if (style.color && !safeLatexColor(style.color)) issue('上下标或其基底的半透明、特殊颜色无法表示为有效 LaTeX 颜色，请将这个局部保留为图片或调整颜色。');
    if (style.background && !style.pageBackground) issue('上下标或其基底带背景色，暂不能完整映射到 B 站原生公式，请将这个局部保留为图片或调整样式。');
    // TeX \\cancel draws a diagonal slash, which is not an HTML horizontal strike.
    // Do not silently substitute a different decoration.
    if (style.strikethrough) issue('上下标或其基底带删除线，暂不能完整映射到 B 站原生公式，请将这个局部保留为图片或调整样式。');
  }

  function pushText(nodes, style, el, context) {
    // Whitespace-only paragraph wrappers are not content; visible newlines within text remain.
    if (!nodes.some(n => n.node_type !== 1 || n.word.words.trim())) return;
    const format = simpleFormat(style, el);
    let type = context?.quote ? 4 : 1;
    const visibleWords = nodes.filter(n => n.node_type === 1 && n.word.words.trim());
    const sourceSize = visibleWords[0]?.word.font_size;
    // Work on one already-separated paragraph at a time. A large inline span
    // inside mixed-size text must not turn its neighbors into a large heading.
    const headingIndex = !context?.quote && !context?.list && visibleWords.length &&
      visibleWords.every(n => n.word.font_size === sourceSize) ? HEADINGS.findIndex(h => h.size === sourceSize) : -1;
    if (headingIndex >= 0) {
      type = 9;
      format.heading_type = headingIndex + 1;
      adaptedHeadings = true;
    }
    for (const node of nodes) {
      if (node.node_type !== 1) continue;
      const original = node.word.font_size;
      const font = headingIndex >= 0 ? HEADINGS[headingIndex] : original < 15 ? { size: 13, level: 'small' } : { size: 17, level: 'regular' };
      node.word.font_size = font.size;
      node.word.font_level = font.level;
      if (node.word.words.trim() && original !== font.size) adjustedSizes.add(`${original}→${font.size}`);
    }
    if (context?.list) {
      const list = context.list;
      type = list.ordered ? 5 : 6;
      format.list_format = { level: list.level, order: list.order, theme: list.ordered ? 'arabic_num' : 'dot' };
      format.combine_hash = list.hash;
    }
    paragraphs.push({ para_type: type, format, text: { nodes } });
  }

  function pushImage(el, inline) {
    stats.images++;
    const url = el.getAttribute('src') || '';
    if (!nativeImageUrl(url)) issue('正文仍有未上传到 B 站的图片，已停止生成草稿。');
    const data = lookupImage(url) || {};
    const width = Number(data.width || el.getAttribute('data-width') || el.getAttribute('width'));
    const height = Number(data.height || el.getAttribute('data-height') || el.getAttribute('height'));
    const rawSize = data.size ?? el.getAttribute('data-size');
    const size = Number(rawSize);
    if (!(width > 0) || !(height > 0) || rawSize === null || rawSize === '' || !Number.isFinite(size) || size < 0) issue('部分图片缺少有效尺寸或文件大小，无法生成可靠的 B 站图片节点。');
    if (inline) issue('存在没有 LaTeX 源码的行内图片。B 站原生图片节点只支持独立段落，无法在不改变位置的情况下直接同步；请将该公式补充为 LaTeX，或明确改为独立图片段落。');
    const picture = { url, width: width > 0 ? width : 0, height: height > 0 ? height : 0, size: Number.isFinite(size) ? size : 0 };
    const caption = imageCaptions.has(el) ? imageCaptions.get(el) : normalizedCaption(el.getAttribute('data-caption'));
    if (caption && caption.length <= IMAGE_CAPTION_MAX_LENGTH) picture.comment = caption;
    paragraphs.push({ para_type: 2, pic: { pics: [picture], style: 0 } });
    if (caption && caption.length > IMAGE_CAPTION_MAX_LENGTH) {
      pushText([wordNode(caption, {})], {}, el, {});
      summaryParts.push(caption);
      stats.characters += caption.length;
      warn('超过 100 字符的图注已完整保留为图片下方正文，避免 B 站原生图片注释截断。');
    }
  }

  function subSup(el, inherited, nodes) {
    const style = stylesFor(el, inherited);
    checkScriptStyle(style);
    if (el.querySelector('img,svg,math,table')) {
      issue('上下标包含图片或复杂公式，无法自动保留为原生文字公式。');
      return;
    }
    const kind = el.tagName === 'SUP' || el.style.verticalAlign === 'super' ? '^' : '_';
    stats[kind === '^' ? 'superscripts' : 'subscripts']++;
    const script = el.textContent || '';
    summaryParts.push(script);
    stats.characters += script.length;
    let base = '{}';
    const last = nodes.at(-1);
    // Join adjacent sub/sup on the same base, instead of creating two floating scripts.
    if (last?.node_type === 5 && last.__scriptFormula) {
      base = last.__scriptFormula;
      nodes.pop();
      stats.formulas--;
    } else if (last?.node_type === 1) {
      const m = last.word.words.match(/[A-Za-z0-9\u0370-\u03ff]+$/u);
      if (m) {
        const savedStyle = {
          bold: last.word.style.bold,
          italic: last.word.style.italic,
          underline: last.word.style.underline,
          strikethrough: last.word.style.strikethrough,
          color: last.word.color,
          background: last.word.bg_style?.color?.color,
        };
        checkScriptStyle(savedStyle);
        base = latexText(m[0], savedStyle);
        last.word.words = last.word.words.slice(0, -m[0].length);
        if (!last.word.words) nodes.pop();
      }
    }
    function scriptContents(container, carry) {
      checkScriptStyle(carry);
      let value = '';
      for (const node of container.childNodes) {
        if (node.nodeType === 3) value += latexText(node.textContent, carry);
        else if (node.nodeType === 1) {
          const local = stylesFor(node, carry);
          if (node.tagName === 'SUP' || node.tagName === 'SUB') value += `${node.tagName === 'SUP' ? '^' : '_'}{${scriptContents(node, local)}}`;
          else value += scriptContents(node, local);
        }
      }
      return value;
    }
    const latex = `${base}${kind}{${scriptContents(el, style)}}`;
    const formula = { node_type: 5, formula: { latex_content: latex } };
    // Temporary non-enumerable state never leaks into the saved native payload.
    Object.defineProperty(formula, '__scriptFormula', { value: latex });
    nodes.push(formula);
    stats.formulas++;
    warn('上下标已转换为 B 站原生行内公式，可在 B 站公式编辑器中继续修改。');
  }

  function convertContainer(container, inherited = {}, context = {}) {
    const style = stylesFor(container, inherited);
    let nodes = [];
    const flush = () => { pushText(nodes, style, container, context); nodes = []; };
    // Used only to distinguish a paragraph image from a genuine inline picture.
    const visibleText = node => consumedCaptions.has(node) ? '' : node.nodeType === 3 ? node.textContent : Array.from(node.childNodes || []).map(visibleText).join('');
    const hasVisibleText = visibleText(container).trim().length > 0;
    const hasBlockChildren = Array.from(container.children || []).some(c => BLOCK.has(c.tagName));

    function sourceLink(node, inheritedStyle) {
      const url = normalizeSourceLink(node.getAttribute('href'));
      if (!url) { issue('原文链接地址无效，已停止同步。'); return false; }
      requestedSourceLinks.add(url);
      if (sourceLinkValidation !== undefined && !acceptedSourceLinks.has(url)) {
        warn(rejectedSourceLinks.has(url) ? 'B 站不支持此原文链接，已保留原文标题和完整网址，可复制访问。' : '尚未确认 B 站是否支持此原文链接，已保留原文标题和完整网址，可复制访问。');
        return false;
      }
      const descendants = [node, ...node.querySelectorAll('*')];
      if (descendants.some(el => explicitLatex(el) !== null || UNSUPPORTED.has(el.tagName) || BLOCK.has(el.tagName) ||
          ['IMG','SUP','SUB','BR'].includes(el.tagName) || ['super','sub'].includes(el.style.verticalAlign) ||
          el.hasAttribute('data-sync-unsupported') || el.hasAttribute('data-wb-unsupported'))) {
        warn('原文链接包含公式、上下标或复杂内容，已保留原文内容和完整网址，避免原生链接丢失含义。');
        return false;
      }
      const runs = [];
      const visit = (child, carry) => {
        if (child.nodeType === 3) {
          const text = child.textContent.replace(/[\t\r\n]+/g, ' ');
          if (text) runs.push({text,style:carry});
        } else if (child.nodeType === 1) {
          const style = stylesFor(child, carry);
          for (const nested of child.childNodes) visit(nested, style);
        }
      };
      for (const child of node.childNodes) visit(child, inheritedStyle);
      // The native link mark has no foreground color field. Ordinary body gray
      // can adopt the platform link color, explicitly reported as an info notice;
      // custom colors retain their source expression plus the copyable URL.
      const ordinaryColor = value => {
        if (!value || ['black','gray','grey','dimgray','dimgrey'].includes(value.toLowerCase())) return true;
        const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
        const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
        const c = hex ? hex.slice(1).map(v=>parseInt(v,16)) : rgba ? rgba.slice(1,4).map(Number) : null;
        return c && c[0] === c[1] && c[1] === c[2] && c[0] <= 190 && (rgba?.[4] === undefined || Number(rgba[4]) >= .7);
      };
      if (runs.some(run => run.text.trim() && !ordinaryColor(run.style.color))) {
        warn('原文链接含自定义文字颜色，已保留原文字颜色和完整网址，避免被 B 站链接色替换。');
        return false;
      }
      if (!runs.some(run=>run.text.trim())) { issue('原文链接缺少可见文字，已停止同步。'); return false; }
      for (const {text,style} of runs) {
        const size = style.size || 17, small = size < 15;
        if (size !== (small ? 13 : 17)) adjustedSizes.add(`${size}→${small ? 13 : 17}`);
        const link = {show_text:text,link:url,icon:'',icon_suffix:'',link_type:16,biz_id:'',pics:[],style:{
          ...Object.fromEntries(['bold','italic','strikethrough','underline'].map(key=>[key,!!style[key]])),font_size:0,font_level:small?'small':'regular',
        }};
        if (style.background && !style.pageBackground) link.bg_style = {style:1,color:nativeColor(style.background)};
        const previous = nodes.at(-1);
        if (previous?.node_type === 4 && JSON.stringify({...previous.link,show_text:''}) === JSON.stringify({...link,show_text:''})) previous.link.show_text += text;
        else nodes.push({node_type:4,link});
        summaryParts.push(text); stats.characters += text.length;
      }
      sourceLinks.add(url);
      inform('原文链接已使用 B 站原生链接颜色。');
      return true;
    }

    function inline(node, parentStyle) {
      if (node.nodeType === 3) {
        const text = node.textContent.replace(/[\t\r\n]+/g, ' ');
        if (!text || (!nodes.length && !text.trim())) return;
        const word = wordNode(text, parentStyle);
        const last = nodes.at(-1);
        if (last?.node_type === 1 && JSON.stringify({ ...last.word, words: '' }) === JSON.stringify({ ...word.word, words: '' })) last.word.words += text;
        else nodes.push(word);
        summaryParts.push(text);
        stats.characters += text.length;
        return;
      }
      if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
      if (consumedCaptions.has(node)) {
        const text = normalizedCaption(captionText(node));
        summaryParts.push(text);
        stats.characters += text.length;
        return;
      }
      const childStyle = stylesFor(node, parentStyle);
      if (childStyle.align === 'justify') warn('B 站原生段落没有已验证的两端对齐值，将使用默认对齐；文字内容保留。');
      if (node.tagName === 'A' && node.getAttribute('data-sync-source-link') === 'true') {
        if (!sourceLink(node, childStyle)) {
          for (const child of node.childNodes) inline(child, childStyle);
          const url = normalizeSourceLink(node.getAttribute('href'));
          if (url && normalizeSourceLink(node.textContent.trim()) !== url) inline(doc.createTextNode(`（${url}）`), childStyle);
        }
        return;
      }
      const latex = explicitLatex(node);
      if (latex !== null) {
        if (!latex.trim()) { issue('公式标记缺少 LaTeX 内容，不能自动同步。'); return; }
        let styledLatex = latex;
        if (childStyle.bold) styledLatex = `\\boldsymbol{${styledLatex}}`;
        if (safeLatexColor(childStyle.color)) styledLatex = `\\color{${childStyle.color}}{${styledLatex}}`;
        else if (childStyle.color) issue('公式的半透明或特殊颜色无法表示为有效 LaTeX 颜色，请将这个局部保留为图片或调整颜色。');
        if (childStyle.underline) styledLatex = `\\underline{${styledLatex}}`;
        nodes.push({ node_type: 5, formula: { latex_content: styledLatex } });
        stats.formulas++;
        if (node.tagName === 'IMG') stats.formulaImages++;
        summaryParts.push(node.getAttribute('alt') || latex);
        if ((childStyle.background && !childStyle.pageBackground) || childStyle.strikethrough) issue('公式带有背景色或删除线，暂不能完整映射到 B 站原生公式，请处理后重试。');
        return;
      }
      if (UNSUPPORTED.has(node.tagName.toUpperCase()) || node.hasAttribute('data-wb-unsupported') || node.hasAttribute('data-sync-unsupported')) {
        issue(`存在尚不能原生保留的 ${node.tagName.toLowerCase()} 内容，请处理后再同步。`);
        return;
      }
      if (node.tagName === 'SUP' || node.tagName === 'SUB' || ['super', 'sub'].includes(node.style.verticalAlign)) {
        subSup(node, parentStyle, nodes);
        return;
      }
      if (node.tagName === 'IMG') {
        flush();
        const blockDisplay = ['block', 'flex'].includes(node.style.display);
        pushImage(node, hasVisibleText && !hasBlockChildren && !blockDisplay);
        return;
      }
      if (node.tagName === 'BR') {
        nodes.push(wordNode('\n', childStyle));
        summaryParts.push('\n');
        return;
      }
      if (BLOCK.has(node.tagName)) {
        flush();
        convertBlock(node, parentStyle, context);
        return;
      }
      for (const child of node.childNodes) inline(child, childStyle);
    }
    for (const child of container.childNodes) inline(child, style);
    flush();
  }

  function convertBlock(el, inherited, context) {
    const style = stylesFor(el, inherited);
    if (el.tagName === 'HR') { paragraphs.push({ para_type: 3, line: { line_type: 1 } }); return; }
    if (el.tagName === 'PRE') {
      const code = el.querySelector('code');
      const navigation = questionNavigationLines(el);
      if (navigation) {
        const inheritedStyle = navigation.code === el ? style : stylesFor(navigation.code, style);
        for (const {fragment} of navigation.lines) {
          const paragraph = doc.createElement('p');
          paragraph.append(fragment);
          convertContainer(paragraph, inheritedStyle, context);
        }
        return;
      }
      const text = preformattedText(code || el);
      if (text) {
        const lang = code?.className?.match(/(?:language|lang)-([\w+-]+)/)?.[1] || '';
        paragraphs.push({ para_type: 8, code: { lang, content: text } });
        summaryParts.push(text);
        stats.characters += text.length;
      }
      return;
    }
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      const hash = `wechat-list-${++listCounter}`;
      const level = (context.list?.level || 0) + 1;
      let order = Math.max(1, Number(el.getAttribute('start')) || 1);
      for (const item of el.children) {
        if (item.tagName !== 'LI') { issue('列表结构不完整，请检查列表内容。'); continue; }
        convertContainer(item, style, { ...context, list: { hash, level, order: order++, ordered: el.tagName === 'OL' } });
      }
      return;
    }
    convertContainer(el, inherited, { ...context, quote: context.quote || el.tagName === 'BLOCKQUOTE' });
  }

  convertContainer(doc.body);
  if (adjustedSizes.size || adaptedHeadings) {
    const details = [];
    if (adjustedSizes.size) details.push(`正文已按 B 站支持的字号调整（${[...adjustedSizes].join('、')}px）`);
    if (adaptedHeadings) details.push('整段 20/22/24px 文字已使用 B 站对应标题样式');
    warn(`${details.join('；')}。实际字号、字重和段间距由 B 站控制。`);
  }
  stats.paragraphs = paragraphs.length;
  if (!paragraphs.length) issue('正文没有可同步的内容。');
  return { content: { paragraphs }, warnings, notices, sourceLinks:[...sourceLinks], requestedSourceLinks:[...requestedSourceLinks], blockingIssues, stats, summary: summaryParts.join('').replace(/\s+/g, ' ').trim().slice(0, 250) };
}

export { nativeImageUrl, explicitLatex };
