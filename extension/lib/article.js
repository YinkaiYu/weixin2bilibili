/** Article extraction and loss-aware cleanup. No requests or page scripts are executed. */
import {scriptAlbumTitles} from './source-metadata.js';
import {normalizeSourceLink} from './source-links.js';
const HTML_TAGS = new Set('p div section article main header footer figure figcaption span a strong b em i u s strike del sup sub br hr img h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr td th caption colgroup col'.split(' '));
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
for (const property of 'grid-template-columns grid-template-rows grid-template-areas grid-column grid-column-start grid-column-end grid-row grid-row-start grid-row-end grid-area grid-auto-flow grid-auto-columns grid-auto-rows'.split(' ')) STYLE_PROPS.add(property);
// These local sizing, clipping and stacking properties are needed when a grid
// is retained as one composition. They are not enabled for ordinary page HTML.
const COMPOSITE_STYLE_PROPS = new Set('aspect-ratio overflow overflow-x overflow-y opacity z-index transform transform-origin'.split(' '));
const SVG_ATTRS = new Set('viewbox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-opacity opacity transform font-size font-family text-anchor dominant-baseline dx dy offset stop-color stop-opacity preserveaspectratio'.split(' '));
const MATH_ATTRS = new Set('display mathvariant mathsize mathcolor mathbackground stretchy fence separator form lspace rspace linethickness numalign denomalign rowalign columnalign rowspacing columnspacing notation open close separators encoding'.split(' '));
const IMAGE_ATTRS = new Set('src alt title width height data-type data-formula data-latex data-w data-h data-local-path data-sync-formula-image data-caption'.split(' '));
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

function textReadableWithoutImage(element, omittedSolidBackground = null, minimumContrast = 3) {
  const walker = element.ownerDocument.createTreeWalker(element,4);
  const samples=[];
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (normalizedText(text.textContent)) samples.push(text.parentElement);
  }
  // A formula may have source only in an attribute and no text nodes. Its
  // inherited foreground still needs a readable backdrop after conversion.
  samples.push(...element.querySelectorAll(FORMULA_SELECTOR));
  for (const sample of samples) {
    const ancestors = [];
    for (let parent=sample;parent;parent=parent.parentElement) ancestors.unshift(parent);
    let foreground = [0,0,0,1], background = [255,255,255,1];
    for (const ancestor of ancestors) {
      const color = ancestor.style?.color;
      if (color && !['inherit','currentcolor'].includes(color.toLowerCase())) foreground=cssColor(color);
      const solid = ancestor===omittedSolidBackground?'':ancestor.style?.backgroundColor;
      if (solid && !['inherit','initial','unset'].includes(solid.toLowerCase())) {
        const parsed=cssColor(solid);
        if (!parsed) return false;
        background=blend(parsed,background);
      }
    }
    if (!foreground) return false;
    const ink=luminance(blend(foreground,background)), paper=luminance(background);
    // Be conservative when the image may supply the contrast for the text.
    if ((Math.max(ink,paper)+0.05)/(Math.min(ink,paper)+0.05)<minimumContrast) return false;
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
  const semantic=['alt','title','aria-label'].some(name=>normalizedText(element.getAttribute(name))) || element.getAttribute('role')==='img';
  if(semantic) return '';
  const text=normalizedText(element.textContent);
  if (!text) {
    if(['presentation','none'].includes(element.getAttribute('role')?.trim().toLowerCase()))return 'empty';
    const row=element.parentElement,siblings=row?[...row.children].filter(node=>node!==element):[];
    const label=siblings.length===1?siblings[0]:null;
    if(label && ['flex','inline-flex'].includes(row.style.display) && !row.closest('figure,figcaption,table,pre,code') &&
      !row.querySelector(DECORATION_CONTENT) && normalizedText(label.textContent).length<=80 &&
      normalizedText(label.textContent) && label.querySelector('strong,b,h1,h2,h3,h4,h5,h6') &&
      cssColor(label.style.backgroundColor)?.[3]>0 && label.style.backgroundColor===element.style.backgroundColor &&
      ['width','height'].every(property=>/^\d+(?:\.\d+)?px$/.test(element.style[property])&&parseFloat(element.style[property])>0&&parseFloat(element.style[property])<=2*captionTextStyle(label).size) &&
      parseFloat(element.style.marginTop)<0 && textReadableWithoutImage(label))return 'empty';
    return '';
  }
  const label = /^[qa]\d{1,4}[.:：、)）]?$/i.test(text);
  // A stretch-to-fit background behind one bold title is a label skin. Keep
  // the actual text/color rather than capturing a full-width screenshot of it.
  const titleLabel=element.style.display==='inline-block' && element.style.width==='auto' &&
    element.style.backgroundSize==='100% 100%' && element.style.backgroundRepeat==='no-repeat' &&
    ['flex','inline-flex'].includes(element.parentElement?.style.display) && text.length<=80 &&
    element.querySelectorAll('p').length===1 &&
    normalizedText([...element.querySelectorAll('strong,b')].filter(node=>!node.parentElement.closest('strong,b')).map(node=>node.textContent).join(''))===text &&
    Number.parseFloat(element.style.paddingTop)>0 && Number.parseFloat(element.style.paddingLeft)>0 &&
    !element.closest('figure,figcaption,table,pre,code,blockquote,p');
  if(titleLabel && textReadableWithoutImage(element,null,2))return 'background';
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

function hasBackgroundImage(css) {
  // Chromium expands background:<solid> to image:initial; JSDOM exposes ''.
  return !['','none','initial','unset'].includes(css.backgroundImage.trim().toLowerCase());
}

function cssArguments(value) {
  const parts=[];let depth=0,start=0;
  for(let index=0;index<value.length;index++) {
    if(value[index]==='(') depth++;
    if(value[index]===')' && --depth<0) return null;
    if(value[index]===',' && depth===0){parts.push(value.slice(start,index).trim());start=index+1;}
  }
  if(depth!==0) return null;
  parts.push(value.slice(start).trim());return parts;
}

function resolveGradientVariables(value,element,chain=[]) {
  if(value.length>8192 || chain.length>12) return null;
  let result=value;
  for(let step=0;step<32;step++) {
    const match=/var\(/i.exec(result);
    if(!match) return result;
    let depth=1,end=match.index+4;
    for(;end<result.length&&depth;end++){if(result[end]==='(')depth++;else if(result[end]===')')depth--;}
    if(depth) return null;
    const args=cssArguments(result.slice(match.index+4,end-1)),name=args?.[0];
    if(!name || !/^--[\w-]+$/.test(name)) return null;
    let definition='';
    for(let ancestor=element;ancestor&&!definition;ancestor=ancestor.parentElement) definition=ancestor.style?.getPropertyValue(name).trim()||'';
    let replacement=definition && !chain.includes(name)?resolveGradientVariables(definition,element,[...chain,name]):null;
    if(replacement===null && args.length>1) replacement=resolveGradientVariables(args.slice(1).join(','),element,[...chain,name]);
    if(replacement===null || !replacement) return null;
    result=result.slice(0,match.index)+replacement+result.slice(end);
  }
  return null;
}

function gradientMarkerColor(value,element) {
  if(!['span','strong','b','em','i','u','s','a'].includes(element.localName) || element.querySelector('p,section,div,img,svg,math,table')) return '';
  const ownSolid=cssColor(element.style.backgroundColor);
  if(ownSolid?.[3]>0) return '';
  const match=value.match(/^linear-gradient\((.*)\)$/i);
  if(!match) return '';
  const args=cssArguments(match[1]);
  if(args?.length===3 && /^(?:to bottom|180deg)$/i.test(args[0])) args.shift();
  if(args?.length!==2) return '';
  const stops=args.map(arg=>{const stop=arg.match(/^(.*?)\s+([\d.]+)%$/);return stop?{text:stop[1],color:cssColor(stop[1]),position:Number(stop[2])}:null;});
  if(stops.some(stop=>!stop?.color) || stops[0].color[3]!==0 || stops[1].color[3]===0 || stops[0].position<=0 || stops[0].position>=100 || stops[1].position>stops[0].position) return '';
  return stops[1].text;
}

function normalizeGradientBackgrounds(body) {
  const counts={decorative:0,markers:0,raster:0,unsupported:0};
  for(const element of body.querySelectorAll('*')) {
    element.removeAttribute('data-sync-gradient');
    if(!element.style) continue;
    const image=element.style.backgroundImage;
    const raw=image || element.style.background;
    if(!/gradient\(/i.test(raw)) continue;
    const resolved=resolveGradientVariables(raw,element);
    const unsafe=!resolved || /url\s*\(|expression\s*\(|var\s*\(|@import|javascript:/i.test(resolved);
    if(unsafe) {
      element.setAttribute('data-sync-unsupported','CSS 渐变背景（变量无法安全解析）');counts.unsupported++;continue;
    }
    // A shorthand containing var() may remain unexpanded in CSSOM. Resolve
    // only this declaration, then let CSSOM parse its image/position/color.
    if(!image) element.style.background=resolved;
    else element.style.backgroundImage=resolved;
    const gradient=element.style.backgroundImage;
    if(!/gradient\(/i.test(gradient) || /var\s*\(/i.test(gradient)) {
      element.setAttribute('data-sync-unsupported','CSS 渐变背景（变量无法安全解析）');counts.unsupported++;continue;
    }
    if(decorativeBackgroundKind(element)==='background' || faintArticleTexture(element,gradient)) {
      clearDecorativeBackground(element);counts.decorative++;continue;
    }
    const marker=gradientMarkerColor(gradient,element);
    if(marker) {
      element.style.removeProperty('background-image');
      element.style.backgroundColor=marker;counts.markers++;continue;
    }
    const layers=cssArguments(gradient);
    if(layers?.every(layer=>/^(?:linear|radial)-gradient\(/i.test(layer))) {
      element.setAttribute('data-sync-gradient','true');counts.raster++;
    } else {
      element.setAttribute('data-sync-unsupported','CSS 渐变背景（当前无法完整转换）');counts.unsupported++;
    }
  }
  return counts;
}

// Low-opacity repeating paper/grid textures behind an article are page furniture,
// not a reason to rasterize all paragraphs, photographs and formula sources.
function faintArticleTexture(element,gradient) {
  if(!['section','div','article','main'].includes(element.localName)||element.querySelectorAll('p').length<3 ||
    element.closest('figure,figcaption,table,pre,code') || ['role','aria-label','title'].some(key=>element.hasAttribute(key)))return false;
  const sizes=cssArguments(element.style.backgroundSize),repeats=cssArguments(element.style.backgroundRepeat),layers=cssArguments(gradient);
  if(!sizes?.length||!repeats?.length||!layers?.length)return false;
  let opacity=0;
  for(let i=0;i<layers.length;i++){
    const size=sizes[i%sizes.length].split(/\s+/);
    const smallTile=size.length===2&&size.every(value=>/^\d+(?:\.\d+)?px$/.test(value)&&parseFloat(value)>0&&parseFloat(value)<=64);
    const match=layers[i].match(/^linear-gradient\((.*)\)$/i),args=match&&cssArguments(match[1]);
    if(!args)return false;
    if(/^(?:[-\d.]+deg|to\s)/i.test(args[0]))args.shift();
    const colors=args.map(stop=>cssColor(stop.match(/^(rgba?\([^)]*\)|transparent)(?:\s|$)/i)?.[1]));
    if(colors.length<2||colors.some(color=>!color))return false;
    // Some saved paper templates contain a single faint rule rather than a
    // repeated tile. Its hard edge must occupy at most 5% of the background.
    const positions=args.map(stop=>Number(stop.match(/\s([\d.]+)%$/)?.[1]));
    const thinRule=colors.length===2&&colors[1][3]===0&&positions[0]>0&&positions[0]<=5&&positions[0]===positions[1];
    if(!(smallTile&&repeats[i%repeats.length]==='repeat') && !(thinRule&&(smallTile||['auto','auto auto','initial'].includes(size.join(' ')))))return false;
    opacity+=Math.max(...colors.map(color=>color[3]));
  }
  return opacity<=0.1 && textReadableWithoutImage(element,null,2);
}

function framedTextCard(element) {
  const css=element.style, background=cssColor(css.backgroundColor);
  const fullWidthPanel=css.display==='inline-block' && css.width==='100%' && ['flex','inline-flex'].includes(element.parentElement?.style.display) && element.querySelectorAll('p').length>=2;
  if(!background || background[3]===0 || (!['','block'].includes(css.display)&&!fullWidthPanel) || hasBackgroundImage(css)) return false;
  if(element.hasAttribute('data-lazy-bgimg') || element.hasAttribute('data-sync-background-url') || element.hasAttribute('role') || element.hasAttribute('aria-label') || element.hasAttribute('title')) return false;
  const sides=['Top','Right','Bottom','Left'];
  const borders=sides.map(side=>[css['border'+side+'Width'],css['border'+side+'Style'],css['border'+side+'Color']]);
  const borderless=fullWidthPanel&&borders.every(([width,style])=>(!width||Number.parseFloat(width)===0)&&['','none','initial'].includes(style));
  if(!borderless && (borders.some(([width,style])=>!(Number.parseFloat(width)>0) || !['solid','dashed','dotted','double'].includes(style)) || borders.some(border=>border.join('|')!==borders[0].join('|')))) return false;
  const positive=value=>Number.parseFloat(value)>0;
  if(!['Top','Bottom'].some(side=>positive(css['padding'+side])) || !['Left','Right'].some(side=>positive(css['padding'+side]))) return false;
  // Figure/legend/code context and graphical contents can give the backdrop a
  // meaning that text contrast alone cannot establish. Source-backed formula
  // fallbacks are excluded because those graphics will become native formulas.
  if(element.closest('figure,figcaption,table,pre,code,blockquote') || element.querySelector('figure,figcaption,table,pre,code,blockquote,[role],[aria-label]')) return false;
  const graphics=[...element.querySelectorAll('img,svg,math,video,audio,canvas,object,embed,iframe')];
  if(graphics.some(node=>!node.closest(FORMULA_SELECTOR))) return false;
  return true;
}

function clearTextCardDecorations(body) {
  const counts={panels:0,formulas:0};
  for(const card of body.querySelectorAll('section,div')) {
    if(!framedTextCard(card) || !textReadableWithoutImage(card,card)) continue;
    const paragraphs=[...card.querySelectorAll('p,li')].filter(node=>normalizedText(node.textContent) || node.querySelector(FORMULA_SELECTOR));
    const formula=card.querySelector(FORMULA_SELECTOR) || (card.querySelector('sub,sup') && /[=≈≃≅≡∝<>≤≥]/.test(card.textContent));
    if(paragraphs.length<2 && !formula) continue;
    // Only box decoration is removed; inline highlights and all authored
    // text/formulas remain. Neither the question wording nor palette is a key.
    card.style.removeProperty('background');card.style.removeProperty('background-color');
    for(const property of Array.from(card.style)) if(property==='border'||property.startsWith('border-')) card.style.removeProperty(property);
    counts[paragraphs.length<2?'formulas':'panels']++;
  }
  return counts;
}

function containsTemplateMedia(element,selector) {
  return [...element.querySelectorAll(selector)].some(node=>!(node.localName==='svg' && !node.childElementCount && !normalizedText(node.textContent) && /^0\s+0\s+1\s+1$/.test(node.getAttribute('viewBox')||'')));
}

function removeDeclaredDecorativeImages(body,imageIndices) {
  const removed=[];
  for(const image of [...body.querySelectorAll('img')]) {
    // Small size, repetition, generic alt text and a position beside a title
    // are not proof that an image is expendable.
    if(!['presentation','none'].includes(image.getAttribute('role')?.trim().toLowerCase())) continue;
    if(image.matches(FORMULA_SELECTOR) || image.closest('figure,figcaption,table,'+FORMULA_SELECTOR) ||
       image.hasAttribute('data-sync-formula-image') || /(?:formula|latex|math|equation)/i.test(image.getAttribute('class')||'') ||
       image.getAttribute('type')==='latex' || image.getAttribute('data-type')==='latex' ||
       ['alt','title','aria-label','data-caption'].some(name=>normalizedText(image.getAttribute(name)))) continue;
    let anchor=image;
    while(anchor.parentElement!==body && !normalizedText(anchor.parentElement.textContent) && !anchor.parentElement.querySelector('svg,math,hr')) anchor=anchor.parentElement;
    if(firstCaptionCandidate(nextCaptionNode(anchor,body))) continue;
    removed.push({imageIndex:imageIndices.get(image),sourceUrl:image.getAttribute('data-src')||image.getAttribute('src')||'',reason:'explicit-presentation-role'});
    image.remove();
  }
  return removed;
}

function gridCell(css) {
  const area=css.gridArea.trim();
  if(/^[a-z_][\w-]*$/i.test(area) && !['auto','initial','inherit','unset'].includes(area)) return 'area:'+area;
  const parts=area.split('/').map(value=>value.trim());
  const row=css.gridRowStart || css.gridRow.split('/')[0].trim() || parts[0];
  const column=css.gridColumnStart || css.gridColumn.split('/')[0].trim() || parts[1];
  if(!row || !column || ['auto','initial','inherit','unset'].includes(row) || ['auto','initial','inherit','unset'].includes(column)) return '';
  return row+'|'+column;
}

// Typography-only title furniture: classify the role of a whole component,
// never a source URL, article phrase, image count, color or template dimension.
function removeTitleFurniture(body,imageIndices) {
  const removed=[];
  const protectedMedia='svg,math,table,figure,figcaption,video,audio,iframe,sup,sub,'+FORMULA_SELECTOR;
  const contentImage=image=>image.matches(FORMULA_SELECTOR) || image.closest(protectedMedia) ||
    image.hasAttribute('data-sync-formula-image') || /latex|formula|equation|math/i.test(image.className||'') ||
    image.getAttribute('type')==='latex' || image.getAttribute('data-type')==='latex' ||
    ['title','aria-label','data-caption'].some(key=>normalizedText(image.getAttribute(key))) ||
    !['','图片','image'].includes(normalizedText(image.getAttribute('alt')).toLowerCase());
  const textOnly=node=>!node.querySelector('img,'+protectedMedia) && normalizedText(node.textContent);
  const bold=node=>[...node.querySelectorAll('strong,b,h1,h2,h3,h4,h5,h6,[style]')].some(el=>
    normalizedText(el.textContent) && (el.matches('strong,b,h1,h2,h3,h4,h5,h6') || /^(bold|[6-9]00)$/.test(el.style.fontWeight)));
  const discard=(image,reason)=>{removed.push({imageIndex:imageIndices.get(image),sourceUrl:image.getAttribute('data-src')||image.getAttribute('src')||'',reason});image.remove();};
  const flow=node=>{
    for(const el of [node,...node.querySelectorAll('*')]) for(const property of Array.from(el.style||[]))
      if(/^(?:display|position|z-index|transform|aspect-ratio|overflow|grid|width|height|min-|max-|margin|padding|flex|align-self)/.test(property))el.style.removeProperty(property);
  };
  for(const grid of [...body.querySelectorAll('section,div,header')]) {
    if(!['grid','inline-grid'].includes(grid.style.display)||containsTemplateMedia(grid,protectedMedia))continue;
    const children=[...grid.children],images=[...grid.querySelectorAll('img')],texts=children.filter(textOnly);
    const pictureBranches=children.filter(node=>!normalizedText(node.textContent)&&node.querySelectorAll('img').length===1);
    if(!images.length||pictureBranches.length!==images.length||!texts.length||images.some(contentImage))continue;
    if(firstCaptionCandidate(nextCaptionNode(grid,body)))continue;
    const cells=children.filter(node=>normalizedText(node.textContent)||node.querySelector('img')).map(node=>gridCell(node.style));
    if(cells.some(cell=>!cell||cell!==cells[0]))continue;
    // The first typographic component can follow standalone opening images.
    // Earlier prose, captions, figures or semantic media mean body content.
    const before=body.ownerDocument.createRange();before.selectNodeContents(body);before.setEndBefore(grid);
    const preceding=before.cloneContents();
    if(normalizedText(preceding.textContent)||containsTemplateMedia(preceding,protectedMedia)||[...preceding.querySelectorAll('img')].some(contentImage))continue;
    if(texts.some(node=>normalizedText(node.textContent).length>80)||!texts.some(node=>bold(node)&&[node,...node.querySelectorAll('*')].some(el=>captionTextStyle(el).size>=28)))continue;
    if(!images.every(image=>{
      for(let el=image;el&&el!==grid;el=el.parentElement)if(el.style.pointerEvents==='none'&&el.style.lineHeight==='0')return true;
      return false;
    })||!textReadableWithoutImage(grid,null,2))continue;
    for(const image of images)discard(image,'noninteractive-title-poster');
    for(const branch of pictureBranches)branch.remove();
    // An uncaptioned wide banner immediately before a recognized opening
    // poster is header furniture. Width alone never classifies body images.
    for(const image of [...body.querySelectorAll('img')]){
      if(!before.intersectsNode(image)||contentImage(image))continue;
      const width=Number(image.getAttribute('data-w')||image.getAttribute('width'));
      const ratio=Number(image.getAttribute('data-ratio')) || Number(image.getAttribute('height'))/width;
      if(!(width>0&&ratio>0&&ratio<=1/3))continue;
      let anchor=image;
      while(anchor.parentElement!==body&&!normalizedText(anchor.parentElement.textContent)&&anchor.parentElement.querySelectorAll('img').length===1)anchor=anchor.parentElement;
      if(firstCaptionCandidate(nextCaptionNode(anchor,body)))continue;
      discard(image,'opening-title-banner');
    }
    flow(grid);
  }
  for(const row of [...body.querySelectorAll('section,div,header')]) {
    if(!['flex','inline-flex'].includes(row.style.display)||row.style.flexDirection==='column'||row.querySelector(protectedMedia))continue;
    const children=[...row.children],texts=children.filter(textOnly),images=[...row.querySelectorAll('img')];
    const slots=children.filter(node=>!normalizedText(node.textContent)&&node.querySelectorAll('img').length===1);
    if(texts.length!==1||!bold(texts[0])||normalizedText(row.textContent).length>100||slots.length!==images.length||images.some(contentImage))continue;
    if(firstCaptionCandidate(nextCaptionNode(row,body)))continue;
    if(images.some(image=>{
      const width=image.parentElement.style.width.match(/^([\d.]+)px$/);
      return !width || Number(width[1])<=0 || Number(width[1])>4*captionTextStyle(texts[0]).size;
    }))continue;
    const mirrored=slots.length===2&&children[0]===slots[0]&&children.at(-1)===slots[1]&&
      [...slots[1].querySelectorAll('[style]')].some(el=>/rotateY\(180deg\)|scaleX\(-1\)/i.test(el.style.transform));
    const chapter=slots.length===1&&[...texts[0].querySelectorAll('p,h1,h2,h3,h4,h5,h6')].some(el=>/^(?:part|chapter|section)\s*\d+$|^第[一二三四五六七八九十百\d]+[章节部分]$/i.test(normalizedText(el.textContent)));
    if(!mirrored&&!chapter)continue;
    for(const image of images)discard(image,mirrored?'mirrored-title-frame':'chapter-title-badge');
    for(const slot of slots)slot.remove();
  }
  return removed;
}

function markCompositeLayouts(body) {
  // Internal markers are recomputed from the retained layout, never trusted
  // merely because untrusted source HTML supplied their attribute name.
  for(const node of body.querySelectorAll('[data-sync-composite-layout]')) node.removeAttribute('data-sync-composite-layout');
  let count=0;
  for(const grid of body.querySelectorAll('section,div,figure')) {
    if(!['grid','inline-grid'].includes(grid.style.display)) continue;
    const cells=new Map();
    for(const child of grid.children) {
      const key=gridCell(child.style);
      if(!key || (!normalizedText(child.textContent) && !child.matches('img,svg,math') && !child.querySelector('img,svg,math,'+FORMULA_SELECTOR))) continue;
      const cell=cells.get(key)||[];cell.push(child);cells.set(key,cell);
    }
    if(![...cells.values()].some(cell=>cell.length>1 && cell.some(node=>node.matches('img,svg,math')||node.querySelector('img,svg,math')))) continue;
    grid.setAttribute('data-sync-composite-layout','grid-overlay');count++;
    for(const node of [grid,...grid.querySelectorAll('*')]) {
      if(!node.style) continue;
      // The renderer freezes the untransformed layout, then restores supported
      // 2D transforms. 3D and unresolved geometry must never become a flat copy.
      const unsupported=['translate','rotate','scale','perspective'].filter(property=>{
        const value=node.style.getPropertyValue(property).trim().toLowerCase();
        return value && !['none','initial','unset'].includes(value);
      });
      const transform=node.style.transform.trim();
      if(transform && !['none','initial','unset'].includes(transform.toLowerCase()) && !/^(?:(?:matrix|translate[xy]?|scale[xy]?|rotatez?|skew[xy]?)\(\s*[-+\d.e%\s,a-z]+\)\s*)+$/i.test(transform)) unsupported.push('transform');
      if(node.style.getPropertyValue('-webkit-transform').trim() && !transform) unsupported.push('-webkit-transform');
      const position=node.style.position;
      if(position && !['static','initial','unset'].includes(position)) unsupported.push('position');
      for(const property of COMPOSITE_STYLE_PROPS) if(/url\s*\(|expression\s*\(|@import|javascript:|behavior:|var\s*\(/i.test(node.style.getPropertyValue(property))) unsupported.push(property);
      if(unsupported.length) {
        const reason='叠层排版的 '+[...new Set(unsupported)].join('/')+' 几何样式尚不支持';
        const existing=node.getAttribute('data-sync-unsupported');
        node.setAttribute('data-sync-unsupported',existing&&!existing.includes(reason)?existing+'、'+reason:existing||reason);
      }
    }
  }
  return count;
}

function characterCards(row) {
  const cards=[...row.children];
  if(cards.length<2 || cards.length>12 || cards.some(card=>card.style.display!=='inline-block') || containsTemplateMedia(row,'img,svg,math,table,[data-formula],[data-latex]')) return null;
  if([row,...row.querySelectorAll('*')].some(node=>hasBackgroundImage(node.style)||node.hasAttribute('data-lazy-bgimg'))) return null;
  const matches=cards.map(card=>normalizedText(card.textContent).match(/^(?:[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]{1,12})?([\u3400-\u9fff])$/i));
  if(matches.some(match=>!match)) return null;
  const square=style=>/^[\d.]+(?:px|em|rem)$/.test(style.width) && Number.parseFloat(style.width)>0 && style.width===style.height && ['solid','dashed','dotted','double'].includes(style.borderStyle);
  const letters=cards.map((card,index)=>[...card.querySelectorAll('*')].find(node=>square(node.style)&&normalizedText(node.textContent)===matches[index][1]));
  return letters.some(letter=>!letter)?null:{cards,letters,text:matches.map(match=>match[1]).join('')};
}

function flattenCharacterCardHeadings(body) {
  let count=0;
  for(const row of [...body.querySelectorAll('section,div')]) {
    if(!body.contains(row)) continue;
    const group=characterCards(row);
    if(!group) continue;
    const paragraph=body.ownerDocument.createElement('p');
    paragraph.setAttribute('style',row.getAttribute('style')||'');paragraph.style.textAlign=row.style.textAlign||'center';
    const appendInline=(source,parent)=>{
      if(source.nodeType===3){parent.append(source.cloneNode());return;}
      if(source.nodeType!==1) return;
      const tag=['strong','b','em','i','u','s','sup','sub','br'].includes(source.localName)?source.localName:'span';
      const copy=body.ownerDocument.createElement(tag);
      copy.setAttribute('style',source.getAttribute('style')||'');
      for(const property of Array.from(copy.style)) if(/^(?:display|position|transform|width|height|min-|max-|margin|padding|border|flex|grid)/.test(property)) copy.style.removeProperty(property);
      for(const child of source.childNodes) appendInline(child,copy);
      parent.append(copy);
    };
    for(const card of group.cards) appendInline(card,paragraph);
    row.replaceWith(paragraph);count++;
  }
  return count;
}

const CAPTION_BLOCKS = new Set('P DIV SECTION ARTICLE MAIN HEADER FOOTER H1 H2 H3 H4 H5 H6 BLOCKQUOTE FIGURE FIGCAPTION UL OL LI PRE HR'.split(' '));
const CAPTION_BLOCK_SELECTOR = [...CAPTION_BLOCKS].join(',');

function captionTextStyle(node) {
  const ancestors=[];
  for (let element=node.nodeType===1?node:node.parentElement;element;element=element.parentElement) ancestors.unshift(element);
  let size=17,color='',align='',weight='normal',fontStyle='normal',decoration='',background='';
  for (const element of ancestors) {
    if (element.style?.color && element.style.color!=='inherit') color=element.style.color;
    if (element.style?.textAlign) align=element.style.textAlign;
    const font=element.style?.fontSize.match(/^([\d.]+)(px|pt|em|rem|%)$/);
    if (font) {const n=Number(font[1]);size=font[2]==='px'?n:font[2]==='pt'?n*4/3:font[2]==='%'?size*n/100:font[2]==='em'?size*n:17*n;}
    if (['B','STRONG'].includes(element.tagName)) weight='bold';
    if (['I','EM'].includes(element.tagName)) fontStyle='italic';
    if (element.tagName==='U') decoration+=' underline';
    if (['S','STRIKE','DEL'].includes(element.tagName)) decoration+=' line-through';
    if (element.style?.fontWeight && element.style.fontWeight!=='inherit') weight=element.style.fontWeight;
    if (element.style?.fontStyle && element.style.fontStyle!=='inherit') fontStyle=element.style.fontStyle;
    const ownDecoration=element.style?.textDecorationLine || element.style?.textDecoration;
    if (ownDecoration && ownDecoration!=='none' && ownDecoration!=='inherit') decoration+=` ${ownDecoration}`;
    const ownBackground=element.style?.backgroundColor;
    if (ownBackground && ownBackground!=='transparent' && (cssColor(ownBackground)?.[3]??1)>0) background=ownBackground;
  }
  return {size,color,align,weight,fontStyle,decoration:decoration.trim(),background};
}

function captionTextNodes(node) {
  if (node.nodeType===3) return normalizedText(node.textContent)?[node]:[];
  const walker=node.ownerDocument.createTreeWalker(node,4), nodes=[];
  while(walker.nextNode()) if(normalizedText(walker.currentNode.textContent)) nodes.push(walker.currentNode);
  return nodes;
}

function captionCandidate(node) {
  const text=String(node.textContent||'').trim();
  if (!text || normalizedText(text).length>300 || /^(?:by\s|作者\s*[:：]|译者\s*[:：]|编辑\s*[:：]|校对\s*[:：]|审核\s*[:：]|参考文献|参考资料|免责声明|版权声明)/i.test(text)) return false;
  if (node.nodeType===1) {
    const forbidden='img,svg,math,table,figure,figcaption,h1,h2,h3,h4,h5,h6,pre,code,blockquote,ul,ol,li,hr,[data-formula],[data-latex],[data-sync-unsupported],a[data-sync-source-link]';
    if(node.matches(forbidden)||node.querySelector(forbidden)) return false;
  }
  return captionTextNodes(node).every(textNode=>{
    const style=captionTextStyle(textNode),color=cssColor(style.color);
    if (!color || style.size>15 || style.size<9 || color[3]<0.7) return false;
    const channels=color.slice(0,3), mean=channels.reduce((a,b)=>a+b,0)/3;
    return mean>=90 && mean<=190 && Math.max(...channels)-Math.min(...channels)<=40;
  });
}

function meaningfulCaptionNode(node) {
  if(node.nodeType===3) return Boolean(normalizedText(node.textContent));
  return node.nodeType===1 && (normalizedText(node.textContent)||node.matches('img,svg,math,hr,figure')||node.querySelector('img,svg,math,hr,figure'));
}

function nextCaptionNode(node,body,previous=false) {
  while(node&&node!==body) {
    let sibling=previous?node.previousSibling:node.nextSibling;
    while(sibling&&!meaningfulCaptionNode(sibling)) sibling=previous?sibling.previousSibling:sibling.nextSibling;
    if(sibling) return sibling;
    node=node.parentNode;
  }
  return null;
}

function firstCaptionCandidate(node) {
  while(node) {
    // A following section can contain a caption and several body paragraphs.
    // Move only its first standalone leaf block, never the whole section or a
    // grey inline prefix from an otherwise ordinary paragraph.
    const hasBlocks=node.nodeType===1 && node.querySelector(CAPTION_BLOCK_SELECTOR);
    if(!hasBlocks) return captionCandidate(node)?node:null;
    if(node.nodeType!==1 || node.matches('img,svg,math,table,figure,figcaption,h1,h2,h3,h4,h5,h6,pre,code,blockquote,ul,ol,li,hr')) return null;
    const first=[...node.childNodes].find(meaningfulCaptionNode);
    if(first?.nodeType!==1 || !CAPTION_BLOCKS.has(first.tagName) && !first.querySelector(CAPTION_BLOCK_SELECTOR)) return null;
    node=first;
  }
  return null;
}

function associateImageCaptions(body) {
  let associated=0,ambiguous=0;
  for(const image of [...body.querySelectorAll('img')]) {
    if(image.closest('[data-sync-composite-layout]')) continue;
    if(image.closest(FORMULA_SELECTOR) || image.hasAttribute('data-caption') || image.closest('figure')?.querySelector('figcaption')) continue;
    let container=image.parentElement;
    while(container!==body&&!CAPTION_BLOCKS.has(container.tagName)) container=container.parentElement;
    // A multi-image paragraph is a group. Never assign its shared description to
    // whichever image happens to be last, or insert a figure inside a paragraph.
    const hasChildBlocks=[...container.children].some(child=>CAPTION_BLOCKS.has(child.tagName));
    if(container!==body && !hasChildBlocks && container.querySelectorAll('img').length!==1) continue;
    if(normalizedText(container.textContent)&&!hasChildBlocks) continue;
    let anchor=image;
    while(anchor.parentElement!==body && anchor.parentElement && !normalizedText(anchor.parentElement.textContent) && anchor.parentElement.querySelectorAll('img').length===1 && !anchor.parentElement.querySelector('svg,math,hr')) anchor=anchor.parentElement;
    const caption=firstCaptionCandidate(nextCaptionNode(anchor,body));
    if(!caption) continue;
    const validParent=element=>element===body || ['DIV','SECTION','ARTICLE','MAIN','HEADER','FOOTER','LI','BLOCKQUOTE','FIGURE'].includes(element.tagName);
    // Some saved pages put the image block and caption inside one styling span.
    // Lift the complete one-image/one-caption pair, retaining the span, rather
    // than inserting an invalid figure inside an inline element or paragraph.
    while(!validParent(anchor.parentElement) && anchor.parentElement.querySelectorAll('img').length===1 && normalizedText(anchor.parentElement.textContent)===normalizedText(caption.textContent) && !anchor.parentElement.querySelector('svg,math,hr,[data-formula],[data-latex]')) anchor=anchor.parentElement;
    if(!validParent(anchor.parentElement)) continue;
    const previous=nextCaptionNode(anchor,body,true);
    if(/上图|下图|两张图|两幅图|两图/.test(caption.textContent) && previous?.nodeType===1 && !normalizedText(previous.textContent) && (previous.matches('img')||previous.querySelector('img'))) {ambiguous++;continue;}
    // Carry the style context outside the moved node; its own complete markup
    // stays intact, including relative sizes and bold/sub/sup fallback content.
    const inherited=captionTextStyle(caption.parentElement), oldParent=caption.parentElement;
    const figure=anchor.tagName==='FIGURE'?anchor:body.ownerDocument.createElement('figure');
    if(figure!==anchor){anchor.before(figure);figure.append(anchor);}
    const figcaption=body.ownerDocument.createElement('figcaption');
    figcaption.style.color=inherited.color || 'black';
    figcaption.style.fontSize=`${inherited.size}px`;
    figcaption.style.fontWeight=inherited.weight;
    figcaption.style.fontStyle=inherited.fontStyle;
    if(inherited.decoration)figcaption.style.textDecoration=inherited.decoration;
    if(inherited.background)figcaption.style.backgroundColor=inherited.background;
    if(inherited.align)figcaption.style.textAlign=inherited.align;
    figcaption.append(caption);
    figure.append(figcaption);
    // Avoid leaving wrappers that a second cleanup would remove differently.
    let empty=oldParent;
    while(empty!==body && empty!==figure && EMPTY_BLOCKS.has(empty.localName) && !meaningfulCaptionNode(empty) && !empty.querySelector('[data-formula],[data-latex],[data-sync-unsupported],[data-sync-background-url]')) {
      const parent=empty.parentElement; empty.remove(); empty=parent;
    }
    associated++;
  }
  return {associated,ambiguous};
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

function safeSourceHref(raw) {
  const value=String(raw||'').trim();
  return normalizeSourceLink(value.startsWith('//')?`https:${value}`:value);
}

function originalSourceHref(anchor) {
  const href=safeSourceHref(anchor.getAttribute('href'));
  if(!href || !normalizedText(anchor.textContent)) return '';
  const paragraph=anchor.closest('p,section,div');
  if(!paragraph || paragraph.closest('pre,code') || paragraph.querySelector('img,svg,math,table') || paragraph.querySelectorAll('a').length!==1 || normalizedText(paragraph.textContent).length>500) return '';
  // A source citation is one paragraph: the exact source label, one anchor and
  // optional final punctuation. An incoming marker alone grants no exception.
  if([...paragraph.querySelectorAll('p,section,div,h1,h2,h3,h4,h5,h6,li,blockquote')].length) return '';
  const before=anchor.ownerDocument.createRange(), after=anchor.ownerDocument.createRange();
  before.selectNodeContents(paragraph);before.setEndBefore(anchor);
  after.selectNodeContents(paragraph);after.setStartAfter(anchor);
  if(!/^原文链接[:：]$/.test(normalizedText(before.toString())) || !/^[。.!！]?$/.test(normalizedText(after.toString()))) return '';
  return href;
}

function removeComponentHints(body) {
  let removed=0;
  for(const node of [...body.querySelectorAll('p,section,div')]) {
    if(!body.contains(node) || node.closest('pre,code') || normalizedText(node.textContent)!=='左右滑动查看更多' || containsTemplateMedia(node,'img,svg,math,table,[data-formula],[data-latex]')) continue;
    node.remove();removed++;
  }
  return removed;
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
  names.push(...scriptAlbumTitles(document, raw=>decodeSourceString(raw,document)));
  return [...new Set(names.map(value => String(value || '').replace(/^(?:合集|专栏|文集)\s*[:：]\s*/, '').replace(/^#/, '').replace(/\s*[·•]\s*目录\s*$/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()).filter(value => value && value.length <= 80))];
}

function independentStatementText(value) {
  const text=normalizedText(value).replace(/^(?:立场声明|特别声明|声明)[:：]?/,'');
  if(!text || text.length>180) return false;
  return /^(?:(?:翻译内容|译文|本文(?:内容|观点)?|文章(?:内容|观点)?|内容|文中(?:内容|观点))?仅?代表作者(?:个人)?(?:观点|看法|立场)[，,。；;！!]*)?(?:不代表[^，,。；;！!？?：:]{1,50}(?:立场|观点)[，,。；;！!]*)?$/.test(text);
}

function removeStanceStatements(body) {
  let removed=0;
  for(const node of [...body.querySelectorAll('p,section,div,blockquote')]) {
    if(!body.contains(node) || node.querySelector('img,svg,math,table,[data-formula],[data-latex]') || !independentStatementText(node.textContent)) continue;
    const heading=node.previousElementSibling;
    if(heading && /^(?:立场声明|特别声明|声明)[:：]?$/.test(normalizedText(heading.textContent)) && !heading.querySelector('img,svg,math,table') && /^(?:H[1-6]|P)$/.test(heading.tagName)) {heading.remove();removed++;}
    node.remove();removed++;
  }
  return removed;
}

function removeOpeningInteractionLead(body) {
  const first=[...body.querySelectorAll('p')].find(p=>normalizedText(p.textContent));
  if(!first || first.querySelector('img,svg,math,table,[data-formula],[data-latex]')) return 0;
  const text=normalizedText(first.textContent);
  if(!/^认真阅读下面的文章[，,、]?并思考文末互动提出的问题/.test(text) || text.length>400 || !normalizedText(body.textContent).startsWith(text)) return 0;
  first.remove();return 1;
}

function isTailHeading(element,body) {
  if (containsTemplateMedia(element,'img,svg,math,video,audio')) return false;
  let text = (characterCards(element)?.text || normalizedText(element.textContent)).toLowerCase();
  text = text.replace(/^[\-—–·•|｜:：【】\[\]《》「」『』<>()（）]+|[\-—–·•|｜:：【】\[\]《》「」『』<>()（）]+$/g, '');
  if(['上期回顾', '往期回顾', '近期热门文章top10','上期也精彩'].includes(text)) return true;
  if(text==='投票' && /^h[1-6]$/.test(element.localName)) return true;
  if(text!=='福利时间' && !/^互动问题(?:[:：].{0,160})?$/.test(text)) return false;
  // These are optional end columns, not incidental mentions in the article or
  // standalone imported titles. Require substantial preceding article content.
  const before=element.ownerDocument.createRange();before.setStart(body,0);before.setEndBefore(element);
  return normalizedText(before.toString()).length>=40;
}

function trimTail(body) {
  const matches=element=>isTailHeading(element,body);
  const candidates = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,section,div,span,strong,b')].filter(matches);
  const found = candidates.find(element => ![...element.querySelectorAll('*')].some(matches));
  if (!found) return false;
  let boundary = found;
  while (boundary.parentElement && boundary.parentElement !== body && matches(boundary.parentElement)) boundary = boundary.parentElement;
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
  const inComposite=Boolean(element.closest('[data-sync-composite-layout]'));
  for (const property of Array.from(probe.style)) {
    const value = probe.style.getPropertyValue(property).trim();
    if (property === 'background-image' && element.hasAttribute('data-sync-background-url')) {
      element.style.setProperty('background-image', `url("${element.getAttribute('data-sync-background-url').replace(/"/g, '%22')}")`);
      continue;
    }
    if (property === 'background-image' && /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(value) && !/url\s*\(|expression\s*\(|var\s*\(/i.test(value)) {
      element.style.setProperty(property,value);
      continue;
    }
    const compositeProperty=inComposite && COMPOSITE_STYLE_PROPS.has(property);
    const unsafe=/url\s*\(|expression\s*\(|@import|javascript:|behavior:|var\s*\(/i.test(value);
    if (!(STYLE_PROPS.has(property)||compositeProperty) || unsafe) continue;
    element.style.setProperty(property, value);
  }
  // JSDOM enumerates a background shorthand while Chromium can expose expanded
  // longhands. Read its solid color explicitly so both retain the same backdrop.
  const solidBackground=probe.style.backgroundColor;
  if (solidBackground && !/url\s*\(|expression\s*\(|var\s*\(/i.test(solidBackground)) element.style.backgroundColor=solidBackground;
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
    captions: body.querySelectorAll('figure > figcaption').length,
    sourceLinks:body.querySelectorAll('a[data-sync-source-link="true"][href]').length,
  };
}

function getBlockingIssues(body) {
  const issues = new Set();
  if ([...body.querySelectorAll('svg')].some(node => !node.closest('[data-formula],[data-latex]'))) issues.add('原文含 SVG 图形或公式，需要先转成图片才能可靠同步到 B 站。');
  if ([...body.querySelectorAll('math')].some(node => !node.closest('[data-formula],[data-latex]'))) issues.add('原文含 MathML 公式，需要先转换为 B 站可用的公式或图片。');
  if (body.querySelector('table')) issues.add('原文含表格，B 站的原生排版兼容性需处理后再同步。');
  for (const node of body.querySelectorAll('[data-sync-unsupported]')) issues.add(`原文含暂不支持的 ${node.getAttribute('data-sync-unsupported')} 内容，已保留位置提示，请处理后同步。`);
  if (body.querySelector('[data-sync-background-url]')) issues.add('原文含 CSS 背景图，需要转换对应局部排版后同步。');
  if (body.querySelector('[data-sync-gradient="true"]')) issues.add('原文含渐变背景，需要转换对应局部排版后同步。');
  if (body.querySelector('[data-sync-composite-layout="grid-overlay"]')) issues.add('原文含叠层图片排版，需要保留完整组合并转换局部后同步。');
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
  const imageIndices=new Map([...body.querySelectorAll('img')].map((image,index)=>[image,index]));
  const stats = { removedLinks: 0, removedEmptyBlocks: 0, removedImagePlaceholders: 0, removedEmptySvg: 0, removedTransparentBackgrounds: 0, removedDecorativeBackgrounds: 0, removedSmallDecorations: 0, removedHiddenElements: removeHiddenContent(body) };
  stats.removedStanceStatements=removeStanceStatements(body);
  stats.removedOpeningLeads=removeOpeningInteractionLead(body);
  stats.removedComponentHints=removeComponentHints(body);
  stats.removedLiveNotices=0;
  for(const card of body.querySelectorAll('mp-common-videosnap[data-type="live"][data-noticeid]')) {
    if(!card.getAttribute('data-noticeid').startsWith('finderlivenotice-'))continue;
    card.remove();stats.removedLiveNotices++;
  }
  stats.trimmedTail=trimTail(body)?1:0;
  const gradients=normalizeGradientBackgrounds(body);
  stats.removedDecorativeBackgrounds+=gradients.decorative;
  stats.adaptedGradientMarkers=gradients.markers;
  stats.flattenedCharacterHeadings=flattenCharacterCardHeadings(body);
  const removedDecorativeImages=[...removeDeclaredDecorativeImages(body,imageIndices),...removeTitleFurniture(body,imageIndices)];
  stats.removedDecorativeImages=removedDecorativeImages.length;
  const cardDecorations=clearTextCardDecorations(body);
  stats.removedAnswerPanelBackgrounds=cardDecorations.panels;
  stats.removedFormulaCardDecorations=cardDecorations.formulas;
  stats.compositeLayouts=markCompositeLayouts(body);
  if(stats.removedDecorativeImages) warnings.push(`已略去 ${stats.removedDecorativeImages} 张装饰图片，保留标题和正文配图。`);
  if(stats.flattenedCharacterHeadings) warnings.push('已将横排单字卡片整理为一行文字，保留文字与拼音。');
  if(stats.removedAnswerPanelBackgrounds) warnings.push(`已略去 ${stats.removedAnswerPanelBackgrounds} 处正文卡片的装饰底色和边框，保留正文、公式和文字高亮。`);
  if(stats.removedFormulaCardDecorations) warnings.push('已略去公式卡片的装饰底色和边框，保留公式文字、颜色和上下标。');
  if(stats.compositeLayouts) warnings.push('有叠层图片无法仅凭结构判断是否为装饰，已保留完整组合，需转换对应局部排版。');
  if(stats.adaptedGradientMarkers) warnings.push(`已将 ${stats.adaptedGradientMarkers} 处文字渐变底纹适配为原生高亮，保留底纹颜色。`);
  if(stats.removedStanceStatements) warnings.push('已清除独立的立场声明，保留作者、编辑和参考资料。');
  if(stats.removedOpeningLeads) warnings.push('已清除开头的微信互动赠书引导。');
  if(stats.removedComponentHints) warnings.push('已清除微信组件的滑动提示。');
  if(stats.removedLiveNotices) warnings.push('已清除视频号直播预约卡片。');
  if (stats.trimmedTail) warnings.push('已删除回顾、福利互动或投票等尾部栏目及其后面的内容。');

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
      const sourceHref=originalSourceHref(element);
      if(sourceHref) {
        element.setAttribute('href',sourceHref);
        element.setAttribute('data-sync-source-link','true');
      } else {
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
      let keep = ['style','title','dir','lang','role','aria-label'].includes(key);
      if (tag === 'img' && IMAGE_ATTRS.has(key)) keep = true;
      if (tag === 'a' && ['href','data-sync-source-link'].includes(key)) keep = true;
      if (SVG_TAGS.has(tag) && SVG_ATTRS.has(key)) keep = true;
      if (MATH_TAGS.has(tag) && MATH_ATTRS.has(key)) keep = true;
      if (['td', 'th'].includes(tag) && ['colspan', 'rowspan'].includes(key)) keep = true;
      if (tag === 'ol' && key === 'start') keep = true;
      if (key === 'data-sync-unsupported') keep = true;
      if (['data-formula', 'data-latex', 'data-sync-background-url','data-sync-composite-layout','data-sync-gradient'].includes(key)) keep = true;
      if (key.startsWith('on') || /javascript:|expression\s*\(/i.test(attribute.value) && !['src','href'].includes(key) || /url\s*\(/i.test(attribute.value) && !['src','style','href'].includes(key)) keep = false;
      if (!keep) element.removeAttribute(attribute.name);
    }
  }

  const walker = document.createTreeWalker(body, 4 /* SHOW_TEXT */);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    if (node.parentElement?.closest('svg, math')) continue;
    if(!node.parentElement?.closest('a[data-sync-source-link="true"][href]')) node.textContent = node.textContent.replace(/(?:https?:\/\/|www\.)[^\s<>"“”‘’\u3000]+/gi, match => {
      stats.removedLinks++;
      const trailing = match.match(/[，。！？、；：）】》」』,.!?;:]+$/)?.[0] || '';
      return trailing;
    });
    node.textContent = node.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  // A span containing BR is an authored line break in code/navigation or an
  // inline paragraph, not an empty spacer. Unwrap it before empty-node cleanup
  // so the break survives and adjacent blank breaks can still be collapsed.
  for(const element of [...body.querySelectorAll('span,strong,b,em,i,u,s')].reverse()) {
    if(normalizedText(element.textContent) || !element.querySelector('br')) continue;
    let container=element.closest('p,pre,code,li,h1,h2,h3,h4,h5,h6');
    if(!container) {
      const block=element.closest('section,div');
      if(block && ![...block.children].some(child=>CAPTION_BLOCKS.has(child.tagName))) container=block;
    }
    if(container && normalizedText(container.textContent) && [...element.childNodes].every(node=>node.nodeType===3&&!normalizedText(node.textContent)||node.nodeType===1&&node.localName==='br')) element.replaceWith(...element.childNodes);
  }
  // Work from leaves to roots so nested empty WeChat spacer sections also disappear.
  for (const element of [...body.querySelectorAll('*')].reverse()) {
    if (EMPTY_BLOCKS.has(element.localName) && !element.closest('[data-sync-composite-layout]') && !normalizedText(element.textContent) && !element.querySelector('img,svg,math,hr,[data-sync-unsupported],[data-sync-background-url],[data-sync-gradient],[data-formula],[data-latex]') && !element.matches('[data-sync-background-url],[data-sync-gradient],[data-sync-unsupported],[data-formula],[data-latex]')) {
      element.remove(); stats.removedEmptyBlocks++;
    }
  }
  // Preserve line breaks within a text paragraph, while collapsing blank lines.
  for (const br of [...body.querySelectorAll('br')]) {
    if(!body.contains(br)) continue;
    let container=br.closest('p,pre,code,li,h1,h2,h3,h4,h5,h6');
    if(!container) {
      const block=br.closest('section,div');
      if(block && ![...block.children].some(child=>CAPTION_BLOCKS.has(child.tagName))) container=block;
    }
    if(container) {
      const before=document.createRange(), after=document.createRange();
      before.selectNodeContents(container);before.setEndBefore(br);
      after.selectNodeContents(container);after.setStartAfter(br);
      const meaningful=range=>normalizedText(range.toString()) || range.cloneContents().querySelector('img,svg,math,[data-formula],[data-latex]');
      if(!meaningful(before)||!meaningful(after)) {br.remove();stats.removedEmptyBlocks++;continue;}
    }
    let previous = br.previousSibling;
    while (previous?.nodeType === 3 && !normalizedText(previous.textContent)) previous = previous.previousSibling;
    if (previous?.nodeType === 1 && previous.localName === 'br') { br.remove(); stats.removedEmptyBlocks++; }
  }
  const captions=associateImageCaptions(body);
  if(captions.associated) warnings.push(`已将 ${captions.associated} 处图片下方的灰色小字识别为图注。`);
  if(captions.ambiguous) warnings.push('有图注同时描述前面的多张图片，已保留为正文，避免关联到错误图片。');
  if (stats.removedLinks) warnings.push(`已清除 ${stats.removedLinks} 处外链（保留链接文字和图片）。`);
  if (stats.removedImagePlaceholders) warnings.push(`已清除 ${stats.removedImagePlaceholders} 个没有内容的微信图片占位标签。`);
  if (stats.removedDecorativeBackgrounds || stats.removedSmallDecorations) warnings.push(`已略去 ${stats.removedDecorativeBackgrounds+stats.removedSmallDecorations} 处装饰背景，保留正文文字和内容图片。`);
  const localAssets = [...body.querySelectorAll('img[data-local-path]')].map(img => ({sourceUrl: img.getAttribute('src'), localPath: img.getAttribute('data-local-path')}));
  return { html: body.innerHTML.trim(), warnings, blockingIssues: getBlockingIssues(body), stats: { ...stats, ...summarize(body) }, localAssets, removedDecorativeImages };
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
