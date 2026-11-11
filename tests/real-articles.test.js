import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {parseArticle, cleanArticle} from '../extension/lib/article.js';

// User-provided saved pages are local regression inputs, never shipped in the extension.
// DOMParser neither runs their scripts nor loads their external resources.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, '测试文章');
globalThis.DOMParser = new JSDOM('').window.DOMParser;
const expectations = [
  {file:'美瞳爱好者集合，新眼珠享新人生.html', collection:'线上科学日', images:21, gifs:6, formulas:0, superscripts:0, subscripts:0, backgrounds:0, captions:4},
  {file:'细思极恐！为什么我们在三维空间里永远走不出镜像？.html', collection:'线上科学日', images:3, gifs:0, formulas:82, superscripts:0, subscripts:0, backgrounds:0, captions:0},
  {file:'今年诺奖奖金又上涨了一百万？！发了125年，诺贝尔的钱为什么越花越多？.html', collection:'线上科学日', images:13, gifs:3, formulas:0, superscripts:0, subscripts:0, backgrounds:0, captions:9},
  {file:'遍地开花的拼豆店，卖的竟是“诺奖物理”？（内附物理所拼豆图纸）.html', collection:'线上科学日', images:26, gifs:1, formulas:4, superscripts:0, subscripts:14, backgrounds:0, captions:12},
  {file:'不抽血不拍片，闻一闻就能接收身体警报？？？.html', collection:'翻译专栏', images:3, gifs:0, formulas:0, superscripts:0, subscripts:0, backgrounds:0, captions:1},
  {file:'为什么只睡20分钟，下午就能精神满满？_ No. 537.html', collection:'问答', images:7, gifs:0, formulas:7, superscripts:19, subscripts:0, backgrounds:0, captions:3},
  {file:'你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html', collection:'正经玩', images:16, gifs:1, formulas:4, superscripts:0, subscripts:7, backgrounds:0, captions:4},
  {file:'摸了半天找不到头，胶带却记得你撕到哪儿？.html', collection:'线上科学日', images:12, gifs:0, formulas:0, superscripts:0, subscripts:4, backgrounds:0, captions:9},
  {file:'要宣布翻篇了？那我磁化损失呢，厉娜.html', collection:'线上科学日', images:21, gifs:0, formulas:0, superscripts:0, subscripts:0, backgrounds:0, captions:19},
];
const entries = [];
const compact=text=>text.replace(/[\s\u200B-\u200D\uFEFF]/g,'');
// Independently reviewed content figures; all other pre-tail assets are title furniture.
const contentFigureIndices=[14,16,19,23,26,27,30,31,32,35,37,40,43,44,46,49,50,53,57,60,63];
function assertText(actual,expected,message){
  let index=0;while(index<actual.length&&index<expected.length&&actual[index]===expected[index])index++;
  assert.ok(actual===expected,`${message}; first difference ${index}, lengths ${actual.length}/${expected.length}; actual ${JSON.stringify(actual.slice(Math.max(0,index-20),index+60))}; expected ${JSON.stringify(expected.slice(Math.max(0,index-20),index+60))}`);
}
const imageSource=image=>image.getAttribute('data-src')||image.getAttribute('src')||'';
const formulaSources=body=>[...body.querySelectorAll('[data-formula],[data-latex]')].filter(node=>!node.parentElement.closest('[data-formula],[data-latex]')).map(node=>node.getAttribute('data-formula')||node.getAttribute('data-latex'));

// Fixture review fixes the authorized tail boundary independently of cleanArticle.
// Empty WeChat image shells carry no address. The independently reviewed content
// figure inventory below excludes title furniture, while keeping all source text.
function sourceBaseline(source,expected){
  const raw=new DOMParser().parseFromString(source,'text/html'),body=raw.querySelector('#js_content');
  const tail=expected.collection==='翻译专栏'?'fu福li利shi时jian间':expected.collection==='问答'?'投票':expected.collection==='正经玩'?'上期回顾':'近期热门文章Top10';
  const marker=[...body.querySelectorAll('*')].find(node=>compact(node.textContent)===tail);
  assert.ok(marker,`reviewed source tail: ${tail}`);
  const range=raw.createRange();range.selectNodeContents(body);range.setEndBefore(marker);
  const retained=raw.createElement('main');retained.append(range.cloneContents());
  for(const node of [...retained.querySelectorAll('*')])if(node.hidden||node.style.display==='none'||compact(node.textContent)==='左右滑动查看更多')node.remove();
  for(const paragraph of retained.querySelectorAll('p'))if(compact(paragraph.textContent).startsWith('认真阅读下面的文章'))paragraph.remove();
  if(expected.collection==='问答'){
    const walker=raw.createTreeWalker(retained,4),urls=[];
    while(walker.nextNode())walker.currentNode.textContent=walker.currentNode.textContent.replace(/https?:\/\/[^\s]+/g,url=>{urls.push(url);return '';});
    assert.equal(urls.length,5,'five ordinary DOI URLs are deliberately removed; citation prose remains');
  }
  if(expected.file.includes('厉娜')) for(const [index,image] of [...retained.querySelectorAll('img')].entries()) if(!contentFigureIndices.includes(index))image.remove();
  // Reviewed header assets 0–12: opening promotion, paper, clip, waves, leaves and flowers.
  if(expected.file.includes('美瞳')) for(const [index,image] of [...retained.querySelectorAll('img')].entries()) if(index<=12)image.remove();
  return {body:retained,text:compact(retained.textContent),images:[...retained.querySelectorAll('img')].map(imageSource).filter(Boolean),formulas:formulaSources(retained),scripts:[...retained.querySelectorAll('sup,sub')].map(node=>({tag:node.localName,text:node.textContent}))};
}

for (const expected of expectations) {
  const filename = path.join(fixtureDir, expected.file);
  const exists = fs.existsSync(filename);
  let parsed,baseline;
  if (exists) {
    const source = fs.readFileSync(filename, 'utf8');
    const originalDocument = new DOMParser().parseFromString(source, 'text/html');
    const originalBody = originalDocument.querySelector('#js_content');
    baseline=sourceBaseline(source,expected);
    parsed = parseArticle(source);
    const cleanedDocument = new DOMParser().parseFromString(parsed.html, 'text/html');
    const originalImages = [...originalBody.querySelectorAll('img')];
    const coloredNodes = [...cleanedDocument.querySelectorAll('[style]')].filter(node=>node.style?.color);
    const boldNodes = [...cleanedDocument.querySelectorAll('b,strong,[style]')].filter(node=>['B','STRONG'].includes(node.tagName) || ['bold','bolder','600','700','800','900'].includes(node.style?.fontWeight));
    const formulas = [...cleanedDocument.querySelectorAll('[data-formula],[data-latex]')].filter(node=>!node.parentElement.closest('[data-formula],[data-latex]')).map(node=>node.getAttribute('data-formula') || node.getAttribute('data-latex'));
    const localAssets = parsed.localAssets.map(asset=>{
      const absolute = path.resolve(fixtureDir, asset.localPath);
      const inside = absolute.startsWith(`${fixtureDir}${path.sep}`);
      return {...asset, available:inside && fs.existsSync(absolute)};
    });
    entries.push({
      file:expected.file, title:parsed.title, sourceUrl:parsed.sourceUrl,
      coverUrl:parsed.coverUrl, collectionNames:parsed.collectionNames,
      source:{imageElements:originalImages.length,imagesWithRemoteDataSrc:originalImages.filter(img=>/^https?:\/\//.test(img.getAttribute('data-src') || '')).length},
      retained:parsed.stats,
      removedDecorativeImages:parsed.removedDecorativeImages,
      formatting:{boldNodes:boldNodes.length,coloredNodes:coloredNodes.length,colors:[...new Set(coloredNodes.map(node=>node.style.color))],formulas},
      captions:[...cleanedDocument.querySelectorAll('figure > figcaption')].map(caption=>{
        const image=caption.parentElement.querySelector('img');
        return {imageIndex:[...cleanedDocument.images].indexOf(image),sourceUrl:image?.getAttribute('src') || '',text:caption.textContent.trim()};
      }),
      sourceLinks:[...cleanedDocument.querySelectorAll('a[data-sync-source-link="true"]')].map(link=>({href:link.getAttribute('href'),text:link.textContent})),
      blockingIssues:parsed.blockingIssues, warnings:parsed.warnings,
      localAssets,
      backgrounds:[...cleanedDocument.querySelectorAll('[data-sync-background-url]')].map(node=>({url:node.getAttribute('data-sync-background-url'),textPreview:node.textContent.slice(0,45),requiresLocalLayoutConversion:true})),
    });
  }
  test(`real article: ${expected.file}`, {skip: !exists && '用户样稿未附带；合成回归仍会运行。'}, () => {
    assert.ok(parsed.title);
    assert.match(parsed.coverUrl, /^https:\/\/mmbiz\.qpic\.cn\//);
    assert.deepEqual(parsed.collectionNames, [expected.collection]);
    assert.equal(parsed.stats.trimmedTail,1);
    for (const key of ['images','gifs','formulas','superscripts','subscripts','backgrounds','captions']) assert.equal(parsed.stats[key],expected[key],key);
    const document = new DOMParser().parseFromString(parsed.html,'text/html');
    assert.deepEqual([...document.images].map(image=>image.getAttribute('src')),baseline.images,'addressed source images remain in their original order');
    assertText(compact(document.body.textContent),baseline.text,'all source body text remains after the independently listed exclusions');
    assert.deepEqual(formulaSources(document.body),baseline.formulas,'formula source comes from the original DOM');
    assert.deepEqual([...document.querySelectorAll('sup,sub')].map(node=>({tag:node.localName,text:node.textContent})),baseline.scripts,'all original superscript/subscript occurrences remain');
    assert.equal(document.querySelectorAll('script,iframe,a[href]:not([data-sync-source-link="true"]),img:not([src])').length,0);
    assert.equal(parsed.stats.sourceLinks,expected.collection==='翻译专栏'?1:0);
    assert.ok([...document.querySelectorAll('img')].every(img=>/^https:\/\/(?:mmbiz\.qpic\.cn|res\.wx\.qq\.com)\//.test(img.getAttribute('src'))));
    assert.ok([...document.querySelectorAll('svg')].every(svg=>svg.closest('[data-formula],[data-latex]')));
    assert.ok(parsed.blockingIssues.every(issue=>/CSS 背景图|叠层|渐变背景/.test(issue)));
    assert.doesNotMatch(document.body.textContent,/近期热门文章Top10|往期回顾|上期回顾/);
    const cleanedAgain = cleanArticle(parsed.html,{sourceUrl:parsed.sourceUrl});
    for (const key of ['images','gifs','formulas','superscripts','subscripts','backgrounds','captions','sourceLinks']) assert.equal(cleanedAgain.stats[key],parsed.stats[key],`second cleanup ${key}`);
    assert.equal(cleanedAgain.html,parsed.html,'cleanup remains idempotent after caption association');
    assert.deepEqual(cleanedAgain.blockingIssues,parsed.blockingIssues);
    if (expected.collection==='问答') {
      const labels=[...document.querySelectorAll('span')].map(node=>node.textContent.trim());
      for (let n=1;n<=12;n++) assert.ok(labels.includes(`Q${n}`),`editable Q${n} label`);
      const retainedPanels=[...document.querySelectorAll('section')].filter(node=>/^答[：:]/.test(compact(node.textContent))&&node.style.backgroundColor==='rgb(239, 239, 246)');
      assert.equal(retainedPanels.length,3,'three answer cards with images retain their meaningful background');
      assert.ok(retainedPanels.every(panel=>panel.querySelector('img')));
      assert.equal(parsed.stats.removedAnswerPanelBackgrounds,9,'only the nine text-only cards lose box decoration');
      assert.equal(document.querySelector('pre code').querySelectorAll('br').length,12);
      assert.doesNotMatch(document.body.textContent,/投票|上期也精彩|本期答题团队/);
      assert.match(document.body.textContent,/Hayashi M, Motoyoshi N, Hori T/);
      assert.equal(parsed.stats.removedComponentHints,1);
      assert.doesNotMatch(document.body.textContent,/左右滑动查看更多/);
    }
    else assert.equal(parsed.stats.removedAnswerPanelBackgrounds,expected.file.includes('拼豆')?2:0);
    if(expected.file.startsWith('摸了')) {
      assert.equal(parsed.stats.removedFormulaCardDecorations,1);
      const card=[...document.querySelectorAll('section')].find(node=>node.textContent.replace(/\s/g,'')==='ΔF=Fpeak−Fbaseline');
      assert.ok(card);
      assert.equal(card.style.backgroundColor,'');
      assert.equal(card.style.border,'');
      assert.equal(card.style.color,'rgb(130, 66, 46)');
      assert.equal(card.querySelectorAll('sub').length,2);
    } else assert.equal(parsed.stats.removedFormulaCardDecorations,0);
    if (expected.collection==='翻译专栏') {
      assert.equal(parsed.stats.flattenedCharacterHeadings,0,'tail is removed before touching its character cards');
      assert.equal(parsed.stats.removedOpeningLeads,1);
      assert.equal(parsed.stats.removedStanceStatements,2);
      assert.doesNotMatch(document.body.textContent,/福利时间|互动问题|认真阅读下面的文章|仅代表作者观点|不代表中科院物理所立场/);
      assert.match(document.body.textContent,/作者：Marta Zaraska翻译：二律背反审校：持之以恒/);
      const link=document.querySelector('a[data-sync-source-link="true"]');
      assert.equal(link.getAttribute('href'),'https://knowablemagazine.org/content/article/health-disease/2026/disease-sniffing-tests-get-closer-to-reality');
      assert.equal(link.textContent,'Sniffing out the link between odor and disease');
    }
    if (expected.file.includes('厉娜')) {
      assert.deepEqual(parsed.removedDecorativeImages.map(item=>item.imageIndex).sort((a,b)=>a-b),Array.from({length:64},(_,i)=>i).filter(i=>!contentFigureIndices.includes(i)));
      assert.equal(parsed.stats.removedDecorativeImages,43);
      assert.equal(baseline.images.length,21);
      assert.ok([...baseline.body.querySelectorAll('img')].every(image=>!['presentation','none'].includes(image.getAttribute('role'))));
      assert.deepEqual([...document.images].map(image=>Number(new URL(image.src).hash.match(/imgIndex=(\d+)/)?.[1])),contentFigureIndices,'all independently reviewed content figures remain in order');
      for (const text of ['都重新见面了怎么还没和好？','从《后会友期》看物理','外场变了，过去还算数','还买鸭舌呢，外场早变了','“画地为牢”，这个牢为什么出不去','弹幕都在劝，怎么又说回去了','油烟扇走了，旧事还在后台','所以，下一次开口能做什么']) assert.ok(document.body.textContent.includes(text),text);
      for(const index of [46,63]) assert.ok([...document.images].some(img=>img.getAttribute('src').endsWith(`#imgIndex=${index}`)),`content image ${index}`);
      const rawDocument=new DOMParser().parseFromString(fs.readFileSync(filename,'utf8'),'text/html');
      for(const image of rawDocument.querySelectorAll('#js_content img')) if(['34px','58px'].includes(image.parentElement.style.width)) image.style.width='100%';
      const lazyVariant=parseArticle(rawDocument.documentElement.outerHTML);
      assert.equal(lazyVariant.stats.images,21,'changing lazy image widths cannot change semantic retention');
      assert.equal(lazyVariant.stats.removedDecorativeImages,43);
      const lazyDocument=new DOMParser().parseFromString(lazyVariant.html,'text/html');
      assert.deepEqual([...lazyDocument.images].map(image=>image.getAttribute('src')),baseline.images);
    } else if(expected.file.includes('美瞳')) {
      assert.equal(parsed.stats.removedDecorativeImages,13);
      assert.deepEqual(parsed.removedDecorativeImages.map(item=>item.imageIndex).sort((a,b)=>a-b),Array.from({length:13},(_,i)=>i));
    } else assert.equal(parsed.stats.removedDecorativeImages,0);
    if (expected.collection==='正经玩') {
      assert.equal(document.querySelectorAll('[data-sync-background-url]').length,0,'empty title ribbon is decorative');
      assert.ok(document.body.textContent.includes('实验器材'));
      assert.equal(parsed.coverUrl,'https://mmbiz.qpic.cn/mmbiz_jpg/Q5JJsLWYMJWOFjB3xPPD8kc4xhicGDkmqHVZUuicHQP65XJwUSZcTuZ9CJyAa3j6KjUCw70phMYIIBI1HbxYTotSz3o86TCY3EfZgazCScdg0/0?wx_fmt=jpeg');
      assert.deepEqual([...document.querySelectorAll('figure > figcaption')].map(caption=>({imageIndex:[...document.images].indexOf(caption.parentElement.querySelector('img')),text:caption.textContent.trim()})),[
        {imageIndex:0,text:'↑试图用肉眼看清手机屏幕像素的小编'},
        {imageIndex:3,text:'书籍是人类进步的阶梯（物理意义）'},
        {imageIndex:12,text:'半导体晶圆'},
        {imageIndex:13,text:'真实的X射线衍射点阵'},
      ]);
      assert.match(document.body.textContent,/激光/);
      assert.ok([...document.querySelectorAll('figcaption')].every(caption=>!caption.textContent.includes('激光')));
    }
  });
}

if (process.env.WRITE_ARTICLE_AUDIT === '1') {
  fs.mkdirSync(path.join(root,'test-artifacts'), { recursive:true });
  fs.writeFileSync(path.join(root,'test-artifacts','article-audit.json'),JSON.stringify({
    schemaVersion:2,
    verification:'Local source-DOM parsing and preservation regression with explicitly reviewed tail, opening-lead, hint and ordinary-URL exclusions. Original image identity/order, text, formula source and script occurrences are checked independently of the cleaned output. No page scripts, external requests, canvas pixels or Bilibili save/readback are verified here. Private samples are historical regression inputs, not evidence of general template support.',
    articles:entries,
  },null,2)+'\n');
}
