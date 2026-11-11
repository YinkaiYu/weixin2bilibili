import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseArticle, cleanArticle, inspectArticle, rewriteImageSources } from '../extension/lib/article.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const sourceUrl = 'https://mp.weixin.qq.com/s/example';
const doc = html => new DOMParser().parseFromString(html, 'text/html');

test('extracts cover/collection while preserving lazy GIF, formula, colors, superscripts and subscripts', () => {
  const result = parseArticle(`<html><head><title>页面标题</title><script>var msg_cdn_url = "https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg&amp;a=1"; var album_title = "正经玩";</script></head><body>
    <h1 id="activity-name">  科学文章  </h1><div id="js_content"><p style="color:#a00;font-weight:700">红色<strong>加粗</strong> H<sub>2</sub>O 与 x<sup>2</sup></p>
    <p><img src="placeholder.png" data-src="https://mmbiz.qpic.cn/example/0?wx_fmt=gif" data-type="gif" alt="演示"></p>
    <p>行内<img class="latex" data-src="//mmbiz.qpic.cn/math.png" alt="E=mc²" style="vertical-align:middle;width:60px">公式</p></div></body></html>`, {sourceUrl});
  assert.equal(result.title, '科学文章');
  assert.equal(result.coverUrl, 'https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg&a=1');
  assert.deepEqual(result.collectionNames, ['正经玩']);
  assert.deepEqual(result.blockingIssues, []);
  const content = doc(result.html);
  assert.equal(content.querySelectorAll('img').length, 2);
  assert.match(content.querySelector('img').src, /wx_fmt=gif/);
  assert.ok(content.querySelector('sup'));
  assert.ok(content.querySelector('sub'));
  assert.equal(content.querySelector('p').style.color, 'rgb(170, 0, 0)');
  assert.equal(content.querySelectorAll('p')[2].textContent, '行内公式');
  assert.equal(result.stats.gifs, 1);
  assert.equal(result.stats.formulas, 1);
});

for (const marker of ['上期回顾', '往期回顾', '近期热门文章 Top10']) {
  test(`trims nested tail at ${marker}, but keeps prior text and images`, () => {
    const result = cleanArticle(`<section><p>正文提到往期回顾，并不应该截断。</p><img src="https://mmbiz.qpic.cn/keep.png"><section><p><strong>${marker}</strong></p><p>旧文章</p></section></section><p>尾部广告</p>`, {sourceUrl});
    assert.match(result.html, /正文提到往期回顾/);
    assert.match(result.html, /keep\.png/);
    assert.doesNotMatch(result.html, /旧文章|尾部广告/);
    assert.equal(result.stats.trimmedTail, 1);
  });
}

test('handles split footer heading and does not remove image before it', () => {
  const result = cleanArticle('<section><img src="https://mmbiz.qpic.cn/keep.png"><p><span>近期热门文章</span><b>Top10</b></p><p>删除</p></section>');
  assert.match(result.html, /keep.png/);
  assert.doesNotMatch(result.html, /Top10|删除/);
});

test('strips external link destination and raw URLs, blank spacer blocks and unsafe content', () => {
  const result = cleanArticle(`<div><p>&nbsp;<br></p><section><p> </p></section><p><a href="https://external.test" onclick="x()">保留标签</a> https://external.test/a。</p>
    <p style="background-image:url(https://evil.test);color:blue" onclick="alert(1)">安全文字<script>alert(1)</script><img data-src="https://mmbiz.qpic.cn/ok.png" srcset="https://evil.test 2x" onerror="alert(1)"></p></div>`);
  const content = doc(result.html);
  assert.equal(content.querySelectorAll('a, script').length, 0);
  assert.match(content.body.textContent, /保留标签/);
  assert.doesNotMatch(result.html, /external\.test|onclick|onerror|srcset/);
  assert.ok(result.blockingIssues.some(issue => issue.includes('CSS 背景图')));
  assert.ok(result.stats.removedEmptyBlocks >= 3);
  assert.equal(content.querySelectorAll('p').length, 2);
  assert.equal(content.querySelectorAll('p')[1].style.color, 'blue');
});

test('does not silently discard unsupported SVG, MathML or embedded media', () => {
  const result = cleanArticle('<p>公式</p><svg viewBox="0 0 20 20"><script>bad()</script><path d="M0 0L10 10" stroke="red" onload="bad()"/></svg><math><msup><mi>x</mi><mn>2</mn></msup></math><iframe src="https://example.test"></iframe>');
  const content = doc(result.html);
  assert.ok(content.querySelector('svg path'));
  assert.ok(content.querySelector('math msup'));
  assert.ok(content.querySelector('[data-sync-unsupported="iframe"]'));
  assert.doesNotMatch(result.html, /<script|onload|<iframe/);
  assert.equal(result.blockingIssues.length, 3);
  assert.deepEqual(inspectArticle(result.html).blockingIssues, result.blockingIssues);
});

test('blocks missing image URLs and SVG data images instead of replacing them with blanks', () => {
  const result = cleanArticle('<p><img src="javascript:alert(1)"><img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></p>');
  assert.equal(doc(result.html).querySelectorAll('img').length, 2);
  assert.equal(result.blockingIssues.length, 2);
});

test('mapping rewrites all repeated images while preserving inline layout', () => {
  const result = rewriteImageSources('<p>左<img src="https://mmbiz.qpic.cn/a.gif">右</p><p><img src="https://mmbiz.qpic.cn/a.gif"></p>', new Map([['https://mmbiz.qpic.cn/a.gif', 'https://i0.hdslb.com/bfs/article/a.gif']]));
  assert.equal(doc(result).querySelectorAll('img[src="https://i0.hdslb.com/bfs/article/a.gif"]').length, 2);
  assert.equal(doc(result).querySelector('p').textContent, '左右');
});

test('script metadata parsing never executes scripts and supports escaped covers and collection names', () => {
  globalThis.articleScriptRan = false;
  const result = parseArticle(`<script>articleScriptRan = true; var msg_cdn_url='https:\\/\\/mmbiz.qpic.cn\\/cover.jpg?x=1\\x26y=2'; var album_name='正经玩';</script><div id="js_content"><p>正文</p></div>`);
  assert.equal(globalThis.articleScriptRan, false);
  assert.equal(result.coverUrl, 'https://mmbiz.qpic.cn/cover.jpg?x=1&y=2');
  assert.deepEqual(result.collectionNames, ['正经玩']);
});

test('does not mistake unrelated CDN variables for the article cover', () => {
  const result = parseArticle('<head><meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg"><script>var avatar_cdn_url="https://mmbiz.qpic.cn/avatar.jpg";</script></head><body><div id="js_content"><p>正文</p></div></body>');
  assert.equal(result.coverUrl, 'https://mmbiz.qpic.cn/cover.jpg');
});

test('reports background images rather than silently losing them during style cleanup', () => {
  const result = cleanArticle('<section style="background-image:url(https://mmbiz.qpic.cn/bg.png)"><p>正文</p></section>');
  assert.match(result.html, /正文/);
  assert.match(result.html, /background-image/);
  assert.match(result.html, /data-sync-background-url/);
  assert.match(result.blockingIssues.join(' '), /CSS 背景图/);
});

test('restores an unclassified large lazy background instead of discarding its transparent CSS placeholder', () => {
  // This MIME-mislabeled PNG placeholder is the one actually present in the
  // saved 正经玩 title decoration; its real image lives in data-lazy-bgimg.
  const placeholder = 'data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
  const result = cleanArticle(`<section data-lazy-bgimg="https://mmbiz.qpic.cn/decoration.png" style="width:320px;height:200px;margin-top:-14px;background-image:url('${placeholder}');background-size:100% 100%"><br></section>`);
  const element = doc(result.html).querySelector('section');
  assert.equal(element.getAttribute('data-sync-background-url'), 'https://mmbiz.qpic.cn/decoration.png');
  assert.equal(element.style.backgroundImage, 'url("https://mmbiz.qpic.cn/decoration.png")');
  assert.equal(element.style.height, '200px');
  assert.equal(element.style.marginTop, '-14px');
  assert.equal(result.stats.backgrounds, 1);
  assert.equal(result.stats.removedTransparentBackgrounds, 0);
  assert.ok(result.blockingIssues.some(issue => issue.includes('CSS 背景图')));
  assert.equal(cleanArticle(result.html).stats.backgrounds, 1);
});

test('does not promote executable or malformed lazy backgrounds into image sources', () => {
  const result = cleanArticle('<section data-lazy-bgimg="javascript:alert(1)"><p>保留正文</p></section><section data-lazy-bgimg="data:text/html,invalid"><p>第二段</p></section>');
  const content = doc(result.html);
  assert.equal(content.querySelectorAll('[data-sync-background-url]').length, 0);
  assert.equal(content.querySelectorAll('[data-sync-unsupported="CSS 背景图"]').length, 2);
  assert.equal(content.body.textContent, '保留正文第二段');
  assert.doesNotMatch(result.html, /javascript:|data:text\/html/);
});

test('preserves flex layout properties used by background decorations without allowing page positioning', () => {
  const result = cleanArticle('<section style="display:flex;justify-content:center;align-items:flex-end;align-content:center;flex-direction:row;flex-wrap:wrap;gap:8px;row-gap:2px;column-gap:4px;position:fixed"><span style="flex:1 0 20px;align-self:center;order:2;min-width:10px;box-sizing:border-box">标题</span></section>');
  const content = doc(result.html), section = content.querySelector('section'), span = content.querySelector('span');
  for (const [key,value] of Object.entries({display:'flex',justifyContent:'center',alignItems:'flex-end',alignContent:'center',flexDirection:'row',flexWrap:'wrap',gap:'8px',rowGap:'2px',columnGap:'4px'})) assert.equal(section.style[key], value, key);
  assert.equal(section.style.position, '');
  assert.equal(span.style.flex, '1 0 20px');
  assert.equal(span.style.alignSelf, 'center');
  assert.equal(span.style.order, '2');
  assert.equal(span.style.minWidth, '10px');
  assert.equal(span.style.boxSizing, 'border-box');
});

test('preserves corner radii and border longhands exposed by Chromium shorthand expansion', () => {
  const result = cleanArticle('<section style="border-top-left-radius:8px;border-top-right-radius:6px 10px;border-bottom-right-radius:4px;border-bottom-left-radius:2px;border-top-width:1px;border-top-style:solid;border-top-color:#fcb42b;border-right-width:2px;border-right-style:dashed;border-right-color:red;border-bottom-width:3px;border-bottom-style:dotted;border-bottom-color:blue;border-left-width:4px;border-left-style:double;border-left-color:green;position:fixed;top:0;left:0">实验器材</section>');
  const style = doc(result.html).querySelector('section').style;
  assert.equal(style.borderTopLeftRadius, '8px');
  assert.equal(style.borderTopRightRadius, '6px 10px');
  assert.equal(style.borderBottomRightRadius, '4px');
  assert.equal(style.borderBottomLeftRadius, '2px');
  assert.deepEqual([style.borderTopWidth,style.borderTopStyle,style.borderTopColor], ['1px','solid','rgb(252, 180, 43)']);
  assert.deepEqual([style.borderRightWidth,style.borderRightStyle,style.borderRightColor], ['2px','dashed','red']);
  assert.deepEqual([style.borderBottomWidth,style.borderBottomStyle,style.borderBottomColor], ['3px','dotted','blue']);
  assert.deepEqual([style.borderLeftWidth,style.borderLeftStyle,style.borderLeftColor], ['4px','double','green']);
  assert.equal(style.position, '');
  assert.equal(style.top, '');
  assert.equal(style.left, '');
});

test('preserves unknown background position longhands for local rendering', () => {
  const result = cleanArticle('<section style="background-image:url(https://mmbiz.qpic.cn/decoration.png);background-position-x:50%;background-position-y:top;background-repeat:no-repeat">待保留的信息图</section>');
  const element = doc(result.html).querySelector('section');
  assert.equal(element.style.getPropertyValue('background-position-x'), '50%');
  assert.equal(element.style.getPropertyValue('background-position-y'), 'top');
  assert.equal(element.style.backgroundRepeat, 'no-repeat');
  assert.equal(element.getAttribute('data-sync-background-url'), 'https://mmbiz.qpic.cn/decoration.png');
  assert.ok(result.blockingIssues.some(issue => issue.includes('CSS 背景图')));
});

test('omits explicitly decorative empty backgrounds while preserving unknown small information graphics',()=>{
  const result=cleanArticle('<section style="background-color:orange"><strong style="color:black">实验器材</strong><section role="presentation" data-lazy-bgimg="https://mmbiz.qpic.cn/ribbon.png" style="width:200px;height:250px;margin-top:-14px;background-color:orange"><br></section></section><p><img src="https://mmbiz.qpic.cn/small.gif" width="20" height="25"></p><section data-lazy-bgimg="https://mmbiz.qpic.cn/small-chart.png" style="width:20px;height:25px"></section>');
  const content=doc(result.html);
  assert.equal(content.body.textContent,'实验器材');
  assert.ok(content.querySelector('strong'));
  assert.equal(content.querySelectorAll('img').length,1);
  assert.equal(content.querySelector('section').style.backgroundColor,'orange');
  assert.equal(result.stats.removedSmallDecorations,1);
  assert.equal(result.stats.backgrounds,1);
  assert.match(content.querySelector('[data-sync-background-url]').getAttribute('data-sync-background-url'),/small-chart/);
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('question and answer label backgrounds become editable text with original emphasis and color',()=>{
  const result=cleanArticle('<section><span style="color:#808080;font-weight:bold;background-image:url(https://mmbiz.qpic.cn/q.png);background-size:110px auto">Q127</span><b data-lazy-bgimg="https://mmbiz.qpic.cn/a.png" style="color:#333">A2：</b><h3 style="color:blue;background-image:url(https://mmbiz.qpic.cn/title.png);background-size:100px auto">实验结果</h3></section>');
  const content=doc(result.html);
  assert.equal(content.body.textContent,'Q127A2：实验结果');
  assert.equal(content.querySelector('span').style.fontWeight,'bold');
  assert.equal(content.querySelector('span').style.color,'rgb(128, 128, 128)');
  assert.equal(content.querySelector('h3').style.color,'blue');
  assert.equal(result.stats.removedDecorativeBackgrounds,3);
  assert.equal(result.stats.backgrounds,0);
  assert.deepEqual(result.blockingIssues,[]);
});

test('retains white text support from ancestor solid backgrounds and checks the nearest text color',()=>{
  const result=cleanArticle('<section style="background-color:rgb(90,45,20);color:white"><span data-lazy-bgimg="https://mmbiz.qpic.cn/q.png">Q1</span></section><section style="color:white"><span style="color:black;background-image:url(https://mmbiz.qpic.cn/a.png)">A1</span></section><span style="color:white;background-image:url(https://mmbiz.qpic.cn/needed.png)">Q2</span>');
  const content=doc(result.html);
  assert.equal(result.stats.removedDecorativeBackgrounds,2);
  assert.equal(content.querySelector('section').style.backgroundColor,'rgb(90, 45, 20)');
  assert.equal(content.querySelector('section').style.color,'white');
  assert.equal(content.querySelector('[data-sync-background-url]').textContent,'Q2');
  assert.equal(result.stats.backgrounds,1);
});

test('removes proven tiled card texture but retains unknown backgrounds and content-bearing media',()=>{
  const text='这是一段足够长的互动说明文字，所有信息都来自可以编辑的文字内容，背景只是一张重复铺满卡片的小纹理。';
  const result=cleanArticle(`<section style="color:white;background-color:white;background-image:url(https://mmbiz.qpic.cn/tile.png);background-size:29% auto;background-repeat:repeat"><p style="color:black">${text}</p></section><section style="background-image:url(https://mmbiz.qpic.cn/infographic.png);background-size:100% auto;background-repeat:no-repeat">${text}</section><section style="background-image:url(https://mmbiz.qpic.cn/tile.png);background-size:29% auto;background-repeat:repeat">${text}<img src="https://mmbiz.qpic.cn/content.png"></section>`);
  const content=doc(result.html);
  assert.equal(result.stats.removedDecorativeBackgrounds,1);
  assert.equal(result.stats.backgrounds,2);
  assert.equal(content.querySelector('section').style.backgroundColor,'white');
  assert.equal(content.querySelectorAll('img').length,1);
  assert.equal(content.querySelectorAll('section')[0].textContent,text);
  assert.equal(cleanArticle(result.html).stats.backgrounds,2);
});

test('saved article collection DOM and local image mapping are retained', () => {
  const result = parseArticle('<!-- saved from url=(0049)https://mp.weixin.qq.com/s/example --><div class="album_name_title">#正经玩</div><span class="js_album_directory__name">正经玩 · 目录</span><div id="js_content"><p><img data-src="https://mmbiz.qpic.cn/a.gif" src="./文章_files/640"></p><p><img src="./文章_files/640(1)"></p></div>');
  assert.equal(result.sourceUrl, 'https://mp.weixin.qq.com/s/example');
  assert.deepEqual(result.collectionNames, ['正经玩']);
  assert.deepEqual(result.localAssets, [{sourceUrl:'https://mmbiz.qpic.cn/a.gif',localPath:'文章_files/640'},{sourceUrl:`localasset:///${encodeURIComponent('文章_files/640(1)')}`,localPath:'文章_files/640(1)'}]);
  assert.ok(result.blockingIssues.some(issue=>issue.includes('本地资源目录')));
  assert.equal(cleanArticle(result.html).localAssets.length,2);
});

test('removes known empty editor shells but retains real formula source and SVG', () => {
  const result = cleanArticle('<p><img class="rich_pages wxw-img"><svg viewBox="0 0 1 1"></svg></p><p><span data-formula="x^2"><span data-formula="x^2"><svg viewBox="0 0 20 20"><path d="M0 0L10 10"/></svg></span></span></p>');
  assert.equal(result.stats.removedImagePlaceholders,1);
  assert.equal(result.stats.removedEmptySvg,1);
  assert.equal(result.stats.formulas,1);
  assert.equal(doc(result.html).querySelectorAll('[data-formula]').length,2);
  assert.deepEqual(result.blockingIssues,[]);
});

test('never invents LaTeX source from an image class or alternative text', () => {
  const result = cleanArticle('<p><img class="latex math" src="https://mmbiz.qpic.cn/formula.png" alt="公式图片说明"><img class="equation" src="https://mmbiz.qpic.cn/another.png"></p>');
  const document = doc(result.html);
  assert.equal(document.querySelectorAll('[data-formula],[data-latex]').length,0);
  assert.equal(document.querySelectorAll('img[data-sync-formula-image]').length,2);
  assert.equal(result.stats.formulas,2);
  assert.equal(cleanArticle(result.html).stats.formulas,2);
  assert.equal(document.querySelector('img').getAttribute('alt'),'公式图片说明');
});

test('removing a link retains its own color, bold and nested image without an active destination',()=>{
  const result=cleanArticle('<p><a href="https://example.test" onclick="bad()" style="color:#e03040;font-weight:700;text-decoration:underline;position:fixed">链接内<strong>文字</strong><img src="https://mmbiz.qpic.cn/p.png"></a> <a href="https://example.test/plain">普通链接</a></p>');
  const document=doc(result.html);
  const span=document.querySelector('p > span');
  assert.equal(span.style.color,'rgb(224, 48, 64)');
  assert.equal(span.style.fontWeight,'700');
  assert.equal(span.style.textDecoration,'underline');
  assert.equal(span.style.position,'');
  assert.equal(span.querySelector('img').getAttribute('src'),'https://mmbiz.qpic.cn/p.png');
  assert.equal(document.querySelectorAll('a,[href],[onclick]').length,0);
  assert.match(document.body.textContent,/普通链接/);
  assert.equal(result.stats.removedLinks,2);
});

test('removes explicitly hidden content before style cleanup and footer detection', () => {
  const result = cleanArticle('<p>前文</p><div style="display:none!important"><img src="https://mmbiz.qpic.cn/tracker.png"><p>往期回顾</p></div><p hidden="false">隐藏文字</p><img hidden src="https://mmbiz.qpic.cn/hidden.png"><p aria-hidden="true">仍然可见</p><p>后文</p>');
  assert.equal(doc(result.html).body.textContent, '前文仍然可见后文');
  assert.equal(result.stats.images, 0);
  assert.equal(result.stats.trimmedTail, 0);
  assert.equal(result.stats.removedHiddenElements, 3);
  assert.deepEqual(result.blockingIssues, []);
});

test('retains declared formula semantics from hidden carriers without exposing other hidden content', () => {
  const result = cleanArticle('<div hidden style="color:red">隐藏文字<img src="https://mmbiz.qpic.cn/tracker.png"><b><span data-formula="x^2" style="display:none"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></span></b><span hidden data-latex="E=mc^2"></span></div><p>正文</p>');
  const content = doc(result.html);
  assert.deepEqual([...content.querySelectorAll('[data-formula],[data-latex]')].map(node => node.getAttribute('data-formula') || node.getAttribute('data-latex')), ['x^2', 'E=mc^2']);
  assert.equal(content.querySelectorAll('[hidden],img').length, 0);
  assert.equal(content.querySelector('[data-formula]').style.display, '');
  assert.equal(content.querySelector('div').style.color, 'red');
  assert.ok(content.querySelector('b [data-formula] svg'));
  assert.equal(content.body.textContent, '正文');
  assert.equal(result.stats.formulas, 2);
  assert.deepEqual(result.blockingIssues, []);
});

test('removes empty WeChat shells with lazy metadata but preserves authored missing images', () => {
  const result = cleanArticle('<p><img class="rich_pages wxw-img" data-index="2" data-order="0" loading="lazy" src=""><img class="wxw-img" data-loaded="false" style=""></p><p><img class="wxw-img" alt="缺失的插图"><img class="wxw-img" data-imgfileid="123"><img class="wxw-img" data-formula="x^2"><img alt="未知图片"></p>');
  assert.equal(result.stats.removedImagePlaceholders, 2);
  const remaining = [...doc(result.html).images];
  assert.equal(remaining.length, 4);
  assert.ok(remaining.some(image => image.getAttribute('alt') === '缺失的插图'));
  assert.ok(remaining.some(image => image.getAttribute('data-formula') === 'x^2'));
  assert.ok(result.blockingIssues.some(issue => issue.includes('没有可读取')));
});

test('only removes exact transparent pixels with WeChat placeholder evidence and no real source', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const unknownSmall = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6kAAAAASUVORK5CYII=';
  const result = cleanArticle(`<p><img class="wxw-img js_img_placeholder" src="${png}" data-index="1"><img class="wxw-img wx_img_placeholder" src="${gif}"></p>
    <p><img class="wxw-img js_img_placeholder" src="${png}" data-src="https://mmbiz.qpic.cn/photo.jpg"><img class="wxw-img js_img_placeholder" src="${gif}" data-original="https://mmbiz.qpic.cn/animation.gif"></p>
    <p><img src="${png}"><img class="wxw-img" src="${gif}"><img class="wxw-img js_img_placeholder" src="${unknownSmall}"><img class="wxw-img js_img_placeholder" alt="作者说明" src="${png}"><img class="wxw-img js_img_placeholder" src="https://mmbiz.qpic.cn/real-small.png" width="1" height="1"><img class="wxw-img js_img_placeholder" data-imgfileid="123" src="${png}"><img class="wxw-img js_img_placeholder" data-w="1080" src="${png}"></p>`);
  const images = [...doc(result.html).images];
  assert.equal(result.stats.removedImagePlaceholders, 2);
  assert.equal(images.length, 9);
  assert.equal(images[0].getAttribute('src'), 'https://mmbiz.qpic.cn/photo.jpg');
  assert.equal(images[1].getAttribute('src'), 'https://mmbiz.qpic.cn/animation.gif');
  assert.ok(images.some(image => image.getAttribute('src') === unknownSmall));
  assert.ok(images.some(image => image.getAttribute('alt') === '作者说明'));
  assert.ok(images.some(image => image.getAttribute('src') === 'https://mmbiz.qpic.cn/real-small.png'));
  assert.ok(images.some(image => image.getAttribute('data-w') === '1080'));
  assert.deepEqual(result.blockingIssues, []);
});

test('associates a following small gray caption with its image and preserves caption markup', () => {
  const result=cleanArticle('<section><p><img data-src="https://mmbiz.qpic.cn/demo.gif?wx_fmt=gif" data-type="gif"></p><p style="font-size:14px;color:#888;text-align:center">图1：<strong>演示</strong> H<sub>2</sub>O 与 x<sup>2</sup></p><p>正文继续</p></section>');
  const content=doc(result.html), figure=content.querySelector('figure');
  assert.equal(result.stats.captions,1);
  assert.equal(result.stats.gifs,1);
  assert.equal(figure.querySelector('img').getAttribute('src'),'https://mmbiz.qpic.cn/demo.gif?wx_fmt=gif');
  assert.equal(figure.querySelector('figcaption > p').textContent,'图1：演示 H2O 与 x2');
  assert.ok(figure.querySelector('figcaption strong'));
  assert.ok(figure.querySelector('figcaption sub'));
  assert.ok(figure.querySelector('figcaption sup'));
  assert.equal(content.querySelector('figure + p').textContent,'正文继续');
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('only moves the first caption leaf from a section that also contains gray body text', () => {
  const result=cleanArticle('<p><img src="https://mmbiz.qpic.cn/a.png"></p><section style="color:#888;font-size:14px"><p>图1：说明</p><p>接下来是正文</p></section>');
  const content=doc(result.html);
  assert.equal(content.querySelector('figcaption').textContent,'图1：说明');
  assert.equal(content.querySelector('figure + section').textContent,'接下来是正文');
  assert.equal(content.querySelectorAll('figcaption p').length,1);
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('moving a caption preserves inherited emphasis, highlight and relative font sizes', () => {
  const result=cleanArticle('<p><img src="https://mmbiz.qpic.cn/a.png"></p><section style="color:#888;font-size:14px;font-weight:700;font-style:italic;background-color:yellow;text-decoration:underline"><p style="font-size:.9em">图：继承样式</p><p style="color:black">正文</p></section>');
  const caption=doc(result.html).querySelector('figcaption');
  assert.equal(caption.style.color,'rgb(136, 136, 136)');
  assert.equal(caption.style.fontSize,'14px');
  assert.equal(caption.style.fontWeight,'700');
  assert.equal(caption.style.fontStyle,'italic');
  assert.equal(caption.style.backgroundColor,'yellow');
  assert.equal(caption.style.textDecoration,'underline');
  assert.equal(caption.querySelector('p').style.fontSize,'0.9em');
});

test('does not misassociate body text, a gray inline prefix, headings or credits as captions', () => {
  const candidates=[
    '<p style="font-size:14px;color:#888">灰色开头<span style="color:black">接着正文</span></p>',
    '<p>普通正文</p><p style="font-size:14px;color:#888">后面的灰字</p>',
    '<h3 style="font-size:14px;color:#888">灰色标题</h3>',
    '<p style="font-size:16px;color:#888">普通字号正文</p>',
    '<p style="font-size:14px;color:red">激光有危险</p>',
    '<p style="font-size:14px;color:#888">编辑：小编</p>',
    '<p style="font-size:14px;color:#888">免责声明：请勿模仿</p>',
  ];
  for(const candidate of candidates) assert.equal(cleanArticle(`<p><img src="https://mmbiz.qpic.cn/a.png"></p>${candidate}`).stats.captions,0,candidate);
  assert.equal(cleanArticle('<p>行内表情<img src="https://mmbiz.qpic.cn/emoji.png"></p><p style="font-size:14px;color:#888">后面的灰字</p>').stats.captions,0);
});

test('retains a shared caption beneath two images as body rather than choosing an arbitrary image', () => {
  const result=cleanArticle('<p><img src="https://mmbiz.qpic.cn/a.png"></p><p><img src="https://mmbiz.qpic.cn/b.png"></p><p style="font-size:14px;color:#888">上图和下图分别表示实验的两个阶段。</p>');
  assert.equal(result.stats.captions,0);
  assert.match(doc(result.html).body.textContent,/上图和下图/);
  assert.ok(result.warnings.some(warning=>warning.includes('多张图片')));
  const group=cleanArticle('<p><img src="https://mmbiz.qpic.cn/a.png"><img src="https://mmbiz.qpic.cn/b.png"></p><p style="font-size:14px;color:#888">实验装置</p>');
  assert.equal(group.stats.captions,0);
  assert.equal(doc(group.html).querySelectorAll('figure').length,0);
  assert.equal(cleanArticle(group.html).html,group.html);
});

test('preserves explicit figure captions and image data-caption without creating duplicate associations', () => {
  const result=cleanArticle('<figure><p><img src="https://mmbiz.qpic.cn/a.png"></p><figcaption><p style="font-size:14px;color:#888">已有注释</p></figcaption></figure><p><img src="https://mmbiz.qpic.cn/b.png" data-caption="原生注释"></p><p style="font-size:14px;color:#888">独立灰字</p>');
  const content=doc(result.html);
  assert.equal(result.stats.captions,1);
  assert.equal(content.querySelectorAll('figure').length,1);
  assert.equal(content.querySelector('[data-caption]').getAttribute('data-caption'),'原生注释');
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('recognizes independent captioned images in a shared section and lifts one-image styling spans safely', () => {
  const result=cleanArticle('<section><p>正文</p><span><span><img src="https://mmbiz.qpic.cn/a.png"></span></span><p style="font-size:14px;color:#888">图1：说明</p><p>中间正文</p><span><img src="https://mmbiz.qpic.cn/b.png"></span><p style="font-size:14px;color:#888">图2：说明</p></section><section><span style="font-size:14px;color:#888"><section><img src="https://mmbiz.qpic.cn/c.png"></section><span>图3：说明</span></span></section>');
  const content=doc(result.html);
  assert.equal(result.stats.captions,3);
  assert.deepEqual([...content.querySelectorAll('figcaption')].map(node=>node.textContent),['图1：说明','图2：说明','图3：说明']);
  assert.equal(content.querySelectorAll('p > figure,span > figure').length,0);
  assert.equal(cleanArticle(result.html).html,result.html);
});

function overlayFixture({prefix='https://mmbiz.qpic.cn/example-',count=3,cell='grid-row:1;grid-column:1',title='研究观察'}={}) {
  const images=Array.from({length:count},(_,i)=>'<section style="'+cell+'"><img alt="图片" src="'+prefix+i+'.png"></section>').join('');
  return '<section style="display:grid;grid-template-columns:100%;grid-template-rows:auto">'+images+'<section style="'+cell+';font-weight:bold">'+title+'</section></section>';
}

test('removes only explicitly declared presentation images regardless of asset identity or dimensions',()=>{
  const result=cleanArticle('<p>标题</p><img role="presentation" alt="" width="900" src="https://mmbiz.qpic.cn/new-art.png"><img role="none" alt="" width="27" src="https://mmbiz.qpic.cn/changed-icon.gif"><p><img width="27" src="https://mmbiz.qpic.cn/data-chart.png"></p>');
  assert.equal(result.stats.removedDecorativeImages,2);
  assert.deepEqual(result.removedDecorativeImages.map(x=>x.imageIndex),[0,1]);
  assert.deepEqual(result.removedDecorativeImages.map(x=>x.reason),['explicit-presentation-role','explicit-presentation-role']);
  assert.equal(doc(result.html).images[0].getAttribute('src'),'https://mmbiz.qpic.cn/data-chart.png');
  assert.equal(doc(result.html).body.textContent,'标题');
});

test('retains semantic images even with presentation roles and never guesses from tiny size or heading position',()=>{
  const guards=['class="formula"','data-formula="x^2"','data-type="latex"','alt="光谱数据"','title="实验结果"','aria-label="趋势图"','data-caption="一张内容图"'];
  for(const guard of guards) {
    const result=cleanArticle('<img role="presentation" '+guard+' width="14" src="https://mmbiz.qpic.cn/content.png">');
    assert.equal(result.stats.removedDecorativeImages,0,guard);assert.equal(result.stats.images,1,guard);
  }
  const result=cleanArticle('<section style="display:flex"><img alt="" width="20" src="https://mmbiz.qpic.cn/a.png"><section>任意标题</section><img alt="" width="20" src="https://mmbiz.qpic.cn/b.png"></section><figure><img role="none" alt="" src="https://mmbiz.qpic.cn/chart.png"><figcaption>测量结果</figcaption></figure>');
  assert.equal(result.stats.removedDecorativeImages,0);
  assert.equal(result.stats.images,3);
  const caption=cleanArticle('<p><img role="presentation" alt="" src="https://mmbiz.qpic.cn/chart.png"></p><p style="color:#888;font-size:14px;text-align:center">测量结果曲线</p><p>正文继续。</p>');
  assert.equal(caption.stats.images,1);assert.equal(caption.stats.captions,1);
  assert.equal(doc(caption.html).querySelector('figcaption').textContent,'测量结果曲线');
});

test('preserves arbitrary overlay assets and marks their complete layout for local rendering',()=>{
  for(const options of [
    {},
    {prefix:'https://mmbiz.qpic.cn/replaced-',count:5,cell:'grid-row-start:2;grid-column-start:3',title:'另一个信息图'},
    {prefix:'https://mmbiz.qpic.cn/third-',count:2,cell:'grid-area:poster',title:'温度与压力'},
  ]) {
    const result=cleanArticle(overlayFixture(options)), d=doc(result.html);
    assert.equal(result.stats.removedDecorativeImages,0);
    assert.equal(result.stats.images,options.count||3);
    assert.equal(result.stats.compositeLayouts,1);
    assert.equal(d.querySelector('[data-sync-composite-layout]').style.gridTemplateColumns,'100%');
    assert.ok(result.blockingIssues.some(x=>x.includes('叠层')));
    assert.ok(result.warnings.some(x=>x.includes('无法仅凭结构')));
    assert.equal(cleanArticle(result.html).html,result.html);
  }
  const spacer=cleanArticle(overlayFixture().replace('</section><section style="grid-row:1;grid-column:1;font-weight:bold">','</section><section style="padding-top:137%"></section><section style="grid-row:1;grid-column:1;font-weight:bold">'));
  assert.ok([...doc(spacer.html).querySelectorAll('section')].some(node=>node.style.paddingTop==='137%'));
});

test('does not trust source-supplied composite markers or mark ordinary nonoverlapping image grids',()=>{
  const result=cleanArticle('<section data-sync-composite-layout="grid-overlay"><p>普通正文</p></section><section style="display:grid;grid-template-columns:1fr 1fr"><section style="grid-area:1 / 1"><img src="https://mmbiz.qpic.cn/a.png"></section><section style="grid-area:1 / 2"><img src="https://mmbiz.qpic.cn/b.png"></section></section>');
  assert.equal(result.stats.compositeLayouts,0);
  assert.equal(doc(result.html).querySelector('[data-sync-composite-layout]'),null);
  assert.equal(result.stats.images,2);
});

test('retains aspect ratio, clipping and stacking only inside a retained composition',()=>{
  const html=overlayFixture().replace('display:grid;','display:grid;aspect-ratio:4 / 3;overflow:hidden;opacity:0.8;').replace('grid-row:1;grid-column:1','grid-row:1;grid-column:1;overflow-x:clip;overflow-y:hidden;z-index:2');
  const result=cleanArticle(html+'<p style="aspect-ratio:1 / 1;overflow:hidden;opacity:.5;z-index:9">普通正文</p>'), d=doc(result.html);
  const grid=d.querySelector('[data-sync-composite-layout]');
  assert.equal(grid.style.aspectRatio,'4 / 3');assert.equal(grid.style.overflow,'hidden');assert.equal(grid.style.opacity,'0.8');
  assert.equal(grid.firstElementChild.style.overflowX,'clip');assert.equal(grid.firstElementChild.style.overflowY,'hidden');assert.equal(grid.firstElementChild.style.zIndex,'2');
  assert.equal(d.querySelector('p').style.aspectRatio,'');assert.equal(d.querySelector('p').style.opacity,'');
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('retains supported two-dimensional transforms and flags unsupported composition geometry',()=>{
  for(const transform of ['rotate(28deg)','translateX(15px)','rotateZ(319.27deg) scale(0.8) translate(4px, 2%)','matrix(1, 0, 0, 1, 8, 12)','skew(5deg, 3deg)']) {
    const result=cleanArticle(overlayFixture().replace('grid-row:1;grid-column:1','grid-row:1;grid-column:1;transform:'+transform+';transform-origin:25% 75%'));
    const child=doc(result.html).querySelector('[data-sync-composite-layout]').firstElementChild;
    assert.equal(child.style.transform,transform);assert.equal(child.style.transformOrigin,'25% 75%');
    assert.equal(doc(result.html).querySelector('[data-sync-unsupported]'),null,transform);
    assert.equal(cleanArticle(result.html).html,result.html,transform);
  }
  for(const transform of ['transform:rotateX(28deg)','transform:translate3d(15px,0,1px)','transform:matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,1,1)','perspective:500px','rotate:15deg','scale:1.2','position:absolute','aspect-ratio:var(--unknown)']) {
    const result=cleanArticle(overlayFixture().replace('grid-row:1;grid-column:1','grid-row:1;grid-column:1;'+transform));
    assert.equal(result.stats.images,3,transform);
    assert.ok(doc(result.html).querySelector('[data-sync-unsupported]'),transform);
    assert.ok(result.blockingIssues.some(issue=>issue.includes('叠层排版')),transform);
    assert.equal(cleanArticle(result.html).html,result.html,transform);
  }
  const reset=cleanArticle(overlayFixture().replace('display:grid;','display:grid;transform:none;'));
  assert.equal(doc(reset.html).querySelector('[data-sync-unsupported]'),null);
});

const characterCard=(prefix,char,size='2em')=>'<section style="display:inline-block">'+prefix+'<section style="width:'+size+';height:'+size+';border:1px solid #aaa"><p><strong style="font-size:20px;color:#fe9c00">'+char+'</strong></p></section></section>';

test('joins horizontal character cards at varying sizes without discarding instructional pinyin',()=>{
  for(const size of ['2em','32px','57px']) {
    const result=cleanArticle('<section>'+characterCard('kē','科',size)+characterCard('xué','学',size)+'</section>');
    const d=doc(result.html);
    assert.equal(result.stats.flattenedCharacterHeadings,1);
    assert.equal(d.body.textContent,'kē科xué学');
    assert.equal(d.querySelectorAll('p').length,1);
    assert.equal(d.querySelectorAll('strong').length,2);
    assert.equal(d.querySelector('strong').style.color,'rgb(254, 156, 0)');
    assert.equal(cleanArticle(result.html).html,result.html);
  }
  const ordinary=cleanArticle('<section><section style="display:inline-block"><p>科学文章正文</p></section><section style="display:inline-block"><p>另一段正文</p></section></section>');
  assert.equal(ordinary.stats.flattenedCharacterHeadings,0);
  assert.equal(doc(ordinary.html).querySelectorAll('p').length,2);
});

test('recognizes explicitly excluded tail headings in character cards without removing pinyin in article content',()=>{
  const main='正文内容用于解释研究发现与适用条件，作者信息属于正文来源，应该在删除互动尾栏时完整保留。';
  const tail='<section>'+characterCard('fu','福','3em')+characterCard('li','利','3em')+characterCard('shi','时','3em')+characterCard('jian','间','3em')+'</section>';
  const result=cleanArticle('<p>'+main+'</p>'+tail+'<p>尾部推广</p>');
  assert.equal(result.stats.trimmedTail,1);
  assert.equal(doc(result.html).body.textContent,main);
});

test('retains solid background shorthands consistently with equivalent expanded longhands',()=>{
  const short=cleanArticle('<section style="background:white"><p style="background:rgb(252,248,243)">F<sub>peak</sub></p></section>');
  const expanded=cleanArticle('<section style="background-color:white"><p style="background-color:rgb(252,248,243)">F<sub>peak</sub></p></section>');
  assert.equal(short.html,expanded.html);
  assert.equal(doc(short.html).querySelector('p').style.backgroundColor,'rgb(252, 248, 243)');
  const withImage=cleanArticle('<p style="background:#ffeeaa url(https://mmbiz.qpic.cn/unknown.png)">内容</p>');
  assert.equal(doc(withImage.html).querySelector('p').style.backgroundColor,'rgb(255, 238, 170)');
  assert.equal(withImage.stats.backgrounds,1);
});

const textCardStyle=(background='#eef5ff',color='#234',padding='16px 22px')=>'background:'+background+';color:'+color+';border:3px solid #abc;border-radius:11px;padding:'+padding;

test('clears framed prose-card decoration across wording, palette, dimensions and CSS expansion variants',()=>{
  for(const [title,style] of [
    ['答：',textCardStyle()],
    ['实验步骤',textCardStyle('#faf3e2','#654321','24px 8px')],
    ['方法与结果','background-color:#e2f5ed;color:#245634;padding-top:2em;padding-bottom:1em;padding-left:3em;padding-right:1em;border-top:1px dotted green;border-right:1px dotted green;border-bottom:1px dotted green;border-left:1px dotted green'],
  ]) {
    const result=cleanArticle('<section style="'+style+'"><span>'+title+'</span><p>正文 x<sup>2</sup></p><p><span style="background:red;color:white">文字高亮</span><span data-formula="E=mc^2"></span></p></section>'), d=doc(result.html);
    assert.equal(result.stats.removedAnswerPanelBackgrounds,1,title);
    assert.equal(d.querySelector('section').style.backgroundColor,'');
    assert.equal(d.querySelector('section').style.border,'');
    assert.equal(d.querySelector('sup').textContent,'2');
    assert.equal(d.querySelector('[data-formula]').getAttribute('data-formula'),'E=mc^2');
    assert.ok([...d.querySelectorAll('span')].some(s=>s.style.backgroundColor==='red'&&s.style.color==='white'));
    assert.equal(cleanArticle(result.html).html,result.html);
  }
});

test('retains meaningful figure, legend, inline and contrast-dependent backgrounds',()=>{
  const style=textCardStyle('#345','#fff');
  const cases=[
    '<section style="'+style+'"><p>白字正文</p><p>必须保留底色</p></section>',
    '<section role="note" style="'+textCardStyle()+'"><p>色块用于区分分类</p><p>第二段</p></section>',
    '<section style="'+textCardStyle()+'"><p>图例</p><p><img src="https://mmbiz.qpic.cn/chart.png"></p></section>',
    '<section style="'+textCardStyle()+'"><p>数据</p><table><tr><td>10</td></tr></table></section>',
    '<section style="'+textCardStyle()+'"><p>正文</p><p>第二段</p><svg viewBox="0 0 100 80"><rect width="50" height="30"></rect></svg></section>',
    '<section style="'+textCardStyle()+';background-image:linear-gradient(red,blue)"><p>正文</p><p>下一段</p></section>',
    '<section style="'+textCardStyle()+'"><span>一段普通正文</span></section>',
    '<section style="background:#ffeedd"><p>没有卡片边框的正文底色</p><p>下一段</p></section>',
  ];
  for(const html of cases) {
    const result=cleanArticle(html);
    assert.equal(result.stats.removedAnswerPanelBackgrounds,0,html);
    assert.equal(result.stats.removedFormulaCardDecorations,0,html);
    assert.notEqual(doc(result.html).querySelector('section').style.backgroundColor,'',html);
    assert.equal(cleanArticle(result.html).html,result.html);
  }
  const inline=cleanArticle('<p>保留<span style="background:#ffeeaa;color:#333">行内高亮</span></p>');
  assert.equal(doc(inline.html).querySelector('span').style.backgroundColor,'rgb(255, 238, 170)');
});

test('clears standalone equation card decoration without depending on formula names or a fixed palette',()=>{
  for(const [formula,style] of [
    ['ΔG =<i>G</i><sub>final</sub>−<i>G</i><sub>initial</sub>',textCardStyle('#f7e8dc','#74421a','20px 16px')],
    ['<span data-formula="pV=nRT"></span>',textCardStyle('#e8f7ec','#24563a','1em 2em')],
    ['x<sup>3</sup>+y<sup>3</sup>=z<sup>3</sup>',textCardStyle('#eef0ff','#283456','14px')],
  ]) {
    const result=cleanArticle('<section style="text-align:center;font-size:23px;'+style+'">'+formula+'</section>'), card=doc(result.html).querySelector('section');
    assert.equal(result.stats.removedFormulaCardDecorations,1,formula);
    assert.equal(card.style.backgroundColor,'');assert.equal(card.style.border,'');
    assert.equal(card.style.fontSize,'23px');assert.equal(card.style.textAlign,'center');
    assert.equal(card.textContent,doc(formula).body.textContent);
    assert.equal(cleanArticle(result.html).html,result.html);
  }
  const whiteSource=cleanArticle('<section style="'+textCardStyle('#345','white')+'"><span data-formula="E=mc^2"></span></section>');
  assert.equal(whiteSource.stats.removedFormulaCardDecorations,0);
  assert.notEqual(doc(whiteSource.html).querySelector('section').style.backgroundColor,'');
  const chemical=cleanArticle('<section style="'+textCardStyle()+'">H<sub>2</sub>O</section>');
  assert.equal(chemical.stats.removedFormulaCardDecorations,0);
});

test('handles Chromium reset values without confusing real background images with solid-card decoration',()=>{
  const html='<section style="'+textCardStyle()+'"><p>第一段</p><p>第二段 x<sup>2</sup></p></section>';
  for(const reset of ['initial','unset','none']) {
    const result=cleanArticle(html.replace('background:','background-image:'+reset+';background:'));
    assert.equal(result.stats.removedAnswerPanelBackgrounds,1,reset);
  }
  const image=cleanArticle(html.replace('background:','background-image:url(https://mmbiz.qpic.cn/diagram.png);background:'));
  // A shorthand resets a prior image. A following image declaration is real.
  assert.equal(image.stats.removedAnswerPanelBackgrounds,1);
  const diagram=cleanArticle(html.replace('color:#234','background-image:url(https://mmbiz.qpic.cn/diagram.png);color:#234'));
  assert.equal(diagram.stats.removedAnswerPanelBackgrounds,0);
  assert.equal(diagram.stats.backgrounds,1);
});


test('normalizes generic marker gradients with changed colors, stops and safely scoped variables',()=>{
  for(const [definition,gradient,color] of [
    ['', 'linear-gradient(transparent 60%, rgb(180, 210, 190) 40%)','rgb(180, 210, 190)'],
    ['--marker: #ffeedd;', 'linear-gradient(to bottom, rgba(0,0,0,0) 45%, var(--marker) 45%)','rgb(255, 238, 221)'],
    ['', 'linear-gradient(180deg, transparent 70%, var(--missing, rgba(20,40,60,.25)) 20%)','rgba(20, 40, 60, 0.25)'],
    ['--outer: var(--inner);--inner: #caf;', 'linear-gradient(transparent 50%, var(--outer) 50%)','rgb(204, 170, 255)'],
  ]) {
    const result=cleanArticle('<section style="'+definition+'"><p><strong style="color:#345;background:'+gradient+'">任意强调文字</strong></p></section>');
    const strong=doc(result.html).querySelector('strong');
    assert.equal(result.stats.adaptedGradientMarkers,1,gradient);
    assert.equal(strong.style.backgroundColor,color);
    assert.equal(strong.style.backgroundImage,'');
    assert.equal(strong.textContent,'任意强调文字');
    assert.deepEqual(result.blockingIssues,[]);
    assert.equal(cleanArticle(result.html).html,result.html);
  }
});

test('removes gradient decoration using label or repeated-tile structure rather than fixed headings',()=>{
  const result=cleanArticle('<h2 style="color:#123;background:linear-gradient(red,blue);background-size:2em 2em">实验方法</h2><span style="color:#234;background:linear-gradient(green,yellow)">A72：</span><h3 style="color:white;background:linear-gradient(red,blue);background-size:20px 20px">重要警告</h3>');
  // The arbitrary heading has unknown em tile dimensions and is preserved;
  // the numbered label is a supported structural decoration.
  assert.equal(result.stats.removedDecorativeBackgrounds,1);
  assert.equal(doc(result.html).querySelector('span').style.backgroundImage,'');
  assert.equal(doc(result.html).querySelectorAll('[data-sync-gradient]').length,2);
  assert.equal(doc(result.html).body.textContent,'实验方法A72：重要警告');
});

test('retains ordinary gradients for local rendering and blocks unresolved or unsupported gradient semantics',()=>{
  const result=cleanArticle('<section style="background:linear-gradient(red,blue)"><p>连续色标</p><p>不能变成单色</p></section><section style="background-image:radial-gradient(white,black)">径向信息</section><span style="background:linear-gradient(transparent 60%, var(--absent) 40%)">未知变量</span><section style="background:conic-gradient(red,blue)">环形信息</section><span style="--bad:url(https://example.org/tracker);background:linear-gradient(transparent 50%,var(--bad) 50%)">拒绝外部加载</span><section style="background:repeating-linear-gradient(red,blue 20px)">条纹色标</section>');
  const d=doc(result.html);
  assert.equal(d.querySelectorAll('[data-sync-gradient]').length,2);
  assert.equal(d.querySelectorAll('[data-sync-unsupported]').length,4);
  assert.match(d.querySelector('section').style.backgroundImage,/linear-gradient/);
  assert.ok(result.blockingIssues.some(x=>x.includes('变量无法安全解析')));
  assert.equal(cleanArticle(result.html).html,result.html);
  const spoofed=cleanArticle('<p data-sync-gradient="true">普通正文</p>');
  assert.equal(doc(spoofed.html).querySelector('[data-sync-gradient]'),null);
});
test('removes the independent opening giveaway lead and ends at the benefits column while retaining earlier credits',()=>{
  const main='正文内容用于解释研究发现与适用条件，作者信息属于正文来源，应该在删除互动尾栏时完整保留。';
  const result=cleanArticle(`<p>认真阅读下面的文章，并思考文末互动提出的问题，严格按照互动：你的答案格式留言。</p><p>${main}</p><p>作者：甲；编辑：乙</p><h3>福利时间</h3><p>赠书介绍</p><img src="https://mmbiz.qpic.cn/book.png"><p>尾栏编辑：丙</p>`);
  assert.equal(result.stats.removedOpeningLeads,1);
  assert.equal(result.stats.trimmedTail,1);
  assert.equal(result.stats.images,0);
  assert.equal(doc(result.html).body.textContent,main+'作者：甲；编辑：乙');
  const mention=cleanArticle('<p>正文先介绍活动。</p><p>认真阅读下面的文章，并思考文末互动提出的问题，这是原文的一句话。</p><p>这里提到福利时间，但属于正文说明。</p>');
  assert.equal(mention.stats.removedOpeningLeads,0);
  assert.equal(mention.stats.trimmedTail,0);
});

test('removes only independent stance statements and their labels while keeping credits and research claims',()=>{
  const result=cleanArticle('<p>正文讨论作者观点与机构立场的区别。</p><section><p>作者：甲</p><h3>立场声明</h3><p>翻译内容仅代表作者观点</p><p>不代表中科院物理所立场</p><p>编辑：乙</p><p>参考资料：[1] 原论文</p></section><p>研究者强调本文观点不代表全部学者的立场，并讨论了证据。</p>');
  assert.equal(result.stats.removedStanceStatements,3);
  const text=doc(result.html).body.textContent;
  assert.match(text,/作者：甲编辑：乙参考资料/);
  assert.match(text,/研究者强调/);
  assert.doesNotMatch(text,/翻译内容仅代表|不代表中科院物理所/);
});

test('trims explicit voting and previous-issue footer headings without cutting body mentions',()=>{
  for(const heading of ['投票','上期也精彩']) {
    const result=cleanArticle(`<p>正文提到了投票这个词。</p><p>参考文献：[1] 论文</p><h3>${heading}</h3><p>尾部推广</p><img src="https://mmbiz.qpic.cn/ad.png">`);
    assert.equal(result.stats.trimmedTail,1);
    assert.equal(doc(result.html).body.textContent,'正文提到了投票这个词。参考文献：[1] 论文');
    assert.equal(result.stats.images,0);
  }
  const body='这里是足够长的科学正文，不是互动栏目。它详细介绍实验条件和结论，并保留来源与参考资料。';
  assert.equal(doc(cleanArticle(`<p>${body}</p><p>【互动问题：你怎么看？】</p><p>尾部</p>`).html).body.textContent,body);
  assert.equal(cleanArticle('<p>正文</p><p>投票</p><p>这里仍是正文</p>').stats.trimmedTail,0);
});

test('preserves wrapped semantic line breaks in navigation, code and paragraphs while removing blank spacer blocks',()=>{
  const result=cleanArticle('<pre><code><span><br></span><span>问答导航</span><span><br></span><span>Q1 第一题</span><span><br></span><span>Q2 第二题</span><span><br></span></code></pre><p><span><br></span>第一行<span><span><br></span></span>第二行<span><br></span><span><br></span>第三行<span><br></span></p><p><span><br></span></p>');
  const d=doc(result.html);
  assert.equal(d.querySelector('pre').querySelectorAll('br').length,2);
  assert.equal(d.querySelector('p').querySelectorAll('br').length,2);
  assert.equal(d.querySelectorAll('p').length,1);
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('preserves only an explicitly labelled original-source link with its text, emphasis and color',()=>{
  const result=cleanArticle('<p><span>原文链接：</span><a href="https://journal.example/paper?q=1&amp;x=2" target="_blank" onclick="bad()" style="color:#2e3191;font-weight:700"><em>原文标题</em></a></p><p><a href="https://other.example/">普通外链文字</a> https://other.example/naked</p>');
  const d=doc(result.html), link=d.querySelector('a');
  assert.equal(result.stats.sourceLinks,1);
  assert.equal(d.querySelectorAll('a[href]').length,1);
  assert.equal(link.getAttribute('href'),'https://journal.example/paper?q=1&x=2');
  assert.equal(link.getAttribute('data-sync-source-link'),'true');
  assert.equal(link.textContent,'原文标题');
  assert.equal(link.style.color,'rgb(46, 49, 145)');
  assert.equal(link.style.fontWeight,'700');
  assert.ok(link.querySelector('em'));
  assert.equal(link.hasAttribute('onclick'),false);
  assert.equal(link.hasAttribute('target'),false);
  assert.match(d.body.textContent,/普通外链文字/);
  assert.doesNotMatch(d.body.textContent,/other\.example/);
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('source-link markers cannot bypass citation scope or HTTP URL validation',()=>{
  for(const href of ['javascript:alert(1)','data:text/html,bad','file:///secret','https://user:password@example.test/x','https://exa\nmple.test/x','https://example.test/%G0','/relative','']) {
    const result=cleanArticle(`<p>原文链接：<a data-sync-source-link="true" href="${href}">来源文字</a></p>`);
    assert.equal(result.stats.sourceLinks,0,href);
    assert.equal(doc(result.html).querySelector('a'),null,href);
    assert.equal(doc(result.html).body.textContent,'原文链接：来源文字');
  }
  for(const html of ['<p>正文<a data-sync-source-link="true" href="https://example.test">伪造标记</a></p>','<p>原文链接：<a href="https://example.test">标题</a>；编辑：甲</p>','<p>原文链接：<a href="https://example.test/1">一</a><a href="https://example.test/2">二</a></p>']) assert.equal(cleanArticle(html).stats.sourceLinks,0);
});

test('retains a bare URL inside the authorised source anchor and does not mistake the citation for an image caption',()=>{
  const url='https://journal.example/paper';
  const result=cleanArticle(`<p><img src="https://mmbiz.qpic.cn/a.png"></p><p style="font-size:14px;color:#888">原文链接：<a href="${url}">${url}</a></p>`);
  const d=doc(result.html);
  assert.equal(d.querySelector('a').textContent,url);
  assert.equal(result.stats.sourceLinks,1);
  assert.equal(result.stats.captions,0);
  assert.equal(cleanArticle(result.html).html,result.html);
  assert.equal(cleanArticle('<p>原文链接：<a href="//journal.example/paper">来源</a></p>').stats.sourceLinks,1);
  assert.equal(doc(cleanArticle('<p>原文链接：https://journal.example/paper</p>').html).body.textContent,'原文链接：');
  const semantic=doc(cleanArticle('<p>原文链接：<a href="https://journal.example/paper">H<sub>2</sub>O 与 x<sup>2</sup></a></p>').html);
  assert.ok(semantic.querySelector('a sub'));
  assert.ok(semantic.querySelector('a sup'));
});

test('omits only standalone WeChat sliding hints, retaining body mentions and code examples',()=>{
  const result=cleanArticle('<section><p><span>左右滑动查看更多</span></p></section><p>正文中提到“左右滑动查看更多”的交互设计。</p><pre><code>左右滑动查看更多</code></pre><p>下一段正文</p>');
  assert.equal(result.stats.removedComponentHints,1);
  assert.equal(doc(result.html).body.textContent,'正文中提到“左右滑动查看更多”的交互设计。左右滑动查看更多下一段正文');
  assert.ok(result.warnings.includes('已清除微信组件的滑动提示。'));
  assert.equal(cleanArticle(result.html).html,result.html);
});
