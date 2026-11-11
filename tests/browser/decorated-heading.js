import {cleanArticle} from '/lib/article.js';
import {prepareForNative} from '/lib/raster.js';

document.getElementById('run').onclick = async () => {
  const status = document.getElementById('status');
  status.textContent = '正在检查';
  try {
    const asset = document.createElement('canvas');
    asset.width = 20; asset.height = 25;
    const brush = asset.getContext('2d');
    brush.fillStyle = '#0055ff'; brush.fillRect(0,0,20,25);
    const placeholder = 'data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
    const source = `<p>正文保持原生</p><section style="text-align:center"><section style="display:inline-block;padding:0 6px;background:#fefefe"><section style="display:flex"><section style="height:35px;line-height:35px;padding:0 15px;background-color:#fcb42b;border-radius:8px"><p style="margin:0"><strong>实验器材</strong></p></section><section data-lazy-bgimg="${asset.toDataURL()}" style="width:20px;height:25px;margin-top:-14px;margin-left:3px;background-color:#fcb42b;background-size:100% 100%;background-image:url(${placeholder})"><span><br></span></section></section></section></section><p>后续文字仍可编辑</p>`;
    const parsed = cleanArticle(source);
    document.getElementById('original').innerHTML=parsed.html;
    const result = await prepareForNative(parsed.html);
    if (result.blockingIssues.length) throw new Error(result.blockingIssues.join('\n'));
    const preview = document.getElementById('result'); preview.innerHTML = result.html;
    const image = preview.querySelector('img'); await image.decode();
    const pixels = document.createElement('canvas'); pixels.width=image.naturalWidth; pixels.height=image.naturalHeight;
    const context=pixels.getContext('2d'); context.drawImage(image,0,0);
    const data=context.getImageData(0,0,pixels.width,pixels.height).data;
    let blueTop=false,orangeBelow=false,minBlueY=Infinity,maxBlueY=-1,minInkX=Infinity,maxInkX=-1;
    for(let y=0;y<pixels.height;y++) for(let x=0;x<pixels.width;x++) {
      const offset=(y*pixels.width+x)*4;
      if(y<28 && data[offset]<10 && data[offset+1]>=80 && data[offset+1]<=90 && data[offset+2]>245) blueTop=true;
      if(data[offset]<10 && data[offset+1]>=80 && data[offset+1]<=90 && data[offset+2]>245) {minBlueY=Math.min(minBlueY,y);maxBlueY=Math.max(maxBlueY,y);}
      if(y>=28 && data[offset]>245 && data[offset+1]>=170 && data[offset+1]<=190 && data[offset+2]<60) orangeBelow=true;
      if(data[offset]<240 || data[offset+1]<240 || data[offset+2]<240) {minInkX=Math.min(minInkX,x);maxInkX=Math.max(maxInkX,x);}
    }
    const checks = {
      oneCompleteHeading:result.rasterized===1 && preview.querySelectorAll('img').length===1,
      fullHeight:image.naturalHeight>=98,
      negativeMarginAccentPreserved:blueTop && maxBlueY-minBlueY>=48,
      titleBackgroundPreserved:orangeBelow,
      headingCentered:Math.abs((minInkX+maxInkX)/2-pixels.width/2)<25,
      roundCornersRetained:[...document.querySelectorAll('#original section')].some(el=>el.style.borderTopLeftRadius==='8px'),
      nativeTextPreserved:preview.textContent.includes('正文保持原生') && preview.textContent.includes('后续文字仍可编辑'),
    };
    if(Object.values(checks).some(value=>!value)) throw new Error(JSON.stringify(checks));
    status.textContent=`全部通过：${image.naturalWidth}×${image.naturalHeight}\n标题与装饰完整保留，上溢部分没有裁切。\n前后正文保持原生。`;
    status.dataset.passed='true';
  } catch(error) { status.textContent=`失败：${error.message}`; status.dataset.passed='false'; }
};
