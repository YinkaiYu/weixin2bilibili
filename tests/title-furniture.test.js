import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {cleanArticle} from '../extension/lib/article.js';
import {findRasterTargets} from '../extension/lib/raster.js';
import {classifyImportMessages} from '../extension/lib/import-notices.js';
globalThis.DOMParser=new JSDOM('').window.DOMParser;
const parse=html=>new DOMParser().parseFromString(html,'text/html');
const picture=(id,extra='')=>`<img src="https://mmbiz.qpic.cn/${id}.png" alt="图片" ${extra}>`;
const poster=(count,title='A different subject',color='#362866')=>`<header style="display:grid;grid-template-columns:100%">${Array.from({length:count},(_,i)=>`<section style="grid-area:1/1"><div style="pointer-events:none;line-height:0">${picture('random-'+i)}</div></section>`).join('')}<section style="grid-area:1/1;font-size:32px;color:${color}"><strong>${title}</strong></section></header>`;
const frame=(width,title,chapter=false)=>`<section style="display:flex;justify-content:center"><div><div style="width:${width}px">${picture('left')}</div></div><div style="font-size:20px">${chapter?'<p><b>CHAPTER 7</b></p>':''}<p><strong>${title}</strong></p></div>${chapter?'':`<div><div style="transform:scaleX(-1);width:${width}px">${picture('right')}</div></div>`}</section>`;

test('title furniture generalizes across text, colors, image addresses, counts and sizes',()=>{
  for(const [count,title,color,width] of [[2,'未见过的标题','#364b51',24],[5,'Another heading','#403473',48],[9,'相变与材料','#914532',63]]){
    const source=poster(count,title,color)+frame(width,title)+frame(width,title,true)+`<p>正文</p><figure>${picture('content','title="数据图"')}<figcaption>实验数据</figcaption></figure>`;
    const result=cleanArticle(source),doc=parse(result.html);
    assert.equal(result.stats.removedDecorativeImages,count+3);
    assert.equal(result.stats.images,1);assert.equal(result.stats.compositeLayouts,0);
    assert.equal(classifyImportMessages(result.warnings).find(item=>item.message.includes('张装饰图片'))?.severity,'info');
    assert.equal(doc.body.textContent,parse(source).body.textContent);
    assert.equal(findRasterTargets(doc).length,0);
    assert.match(doc.querySelector('img').src,/content/);
    assert.equal(cleanArticle(result.html).stats.images,1,'cleanup remains idempotent');
  }
});

test('captioned, semantic and formula images override decorative layout cues',()=>{
  for(const extra of ['title="测量曲线"','aria-label="原理图"','data-caption="说明"','data-latex="x^2"']){
    for(const source of [poster(3),frame(32,'测试'),frame(32,'测试',true)]){
      const result=cleanArticle(source.replace('alt="图片"',`alt="图片" ${extra}`));
      assert.equal(result.stats.removedDecorativeImages,0,extra);
    }
  }
  for(const source of [poster(3),frame(32,'测试')]){
    assert.equal(cleanArticle(source+'<p style="font-size:12px;color:gray">图：测量结果</p>').stats.removedDecorativeImages,0);
  }
});

test('ordinary image collages, body illustrations, pale labels and unmirrored images remain',()=>{
  for(const source of [poster(3).replaceAll('pointer-events:none;',''),'<p>正文开始</p>'+poster(3),poster(3,'白字','#fff'),frame(32,'标题').replace('scaleX(-1)','rotate(10deg)'),frame(180,'标题')]){
    assert.equal(cleanArticle(source).stats.removedDecorativeImages,0);
  }
});
