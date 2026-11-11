/** Normalize an explicitly identified source citation. This never fetches a URL. */
export function normalizeSourceLink(value) {
  if(typeof value!=='string')return '';
  const raw=value.trim();
  if(!/^https?:\/\/[^/?#]/i.test(raw)||/[\s\u0000-\u001f\u007f\\]/u.test(raw)||/%(?![\da-f]{2})/i.test(raw))return '';
  try{
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)return '';
    return url.href;
  }catch{return '';}
}
