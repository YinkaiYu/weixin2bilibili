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

const reviewedCoverTestIds=["Q5JJsLWYMJUgWzYQ4YibDBNQnPvFy5a4tyzWtTELMFQhOQcHC8VhSt8dvdqc7XhQRibqcErGcdEyLKVQ9Ly057zDrBKgNfsNDFPu53zZyn0tE","Q5JJsLWYMJVib8nfqMDibiaiaoEEO2iaiaqO4Fric7nQCJCQxZUbXbaLibckEAT44TVdR297YYvGtSTQJ2bibSIpz83T2N6zxicEM8jp922M0z6tblpmk","Q5JJsLWYMJUXV0nNxkrHV5jARdynE0XodLyh1f1F0ZtQsDItzRXhBq4Bwl3PNiaCMxKt8ROAaibgDibW2Piby8MCmL2icsuuJkibVAKqBl2b8KZy4","Q5JJsLWYMJXgfaiarNOHWFD2zsarngWsCFSQ4XDIBicXvSjTnSaImLlPib5sicgSO7LmBwlU1YjdXSbqJK1BYQZHGsBHIKIR3fEyYAN5fB0WQTo","Q5JJsLWYMJVymW3L5EdOeQwJiaabS39CRr1xnGZuXBjmbeGicUtqFnj4U8icQeDAMk3HK6FlGDL2W41p06Dk7Oibkw75XVTjBRQlicfNItib7dmz0","Q5JJsLWYMJUibnCc0SwNCjZYDXpy9EJzD3FzXpiae39SJRagYNDtPbOGRQhQG0oKCibics9RChWv0GhPCKUW7ZsvQEwKiawp3xKeJ0w6QT2xFZVY","Q5JJsLWYMJUm2lZD0zJLVLXT6YnpYUicLTvxicCPK0YmurOMuzMV40m0uaMRW0JOwJwd2sa2qt6ZDVTtjGia4iaiciaTwoNiaJPNLh8l4DN0IAkRYE","Q5JJsLWYMJV30mwjicRXXnzVpRcUFzGYegcVh7vnwPF31picqUxskCrxwXibx8rXKCtjSn9ofcHCA1QKDSL5rPhESLE7OJuqYrr0JKVyM5K10E","Q5JJsLWYMJWS9l5PL5eGAPTnia3lpNDckFzicXGYQHWB7bDlfOUzrIic0TaCUmdaoIRBIQgEj3TyP6fJKHNxB8jicmcS7cHWaoSRahzZ1kdzn6I","Q5JJsLWYMJUHCcBRrQVjricwZNiaVyzrkEEWOAwWPLw1KrVAE0X5R0BibGWoT8qeRTVzTWoWqgXFff7WbYSeav5I5nuZ65qM3mVduLUvULILic8","Q5JJsLWYMJUe6LrN9E3rx3LPXkZDK4J9RibicOGtN2WOWUV5l6ofOvBiaDuDD9vNAqRmJdfKZSAmOQasXYb91SqjmYnyy5mGwt1ibr7DSmmQWSA","Q5JJsLWYMJXD5snfggprIKX1n4cH9mm5na9Wkxf7t7zeAu8gF3ciaic3oPP1HmUoeGibHjLaevBlVpKvr1h9JhoLRd0HcSfgOrgecXibQVbpDk8","Q5JJsLWYMJWvkatACDQ06oBFkWIqST12ZHYe1icsf3tuesNJK0FDKKZXDPpcn6nyDWVqadL7kXziaos0WzSch9ZTteCZvjcATic7Uh8ia6V2Cvc","Q5JJsLWYMJX8YjXmljjRVAJplicrgdg4R2DSP4Z8wSibPMiaOcPRIsPxo4X222dqicaxCIAdN8XLHY1ylQQfynSlOCTJrW4nAXF1HHm2cucXndk"];

function reviewedCoverFixture(ids=reviewedCoverTestIds) {
  const layers=ids.map(id=>'<section style="grid-column-start:1;grid-row-start:1"><img alt="图片" data-src="https://mmbiz.qpic.cn/mmbiz_png/'+id+'/640?wx_fmt=png"></section>').join('');
  const text=['标题一','标题二','标题三'].map(t=>'<section style="grid-column-start:1;grid-row-start:1;font-weight:bold;color:#8a4400">'+t+'</section>').join('');
  return '<section style="display:grid;grid-template-columns:100%;grid-template-rows:100%">'+layers+text+'<section style="padding-top:124.63%"></section></section>';
}
const ornamentBranchFixture=width=>'<section><section style="width:'+width+'px"><img alt="图片" style="width:'+width+'px" src="https://mmbiz.qpic.cn/ornament.png"></section></section>';

test('omits only the reviewed cover template and its verified chapter and paired heading ornament roles',()=>{
  const chapter='<section style="display:flex">'+ornamentBranchFixture(58)+'<section>PART 01章节标题</section></section>';
  const paired='<section style="display:flex">'+ornamentBranchFixture(34)+'<section>中间标题</section>'+ornamentBranchFixture(34)+'</section>';
  const content='<p><img src="https://mmbiz.qpic.cn/chart.png"></p><p><img width="34" src="https://mmbiz.qpic.cn/tiny-real.png"></p><p><img data-formula="x^2" src="https://mmbiz.qpic.cn/formula.png"></p>';
  const result=cleanArticle(reviewedCoverFixture()+chapter+paired+content), d=doc(result.html);
  assert.equal(result.stats.removedDecorativeImages,17);
  assert.deepEqual(result.removedDecorativeImages.map(x=>x.imageIndex),Array.from({length:17},(_,i)=>i));
  assert.deepEqual(result.removedDecorativeImages.slice(14).map(x=>x.reason),['reviewed-chapter-badge','reviewed-paired-heading-ornament','reviewed-paired-heading-ornament']);
  assert.equal(d.images.length,3);
  assert.ok(d.querySelector('img[data-formula]'));
  assert.equal(d.body.textContent,'标题一标题二标题三PART 01章节标题中间标题');
  assert.equal(cleanArticle(result.html).html,result.html);
});

test('retains unknown collage images and small illustrations outside the reviewed template',()=>{
  const unknown=[...reviewedCoverTestIds];unknown[5]='unknown-real-content';
  const chapter='<section style="display:flex">'+ornamentBranchFixture(58)+'<section>PART 01章节标题</section></section>';
  const result=cleanArticle(reviewedCoverFixture(unknown)+chapter);
  assert.equal(result.stats.removedDecorativeImages,0);
  assert.equal(result.stats.images,15);
  const formula=cleanArticle(reviewedCoverFixture()+chapter.replace('alt="图片"','data-formula="x^2"'));
  assert.equal(formula.stats.removedDecorativeImages,14);
  assert.equal(formula.stats.formulas,1);
  for(const attribute of ['class="formula"','class="latex"','data-type="latex"']) {
    const semantic=cleanArticle(reviewedCoverFixture()+chapter.replace('alt="图片"',`${attribute} alt="图片"`));
    assert.equal(semantic.stats.removedDecorativeImages,14,attribute);
    assert.equal(doc(semantic.html).images.length,1,attribute);
  }
});

test('flattens verified horizontal character cards into one editable title while retaining emphasis and color',()=>{
  const card=(pinyin,char)=>'<section style="display:inline-block">'+pinyin+'<section style="width:40px;height:40px;border:1px solid #aaa"><p><strong style="font-size:20px;color:#fe9c00">'+char+'</strong></p></section></section>';
  const result=cleanArticle('<section>'+card('fu','福')+card('li','利')+card('shi','时')+card('jian','间')+'</section>');
  const d=doc(result.html);
  assert.equal(result.stats.flattenedCharacterHeadings,1);
  assert.equal(d.body.textContent,'福利时间');
  assert.equal(d.querySelectorAll('p').length,1);
  assert.ok([...d.querySelectorAll('span')].every(s=>s.style.fontWeight==='bold'&&s.style.color==='rgb(254, 156, 0)'));
  assert.equal(cleanArticle(result.html).html,result.html);
  const ordinary=cleanArticle('<section><section style="display:inline-block"><p>科学文章正文</p></section><section style="display:inline-block"><p>另一段正文</p></section></section>');
  assert.equal(ordinary.stats.flattenedCharacterHeadings,0);
  assert.equal(doc(ordinary.html).querySelectorAll('p').length,2);
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

test('removes only reviewed answer-panel backdrops while preserving native formula and inline highlights',()=>{
  const panelStyle='background:rgb(239,239,246);color:rgb(62,62,62);font-weight:400;border:2px solid #2e3191;border-radius:6px;padding:10px;margin:20px 0';
  const result=cleanArticle(`<section style="${panelStyle}"><span>答：</span><p>正文 x<sup>2</sup><span style="background:initial">透明继承</span></p><p><span style="background:red;color:white">保留文字高亮</span><span data-formula="E=mc^2"></span></p></section>`);
  const d=doc(result.html);
  assert.equal(result.stats.removedAnswerPanelBackgrounds,1);
  assert.equal(d.querySelector('section').style.backgroundColor,'');
  assert.equal(d.querySelector('sup').textContent,'2');
  assert.equal(d.querySelector('[data-formula]').getAttribute('data-formula'),'E=mc^2');
  assert.ok([...d.querySelectorAll('span')].some(s=>s.style.backgroundColor==='red'&&s.style.color==='white'));
  assert.equal(cleanArticle(result.html).html,result.html);
  const protectedText=cleanArticle(`<section style="${panelStyle}"><span>答：</span><p style="color:white">白字正文</p><p>下一段</p></section>`);
  assert.equal(protectedText.stats.removedAnswerPanelBackgrounds,0);
  const other=cleanArticle(`<section style="${panelStyle}"><p>问答导航</p><p>下一题</p></section><section style="background:rgb(252,248,243)"><p>F<sub>peak</sub></p></section><section style="background:#ae430e;color:white">白字棕底标题</section>`);
  assert.equal(other.stats.removedAnswerPanelBackgrounds,0);
  assert.deepEqual([...doc(other.html).querySelectorAll('section')].map(s=>s.style.backgroundColor),['rgb(239, 239, 246)','rgb(252, 248, 243)','rgb(174, 67, 14)']);
});

test('removes the reviewed tape formula card decoration without flattening its colored editable formula',()=>{
  const style='text-align:center;background:rgb(252,248,243);border:1px solid rgb(233,219,207);border-radius:10px;padding:18px 12px;color:rgb(130,66,46);font-size:20px';
  const html=`<section style="${style}">ΔF =<i>F</i><sub>peak</sub>−<i>F</i><sub>baseline</sub></section>`;
  const result=cleanArticle(html), card=doc(result.html).querySelector('section');
  assert.equal(result.stats.removedFormulaCardDecorations,1);
  assert.equal(card.style.backgroundColor,'');
  assert.equal(card.style.border,'');
  assert.equal(card.style.borderRadius,'');
  assert.equal(card.style.fontSize,'20px');
  assert.equal(card.style.color,'rgb(130, 66, 46)');
  assert.equal(card.style.textAlign,'center');
  assert.equal(card.querySelectorAll('i').length,2);
  assert.deepEqual([...card.querySelectorAll('sub')].map(s=>s.textContent),['peak','baseline']);
  assert.equal(cleanArticle(result.html).html,result.html);
  assert.equal(cleanArticle(html.replace('ΔF','ΔE')).stats.removedFormulaCardDecorations,0);
  const highlight=cleanArticle(html.replace('<i>F</i>','<i style="background:yellow">F</i>'));
  assert.equal(doc(highlight.html).querySelector('i').style.backgroundColor,'yellow');
});
