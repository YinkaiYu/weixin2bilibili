import {cleanArticle} from '/lib/article.js';
import {prepareForNative} from '/lib/raster.js';
import {toOpus} from '/lib/opus.js';

const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const parse=html=>new DOMParser().parseFromString(html,'text/html');
function solidImage(color){const canvas=document.createElement('canvas');canvas.width=240;canvas.height=120;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,240,120);return canvas.toDataURL();}
async function pixels(url){const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return (x,y)=>[...context.getImageData(x,y,1,1).data].slice(0,3);}

document.querySelector('#run').onclick=async()=>{
  const status=document.querySelector('#status'), examples=document.querySelector('#examples');
  status.textContent='正在运行';status.dataset.done='false';examples.replaceChildren();
  const results=[];
  try{
    for(const [title,color,size] of [['量子材料的新线索','#173f8a',23],['另一篇文章的标题','#24633a',28],['A new topic','#7a2855',19]]){
      const cleaned=cleanArticle(`<h2 style="color:white;background:${color};font-size:${size}px">${title}</h2><p>正文继续保留。</p>`);
      const prepared=await prepareForNative(cleaned.html);
      assert(prepared.rasterized===0,`${title}: 应保持原生文字`);
      const native=toOpus(prepared.html,{document});
      assert(!native.blockingIssues.length,native.blockingIssues.join(';'));
      const word=native.content.paragraphs.flatMap(p=>p.text?.nodes||[]).find(n=>n.word?.words===title)?.word;
      assert(word?.color===color&&word.style.bold&&!word.bg_style,`${title}: 应使用底色作为加粗字色`);
      results.push(`通过：不同文案、配色与字号 ${title}`);
    }
    const blue=solidImage('#1144cc'), red=solidImage('#dd2244');
    const furniture=cleanArticle(`<header style="display:grid;grid-template-columns:100%"><section style="grid-area:1/1"><div style="pointer-events:none;line-height:0"><img src="${blue}" alt="图片"></div></section><section style="grid-area:1/1;color:#914532;font-size:35px"><strong>新的主题标题</strong></section></header><section style="display:flex"><div><div style="width:40px"><img src="${red}" alt="图片"></div></div><div style="font-size:20px"><strong>新的小标题</strong></div><div><div style="transform:scaleX(-1);width:40px"><img src="${red}" alt="图片"></div></div></section><p>正文配图保留</p><figure><img src="${blue}" alt="数据图"><figcaption>实验数据</figcaption></figure>`);
    assert(furniture.stats.removedDecorativeImages===3,'只清理标题的非交互拼贴和镜像边饰');
    const furnitureNative=await prepareForNative(furniture.html);
    assert(furnitureNative.rasterized===0,'标题装饰清理后不应转图');
    assert(parse(furnitureNative.html).images.length===1,'正文配图不能被删');
    assert(parse(furnitureNative.html).body.textContent==='新的主题标题新的小标题正文配图保留实验数据','标题、正文与图注必须完整');
    results.push('通过：标题装饰清理、文字可编辑与正文配图保留');
    const overlay=`<section style="display:grid;grid-template-columns:100%;grid-template-rows:100%;width:240px;height:120px"><div style="grid-column-start:1;grid-row-start:1"><img src="${blue}" style="display:block;width:240px;height:120px"></div><div style="grid-column-start:1;grid-row-start:1;width:60px;height:60px;margin:20px 0 0 30px"><img src="${red}" style="display:block;width:60px;height:60px"></div><div style="grid-column-start:1;grid-row-start:1;align-self:end;color:white;font-weight:bold">保留全部叠层内容</div></section>`;
    const cleaned=cleanArticle(overlay);
    assert(parse(cleaned.html).images.length===2,'未经确认的图片必须保留');
    const prepared=await prepareForNative(cleaned.html);
    assert(!prepared.blockingIssues.length,prepared.blockingIssues.join(';'));
    assert(prepared.rasterized===1,'叠层组合应作为一个局部转换');
    const output=parse(prepared.html), pixel=await pixels(output.images[0].src);
    assert(JSON.stringify(pixel(10,10))==='[17,68,204]','底层蓝色图片像素必须保留');
    assert(JSON.stringify(pixel(70,50))==='[221,34,68]','上层红色图片的位置与遮挡必须保留');
    const preview=document.createElement('div');preview.className='example';preview.innerHTML=prepared.html;examples.append(preview);
    results.push('通过：未知图片保留、叠层位置和上下层像素');
    const rotated=cleanArticle(`<section style="display:grid;grid-template-columns:100%;grid-template-rows:100%;width:240px;aspect-ratio:2 / 1;overflow:hidden"><div style="grid-column-start:1;grid-row-start:1"><img src="${blue}" style="display:block;width:240px;height:120px"></div><div style="grid-column-start:1;grid-row-start:1;width:60px;height:60px;margin:20px 0 0 30px;transform:rotateZ(45deg);transform-origin:50% 50%;opacity:.5;z-index:2"><img src="${red}" style="display:block;width:60px;height:60px"></div></section>`);
    const rotation=await prepareForNative(rotated.html);
    assert(!rotation.blockingIssues.length,rotation.blockingIssues.join(';'));
    assert(rotation.rasterized===1,'旋转组合应作为一个局部');
    const rotatedPixel=await pixels(parse(rotation.html).images[0].src);
    assert(JSON.stringify(rotatedPixel(120,100))==='[119,51,136]','旋转中心应保留半透明颜色混合');
    assert(JSON.stringify(rotatedPixel(68,48))==='[17,68,204]','旋转后角部应露出底层，不能重复放大旋转');
    const rotatedPreview=document.createElement('div');rotatedPreview.className='example';rotatedPreview.innerHTML=rotation.html;examples.append(rotatedPreview);
    results.push('通过：组合比例、裁切、旋转和半透明像素');
    const inline=cleanArticle('<p>前文 <span style="color:white;background:#005577">普通行内重点</span> 后文</p><p>独立正文</p>');
    const fallback=await prepareForNative(inline.html);
    assert(!fallback.blockingIssues.length,fallback.blockingIssues.join(';'));
    assert(fallback.rasterized===1,'不属于标题的浅字底色应局部保真转换');
    assert(fallback.html.includes('独立正文'),'其他正文必须保持文字');
    const fallbackPreview=document.createElement('div');fallbackPreview.className='example';fallbackPreview.innerHTML=fallback.html;examples.append(fallbackPreview);
    results.push('通过：行内重点完整底色保留，其他正文保持可编辑');
    const marker=cleanArticle('<p><span style="background:linear-gradient(transparent 60%,var(--accent,#f4d58b) 40%)">未见过的高亮文字</span></p>');
    assert(marker.stats.adaptedGradientMarkers===1,'渐变变量fallback应解析为高亮色');
    const markerNative=toOpus(marker.html,{document});
    assert(!markerNative.blockingIssues.length,markerNative.blockingIssues.join(';'));
    const marked=markerNative.content.paragraphs.flatMap(p=>p.text?.nodes||[]).find(n=>n.word?.words==='未见过的高亮文字')?.word;
    assert(marked?.bg_style?.color?.color==='#f4d58b','原生高亮色应保留');
    results.push('通过：带变量fallback的渐变高亮保持原生文字');
    const formula=cleanArticle('<section style="background:#eef2ff"><p>E=mc<sup>2</sup></p><p>其他段落保持文字</p></section>');
    const rendered=await prepareForNative(formula.html);
    assert(!rendered.blockingIssues.length,rendered.blockingIssues.join(';'));
    assert(rendered.rasterized===1&&rendered.html.includes('其他段落保持文字'),'带底色公式只转换自身段落');
    const formulaPreview=document.createElement('div');formulaPreview.className='example';formulaPreview.innerHTML=rendered.html;examples.append(formulaPreview);
    results.push('通过：带底色公式局部保留，其他段落仍可编辑');
    status.textContent=results.join('\n');status.dataset.done='true';
  }catch(error){status.textContent=results.concat(`失败：${error.message}`).join('\n');}
};
