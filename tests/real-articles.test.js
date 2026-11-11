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
  {file:'不抽血不拍片，闻一闻就能接收身体警报？？？.html', collection:'翻译专栏', images:3, gifs:0, formulas:0, superscripts:0, subscripts:0, backgrounds:0, captions:1},
  {file:'为什么只睡20分钟，下午就能精神满满？_ No. 537.html', collection:'问答', images:7, gifs:0, formulas:7, superscripts:19, subscripts:0, backgrounds:0, captions:3},
  {file:'你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html', collection:'正经玩', images:16, gifs:1, formulas:4, superscripts:0, subscripts:7, backgrounds:0, captions:4},
  {file:'摸了半天找不到头，胶带却记得你撕到哪儿？.html', collection:'线上科学日', images:12, gifs:0, formulas:0, superscripts:0, subscripts:4, backgrounds:0, captions:9},
  {file:'要宣布翻篇了？那我磁化损失呢，厉娜.html', collection:'线上科学日', images:21, gifs:0, formulas:0, superscripts:0, subscripts:0, backgrounds:0, captions:19},
];
const entries = [];

for (const expected of expectations) {
  const filename = path.join(fixtureDir, expected.file);
  const exists = fs.existsSync(filename);
  let parsed;
  if (exists) {
    const source = fs.readFileSync(filename, 'utf8');
    const originalDocument = new DOMParser().parseFromString(source, 'text/html');
    const originalBody = originalDocument.querySelector('#js_content');
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
    assert.equal(document.querySelectorAll('script,iframe,a[href]:not([data-sync-source-link="true"]),img:not([src])').length,0);
    assert.equal(parsed.stats.sourceLinks,expected.collection==='翻译专栏'?1:0);
    assert.ok([...document.querySelectorAll('img')].every(img=>/^https:\/\/(?:mmbiz\.qpic\.cn|res\.wx\.qq\.com)\//.test(img.getAttribute('src'))));
    assert.ok([...document.querySelectorAll('svg')].every(svg=>svg.closest('[data-formula],[data-latex]')));
    assert.ok(parsed.blockingIssues.every(issue=>issue.includes('CSS 背景图')));
    assert.doesNotMatch(document.body.textContent,/近期热门文章Top10|往期回顾|上期回顾/);
    const cleanedAgain = cleanArticle(parsed.html,{sourceUrl:parsed.sourceUrl});
    for (const key of ['images','gifs','formulas','superscripts','subscripts','backgrounds','captions','sourceLinks']) assert.equal(cleanedAgain.stats[key],parsed.stats[key],`second cleanup ${key}`);
    assert.equal(cleanedAgain.html,parsed.html,'cleanup remains idempotent after caption association');
    assert.deepEqual(cleanedAgain.blockingIssues,parsed.blockingIssues);
    if (expected.collection==='问答') {
      const labels=[...document.querySelectorAll('span')].map(node=>node.textContent.trim());
      for (let n=1;n<=12;n++) assert.ok(labels.includes(`Q${n}`),`editable Q${n} label`);
      assert.equal(parsed.stats.removedDecorativeBackgrounds,12);
      assert.equal(parsed.stats.removedAnswerPanelBackgrounds,12);
      assert.ok([...document.querySelectorAll('section')].filter(node=>/^答[：:]/.test(node.textContent.replace(/\s/g,''))).every(node=>node.style.backgroundColor!=='rgb(239, 239, 246)'));
      assert.equal(document.querySelector('pre code').querySelectorAll('br').length,12);
      assert.doesNotMatch(document.body.textContent,/投票|上期也精彩|本期答题团队/);
      assert.match(document.body.textContent,/Hayashi M, Motoyoshi N, Hori T/);
      assert.equal(parsed.stats.removedComponentHints,1);
      assert.doesNotMatch(document.body.textContent,/左右滑动查看更多/);
    }
    else assert.equal(parsed.stats.removedAnswerPanelBackgrounds,0);
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
      assert.equal(parsed.stats.flattenedCharacterHeadings,1);
      assert.equal(parsed.stats.removedOpeningLeads,1);
      assert.equal(parsed.stats.removedStanceStatements,2);
      assert.doesNotMatch(document.body.textContent,/福利时间|互动问题|认真阅读下面的文章|仅代表作者观点|不代表中科院物理所立场/);
      assert.match(document.body.textContent,/作者：Marta Zaraska翻译：二律背反审校：持之以恒/);
      const link=document.querySelector('a[data-sync-source-link="true"]');
      assert.equal(link.getAttribute('href'),'https://knowablemagazine.org/content/article/health-disease/2026/disease-sniffing-tests-get-closer-to-reality');
      assert.equal(link.textContent,'Sniffing out the link between odor and disease');
    }
    if (expected.file.includes('厉娜')) {
      const indices=parsed.removedDecorativeImages.map(item=>item.imageIndex);
      assert.deepEqual(indices,[0,1,2,3,4,5,6,7,8,9,10,11,12,13,15,17,18,20,21,22,24,25,28,29,33,34,36,38,39,41,42,45,47,48,51,52,54,55,56,58,59,61,62]);
      assert.equal(parsed.stats.removedDecorativeImages,43);
      for (const text of ['都重新见面了怎么还没和好？','从《后会友期》看物理','外场变了，过去还算数','还买鸭舌呢，外场早变了','“画地为牢”，这个牢为什么出不去','弹幕都在劝，怎么又说回去了','油烟扇走了，旧事还在后台','所以，下一次开口能做什么']) assert.ok(document.body.textContent.includes(text),text);
      for(const index of [46,63]) assert.ok([...document.images].some(img=>img.getAttribute('src').endsWith(`#imgIndex=${index}`)),`content image ${index}`);
      const rawDocument=new DOMParser().parseFromString(fs.readFileSync(filename,'utf8'),'text/html');
      for(const image of rawDocument.querySelectorAll('#js_content img')) if(['34px','58px'].includes(image.parentElement.style.width)) image.style.width='100%';
      const lazyVariant=parseArticle(rawDocument.documentElement.outerHTML);
      assert.equal(lazyVariant.stats.images,21,'live lazy image widths');
      assert.equal(lazyVariant.stats.removedDecorativeImages,43,'same decoration roles before image decoding');
      assert.deepEqual(lazyVariant.removedDecorativeImages.map(item=>item.imageIndex),indices);
    } else assert.equal(parsed.stats.removedDecorativeImages,0);
    if (expected.collection==='正经玩') {
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
  fs.writeFileSync(path.join(root,'docs','article-audit.json'),JSON.stringify({
    schemaVersion:1,
    verification:'Local HTML parsing only. Page scripts were not executed; no external requests were made. Bilibili save/readback is a separate integration check.',
    localAssetResolution:'Match sourceUrl to selected File using localPath relative to the saved HTML folder. data-src remains the original remote URL; localasset:/// + encodeURIComponent(localPath) is used only when no remote image source exists. Read image bytes and substitute an object/data URL for preview, then upload original bytes. Do not infer resource mapping by filename alone.',
    backgroundExtraction:'Content-first cleanup resolves WeChat lazy background metadata before classification. Small empty decorations up to 48×48px are omitted; question/answer labels and short headings with proven small tiles retain native editable text. Text-only cards with explicit small repeated texture omit only the image layer when effective text colors remain readable against retained solid backgrounds. Unknown or potentially informative backgrounds remain marked for local rendering. In these five private samples, the 20×25px 正经玩 decoration, all Q1–Q12 backgrounds, and the 翻译专栏 interaction-card texture are omitted; source content images, formulas, superscripts, subscripts, bold and text colors remain.',
    captionExtraction:'Recognizes only the immediately following standalone text leaf with effective 9–15px type and muted gray color (mean RGB 90–190, channel spread at most 40). Retains the complete caption node and inherited semantic styling inside figure/figcaption; existing captions are preserved. Does not cross body paragraphs, choose a single image within a same-paragraph image group, move entire multi-paragraph sections, or absorb heading/credit/disclaimer blocks. The shared upper/lower-image caption in the translation sample stays body text. Bilibili native comment eligibility, the 100-character limit and formatting fallback are checked separately by the native converter.',
    reviewedOrnaments:'The 厉娜 template is recognized only by the reviewed 14 ornament asset identities and its overlapping-grid structure. Its 14 decorative cover layers, five 58px chapter badges, and twelve pairs of 34px heading ornaments are omitted after role checks; live lazy images may use width:100% or no width inside the same verified fixed-size wrapper. All three cover text layers, five chapter headings, 19 captioned images and the two other content images remain. Unknown collages and unrelated small images are retained. The 翻译专栏 character-card heading is normalized so its 福利时间 footer boundary can be recognized.',
    footerCleanup:'Removes the independent opening WeChat giveaway lead and standalone author-opinion/institution-position disclaimers. Tail boundaries include the normalized 福利时间/互动问题 columns and explicit 投票/上期也精彩 headings. Earlier author, editor and reference text remains; text after a clear footer boundary is omitted with the entire tail column. The translation sample retains three content images; the Q&A sample retains seven content images and all 12 answers, reference citations and 26 native formulas after conversion. Navigation BR wrappers are preserved for the native converter to emit separate editable lines.',
    sourceLinksAndHints:'A standalone 原文链接： citation may retain exactly one validated HTTP(S) anchor with data-sync-source-link="true"; its label, inline semantics and colors remain. Incoming markers are never trusted without rechecking the citation structure and URL. Bare URLs remain visible only inside this allowed source anchor; other external links follow normal cleanup. Standalone 左右滑动查看更多 component hints are omitted, while body mentions and code samples remain.',
    reviewedAnswerPanels:'Only the 12 verified multi-paragraph answer panels beginning 答： with the matching pale background, blue border, radius and spacing omit their container backdrop after per-text contrast checks. The one reviewed tape ΔF = Fpeak − Fbaseline formula card also omits its cream backdrop and border after matching formula structure, colors, spacing and contrast. Its brown text, italics and subscripts remain native. Inline highlights, navigation blocks, unknown colored cards and white-on-brown headings retain their backgrounds. Background shorthand solid colors are explicitly preserved before classification; CSSOM image resets initial/unset are recognized as none, while URLs, gradients and inherit remain protected. Equivalent expanded corner/padding and normal font-weight forms match the same reviewed structures.',
    articles:entries,
  },null,2)+'\n');
}
