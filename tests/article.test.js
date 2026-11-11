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

test('omits small empty title decoration while preserving real images and the editable title',()=>{
  const result=cleanArticle('<section style="background-color:orange"><strong style="color:black">实验器材</strong><section data-lazy-bgimg="https://mmbiz.qpic.cn/ribbon.png" style="width:20px;height:25px;margin-top:-14px;background-color:orange"><br></section></section><p><img src="https://mmbiz.qpic.cn/small.gif" width="20" height="25"></p>');
  const content=doc(result.html);
  assert.equal(content.body.textContent,'实验器材');
  assert.ok(content.querySelector('strong'));
  assert.equal(content.querySelectorAll('img').length,1);
  assert.equal(content.querySelector('section').style.backgroundColor,'orange');
  assert.equal(result.stats.removedSmallDecorations,1);
  assert.equal(result.stats.backgrounds,0);
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
