/** Article extraction and loss-aware cleanup. No requests or page scripts are executed. */
import {scriptAlbumTitles} from './source-metadata.js';
const HTML_TAGS = new Set('p div section article main header footer figure figcaption span strong b em i u s strike del sup sub br hr img h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr td th caption colgroup col'.split(' '));
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

function textReadableWithoutImage(element, omittedSolidBackground = null) {
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

function pixelsEqual(value,pixels) {
  return /^\d+(?:\.\d+)?(?:px)?$/.test(String(value)) && Number.parseFloat(value)===pixels;
}

function cornersEqual(css,pixels) {
  return ['TopLeft','TopRight','BottomRight','BottomLeft'].every(corner=>String(css[`border${corner}Radius`]||css.borderRadius).split(/\s+/).every(value=>pixelsEqual(value,pixels)));
}

function hasBackgroundImage(css) {
  // Chromium exposes the implicit image reset from background:<solid> as
  // "initial"; JSDOM often exposes an empty value. This non-inherited property
  // also resets to none for "unset". URLs, gradients and inherit stay protected.
  return !['','none','initial','unset'].includes(css.backgroundImage.trim().toLowerCase());
}

function clearReviewedAnswerPanelBackgrounds(body) {
  let removed=0;
  const isColor=(value,r,g,b)=>{const color=cssColor(value);return color&&color[0]===r&&color[1]===g&&color[2]===b&&color[3]===1;};
  for(const panel of body.querySelectorAll('section')) {
    const css=panel.style;
    // This reviewed question/answer template uses a pale decorative container
    // around several ordinary paragraphs. Do not generalize to inline highlights,
    // independent formula cards or white text supported by a colored heading.
    if(!/^答[:：]/.test(normalizedText(panel.textContent)) || panel.querySelectorAll('p,ol,ul').length<2) continue;
    if(!isColor(css.backgroundColor,239,239,246) || !isColor(css.color,62,62,62) || !['400','normal'].includes(css.fontWeight)) continue;
    if(!cornersEqual(css,6) || ['Top','Right','Bottom','Left'].some(side=>!pixelsEqual(css[`padding${side}`],10)) || !pixelsEqual(css.marginTop,20) || !pixelsEqual(css.marginBottom,20) || !pixelsEqual(css.marginLeft,0) || !pixelsEqual(css.marginRight,0)) continue;
    if(['Top','Right','Bottom','Left'].some(side=>css[`border${side}Width`]!=='2px'||css[`border${side}Style`]!=='solid'||!isColor(css[`border${side}Color`],46,49,145))) continue;
    if(hasBackgroundImage(css) || panel.hasAttribute('data-lazy-bgimg') || panel.hasAttribute('data-sync-background-url')) continue;
    if(!textReadableWithoutImage(panel,panel)) continue;
    css.removeProperty('background');css.removeProperty('background-color');removed++;
  }
  return removed;
}

function clearReviewedFormulaCardDecorations(body) {
  let removed=0;
  const isColor=(value,r,g,b)=>{const color=cssColor(value);return color&&color[0]===r&&color[1]===g&&color[2]===b&&color[3]===1;};
  for(const card of body.querySelectorAll('section')) {
    const css=card.style, scripts=[...card.querySelectorAll('sub')];
    // This reviewed formula's two subscripts and brown text remain native. The
    // cream card and border are decoration; unknown colored cards stay intact.
    if(normalizedText(card.textContent)!=='ΔF=Fpeak−Fbaseline' || scripts.length!==2 || scripts[0].textContent!=='peak' || scripts[1].textContent!=='baseline') continue;
    if(card.querySelector('img,svg,math,table,[data-formula],[data-latex]') || hasBackgroundImage(css)) continue;
    if(!isColor(css.backgroundColor,252,248,243) || !isColor(css.color,130,66,46) || css.fontSize!=='20px' || css.textAlign!=='center' || !cornersEqual(css,10) || !pixelsEqual(css.paddingTop,18) || !pixelsEqual(css.paddingBottom,18) || !pixelsEqual(css.paddingLeft,12) || !pixelsEqual(css.paddingRight,12)) continue;
    if(['Top','Right','Bottom','Left'].some(side=>css[`border${side}Width`]!=='1px'||css[`border${side}Style`]!=='solid'||!isColor(css[`border${side}Color`],233,219,207))) continue;
    if(!textReadableWithoutImage(card,card)) continue;
    css.removeProperty('background');css.removeProperty('background-color');
    for(const property of Array.from(css)) if(property==='border'||property.startsWith('border-')) css.removeProperty(property);
    removed++;
  }
  return removed;
}

// Reviewed template assets: transparent leaves, dots and brush shapes only.
// Identity plus structure is required; unknown collages are never deleted.
const REVIEWED_COVER_ORNAMENTS = new Set([
  "Q5JJsLWYMJUgWzYQ4YibDBNQnPvFy5a4tyzWtTELMFQhOQcHC8VhSt8dvdqc7XhQRibqcErGcdEyLKVQ9Ly057zDrBKgNfsNDFPu53zZyn0tE",
  "Q5JJsLWYMJVib8nfqMDibiaiaoEEO2iaiaqO4Fric7nQCJCQxZUbXbaLibckEAT44TVdR297YYvGtSTQJ2bibSIpz83T2N6zxicEM8jp922M0z6tblpmk",
  "Q5JJsLWYMJUXV0nNxkrHV5jARdynE0XodLyh1f1F0ZtQsDItzRXhBq4Bwl3PNiaCMxKt8ROAaibgDibW2Piby8MCmL2icsuuJkibVAKqBl2b8KZy4",
  "Q5JJsLWYMJXgfaiarNOHWFD2zsarngWsCFSQ4XDIBicXvSjTnSaImLlPib5sicgSO7LmBwlU1YjdXSbqJK1BYQZHGsBHIKIR3fEyYAN5fB0WQTo",
  "Q5JJsLWYMJVymW3L5EdOeQwJiaabS39CRr1xnGZuXBjmbeGicUtqFnj4U8icQeDAMk3HK6FlGDL2W41p06Dk7Oibkw75XVTjBRQlicfNItib7dmz0",
  "Q5JJsLWYMJUibnCc0SwNCjZYDXpy9EJzD3FzXpiae39SJRagYNDtPbOGRQhQG0oKCibics9RChWv0GhPCKUW7ZsvQEwKiawp3xKeJ0w6QT2xFZVY",
  "Q5JJsLWYMJUm2lZD0zJLVLXT6YnpYUicLTvxicCPK0YmurOMuzMV40m0uaMRW0JOwJwd2sa2qt6ZDVTtjGia4iaiciaTwoNiaJPNLh8l4DN0IAkRYE",
  "Q5JJsLWYMJV30mwjicRXXnzVpRcUFzGYegcVh7vnwPF31picqUxskCrxwXibx8rXKCtjSn9ofcHCA1QKDSL5rPhESLE7OJuqYrr0JKVyM5K10E",
  "Q5JJsLWYMJWS9l5PL5eGAPTnia3lpNDckFzicXGYQHWB7bDlfOUzrIic0TaCUmdaoIRBIQgEj3TyP6fJKHNxB8jicmcS7cHWaoSRahzZ1kdzn6I",
  "Q5JJsLWYMJUHCcBRrQVjricwZNiaVyzrkEEWOAwWPLw1KrVAE0X5R0BibGWoT8qeRTVzTWoWqgXFff7WbYSeav5I5nuZ65qM3mVduLUvULILic8",
  "Q5JJsLWYMJUe6LrN9E3rx3LPXkZDK4J9RibicOGtN2WOWUV5l6ofOvBiaDuDD9vNAqRmJdfKZSAmOQasXYb91SqjmYnyy5mGwt1ibr7DSmmQWSA",
  "Q5JJsLWYMJXD5snfggprIKX1n4cH9mm5na9Wkxf7t7zeAu8gF3ciaic3oPP1HmUoeGibHjLaevBlVpKvr1h9JhoLRd0HcSfgOrgecXibQVbpDk8",
  "Q5JJsLWYMJWvkatACDQ06oBFkWIqST12ZHYe1icsf3tuesNJK0FDKKZXDPpcn6nyDWVqadL7kXziaos0WzSch9ZTteCZvjcATic7Uh8ia6V2Cvc",
  "Q5JJsLWYMJX8YjXmljjRVAJplicrgdg4R2DSP4Z8wSibPMiaOcPRIsPxo4X222dqicaxCIAdN8XLHY1ylQQfynSlOCTJrW4nAXF1HHm2cucXndk"
]);

function ornamentAssetId(image) {
  try {
    const url=new URL(image.getAttribute('data-src') || image.getAttribute('src'),'https://mp.weixin.qq.com/');
    return url.hostname==='mmbiz.qpic.cn'?url.pathname.split('/')[2]:'';
  } catch { return ''; }
}

function clearTemplateGeometry(element) {
  for(const node of [element,...element.querySelectorAll('*')]) for(const property of Array.from(node.style||[])) {
    if (/^(?:display|position|z-index|transform|aspect-ratio|grid(?:-|$)|width|height|min-width|max-width|min-height|max-height|margin(?:-|$)|padding(?:-|$)|flex(?:-|$)|align-self)/.test(property)) node.style.removeProperty(property);
  }
}

function containsTemplateMedia(element,selector) {
  return [...element.querySelectorAll(selector)].some(node=>!(node.localName==='svg' && !node.childElementCount && !normalizedText(node.textContent) && /^0\s+0\s+1\s+1$/.test(node.getAttribute('viewBox')||'')));
}

function cleanReviewedTemplate(body,imageIndices) {
  const removed=[];
  const media='svg,math,table,video,audio,[data-formula],[data-latex],figcaption';
  const sourceOf=image=>image.getAttribute('data-src') || image.getAttribute('src') || '';
  const forget=(image,reason)=>removed.push({imageIndex:imageIndices.get(image),sourceUrl:sourceOf(image),reason});
  let recognized=false;
  for(const grid of [...body.querySelectorAll('section,div')]) {
    if(grid.style.display!=='grid' || grid.style.gridTemplateColumns!=='100%' || grid.style.gridTemplateRows!=='100%' || containsTemplateMedia(grid,media)) continue;
    const branches=[...grid.children], pictures=[...grid.querySelectorAll('img')];
    const imageBranches=branches.filter(branch=>branch.querySelectorAll('img').length===1&&!normalizedText(branch.textContent));
    const textBranches=branches.filter(branch=>normalizedText(branch.textContent));
    if(pictures.length!==14 || imageBranches.length!==14 || textBranches.length!==3) continue;
    if(branches.some(branch=>!imageBranches.includes(branch)&&!textBranches.includes(branch)&&containsTemplateMedia(branch,media))) continue;
    if(pictures.some(image=>!REVIEWED_COVER_ORNAMENTS.has(ornamentAssetId(image))) || new Set(pictures.map(ornamentAssetId)).size!==14) continue;
    if([...imageBranches,...textBranches].some(branch=>branch.style.gridColumnStart!=='1'||branch.style.gridRowStart!=='1')) continue;
    if(textBranches.some(branch=>branch.querySelector('img') || normalizedText(branch.textContent).length>60)) continue;
    recognized=true;
    for(const branch of imageBranches) {forget(branch.querySelector('img'),'reviewed-cover-ornament');branch.remove();}
    for(const branch of [...grid.children]) if(!normalizedText(branch.textContent)) branch.remove();
    clearTemplateGeometry(grid);
  }
  if(!recognized) return removed;
  // This frame's chapter badges and paired heading ornaments are reviewed roles,
  // not a global rule that small images, formula pictures or cartoons are empty.
  for(const row of [...body.querySelectorAll('section,div')]) {
    if(row.style.display!=='flex' || containsTemplateMedia(row,media)) continue;
    const children=[...row.children], text=normalizedText(row.textContent), pictures=[...row.querySelectorAll('img')];
    const noSemanticImage=image=>!image.hasAttribute('data-formula')&&!image.hasAttribute('data-latex')&&!image.hasAttribute('data-sync-formula-image')&&!/(?:formula|latex|math|equation)/i.test(image.getAttribute('class')||'')&&image.getAttribute('type')!=='latex'&&image.getAttribute('data-type')!=='latex'&&!image.getAttribute('title')&&['','图片'].includes(image.getAttribute('alt')||'');
    // Live lazy images keep width:100% (or no width) until decoded; saved HTML
    // often replaces that with a pixel width. The reviewed fixed-size wrapper is
    // the stable role marker, while incompatible explicit image widths stay safe.
    const ornamentBranch=(branch,width)=>branch && !normalizedText(branch.textContent) && branch.querySelectorAll('img').length===1 && (()=>{const image=branch.querySelector('img');return noSemanticImage(image)&&['','auto','100%',width].includes(image.style.width)&&image.parentElement.style.width===width;})();
    if(children.length===2 && pictures.length===1 && /^PART\d{1,2}/i.test(text) && text.length<=80 && ornamentBranch(children[0],'58px') && !children[1].querySelector('img')) {
      forget(pictures[0],'reviewed-chapter-badge');children[0].remove();
    } else if(children.length===3 && pictures.length===2 && text.length>0 && text.length<=40 && ornamentBranch(children[0],'34px') && ornamentBranch(children[2],'34px') && !children[1].querySelector('img') && normalizedText(children[1].textContent)===text) {
      for(const branch of [children[0],children[2]]) {forget(branch.querySelector('img'),'reviewed-paired-heading-ornament');branch.remove();}
    }
  }
  return removed;
}

function flattenCharacterCardHeadings(body) {
  let count=0;
  for(const row of [...body.querySelectorAll('section,div')]) {
    const cards=[...row.children];
    if(cards.length<2 || cards.length>8 || cards.some(card=>card.style.display!=='inline-block') || containsTemplateMedia(row,'img,svg,math,table,[data-formula],[data-latex]')) continue;
    const matches=cards.map(card=>normalizedText(card.textContent).match(/^(?:[a-z]{1,8})?([\u3400-\u9fff])$/i));
    if(matches.some(match=>!match)) continue;
    const letters=cards.map((card,index)=>[...card.querySelectorAll('*')].find(node=>node.style.width==='40px'&&node.style.height==='40px'&&node.style.borderStyle==='solid'&&normalizedText(node.textContent)===matches[index][1]));
    if(letters.some(letter=>!letter)) continue;
    const paragraph=body.ownerDocument.createElement('p');paragraph.style.textAlign=row.style.textAlign||'center';
    for(const [index,letter] of letters.entries()) {
      const textNode=captionTextNodes(letter).find(node=>normalizedText(node.textContent)===matches[index][1]);
      const style=captionTextStyle(textNode), span=body.ownerDocument.createElement('span');
      span.textContent=matches[index][1];span.style.fontSize=String(style.size)+'px';span.style.fontWeight=style.weight;span.style.fontStyle=style.fontStyle;
      if(style.color)span.style.color=style.color;
      if(style.decoration)span.style.textDecoration=style.decoration;
      paragraph.append(span);
    }
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
    const forbidden='img,svg,math,table,figure,figcaption,h1,h2,h3,h4,h5,h6,pre,code,blockquote,ul,ol,li,hr,[data-formula],[data-latex],[data-sync-unsupported]';
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
  if (element.querySelector('img,svg,math,video,audio')) return false;
  let text = normalizedText(element.textContent).toLowerCase();
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
  for (const property of Array.from(probe.style)) {
    const value = probe.style.getPropertyValue(property).trim();
    if (property === 'background-image' && element.hasAttribute('data-sync-background-url')) {
      element.style.setProperty('background-image', `url("${element.getAttribute('data-sync-background-url').replace(/"/g, '%22')}")`);
      continue;
    }
    if (!STYLE_PROPS.has(property) || /url\s*\(|expression\s*\(|@import|javascript:|behavior:|var\s*\(/i.test(value)) continue;
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
  const imageIndices=new Map([...body.querySelectorAll('img')].map((image,index)=>[image,index]));
  const stats = { removedLinks: 0, removedEmptyBlocks: 0, removedImagePlaceholders: 0, removedEmptySvg: 0, removedTransparentBackgrounds: 0, removedDecorativeBackgrounds: 0, removedSmallDecorations: 0, removedHiddenElements: removeHiddenContent(body) };
  stats.removedStanceStatements=removeStanceStatements(body);
  stats.removedOpeningLeads=removeOpeningInteractionLead(body);
  stats.flattenedCharacterHeadings=flattenCharacterCardHeadings(body);
  stats.trimmedTail=trimTail(body)?1:0;
  const removedDecorativeImages=cleanReviewedTemplate(body,imageIndices);
  stats.removedDecorativeImages=removedDecorativeImages.length;
  stats.removedAnswerPanelBackgrounds=clearReviewedAnswerPanelBackgrounds(body);
  stats.removedFormulaCardDecorations=clearReviewedFormulaCardDecorations(body);
  if(stats.removedDecorativeImages) warnings.push(`已略去 ${stats.removedDecorativeImages} 张已确认的模板装饰图，保留标题和正文配图。`);
  if(stats.flattenedCharacterHeadings) warnings.push('已将横排单字装饰标题整理为一行文字，省略字卡和拼音装饰。');
  if(stats.removedAnswerPanelBackgrounds) warnings.push(`已略去 ${stats.removedAnswerPanelBackgrounds} 处问答面板的装饰底色，保留正文、公式和文字高亮。`);
  if(stats.removedFormulaCardDecorations) warnings.push('已略去已确认公式卡片的装饰底色和边框，保留公式文字、颜色和上下标。');
  if(stats.removedStanceStatements) warnings.push('已清除独立的立场声明，保留作者、编辑和参考资料。');
  if(stats.removedOpeningLeads) warnings.push('已清除开头的微信互动赠书引导。');
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
    if (EMPTY_BLOCKS.has(element.localName) && !normalizedText(element.textContent) && !element.querySelector('img,svg,math,hr,[data-sync-unsupported],[data-sync-background-url]') && !element.matches('[data-sync-background-url],[data-formula],[data-latex]')) {
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
