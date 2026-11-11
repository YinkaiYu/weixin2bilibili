/** Loss-aware, local-only rendering for the few blocks Bilibili cannot represent. */
import {downloadImage} from './media.js';
import {analyzeNativeTextBackgrounds,getCompositePageBackground} from './opus.js';

const BLOCK = new Set('P DIV SECTION ARTICLE MAIN HEADER FOOTER H1 H2 H3 H4 H5 H6 BLOCKQUOTE FIGURE FIGCAPTION UL OL LI PRE HR'.split(' '));
const WIDTH = 680;
const SCALE = 2;
const MAX_HEIGHT = 4096;
const MAX_PIXELS = 12_000_000;
const INHERITED = ['font-family','font-size','font-weight','font-style','color','text-align','line-height','letter-spacing','text-decoration','text-decoration-line'];

function hasFormula(node) { return Boolean(node.closest?.('[data-formula],[data-latex]')); }
function nearestBlock(node, body) {
  for (let parent = node.parentElement; parent && parent !== body; parent = parent.parentElement) {
    if (BLOCK.has(parent.tagName.toUpperCase())) return parent;
  }
  return body;
}
function isLeafTextBlock(node) {
  return Boolean(node.textContent.trim()) && ![...node.children].some(child => BLOCK.has(child.tagName.toUpperCase()));
}
function allIncluding(node, selector) {
  return [...(node.matches?.(selector) ? [node] : []), ...node.querySelectorAll(selector)];
}

function decoratedHeadingTarget(decoration, body) {
  // A small empty background may be an accent attached to a flex heading. Its
  // negative margin depends on that group; capturing it alone produces a strip.
  // Keep this promotion narrow so a flex article or an image/GIF is not flattened.
  const text = node => node.textContent.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  const group = decoration.parentElement;
  if (text(decoration) || !group || group === body || !['flex','inline-flex'].includes(group.style.display)) return null;
  if (group.style.flexDirection && !['row','row-reverse'].includes(group.style.flexDirection)) return null;
  if (group.querySelector('img,svg,math,table,ul,ol,li,[data-formula],[data-latex],[data-sync-unsupported]')) return null;
  const title = text(group);
  if (!title || title.length > 120 || [...group.children].filter(node => text(node)).length !== 1) return null;
  const textBlocks = [...group.querySelectorAll('*')].filter(node => BLOCK.has(node.tagName) && text(node) && ![...node.querySelectorAll('*')].some(child => BLOCK.has(child.tagName) && text(child)));
  if (textBlocks.length > 1) return null;
  let target = group;
  // Preserve the shrink-wrapped heading box. Its outer text-align is inherited
  // by the rendering wrapper, so a centered title stays centered.
  while (target.parentElement && target.parentElement !== body) {
    const parent = target.parentElement;
    if (!['inline-block','inline-flex'].includes(parent.style.display) || parent.children.length !== 1 || text(parent) !== text(target)) break;
    target = parent;
  }
  return target;
}

function includeVerticalOverflow(wrapper) {
  const box = wrapper.getBoundingClientRect();
  let top = 0, bottom = 0;
  for (const node of wrapper.querySelectorAll('*')) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      top = Math.max(top, Math.ceil(box.top - rect.top));
      bottom = Math.max(bottom, Math.ceil(rect.bottom - box.bottom));
    }
  }
  // Move the content with padding, rather than merely extending the canvas below
  // it: a negative top margin can otherwise still be clipped above the canvas.
  if (top) wrapper.style.paddingTop = `${top}px`;
  if (bottom) wrapper.style.paddingBottom = `${bottom}px`;
}

/** Returns disjoint DOM elements in document order. The caller owns the inert document. */
export function findRasterTargets(input) {
  const body = input.body || input;
  const candidates = new Set();
  for (const element of body.querySelectorAll('[data-sync-composite-layout],[data-sync-gradient],[data-sync-background-url],svg,math,table,img')) {
    const tag = element.tagName.toUpperCase();
    if (element.getAttribute('data-sync-composite-layout') === 'grid-overlay') {
      candidates.add(element);
      continue;
    }
    if (element.hasAttribute('data-sync-background-url') || element.getAttribute('data-sync-gradient')==='true') {
      const paragraph = nearestBlock(element,body);
      candidates.add(decoratedHeadingTarget(element,body) || (!BLOCK.has(tag) && isLeafTextBlock(paragraph) ? paragraph : element));
      continue;
    }
    if (hasFormula(element)) continue;
    if (tag === 'TABLE') { candidates.add(element); continue; }
    if (tag === 'SVG' || tag === 'MATH') {
      const paragraph = nearestBlock(element, body);
      const leaf = ![...paragraph.children].some(child => BLOCK.has(child.tagName.toUpperCase()));
      candidates.add(paragraph !== body && leaf ? paragraph : element);
      continue;
    }
    if (tag === 'IMG' && !['block','flex'].includes(element.style.display)) {
      const paragraph = nearestBlock(element, body);
      if (isLeafTextBlock(paragraph)) candidates.add(paragraph);
    }
  }
  for (const {element,backgroundElement,reason} of analyzeNativeTextBackgrounds(body).unsupported) {
    if (!backgroundElement) continue;
    candidates.add(reason==='formula-background' ? BLOCK.has(element.tagName) ? element : nearestBlock(element,body) : BLOCK.has(backgroundElement.tagName) ? backgroundElement : nearestBlock(backgroundElement,body));
  }
  // A background or table can contain another candidate. Capture it only once.
  return [body,...body.querySelectorAll('*')].filter(element => candidates.has(element) && ![...candidates].some(other => other !== element && other.contains(element)));
}

export function assertStaticAsset(info) {
  if (!info || info.animated || Number(info.frames) > 1) throw new Error('这个局部包含动图，不能转成静态图片；请调整为独立动图段落后重试。');
  if (!(info.width > 0) || !(info.height > 0)) throw new Error('局部图片的尺寸无法确认，已停止转换。');
}

function copyInheritedStyle(source, boundary, wrapper) {
  const ancestors = [];
  for (let node = source.parentElement; node; node = node.parentElement) {
    ancestors.unshift(node);
    if (node === boundary) break;
  }
  wrapper.style.fontFamily = 'Arial, "Microsoft YaHei", sans-serif';
  wrapper.style.fontSize = '17px';
  wrapper.style.lineHeight = '1.8';
  wrapper.style.color = '#222222';
  const background=getCompositePageBackground(source);
  if(!background)throw new Error('局部的祖先背景或透明度无法完整合成，请调整该局部后重试。');
  wrapper.style.backgroundColor = background;
  for (const ancestor of ancestors) {
    if (['B','STRONG'].includes(ancestor.tagName)) wrapper.style.fontWeight = 'bold';
    if (['I','EM'].includes(ancestor.tagName)) wrapper.style.fontStyle = 'italic';
    for (const property of INHERITED) {
      const value = ancestor.style?.getPropertyValue(property);
      if (value && value !== 'inherit') wrapper.style.setProperty(property, value);
    }
  }
}

// Preserve the browser's grid layout before passing it to html2canvas, whose
// painter does not implement CSS Grid stacking. All coordinates come from the
// loaded local clone; no dimensions or asset identities are template-specific.
function freezeGridLayouts(wrapper, owner) {
  const transformed=[];
  for(const element of wrapper.querySelectorAll('*')) {
    const transform=owner.defaultView.getComputedStyle(element).transform;
    if(!transform||transform==='none')continue;
    if(!/^matrix\((?:[-+\d.e]+\s*,\s*){5}[-+\d.e]+\)$/i.test(transform))throw new Error('局部含暂不支持的三维变换，已保留原文并停止转换。');
    transformed.push({element,value:element.style.getPropertyValue('transform'),priority:element.style.getPropertyPriority('transform')});
  }
  // Transform bounding boxes include rotation/scale. Measure the unchanged
  // layout with transforms temporarily off, then restore them exactly once.
  for(const {element} of transformed)element.style.setProperty('transform','none','important');
  const grids=[...wrapper.querySelectorAll('*')].filter(node=>['grid','inline-grid'].includes(owner.defaultView.getComputedStyle(node).display));
  const snapshots=grids.map(grid=>{
    const rect=grid.getBoundingClientRect(), css=owner.defaultView.getComputedStyle(grid);
    const borderLeft=parseFloat(css.borderLeftWidth)||0, borderTop=parseFloat(css.borderTopWidth)||0;
    const children=[...grid.children].map(child=>({child,rect:child.getBoundingClientRect()}));
    return {grid,rect,borderLeft,borderTop,children};
  });
  for(const {grid,rect,borderLeft,borderTop,children} of snapshots.reverse()) {
    grid.style.display='block';grid.style.position='relative';grid.style.boxSizing='border-box';
    grid.style.width=`${rect.width}px`;grid.style.height=`${rect.height}px`;
    for(const {child,rect:childRect} of children) {
      child.style.position='absolute';child.style.boxSizing='border-box';child.style.margin='0';
      child.style.left=`${childRect.left-rect.left-borderLeft}px`;
      child.style.top=`${childRect.top-rect.top-borderTop}px`;
      child.style.width=`${childRect.width}px`;child.style.height=`${childRect.height}px`;
    }
  }
  for(const {element,value,priority} of transformed) {
    if(value)element.style.setProperty('transform',value,priority);else element.style.removeProperty('transform');
  }
}

function assertSafeTree(target) {
  if (target.matches?.('script,iframe,object,embed,link,style,base,form') || target.querySelector('script,iframe,object,embed,link,style,base,form')) throw new Error('局部包含未清理的嵌入内容，已停止转换。');
  const unsupported=allIncluding(target,'[data-sync-unsupported]');
  if (unsupported.length) throw new Error(`局部含暂不支持的 ${unsupported[0].getAttribute('data-sync-unsupported')}，已保留原内容并停止转换。`);
  if (target.querySelector('animate,animateTransform,animateMotion,set')) throw new Error('局部包含 SVG 动画，不能转成静态图片。');
  for (const formula of allIncluding(target,'[data-formula],[data-latex]')) {
    if (!formula.textContent.trim() && !formula.querySelector('svg,math,img') && formula.tagName!=='IMG') throw new Error('公式只有源码、没有可供截图的显示内容；请保留原生公式或补充公式显示后再导入。');
  }
  for (const element of [target,...target.querySelectorAll('*')]) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name) || /javascript:|expression\s*\(/i.test(attribute.value)) throw new Error('局部包含未清理的可执行属性，已停止转换。');
    }
    if (element.matches('a[href],use[href],use[xlink\\:href],image[href],image[xlink\\:href]')) throw new Error('局部仍有未清理的外部引用，已停止转换。');
    for (const property of Array.from(element.style || [])) {
      if (/url\s*\(/i.test(element.style.getPropertyValue(property)) && property !== 'background-image') throw new Error('局部含无法安全读取的外部样式资源，已停止转换。');
    }
  }
}

async function blobDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function waitForImage(image) {
  let timer;
  try {
    await Promise.race([
      typeof image.decode === 'function' ? image.decode() : new Promise((resolve,reject) => {
        if (image.complete && image.naturalWidth) return resolve();
        image.onload = resolve;
        image.onerror = () => reject(new Error('图片解码失败'));
      }),
      new Promise((_,reject) => { timer=setTimeout(()=>reject(new Error('局部图片加载超时，已停止转换。')),15000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('局部图片无法完整显示，已停止转换。');
}

function graphicDataUrl(node, owner) {
  const rect = node.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) throw new Error('图形没有有效显示尺寸，已停止转换。');
  const serialize = new owner.defaultView.XMLSerializer();
  const style = owner.defaultView.getComputedStyle(node);
  let svg;
  if (node.tagName.toUpperCase() === 'SVG') {
    svg = node.cloneNode(true);
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
    svg.setAttribute('width',String(rect.width));
    svg.setAttribute('height',String(rect.height));
    svg.style.width = `${rect.width}px`;
    svg.style.height = `${rect.height}px`;
    svg.style.color = style.color;
  } else {
    // The browser paints MathML inside the SVG image. html2canvas alone cannot lay it out.
    svg = owner.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
    svg.setAttribute('width',String(rect.width));
    svg.setAttribute('height',String(rect.height));
    const foreign = owner.createElementNS('http://www.w3.org/2000/svg','foreignObject');
    foreign.setAttribute('width','100%'); foreign.setAttribute('height','100%');
    const math = node.cloneNode(true);
    math.setAttribute('xmlns','http://www.w3.org/1998/Math/MathML');
    math.setAttribute('style',`${math.getAttribute('style') || ''};color:${style.color};font-size:${style.fontSize}`);
    foreign.append(math); svg.append(foreign);
  }
  return {url:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialize.serializeToString(svg))}`,width:rect.width,height:rect.height};
}

async function replaceGraphics(wrapper, owner) {
  for (const graphic of [...wrapper.querySelectorAll('svg,math')]) {
    if (!wrapper.contains(graphic)) continue;
    const data = graphicDataUrl(graphic,owner);
    const image = owner.createElement('img');
    image.src = data.url;
    image.style.cssText = graphic.getAttribute('style') || '';
    image.style.width = `${data.width}px`;
    image.style.height = `${data.height}px`;
    image.alt = graphic.closest('[data-formula]')?.getAttribute('data-formula') || '原文图形';
    graphic.replaceWith(image);
    await waitForImage(image);
  }
}

/**
 * Render only incompatible blocks in a clone. Native text, formulas and independent
 * images are never rasterized. Injectable dependencies are for deterministic tests.
 */
export async function prepareForNative(html, {
  localFiles = new Map(), savedPaths = new Map(), onProgress = () => {},
  downloadImageImpl = downloadImage, renderImpl = globalThis.html2canvas,
  document: owner = globalThis.document,
} = {}) {
  const Parser = owner?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error('局部转换需要浏览器文档环境。');
  const doc = new Parser().parseFromString(String(html || ''),'text/html');
  const targets = findRasterTargets(doc);
  const warnings = [], blockingIssues = [];
  const downloads = new Map();
  let rasterized = 0;
  const load = async url => {
    if (!downloads.has(url)) downloads.set(url, downloadImageImpl(url,{localFiles,savedPaths}));
    const info = await downloads.get(url);
    assertStaticAsset(info);
    return info;
  };
  for (let index=0; index<targets.length; index++) {
    const source = targets[index];
    let wrapper;
    const reason = source.matches('[data-sync-composite-layout]') ? '叠层图文' : source.matches('[data-sync-background-url]') || source.querySelector('[data-sync-background-url]') ? '背景排版' : source.querySelector('img') ? '行内图文' : '文字底色或复杂图形';
    onProgress({index,total:targets.length,state:'rendering',reason});
    try {
      assertSafeTree(source);
      // Work only on a clone until the completed PNG passes checks.
      let clone = source.cloneNode(true);
      if (source === doc.body) {
        const section = doc.createElement('section');
        section.append(...clone.childNodes);
        clone = section;
      }
      for (const image of allIncluding(clone,'img')) {
        const info = await load(image.getAttribute('src') || '');
        image.setAttribute('src',await blobDataUrl(info.blob));
        image.removeAttribute('srcset');
      }
      const backgrounds = [];
      for (const element of allIncluding(clone,'[data-sync-background-url]')) {
        const info = await load(element.getAttribute('data-sync-background-url'));
        const url = await blobDataUrl(info.blob);
        element.style.backgroundImage = `url("${url}")`;
        element.removeAttribute('data-sync-background-url');
        backgrounds.push(url);
      }
      if (!owner?.body || typeof renderImpl !== 'function') throw new Error('局部转换组件未加载，请重新打开插件。');
      wrapper = owner.createElement('div');
      copyInheritedStyle(source,doc.body,wrapper);
      wrapper.style.position = 'fixed'; wrapper.style.left = '-10000px'; wrapper.style.top = '0';
      wrapper.style.width = `${WIDTH}px`; wrapper.style.boxSizing = 'border-box';
      wrapper.style.padding = '0'; wrapper.style.margin = '0'; wrapper.style.pointerEvents = 'none';
      wrapper.style.zIndex = '0'; wrapper.style.display = 'flow-root';
      const imported = owner.importNode(clone,true);
      if (imported.style) imported.style.maxWidth = '100%';
      for (const element of allIncluding(imported,'*')) {
        if (['flex','inline-flex'].includes(element.style?.display)) {
          // html2canvas otherwise paints an inline-block ancestor's background
          // over unpositioned flex descendants. A local stacking context keeps
          // the browser's visible order without changing their layout.
          element.style.position = 'relative'; element.style.zIndex = '0';
        }
      }
      wrapper.append(imported);
      owner.body.append(wrapper);
      for (const image of wrapper.querySelectorAll('img')) {
        image.style.maxWidth = '100%';
        await waitForImage(image);
      }
      for (const url of backgrounds) {
        const image = owner.createElement('img'); image.src=url; await waitForImage(image);
      }
      if (owner.fonts?.ready) await owner.fonts.ready;
      await replaceGraphics(wrapper,owner);
      freezeGridLayouts(wrapper,owner);
      includeVerticalOverflow(wrapper);
      const rect = wrapper.getBoundingClientRect();
      const height = Math.ceil(Math.max(rect.height,wrapper.scrollHeight));
      const width = Math.ceil(Math.max(rect.width,wrapper.scrollWidth));
      if (!(height > 0) || height > MAX_HEIGHT || width > WIDTH+2 || width*height*SCALE*SCALE > MAX_PIXELS) throw new Error(`局部排版超出安全截图尺寸（${width}×${height}），请缩小或拆分该段。`);
      const canvas = await renderImpl(wrapper, {backgroundColor:null,scale:SCALE,width:WIDTH,height,useCORS:false,allowTaint:false,logging:false,imageTimeout:15000,windowWidth:1024,windowHeight:Math.max(768,height),scrollX:0,scrollY:0});
      if (!canvas || canvas.width !== WIDTH*SCALE || canvas.height < height*SCALE-2 || canvas.height > MAX_HEIGHT*SCALE) throw new Error('局部图片输出尺寸异常，未替换原文。');
      const png = canvas.toDataURL('image/png');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(png) || png.length < 100) throw new Error('局部图片生成失败，未替换原文。');
      const paragraph = doc.createElement('p');
      const image = doc.createElement('img');
      image.src = png; image.alt = `${reason}（由原文局部保真转换）`;
      image.setAttribute('data-sync-rasterized',reason);
      image.setAttribute('width',String(WIDTH)); image.setAttribute('height',String(height));
      image.style.maxWidth = '100%'; image.style.height = 'auto';
      paragraph.append(image);
      if(source===doc.body) doc.body.replaceChildren(paragraph); else source.replaceWith(paragraph);
      rasterized++;
      onProgress({index,total:targets.length,state:'done',reason});
    } catch(error) {
      blockingIssues.push(`第 ${index+1} 处${reason}转换失败：${error.message}`);
      onProgress({index,total:targets.length,state:'error',reason,message:error.message});
    } finally { wrapper?.remove(); }
  }
  if (rasterized) warnings.push(`${rasterized} 处复杂排版已转为高清图片，其余正文保持原生。这些局部的文字在 B站需通过替换图片修改。`);
  return {html:doc.body.innerHTML,warnings,blockingIssues,rasterized};
}
