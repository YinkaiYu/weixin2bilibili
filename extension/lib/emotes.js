/** Semantic IDs from WeChat's official system-emote assets, not article assets.
 * Targets are the free small-face names in Bilibili's native editor picker.
 * Unknown or non-inline images retain the ordinary media/rendering path.
 */
const WECHAT_EMOTES = Object.freeze({
  Yellowdog: '[doge]',
  // Match the actual artwork: Bilibili's [笑哭] is the hand-over-face icon.
  Lol: '[喜极而泣]',
  '2_05': '[笑哭]',
  Wow: '[星星眼]',
});

export function wechatEmote(element) {
  if(element?.tagName?.toUpperCase()!=='IMG' || element.closest('figure,figcaption,table,pre,code,[data-formula],[data-latex],[data-sync-composite-layout]'))return null;
  if(!['','inline','inline-block'].includes(element.style.display))return null;
  const width=(element.style.width||element.getAttribute('width')||'').match(/^([\d.]+)(em|px)?$/);
  if(!width||!(Number(width[1])>0)||Number(width[1])>(width[2]==='em'?2:40))return null;
  let url;
  try{url=new URL(element.getAttribute('src')||'');}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='res.wx.qq.com'||url.port||url.username||url.password)return null;
  const id=url.pathname.match(/^\/t\/wx_fed\/we-emoji\/res\/assets\/newemoji\/([A-Za-z0-9_]+)\.png$/)?.[1];
  return Object.hasOwn(WECHAT_EMOTES,id)?WECHAT_EMOTES[id]:null;
}
