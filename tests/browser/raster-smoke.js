import {prepareForNative} from '/lib/raster.js';
document.getElementById('rasterTest').onclick=async()=>{
  const out=document.getElementById('rasterResults');out.textContent='处理中';
  const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const ctx=canvas.getContext('2d');ctx.fillStyle='#f9dc8f';ctx.fillRect(0,0,24,24);ctx.fillStyle='#ce8b32';ctx.fillRect(0,0,12,12);const png=canvas.toDataURL();
  const html=`<p>原生正文<strong>保留加粗</strong></p><section data-sync-background-url="${png}" style="background-image:url(${png});background-repeat:repeat;padding:20px"><p style="color:#552e13;font-size:20px">背景排版测试，公式 H<sub>2</sub>O。</p></section><p>行内图文 <img src="${png}" style="width:1em;height:1em;display:inline-block"> 应保留相对位置。</p>`;
  try{const r=await prepareForNative(html);out.replaceChildren();const status=document.createElement('h2');status.textContent=r.blockingIssues.length?r.blockingIssues.join(';'):`完成：${r.rasterized} 处局部转换`;out.append(status);const preview=document.createElement('div');preview.innerHTML=r.html;out.append(preview);}catch(e){out.textContent=e.message;}
};
