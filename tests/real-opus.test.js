import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseArticle } from '../extension/lib/article.js';
import { findRasterTargets } from '../extension/lib/raster.js';
import { toOpus } from '../extension/lib/opus.js';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '测试文章');
const document = new JSDOM('').window.document;
const cases = [
  { name: '不抽血不拍片，闻一闻就能接收身体警报？？？.html', tail: 'fu福li利shi时jian间', raster: 0, images: 3, formulas: 0, captions: 1 },
  { name: '为什么只睡20分钟，下午就能精神满满？_ No. 537.html', tail: '投票', raster: 8, images: 15, formulas: 14, captions: 0 },
  { name: '你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html', tail: '上期回顾', raster: 2, images: 17, formulas: 11, captions: 4 },
  { name: '摸了半天找不到头，胶带却记得你撕到哪儿？.html', raster: 0, images: 12, formulas: 4, captions: 9 },
  { name: '要宣布翻篇了？那我磁化损失呢，厉娜.html', raster: 1, images: 51, formulas: 0, captions: 19 },
];
const compact=text=>text.replace(/[\s\u200B-\u200D\uFEFF]/g,'');
function assertText(actual,expected,message){
  let index=0;while(index<actual.length&&index<expected.length&&actual[index]===expected[index])index++;
  assert.ok(actual===expected,`${message}; first difference ${index}, lengths ${actual.length}/${expected.length}; actual ${JSON.stringify(actual.slice(Math.max(0,index-20),index+60))}; expected ${JSON.stringify(expected.slice(Math.max(0,index-20),index+60))}`);
}
const formulaSources=body=>[...(body.matches?.('[data-formula],[data-latex]')?[body]:[]),...body.querySelectorAll('[data-formula],[data-latex]')].filter(node=>!node.parentElement.closest('[data-formula],[data-latex]')).map(node=>node.getAttribute('data-formula')||node.getAttribute('data-latex'));
const scriptSources=body=>[...body.querySelectorAll('sup,sub')].map(node=>({tag:node.localName,text:node.textContent}));
const latexKey=latex=>compact(latex).replace(/^\[|\]$/g,'');

function sourceBaseline(html,sample){
  const raw=new document.defaultView.DOMParser().parseFromString(html,'text/html'),body=raw.querySelector('#js_content');
  const tail=sample.tail||'近期热门文章Top10';
  const marker=[...body.querySelectorAll('*')].find(node=>compact(node.textContent)===tail);
  assert.ok(marker,`independently reviewed tail: ${tail}`);
  const range=raw.createRange();range.selectNodeContents(body);range.setEndBefore(marker);
  const retained=raw.createElement('main');retained.append(range.cloneContents());
  for(const node of [...retained.querySelectorAll('*')])if(node.hidden||node.style.display==='none'||compact(node.textContent)==='左右滑动查看更多')node.remove();
  for(const paragraph of retained.querySelectorAll('p'))if(compact(paragraph.textContent).startsWith('认真阅读下面的文章'))paragraph.remove();
  // The five unlinked DOI URLs are excluded by the user's ordinary-link rule;
  // their surrounding author/title/reference text is still in the baseline.
  if(sample.tail==='投票'){
    const walker=raw.createTreeWalker(retained,4),urls=[];
    while(walker.nextNode())walker.currentNode.textContent=walker.currentNode.textContent.replace(/https?:\/\/[^\s]+/g,url=>{urls.push(url);return '';});
    assert.equal(urls.length,5);
  }
  return {body:retained,text:compact(retained.textContent),images:[...retained.querySelectorAll('img')].map(image=>image.getAttribute('data-src')||image.getAttribute('src')||'').filter(Boolean),formulas:formulaSources(retained),scripts:scriptSources(retained)};
}

function scriptText(latex){
  // In these fixtures a native script formula contains ordinary source text
  // plus its script. Explicit authored LaTeX is checked separately by identity.
  return latex.replace(/\\color\{[^{}]*\}/g,'').replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt)\b/g,'').replace(/[{}_^]/g,'').replace(/\\([%&#$])/g,'$1');
}

// Structural integration only: local HTML -> actual raster target selection ->
// mocked completed raster blocks/uploads -> actual native converter. No network,
// page script execution, canvas output, or real Bilibili writes take place here.
for (const sample of cases) {
  const filename = path.join(directory, sample.name);
  test(`native structural integration with mock raster/upload: ${sample.name}`, { skip: !fs.existsSync(filename) && '用户本地样稿未附带。' }, () => {
    const raw=fs.readFileSync(filename,'utf8'),baseline=sourceBaseline(raw,sample);
    const source = parseArticle(raw, { document });
    const doc = new document.defaultView.DOMParser().parseFromString(source.html, 'text/html');
    assert.deepEqual([...doc.images].map(image=>image.getAttribute('src')),baseline.images,'all source image identities and occurrences survive cleanup');
    assertText(compact(doc.body.textContent),baseline.text,'cleanup is compared with the original DOM, not with its own output');
    assert.deepEqual(formulaSources(doc.body),baseline.formulas);
    assert.deepEqual(scriptSources(doc.body),baseline.scripts);
    const targets = findRasterTargets(doc);
    assert.equal(targets.length, sample.raster);
    if (sample.name.includes('胶带')) {
      const card = [...doc.querySelectorAll('section')].find(el => el.textContent.replace(/\s+/g, '') === 'ΔF=Fpeak−Fbaseline');
      assert.ok(card, '公式文字所在段落必须保留');
      assert.equal(card.style.backgroundColor, '', '符合结构与对比度条件的公式卡片底色可省');
      assert.equal(card.style.borderTopWidth, '', '公式卡片装饰边框可省');
      assert.equal(card.style.color, 'rgb(130, 66, 46)', '公式文字颜色不能丢');
      assert.deepEqual([...card.querySelectorAll('sub')].map(el => el.textContent), ['peak','baseline']);
      assert.equal([...doc.querySelectorAll('sub')].filter(el => !card.contains(el)).length, 2, '正文两个下标保留原生');
    }
    if (sample.name.includes('厉娜')) {
      const retained = [...doc.images].map(img => Number(new URL(img.src).hash.match(/imgIndex=(\d+)/)?.[1]));
      assert.deepEqual(retained,Array.from({length:64},(_,index)=>index),'all 64 unmarked original images remain');
      for (const title of ['都重新见面了怎么还没和好？','从《后会友期》看物理','外场变了，过去还算数']) assert.ok(doc.body.textContent.includes(title), '海报文字保留');
      assert.ok(doc.body.textContent.includes('τ ≈ τ₀ · exp(ΔE / kBT)'), 'Unicode 正文公式不因装饰清理被删');
    }
    const captures=[];
    for (const [index, target] of targets.entries()) {
      // The real renderer checks decoded frames; this assertion also protects the
      // one known animation in the user's sample from being selected for flattening.
      assert.equal(target.querySelectorAll('img[data-type="gif"],img[src*="wx_fmt=gif"]').length, 0);
      const capture={url:`https://i0.hdslb.com/bfs/mock/raster-${index}.png`,text:target.textContent,images:[...(target.tagName==='IMG'?[target]:[]),...target.querySelectorAll('img')].map(image=>image.getAttribute('src')),formulas:formulaSources(target),scripts:scriptSources(target)};
      captures.push(capture);
      const p = doc.createElement('p');
      const img = doc.createElement('img');
      img.src = capture.url;
      img.setAttribute('data-sync-rasterized', 'mock-only');
      img.setAttribute('data-mock-original-text', target.textContent);
      p.append(img);
      target.replaceWith(p);
    }
    assert.equal(doc.querySelectorAll('[data-sync-background-url]').length, 0);
    const imageMap = new Map();
    const uploaded=new Map();
    for (const [index, img] of [...doc.images].entries()) {
      const animated = img.getAttribute('data-type') === 'gif' || img.src.includes('wx_fmt=gif');
      const url = `https://i0.hdslb.com/bfs/mock/image-${index}.${animated ? 'gif' : 'png'}`;
      const capture=captures.find(item=>item.url===img.src);
      uploaded.set(url,capture||{images:[img.getAttribute('src')],text:'',formulas:[],scripts:[]});
      img.src = url;
      imageMap.set(url, { width: 680, height: 320, size: 80, animated, frames: animated ? 2 : 1 });
    }
    const result = toOpus(doc.body.innerHTML, { document, images: imageMap });
    assert.deepEqual(result.blockingIssues, []);
    assert.equal(result.stats.images,baseline.images.length-captures.reduce((sum,item)=>sum+item.images.length,0)+targets.length);
    assert.equal(result.stats.images, sample.images);
    assert.equal(result.stats.formulas, sample.formulas);
    const pictures = result.content.paragraphs.flatMap(p => p.pic?.pics || []);
    assert.deepEqual(pictures.flatMap(picture=>{assert.ok(uploaded.has(picture.url));return uploaded.get(picture.url).images;}),baseline.images,'expanding each mock raster recovers the original image order and identities');
    assert.equal(pictures.filter(p => p.comment).length, sample.captions);
    const withoutCaptions = new document.defaultView.DOMParser().parseFromString(doc.body.innerHTML, 'text/html');
    for (const [index, picture] of pictures.entries()) {
      if (!picture.comment) continue;
      const caption = withoutCaptions.images[index].closest('figure')?.querySelector('figcaption');
      assert.ok(caption, '每条原生图片注释必须来自同一张源图片的 figcaption');
      assert.equal(picture.comment, caption.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim());
      assert.ok(picture.comment.length <= 100, '图注不能超过原生编辑器限制');
      caption.remove();
    }
    // Native captions have one representation, not a duplicate text paragraph.
    // Removing exactly those source captions must leave identical body nodes,
    // including formulas, colors and emphasis outside the consumed captions.
    const bare = toOpus(withoutCaptions.body.innerHTML, { document, images: imageMap });
    assert.deepEqual(result.content.paragraphs.filter(p => p.text), bare.content.paragraphs.filter(p => p.text));
    const formulaNodes = result.content.paragraphs.flatMap(p => p.text?.nodes || []).filter(n => n.node_type === 5);
    const remainingFormulas=[...baseline.formulas];
    for(const latex of captures.flatMap(capture=>capture.formulas)){
      const index=remainingFormulas.indexOf(latex);assert.ok(index>=0,'a raster formula must have an original source occurrence');remainingFormulas.splice(index,1);
    }
    const explicitFormulaNodes=new Set();
    for(const latex of [...remainingFormulas].sort((a,b)=>b.length-a.length)){
      const node=formulaNodes.find(node=>!explicitFormulaNodes.has(node)&&latexKey(node.formula.latex_content).includes(latexKey(latex)));
      assert.ok(node,`原生公式的每次出现必须保留：${latex}`);explicitFormulaNodes.add(node);
    }
    assert.equal(formulaNodes.length,remainingFormulas.length+baseline.scripts.length-captures.reduce((sum,capture)=>sum+capture.scripts.length,0),'every original formula/script remains either native or explicitly inside a mock raster');
    for(const [tag,stat] of [['sup','superscripts'],['sub','subscripts']])assert.equal(result.stats[stat],baseline.scripts.filter(script=>script.tag===tag).length-captures.flatMap(capture=>capture.scripts).filter(script=>script.tag===tag).length,`source ${tag} occurrences remain native outside the recorded rasters`);
    assert.ok(formulaNodes.every(n => !n.formula.latex_content.includes('\\color{rgba(')));
    const nativeWords=result.content.paragraphs.flatMap(p=>p.text?.nodes||[]).filter(n=>n.node_type===1).map(n=>n.word);
    const nativeText=nativeWords.map(word=>word.words).join('');
    const representedText=result.content.paragraphs.map(paragraph=>paragraph.pic?.pics.map(picture=>uploaded.get(picture.url).text+(picture.comment||'')).join('')||(paragraph.text?.nodes||[]).map(node=>node.word?.words||node.link?.show_text||(node.formula?(explicitFormulaNodes.has(node)?'':scriptText(node.formula.latex_content)):'')).join('')).join('');
    assertText(compact(representedText),baseline.text,'native words, captions, script text and recorded raster text jointly preserve the independent source text');
    if (sample.name.includes('正经玩')) {
      assert.equal(pictures.filter(p => p.url.endsWith('.gif')).length, 1);
      assert.ok([...doc.querySelectorAll('[data-mock-original-text]')].some(image=>image.getAttribute('data-mock-original-text')==='实验器材'),'未知背景与完整标题都交给局部渲染，而非要求原生标题');
      assert.deepEqual(pictures.map((p, index) => p.comment ? index : -1).filter(index => index >= 0), [0, 4, 13, 14]);
      assert.deepEqual(pictures.filter(p => p.comment).map(p => p.comment), ['↑试图用肉眼看清手机屏幕像素的小编', '书籍是人类进步的阶梯（物理意义）', '半导体晶圆', '真实的X射线衍射点阵']);
    }
    if (sample.name.includes('No. 537')) {
      // Q3's block equation and following explanation are separate captures;
      // its surrounding answer text and image must not be swallowed with them.
      assert.deepEqual(captures.flatMap(capture=>capture.images),[],'all seven original images stay outside local formula rendering');
      assert.deepEqual(captures.flatMap(capture=>capture.formulas),baseline.formulas,'all seven original formula sources remain in order, including the capture root itself');
      const standaloneEquation=captures.find(capture=>capture.formulas.length===1&&capture.formulas[0]===baseline.formulas[1]);
      assert.ok(standaloneEquation);assert.equal(standaloneEquation.text,'');
      assert.ok(captures.some(capture=>capture.formulas.length===5&&capture.text.startsWith('其中')),'the explanation is captured separately from its standalone equation');
      assert.equal(captures.flatMap(capture=>capture.scripts).length,5);
      assert.equal(pictures.filter(picture=>uploaded.get(picture.url).images.length===1).length,baseline.images.length);
      const fallbackCaptions=[...doc.querySelectorAll('figcaption')];
      assert.equal(fallbackCaptions.length,3);
      assert.ok(fallbackCaptions.every(caption=>caption.style.backgroundColor==='rgb(239, 239, 246)'),'caption formatting inherits the preserved image-card background');
      assert.ok(result.warnings.some(message=>message.includes('图注已保留为图片下方正文')));
      for(const caption of fallbackCaptions)assert.equal(compact(nativeText).split(compact(caption.textContent)).length-1,1,'styled caption remains once in editable body text');
      for(let q=1;q<=12;q++) assert.match(nativeText,new RegExp(`Q\\s*${q}(?!\\d)`),`Q${q}必须保留为原生文字`);
      const textOf=paragraph=>(paragraph.text?.nodes||[]).map(node=>node.word?.words||'').join('').trim();
      const navigationIndex=result.content.paragraphs.findIndex(p=>textOf(p)==='问答导航');
      assert.ok(navigationIndex>=0);
      const navigation=result.content.paragraphs.slice(navigationIndex,navigationIndex+13);
      assert.equal(navigation.length,13);
      assert.ok(navigation.every(p=>p.para_type===1),'目录应保留13行普通可编辑文字，不能变成代码块');
      for(let q=1;q<=12;q++)assert.match(textOf(navigation[q]),new RegExp(`^Q${q}\\s+\\S`));
      assert.equal(result.content.paragraphs.filter(p=>p.code).length,0);
      assert.ok(!nativeText.includes('火箭发射时'),'投票后的上期文章尾部不能导入');
      assert.ok(!nativeText.includes('上期也精彩'));
    }
    if (sample.name.includes('不抽血')) {
      assert.ok(!nativeText.includes('福利时间'),'福利活动尾部不能导入');
      const originalUrl='https://knowablemagazine.org/content/article/health-disease/2026/disease-sniffing-tests-get-closer-to-reality';
      assert.deepEqual(result.requestedSourceLinks,[originalUrl]);
      const fallback=toOpus(doc.body.innerHTML,{document,images:imageMap,sourceLinkValidation:{rejected:[originalUrl]}});
      assert.deepEqual(fallback.blockingIssues,[]);assert.deepEqual(fallback.sourceLinks,[]);
      const fallbackText=fallback.content.paragraphs.flatMap(p=>p.text?.nodes||[]).map(node=>node.word?.words||node.link?.show_text||'').join('');
      assert.ok(fallbackText.includes('Sniffing out the link between odor and disease'));
      assert.equal(fallbackText.split(originalUrl).length-1,1,'B站拒绝的真实出处仍保留完整可复制URL且不重复');
      assert.deepEqual(fallback.content.paragraphs.flatMap(p=>p.pic?.pics||[]),pictures,'链接回退不能改变任何正文图和图注');
    }
    if (sample.name.includes('厉娜')) {
      assert.equal(captures.length,1);assert.deepEqual(captures[0].images,baseline.images.slice(0,14),'cover raster retains all fourteen original layers');
      assert.equal(compact(captures[0].text),'都重新见面了怎么还没和好？从《后会友期》看物理外场变了，过去还算数');
      assert.equal(pictures.length,1+50,'one intact cover composite plus fifty independent source images');
      for (const title of ['还买鸭舌呢，外场早变了','“画地为牢”，这个牢为什么出不去','弹幕都在劝，怎么又说回去了','油烟扇走了，旧事还在后台','所以，下一次开口能做什么']) {
        const word=nativeWords.find(word=>word.words===title);
        assert.ok(word, '标题内容保留可编辑文字');
        assert.equal(word.color,'#ae430e');assert.equal(word.style.bold,true);assert.equal(word.bg_style,undefined,'不得再用半高底纹承载白字');
      }
      assert.ok(result.notices.some(item=>item.severity==='info'&&item.message.includes('背景色加粗文字')));
    }
  });
}
