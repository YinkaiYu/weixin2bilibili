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

test('opening banners do not hide animated title furniture; independent GIFs and scientific overlays stay',()=>{
  for(const [title,color,count] of [['探究新的材料','#ff8100',4],['A new discovery','#354f80',7]]){
    const banner=picture('opening','data-type="gif"');
    const animatedPoster=poster(count,title,color).replaceAll('header','section').replaceAll('.png','.gif').replaceAll('alt="图片"','alt="图片" data-type="gif"');
    const body=`<p>正文实验</p>${picture('experiment','data-type="gif" title="实验过程"')}`;
    const source=banner+animatedPoster+body, result=cleanArticle(source),doc=parse(result.html);
    assert.equal(result.stats.removedDecorativeImages,count);
    assert.equal(result.stats.gifs,2);assert.equal(findRasterTargets(doc).length,0);
    assert.deepEqual([...doc.images].map(i=>i.src),['https://mmbiz.qpic.cn/opening.png','https://mmbiz.qpic.cn/experiment.png']);
    assert.equal(doc.body.textContent,parse(source).body.textContent);
    for(const variant of [animatedPoster.replace('alt="图片"','alt="测量示意"'),animatedPoster.replaceAll('pointer-events:none;',''),'<p>实验结果</p>'+animatedPoster]){
      const retained=cleanArticle(banner+variant+body);
      assert.equal(retained.stats.removedDecorativeImages,0);
      assert.equal(retained.stats.gifs,count+2);
      assert.equal(findRasterTargets(parse(retained.html)).length,1,'ambiguous animated overlays still require explicit handling');
    }
  }
});

test('wide opening banners are removed only alongside a recognized title poster',()=>{
  for(const [width,ratio] of [[650,.24],[900,.18],[480,.3]]){
    const banner=picture('banner-'+width,`data-w="${width}" data-ratio="${ratio}" data-type="gif"`);
    const source=banner+poster(3)+`<p>正文</p>${banner}`;
    const result=cleanArticle(source);
    assert.equal(result.stats.removedDecorativeImages,4);
    assert.equal(result.stats.images,1);assert.equal(result.stats.gifs,1,'same wide image in the body remains animated');
    for(const variant of [banner+'<p>正文</p>',banner.replace('alt="图片"','alt="实验数据"')+poster(3),banner+poster(3).replaceAll('pointer-events:none;',''),banner+'<p style="color:gray;font-size:12px">图：实验过程</p>'+poster(3)]){
      assert.equal(cleanArticle(variant).stats.removedDecorativeImages,0);
    }
  }
});

test('stretch-fit bold title backgrounds become native text across copy, color and padding',()=>{
  for(const [title,color,padding] of [['新的科学问题','#6ab3e0',11],['Another title','#335588',23]]){
    const source=`<section style="display:flex"><section style="display:inline-block;width:auto;padding:${padding}px;background-image:url(https://mmbiz.qpic.cn/${padding}.png);background-position:center;background-size:100% 100%;background-repeat:no-repeat"><p style="color:${color}"><strong>${title}</strong></p></section></section>`;
    const result=cleanArticle(source);
    assert.equal(result.stats.backgrounds,0);assert.equal(result.stats.removedDecorativeBackgrounds,1);
    assert.equal(parse(result.html).body.textContent,title);assert.equal(findRasterTargets(parse(result.html)).length,0);
    assert.ok(parse(result.html).querySelector('strong'));
    for(const variant of [source.replace(color,'#fff'),source.replace('<strong>','<span>').replace('</strong>','</span>'),source.replace(title,title+'<img src="https://mmbiz.qpic.cn/content.png">')]){
      assert.equal(cleanArticle(variant).stats.backgrounds,1,'ambiguous or contrast-dependent background stays');
    }
  }
});

test('empty matching ribbon beside a bold heading is decoration, not an uploaded image',()=>{
  for(const [title,color,size] of [['器材与方法','#e7a240',18],['New findings','#5588cc',24]]){
    const source=`<section style="display:flex"><section style="font-size:${size}px;background-color:${color}"><p><strong>${title}</strong></p></section><section data-lazy-bgimg="https://mmbiz.qpic.cn/ribbon-${size}.png" style="width:${size}px;height:${size*1.4}px;margin-top:-10px;background-color:${color}"><br></section></section>`;
    const result=cleanArticle(source);
    assert.equal(result.stats.backgrounds,0);assert.equal(result.stats.removedSmallDecorations,1);
    assert.equal(parse(result.html).body.textContent,title);assert.equal(findRasterTargets(parse(result.html)).length,0);
    for(const variant of [source.replace('<br>','曲线'),source.replace('<br>','<img src="https://mmbiz.qpic.cn/graph.png">'),source.replace('data-lazy-bgimg=','aria-label="测量图" data-lazy-bgimg='),source.replace('display:flex','display:block'),source.replace('<strong>','<span>').replace('</strong>','</span>')]){
      assert.equal(cleanArticle(variant).stats.backgrounds,1,'meaningful or structurally ambiguous backgrounds remain');
    }
  }
});

test('padded full-width prose panels keep text and scripts native; inline highlights and content images stay',()=>{
  const panel=inside=>`<section style="display:flex"><section style="display:inline-block;width:100%;padding:22px;background:rgba(231,245,251,.55)">${inside}</section></section>`;
  const inside='<p><strong>特征温度 T<sub>a</sub></strong></p><p>正文 T<sub>b</sub> 与 <span style="background:#ffee00">强调文字</span></p>';
  const result=cleanArticle(panel(inside));
  assert.equal(result.stats.removedAnswerPanelBackgrounds,1);
  assert.equal(findRasterTargets(parse(result.html)).length,0);
  assert.equal(parse(result.html).querySelectorAll('sub').length,2);
  assert.equal(parse(result.html).querySelector('span').style.backgroundColor,'rgb(255, 238, 0)');
  assert.equal(cleanArticle(panel(inside+picture('chart'))).stats.removedAnswerPanelBackgrounds,0);
});

test('faint repeating article textures do not capture entire articles or their images/formulas',()=>{
  const texture=(alpha,size=24)=>`<section style="background-image:linear-gradient(90deg,rgba(20,30,40,${alpha}) 0%,transparent 15%),linear-gradient(0deg,rgba(40,20,30,${alpha}) 0%,transparent 20%);background-size:${size}px ${size}px;background-repeat:repeat"><p>第一段</p><p>第二段 <span data-formula="x^2"></span></p><p>${picture('figure')}</p></section>`;
  const cleaned=cleanArticle(texture(.03));
  assert.equal(cleaned.stats.removedDecorativeBackgrounds,1);
  assert.equal(cleaned.stats.images,1);assert.equal(cleaned.stats.formulas,1);
  assert.equal(findRasterTargets(parse(cleaned.html)).length,0);
  const rule=texture(.03).replaceAll('0%,transparent 15%','3%,transparent 3%').replaceAll('0%,transparent 20%','3%,transparent 3%').replace('background-size:24px 24px;background-repeat:repeat','background-size:24px 24px,auto;background-repeat:no-repeat');
  assert.equal(cleanArticle(rule).stats.removedDecorativeBackgrounds,1,'faint thin paper rules are decorative even without repetition');
  for(const source of [texture(.5),texture(.03,240),texture(.03).replace('background-repeat:repeat','background-repeat:no-repeat')]){
    assert.equal(cleanArticle(source).stats.removedDecorativeBackgrounds,0,'nontexture backgrounds remain');
  }
});

test('live reservation widgets are promotional, ordinary videos remain blocked with their location',()=>{
  const notice='<mp-common-videosnap data-type="live" data-noticeid="finderlivenotice-new-event"><template>预约按钮</template></mp-common-videosnap>';
  const result=cleanArticle('<p>正文</p>'+notice+'<p>后文</p>');
  assert.equal(result.stats.removedLiveNotices,1);assert.deepEqual(result.blockingIssues,[]);
  assert.equal(parse(result.html).body.textContent,'正文后文');
  for(const video of ['<mp-common-videosnap data-type="video"></mp-common-videosnap>','<mp-common-videosnap data-type="live"></mp-common-videosnap>']){
    assert.equal(cleanArticle(video).stats.removedLiveNotices,0);
    assert.ok(cleanArticle(video).blockingIssues.length);
  }
});
