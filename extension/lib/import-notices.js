/** Severity for import results. Unrecognized legacy messages need review. */
const SEVERITIES = new Set(['error','warning','info']);
const RANK = {info:0,warning:1,error:2};
const INFORMATION = [
  /^上下标已转换为 B 站原生行内公式/,
  /^B 站原生段落没有已验证的两端对齐值，将使用默认对齐；文字内容保留。$/,
  /^(?:正文已按 B 站支持的字号调整|整段 20\/22\/24px 文字已使用 B 站对应标题样式)/,
  /^已删除回顾／近期热门文章标题及其后面的内容。$/,
  /^已删除回顾、福利互动或投票等尾部栏目及其后面的内容。$/,
  /^已清除独立的立场声明，保留作者、编辑和参考资料。$/,
  /^已清除开头的微信互动赠书引导。$/,
  /^已清除微信组件的滑动提示。$/,
  /^已清除 \d+ 处外链（保留链接文字和图片）。$/,
  /^已清除 \d+ 个没有内容的微信图片占位标签。$/,
  /^已略去 \d+ (?:张已确认的模板装饰图，保留标题和正文配图|处装饰背景，保留正文文字和内容图片|处问答面板的装饰底色，保留正文、公式和文字高亮)。$/,
  /^已将横排单字装饰标题整理为一行文字，省略字卡和拼音装饰。$/,
  /^已略去已确认公式卡片的装饰底色和边框，保留公式文字、颜色和上下标。$/,
  /^已将 \d+ 处图片下方的灰色小字识别为图注。$/,
];

export function classifyImportMessages(...sources) {
  const messages=new Map();
  for(const source of sources)for(const item of Array.isArray(source)?source:[]) {
    const message=typeof item==='string'?item:typeof item?.message==='string'?item.message:'';
    if(!message.trim())continue;
    const severity=SEVERITIES.has(item?.severity)?item.severity:INFORMATION.some(pattern=>pattern.test(message))?'info':'warning';
    const previous=messages.get(message);
    if(!previous||RANK[severity]>RANK[previous.severity])messages.set(message,{severity,message});
  }
  return [...messages.values()];
}

export function noticeFields(notices) {
  return {
    notices,
    errors:notices.filter(item=>item.severity==='error').map(item=>item.message),
    warnings:notices.filter(item=>item.severity==='warning').map(item=>item.message),
    info:notices.filter(item=>item.severity==='info').map(item=>item.message),
  };
}

export function importFailure(value) {
  // Preserve code, cause, image diagnostics and saved/uncertain draft metadata.
  const error=value instanceof Error?value:new Error(typeof value==='string'?value:'导入失败，请重试。',{cause:value});
  error.severity='error';
  Object.assign(error,noticeFields(classifyImportMessages(error.notices,[{severity:'error',message:error.message}])));
  return error;
}
